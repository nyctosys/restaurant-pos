"""Validate and normalize order_type / order_snapshot for checkout (POS)."""
from __future__ import annotations

from typing import Any

ORDER_TYPES = frozenset({"takeaway", "dine_in", "delivery"})
MAX_FIELD = 255
MAX_PHONE = 64
MAX_LANDMARK = 255


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
        landmark = (snap_in.get("nearest_landmark") or "").strip()
        rider_name = (snap_in.get("rider_name") or "").strip()
        if not name or not phone or (not address and not landmark):
            return None, None, "Delivery orders require customer_name, phone, and address or nearest_landmark"
        if (
            len(name) > MAX_FIELD
            or len(address) > MAX_FIELD
            or len(landmark) > MAX_LANDMARK
            or len(rider_name) > MAX_FIELD
        ):
            return None, None, "Name, address, nearest_landmark, or rider_name is too long"
        if len(phone) > MAX_PHONE:
            return None, None, "Phone number is too long"
        out: dict[str, Any] = {"customer_name": name, "phone": phone}
        if address:
            out["address"] = address
        if landmark:
            out["nearest_landmark"] = landmark
        if rider_name:
            out["rider_name"] = rider_name
        distance_km = snap_in.get("distance_km")
        if distance_km is not None:
            try:
                out["distance_km"] = round(max(0.0, float(distance_km)), 2)
            except (TypeError, ValueError):
                pass
        distance_source = str(snap_in.get("distance_source") or "").strip()
        if distance_source:
            out["distance_source"] = distance_source[:64]
        return raw, out, None

    # takeaway
    return raw, None, None
