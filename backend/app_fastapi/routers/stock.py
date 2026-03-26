from __future__ import annotations

from datetime import datetime, time, timedelta
from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from app.models import Inventory, InventoryTransaction, Product, User, db
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


@stock_router.get("/")
def get_inventory(branch_id: int | None = None, current_user: User = Depends(get_current_user)):
    resolved_branch_id = branch_id
    if current_user.role != "owner":
        resolved_branch_id = current_user.branch_id
    elif not resolved_branch_id:
        resolved_branch_id = current_user.branch_id or 1
    records = Inventory.query.filter_by(branch_id=resolved_branch_id).all()
    stock_map: dict[int, dict[str, int]] = {}
    for r in records:
        stock_map.setdefault(r.product_id, {})
        stock_map[r.product_id][r.variant_sku_suffix] = r.stock_level
    return {"inventory": stock_map}


@stock_router.post("/update")
def update_inventory(payload: dict[str, Any] | None = None, current_user: User = Depends(get_current_user)):
    data = payload or {}
    branch_id = data.get("branch_id")
    if current_user.role != "owner":
        branch_id = current_user.branch_id
    elif not branch_id:
        branch_id = current_user.branch_id or 1
    product_id = data.get("product_id")
    variant_sku_suffix = data.get("variant_sku_suffix", "")
    stock_delta = data.get("stock_delta", 0)
    if not product_id:
        return JSONResponse(status_code=400, content={"message": "product_id required"})
    record = Inventory.query.filter_by(
        branch_id=branch_id, product_id=product_id, variant_sku_suffix=variant_sku_suffix
    ).first()
    if not record:
        record = Inventory(branch_id=branch_id, product_id=product_id, variant_sku_suffix=variant_sku_suffix, stock_level=0)
        db.session.add(record)
    record.stock_level += stock_delta
    db.session.add(
        InventoryTransaction(
            branch_id=branch_id,
            product_id=product_id,
            variant_sku_suffix=variant_sku_suffix,
            delta=stock_delta,
            reason="adjustment",
            user_id=current_user.id,
            reference_type=None,
            reference_id=None,
        )
    )
    try:
        db.session.commit()
        return {"message": "Stock updated", "stock_level": record.stock_level}
    except Exception as exc:
        db.session.rollback()
        return JSONResponse(status_code=500, content={"message": "Error updating stock", "error": str(exc)})


@stock_router.get("/transactions")
def get_stock_transactions(
    time_filter: str = "today",
    start_date: str | None = None,
    end_date: str | None = None,
    branch_id: int | None = None,
    current_user: User = Depends(get_current_user),
):
    resolved_branch_id = branch_id
    if current_user.role != "owner":
        resolved_branch_id = current_user.branch_id
    elif not resolved_branch_id:
        resolved_branch_id = current_user.branch_id or 1
    start_dt, end_dt = _stock_transactions_time_range(time_filter, start_date, end_date)
    query = InventoryTransaction.query.filter_by(branch_id=resolved_branch_id)
    if start_dt and end_dt:
        query = query.filter(InventoryTransaction.created_at >= start_dt, InventoryTransaction.created_at <= end_dt)
    transactions = query.order_by(InventoryTransaction.created_at.desc()).limit(500).all()
    product_ids = {t.product_id for t in transactions}
    products = {p.id: p for p in Product.query.filter(Product.id.in_(product_ids)).all()} if product_ids else {}
    out: list[dict[str, Any]] = []
    for t in transactions:
        p = products.get(t.product_id)
        out.append(
            {
                "id": t.id,
                "product_id": t.product_id,
                "product_title": p.title if p else None,
                "variant_sku_suffix": t.variant_sku_suffix or "",
                "delta": t.delta,
                "reason": t.reason,
                "reference_type": t.reference_type,
                "reference_id": t.reference_id,
                "created_at": t.created_at.isoformat(),
            }
        )
    return {"transactions": out}
