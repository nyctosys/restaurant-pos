"""
Central unit system for inventory: categories, base units, static + dynamic (carton/packet) conversions.
Align with frontend `unitSystem.ts`.
"""

from __future__ import annotations

from typing import Any, Literal

import math

from app.models import Ingredient, UnitOfMeasure

UnitCategory = Literal["weight", "volume", "count", "packaging"]

# Logical groups (display / validation)
UNIT_TYPES: dict[str, tuple[str, ...]] = {
    "WEIGHT": ("kg", "g"),
    "VOLUME": ("ltr", "ml"),
    "COUNT": ("pcs",),
    "PACKAGING": ("carton", "packet"),
}

BASE_UNITS: dict[str, str] = {
    "WEIGHT": "kg",
    "VOLUME": "ltr",
    "COUNT": "pcs",
    "PACKAGING": "pcs",
}

# Canonical DB enum / storage tokens (SQLAlchemy UnitOfMeasure values)
_CANONICAL = {
    "ltr": "l",
    "l": "l",
    "liter": "l",
    "litre": "l",
    "kg": "kg",
    "g": "g",
    "ml": "ml",
    "pcs": "piece",
    "pc": "piece",
    "piece": "piece",
    "carton": "carton",
    "packet": "packet",
}


def normalize_unit_token(raw: str | None) -> str:
    """Lowercase alias → canonical engine token (ltr→l, pcs→piece). Packaging unchanged."""
    if raw is None:
        return ""
    s = str(raw).strip().lower()
    if not s:
        return ""
    return _CANONICAL.get(s, s)


def category_for_canonical_unit(canonical: str) -> UnitCategory | None:
    u = normalize_unit_token(canonical)
    if u in ("kg", "g"):
        return "weight"
    if u in ("l", "ml"):
        return "volume"
    if u == "piece":
        return "count"
    if u in ("carton", "packet"):
        return "packaging"
    return None


def ingredient_storage_category(ingredient: Ingredient | dict[str, Any]) -> UnitCategory | None:
    raw = ingredient.unit if hasattr(ingredient, "unit") else ingredient.get("unit")
    if raw is None:
        return None
    v = raw.value if hasattr(raw, "value") else raw
    return category_for_canonical_unit(str(v))


def effective_packaging_conversions(ingredient: Ingredient | dict[str, Any]) -> dict[str, float]:
    """Base-quantity per 1 carton or 1 packet. Merges JSON + legacy purchase_unit/conversion_factor."""
    conv: dict[str, float] = {}
    if isinstance(ingredient, dict):
        raw_json = ingredient.get("unit_conversions")
        pu = (ingredient.get("purchase_unit") or "").strip().lower()
        try:
            cf = float(ingredient.get("conversion_factor") or 1.0)
        except (TypeError, ValueError):
            cf = 1.0
    else:
        raw_json = getattr(ingredient, "unit_conversions", None)
        pu = (getattr(ingredient, "purchase_unit", None) or "").strip().lower()
        try:
            cf = float(getattr(ingredient, "conversion_factor", None) or 1.0)
        except (TypeError, ValueError):
            cf = 1.0
    if isinstance(raw_json, dict):
        for key, val in raw_json.items():
            k = str(key).strip().lower()
            try:
                fv = float(val)
            except (TypeError, ValueError):
                continue
            if fv > 0 and k in ("carton", "packet"):
                conv[k] = fv
    if pu in ("carton", "packet") and cf > 0 and pu not in conv:
        conv[pu] = cf
    return conv


def _base_unit_str(ingredient: Ingredient | dict[str, Any]) -> str:
    raw = ingredient.unit if hasattr(ingredient, "unit") else ingredient.get("unit")
    if raw is None:
        return ""
    return str(raw.value if hasattr(raw, "value") else raw).strip().lower()


def categories_compatible(a: str, b: str) -> bool:
    ca = category_for_canonical_unit(a)
    cb = category_for_canonical_unit(b)
    if ca is None or cb is None:
        return False
    if ca == cb:
        return True
    # packaging converts into ingredient base category (same stock category)
    if ca == "packaging" or cb == "packaging":
        return False
    return False


def _grams(qty: float, u: str) -> float:
    if u == "g":
        return float(qty)
    if u == "kg":
        return float(qty) * 1000.0
    raise ValueError(u)


def _grams_to_unit(grams: float, u: str) -> float:
    if u == "g":
        return grams
    if u == "kg":
        return grams / 1000.0
    raise ValueError(u)


def _ml_amt(qty: float, u: str) -> float:
    if u == "ml":
        return float(qty)
    if u == "l":
        return float(qty) * 1000.0
    raise ValueError(u)


def _ml_to_unit(ml_q: float, u: str) -> float:
    if u == "ml":
        return ml_q
    if u == "l":
        return ml_q / 1000.0
    raise ValueError(u)


def to_base_unit(
    value: float,
    unit: str,
    ingredient: Ingredient | dict[str, Any],
) -> float:
    """
    Convert a quantity expressed in `unit` into the ingredient's storage/base unit.
    Raises ValueError if incompatible or missing dynamic conversion for carton/packet.
    """
    if not math.isfinite(float(value)):
        raise ValueError("Quantity must be a finite number")
    from_u = normalize_unit_token(unit)
    base_u = normalize_unit_token(_base_unit_str(ingredient))
    if not base_u:
        raise ValueError("Ingredient has no base unit")

    if from_u == base_u:
        return float(value)

    from_cat = category_for_canonical_unit(from_u)
    base_cat = category_for_canonical_unit(base_u)

    # Packaging → base (dynamic)
    if from_u in ("carton", "packet"):
        conv = effective_packaging_conversions(ingredient)
        per_one = conv.get(from_u)
        if per_one is None or per_one <= 0:
            raise ValueError(
                f"Missing positive unit_conversions['{from_u}'] for this ingredient (base unit {base_u})"
            )
        return float(value) * float(per_one)

    # Weight family
    if from_cat == "weight" and base_cat == "weight":
        g = _grams(float(value), from_u)
        return _grams_to_unit(g, base_u)

    # Volume family
    if from_cat == "volume" and base_cat == "volume":
        ml_q = _ml_amt(float(value), from_u)
        return _ml_to_unit(ml_q, base_u)

    # Count
    if from_cat == "count" and base_cat == "count":
        return float(value)

    raise ValueError(f"Cannot convert {from_u!r} to ingredient base {base_u!r} (invalid category mix)")


def sql_unit_enum_value(unit_str: str) -> Any:
    """Map canonical storage string to UnitOfMeasure enum member."""
    u = normalize_unit_token(unit_str)
    if u == "l":
        return UnitOfMeasure.L
    if u == "ml":
        return UnitOfMeasure.ML
    if u == "kg":
        return UnitOfMeasure.KG
    if u == "g":
        return UnitOfMeasure.G
    if u == "piece":
        return UnitOfMeasure.PIECE
    raise ValueError(f"Unsupported storage unit for enum: {unit_str!r}")


def allowed_input_units_for_ingredient(ingredient: Ingredient | dict[str, Any]) -> list[str]:
    """Units shown in dropdowns for this ingredient (labels use canonical tokens)."""
    base = _base_unit_str(ingredient)
    cat = category_for_canonical_unit(base)
    conv = effective_packaging_conversions(ingredient)
    out: list[str] = []
    if cat == "weight":
        out.extend(["kg", "g"])
    elif cat == "volume":
        out.extend(["ltr", "ml"])
    elif cat == "count":
        out.extend(["pcs"])
    else:
        out.append(base or "pcs")

    for key in ("carton", "packet"):
        if key in conv and conv[key] and conv[key] > 0:
            out.append(key)
    return out
