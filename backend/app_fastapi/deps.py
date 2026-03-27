from __future__ import annotations

import os

import jwt
from fastapi import Depends, Header, HTTPException, status

from app.models import User

SECRET_KEY = os.environ.get("SECRET_KEY", "dev_secret_key_change_in_production")


def _extract_bearer(authorization: str | None) -> str | None:
    if not authorization:
        return None
    parts = authorization.split()
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1]
    return None


def get_current_user(authorization: str | None = Header(default=None)) -> User:
    token = _extract_bearer(authorization)
    if not token:
        raise HTTPException(status_code=401, detail={"message": "Token is missing!"})
    try:
        data = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
        user = User.query.get(data["user_id"])
        if not user:
            raise HTTPException(status_code=401, detail={"message": "User not found!"})
        return user
    except jwt.ExpiredSignatureError as exc:
        raise HTTPException(
            status_code=401,
            detail={"message": "Session expired. Please log in again.", "code": "token_expired"},
        ) from exc
    except jwt.InvalidTokenError as exc:
        raise HTTPException(
            status_code=401,
            detail={"message": "Invalid session. Please log in again.", "code": "token_invalid"},
        ) from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=401, detail={"message": "Invalid session. Please log in again."}) from exc


def require_owner(current_user: User = Depends(get_current_user)) -> User:
    if current_user.role != "owner":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail={"message": "Owner privileges required!"})
    return current_user
