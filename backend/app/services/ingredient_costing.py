from __future__ import annotations

from app.models import Ingredient
from app.services.branch_ingredient_stock import get_branch_stock


def apply_ingredient_purchase_cost(
    ingredient: Ingredient,
    branch_id: int,
    quantity_added: float,
    unit_cost: float,
) -> float:
    """Apply moving-average cost for a restock/purchase in the ingredient's inventory unit."""
    qty_before = get_branch_stock(int(ingredient.id), branch_id)
    total_value_before = qty_before * float(ingredient.average_cost or 0.0)
    new_total_qty = qty_before + quantity_added
    if new_total_qty > 0:
        ingredient.average_cost = (total_value_before + (quantity_added * unit_cost)) / new_total_qty
    ingredient.last_purchase_price = unit_cost
    return float(ingredient.average_cost or 0.0)
