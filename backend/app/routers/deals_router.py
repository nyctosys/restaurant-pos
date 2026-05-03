from datetime import datetime, timezone
from typing import List

from pydantic import BaseModel, Field
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from app.models import db, User, Product, ComboItem, SaleItem
from app.services.product_pricing import effective_sale_price
from app.services.recipe_variants import (
    combo_category_label,
    normalize_combo_category_name,
    normalize_combo_category_names,
    normalize_combo_selection_type,
)
from app.deps import get_current_user, require_owner
from app.routers.common import yes

deals_router = APIRouter(prefix="/api/inventory-advanced/deals", tags=["deals"])
menu_deals_router = APIRouter(prefix="/api/menu/deals", tags=["menu-deals"])


class ComboItemCreate(BaseModel):
    product_id: int | None = None
    quantity: int
    variant_key: str = ""
    selection_type: str = "product"
    category_name: str = ""
    category_names: list[str] = Field(default_factory=list)


class DealCreate(BaseModel):
    title: str
    sku: str
    sale_price: float | None = Field(default=None)
    base_price: float | None = Field(default=None)
    variants: list[str] = Field(default_factory=list)
    combo_items: List[ComboItemCreate]


def _deal_to_dict(deal: Product) -> dict:
    items: list[dict] = []
    for ci in deal.combo_items:
        selection_type = normalize_combo_selection_type(getattr(ci, "selection_type", None))
        category_names = normalize_combo_category_names(getattr(ci, "category_names", None))
        category_name = normalize_combo_category_name(getattr(ci, "category_name", None))
        if selection_type == "multiple_category":
            category_name = combo_category_label(category_names, category_name)
        items.append(
            {
                "id": ci.id,
                "product_id": ci.product_id,
                "product_title": ci.child_product.title if ci.child_product else None,
                "quantity": ci.quantity,
                "selection_type": selection_type,
                "category_name": category_name,
                "category_names": category_names,
                "variant_key": (getattr(ci, "variant_key", None) or "").strip(),
            }
        )
    return {
        "id": deal.id,
        "sku": deal.sku,
        "title": deal.title,
        "base_price": float(deal.base_price),
        "sale_price": effective_sale_price(deal),
        "section": (deal.section or "").strip() or "Deals",
        "variants": [],
        "combo_items": items,
        "archived_at": deal.archived_at.isoformat() if getattr(deal, "archived_at", None) else None,
    }


def _list_deals_impl(current_user: User, include_archived: str | None = None) -> dict[str, list[dict]]:
    # Returns all products that are deals (restaurant menu promotions).
    query = Product.query.filter_by(is_deal=True)
    if not yes(include_archived):
        query = query.filter(Product.archived_at == None)  # noqa: E711
    return {"deals": [_deal_to_dict(deal) for deal in query.all()]}


def _validate_deal_payload(payload: DealCreate, deal_id: int | None = None) -> tuple[dict[str, object], list[dict[str, object]]] | JSONResponse:
    sku = (payload.sku or "").strip()
    title = (payload.title or "").strip()
    if not sku or not title:
        return JSONResponse(status_code=400, content={"message": "Deal title and SKU are required"})

    existing = Product.query.filter_by(sku=sku).first()
    if existing and (deal_id is None or existing.id != deal_id):
        return JSONResponse(status_code=400, content={"message": "SKU already exists"})

    sale_price = payload.sale_price if payload.sale_price is not None else payload.base_price
    if sale_price is None:
        return JSONResponse(status_code=400, content={"message": "sale_price is required"})
    if float(sale_price) < 0:
        return JSONResponse(status_code=400, content={"message": "sale_price cannot be negative"})

    normalized_combo_items: list[dict[str, object]] = []
    for index, ci in enumerate(payload.combo_items):
        category_names = normalize_combo_category_names(ci.category_names)
        selection_type = normalize_combo_selection_type(ci.selection_type)
        if selection_type == "product" and category_names:
            selection_type = "multiple_category" if len(category_names) > 1 else "category"
        quantity = int(ci.quantity)
        if quantity <= 0:
            return JSONResponse(
                status_code=400,
                content={"message": f"Combo line {index + 1} quantity must be positive."},
            )
        category_name = normalize_combo_category_name(ci.category_name)
        product_id = int(ci.product_id) if ci.product_id is not None else None
        variant_key_line = (ci.variant_key or "").strip()[:100]

        if selection_type in {"category", "multiple_category"}:
            if selection_type == "multiple_category":
                if len(category_names) < 2:
                    return JSONResponse(
                        status_code=400,
                        content={"message": f"Combo line {index + 1} needs at least two categories for multiple-category choice."},
                    )
                category_name = combo_category_label(category_names)
            elif not category_name:
                return JSONResponse(
                    status_code=400,
                    content={"message": f"Combo line {index + 1} needs a category for pick-any selection."},
                )
            else:
                category_names = [category_name]
            normalized_combo_items.append(
                {
                    "selection_type": selection_type,
                    "category_name": category_name,
                    "category_names": category_names,
                    "product_id": None,
                    "quantity": quantity,
                    "variant_key": variant_key_line,
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
        if product.id == deal_id or getattr(product, "is_deal", False):
            return JSONResponse(
                status_code=400,
                content={"message": "Deals cannot include another deal as a combo line."},
            )
        normalized_combo_items.append(
            {
                "selection_type": selection_type,
                "category_name": "",
                "category_names": [],
                "product_id": product_id,
                "quantity": quantity,
                "variant_key": variant_key_line,
            }
        )

    return (
        {
            "sku": sku,
            "title": title,
            "sale_price": float(sale_price),
            "variants": [],
        },
        normalized_combo_items,
    )


def _replace_combo_items(deal: Product, combo_items: list[dict[str, object]]) -> None:
    deal.combo_items.clear()
    db.session.flush()
    for ci_data in combo_items:
        db.session.add(
            ComboItem(
                combo_id=deal.id,
                product_id=ci_data["product_id"],
                quantity=ci_data["quantity"],
                selection_type=ci_data["selection_type"],
                category_name=ci_data["category_name"] or None,
                category_names=ci_data.get("category_names") or [],
                variant_key=str(ci_data.get("variant_key") or "").strip()[:100],
            )
        )


def _create_deal_impl(payload: DealCreate, current_user: User) -> dict[str, object]:
    validated = _validate_deal_payload(payload)
    if isinstance(validated, JSONResponse):
        return validated
    deal_data, normalized_combo_items = validated

    existing = Product.query.filter_by(sku=deal_data["sku"]).first()
    if existing:
        return JSONResponse(status_code=400, content={"message": "SKU already exists"})

    combo = Product(
        sku=deal_data["sku"],
        title=deal_data["title"],
        base_price=0,
        sale_price=deal_data["sale_price"],
        variants=deal_data["variants"],
        is_deal=True,
        section="Deals",
    )
    db.session.add(combo)
    db.session.flush()
    _replace_combo_items(combo, normalized_combo_items)

    db.session.commit()
    return {"id": combo.id, "message": "Deal created successfully"}


def _update_deal_impl(deal_id: int, payload: DealCreate, current_user: User) -> dict[str, object]:
    deal = db.session.get(Product, deal_id)
    if not deal or not deal.is_deal:
        return JSONResponse(status_code=404, content={"message": "Deal not found"})

    validated = _validate_deal_payload(payload, deal_id=deal_id)
    if isinstance(validated, JSONResponse):
        return validated
    deal_data, normalized_combo_items = validated

    deal.sku = deal_data["sku"]
    deal.title = deal_data["title"]
    deal.base_price = 0
    deal.sale_price = deal_data["sale_price"]
    deal.variants = deal_data["variants"]
    deal.section = "Deals"
    _replace_combo_items(deal, normalized_combo_items)
    db.session.commit()
    return {"id": deal.id, "message": "Deal updated successfully", "deal": _deal_to_dict(deal)}


def _archive_deal_impl(deal_id: int, current_user: User) -> dict[str, object]:
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


def _unarchive_deal_impl(deal_id: int, current_user: User) -> dict[str, object]:
    deal = db.session.get(Product, deal_id)
    if not deal or not deal.is_deal:
        return JSONResponse(status_code=404, content={"message": "Deal not found"})
    deal.archived_at = None
    db.session.commit()
    return {"message": "Deal restored to menu."}


def _delete_deal_permanent_impl(deal_id: int, current_user: User) -> dict[str, object]:
    deal = db.session.get(Product, deal_id)
    if not deal or not deal.is_deal:
        return JSONResponse(status_code=404, content={"message": "Deal not found"})
    sale_items_count = SaleItem.query.filter_by(product_id=deal_id).count()
    try:
        SaleItem.query.filter_by(product_id=deal_id).update({"product_id": None}, synchronize_session=False)
        db.session.delete(deal)
        db.session.commit()
        return {
            "message": "Deal permanently deleted.",
            "related_kept": {"sale_items_cleared": sale_items_count},
        }
    except Exception as exc:
        db.session.rollback()
        return JSONResponse(status_code=500, content={"message": "Error deleting deal", "error": str(exc)})


@deals_router.get("/")
def list_deals(include_archived: str | None = None, current_user: User = Depends(get_current_user)):
    return _list_deals_impl(current_user, include_archived=include_archived)


@deals_router.post("/")
def create_deal(payload: DealCreate, current_user: User = Depends(require_owner)):
    return _create_deal_impl(payload, current_user)


@deals_router.put("/{deal_id}")
def update_deal(deal_id: int, payload: DealCreate, current_user: User = Depends(require_owner)):
    return _update_deal_impl(deal_id, payload, current_user)


@deals_router.patch("/{deal_id}/archive")
def archive_deal(deal_id: int, current_user: User = Depends(require_owner)):
    return _archive_deal_impl(deal_id, current_user)


@deals_router.patch("/{deal_id}/unarchive")
def unarchive_deal(deal_id: int, current_user: User = Depends(require_owner)):
    return _unarchive_deal_impl(deal_id, current_user)


@deals_router.delete("/{deal_id}")
def delete_deal(deal_id: int, permanent: str | None = None, current_user: User = Depends(require_owner)):
    if yes(permanent):
        return _delete_deal_permanent_impl(deal_id, current_user)
    return _archive_deal_impl(deal_id, current_user)


# New canonical namespace: menu management owns deals/combos.
@menu_deals_router.get("/")
def list_menu_deals(include_archived: str | None = None, current_user: User = Depends(get_current_user)):
    return _list_deals_impl(current_user, include_archived=include_archived)


@menu_deals_router.post("/")
def create_menu_deal(payload: DealCreate, current_user: User = Depends(require_owner)):
    return _create_deal_impl(payload, current_user)


@menu_deals_router.put("/{deal_id}")
def update_menu_deal(deal_id: int, payload: DealCreate, current_user: User = Depends(require_owner)):
    return _update_deal_impl(deal_id, payload, current_user)


@menu_deals_router.patch("/{deal_id}/archive")
def archive_menu_deal(deal_id: int, current_user: User = Depends(require_owner)):
    return _archive_deal_impl(deal_id, current_user)


@menu_deals_router.patch("/{deal_id}/unarchive")
def unarchive_menu_deal(deal_id: int, current_user: User = Depends(require_owner)):
    return _unarchive_deal_impl(deal_id, current_user)


@menu_deals_router.delete("/{deal_id}")
def delete_menu_deal(deal_id: int, permanent: str | None = None, current_user: User = Depends(require_owner)):
    if yes(permanent):
        return _delete_deal_permanent_impl(deal_id, current_user)
    return _archive_deal_impl(deal_id, current_user)
