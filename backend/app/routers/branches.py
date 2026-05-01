from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse

from app.models import Branch, Ingredient, IngredientBranchStock, Inventory, Sale, Setting, User, db
from app.deps import get_current_user, require_owner, require_owner_or_manager
from app.routers.common import yes

branches_router = APIRouter(prefix="/api/branches", tags=["branches"])


def _assert_branch_access(branch_id: str, user: User) -> None:
    if user.role == "owner":
        return
    if user.role == "manager" and user.branch_id == branch_id:
        return
    raise HTTPException(status_code=403, detail={"message": "Not allowed for this branch"})


def _branch_to_dict(b: Branch) -> dict[str, Any]:
    d = {
        "id": b.id,
        "name": b.name,
        "address": b.address or "",
        "phone": b.phone or "",
        "user_count": len(b.users),
        "created_at": b.created_at.isoformat() if b.created_at else None,
    }
    if hasattr(b, "archived_at") and b.archived_at:
        d["archived_at"] = b.archived_at.isoformat()
    return d


@branches_router.get("/")
def get_branches(include_archived: str | None = None, current_user: User = Depends(get_current_user)):
    if current_user.branch_id:
        branch = db.session.get(Branch, current_user.branch_id)
        if branch and (yes(include_archived) or not getattr(branch, "archived_at", None)):
            return [_branch_to_dict(branch)]
        return []
    query = Branch.query.order_by(Branch.created_at.asc())
    if not yes(include_archived) and hasattr(Branch, "archived_at"):
        query = query.filter(Branch.archived_at == None)  # noqa: E711
    return [_branch_to_dict(b) for b in query.all()]


@branches_router.post("/")
def create_branch(payload: dict[str, Any] | None = None, _: User = Depends(require_owner)):
    data = payload or {}
    if not data.get("name", "").strip():
        return JSONResponse(status_code=400, content={"message": "Branch name is required"})
    existing = Branch.query.filter(db.func.lower(Branch.name) == data["name"].strip().lower()).first()
    if existing:
        return JSONResponse(status_code=409, content={"message": "A branch with that name already exists"})
    try:
        branch = Branch(name=data["name"].strip(), address=data.get("address", "").strip(), phone=data.get("phone", "").strip())
        db.session.add(branch)
        db.session.flush()
        for ing in Ingredient.query.filter(Ingredient.is_active == True).all():  # noqa: E712
            if not IngredientBranchStock.query.filter_by(ingredient_id=ing.id, branch_id=branch.id).first():
                db.session.add(
                    IngredientBranchStock(ingredient_id=ing.id, branch_id=branch.id, current_stock=0.0)
                )
        db.session.commit()
        return JSONResponse(
            status_code=201,
            content={
                "id": branch.id,
                "name": branch.name,
                "address": branch.address,
                "phone": branch.phone,
                "user_count": 0,
                "message": "Branch created successfully",
            },
        )
    except Exception as exc:
        db.session.rollback()
        return JSONResponse(status_code=500, content={"message": f"Error creating branch: {str(exc)}"})


@branches_router.put("/{branch_id}")
def update_branch(branch_id: str, payload: dict[str, Any] | None = None, current_user: User = Depends(require_owner_or_manager)):
    _assert_branch_access(branch_id, current_user)
    branch = db.session.get(Branch, branch_id)
    if not branch:
        return JSONResponse(status_code=404, content={"message": "Branch not found"})
    data = payload or {}
    if not data:
        return JSONResponse(status_code=400, content={"message": "No data provided"})
    name = data.get("name", "").strip()
    if not name:
        return JSONResponse(status_code=400, content={"message": "Branch name is required"})
    existing = Branch.query.filter(db.func.lower(Branch.name) == name.lower(), Branch.id != branch_id).first()
    if existing:
        return JSONResponse(status_code=409, content={"message": "A branch with that name already exists"})
    try:
        branch.name = name
        branch.address = data.get("address", branch.address or "").strip()
        branch.phone = data.get("phone", branch.phone or "").strip()
        db.session.commit()
        return {
            "id": branch.id,
            "name": branch.name,
            "address": branch.address,
            "phone": branch.phone,
            "message": "Branch updated successfully",
        }
    except Exception as exc:
        db.session.rollback()
        return JSONResponse(status_code=500, content={"message": f"Error updating branch: {str(exc)}"})


@branches_router.patch("/{branch_id}/archive")
def archive_branch(branch_id: str, _: User = Depends(require_owner)):
    branch = db.session.get(Branch, branch_id)
    if not branch:
        raise HTTPException(status_code=404, detail="Not Found")
    if not hasattr(branch, "archived_at"):
        return JSONResponse(status_code=400, content={"message": "Archive not supported"})
    try:
        branch.archived_at = datetime.now(timezone.utc)
        db.session.commit()
        return {"message": "Branch archived", "archived_at": branch.archived_at.isoformat()}
    except Exception as exc:
        db.session.rollback()
        return JSONResponse(status_code=500, content={"message": str(exc)})


@branches_router.patch("/{branch_id}/unarchive")
def unarchive_branch(branch_id: str, _: User = Depends(require_owner)):
    branch = db.session.get(Branch, branch_id)
    if not branch:
        raise HTTPException(status_code=404, detail="Not Found")
    if not hasattr(branch, "archived_at"):
        return JSONResponse(status_code=400, content={"message": "Unarchive not supported"})
    try:
        branch.archived_at = None
        db.session.commit()
        return {"message": "Branch restored"}
    except Exception as exc:
        db.session.rollback()
        return JSONResponse(status_code=500, content={"message": str(exc)})


@branches_router.delete("/{branch_id}")
def delete_branch(branch_id: str, cascade: str | None = None, _: User = Depends(require_owner)):
    branch = db.session.get(Branch, branch_id)
    if not branch:
        return JSONResponse(status_code=404, content={"message": "Branch not found"})
    if yes(cascade):
        try:
            users_count = len(branch.users)
            inv_count = Inventory.query.filter_by(branch_id=branch_id).count()
            ibs_count = IngredientBranchStock.query.filter_by(branch_id=branch_id).count()
            sales_count = Sale.query.filter_by(branch_id=branch_id).count()
            setting = Setting.query.filter_by(branch_id=branch_id).first()
            for u in branch.users:
                u.branch_id = None
            Inventory.query.filter_by(branch_id=branch_id).delete()
            IngredientBranchStock.query.filter_by(branch_id=branch_id).delete()
            for sale in Sale.query.filter_by(branch_id=branch_id).all():
                db.session.delete(sale)
            if setting:
                db.session.delete(setting)
            db.session.delete(branch)
            db.session.commit()
            return {
                "message": "Branch permanently deleted.",
                "related_deleted": {
                    "users_reassigned": users_count,
                    "inventory_rows": inv_count,
                    "ingredient_branch_stock_rows": ibs_count,
                    "sales": sales_count,
                    "settings": 1 if setting else 0,
                },
            }
        except Exception as exc:
            db.session.rollback()
            return JSONResponse(status_code=500, content={"message": f"Error deleting branch: {str(exc)}"})
    if len(branch.users) > 0:
        return JSONResponse(
            status_code=409,
            content={
                "message": f'Cannot delete branch "{branch.name}" — it has {len(branch.users)} user(s). Reassign them or use permanent delete with cascade.'
            },
        )
    legacy_inv = len(branch.inventory) > 0
    has_ingredient_stock = IngredientBranchStock.query.filter_by(branch_id=branch_id).count() > 0
    if legacy_inv or has_ingredient_stock:
        return JSONResponse(
            status_code=409,
            content={
                "message": f'Cannot delete branch "{branch.name}" — it has stock records. Use permanent delete with cascade to remove everything.'
            },
        )
    try:
        setting = Setting.query.filter_by(branch_id=branch_id).first()
        if setting:
            db.session.delete(setting)
        db.session.delete(branch)
        db.session.commit()
        return {"message": "Branch deleted successfully"}
    except Exception as exc:
        db.session.rollback()
        return JSONResponse(status_code=500, content={"message": str(exc)})


@branches_router.get("/{branch_id}/users")
def get_branch_users(branch_id: str, current_user: User = Depends(require_owner_or_manager)):
    _assert_branch_access(branch_id, current_user)
    branch = db.session.get(Branch, branch_id)
    if not branch:
        return JSONResponse(status_code=404, content={"message": "Branch not found"})
    users = User.query.filter_by(branch_id=branch_id).order_by(User.created_at.asc()).all()
    return [{"id": u.id, "username": u.username, "role": u.role, "created_at": u.created_at.isoformat() if u.created_at else None} for u in users]
