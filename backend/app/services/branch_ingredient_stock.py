"""Branch-scoped ingredient stock adjustments (restaurant inventory truth)."""
from __future__ import annotations

from app.models import Branch, Ingredient, IngredientBranchStock, StockMovement, StockMovementType, db


class InsufficientIngredientStock(Exception):
    """Raised when a deduction would drive branch stock negative."""

    def __init__(self, ingredient_name: str, needed: float, available: float) -> None:
        self.ingredient_name = ingredient_name
        self.needed = needed
        self.available = available
        super().__init__(
            f"Insufficient stock for {ingredient_name}: need {needed}, have {available}"
        )


def get_branch_stock(ingredient_id: int, branch_id: str) -> float:
    row = IngredientBranchStock.query.filter_by(
        ingredient_id=ingredient_id, branch_id=branch_id
    ).first()
    if row is not None:
        return float(row.current_stock)
    ing = db.session.get(Ingredient, ingredient_id)
    return float(ing.current_stock) if ing else 0.0


def ensure_branch_stock_row(ingredient_id: int, branch_id: str) -> IngredientBranchStock:
    row = IngredientBranchStock.query.filter_by(
        ingredient_id=ingredient_id, branch_id=branch_id
    ).first()
    if row is not None:
        return row
    ing = db.session.get(Ingredient, ingredient_id)
    initial = float(ing.current_stock) if ing else 0.0
    row = IngredientBranchStock(
        ingredient_id=ingredient_id, branch_id=branch_id, current_stock=initial
    )
    db.session.add(row)
    db.session.flush()
    return row


def _movement_type_enum(movement_type: str) -> StockMovementType:
    if isinstance(movement_type, StockMovementType):
        return movement_type
    try:
        return StockMovementType(movement_type)
    except ValueError:
        return StockMovementType.ADJUSTMENT


def adjust_branch_ingredient_stock(
    ingredient_id: int,
    branch_id: str,
    quantity_change: float,
    *,
    movement_type: str | StockMovementType,
    user_id: int | None,
    reference_id: int | None,
    reference_type: str | None,
    reason: str | None,
    unit_cost: float = 0.0,
    allow_negative: bool = False,
) -> tuple[float, float]:
    """
    Apply a delta to branch ingredient stock. Returns (quantity_before, quantity_after).
    """
    ensure_branch_stock_row(ingredient_id, branch_id)
    locked = (
        IngredientBranchStock.query.filter_by(
            ingredient_id=ingredient_id, branch_id=branch_id
        )
        .with_for_update()
        .first()
    )
    if locked is None:
        raise RuntimeError("ingredient branch stock row missing after ensure")

    ing = db.session.get(Ingredient, ingredient_id)
    qty_before = float(locked.current_stock)
    qty_after = qty_before + quantity_change
    if not allow_negative and qty_after < -1e-9:
        name = ing.name if ing else f"ingredient #{ingredient_id}"
        raise InsufficientIngredientStock(name, abs(quantity_change), qty_before)

    locked.current_stock = qty_after
    mt = _movement_type_enum(movement_type) if not isinstance(movement_type, StockMovementType) else movement_type
    db.session.add(
        StockMovement(
            ingredient_id=ingredient_id,
            movement_type=mt,
            quantity_change=quantity_change,
            quantity_before=qty_before,
            quantity_after=qty_after,
            unit_cost=unit_cost,
            reference_id=reference_id,
            reference_type=reference_type,
            reason=reason or "",
            created_by=user_id,
            branch_id=branch_id,
        )
    )
    return qty_before, qty_after


def seed_branch_stocks_for_new_ingredient(ingredient_id: int, initial_per_branch: float) -> None:
    """Create a row for every active branch (used after ingredient insert)."""
    branches = Branch.query.filter(Branch.archived_at == None).all()  # noqa: E711
    if not branches:
        return
    for b in branches:
        existing = IngredientBranchStock.query.filter_by(
            ingredient_id=ingredient_id, branch_id=b.id
        ).first()
        if existing is None:
            db.session.add(
                IngredientBranchStock(
                    ingredient_id=ingredient_id,
                    branch_id=b.id,
                    current_stock=float(initial_per_branch),
                )
            )
