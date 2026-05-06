from __future__ import annotations

from datetime import datetime, time, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from app.models import Ingredient, PreparedItem, IngredientBranchStock, StockMovement, User, db
from app.schemas.inventory_schemas import BulkRestockRequest
from app.services.branch_ingredient_stock import adjust_branch_ingredient_stock
from app.services.units import normalize_unit_token, to_base_unit
from app.services.ingredient_costing import apply_ingredient_purchase_cost
from app.services.ingredient_master_stock import sync_ingredient_master_total
from app.services.branch_scope import resolve_terminal_branch_id
from app.services.sync_outbox import enqueue_sync_event
from app.services.prepared_item_stock import adjust_prepared_branch_stock, sync_prepared_master_total
from app.services.unit_conversion import convert_quantity_to_unit
from app.deps import get_current_user

stock_router = APIRouter(prefix="/api/stock", tags=["stock"])


def _stock_transactions_time_range(time_filter: str, start_date_str: str | None, end_date_str: str | None):
    now = datetime.now(timezone.utc)
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


def _terminal_branch_id(current_user: User) -> str:
    return resolve_terminal_branch_id(current_user)


@stock_router.get("/")
def get_ingredient_stock_map(branch_id: str | None = None, current_user: User = Depends(get_current_user)):
    """Branch-scoped raw ingredient quantities (restaurant inventory)."""
    _ = branch_id
    resolved_branch_id = _terminal_branch_id(current_user)
    rows = IngredientBranchStock.query.filter_by(branch_id=resolved_branch_id).all()
    stock_map: dict[str, float] = {str(r.ingredient_id): float(r.current_stock) for r in rows}
    return {"ingredient_stock": stock_map, "branch_id": resolved_branch_id}


@stock_router.post("/update")
def update_ingredient_stock(payload: dict[str, Any] | None = None, current_user: User = Depends(get_current_user)):
    """Adjust ingredient quantity at a branch (creates a StockMovement)."""
    data = payload or {}
    branch_id = _terminal_branch_id(current_user)
    ingredient_id = data.get("ingredient_id")
    stock_delta = data.get("stock_delta", 0)
    try:
        raw_delta = float(stock_delta)
    except (TypeError, ValueError):
        return JSONResponse(status_code=400, content={"message": "stock_delta must be a number"})
    if not ingredient_id:
        return JSONResponse(status_code=400, content={"message": "ingredient_id required"})
    ing = db.session.get(Ingredient, int(ingredient_id))
    if not ing:
        return JSONResponse(status_code=404, content={"message": "Ingredient not found"})
    input_u = str(data.get("input_unit") or "").strip().lower()
    if input_u:
        try:
            sign = -1.0 if raw_delta < 0 else 1.0
            delta = sign * to_base_unit(abs(raw_delta), input_u, ing)
        except ValueError as exc:
            return JSONResponse(status_code=400, content={"message": str(exc)})
    else:
        delta = raw_delta
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


@stock_router.post("/prepared-update")
def update_prepared_item_stock(payload: dict[str, Any] | None = None, current_user: User = Depends(get_current_user)):
    """Adjust prepared item (sauce/marination) quantity at a branch (creates a PreparedItemStockMovement)."""
    data = payload or {}
    branch_id = _terminal_branch_id(current_user)
    prepared_item_id = data.get("prepared_item_id")
    stock_delta = data.get("stock_delta", 0)
    try:
        raw_delta = float(stock_delta)
    except (TypeError, ValueError):
        return JSONResponse(status_code=400, content={"message": "stock_delta must be a number"})
    if not prepared_item_id:
        return JSONResponse(status_code=400, content={"message": "prepared_item_id required"})
    item = db.session.get(PreparedItem, int(prepared_item_id))
    if not item:
        return JSONResponse(status_code=404, content={"message": "Prepared item not found"})

    item_unit = item.unit.value if hasattr(item.unit, "value") else str(item.unit or "")
    input_u = str(data.get("input_unit") or "").strip().lower()
    if input_u:
        try:
            sign = -1.0 if raw_delta < 0 else 1.0
            delta = sign * convert_quantity_to_unit(
                abs(raw_delta),
                normalize_unit_token(input_u),
                normalize_unit_token(item_unit),
            )
        except ValueError as exc:
            return JSONResponse(status_code=400, content={"message": str(exc)})
    else:
        delta = raw_delta

    try:
        _, qty_after = adjust_prepared_branch_stock(
            int(prepared_item_id),
            branch_id,
            delta,
            movement_type="adjustment",
            user_id=current_user.id,
            reference_id=None,
            reference_type="manual_adjustment",
            reason=data.get("reason") or "Manual stock adjustment",
            allow_negative=False,
        )
        sync_prepared_master_total(int(prepared_item_id))
        db.session.commit()
        return {"message": "Stock updated", "stock_level": qty_after}
    except Exception as exc:
        db.session.rollback()
        return JSONResponse(status_code=400, content={"message": str(exc)})


@stock_router.post("/bulk-restock")
def bulk_restock_ingredients(payload: BulkRestockRequest, current_user: User = Depends(get_current_user)):
    """Bulk restock ingredients for the current terminal branch in one transaction."""
    branch_id = _terminal_branch_id(current_user)
    ingredient_ids = {int(item.ingredient_id) for item in payload.items}
    ingredient_rows = (
        Ingredient.query.filter(Ingredient.id.in_(ingredient_ids)).all()
        if ingredient_ids
        else []
    )
    ingredients_by_id = {int(ing.id): ing for ing in ingredient_rows}
    missing_ids = sorted(iid for iid in ingredient_ids if iid not in ingredients_by_id)
    if missing_ids:
        return JSONResponse(
            status_code=404,
            content={"message": f"Ingredient not found: {missing_ids[0]}"},
        )

    touched_ingredient_ids: set[int] = set()
    results: list[dict[str, Any]] = []
    reason_text = (payload.reason or "").strip() or "Bulk restock"

    try:
        for line in payload.items:
            ingredient_id = int(line.ingredient_id)
            qty_in = float(line.quantity)
            ing = ingredients_by_id[ingredient_id]

            input_u = getattr(line, "input_unit", None)
            if input_u and str(input_u).strip():
                try:
                    ing_for_conv = ing
                    pkg_one = getattr(line, "packaging_units_per_one", None)
                    if pkg_one is not None and float(pkg_one) > 0:
                        u_tok = normalize_unit_token(str(input_u))
                        if u_tok in ("carton", "packet"):
                            raw_json = getattr(ing, "unit_conversions", None) or {}
                            ing_for_conv = {
                                "unit": ing.unit.value if hasattr(ing.unit, "value") else ing.unit,
                                "unit_conversions": {**dict(raw_json), u_tok: float(pkg_one)},
                            }
                    qty_add = to_base_unit(qty_in, str(input_u), ing_for_conv)
                except ValueError as exc:
                    db.session.rollback()
                    return JSONResponse(status_code=400, content={"message": str(exc)})
            else:
                qty_add = qty_in

            incoming_unit_cost = None if line.unit_cost is None else float(line.unit_cost)
            incoming_brand_name = str(getattr(line, "brand_name", "") or "").strip()
            movement_type = "adjustment"
            reference_type = "manual_adjustment"
            applied_unit_cost = float(ing.average_cost or 0.0)

            if incoming_unit_cost is not None:
                if input_u and str(input_u).strip() and qty_add > 0:
                    line_total = qty_in * float(incoming_unit_cost)
                    unit_cost_per_base = line_total / qty_add
                else:
                    unit_cost_per_base = float(incoming_unit_cost)
                apply_ingredient_purchase_cost(ing, branch_id, qty_add, unit_cost_per_base)
                movement_type = "purchase"
                reference_type = "bulk_restock"
                applied_unit_cost = unit_cost_per_base
            if incoming_brand_name and incoming_brand_name != str(getattr(ing, "brand_name", "") or "").strip():
                ing.brand_name = incoming_brand_name

            _, qty_after = adjust_branch_ingredient_stock(
                ingredient_id,
                branch_id,
                qty_add,
                movement_type=movement_type,
                user_id=current_user.id,
                reference_id=None,
                reference_type=reference_type,
                reason=reason_text,
                unit_cost=applied_unit_cost,
                allow_negative=False,
            )
            db.session.flush()
            mv = (
                StockMovement.query.filter_by(branch_id=branch_id, ingredient_id=ingredient_id)
                .order_by(StockMovement.id.desc())
                .first()
            )
            enqueue_sync_event(
                branch_id=branch_id,
                entity_type="stock_movement",
                entity_id=mv.id if mv else None,
                event_type="ingredient_stock_adjustment",
                payload={
                    "ingredient_id": ingredient_id,
                    "delta": qty_add,
                    "quantity_after": qty_after,
                },
            )
            touched_ingredient_ids.add(ingredient_id)
            results.append(
                {
                    "ingredient_id": ingredient_id,
                    "quantity_added": qty_add,
                    "quantity_after": qty_after,
                    "average_cost": float(ing.average_cost or 0.0),
                    "last_purchase_price": float(ing.last_purchase_price or 0.0),
                    "brand_name": ing.brand_name,
                }
            )

        for ingredient_id in touched_ingredient_ids:
            sync_ingredient_master_total(ingredient_id)
        db.session.commit()
        return {"message": "Bulk restock completed", "results": results}
    except Exception as exc:
        db.session.rollback()
        return JSONResponse(status_code=400, content={"message": str(exc)})


@stock_router.get("/transactions")
def get_stock_transactions(
    time_filter: str = "today",
    start_date: str | None = None,
    end_date: str | None = None,
    branch_id: str | None = None,
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
