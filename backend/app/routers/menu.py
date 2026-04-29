from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy.orm import joinedload

from app.models import Ingredient, Inventory, Product, RecipeItem, SaleItem, User, db
from app.deps import get_current_user, require_owner
from app.routers.common import yes
from app.services.product_pricing import effective_sale_price

menu_router = APIRouter(prefix="/api/menu-items", tags=["menu-items"])


def _normalize_variants_list(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for x in raw:
        value = ""
        if isinstance(x, str):
            value = x
        elif isinstance(x, dict):
            for key in ("label", "value", "name", "title"):
                candidate = x.get(key)
                if isinstance(candidate, str) and candidate.strip():
                    value = candidate
                    break
        v = value.strip()
        if v and v not in seen:
            seen.add(v)
            out.append(v)
    return out


def _product_to_dict(product: Product) -> dict[str, Any]:
    recipe_items = []
    for recipe_item in sorted(
        list(getattr(product, "recipe_items", None) or []),
        key=lambda item: ((getattr(item, "variant_key", None) or "").strip(), item.id or 0),
    ):
        ingredient = getattr(recipe_item, "ingredient", None)
        unit = getattr(recipe_item, "unit", "") or ""
        recipe_items.append(
            {
                "id": recipe_item.id,
                "ingredient_id": recipe_item.ingredient_id,
                "ingredient_name": ingredient.name if ingredient else None,
                "brand_name": getattr(ingredient, "brand_name", None) if ingredient else None,
                "brandName": getattr(ingredient, "brand_name", None) if ingredient else None,
                "quantity": float(recipe_item.quantity),
                "unit": unit,
                "unitOfMeasure": unit,
                "variant_key": (getattr(recipe_item, "variant_key", None) or "").strip(),
            }
        )
    return {
        "id": product.id,
        "sku": product.sku,
        "title": product.title,
        "base_price": float(product.base_price),
        "sale_price": effective_sale_price(product),
        "section": product.section or "",
        "variants": _normalize_variants_list(getattr(product, "variants", None)),
        "image_url": product.image_url or "",
        "is_deal": getattr(product, "is_deal", False) or False,
        "archived_at": product.archived_at.isoformat() if getattr(product, "archived_at", None) else None,
        "unit": getattr(product, "unit", "") or "",
        "unitOfMeasure": getattr(product, "unit", "") or "",
        "recipe_items": recipe_items,
    }


@menu_router.get("/")
def get_products(include_archived: str | None = None, _: User = Depends(get_current_user)):
    query = Product.query.options(joinedload(Product.recipe_items).joinedload(RecipeItem.ingredient))
    if not yes(include_archived):
        query = query.filter(Product.archived_at == None)  # noqa: E711
    return {"products": [_product_to_dict(p) for p in query.all()]}


@menu_router.post("/")
def create_product(payload: dict[str, Any] | None = None, _: User = Depends(require_owner)):
    data = payload or {}
    for k in ("sku", "title"):
        if k not in data:
            return JSONResponse(status_code=400, content={"message": "Missing required fields"})
    try:
        sale_price_raw = data.get("sale_price", data.get("base_price"))
        sale_price = float(sale_price_raw)
    except (TypeError, ValueError):
        return JSONResponse(status_code=400, content={"message": "Sale price must be a number"})
    if sale_price != sale_price or sale_price < 0:
        return JSONResponse(status_code=400, content={"message": "Sale price cannot be negative"})
    sku = (data.get("sku") or "").strip()
    title = (data.get("title") or "").strip()
    if not sku or not title:
        return JSONResponse(status_code=400, content={"message": "SKU and title are required"})
    if Product.query.filter_by(sku=sku).first():
        return JSONResponse(status_code=409, content={"message": "Product with this SKU already exists"})
    try:
        new_product = Product(
            sku=sku,
            title=title,
            base_price=0,
            sale_price=sale_price,
            section=(data.get("section") or "").strip(),
            variants=_normalize_variants_list(data.get("variants")),
            image_url=(data.get("image_url") or "").strip() or "",
            unit=(data.get("unitOfMeasure") or data.get("unit") or "").strip() or None,
        )
        db.session.add(new_product)
        db.session.commit()
        return JSONResponse(
            status_code=201,
            content={"message": "Product created!", "id": new_product.id, "product": _product_to_dict(new_product)},
        )
    except Exception as exc:
        db.session.rollback()
        return JSONResponse(status_code=500, content={"message": "Error creating product", "error": str(exc)})


@menu_router.put("/{product_id}")
def update_product(product_id: int, payload: dict[str, Any] | None = None, _: User = Depends(require_owner)):
    product = db.session.get(Product, product_id)
    if not product:
        raise HTTPException(status_code=404, detail="Not Found")
    data = payload or {}
    if "sku" in data and data["sku"] != product.sku:
        if Product.query.filter_by(sku=data["sku"]).first():
            return JSONResponse(status_code=409, content={"message": "Product with this SKU already exists"})
        product.sku = data["sku"]
    if "title" in data:
        product.title = data["title"]
    if "sale_price" in data or "base_price" in data:
        try:
            sale_raw = data.get("sale_price", data.get("base_price"))
            sp = float(sale_raw)
            if sp != sp or sp < 0:
                return JSONResponse(status_code=400, content={"message": "Sale price must be a non-negative number"})
            product.sale_price = sp
        except (TypeError, ValueError):
            return JSONResponse(status_code=400, content={"message": "Sale price must be a number"})
    if "section" in data:
        product.section = data["section"]
    if "variants" in data:
        product.variants = _normalize_variants_list(data.get("variants"))
    if "image_url" in data:
        product.image_url = data["image_url"] or ""
    if "unitOfMeasure" in data or "unit" in data:
        product.unit = (data.get("unitOfMeasure") or data.get("unit") or "").strip() or None
    try:
        db.session.commit()
        return {"message": "Product updated!", "product": _product_to_dict(product)}
    except Exception as exc:
        db.session.rollback()
        return JSONResponse(status_code=500, content={"message": "Error updating product", "error": str(exc)})


@menu_router.patch("/{product_id}/archive")
def archive_product(product_id: int, _: User = Depends(require_owner)):
    product = db.session.get(Product, product_id)
    if not product:
        raise HTTPException(status_code=404, detail="Not Found")
    try:
        product.archived_at = datetime.now(timezone.utc)
        db.session.commit()
        return {"message": "Product archived", "archived_at": product.archived_at.isoformat()}
    except Exception as exc:
        db.session.rollback()
        return JSONResponse(status_code=500, content={"message": "Error archiving product", "error": str(exc)})


@menu_router.patch("/{product_id}/unarchive")
def unarchive_product(product_id: int, _: User = Depends(require_owner)):
    product = db.session.get(Product, product_id)
    if not product:
        raise HTTPException(status_code=404, detail="Not Found")
    try:
        product.archived_at = None
        db.session.commit()
        return {"message": "Product restored"}
    except Exception as exc:
        db.session.rollback()
        return JSONResponse(status_code=500, content={"message": "Error restoring product", "error": str(exc)})


@menu_router.delete("/{product_id}")
def delete_product(product_id: int, _: User = Depends(require_owner)):
    product = db.session.get(Product, product_id)
    if not product:
        raise HTTPException(status_code=404, detail="Not Found")
    inv_count = Inventory.query.filter_by(product_id=product_id).count()
    sale_items_count = SaleItem.query.filter_by(product_id=product_id).count()
    try:
        SaleItem.query.filter_by(product_id=product_id).update({"product_id": None}, synchronize_session=False)
        Inventory.query.filter_by(product_id=product_id).delete()
        db.session.delete(product)
        db.session.commit()
        return {
            "message": "Product permanently deleted.",
            "related_deleted": {"inventory_rows": inv_count},
            "related_kept": {"sale_items_cleared": sale_items_count},
        }
    except Exception as exc:
        db.session.rollback()
        return JSONResponse(status_code=500, content={"message": "Error deleting product", "error": str(exc)})
