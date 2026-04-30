from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy.orm import joinedload

from app.models import Ingredient, Inventory, Product, RecipeExtraCost, RecipeItem, RecipePreparedItem, SaleItem, User, db
from app.deps import get_current_user, require_owner
from app.routers.common import yes
from app.services.product_pricing import effective_sale_price_for_variant
from app.services.recipe_variants import normalize_variant_key, prepared_recipe_rows_for_variant, recipe_rows_for_variant

menu_router = APIRouter(prefix="/api/menu-items", tags=["menu-items"])


def _normalize_variants_list(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, entry in enumerate(raw):
        if isinstance(entry, str):
            name = entry.strip()
            if not name:
                continue
            key = name.casefold()
            if key in seen:
                raise ValueError(f"Duplicate variant name: {name}")
            seen.add(key)
            out.append(
                {
                    "name": name,
                    "basePrice": 0.0,
                    "salePrice": 1.0,
                    "sku": "",
                }
            )
            continue

        if not isinstance(entry, dict):
            raise ValueError(f"Variant at index {index + 1} must be an object")
        name = str(entry.get("name") or entry.get("label") or entry.get("title") or "").strip()
        if not name:
            raise ValueError(f"Variant at index {index + 1} missing name")
        key = name.casefold()
        if key in seen:
            raise ValueError(f"Duplicate variant name: {name}")
        seen.add(key)
        raw_sale_price = entry.get("salePrice", entry.get("sale_price"))
        try:
            sale_price = float(raw_sale_price) if raw_sale_price not in (None, "") else 1.0
        except (TypeError, ValueError):
            raise ValueError(f'Variant "{name}" requires numeric salePrice')
        if sale_price <= 0:
            raise ValueError(f'Variant "{name}" salePrice must be greater than 0')
        try:
            base_price = float(entry.get("basePrice", entry.get("base_price", 0)) or 0)
        except (TypeError, ValueError):
            base_price = 0.0
        sku = str(entry.get("sku") or "").strip()
        out.append(
            {
                "name": name,
                "basePrice": round(base_price, 2),
                "salePrice": round(sale_price, 2),
                "sku": sku,
            }
        )
    return out


def _first_variant_prices(variants: list[dict[str, Any]]) -> tuple[float, float]:
    first = variants[0] if variants else {}
    base_price = float(first.get("basePrice") or 0.0)
    sale_price = float(first.get("salePrice") or base_price or 0.0)
    return base_price, sale_price


def _default_variant_from_legacy_payload(data: dict[str, Any]) -> list[dict[str, Any]]:
    try:
        price = float(data.get("sale_price", data.get("base_price", 0)) or 0)
    except (TypeError, ValueError):
        price = 0.0
    if price <= 0:
        price = 1.0
    return [{"name": "Regular", "basePrice": round(price, 2), "salePrice": round(price, 2), "sku": ""}]


def _extra_cost_rows_for_variant(product: Product, variant_key: str | None) -> list[RecipeExtraCost]:
    vk = normalize_variant_key(variant_key)
    rows = list(getattr(product, "recipe_extra_costs", None) or [])

    def row_vk(row: RecipeExtraCost) -> str:
        return normalize_variant_key(getattr(row, "variant_key", None))

    base = [row for row in rows if row_vk(row) == ""]
    if not vk:
        return base
    specific = [row for row in rows if row_vk(row) == vk]
    return specific if specific else base


def _compute_bom_summary_for_variant(product: Product, variant_key: str | None) -> dict[str, Any]:
    recipe_rows = recipe_rows_for_variant(product, variant_key)
    prepared_rows = prepared_recipe_rows_for_variant(product, variant_key)
    extra_cost_rows = _extra_cost_rows_for_variant(product, variant_key)

    total_cost = 0.0
    total_qty = 0.0
    unit_seen: str | None = None
    mixed_units = False

    for row in recipe_rows:
        ingredient = getattr(row, "ingredient", None)
        qty = float(getattr(row, "quantity", 0) or 0)
        unit = str(getattr(row, "unit", "") or "").strip()
        if ingredient is not None and qty > 0:
            total_cost += qty * float(getattr(ingredient, "average_cost", 0) or 0)
        if qty > 0 and unit:
            if unit_seen is None:
                unit_seen = unit
            elif unit_seen != unit:
                mixed_units = True
            total_qty += qty

    for row in prepared_rows:
        prepared_item = getattr(row, "prepared_item", None)
        qty = float(getattr(row, "quantity", 0) or 0)
        unit = str(getattr(row, "unit", "") or "").strip()
        if prepared_item is not None and qty > 0:
            total_cost += qty * float(getattr(prepared_item, "average_cost", 0) or 0)
        if qty > 0 and unit:
            if unit_seen is None:
                unit_seen = unit
            elif unit_seen != unit:
                mixed_units = True
            total_qty += qty

    for row in extra_cost_rows:
        total_cost += float(getattr(row, "amount", 0) or 0)

    return {
        "basePrice": round(max(total_cost, 0.0), 2),
        "totalQuantity": round(total_qty, 4) if total_qty > 0 else 0.0,
        "unit": "Mixed Units" if mixed_units else (unit_seen or ""),
    }


def _variants_for_response(product: Product) -> list[dict[str, Any]]:
    raw = getattr(product, "variants", None)
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    legacy_base = float(getattr(product, "base_price", 0) or 0)
    legacy_sale = float(getattr(product, "sale_price", legacy_base) or legacy_base)
    for entry in raw:
        if isinstance(entry, str):
            label = entry.strip()
            if not label:
                continue
            out.append(
                {
                    "name": label,
                    "basePrice": legacy_base if legacy_base > 0 else 0.0,
                    "salePrice": legacy_sale if legacy_sale > 0 else max(legacy_base, 1.0),
                    "sku": "",
                }
            )
            continue
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or entry.get("label") or "").strip()
        if not name:
            continue
        try:
            base_price = float(entry.get("basePrice", entry.get("base_price")))
            sale_price = float(entry.get("salePrice", entry.get("sale_price")))
        except (TypeError, ValueError):
            continue
        if sale_price <= 0:
            continue
        out.append(
            {
                "name": name,
                "basePrice": round(base_price, 2),
                "salePrice": round(sale_price, 2),
                "sku": str(entry.get("sku") or "").strip(),
            }
        )
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
    default_bom = _compute_bom_summary_for_variant(product, None)
    variants_raw = _variants_for_response(product)
    variants: list[dict[str, Any]] = []
    for variant in variants_raw:
        variant_name = str(variant.get("name") or "").strip()
        bom = _compute_bom_summary_for_variant(product, variant_name)
        variants.append(
            {
                "name": variant_name,
                "basePrice": bom["basePrice"],
                "salePrice": float(variant.get("salePrice") or 0.0),
                "sku": str(variant.get("sku") or "").strip(),
                "totalQuantity": bom["totalQuantity"],
                "unit": bom["unit"],
            }
        )

    return {
        "id": product.id,
        "sku": product.sku,
        "title": product.title,
        "base_price": default_bom["basePrice"],
        "basePrice": default_bom["basePrice"],
        "sale_price": effective_sale_price_for_variant(product, None),
        "salePrice": effective_sale_price_for_variant(product, None),
        "section": product.section or "",
        "variants": variants,
        "image_url": product.image_url or "",
        "is_deal": getattr(product, "is_deal", False) or False,
        "archived_at": product.archived_at.isoformat() if getattr(product, "archived_at", None) else None,
        "unit": default_bom["unit"],
        "unitOfMeasure": default_bom["unit"],
        "totalQuantity": default_bom["totalQuantity"],
        "recipe_items": recipe_items,
    }


@menu_router.get("/")
def get_products(include_archived: str | None = None, _: User = Depends(get_current_user)):
    query = Product.query.options(
        joinedload(Product.recipe_items).joinedload(RecipeItem.ingredient),
        joinedload(Product.prepared_recipe_items).joinedload(RecipePreparedItem.prepared_item),
        joinedload(Product.recipe_extra_costs),
    )
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
        variants = _normalize_variants_list(data.get("variants"))
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"message": str(exc)})
    if not variants:
        variants = _default_variant_from_legacy_payload(data)
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
            base_price=_first_variant_prices(variants)[0],
            sale_price=_first_variant_prices(variants)[1],
            section=(data.get("section") or "").strip(),
            variants=variants,
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
    if "base_price" in data or "sale_price" in data:
        return JSONResponse(status_code=400, content={"message": "Use variants array for pricing updates"})
    if "section" in data:
        product.section = data["section"]
    if "variants" in data:
        try:
            normalized_variants = _normalize_variants_list(data.get("variants"))
        except ValueError as exc:
            return JSONResponse(status_code=400, content={"message": str(exc)})
        if not normalized_variants:
            return JSONResponse(status_code=400, content={"message": "At least one variant is required"})
        product.variants = normalized_variants
        _, product.sale_price = _first_variant_prices(normalized_variants)
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
