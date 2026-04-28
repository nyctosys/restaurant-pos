"""Resolve which recipe (BOM) rows apply for a menu item and optional variant name."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.models import Product, RecipeItem, RecipePreparedItem


def normalize_variant_key(raw: str | None) -> str:
    return (raw or "").strip()


def combo_items_for_variant(product: "Product", variant_key: str | None) -> list["ComboItem"]:
    """
    - Rows with empty variant_key are the **base** combo (default for all deal variants).
    - Rows with variant_key set apply only when the sold deal line matches that label.
    - If the sold variant has at least one matching combo row, use **only** those rows.
    - Otherwise fall back to base rows (same recipe pattern as BOM).
    """
    from app.models import ComboItem  # local import avoids circular model graph at import time

    vk = normalize_variant_key(variant_key)
    rows = list(getattr(product, "combo_items", None) or [])

    def row_vk(ci: ComboItem) -> str:
        return normalize_variant_key(getattr(ci, "variant_key", None))

    base = [r for r in rows if row_vk(r) == ""]
    if not vk:
        return base

    specific = [r for r in rows if row_vk(r) == vk]
    return specific if specific else base


def recipe_rows_for_variant(product: "Product", variant_key: str | None) -> list["RecipeItem"]:
    """
    - Rows with empty variant_key are the **base** recipe (default).
    - Rows with variant_key set apply only to that variant label.
    - If the sold variant has at least one matching row, use **only** those rows.
    - Otherwise fall back to the base rows (same BOM for all variants unless overridden).
    """
    vk = normalize_variant_key(variant_key)
    rows = list(getattr(product, "recipe_items", None) or [])

    def row_vk(r: "RecipeItem") -> str:
        return normalize_variant_key(getattr(r, "variant_key", None))

    base = [r for r in rows if row_vk(r) == ""]
    if not vk:
        return base

    specific = [r for r in rows if row_vk(r) == vk]
    return specific if specific else base


def prepared_recipe_rows_for_variant(
    product: "Product", variant_key: str | None
) -> list["RecipePreparedItem"]:
    """Variant fallback for prepared sauce/marination recipe rows."""
    vk = normalize_variant_key(variant_key)
    rows = list(getattr(product, "prepared_recipe_items", None) or [])

    def row_vk(r: "RecipePreparedItem") -> str:
        return normalize_variant_key(getattr(r, "variant_key", None))

    base = [r for r in rows if row_vk(r) == ""]
    if not vk:
        return base

    specific = [r for r in rows if row_vk(r) == vk]
    return specific if specific else base
