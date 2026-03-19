from __future__ import annotations

from datetime import datetime, time, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy import func

from app.errors import error_response
from app.models import Branch, Inventory, InventoryTransaction, Product, Sale, SaleItem, Setting, User, db
from app.services.printer_service import PrinterService
from app_fastapi.deps import get_current_user, require_owner
from app_fastapi.routers.common import yes

orders_router = APIRouter(prefix="/api/orders", tags=["orders"])


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
    _ = data.get("order_type"), data.get("notes")
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
    setting = Setting.query.filter_by(branch_id=branch_id).first() or Setting.query.filter_by(branch_id=None).first()
    tax_rate = 0.0
    if setting and setting.config.get("tax_enabled", True):
        rates_by_method = setting.config.get("tax_rates_by_payment_method") or {}
        payment_method = data.get("payment_method") or "Cash"
        if isinstance(rates_by_method.get(payment_method), (int, float)):
            tax_rate = float(rates_by_method[payment_method]) / 100.0
        elif "tax_percentage" in (setting.config or {}):
            tax_rate = float(setting.config["tax_percentage"]) / 100.0
    total_amount = 0.0
    try:
        new_sale = Sale(
            branch_id=branch_id,
            user_id=current_user.id,
            total_amount=0,
            tax_amount=0,
            payment_method=data["payment_method"],
        )
        db.session.add(new_sale)
        db.session.flush()
        for item in items:
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
            subtotal = unit_price * item["quantity"]
            total_amount += subtotal
            db.session.add(
                SaleItem(
                    sale_id=new_sale.id,
                    product_id=product.id,
                    variant_sku_suffix=item.get("variant_sku_suffix", ""),
                    quantity=item["quantity"],
                    unit_price=unit_price,
                    subtotal=subtotal,
                )
            )
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
        for i in items:
            product = Product.query.get(i.get("product_id"))
            receipt_items.append(
                {
                    "title": str(product.title if product else "Item"),
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
            }
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
    current_user: User = Depends(get_current_user),
):
    start_dt, end_dt = get_time_filter_ranges(time_filter, start_date, end_date)
    query = Sale.query
    if not yes(include_archived) and hasattr(Sale, "archived_at"):
        query = query.filter(Sale.archived_at == None)  # noqa: E711
    if current_user.role != "owner":
        query = query.filter_by(branch_id=current_user.branch_id)
    elif branch_id:
        query = query.filter_by(branch_id=int(branch_id))
    elif current_user.branch_id:
        query = query.filter_by(branch_id=current_user.branch_id)
    if start_dt and end_dt:
        query = query.filter(Sale.created_at >= start_dt, Sale.created_at <= end_dt)
    sales = query.order_by(Sale.created_at.desc()).all()
    out = []
    for sale in sales:
        row = {
            "id": sale.id,
            "branch_id": sale.branch_id,
            "user_id": sale.user_id,
            "total_amount": float(sale.total_amount),
            "created_at": sale.created_at.isoformat(),
            "payment_method": sale.payment_method,
            "status": getattr(sale, "status", "completed"),
        }
        if hasattr(sale, "archived_at") and sale.archived_at:
            row["archived_at"] = sale.archived_at.isoformat()
        out.append(row)
    return {"sales": out}


@orders_router.get("/analytics")
def get_analytics(
    time_filter: str = "today",
    start_date: str | None = None,
    end_date: str | None = None,
    branch_id: int | None = None,
    current_user: User = Depends(get_current_user),
):
    start_dt, end_dt = get_time_filter_ranges(time_filter, start_date, end_date)
    query = Sale.query.filter(Sale.status != "refunded")
    if current_user.role != "owner":
        query = query.filter(Sale.branch_id == current_user.branch_id)
    elif branch_id:
        query = query.filter(Sale.branch_id == int(branch_id))
    elif current_user.branch_id:
        query = query.filter(Sale.branch_id == current_user.branch_id)
    if start_dt and end_dt:
        query = query.filter(Sale.created_at >= start_dt, Sale.created_at <= end_dt)
    q_sales = query.all()
    total_sales = db.session.query(func.sum(Sale.total_amount)).filter(Sale.id.in_([s.id for s in q_sales])).scalar() or 0.0
    total_transactions = query.count()
    most_selling = None
    if total_transactions > 0:
        sale_ids = [s.id for s in q_sales]
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


@orders_router.get("/{sale_id}")
def get_sale_details(sale_id: int, current_user: User = Depends(get_current_user)):
    sale = Sale.query.get(sale_id)
    if not sale:
        raise HTTPException(status_code=404, detail="Not Found")
    if current_user.role != "owner" and sale.branch_id != current_user.branch_id:
        return error_response("Forbidden", "Unauthorized", 403)
    items = [
        {
            "id": i.id,
            "product_id": i.product_id,
            "product_title": i.product.title if i.product else "Unknown",
            "variant_sku_suffix": i.variant_sku_suffix,
            "quantity": i.quantity,
            "unit_price": float(i.unit_price),
            "subtotal": float(i.subtotal),
        }
        for i in sale.items
    ]
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
    }
    ok = printer_service.print_receipt(receipt_data)
    if ok:
        return {"message": "Print job sent successfully"}
    return JSONResponse(status_code=503, content={"message": "Printer unavailable"})
