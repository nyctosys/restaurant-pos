from __future__ import annotations

import os
from datetime import datetime, timedelta
from typing import Any

import jwt
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from werkzeug.security import check_password_hash, generate_password_hash

from app.models import Branch, User, db

SECRET_KEY = os.environ.get("SECRET_KEY", "dev_secret_key_change_in_production")

auth_router = APIRouter(prefix="/api/auth", tags=["auth"])


@auth_router.get("/status")
def auth_status():
    return {"initialized": User.query.filter_by(role="owner").first() is not None}


@auth_router.post("/setup")
def auth_setup(payload: dict[str, Any] | None = None):
    if User.query.filter_by(role="owner").first():
        return JSONResponse(status_code=400, content={"error": "System is already initialized."})
    data = payload or {}
    if not all(k in data for k in ("username", "password", "branch_name")):
        return JSONResponse(status_code=400, content={"error": "Missing required fields (username, password, branch_name)"})
    try:
        branch = Branch(name=data["branch_name"], address=data.get("branch_address", ""), phone=data.get("branch_phone", ""))
        db.session.add(branch)
        db.session.flush()
        owner = User(
            branch_id=branch.id,
            username=data["username"],
            password_hash=generate_password_hash(data["password"]),
            role="owner",
        )
        db.session.add(owner)
        db.session.commit()
        token = jwt.encode(
            {
                "user_id": owner.id,
                "role": owner.role,
                "branch_id": branch.id,
                "exp": datetime.utcnow() + timedelta(days=30),
            },
            SECRET_KEY,
            algorithm="HS256",
        )
        return JSONResponse(
            status_code=201,
            content={
                "message": "System initialized successfully.",
                "token": token,
                "user": {
                    "id": owner.id,
                    "username": owner.username,
                    "role": owner.role,
                    "branch_id": owner.branch_id,
                    "branch_name": branch.name,
                },
            },
        )
    except Exception as exc:
        db.session.rollback()
        return JSONResponse(status_code=500, content={"error": str(exc)})


@auth_router.post("/login")
def auth_login(payload: dict[str, Any] | None = None):
    data = payload or {}
    if not data.get("username") or not data.get("password"):
        return JSONResponse(status_code=400, content={"message": "Missing credentials"})
    user = User.query.filter_by(username=data["username"]).first()
    if not user or not check_password_hash(user.password_hash, data["password"]):
        return JSONResponse(status_code=401, content={"message": "Invalid credentials"})
    if getattr(user, "archived_at", None):
        return JSONResponse(status_code=403, content={"message": "Account is archived"})
    token = jwt.encode(
        {
            "user_id": user.id,
            "role": user.role,
            "branch_id": user.branch_id,
            "exp": datetime.utcnow() + timedelta(days=30),
        },
        SECRET_KEY,
        algorithm="HS256",
    )
    return {
        "token": token,
        "user": {
            "id": user.id,
            "username": user.username,
            "role": user.role,
            "branch_id": user.branch_id,
            "branch_name": user.branch.name if user.branch else "",
        },
    }


@auth_router.get("/branches")
def auth_branches():
    branches = Branch.query.all()
    return {"branches": [{"id": b.id, "name": b.name, "address": b.address, "phone": b.phone} for b in branches]}
