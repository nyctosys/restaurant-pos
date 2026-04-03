from __future__ import annotations

from datetime import datetime, time, timedelta
from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from app.models import Ingredient, IngredientBranchStock, StockMovement, User, db
from app.services.branch_scope import resolve_terminal_branch_id
from app.services.sync_outbox import enqueue_sync_event
from app_fastapi.deps import get_current_user

stock_router = APIRouter(prefix="/api/stock", tags=["stock"])


def _stock_transactions_time_range(time_filter: str, start_date_str: str | None, end_date_str: str | None):
    now = datetime.utcnow()
    tz_offset = timedelta(hours=5)
    local_now = now + tz_offset
    start_dt = end_dt = None
    if time_filter == "today":
        start_dt = datetime.combine(local_now.date(), time.min) - tz_offset
        end_dt = datetime.combine(local_now.date(), time.max) - tz_offset
    elif time_filter == "week":
        start_of_week = local_now - timedelta(days=local_now.weekday())
        start_dt = datetime.combine(start_of_week.date(), time.min) - tz_offset
        end_dt = datetime.combine(local_now.date(), time.max) - tz_offset
    elif time_filter == "month":
        start_of_month = local_now.replace(day=1)
        start_dt = datetime.combine(start_of_month.date(), time.min) - tz_offset
        end_dt = datetime.combine(local_now.date(), time.max) - tz_offset
    elif time_filter == "year":
        start_of_year = local_now.replace(month=1, day=1)
        start_dt = datetime.combine(start_of_year.date(), time.min) - tz_offset
        end_dt = datetime.combine(local_now.date(), time.max) - tz_offset
    elif time_filter == "custom" and start_date_str and end_date_str:
        try:
            start_local = datetime.strptime(start_date_str, "%Y-%m-%d")
            end_local = datetime.strptime(end_date_str, "%Y-%m-%d")
            start_dt = datetime.combine(start_local.date(), time.min) - tz_offset
            end_dt = datetime.combine(end_local.date(), time.max) - tz_offset
        except ValueError:
            pass
    return start_dt, end_dt


def _terminal_branch_id(current_user: User) -> int:
    return resolve_terminal_branch_id(current_user)


@stock_router.get("/")
def get_ingredient_stock_map(branch_id: int | None = None, current_user: User = Depends(get_current_user)):
    """Branch-scoped raw ingredient quantities (restaurant inventory)."""
    _ = branch_id
    resolved_branch_id = _terminal_branch_id(current_user)
    rows = IngredientBranchStock.query.filter_by(branch_id=resolved_branch_id).all()
    stock_map: dict[str, float] = {str(r.ingredient_id): float(r.current_stock) for r in rows}
    return {"ingredient_stock": stock_map, "branch_id": resolved_branch_id}


@stock_router.post("/update")
def update_ingredient_stock(payload: dict[str, Any] | None = None, current_user: User = Depends(get_current_user)):
    """Adjust ingredient quantity at a branch (creates a StockMovement)."""
    from app.services.branch_ingredient_stock import adjust_branch_ingredient_stock

    data = payload or {}
    branch_id = _terminal_branch_id(current_user)
    ingredient_id = data.get("ingredient_id")
    stock_delta = data.get("stock_delta", 0)
    try:
        delta = float(stock_delta)
    except (TypeError, ValueError):
        return JSONResponse(status_code=400, content={"message": "stock_delta must be a number"})
    if not ingredient_id:
        return JSONResponse(status_code=400, content={"message": "ingredient_id required"})
    ing = Ingredient.query.get(int(ingredient_id))
    if not ing:
        return JSONResponse(status_code=404, content={"message": "Ingredient not found"})
    try:
        _, qty_after = adjust_branch_ingredient_stock(
            int(ingredient_id),
            branch_id,
            delta,
            movement_type="adjustment",
            user_id=current_user.id,
            reference_id=None,
            reference_type="manual_adjustment",
            reason=data.get("reason") or "Manual stock adjustment",
            unit_cost=float(ing.average_cost or 0),
            allow_negative=False,
        )
        db.session.flush()
        mv = (
            StockMovement.query.filter_by(branch_id=branch_id, ingredient_id=int(ingredient_id))
            .order_by(StockMovement.id.desc())
            .first()
        )
        enqueue_sync_event(
            branch_id=branch_id,
            entity_type="stock_movement",
            entity_id=mv.id if mv else None,
            event_type="ingredient_stock_adjustment",
            payload={
                "ingredient_id": int(ingredient_id),
                "delta": delta,
                "quantity_after": qty_after,
            },
        )
        db.session.commit()
        return {"message": "Stock updated", "stock_level": qty_after}
    except Exception as exc:
        db.session.rollback()
        return JSONResponse(status_code=400, content={"message": str(exc)})


@stock_router.get("/transactions")
def get_stock_transactions(
    time_filter: str = "today",
    start_date: str | None = None,
    end_date: str | None = None,
    branch_id: int | None = None,
    current_user: User = Depends(get_current_user),
):
    """Ingredient movement ledger for reporting (replaces finished-goods inventory transactions)."""
    _ = branch_id
    resolved_branch_id = _terminal_branch_id(current_user)
    start_dt, end_dt = _stock_transactions_time_range(time_filter, start_date, end_date)
    query = StockMovement.query.filter_by(branch_id=resolved_branch_id)
    if start_dt and end_dt:
        query = query.filter(StockMovement.created_at >= start_dt, StockMovement.created_at <= end_dt)
    transactions = query.order_by(StockMovement.created_at.desc()).limit(500).all()
    ing_ids = {t.ingredient_id for t in transactions}
    ingredients = {i.id: i for i in Ingredient.query.filter(Ingredient.id.in_(ing_ids)).all()} if ing_ids else {}
    out: list[dict[str, Any]] = []
    for t in transactions:
        ing = ingredients.get(t.ingredient_id)
        mt = t.movement_type.value if hasattr(t.movement_type, "value") else t.movement_type
        out.append(
            {
                "id": t.id,
                "ingredient_id": t.ingredient_id,
                "ingredient_name": ing.name if ing else None,
                "product_id": None,
                "product_title": None,
                "variant_sku_suffix": "",
                "delta": float(t.quantity_change),
                "reason": mt,
                "movement_type": mt,
                "reference_type": t.reference_type,
                "reference_id": t.reference_id,
                "created_at": t.created_at.isoformat() if t.created_at else "",
            }
        )
    return {"transactions": out}
