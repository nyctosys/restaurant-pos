from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from app.errors import error_response
from app.models import Modifier, User, db
from app_fastapi.deps import get_current_user, require_owner


modifiers_router = APIRouter(prefix="/api/modifiers", tags=["modifiers"])


def _modifier_dict(m: Modifier) -> dict[str, Any]:
    return {
        "id": m.id,
        "name": m.name,
        "price": float(m.price) if m.price is not None else None,
        "ingredient_id": m.ingredient_id,
        "depletion_quantity": float(m.depletion_quantity) if m.depletion_quantity is not None else None,
    }


@modifiers_router.get("/")
def list_modifiers(current_user: User = Depends(get_current_user)):
    # Available to all logged-in roles because POS needs to attach them at checkout.
    mods = Modifier.query.filter(Modifier.archived_at == None).order_by(Modifier.name.asc()).all()  # noqa: E711
    return {"modifiers": [_modifier_dict(m) for m in mods]}


@modifiers_router.post("/")
def create_modifier(payload: dict[str, Any] | None = None, _: User = Depends(require_owner)):
    data = payload or {}
    name = (data.get("name") or "").strip()
    if not name:
        return error_response("Bad Request", "name is required", 400)
    price_raw = data.get("price")
    price = None
    if price_raw is not None and price_raw != "":
        try:
            price = float(price_raw)
        except Exception:
            return error_response("Bad Request", "price must be a number", 400)
        if price < 0:
            return error_response("Bad Request", "price must be >= 0", 400)
    ing_id = data.get("ingredient_id")
    dep_q = data.get("depletion_quantity")
    dep_val = None
    if dep_q is not None and dep_q != "":
        try:
            dep_val = float(dep_q)
        except (TypeError, ValueError):
            return error_response("Bad Request", "depletion_quantity must be a number", 400)
        if dep_val < 0:
            return error_response("Bad Request", "depletion_quantity must be >= 0", 400)
    ing_fk = None
    if ing_id is not None and ing_id != "":
        try:
            ing_fk = int(ing_id)
        except (TypeError, ValueError):
            return error_response("Bad Request", "ingredient_id must be an integer", 400)
    try:
        m = Modifier(name=name, price=price, ingredient_id=ing_fk, depletion_quantity=dep_val)
        db.session.add(m)
        db.session.commit()
        return JSONResponse(status_code=201, content={"modifier": _modifier_dict(m)})
    except Exception as exc:
        db.session.rollback()
        # Most common: unique constraint
        return error_response("Bad Request", str(exc), 400)


@modifiers_router.patch("/{modifier_id}")
def update_modifier(modifier_id: int, payload: dict[str, Any] | None = None, _: User = Depends(require_owner)):
    m = Modifier.query.get(modifier_id)
    if not m or m.archived_at is not None:
        return error_response("Not Found", "Modifier not found", 404)
    data = payload or {}
    if "name" in data:
        name = (data.get("name") or "").strip()
        if not name:
            return error_response("Bad Request", "name cannot be empty", 400)
        m.name = name
    if "price" in data:
        price_raw = data.get("price")
        if price_raw is None or price_raw == "":
            m.price = None
        else:
            try:
                price = float(price_raw)
            except Exception:
                return error_response("Bad Request", "price must be a number", 400)
            if price < 0:
                return error_response("Bad Request", "price must be >= 0", 400)
            m.price = price
    if "ingredient_id" in data:
        raw_ing = data.get("ingredient_id")
        if raw_ing is None or raw_ing == "":
            m.ingredient_id = None
        else:
            try:
                m.ingredient_id = int(raw_ing)
            except (TypeError, ValueError):
                return error_response("Bad Request", "ingredient_id must be an integer", 400)
    if "depletion_quantity" in data:
        dq = data.get("depletion_quantity")
        if dq is None or dq == "":
            m.depletion_quantity = None
        else:
            try:
                m.depletion_quantity = float(dq)
            except (TypeError, ValueError):
                return error_response("Bad Request", "depletion_quantity must be a number", 400)
            if m.depletion_quantity is not None and m.depletion_quantity < 0:
                return error_response("Bad Request", "depletion_quantity must be >= 0", 400)
    try:
        db.session.commit()
        return {"modifier": _modifier_dict(m)}
    except Exception as exc:
        db.session.rollback()
        return error_response("Bad Request", str(exc), 400)


@modifiers_router.delete("/{modifier_id}")
def delete_modifier(modifier_id: int, _: User = Depends(require_owner)):
    m = Modifier.query.get(modifier_id)
    if not m or m.archived_at is not None:
        return error_response("Not Found", "Modifier not found", 404)
    from datetime import datetime

    try:
        m.archived_at = datetime.utcnow()
        db.session.commit()
        return {"message": "Modifier deleted"}
    except Exception as exc:
        db.session.rollback()
        return error_response("Internal Server Error", str(exc), 500)

