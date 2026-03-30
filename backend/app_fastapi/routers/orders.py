from __future__ import annotations

from datetime import datetime, time, timedelta
from typing import Any, Optional

import anyio
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy import func, inspect

from app.errors import error_response
from app.order_metadata import normalize_order_type_and_snapshot
from app.models import (
    Branch,
    Inventory,
    InventoryTransaction,
    Modifier,
    OrderItemModifier,
    Product,
    Sale,
    SaleItem,
    Setting,
    User,
    db,
)
from app.services.printer_service import PrinterService
from app_fastapi.deps import get_current_user, require_owner
from app_fastapi.routers.common import yes
from app_fastapi.socketio_server import RealtimeEvents, emit_event

orders_router = APIRouter(prefix="/api/orders", tags=["orders"])


def _sales_table_columns() -> set[str]:
    return {c["name"] for c in inspect(db.engine).get_columns("sales")}


def get_time_filter_ranges(time_filter: str, start_date_str: str | None, end_date_str: str | None):
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


@orders_router.post("/checkout")
def checkout(payload: dict[str, Any] | None = None, current_user: User = Depends(get_current_user)):
    data = payload or {}
    if "items" not in data or "payment_method" not in data:
        return error_response("Bad Request", "Missing necessary checkout data", 400)
    _ = data.get("notes")
    items = data["items"]
    if not items:
        return error_response("Bad Request", "Cart is empty", 400)
    for idx, item in enumerate(items):
        if not isinstance(item, dict):
            return error_response("Bad Request", f"Item at index {idx} must be an object", 400)
        if item.get("product_id") is None:
            return error_response("Bad Request", f"Item at index {idx} missing product_id", 400)
        try:
            qty = int(item.get("quantity", 0))
        except (TypeError, ValueError):
            return error_response("Bad Request", f"Item at index {idx} quantity must be a positive integer", 400)
        if qty <= 0:
            return error_response("Bad Request", f"Item at index {idx} quantity must be positive", 400)
    branch_id = data.get("branch_id")
    if current_user.role != "owner":
        branch_id = current_user.branch_id
    elif not branch_id:
        branch_id = current_user.branch_id or 1
    if not branch_id:
        return error_response("Bad Request", "Branch ID must be provided or linked to the user", 400)

    order_type_norm, order_snapshot_norm, order_err = normalize_order_type_and_snapshot(data)
    if order_err:
        return error_response("Bad Request", order_err, 400)

    setting = Setting.query.filter_by(branch_id=branch_id).first() or Setting.query.filter_by(branch_id=None).first()
    tax_rate = 0.0
    if setting and setting.config.get("tax_enabled", True):
        rates_by_method = setting.config.get("tax_rates_by_payment_method") or {}
        payment_method = data.get("payment_method") or "Cash"
        if isinstance(rates_by_method.get(payment_method), (int, float)):
            tax_rate = float(rates_by_method[payment_method]) / 100.0
        elif "tax_percentage" in (setting.config or {}):
            tax_rate = float(setting.config["tax_percentage"]) / 100.0
    normalized_items, verr = _validate_cart_items(items)
    if verr:
        return verr
    assert normalized_items is not None

    all_mod_ids = sorted({mid for it in normalized_items for mid in (it.get("modifier_ids") or [])})
    mods_by_id: dict[int, Modifier] = {}
    if all_mod_ids:
        mods = Modifier.query.filter(Modifier.id.in_(all_mod_ids), Modifier.archived_at == None).all()  # noqa: E711
        mods_by_id = {m.id: m for m in mods}
        missing = [mid for mid in all_mod_ids if mid not in mods_by_id]
        if missing:
            return error_response("Bad Request", f"Unknown modifier(s): {missing}", 400)

    total_amount = 0.0
    try:
        new_sale = Sale(
            branch_id=branch_id,
            user_id=current_user.id,
            total_amount=0,
            tax_amount=0,
            payment_method=data["payment_method"],
            order_type=order_type_norm,
            order_snapshot=order_snapshot_norm,
            kitchen_status='placed',
            modifications=[],
        )
        db.session.add(new_sale)
        db.session.flush()
        for item in normalized_items:
            product = Product.query.get(item["product_id"])
            if product is None:
                db.session.rollback()
                return error_response("Bad Request", f"Product ID {item['product_id']} not found", 400)
            inventory = Inventory.query.filter_by(
                branch_id=branch_id, product_id=product.id, variant_sku_suffix=item.get("variant_sku_suffix", "")
            ).first()
            if not inventory or inventory.stock_level < item["quantity"]:
                db.session.rollback()
                return error_response("Bad Request", f"Insufficient stock for {product.title}", 400)
            inventory.stock_level -= item["quantity"]
            db.session.add(
                InventoryTransaction(
                    branch_id=branch_id,
                    product_id=product.id,
                    variant_sku_suffix=item.get("variant_sku_suffix", ""),
                    delta=-item["quantity"],
                    reason="sale",
                    user_id=current_user.id,
                    reference_type="sale",
                    reference_id=new_sale.id,
                )
            )
            unit_price = float(product.base_price)
            mods_price_each = sum(float(mods_by_id[mid].price or 0.0) for mid in (item.get("modifier_ids") or []))
            subtotal = (unit_price + mods_price_each) * item["quantity"]
            total_amount += subtotal
            sale_item = SaleItem(
                sale_id=new_sale.id,
                product_id=product.id,
                variant_sku_suffix=item.get("variant_sku_suffix", ""),
                quantity=item["quantity"],
                unit_price=unit_price,
                subtotal=subtotal,
            )
            db.session.add(sale_item)
            db.session.flush()
            for mid in (item.get("modifier_ids") or []):
                db.session.add(OrderItemModifier(order_item_id=sale_item.id, modifier_id=mid))
        discount_amount = 0.0
        discount_id = None
        discount_snapshot = None
        discount_data = data.get("discount")
        if discount_data and isinstance(discount_data, dict):
            d_type = discount_data.get("type")
            d_value = float(discount_data.get("value", 0) or 0)
            if d_type == "percent" and 0 <= d_value <= 100:
                discount_amount = total_amount * (d_value / 100.0)
            elif d_type == "fixed" and d_value >= 0:
                discount_amount = min(float(d_value), total_amount)
            if discount_amount > 0:
                discount_id = discount_data.get("id")
                discount_snapshot = {"name": discount_data.get("name") or "Discount", "type": d_type, "value": d_value}
        discounted_subtotal = total_amount - discount_amount
        new_sale.discount_amount = discount_amount
        new_sale.discount_id = discount_id
        new_sale.discount_snapshot = discount_snapshot
        new_sale.tax_amount = discounted_subtotal * tax_rate
        new_sale.total_amount = discounted_subtotal + new_sale.tax_amount
        db.session.commit()
        printer_service = PrinterService()
        branch_name = "Main Branch"
        branch_obj = Branch.query.get(branch_id) if branch_id else None
        if branch_obj:
            branch_name = branch_obj.name
        receipt_items = []
        for i in normalized_items:
            product = Product.query.get(i.get("product_id"))
            mod_names = [mods_by_id[mid].name for mid in (i.get("modifier_ids") or [])]
            title = str(product.title if product else "Item")
            if mod_names:
                title = f"{title} ({', '.join(mod_names)})"
            receipt_items.append(
                {
                    "title": title,
                    "quantity": int(i.get("quantity", 1)),
                    "unit_price": float(product.base_price) if product else 0.0,
                }
            )
        discount_name = discount_snapshot.get("name") if isinstance(discount_snapshot, dict) else "Discount"
        print_success = printer_service.print_receipt(
            {
                "total": float(new_sale.total_amount),
                "subtotal": float(total_amount),
                "tax_amount": float(new_sale.tax_amount),
                "tax_rate": float(tax_rate),
                "discount_amount": float(discount_amount),
                "discount_name": discount_name or "Discount",
                "operator": current_user.username,
                "branch": branch_name,
                "branch_id": branch_id,
                "items": receipt_items,
                "order_type": order_type_norm,
                "order_snapshot": order_snapshot_norm,
            }
        )
        anyio.from_thread.run(
            emit_event,
            RealtimeEvents.ORDER_CREATED,
            {"sale_id": new_sale.id, "branch_id": branch_id, "kitchen_status": "placed"},
        )
        return JSONResponse(
            status_code=201,
            content={
                "message": "Checkout successful",
                "sale_id": new_sale.id,
                "total": float(new_sale.total_amount),
                "print_success": print_success,
            },
        )
    except Exception as exc:
        db.session.rollback()
        return error_response("Bad Request", f"Checkout failed: {str(exc)}", 400)


@orders_router.get("/")
def get_sales(
    time_filter: str = "today",
    start_date: str | None = None,
    end_date: str | None = None,
    branch_id: int | None = None,
    include_archived: str | None = None,
    include_open: str | None = None,
    current_user: User = Depends(get_current_user),
):
    try:
        sales_cols = _sales_table_columns()
        has_status_col = "status" in sales_cols
        has_order_type_col = "order_type" in sales_cols
        has_archived_at_col = "archived_at" in sales_cols

        start_dt, end_dt = get_time_filter_ranges(time_filter, start_date, end_date)
        query = db.session.query(
            Sale.id,
            Sale.branch_id,
            Sale.user_id,
            Sale.total_amount,
            Sale.created_at,
            Sale.payment_method,
        )
        if has_status_col:
            query = query.add_columns(Sale.status)
        if has_order_type_col:
            query = query.add_columns(Sale.order_type)
        if has_archived_at_col:
            query = query.add_columns(Sale.archived_at)

        if not yes(include_archived) and has_archived_at_col:
            query = query.filter(Sale.archived_at == None)  # noqa: E711
        if not yes(include_open) and has_status_col:
            query = query.filter(Sale.status != "open")
        if current_user.role != "owner":
            query = query.filter(Sale.branch_id == current_user.branch_id)
        elif branch_id:
            query = query.filter(Sale.branch_id == int(branch_id))
        elif current_user.branch_id:
            query = query.filter(Sale.branch_id == current_user.branch_id)
        if start_dt and end_dt:
            query = query.filter(Sale.created_at >= start_dt, Sale.created_at <= end_dt)

        sales_rows = query.order_by(Sale.created_at.desc()).all()
        out = []
        for row in sales_rows:
            row_iter = iter(row)
            sale_id = next(row_iter)
            sale_branch_id = next(row_iter)
            sale_user_id = next(row_iter)
            sale_total_amount = next(row_iter)
            sale_created_at = next(row_iter)
            sale_payment_method = next(row_iter)
            sale_status = next(row_iter) if has_status_col else "completed"
            sale_order_type = next(row_iter) if has_order_type_col else None
            sale_archived_at = next(row_iter) if has_archived_at_col else None
            row_dict = {
                "id": sale_id,
                "branch_id": sale_branch_id,
                "user_id": sale_user_id,
                "total_amount": float(sale_total_amount),
                "created_at": sale_created_at.isoformat(),
                "payment_method": sale_payment_method,
                "status": sale_status or "completed",
                "order_type": sale_order_type,
            }
            if sale_archived_at:
                row_dict["archived_at"] = sale_archived_at.isoformat()
            out.append(row_dict)
        return {"sales": out}
    except Exception as exc:
        raise


@orders_router.get("/analytics")
def get_analytics(
    time_filter: str = "today",
    start_date: str | None = None,
    end_date: str | None = None,
    branch_id: int | None = None,
    current_user: User = Depends(get_current_user),
):
    try:
        sales_cols = _sales_table_columns()
        has_status_col = "status" in sales_cols

        start_dt, end_dt = get_time_filter_ranges(time_filter, start_date, end_date)
        query = db.session.query(Sale.id, Sale.total_amount, Sale.branch_id, Sale.created_at)
        if has_status_col:
            query = query.add_columns(Sale.status).filter(Sale.status != "refunded", Sale.status != "open")
        if current_user.role != "owner":
            query = query.filter(Sale.branch_id == current_user.branch_id)
        elif branch_id:
            query = query.filter(Sale.branch_id == int(branch_id))
        elif current_user.branch_id:
            query = query.filter(Sale.branch_id == current_user.branch_id)
        if start_dt and end_dt:
            query = query.filter(Sale.created_at >= start_dt, Sale.created_at <= end_dt)
        q_sales = query.all()
        sale_ids = [r[0] for r in q_sales]
        total_sales = float(sum(float(r[1] or 0.0) for r in q_sales))
        total_transactions = len(q_sales)
        most_selling = None
        if total_transactions > 0 and sale_ids:
            top_row = (
                db.session.query(SaleItem.product_id, func.sum(SaleItem.quantity).label("total_qty"))
                .filter(SaleItem.sale_id.in_(sale_ids))
                .group_by(SaleItem.product_id)
                .order_by(func.sum(SaleItem.quantity).desc())
                .first()
            )
            if top_row:
                product = Product.query.get(top_row.product_id)
                if product:
                    most_selling = {"id": product.id, "title": product.title, "total_sold": int(top_row.total_qty)}
        return {"total_sales": float(total_sales), "total_transactions": total_transactions, "most_selling_product": most_selling}
    except Exception as exc:
        raise


def _validate_cart_items(items: list) -> tuple[Optional[list[dict]], Optional[JSONResponse]]:
    if not items:
        return None, error_response("Bad Request", "Cart is empty", 400)
    normalized: list[dict] = []
    for idx, item in enumerate(items):
        if not isinstance(item, dict):
            return None, error_response("Bad Request", f"Item at index {idx} must be an object", 400)
        if item.get("product_id") is None:
            return None, error_response("Bad Request", f"Item at index {idx} missing product_id", 400)
        try:
            qty = int(item.get("quantity", 0))
        except (TypeError, ValueError):
            return None, error_response("Bad Request", f"Item at index {idx} quantity must be a positive integer", 400)
        if qty <= 0:
            return None, error_response("Bad Request", f"Item at index {idx} quantity must be positive", 400)

        raw_mods = item.get("modifier_ids") if isinstance(item, dict) else None
        if raw_mods is None:
            raw_mods = item.get("modifiers") if isinstance(item, dict) else None
        modifier_ids: list[int] = []
        if raw_mods is not None:
            if not isinstance(raw_mods, list):
                return None, error_response("Bad Request", f"Item at index {idx} modifiers must be an array", 400)
            try:
                modifier_ids = sorted({int(x) for x in raw_mods if x is not None and str(x).strip() != ""})
            except Exception:
                return None, error_response("Bad Request", f"Item at index {idx} modifiers must be integer IDs", 400)
        normalized.append(
            {
                "product_id": int(item["product_id"]),
                "variant_sku_suffix": item.get("variant_sku_suffix", "") or "",
                "quantity": qty,
                "modifier_ids": modifier_ids,
            }
        )
    return normalized, None


def _resolve_branch_id(data: dict[str, Any], current_user: User) -> tuple[int | None, JSONResponse | None]:
    branch_id = data.get("branch_id")
    if current_user.role != "owner":
        branch_id = current_user.branch_id
    elif not branch_id:
        branch_id = current_user.branch_id or 1
    if not branch_id:
        return None, error_response("Bad Request", "Branch ID must be provided or linked to the user", 400)
    return int(branch_id), None


@orders_router.get("/active")
def list_active_dine_in_orders(
    branch_id: int | None = None,
    include_archived: str | None = None,
    include_items: str | None = None,
    current_user: User = Depends(get_current_user),
):
    """Unpaid dine-in tabs (KOT sent, payment not finalized). Pass include_items=1 for line items (e.g. KDS)."""
    try:
        sales_cols = _sales_table_columns()
        has_status_col = "status" in sales_cols
        has_order_type_col = "order_type" in sales_cols
        has_archived_at_col = "archived_at" in sales_cols
        has_order_snapshot_col = "order_snapshot" in sales_cols

        # Select only columns that exist in the DB schema.
        select_cols: list[tuple[str, Any]] = []
        def _maybe_add(key: str, col: Any) -> None:
            if key in sales_cols:
                select_cols.append((key, col))

        _maybe_add("id", Sale.id)
        _maybe_add("branch_id", Sale.branch_id)
        _maybe_add("user_id", Sale.user_id)
        _maybe_add("total_amount", Sale.total_amount)
        _maybe_add("tax_amount", Sale.tax_amount)
        _maybe_add("payment_method", Sale.payment_method)
        _maybe_add("created_at", Sale.created_at)
        _maybe_add("status", Sale.status)
        _maybe_add("archived_at", Sale.archived_at)
        _maybe_add("order_type", Sale.order_type)
        _maybe_add("order_snapshot", Sale.order_snapshot)
        _maybe_add("kitchen_status", Sale.kitchen_status)

        if not select_cols:
            return {"sales": []}

        query = db.session.query(*[col for _, col in select_cols])

        if has_status_col:
            query = query.filter(Sale.status == "open")

        if has_order_type_col:
            query = query.filter(Sale.order_type == "dine_in")

        if has_archived_at_col and not yes(include_archived):
            query = query.filter(Sale.archived_at == None)  # noqa: E711

        if current_user.role != "owner":
            query = query.filter(Sale.branch_id == current_user.branch_id)
        elif branch_id is not None:
            query = query.filter(Sale.branch_id == int(branch_id))
        elif current_user.branch_id:
            query = query.filter(Sale.branch_id == current_user.branch_id)

        query = query.order_by(Sale.created_at.desc())
        rows = query.all()

        # Build lightweight order dicts (avoid ORM entity loading for missing columns).
        select_keys = [k for k, _ in select_cols]
        includeItems = yes(include_items)
        out: list[dict[str, Any]] = []
        sale_ids: list[int] = []
        for row in rows:
            data = {k: v for k, v in zip(select_keys, row)}
            snap = data.get("order_snapshot") or {}
            table_name = snap.get("table_name") if isinstance(snap, dict) else None

            # If order_type column is missing, we infer dine_in from the JSON snapshot.
            if not has_order_type_col:
                if not table_name:
                    continue
                inferred_order_type = "dine_in"
            else:
                inferred_order_type = data.get("order_type")

            sale_id_val = data.get("id")
            if sale_id_val is None:
                continue

            out_row: dict[str, Any] = {
                "id": sale_id_val,
                "branch_id": data.get("branch_id"),
                "user_id": data.get("user_id"),
                "total_amount": float(data.get("total_amount") or 0),
                "tax_amount": float(data.get("tax_amount") or 0),
                "created_at": data["created_at"].isoformat() if data.get("created_at") else "",
                "payment_method": data.get("payment_method"),
                "status": data.get("status") or "completed",
                "order_type": inferred_order_type,
                "order_snapshot": snap,
                "table_name": table_name,
                "kitchen_status": data.get("kitchen_status") or "placed",
            }
            out.append(out_row)
            sale_ids.append(sale_id_val)

        if includeItems and sale_ids:
            items_rows = (
                db.session.query(
                    SaleItem.sale_id,
                    SaleItem.variant_sku_suffix,
                    SaleItem.quantity,
                    Product.title,
                )
                .outerjoin(Product, SaleItem.product_id == Product.id)
                .filter(SaleItem.sale_id.in_(sale_ids))
                .all()
            )

            items_by_sale: dict[int, list[dict[str, Any]]] = {}
            for s_id, variant_suf, qty, product_title in items_rows:
                items_by_sale.setdefault(s_id, []).append(
                    {
                        "product_title": product_title if product_title else "Unknown",
                        "variant_sku_suffix": variant_suf or "",
                        "quantity": qty,
                    }
                )

            for out_row in out:
                out_row["items"] = items_by_sale.get(out_row["id"], [])

        return {"sales": out}
    except Exception as exc:
        raise


@orders_router.get("/kitchen")
def list_kitchen_orders(
    branch_id: int | None = None,
    include_completed: str | None = None,
    current_user: User = Depends(get_current_user),
):
    """Kitchen Display: returns orders with kitchen_status new/in_progress (+ completed if requested)."""
    try:
        sales_cols = _sales_table_columns()
        if "kitchen_status" not in sales_cols:
            return {"orders": []}

        # Back-compat: older versions used "accepted" between placed→preparing.
        statuses = ["placed", "accepted", "preparing", "ready"]

        query = db.session.query(Sale).filter(Sale.kitchen_status.in_(statuses))

        if current_user.role != "owner":
            if current_user.branch_id:
                query = query.filter(Sale.branch_id == current_user.branch_id)
            elif branch_id is not None:
                query = query.filter(Sale.branch_id == int(branch_id))
        elif branch_id is not None:
            query = query.filter(Sale.branch_id == int(branch_id))
        elif current_user.branch_id:
            query = query.filter(Sale.branch_id == current_user.branch_id)

        query = query.order_by(
            db.case(
                (Sale.kitchen_status == "placed", 0),
                (Sale.kitchen_status == "preparing", 1),
                (Sale.kitchen_status == "ready", 2),
                else_=3,
            ),
            Sale.created_at.asc(),
        )

        sales = query.all()
        out: list[dict[str, Any]] = []
        for sale in sales:
            snap = getattr(sale, "order_snapshot", None) or {}
            table_name = snap.get("table_name") if isinstance(snap, dict) else None
            items_list = []
            for si in sale.items:
                mods = [oim.modifier.name for oim in getattr(si, "modifiers", []) if oim.modifier and oim.modifier.archived_at is None]
                items_list.append(
                    {
                        "product_title": si.product.title if si.product else "Unknown",
                        "variant_sku_suffix": si.variant_sku_suffix or "",
                        "quantity": si.quantity,
                        "modifiers": mods,
                    }
                )
            ks = sale.kitchen_status
            if ks == "accepted":
                ks = "placed"
            out.append({
                "id": sale.id,
                "order_type": getattr(sale, "order_type", None),
                "order_snapshot": snap,
                "table_name": table_name,
                "kitchen_status": ks,
                "modifications": getattr(sale, "modifications", []) or [],
                "created_at": sale.created_at.isoformat() if sale.created_at else "",
                "items": items_list,
            })
        return {"orders": out}
    except Exception:
        raise


@orders_router.patch("/{sale_id}/kitchen-status")
def update_kitchen_status(
    sale_id: int,
    payload: dict[str, Any] | None = None,
    current_user: User = Depends(get_current_user),
):
    """Advance kitchen workflow: new → in_progress → completed, or recall completed → in_progress."""
    sale = Sale.query.get(sale_id)
    if not sale:
        raise HTTPException(status_code=404, detail="Not Found")
    if current_user.role != "owner" and sale.branch_id != current_user.branch_id:
        return error_response("Forbidden", "Unauthorized", 403)
    data = payload or {}
    new_status = data.get("kitchen_status")
    valid_transitions = {
        "placed": ["preparing"],
        "accepted": ["preparing"],
        "preparing": ["ready"],
        "ready": [],
    }
    current = getattr(sale, "kitchen_status", "none")
    allowed = valid_transitions.get(current, [])
    if new_status not in allowed:
        return error_response(
            "Bad Request",
            f"Cannot transition from '{current}' to '{new_status}'. Allowed: {allowed}",
            400,
        )
    try:
        sale.kitchen_status = new_status
        db.session.commit()
        anyio.from_thread.run(
            emit_event,
            RealtimeEvents.ORDER_STATUS_CHANGED,
            {"sale_id": sale.id, "branch_id": sale.branch_id, "kitchen_status": new_status},
        )
        return {"message": "Kitchen status updated", "sale_id": sale.id, "kitchen_status": new_status}
    except Exception as exc:
        db.session.rollback()
        return error_response("Internal Server Error", str(exc), 500)


@orders_router.post("/dine-in/kot")
def dine_in_kot(payload: dict[str, Any] | None = None, current_user: User = Depends(get_current_user)):
    """Create an open dine-in sale, deduct stock, print KOT (kitchen ticket). No payment yet."""
    data = payload or {}
    if "items" not in data:
        return error_response("Bad Request", "Missing items", 400)
    items, verr = _validate_cart_items(data["items"])
    if verr:
        return verr
    assert items is not None

    all_mod_ids = sorted({mid for it in items for mid in (it.get("modifier_ids") or [])})
    mods_by_id: dict[int, Modifier] = {}
    if all_mod_ids:
        mods = Modifier.query.filter(Modifier.id.in_(all_mod_ids), Modifier.archived_at == None).all()  # noqa: E711
        mods_by_id = {m.id: m for m in mods}
        missing = [mid for mid in all_mod_ids if mid not in mods_by_id]
        if missing:
            return error_response("Bad Request", f"Unknown modifier(s): {missing}", 400)

    bid, berr = _resolve_branch_id(data, current_user)
    if berr:
        return berr
    assert bid is not None

    order_type_norm, order_snapshot_norm, order_err = normalize_order_type_and_snapshot(
        {"order_type": "dine_in", "order_snapshot": data.get("order_snapshot")}
    )
    if order_err:
        return error_response("Bad Request", order_err, 400)
    assert order_type_norm == "dine_in"

    try:
        new_sale = Sale(
            branch_id=bid,
            user_id=current_user.id,
            total_amount=0,
            tax_amount=0,
            payment_method=None,
            status="open",
            order_type=order_type_norm,
            order_snapshot=order_snapshot_norm,
            kitchen_status='placed',
            modifications=[],
        )
        db.session.add(new_sale)
        db.session.flush()
        total_amount = 0.0
        for item in items:
            product = Product.query.get(item["product_id"])
            if product is None:
                db.session.rollback()
                return error_response("Bad Request", f"Product ID {item['product_id']} not found", 400)
            inventory = Inventory.query.filter_by(
                branch_id=bid, product_id=product.id, variant_sku_suffix=item["variant_sku_suffix"]
            ).first()
            if not inventory or inventory.stock_level < item["quantity"]:
                db.session.rollback()
                return error_response("Bad Request", f"Insufficient stock for {product.title}", 400)
            inventory.stock_level -= item["quantity"]
            db.session.add(
                InventoryTransaction(
                    branch_id=bid,
                    product_id=product.id,
                    variant_sku_suffix=item["variant_sku_suffix"],
                    delta=-item["quantity"],
                    reason="sale",
                    user_id=current_user.id,
                    reference_type="sale",
                    reference_id=new_sale.id,
                )
            )
            unit_price = float(product.base_price)
            mods_price_each = sum(float(mods_by_id[mid].price or 0.0) for mid in (item.get("modifier_ids") or []))
            subtotal = (unit_price + mods_price_each) * item["quantity"]
            total_amount += subtotal
            sale_item = SaleItem(
                sale_id=new_sale.id,
                product_id=product.id,
                variant_sku_suffix=item["variant_sku_suffix"],
                quantity=item["quantity"],
                unit_price=unit_price,
                subtotal=subtotal,
            )
            db.session.add(sale_item)
            db.session.flush()
            for mid in (item.get("modifier_ids") or []):
                db.session.add(OrderItemModifier(order_item_id=sale_item.id, modifier_id=mid))
        new_sale.discount_amount = 0
        new_sale.discount_id = None
        new_sale.discount_snapshot = None
        new_sale.total_amount = total_amount
        new_sale.tax_amount = 0
        db.session.commit()

        branch_name = "Main Branch"
        branch_obj = Branch.query.get(bid) if bid else None
        if branch_obj:
            branch_name = branch_obj.name
        table_name = (order_snapshot_norm or {}).get("table_name", "") if isinstance(order_snapshot_norm, dict) else ""
        kot_items = []
        for item in items:
            product = Product.query.get(item["product_id"])
            suf = item["variant_sku_suffix"] or ""
            mod_names = [mods_by_id[mid].name for mid in (item.get("modifier_ids") or [])]
            mod_suffix = f" + {', '.join(mod_names)}" if mod_names else ""
            kot_items.append(
                {
                    "title": str((product.title if product else "Item") + mod_suffix),
                    "quantity": int(item["quantity"]),
                    "variant": suf,
                }
            )
        printer_service = PrinterService()
        print_ok = printer_service.print_kot(
            {
                "sale_id": new_sale.id,
                "branch_id": bid,
                "branch": branch_name,
                "operator": current_user.username,
                "table_name": table_name,
                "items": kot_items,
            }
        )
        anyio.from_thread.run(
            emit_event,
            RealtimeEvents.ORDER_CREATED,
            {"sale_id": new_sale.id, "branch_id": bid, "kitchen_status": "placed", "status": "open", "order_type": "dine_in"},
        )
        return JSONResponse(
            status_code=201,
            content={
                "message": "Kitchen order ticket sent",
                "sale_id": new_sale.id,
                "print_success": print_ok,
            },
        )
    except Exception as exc:
        db.session.rollback()
        return error_response("Bad Request", f"KOT failed: {str(exc)}", 400)


@orders_router.patch("/{sale_id}/items")
def update_open_sale_items(sale_id: int, payload: dict[str, Any] | None = None, current_user: User = Depends(get_current_user)):
    """Update line items on an unpaid dine-in sale using event-driven diffing."""
    sale = Sale.query.get(sale_id)
    if not sale:
        raise HTTPException(status_code=404, detail="Not Found")
    if current_user.role != "owner" and sale.branch_id != current_user.branch_id:
        return error_response("Forbidden", "Unauthorized", 403)
    if getattr(sale, "status", "") != "open":
        return error_response("Bad Request", "Only open unpaid orders can be edited", 400)
    data = payload or {}
    if "items" not in data:
        return error_response("Bad Request", "Missing items", 400)
    items, verr = _validate_cart_items(data["items"])
    if verr:
        return verr
    assert items is not None

    try:
        old_items = list(sale.items)
        old_counts: dict[tuple[int | None, str, tuple[int, ...]], int] = {}
        for old in old_items:
            mods = sorted({oim.modifier_id for oim in getattr(old, "modifiers", [])})
            key = (old.product_id, old.variant_sku_suffix or "", tuple(mods))
            old_counts[key] = old_counts.get(key, 0) + old.quantity
            
        new_counts: dict[tuple[int, str, tuple[int, ...]], int] = {}
        for item in items:
            key = (item["product_id"], item["variant_sku_suffix"], tuple(item.get("modifier_ids") or []))
            new_counts[key] = new_counts.get(key, 0) + item["quantity"]

        now_iso = datetime.utcnow().isoformat()
        events = []
        
        # Compute diffs and events
        all_mod_ids = sorted({mid for it in items for mid in (it.get("modifier_ids") or [])})
        mods_by_id: dict[int, Modifier] = {}
        if all_mod_ids:
            mods = Modifier.query.filter(Modifier.id.in_(all_mod_ids), Modifier.archived_at == None).all()  # noqa: E711
            mods_by_id = {m.id: m for m in mods}
            missing = [mid for mid in all_mod_ids if mid not in mods_by_id]
            if missing:
                db.session.rollback()
                return error_response("Bad Request", f"Unknown modifier(s): {missing}", 400)

        diffs: dict[tuple[Any, ...], int] = {}  # key -> delta
        for key, qty in new_counts.items():
            old_qty = old_counts.get(key, 0)
            if qty != old_qty:
                diffs[key] = qty - old_qty
                
        for key, old_qty in old_counts.items():
            if key not in new_counts:
                diffs[key] = -old_qty

        if not diffs:
            return {"message": "No changes made", "sale_id": sale_id, "total_amount": float(sale.total_amount)}
            
        kitchen_status = getattr(sale, "kitchen_status", "none")
        order_type = getattr(sale, "order_type", "dine_in")
        
        # Block takeaway/delivery if they are already being prepared
        if order_type != "dine_in" and kitchen_status in ("preparing", "ready"):
            db.session.rollback()
            return error_response("Bad Request", f"Modification blocked: {order_type} order is already in {kitchen_status} status.", 400)

        if kitchen_status in ("ready",):
            for key, delta in diffs.items():
                if delta < 0:
                    db.session.rollback()
                    return error_response("Bad Request", "Cannot remove or reduce items that are already ready.", 400)

        for key, delta in diffs.items():
            product_id, variant, mod_ids = key
            product = Product.query.get(product_id)
            mod_names = [mods_by_id[mid].name for mid in mod_ids] if mod_ids else []
            title = product.title + (f" ({variant})" if variant else "") if product else f"Item {product_id}"
            if mod_names:
                title = f"{title} + {', '.join(mod_names)}"
            
            if kitchen_status == "preparing":
                if delta > 0:
                    events.append({"type": "add", "description": f"Add {delta}x {title}", "timestamp": now_iso, "product_title": title})
                elif delta < 0:
                    events.append({"type": "remove", "description": f"Remove {abs(delta)}x {title}", "timestamp": now_iso, "product_title": title})
                
        # Apply Inventory Transactions and update SaleItems
        for key, delta in diffs.items():
            product_id, variant, mod_ids = key
            product = Product.query.get(product_id)
            if not product:
                db.session.rollback()
                return error_response("Bad Request", f"Product ID {product_id} not found", 400)
                
            unit_price = float(product.base_price)
            mods_price_each = sum(float(mods_by_id[mid].price or 0.0) for mid in mod_ids) if mod_ids else 0.0
            
            # Inventory adjustment
            inventory = Inventory.query.filter_by(
                branch_id=sale.branch_id, product_id=product.id, variant_sku_suffix=variant
            ).first()
            if delta > 0 and (not inventory or inventory.stock_level < delta):
                db.session.rollback()
                return error_response("Bad Request", f"Insufficient stock for {title}", 400)
                
            if inventory:
                inventory.stock_level -= delta
            
            db.session.add(
                InventoryTransaction(
                    branch_id=sale.branch_id,
                    product_id=product.id,
                    variant_sku_suffix=variant,
                    delta=-delta,
                    reason="adjustment",
                    user_id=current_user.id,
                    reference_type="sale",
                    reference_id=sale_id,
                )
            )
            
            existing_rows = []
            for i in sale.items:
                if i.product_id != product_id or (i.variant_sku_suffix or "") != variant:
                    continue
                existing_mods = sorted({oim.modifier_id for oim in getattr(i, "modifiers", [])})
                if tuple(existing_mods) == tuple(mod_ids):
                    existing_rows.append(i)

            if delta > 0:
                if existing_rows:
                    existing_rows[0].quantity += delta
                    existing_rows[0].subtotal = float(existing_rows[0].quantity) * (unit_price + mods_price_each)
                else:
                    new_row = SaleItem(
                        sale_id=sale_id,
                        product_id=product.id,
                        variant_sku_suffix=variant,
                        quantity=delta,
                        unit_price=unit_price,
                        subtotal=(unit_price + mods_price_each) * delta,
                    )
                    db.session.add(new_row)
                    db.session.flush()
                    for mid in mod_ids:
                        db.session.add(OrderItemModifier(order_item_id=new_row.id, modifier_id=mid))
            elif delta < 0:
                remaining_to_remove = abs(delta)
                for row in existing_rows:
                    if remaining_to_remove <= 0:
                        break
                    if row.quantity <= remaining_to_remove:
                        remaining_to_remove -= row.quantity
                        db.session.delete(row)
                    else:
                        row.quantity -= remaining_to_remove
                        row.subtotal = float(row.quantity) * (unit_price + mods_price_each)
                        remaining_to_remove = 0

        # Recalculate totals
        db.session.flush()
        total_amount = sum(float(i.subtotal) for i in sale.items)
        sale.total_amount = total_amount
        sale.tax_amount = 0
        sale.discount_amount = 0
        sale.discount_id = None
        sale.discount_snapshot = None
        
        # Append events to modifications
        if events:
            if not getattr(sale, "modifications", None):
                sale.modifications = []
            sale.modifications = list(sale.modifications) + events
            from sqlalchemy.orm.attributes import flag_modified
            flag_modified(sale, "modifications")

        db.session.commit()
        anyio.from_thread.run(
            emit_event,
            RealtimeEvents.ORDER_UPDATED,
            {"sale_id": sale.id, "branch_id": sale.branch_id, "kitchen_status": getattr(sale, "kitchen_status", "placed")},
        )
        return {"message": "Order updated with modifications", "sale_id": sale_id, "total_amount": float(total_amount), "events": events}
    except Exception as exc:
        db.session.rollback()
        return error_response("Bad Request", f"Update failed: {str(exc)}", 400)


@orders_router.post("/{sale_id}/modifications")
def add_manual_modification(sale_id: int, payload: dict[str, Any] | None = None, current_user: User = Depends(get_current_user)):
    """Add a free-text modification to an order without changing cart items."""
    sale = Sale.query.get(sale_id)
    if not sale:
        raise HTTPException(status_code=404, detail="Not Found")
    if current_user.role != "owner" and sale.branch_id != current_user.branch_id:
        return error_response("Forbidden", "Unauthorized", 403)
    if getattr(sale, "status", "") != "open":
        return error_response("Bad Request", "Order must be open", 400)
        
    kitchen_status = getattr(sale, "kitchen_status", "none")
    order_type = getattr(sale, "order_type", "dine_in")
    if order_type != "dine_in" and kitchen_status in ("preparing", "ready"):
        return error_response("Bad Request", f"Modification blocked: {order_type} order is already in {kitchen_status} status.", 400)
        
    data = payload or {}
    mod_type = data.get("type", "update")
    description = data.get("description", "").strip()
    
    if not description:
        return error_response("Bad Request", "Description is required", 400)
        
    now_iso = datetime.utcnow().isoformat()
    event = {
        "type": mod_type,
        "description": description,
        "timestamp": now_iso,
        "product_title": "Manual Note"
    }
    
    if not getattr(sale, "modifications", None):
        sale.modifications = []
    sale.modifications = list(sale.modifications) + [event]
    
    # If the order was already ready, we must put it back into the kitchen queue
    # so the chefs see the new modification note.
    kitchen_status = getattr(sale, "kitchen_status", "none")
    if kitchen_status in ("ready",):
        sale.kitchen_status = "placed"
        
    from sqlalchemy.orm.attributes import flag_modified
    flag_modified(sale, "modifications")
    
    db.session.commit()
    return {"message": "Modification added to order", "events": sale.modifications}


@orders_router.post("/{sale_id}/finalize")
def finalize_open_sale(sale_id: int, payload: dict[str, Any] | None = None, current_user: User = Depends(get_current_user)):
    """Take payment on an open dine-in sale; prints customer receipt."""
    sale = Sale.query.get(sale_id)
    if not sale:
        raise HTTPException(status_code=404, detail="Not Found")
    if current_user.role != "owner" and sale.branch_id != current_user.branch_id:
        return error_response("Forbidden", "Unauthorized", 403)
    if getattr(sale, "status", "") != "open":
        return error_response("Bad Request", "Order is not awaiting payment", 400)
    data = payload or {}
    if not data.get("payment_method"):
        return error_response("Bad Request", "payment_method is required", 400)

    setting = Setting.query.filter_by(branch_id=sale.branch_id).first() or Setting.query.filter_by(branch_id=None).first()
    tax_rate = 0.0
    if setting and setting.config.get("tax_enabled", True):
        rates_by_method = setting.config.get("tax_rates_by_payment_method") or {}
        payment_method = data.get("payment_method") or "Cash"
        if isinstance(rates_by_method.get(payment_method), (int, float)):
            tax_rate = float(rates_by_method[payment_method]) / 100.0
        elif "tax_percentage" in (setting.config or {}):
            tax_rate = float(setting.config["tax_percentage"]) / 100.0

    items_sum = sum(float(i.subtotal) for i in sale.items)
    discount_amount = 0.0
    discount_id = None
    discount_snapshot = None
    discount_data = data.get("discount")
    if discount_data and isinstance(discount_data, dict):
        d_type = discount_data.get("type")
        d_value = float(discount_data.get("value", 0) or 0)
        if d_type == "percent" and 0 <= d_value <= 100:
            discount_amount = items_sum * (d_value / 100.0)
        elif d_type == "fixed" and d_value >= 0:
            discount_amount = min(float(d_value), items_sum)
        if discount_amount > 0:
            discount_id = discount_data.get("id")
            discount_snapshot = {"name": discount_data.get("name") or "Discount", "type": d_type, "value": d_value}
    discounted_subtotal = items_sum - discount_amount
    tax_amount = discounted_subtotal * tax_rate
    total_with_tax = discounted_subtotal + tax_amount

    try:
        sale.payment_method = data["payment_method"]
        sale.discount_amount = discount_amount
        sale.discount_id = discount_id
        sale.discount_snapshot = discount_snapshot
        sale.tax_amount = tax_amount
        sale.total_amount = total_with_tax
        sale.status = "completed"
        db.session.commit()
        anyio.from_thread.run(
            emit_event,
            RealtimeEvents.ORDER_STATUS_CHANGED,
            {"sale_id": sale.id, "branch_id": sale.branch_id, "status": "completed"},
        )

        branch_name = "Main Branch"
        if sale.branch:
            branch_name = sale.branch.name
        receipt_items = [
            {
                "title": str(i.product.title if i.product else "Item"),
                "quantity": i.quantity,
                "unit_price": float(i.unit_price),
            }
            for i in sale.items
        ]
        discount_name = discount_snapshot.get("name") if isinstance(discount_snapshot, dict) else "Discount"
        printer_service = PrinterService()
        print_success = printer_service.print_receipt(
            {
                "total": float(sale.total_amount),
                "subtotal": float(items_sum),
                "tax_amount": float(sale.tax_amount),
                "tax_rate": float(tax_rate),
                "discount_amount": float(discount_amount),
                "discount_name": discount_name or "Discount",
                "operator": current_user.username,
                "branch": branch_name,
                "branch_id": sale.branch_id,
                "items": receipt_items,
                "order_type": getattr(sale, "order_type", None),
                "order_snapshot": getattr(sale, "order_snapshot", None),
            }
        )
        return JSONResponse(
            status_code=200,
            content={
                "message": "Payment completed",
                "sale_id": sale.id,
                "total": float(sale.total_amount),
                "print_success": print_success,
            },
        )
    except Exception as exc:
        db.session.rollback()
        return error_response("Bad Request", f"Finalize failed: {str(exc)}", 400)


@orders_router.post("/{sale_id}/cancel-open")
def cancel_open_sale(sale_id: int, current_user: User = Depends(get_current_user)):
    """Cancel an unpaid dine-in tab and restore stock."""
    sale = Sale.query.get(sale_id)
    if not sale:
        raise HTTPException(status_code=404, detail="Not Found")
    if current_user.role != "owner" and sale.branch_id != current_user.branch_id:
        return error_response("Forbidden", "Unauthorized", 403)
    if getattr(sale, "status", "") != "open":
        return error_response("Bad Request", "Only open unpaid orders can be cancelled this way", 400)
    try:
        for item in list(sale.items):
            inventory = Inventory.query.filter_by(
                branch_id=sale.branch_id,
                product_id=item.product_id,
                variant_sku_suffix=item.variant_sku_suffix or "",
            ).first()
            if inventory is not None:
                inventory.stock_level += item.quantity
                db.session.add(
                    InventoryTransaction(
                        branch_id=sale.branch_id,
                        product_id=item.product_id,
                        variant_sku_suffix=item.variant_sku_suffix or "",
                        delta=item.quantity,
                        reason="adjustment",
                        user_id=current_user.id,
                        reference_type="sale",
                        reference_id=sale_id,
                    )
                )
        db.session.delete(sale)
        db.session.commit()
        anyio.from_thread.run(
            emit_event,
            RealtimeEvents.ORDER_STATUS_CHANGED,
            {"sale_id": sale_id, "branch_id": sale.branch_id, "status": "cancelled"},
        )
        return {"message": "Open order cancelled", "sale_id": sale_id}
    except Exception as exc:
        db.session.rollback()
        return error_response("Internal Server Error", str(exc), 500)


@orders_router.get("/{sale_id}")
def get_sale_details(sale_id: int, current_user: User = Depends(get_current_user)):
    sale = Sale.query.get(sale_id)
    if not sale:
        raise HTTPException(status_code=404, detail="Not Found")
    if current_user.role != "owner" and sale.branch_id != current_user.branch_id:
        return error_response("Forbidden", "Unauthorized", 403)
    items = []
    for i in sale.items:
        mods = []
        for oim in getattr(i, "modifiers", []):
            if oim.modifier and oim.modifier.archived_at is None:
                mods.append(
                    {
                        "id": oim.modifier.id,
                        "name": oim.modifier.name,
                        "price": float(oim.modifier.price) if oim.modifier.price is not None else None,
                    }
                )
        items.append(
            {
                "id": i.id,
                "product_id": i.product_id,
                "product_title": i.product.title if i.product else "Unknown",
                "variant_sku_suffix": i.variant_sku_suffix,
                "quantity": i.quantity,
                "unit_price": float(i.unit_price),
                "subtotal": float(i.subtotal),
                "modifiers": mods,
            }
        )
    out = {
        "id": sale.id,
        "user_id": sale.user_id,
        "operator_name": sale.user.username if sale.user else "Unknown",
        "branch_id": sale.branch_id,
        "total_amount": float(sale.total_amount),
        "tax_amount": float(sale.tax_amount),
        "payment_method": sale.payment_method,
        "created_at": sale.created_at.isoformat(),
        "status": getattr(sale, "status", "completed"),
        "discount_amount": float(getattr(sale, "discount_amount", 0) or 0),
        "discount_snapshot": getattr(sale, "discount_snapshot", None),
        "order_type": getattr(sale, "order_type", None),
        "order_snapshot": getattr(sale, "order_snapshot", None),
        "kitchen_status": getattr(sale, "kitchen_status", "placed"),
        "items": items,
    }
    if hasattr(sale, "archived_at") and sale.archived_at:
        out["archived_at"] = sale.archived_at.isoformat()
    return out


@orders_router.post("/{sale_id}/rollback")
def rollback_sale(sale_id: int, current_user: User = Depends(get_current_user)):
    sale = Sale.query.get(sale_id)
    if not sale:
        raise HTTPException(status_code=404, detail="Not Found")
    if current_user.role != "owner" and sale.branch_id != current_user.branch_id:
        return error_response("Forbidden", "Unauthorized", 403)
    if getattr(sale, "status", "completed") == "open":
        return error_response("Bad Request", "Unpaid dine-in order: cancel from Active Dine-In or void the open tab first", 400)
    if getattr(sale, "status", "completed") == "refunded":
        return error_response("Bad Request", "Sale already refunded", 400)
    try:
        sale.status = "refunded"
        for item in sale.items:
            inventory = Inventory.query.filter_by(
                branch_id=sale.branch_id, product_id=item.product_id, variant_sku_suffix=item.variant_sku_suffix or ""
            ).first()
            if inventory is not None:
                inventory.stock_level += item.quantity
                db.session.add(
                    InventoryTransaction(
                        branch_id=sale.branch_id,
                        product_id=item.product_id,
                        variant_sku_suffix=item.variant_sku_suffix or "",
                        delta=item.quantity,
                        reason="refund",
                        user_id=current_user.id,
                        reference_type="sale_refund",
                        reference_id=sale_id,
                    )
                )
        db.session.commit()
        return {"message": "Sale rolled back successfully"}
    except Exception as exc:
        db.session.rollback()
        return error_response("Internal Server Error", f"Rollback failed: {str(exc)}", 500)


@orders_router.patch("/{sale_id}/archive")
def archive_sale(sale_id: int, current_user: User = Depends(get_current_user)):
    sale = Sale.query.get(sale_id)
    if not sale:
        raise HTTPException(status_code=404, detail="Not Found")
    if current_user.role != "owner" and sale.branch_id != current_user.branch_id:
        return error_response("Forbidden", "Unauthorized", 403)
    if not hasattr(sale, "archived_at"):
        return error_response("Bad Request", "Archive not supported", 400)
    try:
        sale.archived_at = datetime.utcnow()
        db.session.commit()
        return {"message": "Transaction archived", "archived_at": sale.archived_at.isoformat()}
    except Exception as exc:
        db.session.rollback()
        return error_response("Internal Server Error", str(exc), 500)


@orders_router.patch("/{sale_id}/unarchive")
def unarchive_sale(sale_id: int, current_user: User = Depends(get_current_user)):
    sale = Sale.query.get(sale_id)
    if not sale:
        raise HTTPException(status_code=404, detail="Not Found")
    if current_user.role != "owner" and sale.branch_id != current_user.branch_id:
        return error_response("Forbidden", "Unauthorized", 403)
    if not hasattr(sale, "archived_at"):
        return error_response("Bad Request", "Unarchive not supported", 400)
    try:
        sale.archived_at = None
        db.session.commit()
        return {"message": "Transaction restored"}
    except Exception as exc:
        db.session.rollback()
        return error_response("Internal Server Error", str(exc), 500)


@orders_router.delete("/{sale_id}")
def delete_sale_permanent(sale_id: int, current_user: User = Depends(require_owner)):
    sale = Sale.query.get(sale_id)
    if not sale:
        raise HTTPException(status_code=404, detail="Not Found")
    if current_user.role != "owner" and sale.branch_id != current_user.branch_id:
        return error_response("Forbidden", "Unauthorized", 403)
    items_count = len(sale.items)
    try:
        db.session.delete(sale)
        db.session.commit()
        return {"message": "Transaction permanently deleted.", "related_deleted": {"sale_items": items_count}}
    except Exception as exc:
        db.session.rollback()
        return error_response("Internal Server Error", str(exc), 500)


@orders_router.post("/{sale_id}/print")
def print_sale(sale_id: int, current_user: User = Depends(get_current_user)):
    sale = Sale.query.get(sale_id)
    if not sale:
        raise HTTPException(status_code=404, detail="Not Found")
    if current_user.role != "owner" and sale.branch_id != current_user.branch_id:
        return error_response("Forbidden", "Unauthorized", 403)
    if getattr(sale, "status", "") == "open":
        return error_response("Bad Request", "Finalize payment before printing a customer receipt", 400)
    discount_amount = float(getattr(sale, "discount_amount", 0) or 0)
    discounted_subtotal = float(sale.total_amount) - float(sale.tax_amount)
    subtotal = discounted_subtotal + discount_amount
    tax_rate = (float(sale.tax_amount) / discounted_subtotal) if discounted_subtotal else 0
    discount_name = sale.discount_snapshot.get("name") if isinstance(getattr(sale, "discount_snapshot", None), dict) else None
    printer_service = PrinterService()
    receipt_data = {
        "total": float(sale.total_amount),
        "subtotal": subtotal,
        "tax_amount": float(sale.tax_amount),
        "tax_rate": tax_rate,
        "discount_amount": discount_amount,
        "discount_name": discount_name,
        "operator": sale.user.username if sale.user else "Unknown",
        "branch": sale.branch.name if sale.branch else "Main Branch",
        "branch_id": sale.branch_id,
        "items": [{"title": i.product.title if i.product else "Unknown", "quantity": i.quantity, "unit_price": float(i.unit_price)} for i in sale.items],
        "order_type": getattr(sale, "order_type", None),
        "order_snapshot": getattr(sale, "order_snapshot", None),
    }
    ok = printer_service.print_receipt(receipt_data)
    if ok:
        return {"message": "Print job sent successfully"}
    return JSONResponse(status_code=503, content={"message": "Printer unavailable"})
