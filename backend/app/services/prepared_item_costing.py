"""Compute average cost for batch-made prepared items (sauces/marinades)."""

from __future__ import annotations

from typing import Optional

from app.models import PreparedItem
from app.services.unit_conversion import convert_quantity_to_unit
from app.services.units import normalize_unit_token


def _is_mass_or_volume(unit: str) -> bool:
    return unit in {"kg", "g", "l", "ml"}


def _estimate_quantity_in_parent_unit(quantity: float, from_unit: str, parent_unit: str) -> Optional[float]:
    try:
        return convert_quantity_to_unit(quantity, from_unit, parent_unit)
    except Exception:
        # Estimated sauce yield only. This does not change stock conversion rules.
        if _is_mass_or_volume(from_unit) and _is_mass_or_volume(parent_unit):
            return float(quantity)
        return None


def compute_prepared_item_average_cost(item: PreparedItem) -> Optional[float]:
    """
    Compute cost per 1 unit of `item.unit`, using:
    - ingredient component quantities stored in ingredient base unit, multiplied by ingredient.average_cost
    Returns None when a safe yield cannot be computed (e.g. count mixed with kg/l, or empty formula).
    """

    unit_raw = item.unit.value if hasattr(item.unit, "value") else str(item.unit or "")
    parent_unit = normalize_unit_token(str(unit_raw))
    if not parent_unit:
        return None

    total_cost = 0.0
    total_yield_in_parent_unit = 0.0

    # Ingredient lines are stored in the ingredient's base unit.
    for component in getattr(item, "components", []) or []:
        ing = getattr(component, "ingredient", None)
        if ing is None:
            continue
        qty = float(getattr(component, "quantity", 0.0) or 0.0)
        if qty <= 0:
            continue
        ing_unit_raw = component.unit.value if hasattr(component.unit, "value") else str(component.unit or "")
        ing_unit = normalize_unit_token(str(ing_unit_raw))

        total_cost += qty * float(getattr(ing, "average_cost", 0.0) or 0.0)
        qty_in_parent = _estimate_quantity_in_parent_unit(qty, ing_unit, parent_unit)
        if qty_in_parent is None:
            return None
        total_yield_in_parent_unit += qty_in_parent

    if total_yield_in_parent_unit <= 0:
        return None

    cost_per_unit = total_cost / total_yield_in_parent_unit
    if cost_per_unit < 0:
        return None
    return float(cost_per_unit)
