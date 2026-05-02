"""Convert quantities between compatible units; align with frontend `unitSystem` / `unitConversion`."""

from __future__ import annotations

from app.models import Ingredient, UnitOfMeasure
from app.services.units import normalize_unit_token, to_base_unit
from typing import Any


def _unit_value(unit: UnitOfMeasure | str) -> str:
    if hasattr(unit, "value"):
        return normalize_unit_token(str(unit.value))
    return normalize_unit_token(str(unit or ""))


def _is_mass(u: str) -> bool:
    return u in ("kg", "g")


def _is_volume(u: str) -> bool:
    return u in ("l", "ml")


def _to_grams(quantity: float, from_unit: str) -> float:
    u = from_unit.lower().strip()
    if u == "g":
        return float(quantity)
    if u == "kg":
        return float(quantity) * 1000.0
    return float(quantity)


def _grams_to_unit(grams: float, to_unit: str) -> float:
    u = to_unit.lower().strip()
    if u == "g":
        return grams
    if u == "kg":
        return grams / 1000.0
    return grams


def _to_milliliters(quantity: float, from_unit: str) -> float:
    u = from_unit.lower().strip()
    if u == "ml":
        return float(quantity)
    if u == "l":
        return float(quantity) * 1000.0
    return float(quantity)


def _ml_to_unit(ml: float, to_unit: str) -> float:
    u = to_unit.lower().strip()
    if u == "ml":
        return ml
    if u == "l":
        return ml / 1000.0
    return ml


def convert_quantity_to_unit(
    quantity: float,
    from_unit: UnitOfMeasure | str,
    to_unit: UnitOfMeasure | str,
) -> float:
    """Convert `quantity` expressed in `from_unit` into `to_unit` when compatible."""
    fr = _unit_value(from_unit)
    to = _unit_value(to_unit)
    if fr == to:
        return float(quantity)

    if _is_mass(fr) and _is_mass(to):
        g = _to_grams(float(quantity), fr)
        return _grams_to_unit(g, to)

    if _is_volume(fr) and _is_volume(to):
        ml_amt = _to_milliliters(float(quantity), fr)
        return _ml_to_unit(ml_amt, to)

    raise ValueError(f"Incompatible units for conversion: {fr!r} → {to!r}")


def normalize_po_line_to_ingredient_base(
    ingredient: Ingredient,
    quantity_ordered: float,
    line_unit: UnitOfMeasure | str,
    unit_price: float,
    packaging_units_per_one: float | None = None,
) -> tuple[float, float, UnitOfMeasure]:
    """
    PO lines store quantity and unit_price in the ingredient's base unit (same as stock).
    Preserves line total: quantity * price per input = qty_base * price_base.
    Supports carton/packet via ingredient.unit_conversions (+ legacy purchase_unit).
    Optional packaging_units_per_one overrides base units per 1 carton/packet for this line only.
    """
    line_u = normalize_unit_token(str(line_unit))
    ing_for_conv: Any = ingredient
    if (
        packaging_units_per_one is not None
        and float(packaging_units_per_one) > 0
        and line_u in ("carton", "packet")
    ):
        raw_json = getattr(ingredient, "unit_conversions", None) or {}
        ing_for_conv = {
            "unit": ingredient.unit.value if hasattr(ingredient.unit, "value") else ingredient.unit,
            "unit_conversions": {**dict(raw_json), line_u: float(packaging_units_per_one)},
        }
    try:
        qty_base = to_base_unit(float(quantity_ordered), str(line_unit), ing_for_conv)
    except ValueError as exc:
        raise ValueError(str(exc)) from exc
    if qty_base <= 0:
        raise ValueError("Quantity must be positive after unit conversion")

    line_total = float(quantity_ordered) * float(unit_price)
    price_base = line_total / qty_base

    return qty_base, price_base, ingredient.unit

