from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from werkzeug.security import generate_password_hash

from app.models import Sale, User, db
from app.deps import get_current_user, require_owner
from app.routers.common import yes

users_router = APIRouter(prefix="/api/users", tags=["users"])


def _user_to_dict(u: User) -> dict[str, Any]:
    d = {
        "id": u.id,
        "username": u.username,
        "role": u.role,
        "branch_id": u.branch_id,
        "branch_name": u.branch.name if u.branch else "Global",
        "created_at": u.created_at.isoformat() if u.created_at else None,
    }
    if hasattr(u, "archived_at") and u.archived_at:
        d["archived_at"] = u.archived_at.isoformat()
    return d


@users_router.get("/")
def get_users(include_archived: str | None = None, _: User = Depends(require_owner)):
    query = User.query
    if not yes(include_archived) and hasattr(User, "archived_at"):
        query = query.filter(User.archived_at == None)  # noqa: E711
    return [_user_to_dict(u) for u in query.all()]


@users_router.post("/")
def create_user(payload: dict[str, Any] | None = None, current_user: User = Depends(require_owner)):
    data = payload or {}
    if not all(k in data for k in ("username", "password", "role")):
        return JSONResponse(status_code=400, content={"message": "Missing required fields (username, password, role)"})
    if User.query.filter_by(username=data["username"]).first():
        return JSONResponse(status_code=400, content={"message": "Username already exists."})
    try:
        new_user = User(
            branch_id=data.get("branch_id", current_user.branch_id),
            username=data["username"],
            password_hash=generate_password_hash(data["password"]),
            role=data["role"],
        )
        db.session.add(new_user)
        db.session.commit()
        return JSONResponse(
            status_code=201,
            content={
                "message": "User created successfully",
                "user": {"id": new_user.id, "username": new_user.username, "role": new_user.role, "branch_id": new_user.branch_id},
            },
        )
    except Exception as exc:
        db.session.rollback()
        return JSONResponse(status_code=500, content={"message": "Error creating user", "error": str(exc)})


@users_router.put("/{user_id}")
def update_user(user_id: int, payload: dict[str, Any] | None = None, _: User = Depends(require_owner)):
    data = payload or {}
    if not data:
        return JSONResponse(status_code=400, content={"message": "No data provided"})
    user = db.session.get(User, user_id)
    if not user:
        return JSONResponse(status_code=404, content={"message": "User not found"})
    try:
        if "role" in data and data["role"] != "owner" and user.role == "owner":
            owner_count = User.query.filter_by(branch_id=user.branch_id, role="owner").count()
            if owner_count <= 1:
                return JSONResponse(status_code=400, content={"message": "Cannot demote the last owner of the branch."})
        if "username" in data and data["username"] != user.username:
            if User.query.filter_by(username=data["username"]).first():
                return JSONResponse(status_code=400, content={"message": "Username already exists."})
            user.username = data["username"]
        if data.get("password"):
            user.password_hash = generate_password_hash(data["password"])
        if "role" in data:
            user.role = data["role"]
        if "branch_id" in data:
            user.branch_id = data["branch_id"]
        db.session.commit()
        return {"message": "User updated successfully"}
    except Exception as exc:
        db.session.rollback()
        return JSONResponse(status_code=500, content={"message": "Error updating user", "error": str(exc)})


@users_router.patch("/{user_id}/archive")
def archive_user(user_id: int, current_user: User = Depends(require_owner)):
    user = db.session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="Not Found")
    if user.id == current_user.id:
        return JSONResponse(status_code=400, content={"message": "Cannot archive yourself."})
    if not hasattr(user, "archived_at"):
        return JSONResponse(status_code=400, content={"message": "Archive not supported"})
    try:
        user.archived_at = datetime.now(timezone.utc)
        db.session.commit()
        return {"message": "User archived", "archived_at": user.archived_at.isoformat()}
    except Exception as exc:
        db.session.rollback()
        return JSONResponse(status_code=500, content={"message": str(exc)})


@users_router.patch("/{user_id}/unarchive")
def unarchive_user(user_id: int, _: User = Depends(require_owner)):
    user = db.session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="Not Found")
    if not hasattr(user, "archived_at"):
        return JSONResponse(status_code=400, content={"message": "Unarchive not supported"})
    try:
        user.archived_at = None
        db.session.commit()
        return {"message": "User restored"}
    except Exception as exc:
        db.session.rollback()
        return JSONResponse(status_code=500, content={"message": str(exc)})


@users_router.delete("/{user_id}")
def delete_user(user_id: int, current_user: User = Depends(require_owner)):
    user = db.session.get(User, user_id)
    if not user:
        return JSONResponse(status_code=404, content={"message": "User not found"})
    if user.id == current_user.id:
        return JSONResponse(status_code=400, content={"message": "Cannot delete yourself."})
    if user.role == "owner":
        owner_count = User.query.filter_by(branch_id=user.branch_id, role="owner").count()
        if owner_count <= 1:
            return JSONResponse(status_code=400, content={"message": "Cannot delete the last owner of the branch."})
    sales_count = Sale.query.filter_by(user_id=user_id).count()
    if sales_count > 0:
        return JSONResponse(
            status_code=409,
            content={"message": f"Cannot delete user — they have {sales_count} transaction(s). Archive the user instead."},
        )
    try:
        db.session.delete(user)
        db.session.commit()
        return {"message": "User permanently deleted."}
    except Exception as exc:
        db.session.rollback()
        return JSONResponse(status_code=500, content={"message": "Error deleting user", "error": str(exc)})
