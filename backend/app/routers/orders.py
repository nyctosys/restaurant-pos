from __future__ import annotations

from datetime import datetime, time, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy import and_, func, inspect, or_

from app.order_metadata import normalize_order_type_and_snapshot
from app.models import Branch, Ingredient, Modifier, Product, Sale, SaleItem, Setting, User, db
from app.services.branch_scope import resolve_terminal_branch_id
from app.services.ingredient_deduction import (
    deduct_ingredient_stock,
    ingredient_display_name,
    restore_inventory_allocations,
)
from app.services.printer_service import PrinterService
from app.services.recipe_variants import (
    combo_items_for_variant,
    normalize_variant_key,
    prepared_recipe_rows_for_variant,
    recipe_rows_for_variant,
)
from app.services.sync_outbox import enqueue_sync_event
from app.socketio_server import RealtimeEvents, schedule_emit_event
from app.deps import get_current_user, require_owner
from app.routers.common import yes

orders_router = APIRouter(prefix="/api/orders", tags=["orders"])
DELIVERY_CHARGE = 300.0
# Open KOT / kitchen tickets (unpaid tabs before payment)
KITCHEN_OPEN_ORDER_TYPES = ("dine_in", "takeaway", "delivery")
# Paid takeaway/delivery (and paid dine-in) are status=completed but must stay on KDS until kitchen workflow finishes.
KITCHEN_COMPLETED_LOOKBACK_DAYS = 7


# POST /kot must be registered before any /{sale_id} route; otherwise Starlette matches
# GET /{sale_id} for path "kot" and returns 405 for POST (Method Not Allowed).
@orders_router.post("/kot")
def create_open_kot(payload: dict[str, Any] | None = None, current_user: User = Depends(get_current_user)):
    """Create an open KOT for dine-in, takeaway, or delivery (unpaid tab; kitchen + printer)."""
    return _create_open_kot_response(payload or {}, current_user, order_type_fixed=None)


@orders_router.post("/dine-in/kot")
def dine_in_kot(payload: dict[str, Any] | None = None, current_user: User = Depends(get_current_user)):
    """Create an open dine-in sale, deduct stock, print KOT (kitchen ticket). No payment yet."""
    return _create_open_kot_response(payload or {}, current_user, order_type_fixed="dine_in")


def _sales_table_columns() -> set[str]:
    return {c["name"] for c in inspect(db.engine).get_columns("sales")}


def _json_error(error: str, message: str, status_code: int, details: Any = None) -> JSONResponse:
    payload: dict[str, Any] = {"error": error, "message": message}
    if details is not None:
        payload["details"] = details
    return JSONResponse(status_code=status_code, content=payload)


def _terminal_branch_or_error(user: User) -> tuple[int | None, JSONResponse | None]:
    try:
        return resolve_terminal_branch_id(user), None
    except HTTPException as exc:
        detail = exc.detail
        body: dict[str, Any] = detail if isinstance(detail, dict) else {"message": str(detail)}
        return None, JSONResponse(status_code=exc.status_code, content=body)


def _forbidden_unless_sale_branch(sale: Sale, current_user: User) -> JSONResponse | None:
    tid, terr = _terminal_branch_or_error(current_user)
    if terr:
        return terr
    assert tid is not None
    if sale.branch_id != tid:
        return _json_error("Forbidden", "Not allowed for this branch", 403)
    return None


def _order_event_payload(sale: Sale, **extra: Any) -> dict[str, Any]:
    snapshot = sale.order_snapshot if isinstance(getattr(sale, "order_snapshot", None), dict) else {}
    payload: dict[str, Any] = {
        "sale_id": int(sale.id),
        "branch_id": int(sale.branch_id),
        "status": getattr(sale, "status", None),
        "kitchen_status": getattr(sale, "kitchen_status", None),
        "order_type": getattr(sale, "order_type", None),
        "table_name": snapshot.get("table_name"),
        "customer_name": snapshot.get("customer_name"),
    }
    payload.update(extra)
    return payload


def _schedule_order_event(event: str, sale: Sale, **extra: Any) -> None:
    schedule_emit_event(event, _order_event_payload(sale, **extra))


def _parse_optional_non_negative_charge(value: Any, default: float) -> float:
    if value is None:
        return default
    try:
        v = float(value)
    except (TypeError, ValueError):
        return default
    if v < 0:
        return 0.0
    return min(round(v, 2), 9_999_999.99)


def _order_charges(order_type: str | None, payload: dict[str, Any]) -> tuple[float, float]:
    """
    Returns (delivery_charge, service_charge) for checkout/finalize.
    Delivery orders default delivery_charge to DELIVERY_CHARGE when the key is omitted.
    """
    ot = (order_type or "").strip().lower()
    if ot == "delivery":
        if "delivery_charge" in payload:
            dc = _parse_optional_non_negative_charge(payload.get("delivery_charge"), 0.0)
        else:
            dc = float(DELIVERY_CHARGE)
        return dc, 0.0
    if ot == "dine_in":
        return 0.0, _parse_optional_non_negative_charge(payload.get("service_charge"), 0.0)
    return 0.0, 0.0


def get_time_filter_ranges(time_filter: str, start_date_str: str | None, end_date_str: str | None):
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


def _modifiers_for_display(value: Any) -> list[str]:
    """Normalize stored sale line modifiers (strings or {modifier_id, name}) for KDS / UI."""
    if not isinstance(value, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for raw in value:
        if isinstance(raw, str):
            name = raw.strip()
            if name and name not in seen:
                seen.add(name)
                out.append(name)
        elif isinstance(raw, dict):
            name = (raw.get("name") or "").strip()
            if name and name not in seen:
                seen.add(name)
                out.append(name)
    return out


def _modifiers_payload_for_api(value: Any) -> list[dict[str, Any]]:
    """POS order detail: modifiers with ids for cart rehydration."""
    if not isinstance(value, list):
        return []
    out: list[dict[str, Any]] = []
    for raw in value:
        if isinstance(raw, dict) and raw.get("modifier_id") is not None:
            mid = int(raw["modifier_id"])
            m = db.session.get(Modifier, mid)
            price = float(m.price) if m and m.price is not None else None
            out.append(
                {
                    "id": mid,
                    "name": (raw.get("name") or (m.name if m else "")) or "",
                    "price": price,
                }
            )
        elif isinstance(raw, str) and raw.strip():
            out.append({"id": 0, "name": raw.strip(), "price": None})
    return out


def _resolve_modifier_snapshots(
    modifier_ids: list[int],
) -> tuple[bool, str, list[dict[str, Any]]]:
    snapshots: list[dict[str, Any]] = []
    seen_ids: set[int] = set()
    for mid in modifier_ids:
        if mid in seen_ids:
            continue
        seen_ids.add(mid)
        m = db.session.get(Modifier, mid)
        if m is None or m.archived_at is not None:
            return False, f"Unknown or archived modifier (id {mid})", []
        snapshots.append({"modifier_id": m.id, "name": m.name})
    return True, "", snapshots


def _process_modifier_depletions(
    modifier_ids: list[int],
    line_qty: int,
    branch_id: int,
    current_user_id: int,
    sale_id: int,
) -> tuple[bool, str, list[dict[str, Any]]]:
    allocations: list[dict[str, Any]] = []
    for mid in modifier_ids:
        mod = db.session.get(Modifier, mid)
        if mod is None or mod.ingredient_id is None:
            continue
        dep = float(mod.depletion_quantity) if mod.depletion_quantity is not None else 1.0
        total = dep * line_qty
        try:
            modifier_allocations = deduct_ingredient_stock(
                source_ingredient=mod.ingredient,
                required_quantity=total,
                branch_id=branch_id,
                user_id=current_user_id,
                sale_id=sale_id,
                reason=f"Modifier '{mod.name}' on sale",
            )
        except Exception as exc:
            return False, str(exc), []
        for allocation in modifier_allocations:
            allocations.append({"kind": "modifier", "modifier_id": mid, **allocation})
    return True, "", allocations


def _normalize_product_variant_labels(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for x in raw:
        if isinstance(x, str):
            v = x.strip()
            if v and v not in seen:
                seen.add(v)
                out.append(v)
    return out


def _deduct_recipe_for_product(
    product: Product,
    qty: int,
    branch_id: int,
    current_user_id: int,
    sale_id: int,
    variant_key: str | None = None,
) -> tuple[bool, str, list[dict[str, Any]]]:
    from app.services.prepared_item_stock import (
        InsufficientPreparedItemStock,
        adjust_prepared_branch_stock,
        sync_prepared_master_total,
    )

    recipe_items = recipe_rows_for_variant(product, variant_key)
    prepared_items = prepared_recipe_rows_for_variant(product, variant_key)
    if not recipe_items and not prepared_items:
        vk = normalize_variant_key(variant_key)
        if vk:
            return (
                False,
                f'Add a recipe (BOM) for "{product.title}" (variant "{vk}") in Inventory → Recipes, '
                "or add a base recipe that applies to all variants.",
                [],
            )
        return False, f"Add a recipe (BOM) for menu item: {product.title}", []

    allocations: list[dict[str, Any]] = []
    for recipe_item in recipe_items:
        ingredient = recipe_item.ingredient
        if ingredient is None:
            continue
        total_ing = float(recipe_item.quantity) * qty
        try:
            recipe_allocations = deduct_ingredient_stock(
                source_ingredient=ingredient,
                required_quantity=total_ing,
                branch_id=branch_id,
                user_id=current_user_id,
                sale_id=sale_id,
                reason=f"Sold {qty}x {product.title}",
            )
        except Exception as exc:
            return False, str(exc), []
        for allocation in recipe_allocations:
            allocations.append({"kind": "recipe", **allocation})
    for recipe_item in prepared_items:
        prepared_item = recipe_item.prepared_item
        if prepared_item is None:
            continue
        total_prepared = float(recipe_item.quantity) * qty
        try:
            adjust_prepared_branch_stock(
                prepared_item.id,
                branch_id,
                -total_prepared,
                movement_type="sale_deduction",
                user_id=current_user_id,
                reference_id=sale_id,
                reference_type="sale",
                reason=f"Sold {qty}x {product.title}",
                allow_negative=False,
            )
            sync_prepared_master_total(prepared_item.id)
        except InsufficientPreparedItemStock as exc:
            return False, str(exc), []
    return True, "", allocations


def _restore_recipe_for_sale_item(
    product: Product,
    qty: int,
    branch_id: int,
    current_user_id: int,
    sale_id: int,
    reason: str,
    variant_key: str | None = None,
) -> None:
    from app.services.branch_ingredient_stock import adjust_branch_ingredient_stock
    from app.services.prepared_item_stock import adjust_prepared_branch_stock, sync_prepared_master_total

    for recipe_item in recipe_rows_for_variant(product, variant_key):
        ingredient = recipe_item.ingredient
        if ingredient is None:
            continue
        restored_qty = float(recipe_item.quantity) * qty
        adjust_branch_ingredient_stock(
            ingredient.id,
            branch_id,
            restored_qty,
            movement_type="adjustment",
            user_id=current_user_id,
            reference_id=sale_id,
            reference_type="sale",
            reason=reason,
            unit_cost=float(ingredient.average_cost or 0),
            allow_negative=False,
        )
    for recipe_item in prepared_recipe_rows_for_variant(product, variant_key):
        prepared_item = recipe_item.prepared_item
        if prepared_item is None:
            continue
        restored_qty = float(recipe_item.quantity) * qty
        adjust_prepared_branch_stock(
            prepared_item.id,
            branch_id,
            restored_qty,
            movement_type="adjustment",
            user_id=current_user_id,
            reference_id=sale_id,
            reference_type="sale",
            reason=reason,
            allow_negative=False,
        )
        sync_prepared_master_total(prepared_item.id)


def _restore_modifier_depletions_from_sale_item(
    sale_item: SaleItem,
    branch_id: int,
    current_user_id: int,
    reason: str,
) -> None:
    from app.services.branch_ingredient_stock import adjust_branch_ingredient_stock

    raw = sale_item.modifiers or []
    if not isinstance(raw, list):
        return
    qty = int(sale_item.quantity)
    sale_id = int(sale_item.sale_id)
    for entry in raw:
        if isinstance(entry, dict) and entry.get("modifier_id") is not None:
            mod = db.session.get(Modifier, int(entry["modifier_id"]))
            if mod is None or mod.ingredient_id is None:
                continue
            dep = float(mod.depletion_quantity) if mod.depletion_quantity is not None else 1.0
            total = dep * qty
            ing = mod.ingredient
            adjust_branch_ingredient_stock(
                mod.ingredient_id,
                branch_id,
                total,
                movement_type="adjustment",
                user_id=current_user_id,
                reference_id=sale_id,
                reference_type="sale",
                reason=reason,
                unit_cost=float(ing.average_cost) if ing else 0.0,
                allow_negative=False,
            )
        elif isinstance(entry, str):
            mod_name = entry.strip()
            if not mod_name:
                continue
            ingredient = Ingredient.query.filter_by(name=mod_name).first()
            if ingredient is None:
                continue
            adjust_branch_ingredient_stock(
                ingredient.id,
                branch_id,
                float(qty),
                movement_type="adjustment",
                user_id=current_user_id,
                reference_id=sale_id,
                reference_type="sale",
                reason=f"{reason} (legacy modifier name)",
                unit_cost=float(ingredient.average_cost or 0),
                allow_negative=False,
            )


def _restore_sale_item_side_effects(
    sale_item: SaleItem,
    branch_id: int,
    current_user_id: int,
    reason: str,
    inventory_reason: str,
) -> None:
    del inventory_reason  # retail finished-goods ledger removed; kept for API compatibility
    stored_allocations = sale_item.inventory_allocations if isinstance(sale_item.inventory_allocations, list) else []
    if stored_allocations:
        restore_inventory_allocations(
            allocations=stored_allocations,
            branch_id=branch_id,
            user_id=current_user_id,
            sale_id=int(sale_item.sale_id),
            reason=reason,
        )
        return

    product = sale_item.product
    if not product:
        return

    if not product.is_deal:
        _restore_recipe_for_sale_item(
            product,
            int(sale_item.quantity),
            branch_id,
            current_user_id,
            int(sale_item.sale_id),
            reason,
            variant_key=sale_item.variant_sku_suffix or "",
        )

    _restore_modifier_depletions_from_sale_item(sale_item, branch_id, current_user_id, reason)


def _nest_sale_item_dicts(flat_items: list[dict[str, Any]]) -> dict[int, list[dict[str, Any]]]:
    items_by_id: dict[int, dict[str, Any]] = {}
    for item in flat_items:
        items_by_id[item["id"]] = {**item, "children": list(item.get("children") or [])}

    items_by_sale: dict[int, list[dict[str, Any]]] = {}
    for item in flat_items:
        item_dict = items_by_id[item["id"]]
        parent_id = item_dict.get("parent_sale_item_id")
        if parent_id and parent_id in items_by_id:
            items_by_id[parent_id]["children"].append(item_dict)
        else:
            items_by_sale.setdefault(item_dict["sale_id"], []).append(item_dict)
    return items_by_sale


def _deduct_product_inventory_and_create_sale_items(
    product: Product,
    item_dict: dict[str, Any],
    branch_id: int,
    current_user_id: int,
    sale_id: int,
    parent_sale_item_id: int | None = None,
    is_deal_child: bool = False
) -> tuple[bool, str, float]:
    """Create SaleItem rows; deduct branch ingredient stock via recipe (BOM) and modifier mappings."""
    qty = int(item_dict["quantity"])
    modifier_ids = item_dict.get("modifier_ids") or []
    line_variant = normalize_variant_key(item_dict.get("variant_sku_suffix"))

    ok_snap, err_snap, mod_snapshots = _resolve_modifier_snapshots(modifier_ids)
    if not ok_snap:
        return False, err_snap, 0.0

    unit_price = 0.0 if is_deal_child else float(product.base_price)
    subtotal = unit_price * qty

    sale_item = SaleItem(
        sale_id=sale_id,
        product_id=product.id,
        variant_sku_suffix=line_variant[:50] if line_variant else "",
        quantity=qty,
        unit_price=unit_price,
        subtotal=subtotal,
        modifiers=mod_snapshots if (mod_snapshots and not is_deal_child) else None,
        parent_sale_item_id=parent_sale_item_id
    )
    db.session.add(sale_item)
    db.session.flush()

    inventory_allocations: list[dict[str, Any]] = []
    if not is_deal_child and modifier_ids:
        ok, err, modifier_allocations = _process_modifier_depletions(
            modifier_ids,
            qty,
            branch_id,
            current_user_id,
            sale_id,
        )
        if not ok:
            return False, err, 0.0
        inventory_allocations.extend(modifier_allocations)

    if not product.is_deal:
        ok_r, err_r, recipe_allocations = _deduct_recipe_for_product(
            product, qty, branch_id, current_user_id, sale_id, variant_key=line_variant or None
        )
        if not ok_r:
            return False, err_r, 0.0
        inventory_allocations.extend(recipe_allocations)
    else:
        expanded = combo_items_for_variant(product, line_variant or None)
        if not expanded:
            vk = normalize_variant_key(line_variant)
            return (
                False,
                f'No combo lines for deal "{product.title}"'
                + (f' (variant "{vk}")' if vk else "")
                + ". Configure combo items for this deal in Menu → Deals.",
                0.0,
            )
        for combo_item in expanded:
            child = combo_item.child_product
            if child:
                child_dict = {
                    "product_id": child.id,
                    "quantity": qty * combo_item.quantity,
                    "modifier_ids": [],
                }
                ok, err, _ = _deduct_product_inventory_and_create_sale_items(
                    child, child_dict, branch_id, current_user_id, sale_id,
                    parent_sale_item_id=sale_item.id, is_deal_child=True
                )
                if not ok:
                    return False, err, 0.0

    sale_item.inventory_allocations = inventory_allocations or None
    return True, "", subtotal


@orders_router.post("/checkout")
def checkout(payload: dict[str, Any] | None = None, current_user: User = Depends(get_current_user)):
    data = payload or {}
    if "items" not in data or "payment_method" not in data:
        return _json_error("Bad Request", "Missing necessary checkout data", 400)
    _ = data.get("notes")
    items, verr = _validate_cart_items(data.get("items") or [])
    if verr:
        return verr
    assert items is not None
    branch_id, berr = _terminal_branch_or_error(current_user)
    if berr:
        return berr
    assert branch_id is not None

    order_type_norm, order_snapshot_norm, order_err = normalize_order_type_and_snapshot(data)
    if order_err:
        return _json_error("Bad Request", order_err, 400)

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
            order_type=order_type_norm,
            order_snapshot=order_snapshot_norm,
        )
        db.session.add(new_sale)
        db.session.flush()
        for item in items:
            product = db.session.get(Product, item["product_id"])
            if product is None:
                db.session.rollback()
                return _json_error("Bad Request", f"Product ID {item['product_id']} not found", 400)
            
            ok, err, subtotal = _deduct_product_inventory_and_create_sale_items(
                product=product,
                item_dict=item,
                branch_id=branch_id,
                current_user_id=current_user.id,
                sale_id=new_sale.id
            )
            if not ok:
                db.session.rollback()
                return _json_error("Bad Request", err, 400)
            
            total_amount += subtotal
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
        delivery_charge, service_charge = _order_charges(order_type_norm, data)
        new_sale.discount_amount = discount_amount
        new_sale.discount_id = discount_id
        new_sale.discount_snapshot = discount_snapshot
        new_sale.delivery_charge = delivery_charge
        new_sale.service_charge = service_charge
        new_sale.tax_amount = discounted_subtotal * tax_rate
        new_sale.total_amount = discounted_subtotal + new_sale.tax_amount + delivery_charge + service_charge
        db.session.flush()
        enqueue_sync_event(
            branch_id=branch_id,
            entity_type="sale",
            entity_id=new_sale.id,
            event_type="checkout_completed",
            payload={
                "payment_method": data.get("payment_method"),
                "total": float(new_sale.total_amount),
                "order_type": order_type_norm,
            },
        )
        db.session.commit()
        _schedule_order_event(RealtimeEvents.ORDER_CREATED, new_sale, total=float(new_sale.total_amount))
        printer_service = PrinterService()
        branch_name = "Main Branch"
        branch_obj = db.session.get(Branch, branch_id) if branch_id else None
        if branch_obj:
            branch_name = branch_obj.name
        receipt_items = []
        for i in items:
            product = db.session.get(Product, i.get("product_id"))
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
                "delivery_charge": float(delivery_charge),
                "service_charge": float(service_charge),
                "discount_name": discount_name or "Discount",
                "operator": current_user.username,
                "branch": branch_name,
                "branch_id": branch_id,
                "items": receipt_items,
                "order_type": order_type_norm,
                "order_snapshot": order_snapshot_norm,
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
        return _json_error("Bad Request", f"Checkout failed: {str(exc)}", 400)


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
        _ = branch_id
        tid, terr = _terminal_branch_or_error(current_user)
        if terr:
            return terr
        query = query.filter(Sale.branch_id == tid)
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
        _ = branch_id
        tid, terr = _terminal_branch_or_error(current_user)
        if terr:
            return terr
        query = query.filter(Sale.branch_id == tid)
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
                product = db.session.get(Product, top_row.product_id)
                if product:
                    most_selling = {"id": product.id, "title": product.title, "total_sold": int(top_row.total_qty)}
        return {"total_sales": float(total_sales), "total_transactions": total_transactions, "most_selling_product": most_selling}
    except Exception as exc:
        raise


def _validate_cart_items(items: list) -> tuple[Optional[list[dict]], Optional[JSONResponse]]:
    if not items:
            return None, _json_error("Bad Request", "Cart is empty", 400)
    normalized: list[dict] = []
    for idx, item in enumerate(items):
        if not isinstance(item, dict):
            return None, _json_error("Bad Request", f"Item at index {idx} must be an object", 400)
        if item.get("product_id") is None:
            return None, _json_error("Bad Request", f"Item at index {idx} missing product_id", 400)
        try:
            qty = int(item.get("quantity", 0))
        except (TypeError, ValueError):
            return None, _json_error("Bad Request", f"Item at index {idx} quantity must be a positive integer", 400)
        if qty <= 0:
            return None, _json_error("Bad Request", f"Item at index {idx} quantity must be positive", 400)
        raw_mod_ids = item.get("modifier_ids")
        if raw_mod_ids is None:
            raw_mod_ids = item.get("modifierIds")
        if not isinstance(raw_mod_ids, list):
            raw_mod_ids = []
        modifier_ids: list[int] = []
        for x in raw_mod_ids:
            try:
                modifier_ids.append(int(x))
            except (TypeError, ValueError):
                return None, _json_error("Bad Request", f"Item at index {idx} has invalid modifier_ids", 400)

        pid = int(item["product_id"])
        product = db.session.get(Product, pid)
        if product is None:
            return None, _json_error("Bad Request", f"Item at index {idx}: product_id {pid} not found", 400)
        if getattr(product, "archived_at", None) is not None:
            return None, _json_error(
                "Bad Request",
                f'Item at index {idx}: "{product.title}" is no longer on the menu',
                400,
            )

        raw_v = item.get("variant_sku_suffix")
        if raw_v is None:
            raw_v = item.get("variant")
        vk = str(raw_v or "").strip()
        if len(vk) > 50:
            return None, _json_error("Bad Request", f"Item at index {idx}: variant too long (max 50)", 400)

        allowed = _normalize_product_variant_labels(getattr(product, "variants", None))
        if allowed:
            if not vk:
                return None, _json_error(
                    "Bad Request",
                    f'Item at index {idx}: choose a variant for "{product.title}"',
                    400,
                )
            if vk not in allowed:
                return None, _json_error(
                    "Bad Request",
                    f'Item at index {idx}: unknown variant "{vk}" for "{product.title}"',
                    400,
                )
        else:
            vk = ""

        normalized.append(
            {
                "product_id": pid,
                "quantity": qty,
                "modifier_ids": modifier_ids,
                "variant_sku_suffix": vk,
            }
        )
    return normalized, None


def _resolve_branch_id(data: dict[str, Any], current_user: User) -> tuple[int | None, JSONResponse | None]:
    _ = data
    return _terminal_branch_or_error(current_user)


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
            query = query.filter(or_(Sale.order_type.in_(KITCHEN_OPEN_ORDER_TYPES), Sale.order_type.is_(None)))

        if has_archived_at_col and not yes(include_archived):
            query = query.filter(Sale.archived_at == None)  # noqa: E711

        _ = branch_id
        tid, terr = _terminal_branch_or_error(current_user)
        if terr:
            return terr
        query = query.filter(Sale.branch_id == tid)

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
            raw_kitchen_status = data.get("kitchen_status")
            kitchen_status = raw_kitchen_status if raw_kitchen_status in ("placed", "preparing", "ready") else "placed"

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
                "kitchen_status": kitchen_status,
            }
            out.append(out_row)
            sale_ids.append(sale_id_val)

        if includeItems and sale_ids:
            items_rows = (
                db.session.query(
                    SaleItem.id,
                    SaleItem.sale_id,
                    SaleItem.variant_sku_suffix,
                    SaleItem.quantity,
                    SaleItem.modifiers,
                    SaleItem.parent_sale_item_id,
                    Product.title,
                    Product.is_deal
                )
                .outerjoin(Product, SaleItem.product_id == Product.id)
                .filter(SaleItem.sale_id.in_(sale_ids))
                .all()
            )

            flat_items: list[dict[str, Any]] = []
            for item in items_rows:
                flat_items.append(
                    {
                        "id": item.id,
                        "sale_id": item.sale_id,
                        "product_title": item.title if item.title else "Unknown",
                        "variant_sku_suffix": item.variant_sku_suffix or "",
                        "quantity": item.quantity,
                        "modifiers": _modifiers_for_display(item.modifiers or []),
                        "parent_sale_item_id": item.parent_sale_item_id,
                        "is_deal": item.is_deal,
                        "children": [],
                    }
                )

            items_by_sale = _nest_sale_item_dicts(flat_items)

            for out_row in out:
                out_row["items"] = items_by_sale.get(out_row["id"], [])

        return {"sales": out}
    except Exception as exc:
        raise


def _line_dict_from_nested_node(n: dict[str, Any]) -> dict[str, Any]:
    mods_raw = n.get("modifiers") or []
    mod_strs: list[str] = []
    if isinstance(mods_raw, list):
        for m in mods_raw:
            if isinstance(m, str):
                mod_strs.append(m)
            elif isinstance(m, dict) and m.get("name"):
                mod_strs.append(str(m["name"]))
    return {
        "product_title": n.get("product_title") or "Unknown",
        "variant_sku_suffix": (n.get("variant_sku_suffix") or "") or "",
        "quantity": int(n.get("quantity") or 0),
        "modifiers": mod_strs,
    }


def _flatten_kitchen_display_lines(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Flatten nested sale items (deals/children) into KDS line rows (full expansion)."""
    lines: list[dict[str, Any]] = []
    for n in nodes:
        lines.append(_line_dict_from_nested_node(n))
        for ch in n.get("children") or []:
            lines.extend(_flatten_kitchen_display_lines([ch]))
    return lines


def _kds_card_lines(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """KDS ticket: show deal/combo as one line only; expand non-deal children as today."""
    lines: list[dict[str, Any]] = []
    for n in nodes:
        if n.get("is_deal"):
            lines.append(_line_dict_from_nested_node(n))
            continue
        lines.append(_line_dict_from_nested_node(n))
        for ch in n.get("children") or []:
            lines.extend(_kds_card_lines([ch]))
    return lines


def _kds_prep_lines(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Queue totals: for deals, count component lines (children), not the deal parent line."""
    lines: list[dict[str, Any]] = []
    for n in nodes:
        if n.get("is_deal"):
            for ch in n.get("children") or []:
                lines.extend(_flatten_kitchen_display_lines([ch]))
        else:
            lines.extend(_flatten_kitchen_display_lines([n]))
    return lines


def _kitchen_status_value(sale: Sale) -> str:
    raw = getattr(sale, "kitchen_status", None)
    if raw in ("placed", "preparing", "ready"):
        return raw
    return "placed"


KDS_READY_RETENTION = timedelta(days=1)


def _kitchen_ready_reference_utc(sale: Sale) -> datetime | None:
    """Timestamp used to expire READY tickets from KDS (prefer first marked ready, else order created_at)."""
    kr = getattr(sale, "kitchen_ready_at", None)
    if kr is not None:
        if kr.tzinfo is None:
            return kr.replace(tzinfo=timezone.utc)
        return kr
    ca = sale.created_at
    if ca is None:
        return None
    if ca.tzinfo is None:
        return ca.replace(tzinfo=timezone.utc)
    return ca


def _sale_visible_on_kds(sale: Sale) -> bool:
    """Hide READY tickets from KDS after 24h from ready time (or created_at if legacy)."""
    if _kitchen_status_value(sale) != "ready":
        return True
    ref = _kitchen_ready_reference_utc(sale)
    if ref is None:
        return True
    return ref >= datetime.now(timezone.utc) - KDS_READY_RETENTION


@orders_router.get("/kitchen")
def list_kitchen_orders(
    branch_id: int | None = None,
    current_user: User = Depends(get_current_user),
):
    """Kitchen Display: open KOT tickets (dine-in, takeaway, delivery) with workflow status (placed → preparing → ready)."""
    try:
        _ = branch_id
        bid, berr = _terminal_branch_or_error(current_user)
        if berr:
            return berr
        assert bid is not None

        recent_completed = datetime.now(timezone.utc) - timedelta(days=KITCHEN_COMPLETED_LOOKBACK_DAYS)
        # Open tabs (dine-in KOT, etc.) + recently completed kitchen orders (takeaway/delivery pay+KOT flow
        # finalizes immediately; they are no longer status=open but kitchen must still see them).
        q = Sale.query.filter(
            Sale.branch_id == bid,
            Sale.archived_at == None,  # noqa: E711
            or_(
                Sale.status == "open",
                and_(Sale.status == "completed", Sale.created_at >= recent_completed),
            ),
        )
        if hasattr(Sale, "order_type"):
            q = q.filter(or_(Sale.order_type.in_(KITCHEN_OPEN_ORDER_TYPES), Sale.order_type.is_(None)))
        sales = [s for s in q.order_by(Sale.created_at.desc()).all() if _sale_visible_on_kds(s)]
        if not sales:
            return {"orders": []}

        sale_ids = [s.id for s in sales]
        items_rows = (
            db.session.query(
                SaleItem.id,
                SaleItem.sale_id,
                SaleItem.variant_sku_suffix,
                SaleItem.quantity,
                SaleItem.modifiers,
                SaleItem.parent_sale_item_id,
                Product.title,
                Product.is_deal,
            )
            .outerjoin(Product, SaleItem.product_id == Product.id)
            .filter(SaleItem.sale_id.in_(sale_ids))
            .all()
        )

        flat_items: list[dict[str, Any]] = []
        for item in items_rows:
            flat_items.append(
                {
                    "id": item.id,
                    "sale_id": item.sale_id,
                    "product_title": item.title if item.title else "Unknown",
                    "variant_sku_suffix": item.variant_sku_suffix or "",
                    "quantity": item.quantity,
                    "modifiers": _modifiers_for_display(item.modifiers or []),
                    "parent_sale_item_id": item.parent_sale_item_id,
                    "is_deal": item.is_deal,
                    "children": [],
                }
            )

        items_by_sale = _nest_sale_item_dicts(flat_items)
        out: list[dict[str, Any]] = []
        for sale in sales:
            snap = sale.order_snapshot or {}
            table_name = snap.get("table_name") if isinstance(snap, dict) else None
            nested = items_by_sale.get(sale.id, [])
            ot = getattr(sale, "order_type", None) or "dine_in"
            out.append(
                {
                    "id": sale.id,
                    "created_at": sale.created_at.isoformat() if sale.created_at else "",
                    "order_type": ot,
                    "order_snapshot": snap,
                    "table_name": table_name,
                    "kitchen_status": _kitchen_status_value(sale),
                    "items": _kds_card_lines(nested),
                    "prep_lines": _kds_prep_lines(nested),
                    "modifications": [],
                }
            )
        return {"orders": out}
    except Exception as exc:
        raise


@orders_router.patch("/{sale_id}/kitchen-status")
def update_kitchen_status(
    sale_id: int,
    payload: dict[str, Any] | None = None,
    current_user: User = Depends(get_current_user),
):
    data = payload or {}
    status_new = data.get("kitchen_status")
    if status_new not in ("placed", "preparing", "ready"):
        return _json_error("Bad Request", "kitchen_status must be placed, preparing, or ready", 400)
    sale = db.session.get(Sale, sale_id)
    if not sale:
        return _json_error("Not Found", "Order not found", 404)
    fb = _forbidden_unless_sale_branch(sale, current_user)
    if fb:
        return fb
    ot = getattr(sale, "order_type", None)
    kitchen_eligible = ot is None or ot in KITCHEN_OPEN_ORDER_TYPES
    if sale.status == "open":
        pass
    elif sale.status == "completed" and kitchen_eligible:
        pass
    else:
        return _json_error("Bad Request", "Order is not eligible for kitchen status updates", 400)
    sale.kitchen_status = status_new
    if status_new == "ready":
        sale.kitchen_ready_at = datetime.now(timezone.utc)
    else:
        sale.kitchen_ready_at = None
    db.session.commit()
    _schedule_order_event(RealtimeEvents.ORDER_STATUS_CHANGED, sale)
    if status_new == "ready":
        _schedule_order_event(RealtimeEvents.ORDER_READY, sale)
    return {"ok": True, "id": sale.id, "kitchen_status": status_new}


def _create_open_kot_response(
    data: dict[str, Any],
    current_user: User,
    *,
    order_type_fixed: str | None = None,
):
    """Create an open sale, deduct stock, print KOT. Used for dine-in, takeaway, and delivery tabs before payment."""
    if "items" not in data:
        return _json_error("Bad Request", "Missing items", 400)
    items, verr = _validate_cart_items(data["items"])
    if verr:
        return verr
    assert items is not None

    bid, berr = _resolve_branch_id(data, current_user)
    if berr:
        return berr
    assert bid is not None

    ot_src = order_type_fixed if order_type_fixed is not None else (data.get("order_type") or "dine_in")
    order_type_norm, order_snapshot_norm, order_err = normalize_order_type_and_snapshot(
        {"order_type": ot_src, "order_snapshot": data.get("order_snapshot")}
    )
    if order_err:
        return _json_error("Bad Request", order_err, 400)

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
        )
        db.session.add(new_sale)
        db.session.flush()
        total_amount = 0.0
        for item in items:
            product = db.session.get(Product, item["product_id"])
            if product is None:
                db.session.rollback()
                return _json_error("Bad Request", f"Product ID {item['product_id']} not found", 400)
            
            ok, err, subtotal = _deduct_product_inventory_and_create_sale_items(
                product=product,
                item_dict=item,
                branch_id=bid,
                current_user_id=current_user.id,
                sale_id=new_sale.id
            )
            if not ok:
                db.session.rollback()
                return _json_error("Bad Request", err, 400)
            
            total_amount += subtotal
        new_sale.discount_amount = 0
        new_sale.discount_id = None
        new_sale.discount_snapshot = None
        new_sale.total_amount = total_amount
        new_sale.tax_amount = 0
        new_sale.kitchen_status = "placed"
        db.session.flush()
        enqueue_sync_event(
            branch_id=bid,
            entity_type="sale",
            entity_id=new_sale.id,
            event_type="dine_in_kot",
            payload={"total": float(total_amount)},
        )
        db.session.commit()
        _schedule_order_event(RealtimeEvents.ORDER_CREATED, new_sale, total=float(total_amount))

        branch_name = "Main Branch"
        branch_obj = db.session.get(Branch, bid) if bid else None
        if branch_obj:
            branch_name = branch_obj.name
        table_name = (order_snapshot_norm or {}).get("table_name", "") if isinstance(order_snapshot_norm, dict) else ""
        kot_items_rows = (
            db.session.query(
                SaleItem.id,
                SaleItem.sale_id,
                SaleItem.variant_sku_suffix,
                SaleItem.quantity,
                SaleItem.modifiers,
                SaleItem.parent_sale_item_id,
                Product.title,
                Product.is_deal,
            )
            .outerjoin(Product, SaleItem.product_id == Product.id)
            .filter(SaleItem.sale_id == new_sale.id)
            .all()
        )
        kot_flat_items: list[dict[str, Any]] = []
        for item in kot_items_rows:
            kot_flat_items.append(
                {
                    "id": item.id,
                    "sale_id": item.sale_id,
                    "product_title": item.title if item.title else "Unknown",
                    "variant_sku_suffix": item.variant_sku_suffix or "",
                    "quantity": item.quantity,
                    "modifiers": _modifiers_for_display(item.modifiers or []),
                    "parent_sale_item_id": item.parent_sale_item_id,
                    "is_deal": item.is_deal,
                    "children": [],
                }
            )
        kot_items = _nest_sale_item_dicts(kot_flat_items).get(new_sale.id, [])
        printer_service = PrinterService()
        print_ok = printer_service.print_kot(
            {
                "sale_id": new_sale.id,
                "branch_id": bid,
                "branch": branch_name,
                "operator": current_user.username,
                "table_name": table_name,
                "order_type": order_type_norm,
                "items": kot_items,
            }
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
        return _json_error("Bad Request", f"KOT failed: {str(exc)}", 400)


@orders_router.patch("/{sale_id}/items")
def update_open_sale_items(sale_id: int, payload: dict[str, Any] | None = None, current_user: User = Depends(get_current_user)):
    """Replace line items on an unpaid dine-in sale; adjusts inventory."""
    sale = db.session.get(Sale, sale_id)
    if not sale:
        raise HTTPException(status_code=404, detail="Not Found")
    fb = _forbidden_unless_sale_branch(sale, current_user)
    if fb:
        return fb
    if getattr(sale, "status", "") != "open":
        return _json_error("Bad Request", "Only open unpaid orders can be edited", 400)
    data = payload or {}
    if "items" not in data:
        return _json_error("Bad Request", "Missing items", 400)
    items, verr = _validate_cart_items(data["items"])
    if verr:
        return verr
    assert items is not None

    try:
        for old in list(sale.items):
            _restore_sale_item_side_effects(
                old,
                branch_id=sale.branch_id,
                current_user_id=current_user.id,
                reason=f"Open order #{sale_id} edited",
                inventory_reason="adjustment",
            )
            db.session.delete(old)
        db.session.flush()

        total_amount = 0.0
        for item in items:
            product = db.session.get(Product, item["product_id"])
            if product is None:
                db.session.rollback()
                return _json_error("Bad Request", f"Product ID {item['product_id']} not found", 400)
            
            ok, err, subtotal = _deduct_product_inventory_and_create_sale_items(
                product=product,
                item_dict=item,
                branch_id=sale.branch_id,
                current_user_id=current_user.id,
                sale_id=sale_id
            )
            if not ok:
                db.session.rollback()
                return _json_error("Bad Request", err, 400)
            
            total_amount += subtotal
        sale.total_amount = total_amount
        sale.tax_amount = 0
        sale.discount_amount = 0
        sale.discount_id = None
        sale.discount_snapshot = None
        db.session.commit()
        _schedule_order_event(RealtimeEvents.ORDER_UPDATED, sale, total=float(total_amount))
        return {"message": "Order updated", "sale_id": sale_id, "total_amount": float(total_amount)}
    except Exception as exc:
        db.session.rollback()
        return _json_error("Bad Request", f"Update failed: {str(exc)}", 400)


@orders_router.post("/{sale_id}/finalize")
def finalize_open_sale(sale_id: int, payload: dict[str, Any] | None = None, current_user: User = Depends(get_current_user)):
    """Take payment on an open dine-in sale; prints customer receipt."""
    sale = db.session.get(Sale, sale_id)
    if not sale:
        raise HTTPException(status_code=404, detail="Not Found")
    fb = _forbidden_unless_sale_branch(sale, current_user)
    if fb:
        return fb
    if getattr(sale, "status", "") != "open":
        return _json_error("Bad Request", "Order is not awaiting payment", 400)
    data = payload or {}
    if not data.get("payment_method"):
        return _json_error("Bad Request", "payment_method is required", 400)

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
    ot = getattr(sale, "order_type", None)
    delivery_charge, service_charge = _order_charges(ot, data)
    tax_amount = discounted_subtotal * tax_rate
    total_with_tax = discounted_subtotal + tax_amount + delivery_charge + service_charge

    try:
        sale.payment_method = data["payment_method"]
        sale.discount_amount = discount_amount
        sale.discount_id = discount_id
        sale.discount_snapshot = discount_snapshot
        sale.delivery_charge = delivery_charge
        sale.service_charge = service_charge
        sale.tax_amount = tax_amount
        sale.total_amount = total_with_tax
        sale.status = "completed"
        db.session.flush()
        enqueue_sync_event(
            branch_id=sale.branch_id,
            entity_type="sale",
            entity_id=sale.id,
            event_type="dine_in_finalized",
            payload={"total": float(sale.total_amount), "payment_method": data.get("payment_method")},
        )
        db.session.commit()
        _schedule_order_event(RealtimeEvents.ORDER_UPDATED, sale, total=float(sale.total_amount))

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
                "delivery_charge": float(delivery_charge),
                "service_charge": float(service_charge),
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
        return _json_error("Bad Request", f"Finalize failed: {str(exc)}", 400)


@orders_router.post("/{sale_id}/cancel-open")
def cancel_open_sale(sale_id: int, current_user: User = Depends(get_current_user)):
    """Cancel an unpaid dine-in tab and restore stock."""
    sale = db.session.get(Sale, sale_id)
    if not sale:
        raise HTTPException(status_code=404, detail="Not Found")
    fb = _forbidden_unless_sale_branch(sale, current_user)
    if fb:
        return fb
    if getattr(sale, "status", "") != "open":
        return _json_error("Bad Request", "Only open unpaid orders can be cancelled this way", 400)
    try:
        for item in list(sale.items):
            _restore_sale_item_side_effects(
                item,
                branch_id=sale.branch_id,
                current_user_id=current_user.id,
                reason=f"Open order #{sale_id} cancelled",
                inventory_reason="adjustment",
            )
        db.session.delete(sale)
        db.session.commit()
        _schedule_order_event(RealtimeEvents.ORDER_UPDATED, sale, deleted=True)
        return {"message": "Open order cancelled", "sale_id": sale_id}
    except Exception as exc:
        db.session.rollback()
        return _json_error("Internal Server Error", str(exc), 500)


@orders_router.get("/{sale_id}")
def get_sale_details(sale_id: int, current_user: User = Depends(get_current_user)):
    sale = db.session.get(Sale, sale_id)
    if not sale:
        raise HTTPException(status_code=404, detail="Not Found")
    fb = _forbidden_unless_sale_branch(sale, current_user)
    if fb:
        return fb
    flat_items: list[dict[str, Any]] = []
    for i in sale.items:
        flat_items.append(
            {
                "id": i.id,
                "sale_id": sale.id,
                "product_id": i.product_id,
                "product_title": i.product.title if i.product else "Unknown",
                "variant_sku_suffix": i.variant_sku_suffix,
                "quantity": i.quantity,
                "unit_price": float(i.unit_price),
                "subtotal": float(i.subtotal),
                "modifiers": _modifiers_payload_for_api(i.modifiers or []),
                "parent_sale_item_id": i.parent_sale_item_id,
                "is_deal": bool(i.product.is_deal) if i.product else False,
                "children": [],
            }
        )
    items = _nest_sale_item_dicts(flat_items).get(sale.id, [])
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
        "delivery_charge": float(getattr(sale, "delivery_charge", 0) or 0),
        "service_charge": float(getattr(sale, "service_charge", 0) or 0),
        "discount_snapshot": getattr(sale, "discount_snapshot", None),
        "order_type": getattr(sale, "order_type", None),
        "order_snapshot": getattr(sale, "order_snapshot", None),
        "items": items,
    }
    if hasattr(sale, "archived_at") and sale.archived_at:
        out["archived_at"] = sale.archived_at.isoformat()
    return out


@orders_router.post("/{sale_id}/rollback")
def rollback_sale(sale_id: int, current_user: User = Depends(get_current_user)):
    sale = db.session.get(Sale, sale_id)
    if not sale:
        raise HTTPException(status_code=404, detail="Not Found")
    fb = _forbidden_unless_sale_branch(sale, current_user)
    if fb:
        return fb
    if getattr(sale, "status", "completed") == "open":
        return _json_error("Bad Request", "Unpaid dine-in order: cancel from Active Dine-In or void the open tab first", 400)
    if getattr(sale, "status", "completed") == "refunded":
        return _json_error("Bad Request", "Sale already refunded", 400)
    try:
        sale.status = "refunded"
        for item in sale.items:
            _restore_sale_item_side_effects(
                item,
                branch_id=sale.branch_id,
                current_user_id=current_user.id,
                reason=f"Sale #{sale_id} refunded",
                inventory_reason="refund",
            )
        db.session.flush()
        enqueue_sync_event(
            branch_id=sale.branch_id,
            entity_type="sale",
            entity_id=sale.id,
            event_type="sale_refunded",
            payload={"status": "refunded"},
        )
        db.session.commit()
        _schedule_order_event(RealtimeEvents.ORDER_UPDATED, sale, refunded=True)
        return {"message": "Sale rolled back successfully"}
    except Exception as exc:
        db.session.rollback()
        return _json_error("Internal Server Error", f"Rollback failed: {str(exc)}", 500)


@orders_router.patch("/{sale_id}/archive")
def archive_sale(sale_id: int, current_user: User = Depends(get_current_user)):
    sale = db.session.get(Sale, sale_id)
    if not sale:
        raise HTTPException(status_code=404, detail="Not Found")
    fb = _forbidden_unless_sale_branch(sale, current_user)
    if fb:
        return fb
    if not hasattr(sale, "archived_at"):
        return _json_error("Bad Request", "Archive not supported", 400)
    try:
        sale.archived_at = datetime.now(timezone.utc)
        db.session.commit()
        return {"message": "Transaction archived", "archived_at": sale.archived_at.isoformat()}
    except Exception as exc:
        db.session.rollback()
        return _json_error("Internal Server Error", str(exc), 500)


@orders_router.patch("/{sale_id}/unarchive")
def unarchive_sale(sale_id: int, current_user: User = Depends(get_current_user)):
    sale = db.session.get(Sale, sale_id)
    if not sale:
        raise HTTPException(status_code=404, detail="Not Found")
    fb = _forbidden_unless_sale_branch(sale, current_user)
    if fb:
        return fb
    if not hasattr(sale, "archived_at"):
        return _json_error("Bad Request", "Unarchive not supported", 400)
    try:
        sale.archived_at = None
        db.session.commit()
        return {"message": "Transaction restored"}
    except Exception as exc:
        db.session.rollback()
        return _json_error("Internal Server Error", str(exc), 500)


@orders_router.delete("/{sale_id}")
def delete_sale_permanent(sale_id: int, current_user: User = Depends(require_owner)):
    sale = db.session.get(Sale, sale_id)
    if not sale:
        raise HTTPException(status_code=404, detail="Not Found")
    fb = _forbidden_unless_sale_branch(sale, current_user)
    if fb:
        return fb
    items_count = len(sale.items)
    try:
        db.session.delete(sale)
        db.session.commit()
        return {"message": "Transaction permanently deleted.", "related_deleted": {"sale_items": items_count}}
    except Exception as exc:
        db.session.rollback()
        return _json_error("Internal Server Error", str(exc), 500)


@orders_router.post("/{sale_id}/print")
def print_sale(sale_id: int, current_user: User = Depends(get_current_user)):
    sale = db.session.get(Sale, sale_id)
    if not sale:
        raise HTTPException(status_code=404, detail="Not Found")
    fb = _forbidden_unless_sale_branch(sale, current_user)
    if fb:
        return fb
    if getattr(sale, "status", "") == "open":
        return _json_error("Bad Request", "Finalize payment before printing a customer receipt", 400)
    discount_amount = float(getattr(sale, "discount_amount", 0) or 0)
    delivery_charge = float(getattr(sale, "delivery_charge", 0) or 0)
    service_charge = float(getattr(sale, "service_charge", 0) or 0)
    discounted_subtotal = float(sale.total_amount) - float(sale.tax_amount) - delivery_charge - service_charge
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
        "delivery_charge": delivery_charge,
        "service_charge": service_charge,
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
