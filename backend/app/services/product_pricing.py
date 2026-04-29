from __future__ import annotations

from app.models import Product
from app.services.recipe_variants import prepared_recipe_rows_for_variant, recipe_rows_for_variant


def _safe_float(value: object) -> float:
    try:
        return float(value or 0.0)
    except (TypeError, ValueError):
        return 0.0


def effective_sale_price(product: Product) -> float:
    """Return customer-facing price, preserving legacy rows that only used base_price."""
    sale_price = getattr(product, "sale_price", None)
    if sale_price is not None:
        parsed_sale_price = _safe_float(sale_price)
        if parsed_sale_price > 0:
            return parsed_sale_price
    return _safe_float(getattr(product, "base_price", 0.0))


def effective_sale_price_for_variant(product: Product, variant_key: str | None) -> float:
    vk = str(variant_key or "").strip()
    raw_variants = getattr(product, "variants", None)
    if isinstance(raw_variants, list):
        for entry in raw_variants:
            if not isinstance(entry, dict):
                continue
            name = str(entry.get("name") or entry.get("label") or "").strip()
            if not name:
                continue
            if vk and name.casefold() != vk.casefold():
                continue
            parsed = _safe_float(entry.get("salePrice", entry.get("sale_price")))
            if parsed > 0:
                return parsed
    return effective_sale_price(product)


def recalculate_product_cost(product: Product) -> float:
    """Recalculate and persist estimated BOM cost (stored in Product.base_price)."""
    cost = 0.0

    for recipe_item in recipe_rows_for_variant(product, None):
        ing = recipe_item.ingredient
        if ing is None:
            continue
        cost += _safe_float(recipe_item.quantity) * _safe_float(getattr(ing, "average_cost", 0.0))

    for prepared_item_row in prepared_recipe_rows_for_variant(product, None):
        prepared = prepared_item_row.prepared_item
        if prepared is None:
            continue
        cost += _safe_float(prepared_item_row.quantity) * _safe_float(getattr(prepared, "average_cost", 0.0))

    for extra_cost in list(getattr(product, "recipe_extra_costs", None) or []):
        if str(getattr(extra_cost, "variant_key", "") or "").strip():
            continue
        cost += _safe_float(getattr(extra_cost, "amount", 0.0))

    product.base_price = round(max(cost, 0.0), 2)
    return float(product.base_price or 0.0)
