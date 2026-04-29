from datetime import datetime, timezone
from typing import List

from pydantic import BaseModel, Field
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from app.models import db, User, Product, ComboItem
from app.services.recipe_variants import (
    normalize_combo_category_name,
    normalize_combo_selection_type,
    normalize_variant_key,
)
from app.deps import get_current_user, require_owner
from app.routers.menu import _normalize_variants_list

deals_router = APIRouter(prefix="/api/inventory-advanced/deals", tags=["deals"])
menu_deals_router = APIRouter(prefix="/api/menu/deals", tags=["menu-deals"])


class ComboItemCreate(BaseModel):
    product_id: int | None = None
    quantity: int
    variant_key: str = ""
    selection_type: str = "product"
    category_name: str = ""


class DealCreate(BaseModel):
    title: str
    sku: str
    sale_price: float | None = Field(default=None)
    base_price: float | None = Field(default=None)
    variants: list[str] = Field(default_factory=list)
    combo_items: List[ComboItemCreate]


def _list_deals_impl(current_user: User) -> dict[str, list[dict]]:
    # Returns all products that are deals (restaurant menu promotions).
    deals = Product.query.filter_by(is_deal=True, archived_at=None).all()
    output: list[dict] = []
    for d in deals:
        items: list[dict] = []
        for ci in d.combo_items:
            items.append(
                {
                    "id": ci.id,
                    "product_id": ci.product_id,
                    "product_title": ci.child_product.title if ci.child_product else None,
                    "quantity": ci.quantity,
                    "selection_type": normalize_combo_selection_type(getattr(ci, "selection_type", None)),
                    "category_name": normalize_combo_category_name(getattr(ci, "category_name", None)),
                    "variant_key": normalize_variant_key(getattr(ci, "variant_key", None)),
                }
            )
        output.append(
            {
                "id": d.id,
                "sku": d.sku,
                "title": d.title,
                "base_price": float(d.base_price),
                "sale_price": float(getattr(d, "sale_price", None) if getattr(d, "sale_price", None) is not None else d.base_price),
                "section": (d.section or "").strip() or "Deals",
                "variants": _normalize_variants_list(getattr(d, "variants", None)),
                "combo_items": items,
            }
        )
    return {"deals": output}


def _create_deal_impl(payload: DealCreate, current_user: User) -> dict[str, object]:
    existing = Product.query.filter_by(sku=payload.sku).first()
    if existing:
        return JSONResponse(status_code=400, content={"message": "SKU already exists"})

    variant_labels = _normalize_variants_list(payload.variants)
    label_set = set(variant_labels)

    for ci in payload.combo_items:
        ci_vk = normalize_variant_key(ci.variant_key)
        if ci_vk and ci_vk not in label_set:
            return JSONResponse(
                status_code=400,
                content={
                    "message": f'Combo line variant "{ci_vk}" must be one of the deal variants or empty (base).',
                },
            )

    if not variant_labels:
        for ci in payload.combo_items:
            if normalize_variant_key(ci.variant_key):
                return JSONResponse(
                    status_code=400,
                    content={
                        "message": "Add deal variants first, or leave combo line variant empty for base-only deals.",
                    },
                )

    sale_price = payload.sale_price if payload.sale_price is not None else payload.base_price
    if sale_price is None:
        return JSONResponse(status_code=400, content={"message": "sale_price is required"})
    if float(sale_price) < 0:
        return JSONResponse(status_code=400, content={"message": "sale_price cannot be negative"})

    normalized_combo_items: list[dict[str, object]] = []
    for index, ci in enumerate(payload.combo_items):
        selection_type = normalize_combo_selection_type(ci.selection_type)
        quantity = int(ci.quantity)
        if quantity <= 0:
            return JSONResponse(
                status_code=400,
                content={"message": f"Combo line {index + 1} quantity must be positive."},
            )
        category_name = normalize_combo_category_name(ci.category_name)
        product_id = int(ci.product_id) if ci.product_id is not None else None

        if selection_type == "category":
            if not category_name:
                return JSONResponse(
                    status_code=400,
                    content={"message": f"Combo line {index + 1} needs a category for pick-any selection."},
                )
            normalized_combo_items.append(
                {
                    "selection_type": selection_type,
                    "category_name": category_name,
                    "product_id": None,
                    "quantity": quantity,
                    "variant_key": normalize_variant_key(ci.variant_key),
                }
            )
            continue

        if product_id is None:
            return JSONResponse(
                status_code=400,
                content={"message": f"Combo line {index + 1} needs a menu item."},
            )
        product = db.session.get(Product, product_id)
        if product is None or getattr(product, "archived_at", None) is not None:
            return JSONResponse(
                status_code=400,
                content={"message": f"Combo line {index + 1} references a menu item that is unavailable."},
            )
        if getattr(product, "is_deal", False):
            return JSONResponse(
                status_code=400,
                content={"message": "Deals cannot include another deal as a combo line."},
            )
        normalized_combo_items.append(
            {
                "selection_type": selection_type,
                "category_name": "",
                "product_id": product_id,
                "quantity": quantity,
                "variant_key": normalize_variant_key(ci.variant_key),
            }
        )

    combo = Product(
        sku=payload.sku,
        title=payload.title,
        base_price=0,
        sale_price=float(sale_price),
        variants=variant_labels,
        is_deal=True,
        section="Deals",
    )
    db.session.add(combo)
    db.session.flush()

    for ci_data in normalized_combo_items:
        ci = ComboItem(
            combo_id=combo.id,
            product_id=ci_data["product_id"],
            quantity=ci_data["quantity"],
            selection_type=ci_data["selection_type"],
            category_name=ci_data["category_name"] or None,
            variant_key=ci_data["variant_key"],
        )
        db.session.add(ci)

    db.session.commit()
    return {"id": combo.id, "message": "Deal created successfully"}


def _delete_deal_impl(deal_id: int, current_user: User) -> dict[str, object]:
    """Soft-delete: archive the deal product so past sales keep valid product_id / combo rows."""
    deal = db.session.get(Product, deal_id)
    if not deal or not deal.is_deal:
        return JSONResponse(status_code=404, content={"message": "Deal not found"})
    if deal.archived_at is not None:
        return JSONResponse(status_code=400, content={"message": "Deal is already removed from the menu"})

    deal.archived_at = datetime.now(timezone.utc)
    db.session.commit()
    return {
        "message": "Deal removed from menu (archived). Past sales are unchanged.",
        "archived_at": deal.archived_at.isoformat() if deal.archived_at else None,
    }


@deals_router.get("/")
def list_deals(current_user: User = Depends(get_current_user)):
    return _list_deals_impl(current_user)


@deals_router.post("/")
def create_deal(payload: DealCreate, current_user: User = Depends(require_owner)):
    return _create_deal_impl(payload, current_user)


@deals_router.delete("/{deal_id}")
def delete_deal(deal_id: int, current_user: User = Depends(require_owner)):
    return _delete_deal_impl(deal_id, current_user)


# New canonical namespace: menu management owns deals/combos.
@menu_deals_router.get("/")
def list_menu_deals(current_user: User = Depends(get_current_user)):
    return _list_deals_impl(current_user)


@menu_deals_router.post("/")
def create_menu_deal(payload: DealCreate, current_user: User = Depends(require_owner)):
    return _create_deal_impl(payload, current_user)


@menu_deals_router.delete("/{deal_id}")
def delete_menu_deal(deal_id: int, current_user: User = Depends(require_owner)):
    return _delete_deal_impl(deal_id, current_user)
