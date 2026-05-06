from __future__ import annotations

from datetime import datetime, time, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy import and_, func, inspect, or_
from starlette.concurrency import run_in_threadpool

from app.deps import get_current_user, require_owner
from app.models import (
    Branch,
    Ingredient,
    Modifier,
    Product,
    Rider,
    Sale,
    SaleItem,
    Setting,
    User,
    db,
)
from app.order_metadata import normalize_order_type_and_snapshot
from app.routers.common import yes
from app.services.branch_scope import resolve_terminal_branch_id
from app.services.delivery_distance_service import compute_delivery_distance
from app.services.ingredient_deduction import (
    deduct_ingredient_stock,
    ingredient_display_name,
    restore_inventory_allocations,
)
from app.services.printer_background import (
    run_print_kot_and_stamp_job,
    run_print_kot_job,
    run_print_receipt_job,
    run_print_kot_modification_job as _run_print_kot_modification_job,
)
from app.services.product_pricing import effective_sale_price_for_variant
from app.services.recipe_variants import (
    combo_category_label,
    combo_items_for_variant,
    normalize_combo_category_name,
    normalize_combo_category_names,
    normalize_combo_selection_type,
    normalize_variant_key,
    prepared_recipe_rows_for_variant,
    recipe_rows_for_variant,
)
from app.services.sync_outbox import enqueue_sync_event
from app.routers.menu import _normalize_variants_list
from app.socketio_server import RealtimeEvents, schedule_emit_event

orders_router = APIRouter(prefix="/api/orders", tags=["orders"])
DELIVERY_CHARGE = 300.0
# Open KOT / kitchen tickets (unpaid tabs before payment)
KITCHEN_OPEN_ORDER_TYPES = ("dine_in", "takeaway", "delivery")
# Paid takeaway/delivery (and paid dine-in) are status=completed but must stay on KDS until kitchen workflow finishes.
KITCHEN_COMPLETED_LOOKBACK_DAYS = 7


def _normalize_phone_for_lookup(value: Any) -> str:
    if value is None:
        return ""
    return "".join(ch for ch in str(value) if ch.isdigit())


# POST /kot must be registered before any /{sale_id} route; otherwise Starlette matches
# GET /{sale_id} for path "kot" and returns 405 for POST (Method Not Allowed).
@orders_router.post("/kot")
def create_open_kot(
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    payload: dict[str, Any] | None = None,
):
    """Create an open KOT for dine-in, takeaway, or delivery (unpaid tab; kitchen + printer)."""
    return _create_open_kot_response(
        payload or {}, current_user, order_type_fixed=None, background_tasks=background_tasks
    )


@orders_router.post("/dine-in/kot")
def dine_in_kot(
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    payload: dict[str, Any] | None = None,
):
    """Create an open dine-in sale, deduct stock, print KOT (kitchen ticket). No payment yet."""
    return _create_open_kot_response(
        payload or {}, current_user, order_type_fixed="dine_in", background_tasks=background_tasks
    )


def _sales_table_columns() -> set[str]:
    return {c["name"] for c in inspect(db.engine).get_columns("sales")}


def _json_error(
    error: str, message: str, status_code: int, details: Any = None
) -> JSONResponse:
    payload: dict[str, Any] = {"error": error, "message": message}
    if details is not None:
        payload["details"] = details
    return JSONResponse(status_code=status_code, content=payload)


def _terminal_branch_or_error(user: User) -> tuple[str | None, JSONResponse | None]:
    try:
        return resolve_terminal_branch_id(user), None
    except HTTPException as exc:
        detail = exc.detail
        body: dict[str, Any] = (
            detail if isinstance(detail, dict) else {"message": str(detail)}
        )
        return None, JSONResponse(status_code=exc.status_code, content=body)


def _forbidden_unless_sale_branch(
    sale: Sale, current_user: User
) -> JSONResponse | None:
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
        "branch_id": sale.branch_id,
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


def _delivery_status_value(sale: Sale) -> str | None:
    if (getattr(sale, "order_type", None) or "").strip().lower() != "delivery":
        return None
    raw = str(getattr(sale, "delivery_status", "") or "").strip().lower()
    if raw in ("pending", "assigned", "delivered"):
        return raw
    if getattr(sale, "assigned_rider_id", None):
        return "assigned"
    return "pending"


def _fulfillment_status_value(sale: Sale) -> str | None:
    if (getattr(sale, "order_type", None) or "").strip().lower() != "takeaway":
        return None
    raw = str(getattr(sale, "fulfillment_status", "") or "").strip().lower()
    if raw in ("pending", "served"):
        return raw
    return "pending"


def _apply_order_fulfillment_defaults(sale: Sale) -> None:
    ot = (getattr(sale, "order_type", None) or "").strip().lower()
    if ot == "takeaway":
        sale.fulfillment_status = getattr(sale, "fulfillment_status", None) or "pending"
    else:
        sale.fulfillment_status = None


def _mark_takeaway_served(sale: Sale) -> tuple[bool, str]:
    if (getattr(sale, "order_type", None) or "").strip().lower() != "takeaway":
        return False, "Served action is only available for takeaway orders"
    sale.fulfillment_status = "served"
    return True, ""


def _upsert_rider_assignment_for_sale(sale: Sale) -> None:
    if (getattr(sale, "order_type", None) or "").strip().lower() != "delivery":
        sale.delivery_status = None
        sale.assigned_rider_id = None
        return
    snapshot = sale.order_snapshot if isinstance(getattr(sale, "order_snapshot", None), dict) else {}
    rider_name = str(snapshot.get("rider_name") or "").strip()
    if not rider_name:
        if getattr(sale, "assigned_rider", None):
            sale.assigned_rider.is_available = True
        sale.assigned_rider_id = None
        sale.delivery_status = "pending"
        return
    rider = Rider.query.filter_by(branch_id=sale.branch_id, name=rider_name, archived_at=None).first()
    if rider is None:
        rider = Rider(branch_id=sale.branch_id, name=rider_name, is_available=False)
        db.session.add(rider)
        db.session.flush()
    rider.is_available = False
    sale.assigned_rider_id = rider.id
    sale.delivery_status = "assigned"


def _mark_delivery_completed(sale: Sale) -> tuple[bool, str]:
    if (getattr(sale, "order_type", None) or "").strip().lower() != "delivery":
        return False, "Delivered action is only available for delivery orders"
    if _delivery_status_value(sale) != "assigned":
        return False, "Only assigned delivery orders can be marked delivered"
    rider_id = getattr(sale, "assigned_rider_id", None)
    if not rider_id:
        return False, "Cannot mark delivered without an assigned rider"
    rider = db.session.get(Rider, int(rider_id))
    if rider is not None:
        rider.is_available = True
    sale.assigned_rider_id = None
    sale.delivery_status = "delivered"
    snapshot = sale.order_snapshot if isinstance(getattr(sale, "order_snapshot", None), dict) else {}
    if snapshot:
        snapshot["rider_name"] = None
        sale.order_snapshot = snapshot
    return True, ""


def _assign_delivery_rider(sale: Sale, rider_name: Any) -> tuple[bool, str]:
    if (getattr(sale, "order_type", None) or "").strip().lower() != "delivery":
        return False, "Rider assignment is only available for delivery orders"
    if _delivery_status_value(sale) == "delivered":
        return False, "Delivered orders cannot be reassigned"
    name = str(rider_name or "").strip()
    if not name:
        return False, "Select a rider before assigning this delivery order"
    snapshot = sale.order_snapshot if isinstance(getattr(sale, "order_snapshot", None), dict) else {}
    snapshot = dict(snapshot)
    snapshot["rider_name"] = name
    sale.order_snapshot = snapshot
    _upsert_rider_assignment_for_sale(sale)
    return True, ""


def _sale_unit_price(product: Product, variant_key: str | None = None) -> float:
    return effective_sale_price_for_variant(product, variant_key)


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


def _order_charges(
    order_type: str | None, payload: dict[str, Any]
) -> tuple[float, float]:
    """
    Returns (delivery_charge, service_charge) for checkout/finalize.
    Delivery orders default delivery_charge to DELIVERY_CHARGE when the key is omitted.
    """
    ot = (order_type or "").strip().lower()
    if ot == "delivery":
        if "delivery_charge" in payload:
            dc = _parse_optional_non_negative_charge(
                payload.get("delivery_charge"), 0.0
            )
        else:
            dc = float(DELIVERY_CHARGE)
        return dc, 0.0
    if ot == "dine_in":
        return 0.0, _parse_optional_non_negative_charge(
            payload.get("service_charge"), 0.0
        )
    return 0.0, 0.0


def get_time_filter_ranges(
    time_filter: str, start_date_str: str | None, end_date_str: str | None
):
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
    branch_id: str,
    current_user_id: int,
    sale_id: int,
) -> tuple[bool, str, list[dict[str, Any]]]:
    allocations: list[dict[str, Any]] = []
    for mid in modifier_ids:
        mod = db.session.get(Modifier, mid)
        if mod is None or mod.ingredient_id is None:
            continue
        dep = (
            float(mod.depletion_quantity) if mod.depletion_quantity is not None else 1.0
        )
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


def _display_variant_suffix(raw: Any) -> str:
    """Return the variant label for display/API responses.
    Strips the implicit 'Default' sentinel that is used internally for single-price items
    with no real variant choice — callers should never show 'Default' to users.
    """
    v = str(raw or "").strip()
    return "" if v.lower() == "default" else v


def _normalize_product_variant_labels(raw: Any) -> list[str]:
    try:
        normalized = _normalize_variants_list(raw)
    except ValueError:
        normalized = []
    out: list[str] = []
    seen: set[str] = set()
    for entry in normalized:
        if isinstance(entry, str):
            label = entry.strip()
        elif isinstance(entry, dict):
            label = str(entry.get("name") or entry.get("label") or "").strip()
        else:
            label = ""
        if not label:
            continue
        key = label.casefold()
        if key in seen:
            continue
        seen.add(key)
        out.append(label)
    return out


def _default_variant_for_recipe_resolution(product: Product) -> str:
    """When a combo line does not carry a variant label, resolve BOM using the first priced variant (stable default)."""
    labels = _normalize_product_variant_labels(getattr(product, "variants", None))
    return labels[0] if labels else ""


def _validate_selected_product_variant(
    product: Product,
    raw_variant: Any,
    *,
    item_label: str,
) -> tuple[str | None, JSONResponse | None]:
    vk = str(raw_variant or "").strip()
    if len(vk) > 50:
        return None, _json_error(
            "Bad Request", f'{item_label}: variant too long (max 50)', 400
        )

    allowed = _normalize_product_variant_labels(getattr(product, "variants", None))
    if allowed:
        if not vk:
            if len(allowed) == 1:
                return allowed[0], None
            return None, _json_error(
                "Bad Request",
                f'{item_label}: choose a variant for "{product.title}"',
                400,
            )
        if vk not in allowed:
            return None, _json_error(
                "Bad Request",
                f'{item_label}: unknown variant "{vk}" for "{product.title}"',
                400,
            )
        return vk, None
    return "", None


def _validate_deal_selections(
    product: Product,
    variant_key: str,
    raw_selections: Any,
    *,
    item_index: int,
) -> tuple[list[dict[str, Any]] | None, JSONResponse | None]:
    expanded = combo_items_for_variant(product, variant_key or None)
    if not expanded:
        return None, _json_error(
            "Bad Request",
            f'Item at index {item_index}: deal "{product.title}" has no configured combo lines',
            400,
        )

    def _combo_row_requires_pos_selection(row: Any) -> bool:
        st = normalize_combo_selection_type(getattr(row, "selection_type", None))
        if st in {"category", "multiple_category"}:
            return True
        if st != "product":
            return False
        child = getattr(row, "child_product", None)
        if child is None:
            return False
        return len(_normalize_product_variant_labels(getattr(child, "variants", None))) > 1

    selection_rows = [row for row in expanded if _combo_row_requires_pos_selection(row)]
    if not selection_rows:
        return [], None

    if not isinstance(raw_selections, list):
        return None, _json_error(
            "Bad Request",
            f'Item at index {item_index}: deal "{product.title}" needs selections for its configurable slots',
            400,
        )

    choice_rows_by_id = {int(row.id): row for row in selection_rows if getattr(row, "id", None) is not None}
    selections_by_row: dict[int, dict[str, Any]] = {}
    normalized_selections: list[dict[str, Any]] = []
    for selection_index, raw_selection in enumerate(raw_selections):
        if not isinstance(raw_selection, dict):
            return None, _json_error(
                "Bad Request",
                f"Item at index {item_index}: deal selection {selection_index + 1} must be an object",
                400,
            )

        combo_item_id_raw = raw_selection.get("combo_item_id")
        if combo_item_id_raw is None:
            combo_item_id_raw = raw_selection.get("comboItemId")
        product_id_raw = raw_selection.get("product_id")
        if product_id_raw is None:
            product_id_raw = raw_selection.get("productId")

        try:
            combo_item_id = int(combo_item_id_raw)
            selected_product_id = int(product_id_raw)
        except (TypeError, ValueError):
            return None, _json_error(
                "Bad Request",
                f"Item at index {item_index}: each deal selection needs valid combo_item_id and product_id",
                400,
            )

        combo_row = choice_rows_by_id.get(combo_item_id)
        if combo_row is None:
            return None, _json_error(
                "Bad Request",
                f'Item at index {item_index}: selection row {combo_item_id} does not belong to the active deal configuration',
                400,
            )
        if combo_item_id in selections_by_row:
            return None, _json_error(
                "Bad Request",
                f"Item at index {item_index}: duplicate selection for deal row {combo_item_id}",
                400,
            )

        selected_product = db.session.get(Product, selected_product_id)
        if selected_product is None or getattr(selected_product, "archived_at", None) is not None:
            return None, _json_error(
                "Bad Request",
                f"Item at index {item_index}: selected menu item {selected_product_id} is unavailable",
                400,
            )
        if getattr(selected_product, "is_deal", False):
            return None, _json_error(
                "Bad Request",
                f'Item at index {item_index}: "{selected_product.title}" is a deal and cannot fill a deal slot',
                400,
            )

        row_st = normalize_combo_selection_type(getattr(combo_row, "selection_type", None))
        if row_st in {"category", "multiple_category"}:
            if row_st == "multiple_category":
                expected_categories = normalize_combo_category_names(getattr(combo_row, "category_names", None))
            else:
                expected_categories = [normalize_combo_category_name(getattr(combo_row, "category_name", None))]
            expected_keys = {name.casefold() for name in expected_categories if name}
            selected_category = normalize_combo_category_name(getattr(selected_product, "section", None))
            if not expected_keys or selected_category.casefold() not in expected_keys:
                return None, _json_error(
                    "Bad Request",
                    f'Item at index {item_index}: "{selected_product.title}" is not in category "{combo_category_label(expected_categories)}"',
                    400,
                )
        else:
            fixed_pid = int(getattr(combo_row, "product_id", 0) or 0)
            if fixed_pid != int(selected_product.id):
                return None, _json_error(
                    "Bad Request",
                    f'Item at index {item_index}: wrong menu item for a fixed deal line (expected bundled item id {fixed_pid})',
                    400,
                )

        raw_child_variant = raw_selection.get("variant_sku_suffix")
        if raw_child_variant is None:
            raw_child_variant = raw_selection.get("variant")
        child_variant, child_variant_err = _validate_selected_product_variant(
            selected_product,
            raw_child_variant,
            item_label=f"Item at index {item_index} selection {selection_index + 1}",
        )
        if child_variant_err:
            return None, child_variant_err
        assert child_variant is not None

        normalized_selection = {
            "combo_item_id": combo_item_id,
            "product_id": selected_product.id,
            "variant_sku_suffix": child_variant,
        }
        selections_by_row[combo_item_id] = normalized_selection
        normalized_selections.append(normalized_selection)

    missing_rows = [row for row_id, row in choice_rows_by_id.items() if row_id not in selections_by_row]
    if missing_rows:
        labels: list[str] = []
        for row in missing_rows:
            st = normalize_combo_selection_type(getattr(row, "selection_type", None))
            if st == "category":
                labels.append(normalize_combo_category_name(getattr(row, "category_name", None)) or f"row {row.id}")
            elif st == "multiple_category":
                labels.append(
                    combo_category_label(
                        normalize_combo_category_names(getattr(row, "category_names", None)),
                        getattr(row, "category_name", None),
                    )
                    or f"row {row.id}"
                )
            else:
                ch = getattr(row, "child_product", None)
                labels.append(str(getattr(ch, "title", None) or f"row {row.id}"))
        names = ", ".join(labels)
        return None, _json_error(
            "Bad Request",
            f'Item at index {item_index}: complete deal choices for: {names}',
            400,
        )

    return normalized_selections, None


def _deduct_recipe_for_product(
    product: Product,
    qty: int,
    branch_id: str,
    current_user_id: int,
    sale_id: int,
    variant_key: str | None = None,
    *,
    recipe_error_context: str = "",
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
        deal_hint = (
            " (bundled deal items use each menu item's BOM in Inventory → Recipes, not the deal product itself)"
            if recipe_error_context == "deal_component"
            else ""
        )
        if vk:
            return (
                False,
                f'Add a recipe (BOM) for "{product.title}" (variant "{vk}") in Inventory → Recipes, '
                "or add a base recipe that applies to all variants."
                + deal_hint,
                [],
            )
        return False, f"Add a recipe (BOM) for menu item: {product.title}" + deal_hint, []

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
    branch_id: str,
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
    branch_id: str,
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
            dep = (
                float(mod.depletion_quantity)
                if mod.depletion_quantity is not None
                else 1.0
            )
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
    branch_id: str,
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

    _restore_modifier_depletions_from_sale_item(
        sale_item, branch_id, current_user_id, reason
    )


def _nest_sale_item_dicts(
    flat_items: list[dict[str, Any]],
) -> dict[int, list[dict[str, Any]]]:
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
    branch_id: str,
    current_user_id: int,
    sale_id: int,
    parent_sale_item_id: int | None = None,
    is_deal_child: bool = False,
) -> tuple[bool, str, float]:
    """Create SaleItem rows; deduct branch ingredient stock via recipe (BOM) and modifier mappings."""
    qty = int(item_dict["quantity"])
    modifier_ids = item_dict.get("modifier_ids") or []
    line_variant = normalize_variant_key(item_dict.get("variant_sku_suffix"))

    ok_snap, err_snap, mod_snapshots = _resolve_modifier_snapshots(modifier_ids)
    if not ok_snap:
        return False, err_snap, 0.0

    unit_price = 0.0 if is_deal_child else _sale_unit_price(product, line_variant)
    subtotal = unit_price * qty

    sale_item = SaleItem(
        sale_id=sale_id,
        product_id=product.id,
        variant_sku_suffix=line_variant[:50] if line_variant else "",
        quantity=qty,
        unit_price=unit_price,
        subtotal=subtotal,
        modifiers=mod_snapshots if (mod_snapshots and not is_deal_child) else None,
        parent_sale_item_id=parent_sale_item_id,
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
            product,
            qty,
            branch_id,
            current_user_id,
            sale_id,
            variant_key=line_variant or None,
            recipe_error_context="deal_component" if is_deal_child else "",
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
        selection_lookup = {
            int(selection["combo_item_id"]): selection
            for selection in (item_dict.get("deal_selections") or [])
            if isinstance(selection, dict) and selection.get("combo_item_id") is not None
        }
        for combo_item in expanded:
            selection_type = normalize_combo_selection_type(getattr(combo_item, "selection_type", None))
            child = combo_item.child_product
            child_variant = ""
            if selection_type in {"category", "multiple_category"}:
                selection = selection_lookup.get(int(combo_item.id))
                if selection is None:
                    if selection_type == "multiple_category":
                        category_name = combo_category_label(
                            normalize_combo_category_names(getattr(combo_item, "category_names", None)),
                            getattr(combo_item, "category_name", None),
                        )
                    else:
                        category_name = normalize_combo_category_name(getattr(combo_item, "category_name", None))
                    return (
                        False,
                        f'Choose a menu item for "{category_name}" in deal "{product.title}" before checkout.',
                        0.0,
                    )
                child = db.session.get(Product, int(selection["product_id"]))
                child_variant = normalize_variant_key(selection.get("variant_sku_suffix"))
            elif child:
                sel_fixed = selection_lookup.get(int(combo_item.id))
                labels = _normalize_product_variant_labels(getattr(child, "variants", None))
                if len(labels) > 1 and sel_fixed:
                    child_variant = normalize_variant_key(sel_fixed.get("variant_sku_suffix"))
                else:
                    child_variant = _default_variant_for_recipe_resolution(child)
            if child:
                child_dict = {
                    "product_id": child.id,
                    "quantity": qty * combo_item.quantity,
                    "modifier_ids": [],
                    "variant_sku_suffix": child_variant,
                }
                ok, err, _ = _deduct_product_inventory_and_create_sale_items(
                    child,
                    child_dict,
                    branch_id,
                    current_user_id,
                    sale_id,
                    parent_sale_item_id=sale_item.id,
                    is_deal_child=True,
                )
                if not ok:
                    return False, err, 0.0

    sale_item.inventory_allocations = inventory_allocations or None
    return True, "", subtotal


@orders_router.post("/checkout")
def checkout(
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    payload: dict[str, Any] | None = None,
):
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

    order_type_norm, order_snapshot_norm, order_err = normalize_order_type_and_snapshot(
        data
    )
    if order_err:
        return _json_error("Bad Request", order_err, 400)

    setting = (
        Setting.query.filter_by(branch_id=branch_id).first()
        or Setting.query.filter_by(branch_id=None).first()
    )
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
        _upsert_rider_assignment_for_sale(new_sale)
        _apply_order_fulfillment_defaults(new_sale)
        if order_type_norm == "takeaway":
            new_sale.fulfillment_status = "served"
        db.session.add(new_sale)
        db.session.flush()
        for item in items:
            product = db.session.get(Product, item["product_id"])
            if product is None:
                db.session.rollback()
                return _json_error(
                    "Bad Request", f"Product ID {item['product_id']} not found", 400
                )

            ok, err, subtotal = _deduct_product_inventory_and_create_sale_items(
                product=product,
                item_dict=item,
                branch_id=branch_id,
                current_user_id=current_user.id,
                sale_id=new_sale.id,
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
                discount_snapshot = {
                    "name": discount_data.get("name") or "Discount",
                    "type": d_type,
                    "value": d_value,
                }
        discounted_subtotal = total_amount - discount_amount
        delivery_charge, service_charge = _order_charges(order_type_norm, data)
        new_sale.discount_amount = discount_amount
        new_sale.discount_id = discount_id
        new_sale.discount_snapshot = discount_snapshot
        new_sale.delivery_charge = delivery_charge
        new_sale.service_charge = service_charge
        new_sale.tax_amount = discounted_subtotal * tax_rate
        new_sale.total_amount = (
            discounted_subtotal + new_sale.tax_amount + delivery_charge + service_charge
        )
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
        branch_name = "Main Branch"
        branch_obj = db.session.get(Branch, branch_id) if branch_id else None
        if branch_obj:
            branch_name = branch_obj.name
        receipt_items = _build_receipt_items(new_sale.id)
        discount_name = (
            discount_snapshot.get("name")
            if isinstance(discount_snapshot, dict)
            else "Discount"
        )
        receipt_dict = {
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
        # Enqueue immediately (fast). Actual I/O runs on the print dispatcher thread.
        receipt_job_id = run_print_receipt_job(receipt_dict)
        # Paid checkout must start the customer receipt before any kitchen printer I/O.
        # Kitchen printing can block on a separate LAN/USB device; it should never delay
        # the receipt for dine-in, takeaway, delivery, or any payment method.
        if getattr(new_sale, "order_type", None) in KITCHEN_OPEN_ORDER_TYPES and getattr(
            new_sale, "kds_ticket_printed_at", None
        ) is None:
            # Queue KOT after the receipt has been queued (lower priority).
            run_print_kot_and_stamp_job(new_sale.id, None, branch_id, current_user.username)
        return JSONResponse(
            status_code=201,
            content={
                "message": "Checkout successful",
                "sale_id": new_sale.id,
                "total": float(new_sale.total_amount),
                "print_success": True,
                "print_deferred": True,
                "print_job_id": receipt_job_id,
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
    branch_id: str | None = None,
    include_archived: str | None = None,
    include_open: str | None = None,
    limit: int | None = None,
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

        query = query.order_by(Sale.created_at.desc())
        if limit is not None:
            query = query.limit(max(1, min(int(limit), 1000)))
        sales_rows = query.all()
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
    branch_id: str | None = None,
    current_user: User = Depends(get_current_user),
):
    try:
        sales_cols = _sales_table_columns()
        has_status_col = "status" in sales_cols

        start_dt, end_dt = get_time_filter_ranges(time_filter, start_date, end_date)
        query = db.session.query(
            Sale.id, Sale.total_amount, Sale.branch_id, Sale.created_at
        )
        if has_status_col:
            query = query.add_columns(Sale.status).filter(
                Sale.status != "refunded", Sale.status != "open"
            )
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
                db.session.query(
                    SaleItem.product_id, func.sum(SaleItem.quantity).label("total_qty")
                )
                .filter(SaleItem.sale_id.in_(sale_ids))
                .group_by(SaleItem.product_id)
                .order_by(func.sum(SaleItem.quantity).desc())
                .first()
            )
            if top_row:
                product = db.session.get(Product, top_row.product_id)
                if product:
                    most_selling = {
                        "id": product.id,
                        "title": product.title,
                        "total_sold": int(top_row.total_qty),
                    }
        return {
            "total_sales": float(total_sales),
            "total_transactions": total_transactions,
            "most_selling_product": most_selling,
        }
    except Exception as exc:
        raise


def _money(value: Any) -> float:
    return float(value or 0)


def _metric(orders: int = 0, amount: Any = 0) -> dict[str, Any]:
    return {"orders": int(orders or 0), "amount": _money(amount)}


def _payment_key(value: Any) -> str:
    normalized = (str(value or "unspecified").strip().lower() or "unspecified")
    normalized = normalized.replace("-", " ").replace("_", " ")
    if normalized in {"online", "online transfer", "bank transfer"}:
        return "online_transfer"
    return "_".join(normalized.split())


def _payment_label(key: str, raw: Any = None) -> str:
    labels = {
        "cash": "Cash",
        "card": "Card",
        "online_transfer": "Online Transfer",
        "unspecified": "Unspecified",
    }
    return labels.get(key) or (str(raw).strip() if raw else key.replace("_", " ").title())


def _order_type_key(value: Any) -> str:
    normalized = (str(value or "unspecified").strip().lower() or "unspecified")
    normalized = normalized.replace("-", "_").replace(" ", "_")
    return normalized if normalized in {"takeaway", "dine_in", "delivery"} else "unspecified"


def _sales_report_filters(
    terminal_branch_id: str,
    start_dt: datetime | None,
    end_dt: datetime | None,
    include_archived: str | None,
) -> list[Any]:
    filters: list[Any] = [Sale.branch_id == terminal_branch_id]
    if start_dt and end_dt:
        filters.extend([Sale.created_at >= start_dt, Sale.created_at <= end_dt])
    if not yes(include_archived):
        filters.append(Sale.archived_at == None)  # noqa: E711
    return filters


def _build_detailed_report(
    time_filter: str,
    start_date: str | None,
    end_date: str | None,
    include_archived: str | None,
    current_user: User,
) -> dict[str, Any] | JSONResponse:
    start_dt, end_dt = get_time_filter_ranges(time_filter, start_date, end_date)
    tid, terr = _terminal_branch_or_error(current_user)
    if terr:
        return terr
    assert tid is not None

    base_filters = _sales_report_filters(tid, start_dt, end_dt, include_archived)
    completed_filters = [*base_filters, Sale.status == "completed"]

    profit_row = (
        db.session.query(
            func.coalesce(
                func.sum(
                    (SaleItem.unit_price - func.coalesce(Product.base_price, 0))
                    * SaleItem.quantity
                ),
                0,
            )
        )
        .join(Sale, Sale.id == SaleItem.sale_id)
        # Outer join so old rows with missing/deleted products don't zero-out profit.
        .outerjoin(Product, Product.id == SaleItem.product_id)
        # Deals create child lines with unit_price=0; those should not affect profit since
        # revenue is captured on the deal parent line.
        .filter(*completed_filters, SaleItem.parent_sale_item_id == None)  # noqa: E711
        .one()
    )

    totals_row = (
        db.session.query(
            func.count(Sale.id),
            func.coalesce(func.sum(Sale.total_amount), 0),
            func.coalesce(func.sum(Sale.discount_amount), 0),
            func.coalesce(func.sum(Sale.tax_amount), 0),
            func.coalesce(func.sum(Sale.delivery_charge), 0),
            func.coalesce(func.sum(Sale.service_charge), 0),
        )
        .filter(*completed_filters)
        .one()
    )
    refunded_row = (
        db.session.query(func.count(Sale.id), func.coalesce(func.sum(Sale.total_amount), 0))
        .filter(*base_filters, Sale.status == "refunded")
        .one()
    )
    open_row = (
        db.session.query(func.count(Sale.id), func.coalesce(func.sum(Sale.total_amount), 0))
        .filter(*base_filters, Sale.status == "open")
        .one()
    )

    payment_rows = (
        db.session.query(
            Sale.payment_method,
            func.count(Sale.id).label("orders"),
            func.coalesce(func.sum(Sale.total_amount), 0).label("amount"),
        )
        .filter(*completed_filters)
        .group_by(Sale.payment_method)
        .all()
    )
    order_type_rows = (
        db.session.query(
            Sale.order_type,
            func.count(Sale.id).label("orders"),
            func.coalesce(func.sum(Sale.total_amount), 0).label("amount"),
        )
        .filter(*completed_filters)
        .group_by(Sale.order_type)
        .all()
    )

    top_row = (
        db.session.query(
            SaleItem.product_id,
            Product.title,
            func.sum(SaleItem.quantity).label("total_qty"),
        )
        .join(Sale, Sale.id == SaleItem.sale_id)
        .join(Product, Product.id == SaleItem.product_id)
        .filter(*completed_filters)
        .group_by(SaleItem.product_id, Product.title)
        .order_by(func.sum(SaleItem.quantity).desc())
        .first()
    )

    payment_methods: dict[str, dict[str, Any]] = {
        "cash": _metric(),
        "card": _metric(),
        "online_transfer": _metric(),
    }
    payment_breakdown: list[dict[str, Any]] = []
    for raw_method, orders, amount in payment_rows:
        key = _payment_key(raw_method)
        metric = _metric(orders, amount)
        payment_methods[key] = metric
        payment_breakdown.append(
            {
                "key": key,
                "label": _payment_label(key, raw_method),
                **metric,
            }
        )

    order_types: dict[str, dict[str, Any]] = {
        "delivery": _metric(),
        "dine_in": _metric(),
        "takeaway": _metric(),
        "unspecified": _metric(),
    }
    order_type_breakdown: list[dict[str, Any]] = []
    order_type_labels = {
        "delivery": "Delivery",
        "dine_in": "Dine-in",
        "takeaway": "Takeaway",
        "unspecified": "Unspecified",
    }
    for raw_type, orders, amount in order_type_rows:
        key = _order_type_key(raw_type)
        metric = _metric(orders, amount)
        order_types[key] = metric
        order_type_breakdown.append({"key": key, "label": order_type_labels[key], **metric})

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "period": {
            "time_filter": time_filter,
            "start": start_dt.isoformat() if start_dt else None,
            "end": end_dt.isoformat() if end_dt else None,
        },
        "totals": {
            "orders": int(totals_row[0] or 0),
            "received_amount": _money(totals_row[1]),
            "profit_amount": _money(profit_row[0]),
            "discount_amount": _money(totals_row[2]),
            "tax_amount": _money(totals_row[3]),
            "delivery_charge": _money(totals_row[4]),
            "service_charge": _money(totals_row[5]),
            "refunded_orders": int(refunded_row[0] or 0),
            "refunded_amount": _money(refunded_row[1]),
            "open_orders": int(open_row[0] or 0),
            "open_amount": _money(open_row[1]),
        },
        "payment_methods": payment_methods,
        "payment_method_breakdown": sorted(
            payment_breakdown,
            key=lambda row: (0 if row["key"] in {"cash", "card", "online_transfer"} else 1, row["label"]),
        ),
        "order_types": order_types,
        "order_type_breakdown": sorted(order_type_breakdown, key=lambda row: row["label"]),
        "most_selling_product": (
            {
                "id": top_row.product_id,
                "title": top_row.title,
                "total_sold": int(top_row.total_qty or 0),
            }
            if top_row
            else None
        ),
    }


@orders_router.get("/report")
async def get_detailed_report(
    time_filter: str = "today",
    start_date: str | None = None,
    end_date: str | None = None,
    branch_id: str | None = None,
    include_archived: str | None = None,
    current_user: User = Depends(get_current_user),
):
    _ = branch_id
    return await run_in_threadpool(
        _build_detailed_report,
        time_filter,
        start_date,
        end_date,
        include_archived,
        current_user,
    )


@orders_router.get("/delivery-customer")
def get_delivery_customer_by_phone(
    phone: str,
    current_user: User = Depends(get_current_user),
):
    """Lookup the latest delivery customer details by phone for this terminal branch."""
    normalized_query = _normalize_phone_for_lookup(phone)
    if not normalized_query:
        return {"found": False}

    tid, terr = _terminal_branch_or_error(current_user)
    if terr:
        return terr

    sales = (
        Sale.query.filter(
            Sale.branch_id == tid,
            Sale.order_type == "delivery",
            Sale.order_snapshot.isnot(None),
            Sale.status != "refunded",
        )
        .order_by(Sale.created_at.desc())
        .limit(500)
        .all()
    )
    matches: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for sale in sales:
        snap = sale.order_snapshot if isinstance(sale.order_snapshot, dict) else {}
        snap_phone = _normalize_phone_for_lookup(snap.get("phone"))
        if not snap_phone:
            continue
        if snap_phone != normalized_query:
            continue
        customer_name = (snap.get("customer_name") or "").strip()
        address = (snap.get("address") or "").strip()
        nearest_landmark = (snap.get("nearest_landmark") or "").strip()
        if not customer_name or (not address and not nearest_landmark):
            continue
        pair_key = (customer_name.casefold(), (address or nearest_landmark).casefold())
        if pair_key in seen:
            continue
        seen.add(pair_key)
        matches.append(
            {
                "customer_name": customer_name,
                "address": address,
                "nearest_landmark": nearest_landmark,
                "phone": (snap.get("phone") or "").strip() or phone.strip(),
            }
        )
        if len(matches) >= 5:
            break
    if matches:
        primary = matches[0]
        return {
            "found": True,
            "customer_name": primary["customer_name"],
            "address": primary["address"],
            "nearest_landmark": primary["nearest_landmark"],
            "phone": primary["phone"],
            "matches": matches,
        }
    return {"found": False}


@orders_router.get("/delivery-distance")
def get_delivery_distance(
    address: str,
    current_user: User = Depends(get_current_user),
):
    """Calculate branch -> customer delivery distance in kilometers."""
    customer_address = (address or "").strip()
    if not customer_address:
        return _json_error("Bad Request", "address is required", 400)

    tid, terr = _terminal_branch_or_error(current_user)
    if terr:
        return terr

    branch = db.session.get(Branch, tid)
    branch_address = (branch.address or "").strip() if branch else ""
    if not branch_address:
        return {
            "found": False,
            "distance_km": None,
            "duration_min": None,
            "source": "unavailable",
            "message": "Branch address is missing. Update branch details first.",
        }

    result = compute_delivery_distance(branch_address, customer_address)
    return result


def _validate_cart_items(
    items: list,
) -> tuple[Optional[list[dict]], Optional[JSONResponse]]:
    if not items:
        return None, _json_error("Bad Request", "Cart is empty", 400)
    normalized: list[dict] = []
    for idx, item in enumerate(items):
        if not isinstance(item, dict):
            return None, _json_error(
                "Bad Request", f"Item at index {idx} must be an object", 400
            )
        if item.get("product_id") is None:
            return None, _json_error(
                "Bad Request", f"Item at index {idx} missing product_id", 400
            )
        try:
            qty = int(item.get("quantity", 0))
        except (TypeError, ValueError):
            return None, _json_error(
                "Bad Request",
                f"Item at index {idx} quantity must be a positive integer",
                400,
            )
        if qty <= 0:
            return None, _json_error(
                "Bad Request", f"Item at index {idx} quantity must be positive", 400
            )
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
                return None, _json_error(
                    "Bad Request", f"Item at index {idx} has invalid modifier_ids", 400
                )

        pid = int(item["product_id"])
        product = db.session.get(Product, pid)
        if product is None:
            return None, _json_error(
                "Bad Request", f"Item at index {idx}: product_id {pid} not found", 400
            )
        if getattr(product, "archived_at", None) is not None:
            return None, _json_error(
                "Bad Request",
                f'Item at index {idx}: "{product.title}" is no longer on the menu',
                400,
            )

        raw_v = item.get("variant_sku_suffix")
        if raw_v is None:
            raw_v = item.get("variant")
        vk, variant_err = _validate_selected_product_variant(
            product,
            raw_v,
            item_label=f"Item at index {idx}",
        )
        if variant_err:
            return None, variant_err
        assert vk is not None

        raw_deal_selections = item.get("deal_selections")
        if raw_deal_selections is None:
            raw_deal_selections = item.get("dealSelections")
        if getattr(product, "is_deal", False):
            deal_selections, selection_err = _validate_deal_selections(
                product,
                vk,
                raw_deal_selections,
                item_index=idx,
            )
            if selection_err:
                return None, selection_err
            assert deal_selections is not None
        else:
            deal_selections = []

        normalized.append(
            {
                "product_id": pid,
                "quantity": qty,
                "modifier_ids": modifier_ids,
                "variant_sku_suffix": vk,
                "deal_selections": deal_selections,
            }
        )
    return normalized, None


def _resolve_branch_id(
    data: dict[str, Any], current_user: User
) -> tuple[int | None, JSONResponse | None]:
    _ = data
    return _terminal_branch_or_error(current_user)


@orders_router.get("/active")
def list_active_dine_in_orders(
    branch_id: str | None = None,
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
        has_fulfillment_status_col = "fulfillment_status" in sales_cols

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
        _maybe_add("fulfillment_status", Sale.fulfillment_status)

        if not select_cols:
            return {"sales": []}

        query = db.session.query(*[col for _, col in select_cols])

        if has_status_col:
            active_status_clauses = [
                Sale.status == "open",
                and_(Sale.order_type == "delivery", Sale.delivery_status != "delivered"),
                and_(Sale.order_type == "delivery", Sale.delivery_status.is_(None), Sale.status == "completed"),
            ]
            if has_fulfillment_status_col:
                active_status_clauses.extend(
                    [
                        and_(Sale.order_type == "takeaway", Sale.fulfillment_status != "served"),
                        and_(Sale.order_type == "takeaway", Sale.fulfillment_status.is_(None), Sale.status == "completed"),
                    ]
                )
            query = query.filter(or_(*active_status_clauses))

        if has_order_type_col:
            query = query.filter(
                or_(
                    Sale.order_type.in_(KITCHEN_OPEN_ORDER_TYPES),
                    Sale.order_type.is_(None),
                )
            )

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
                "created_at": data["created_at"].isoformat()
                if data.get("created_at")
                else "",
                "payment_method": data.get("payment_method"),
                "status": data.get("status") or "completed",
                "order_type": inferred_order_type,
                "order_snapshot": snap,
                "table_name": table_name,
                "kitchen_status": kitchen_status,
                "fulfillment_status": data.get("fulfillment_status") if has_fulfillment_status_col else None,
            }
            out.append(out_row)
            sale_ids.append(sale_id_val)

        sales_by_id: dict[int, Sale] = {}
        if sale_ids:
            for sale in Sale.query.filter(Sale.id.in_(sale_ids)).all():
                sales_by_id[int(sale.id)] = sale
        for out_row in out:
            sale_obj = sales_by_id.get(int(out_row["id"]))
            out_row["delivery_status"] = _delivery_status_value(sale_obj) if sale_obj else None
            out_row["fulfillment_status"] = _fulfillment_status_value(sale_obj) if sale_obj else out_row.get("fulfillment_status")
            out_row["assigned_rider_id"] = int(sale_obj.assigned_rider_id) if sale_obj and sale_obj.assigned_rider_id else None
            out_row["orderStatus"] = "paid" if (out_row.get("status") or "completed") != "open" else "open"

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
                        "variant_sku_suffix": _display_variant_suffix(item.variant_sku_suffix),
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


def _line_dict_from_nested_node(
    n: dict[str, Any], *, children: list[dict[str, Any]] | None = None
) -> dict[str, Any]:
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
        "variant_sku_suffix": _display_variant_suffix(n.get("variant_sku_suffix")),
        "quantity": int(n.get("quantity") or 0),
        "modifiers": mod_strs,
        "children": children or [],
    }


def _line_signature(line: dict[str, Any]) -> str:
    mods = [m for m in (line.get("modifiers") or []) if isinstance(m, str)]
    mods.sort()
    vk = (line.get("variant_sku_suffix") or "").strip()
    return f'{line.get("product_title") or "Unknown"}|{vk}|{",".join(mods)}'


def _summarize_line(line: dict[str, Any]) -> str:
    qty = int(line.get("quantity") or 0)
    title = str(line.get("product_title") or "Unknown")
    vk = (line.get("variant_sku_suffix") or "").strip()
    mods = [m for m in (line.get("modifiers") or []) if isinstance(m, str) and m.strip()]
    text = f"{qty}x {title}"
    if vk:
        text += f" ({vk})"
    if mods:
        text += f" [+ {', '.join(mods)}]"
    return text


def _compute_order_modifications(
    old_nested: list[dict[str, Any]],
    new_nested: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    old_lines = _flatten_kitchen_display_lines(old_nested)
    new_lines = _flatten_kitchen_display_lines(new_nested)
    old_map = {_line_signature(line): line for line in old_lines}
    new_map = {_line_signature(line): line for line in new_lines}
    changes: list[dict[str, Any]] = []

    for sig, new_line in new_map.items():
        old_line = old_map.get(sig)
        new_qty = int(new_line.get("quantity") or 0)
        old_qty = int(old_line.get("quantity") or 0) if old_line else 0
        if old_line is None:
            changes.append(
                {
                    "type": "add",
                    "description": f"Added {_summarize_line(new_line)}",
                    "old": None,
                    "new": _summarize_line(new_line),
                    "old_quantity": 0,
                    "new_quantity": new_qty,
                }
            )
        elif new_qty != old_qty:
            changes.append(
                {
                    "type": "change",
                    "description": f"Changed {_summarize_line(new_line)} from {old_qty}x to {new_qty}x",
                    "old": _summarize_line(old_line),
                    "new": _summarize_line(new_line),
                    "old_quantity": old_qty,
                    "new_quantity": new_qty,
                }
            )

    for sig, old_line in old_map.items():
        if sig not in new_map:
            changes.append(
                {
                    "type": "remove",
                    "description": f"Removed {_summarize_line(old_line)}",
                    "old": _summarize_line(old_line),
                    "new": None,
                    "old_quantity": int(old_line.get("quantity") or 0),
                    "new_quantity": 0,
                }
            )
    return changes


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
            lines.append(
                _line_dict_from_nested_node(
                    n,
                    children=_flatten_kitchen_display_lines(n.get("children") or []),
                )
            )
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


KDS_BOARD_RETENTION = timedelta(hours=12)


def _kds_ticket_reference_utc(sale: Sale) -> datetime | None:
    """Timestamp used to reset stale tickets from the kitchen board."""
    ca = sale.created_at
    if ca is None:
        return None
    if ca.tzinfo is None:
        return ca.replace(tzinfo=timezone.utc)
    return ca


def _sale_visible_on_kds(sale: Sale) -> bool:
    """Hide voided/archived tickets and stale KDS cards after the 12h operating window."""
    if getattr(sale, "status", None) == "refunded":
        return False
    if getattr(sale, "archived_at", None) is not None:
        return False
    ref = _kds_ticket_reference_utc(sale)
    if ref is None:
        return True
    return ref >= datetime.now(timezone.utc) - KDS_BOARD_RETENTION


@orders_router.get("/kitchen")
def list_kitchen_orders(
    branch_id: str | None = None,
    current_user: User = Depends(get_current_user),
):
    """Kitchen Display: open KOT tickets (dine-in, takeaway, delivery) with workflow status (placed → preparing → ready)."""
    try:
        _ = branch_id
        bid, berr = _terminal_branch_or_error(current_user)
        if berr:
            return berr
        assert bid is not None

        recent_completed = datetime.now(timezone.utc) - timedelta(
            days=KITCHEN_COMPLETED_LOOKBACK_DAYS
        )
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
            q = q.filter(
                or_(
                    Sale.order_type.in_(KITCHEN_OPEN_ORDER_TYPES),
                    Sale.order_type.is_(None),
                )
            )
        sales = [
            s
            for s in q.order_by(Sale.created_at.desc()).all()
            if _sale_visible_on_kds(s)
        ]
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
                    "variant_sku_suffix": _display_variant_suffix(item.variant_sku_suffix),
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
                    "created_at": sale.created_at.isoformat()
                    if sale.created_at
                    else "",
                    "order_type": ot,
                    "order_snapshot": snap,
                    "table_name": table_name,
                    "kitchen_status": _kitchen_status_value(sale),
                    "items": _kds_card_lines(nested),
                    "prep_lines": _kds_prep_lines(nested),
                    "modifications": (
                        (sale.modification_snapshot or {}).get("changes")
                        if isinstance(getattr(sale, "modification_snapshot", None), dict)
                        else []
                    ),
                    "is_modified": bool(getattr(sale, "modified_at", None)),
                    "modified_at": sale.modified_at.isoformat() if getattr(sale, "modified_at", None) else None,
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
        return _json_error(
            "Bad Request", "kitchen_status must be placed, preparing, or ready", 400
        )
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
        return _json_error(
            "Bad Request", "Order is not eligible for kitchen status updates", 400
        )
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


@orders_router.patch("/{sale_id}/delivery-complete")
def mark_delivery_complete(
    sale_id: int,
    current_user: User = Depends(get_current_user),
):
    sale = db.session.get(Sale, sale_id)
    if not sale:
        return _json_error("Not Found", "Order not found", 404)
    fb = _forbidden_unless_sale_branch(sale, current_user)
    if fb:
        return fb
    ok, message = _mark_delivery_completed(sale)
    if not ok:
        return _json_error("Bad Request", message, 400)
    db.session.commit()
    _schedule_order_event(RealtimeEvents.ORDER_UPDATED, sale, delivery_status="delivered")
    return {
        "ok": True,
        "id": sale.id,
        "delivery_status": "delivered",
        "assigned_rider_id": None,
    }


@orders_router.patch("/{sale_id}/assign-rider")
def assign_delivery_rider(
    sale_id: int,
    payload: dict[str, Any] | None = None,
    current_user: User = Depends(get_current_user),
):
    sale = db.session.get(Sale, sale_id)
    if not sale:
        raise HTTPException(status_code=404, detail="Not Found")
    fb = _forbidden_unless_sale_branch(sale, current_user)
    if fb:
        return fb
    ok, message = _assign_delivery_rider(sale, (payload or {}).get("rider_name"))
    if not ok:
        return _json_error("Bad Request", message, 400)
    db.session.commit()
    _schedule_order_event(RealtimeEvents.ORDER_UPDATED, sale, delivery_status="assigned")
    snapshot = sale.order_snapshot if isinstance(getattr(sale, "order_snapshot", None), dict) else {}
    return {
        "message": "Rider assigned",
        "sale_id": sale.id,
        "delivery_status": _delivery_status_value(sale),
        "assigned_rider_id": int(sale.assigned_rider_id) if sale.assigned_rider_id else None,
        "rider_name": snapshot.get("rider_name"),
    }


@orders_router.patch("/{sale_id}/takeaway-served")
def mark_takeaway_served(
    sale_id: int,
    current_user: User = Depends(get_current_user),
):
    sale = db.session.get(Sale, sale_id)
    if not sale:
        return _json_error("Not Found", "Order not found", 404)
    fb = _forbidden_unless_sale_branch(sale, current_user)
    if fb:
        return fb
    ok, message = _mark_takeaway_served(sale)
    if not ok:
        return _json_error("Bad Request", message, 400)
    db.session.commit()
    _schedule_order_event(RealtimeEvents.ORDER_UPDATED, sale, fulfillment_status="served")
    return {
        "ok": True,
        "id": sale.id,
        "fulfillment_status": "served",
    }


def _create_open_kot_response(
    data: dict[str, Any],
    current_user: User,
    *,
    background_tasks: BackgroundTasks,
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

    ot_src = (
        order_type_fixed
        if order_type_fixed is not None
        else (data.get("order_type") or "dine_in")
    )
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
        _upsert_rider_assignment_for_sale(new_sale)
        _apply_order_fulfillment_defaults(new_sale)
        db.session.add(new_sale)
        db.session.flush()
        total_amount = 0.0
        for item in items:
            product = db.session.get(Product, item["product_id"])
            if product is None:
                db.session.rollback()
                return _json_error(
                    "Bad Request", f"Product ID {item['product_id']} not found", 400
                )

            ok, err, subtotal = _deduct_product_inventory_and_create_sale_items(
                product=product,
                item_dict=item,
                branch_id=bid,
                current_user_id=current_user.id,
                sale_id=new_sale.id,
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

        skip_kot_print = data.get("skip_kot_print")
        should_print_now = not (
            skip_kot_print is True
            or (isinstance(skip_kot_print, str) and yes(skip_kot_print))
        )
        print_ok = None
        if should_print_now:
            background_tasks.add_task(
                run_print_kot_and_stamp_job,
                new_sale.id,
                None,
                bid,
                current_user.username,
            )
            print_ok = True
        kot_body: dict[str, Any] = {
            "message": "Kitchen order created",
            "sale_id": new_sale.id,
            "print_success": print_ok,
        }
        if should_print_now:
            kot_body["print_deferred"] = True
        return JSONResponse(status_code=201, content=kot_body)
    except Exception as exc:
        db.session.rollback()
        return _json_error("Bad Request", f"KOT failed: {str(exc)}", 400)


def _build_receipt_items(sale_id: int) -> list[dict[str, Any]]:
    receipt_rows = (
        db.session.query(
            SaleItem.id,
            SaleItem.sale_id,
            SaleItem.variant_sku_suffix,
            SaleItem.quantity,
            SaleItem.modifiers,
            SaleItem.parent_sale_item_id,
            SaleItem.unit_price,
            Product.title,
            Product.is_deal,
        )
        .outerjoin(Product, SaleItem.product_id == Product.id)
        .filter(SaleItem.sale_id == sale_id)
        .all()
    )
    receipt_flat_items: list[dict[str, Any]] = []
    for row in receipt_rows:
        receipt_flat_items.append(
            {
                "id": row.id,
                "sale_id": row.sale_id,
                "title": row.title if row.title else "Unknown",
                "variant_sku_suffix": _display_variant_suffix(row.variant_sku_suffix),
                "quantity": row.quantity,
                "unit_price": float(row.unit_price),
                "modifiers": _modifiers_for_display(row.modifiers or []),
                "parent_sale_item_id": row.parent_sale_item_id,
                "is_deal": row.is_deal,
                "children": [],
            }
        )
    return _nest_sale_item_dicts(receipt_flat_items).get(sale_id, [])


def _build_kot_print_payload(
    sale_id: int, branch_id: str | None, operator_name: str | None = None
) -> dict[str, Any]:
    branch_name = "Main Branch"
    branch_obj = db.session.get(Branch, branch_id) if branch_id else None
    if branch_obj:
        branch_name = branch_obj.name

    sale = db.session.get(Sale, sale_id)
    if sale is None:
        raise HTTPException(status_code=404, detail="Not Found")

    table_name = ""
    if isinstance(getattr(sale, "order_snapshot", None), dict):
        table_name = str(sale.order_snapshot.get("table_name") or "").strip()

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
        .filter(SaleItem.sale_id == sale_id)
        .all()
    )
    kot_flat_items: list[dict[str, Any]] = []
    for item in kot_items_rows:
        kot_flat_items.append(
            {
                "id": item.id,
                "sale_id": item.sale_id,
                "product_title": item.title if item.title else "Unknown",
                "variant_sku_suffix": _display_variant_suffix(item.variant_sku_suffix),
                "quantity": item.quantity,
                "modifiers": _modifiers_for_display(item.modifiers or []),
                "parent_sale_item_id": item.parent_sale_item_id,
                "is_deal": item.is_deal,
                "children": [],
            }
        )
    kot_items = _nest_sale_item_dicts(kot_flat_items).get(sale_id, [])
    return {
        "sale_id": sale_id,
        "branch_id": branch_id,
        "branch": branch_name,
        "operator": operator_name or (sale.user.username if sale.user else ""),
        "table_name": table_name,
        "order_type": getattr(sale, "order_type", None),
        "items": kot_items,
    }


@orders_router.patch("/{sale_id}/items")
def update_open_sale_items(
    sale_id: int,
    background_tasks: BackgroundTasks,
    payload: dict[str, Any] | None = None,
    current_user: User = Depends(get_current_user),
):
    """Replace line items on unpaid order; adjusts inventory and optional order metadata."""
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
    if "order_snapshot" in data or "order_type" in data:
        order_type_norm, order_snapshot_norm, order_err = normalize_order_type_and_snapshot(
            {
                "order_type": data.get("order_type") or getattr(sale, "order_type", None),
                "order_snapshot": data.get("order_snapshot"),
            }
        )
        if order_err:
            return _json_error("Bad Request", order_err, 400)
    else:
        order_type_norm = getattr(sale, "order_type", None)
        order_snapshot_norm = getattr(sale, "order_snapshot", None)

    try:
        old_flat_items: list[dict[str, Any]] = []
        for item in list(sale.items):
            old_flat_items.append(
                {
                    "id": item.id,
                    "sale_id": item.sale_id,
                    "product_title": item.product.title if item.product else "Unknown",
                    "variant_sku_suffix": _display_variant_suffix(item.variant_sku_suffix),
                    "quantity": item.quantity,
                    "modifiers": _modifiers_for_display(item.modifiers or []),
                    "parent_sale_item_id": item.parent_sale_item_id,
                    "is_deal": bool(item.product.is_deal) if item.product else False,
                    "children": [],
                }
            )
        old_nested = _nest_sale_item_dicts(old_flat_items).get(sale.id, [])

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
                return _json_error(
                    "Bad Request", f"Product ID {item['product_id']} not found", 400
                )

            ok, err, subtotal = _deduct_product_inventory_and_create_sale_items(
                product=product,
                item_dict=item,
                branch_id=sale.branch_id,
                current_user_id=current_user.id,
                sale_id=sale_id,
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
        sale.order_type = order_type_norm
        sale.order_snapshot = order_snapshot_norm
        _upsert_rider_assignment_for_sale(sale)
        _apply_order_fulfillment_defaults(sale)
        new_rows = (
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
            .filter(SaleItem.sale_id == sale.id)
            .all()
        )
        new_flat_items: list[dict[str, Any]] = []
        for row in new_rows:
            new_flat_items.append(
                {
                    "id": row.id,
                    "sale_id": row.sale_id,
                    "product_title": row.title if row.title else "Unknown",
                    "variant_sku_suffix": _display_variant_suffix(row.variant_sku_suffix),
                    "quantity": row.quantity,
                    "modifiers": _modifiers_for_display(row.modifiers or []),
                    "parent_sale_item_id": row.parent_sale_item_id,
                    "is_deal": row.is_deal,
                    "children": [],
                }
            )
        new_nested = _nest_sale_item_dicts(new_flat_items).get(sale.id, [])
        changes = _compute_order_modifications(old_nested, new_nested)
        if changes:
            now = datetime.now(timezone.utc)
            for change in changes:
                change["timestamp"] = now.isoformat()
            sale.modified_at = now
            sale.modification_snapshot = {"changes": changes, "count": len(changes), "timestamp": now.isoformat()}
        db.session.commit()
        _schedule_order_event(RealtimeEvents.ORDER_UPDATED, sale, total=float(total_amount))
        branch_name = sale.branch.name if sale.branch else "Main Branch"
        table_name = ""
        snapshot = sale.order_snapshot if isinstance(sale.order_snapshot, dict) else {}
        if isinstance(snapshot, dict):
            table_name = snapshot.get("table_name") or ""
        if changes:
            mod_payload = {
                "sale_id": sale.id,
                "branch_id": sale.branch_id,
                "branch": branch_name,
                "operator": current_user.username,
                "table_name": table_name,
                "order_type": getattr(sale, "order_type", None),
                "items": new_nested,
                "changes": changes,
            }
            background_tasks.add_task(_run_print_kot_modification_job, mod_payload)
        return {"message": "Order updated", "sale_id": sale_id, "total_amount": float(total_amount)}
    except Exception as exc:
        db.session.rollback()
        return _json_error("Bad Request", f"Update failed: {str(exc)}", 400)


@orders_router.post("/{sale_id}/finalize")
def finalize_open_sale(
    sale_id: int,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    payload: dict[str, Any] | None = None,
):
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

    setting = (
        Setting.query.filter_by(branch_id=sale.branch_id).first()
        or Setting.query.filter_by(branch_id=None).first()
    )
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
            discount_snapshot = {
                "name": discount_data.get("name") or "Discount",
                "type": d_type,
                "value": d_value,
            }
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
            payload={
                "total": float(sale.total_amount),
                "payment_method": data.get("payment_method"),
            },
        )
        db.session.commit()
        _schedule_order_event(RealtimeEvents.ORDER_UPDATED, sale, total=float(sale.total_amount))

        branch_name = "Main Branch"
        if sale.branch:
            branch_name = sale.branch.name
        receipt_items = _build_receipt_items(sale.id)
        discount_name = (
            discount_snapshot.get("name")
            if isinstance(discount_snapshot, dict)
            else "Discount"
        )
        receipt_dict = {
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
        receipt_job_id = run_print_receipt_job(receipt_dict)
        return JSONResponse(
            status_code=200,
            content={
                "message": "Payment completed",
                "sale_id": sale.id,
                "total": float(sale.total_amount),
                "print_success": True,
                "print_deferred": True,
                "print_job_id": receipt_job_id,
            },
        )
    except Exception as exc:
        db.session.rollback()
        return _json_error("Bad Request", f"Finalize failed: {str(exc)}", 400)


@orders_router.post("/{sale_id}/print-kot")
def print_sale_kot(sale_id: int, current_user: User = Depends(get_current_user)):
    sale = db.session.get(Sale, sale_id)
    if not sale:
        raise HTTPException(status_code=404, detail="Not Found")
    fb = _forbidden_unless_sale_branch(sale, current_user)
    if fb:
        return fb
    ot = (getattr(sale, "order_type", None) or "").strip().lower()
    if ot not in KITCHEN_OPEN_ORDER_TYPES:
        return _json_error(
            "Bad Request", "Order type does not support KOT printing", 400
        )
    if getattr(sale, "status", "") == "refunded":
        return _json_error("Bad Request", "Cannot print KOT for a refunded order", 400)

    job_id = run_print_kot_job(
        _build_kot_print_payload(sale_id, sale.branch_id, current_user.username)
    )
    return {
        "message": "Kitchen order ticket sent",
        "sale_id": sale_id,
        "print_success": True,
        "print_deferred": True,
        "print_job_id": job_id,
    }


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
        return _json_error(
            "Bad Request", "Only open unpaid orders can be cancelled this way", 400
        )
    try:
        if (getattr(sale, "order_type", None) or "").strip().lower() == "delivery" and getattr(sale, "assigned_rider", None):
            sale.assigned_rider.is_available = True
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
                "variant_sku_suffix": _display_variant_suffix(i.variant_sku_suffix),
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
        "delivery_status": _delivery_status_value(sale),
        "assigned_rider_id": int(sale.assigned_rider_id) if getattr(sale, "assigned_rider_id", None) else None,
        "orderStatus": "paid" if getattr(sale, "status", "completed") != "open" else "open",
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
        return _json_error(
            "Bad Request",
            "Unpaid dine-in order: cancel from Active Dine-In or void the open tab first",
            400,
        )
    if getattr(sale, "status", "completed") == "refunded":
        return _json_error("Bad Request", "Sale already refunded", 400)
    try:
        sale.status = "refunded"
        if (getattr(sale, "order_type", None) or "").strip().lower() == "delivery" and getattr(sale, "assigned_rider", None):
            sale.assigned_rider.is_available = True
            sale.assigned_rider_id = None
            sale.delivery_status = "delivered"
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
        return {
            "message": "Transaction archived",
            "archived_at": sale.archived_at.isoformat(),
        }
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
        return {
            "message": "Transaction permanently deleted.",
            "related_deleted": {"sale_items": items_count},
        }
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
        return _json_error(
            "Bad Request", "Finalize payment before printing a customer receipt", 400
        )
    discount_amount = float(getattr(sale, "discount_amount", 0) or 0)
    delivery_charge = float(getattr(sale, "delivery_charge", 0) or 0)
    service_charge = float(getattr(sale, "service_charge", 0) or 0)
    discounted_subtotal = (
        float(sale.total_amount)
        - float(sale.tax_amount)
        - delivery_charge
        - service_charge
    )
    subtotal = discounted_subtotal + discount_amount
    tax_rate = (
        (float(sale.tax_amount) / discounted_subtotal) if discounted_subtotal else 0
    )
    discount_name = (
        sale.discount_snapshot.get("name")
        if isinstance(getattr(sale, "discount_snapshot", None), dict)
        else None
    )
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
        "items": _build_receipt_items(sale.id),
        "order_type": getattr(sale, "order_type", None),
        "order_snapshot": getattr(sale, "order_snapshot", None),
    }
    job_id = run_print_receipt_job(receipt_data)
    return {
        "message": "Print job sent successfully",
        "print_success": True,
        "print_deferred": True,
        "print_job_id": job_id,
    }
