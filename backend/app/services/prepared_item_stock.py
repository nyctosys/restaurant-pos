"""Branch-scoped stock adjustments for batch-made sauces and marinations."""
from __future__ import annotations

from app.models import (
    Branch,
    PreparedItem,
    PreparedItemBranchStock,
    PreparedItemStockMovement,
    db,
)


class InsufficientPreparedItemStock(Exception):
    def __init__(self, item_name: str, needed: float, available: float) -> None:
        super().__init__(
            f"Insufficient prepared stock for {item_name}: need {needed}, have {available}"
        )


def get_prepared_branch_stock(prepared_item_id: int, branch_id: str) -> float:
    row = PreparedItemBranchStock.query.filter_by(
        prepared_item_id=prepared_item_id, branch_id=branch_id
    ).first()
    if row is not None:
        return float(row.current_stock)
    item = db.session.get(PreparedItem, prepared_item_id)
    return float(item.current_stock) if item else 0.0


def ensure_prepared_branch_stock_row(
    prepared_item_id: int, branch_id: str
) -> PreparedItemBranchStock:
    row = PreparedItemBranchStock.query.filter_by(
        prepared_item_id=prepared_item_id, branch_id=branch_id
    ).first()
    if row is not None:
        return row
    item = db.session.get(PreparedItem, prepared_item_id)
    initial = float(item.current_stock) if item else 0.0
    row = PreparedItemBranchStock(
        prepared_item_id=prepared_item_id, branch_id=branch_id, current_stock=initial
    )
    db.session.add(row)
    db.session.flush()
    return row


def adjust_prepared_branch_stock(
    prepared_item_id: int,
    branch_id: str,
    quantity_change: float,
    *,
    movement_type: str,
    user_id: int | None,
    reference_id: int | None,
    reference_type: str | None,
    reason: str | None,
    allow_negative: bool = False,
) -> tuple[float, float]:
    ensure_prepared_branch_stock_row(prepared_item_id, branch_id)
    locked = (
        PreparedItemBranchStock.query.filter_by(
            prepared_item_id=prepared_item_id, branch_id=branch_id
        )
        .with_for_update()
        .first()
    )
    if locked is None:
        raise RuntimeError("prepared item branch stock row missing after ensure")

    item = db.session.get(PreparedItem, prepared_item_id)
    qty_before = float(locked.current_stock)
    qty_after = qty_before + quantity_change
    if not allow_negative and qty_after < -1e-9:
        name = item.name if item else f"prepared item #{prepared_item_id}"
        raise InsufficientPreparedItemStock(name, abs(quantity_change), qty_before)

    locked.current_stock = qty_after
    db.session.add(
        PreparedItemStockMovement(
            prepared_item_id=prepared_item_id,
            movement_type=movement_type,
            quantity_change=quantity_change,
            quantity_before=qty_before,
            quantity_after=qty_after,
            reference_id=reference_id,
            reference_type=reference_type,
            reason=reason or "",
            created_by=user_id,
            branch_id=branch_id,
        )
    )
    return qty_before, qty_after


def seed_prepared_branch_stocks_for_new_item(
    prepared_item_id: int, initial_per_branch: float = 0.0
) -> None:
    branches = Branch.query.filter(Branch.archived_at == None).all()  # noqa: E711
    for branch in branches:
        existing = PreparedItemBranchStock.query.filter_by(
            prepared_item_id=prepared_item_id, branch_id=branch.id
        ).first()
        if existing is None:
            db.session.add(
                PreparedItemBranchStock(
                    prepared_item_id=prepared_item_id,
                    branch_id=branch.id,
                    current_stock=float(initial_per_branch),
                )
            )


def sync_prepared_master_total(prepared_item_id: int) -> None:
    item = db.session.get(PreparedItem, prepared_item_id)
    if item is None:
        return
    total = sum(float(row.current_stock or 0.0) for row in item.branch_stocks)
    item.current_stock = total
