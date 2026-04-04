from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse

from app.models import Inventory, Product, SaleItem, User, db
from app.deps import get_current_user, require_owner
from app.routers.common import yes

menu_router = APIRouter(prefix="/api/menu-items", tags=["menu-items"])


def _normalize_variants_list(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for x in raw:
        if isinstance(x, str):
            v = x.strip()
            if v and v not in seen:
                seen.add(v)
                out.append(v)
    return out


def _product_to_dict(product: Product) -> dict[str, Any]:
    return {
        "id": product.id,
        "sku": product.sku,
        "title": product.title,
        "base_price": float(product.base_price),
        "section": product.section or "",
        "variants": _normalize_variants_list(getattr(product, "variants", None)),
        "image_url": product.image_url or "",
        "is_deal": getattr(product, "is_deal", False) or False,
        "archived_at": product.archived_at.isoformat() if getattr(product, "archived_at", None) else None,
    }


@menu_router.get("/")
def get_products(include_archived: str | None = None, _: User = Depends(get_current_user)):
    query = Product.query
    if not yes(include_archived):
        query = query.filter(Product.archived_at == None)  # noqa: E711
    return {"products": [_product_to_dict(p) for p in query.all()]}


@menu_router.post("/")
def create_product(payload: dict[str, Any] | None = None, _: User = Depends(require_owner)):
    data = payload or {}
    for k in ("sku", "title", "base_price"):
        if k not in data:
            return JSONResponse(status_code=400, content={"message": "Missing required fields"})
    try:
        base_price = float(data["base_price"])
    except (TypeError, ValueError):
        return JSONResponse(status_code=400, content={"message": "Base price must be a number"})
    if base_price != base_price or base_price < 0:
        return JSONResponse(status_code=400, content={"message": "Base price cannot be negative"})
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
            base_price=base_price,
            section=(data.get("section") or "").strip(),
            variants=_normalize_variants_list(data.get("variants")),
            image_url=(data.get("image_url") or "").strip() or "",
        )
        db.session.add(new_product)
        db.session.commit()
        return JSONResponse(status_code=201, content={"message": "Product created!", "id": new_product.id})
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
    if "base_price" in data:
        try:
            bp = float(data["base_price"])
            if bp != bp or bp < 0:
                return JSONResponse(status_code=400, content={"message": "Base price must be a non-negative number"})
            product.base_price = bp
        except (TypeError, ValueError):
            return JSONResponse(status_code=400, content={"message": "Base price must be a number"})
    if "section" in data:
        product.section = data["section"]
    if "variants" in data:
        product.variants = _normalize_variants_list(data.get("variants"))
    if "image_url" in data:
        product.image_url = data["image_url"] or ""
    try:
        db.session.commit()
        return {"message": "Product updated!"}
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
