from __future__ import annotations

from sqlalchemy import func

from app.models import Ingredient, IngredientBranchStock, db


def sync_ingredient_master_total(ingredient_id: int) -> None:
    """Keep Ingredient.current_stock aligned with the sum of branch rows."""
    total = (
        db.session.query(func.coalesce(func.sum(IngredientBranchStock.current_stock), 0.0))
        .filter(IngredientBranchStock.ingredient_id == ingredient_id)
        .scalar()
    )
    ing = db.session.get(Ingredient, ingredient_id)
    if ing is not None:
        ing.current_stock = float(total or 0.0)
