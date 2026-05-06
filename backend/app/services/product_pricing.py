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


def effective_base_cost_for_variant(product: Product, variant_key: str | None) -> float:
    """
    Return the best-available "base cost" for a menu item variant.

    In this app, `Product.base_price` is used as the baseline cost field for profit reporting.
    Some products also carry per-variant `basePrice` inside `Product.variants` JSON.
    """
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
            parsed = _safe_float(entry.get("basePrice", entry.get("base_price")))
            if parsed > 0:
                return parsed
    return _safe_float(getattr(product, "base_price", 0.0))


def _recipe_extra_cost_rows_for_variant(product: Product, variant_key: str | None) -> list[object]:
    vk = str(variant_key or "").strip()
    rows = list(getattr(product, "recipe_extra_costs", None) or [])

    def row_vk(row: object) -> str:
        return str(getattr(row, "variant_key", "") or "").strip()

    base = [r for r in rows if row_vk(r) == ""]
    if not vk:
        return base

    specific = [r for r in rows if row_vk(r).casefold() == vk.casefold()]
    return specific if specific else base


def calculate_bom_cost_for_variant(product: Product, variant_key: str | None) -> float:
    """
    Calculate the BOM (recipe) cost for a menu item variant.

    This is computed from ingredient average costs, prepared-item average costs, and configured recipe extra costs.
    It does not depend on `Product.base_price` (which can be stale / legacy).
    """
    cost = 0.0

    recipe_rows = recipe_rows_for_variant(product, variant_key)
    prepared_rows = prepared_recipe_rows_for_variant(product, variant_key)
    extra_rows = _recipe_extra_cost_rows_for_variant(product, variant_key)
    if not recipe_rows and not prepared_rows and not extra_rows:
        # Legacy / simple menu items may not have BOM configured.
        # Preserve existing profit behavior by falling back to stored base_price.
        return round(max(_safe_float(getattr(product, "base_price", 0.0)), 0.0), 2)

    for recipe_item in recipe_rows:
        ing = getattr(recipe_item, "ingredient", None)
        if ing is None:
            continue
        cost += _safe_float(getattr(recipe_item, "quantity", 0.0)) * _safe_float(getattr(ing, "average_cost", 0.0))

    for prepared_item_row in prepared_rows:
        prepared = getattr(prepared_item_row, "prepared_item", None)
        if prepared is None:
            continue
        cost += _safe_float(getattr(prepared_item_row, "quantity", 0.0)) * _safe_float(getattr(prepared, "average_cost", 0.0))

    for extra_cost in extra_rows:
        cost += _safe_float(getattr(extra_cost, "amount", 0.0))

    return round(max(cost, 0.0), 2)


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


def compute_deal_base_cost(deal: Product) -> float:
    """
    Dynamically compute a deal's base cost from the current BOM costs of its
    constituent combo items.  Only fixed-product lines contribute (category-choice
    lines are resolved at sale time).
    """
    from app.services.recipe_variants import normalize_combo_selection_type, normalize_variant_key

    total = 0.0
    for ci in list(getattr(deal, "combo_items", None) or []):
        selection_type = normalize_combo_selection_type(getattr(ci, "selection_type", None))
        if selection_type != "product":
            continue
        child = getattr(ci, "child_product", None)
        if child is None or getattr(child, "is_deal", False):
            continue
        qty = int(getattr(ci, "quantity", 0) or 0)
        if qty <= 0:
            continue
        variant_key = normalize_variant_key(getattr(ci, "variant_key", None))
        total += calculate_bom_cost_for_variant(child, variant_key) * qty
    return round(max(total, 0.0), 2)


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
