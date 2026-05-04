"""Resolve which recipe (BOM) rows apply for a menu item and optional variant name."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.models import Product, RecipeItem, RecipePreparedItem


def normalize_variant_key(raw: str | None) -> str:
    return (raw or "").strip()


def normalize_combo_selection_type(raw: str | None) -> str:
    normalized = (raw or "").strip().lower().replace("-", "_").replace(" ", "_")
    if normalized in {"category", "single_category"}:
        return "category"
    if normalized in {"multiple_category", "multi_category", "multiple_categories", "category_group"}:
        return "multiple_category"
    return "product"


def normalize_combo_category_name(raw: str | None) -> str:
    return (raw or "").strip()


def normalize_combo_category_names(raw: object) -> list[str]:
    if not isinstance(raw, list):
        return []
    seen: set[str] = set()
    normalized: list[str] = []
    for value in raw:
        name = normalize_combo_category_name(str(value) if value is not None else None)
        key = name.casefold()
        if name and key not in seen:
            seen.add(key)
            normalized.append(name)
    return normalized


def combo_category_label(category_names: list[str], fallback: str | None = None) -> str:
    names = normalize_combo_category_names(category_names)
    if names:
        return " / ".join(names)
    return normalize_combo_category_name(fallback)


def combo_items_for_variant(product: "Product", variant_key: str | None) -> list["ComboItem"]:
    """
    - Rows with empty variant_key are the **base** combo (default for all deal variants).
    - Rows with variant_key set apply only when the sold deal line matches that label.
    - If the sold variant has matching combo rows, include base rows plus those variant rows.
    - Otherwise fall back to base rows.
    """
    from app.models import ComboItem  # local import avoids circular model graph at import time

    vk = normalize_variant_key(variant_key)
    rows = list(getattr(product, "combo_items", None) or [])

    def row_vk(ci: ComboItem) -> str:
        return normalize_variant_key(getattr(ci, "variant_key", None))

    def has_deal_variants() -> bool:
        variants = getattr(product, "variants", None)
        if not isinstance(variants, list):
            return False
        labels: list[str] = []
        for entry in variants:
            if isinstance(entry, str):
                label = entry.strip()
            elif isinstance(entry, dict):
                label = str(entry.get("name") or entry.get("label") or "").strip()
            else:
                label = ""
            if label:
                labels.append(label)
        if len(labels) > 1:
            return True
        return bool(labels and labels[0].casefold() != "default")

    base = [r for r in rows if row_vk(r) == ""]
    if not vk:
        if not has_deal_variants():
            return rows
        return base

    specific = [r for r in rows if row_vk(r) == vk]
    return [*base, *specific] if specific else base


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
