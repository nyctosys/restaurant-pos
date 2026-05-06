"""Compute average cost for batch-made prepared items (sauces/marinades)."""

from __future__ import annotations

from typing import Optional

from app.models import PreparedItem, PreparedItemPreparedComponent
from app.services.unit_conversion import convert_quantity_to_unit
from app.services.units import normalize_unit_token


def compute_prepared_item_average_cost(item: PreparedItem) -> Optional[float]:
    """
    Compute cost per 1 unit of `item.unit`, using:
    - ingredient component quantities stored in ingredient base unit, multiplied by ingredient.average_cost
    - prepared-item component quantities stored in child prepared unit, multiplied by child.average_cost

    Returns None when a safe yield cannot be computed (e.g. incompatible units or empty formula).
    """

    unit_raw = item.unit.value if hasattr(item.unit, "value") else str(item.unit or "")
    parent_unit = normalize_unit_token(str(unit_raw))
    if not parent_unit:
        return None

    total_cost = 0.0
    total_yield_in_parent_unit = 0.0

    # Ingredient lines (stored in ingredient base unit already)
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
        try:
            total_yield_in_parent_unit += convert_quantity_to_unit(qty, ing_unit, parent_unit)
        except Exception:
            # If units are incompatible (e.g. piece → kg), we can't safely estimate yield.
            return None

    # Prepared-item lines (stored in child prepared base unit already)
    prepared_components = PreparedItemPreparedComponent.query.filter_by(prepared_item_id=item.id).all()
    for component in prepared_components:
        child = getattr(component, "component_prepared_item", None)
        if child is None:
            continue
        qty = float(getattr(component, "quantity", 0.0) or 0.0)
        if qty <= 0:
            continue
        child_unit_raw = child.unit.value if hasattr(child.unit, "value") else str(child.unit or "")
        child_unit = normalize_unit_token(str(child_unit_raw))

        total_cost += qty * float(getattr(child, "average_cost", 0.0) or 0.0)
        try:
            total_yield_in_parent_unit += convert_quantity_to_unit(qty, child_unit, parent_unit)
        except Exception:
            return None

    if total_yield_in_parent_unit <= 0:
        return None

    cost_per_unit = total_cost / total_yield_in_parent_unit
    if cost_per_unit < 0:
        return None
    return float(cost_per_unit)

