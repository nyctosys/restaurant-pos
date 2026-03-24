"""Validate and normalize order_type / order_snapshot for checkout (POS)."""
from __future__ import annotations

from typing import Any

ORDER_TYPES = frozenset({"takeaway", "dine_in", "delivery"})
MAX_FIELD = 255
MAX_PHONE = 64


def normalize_order_type_and_snapshot(data: dict[str, Any]) -> tuple[str | None, dict[str, Any] | None, str | None]:
    """
    Returns (order_type, order_snapshot, error_message).
    error_message is set when validation fails.
    order_snapshot is None for takeaway (nothing to persist).
    """
    raw = (data.get("order_type") or "").strip().lower() or "takeaway"
    if raw not in ORDER_TYPES:
        return None, None, f"Invalid order_type: must be one of {', '.join(sorted(ORDER_TYPES))}"

    snap_raw = data.get("order_snapshot")
    if snap_raw is not None and not isinstance(snap_raw, dict):
        return None, None, "order_snapshot must be an object"

    snap_in: dict[str, Any] = dict(snap_raw) if isinstance(snap_raw, dict) else {}

    if raw == "dine_in":
        table = (snap_in.get("table_name") or "").strip()
        if not table:
            return None, None, "Dine-in orders require order_snapshot.table_name"
        if len(table) > MAX_FIELD:
            return None, None, "Table name is too long"
        return raw, {"table_name": table}, None

    if raw == "delivery":
        name = (snap_in.get("customer_name") or "").strip()
        phone = (snap_in.get("phone") or "").strip()
        address = (snap_in.get("address") or "").strip()
        if not name or not phone or not address:
            return None, None, "Delivery orders require customer_name, phone, and address"
        if len(name) > MAX_FIELD or len(address) > MAX_FIELD:
            return None, None, "Name or address is too long"
        if len(phone) > MAX_PHONE:
            return None, None, "Phone number is too long"
        return raw, {"customer_name": name, "phone": phone, "address": address}, None

    # takeaway
    return raw, None, None
