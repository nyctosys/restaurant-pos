from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse

from app.models import Setting, User, db
from app.services.branch_scope import resolve_terminal_branch_id
from app.services.sync_outbox import enqueue_sync_event
from app.deps import get_current_user
from app.routers.common import yes

settings_router = APIRouter(prefix="/api/settings", tags=["settings"])


def _merge_configs(global_config: dict[str, Any], branch_config: dict[str, Any]) -> dict[str, Any]:
    if not global_config:
        return branch_config or {}
    if not branch_config:
        return global_config
    return {**global_config, **branch_config}


@settings_router.get("/")
def get_settings(
    global_only: str | None = None,
    branch_id: int | None = None,
    current_user: User = Depends(get_current_user),
):
    if yes(global_only):
        if current_user.role != "owner":
            raise HTTPException(status_code=403, detail={"message": "Global settings require owner access"})
        setting = Setting.query.filter_by(branch_id=None).first()
        return {"config": setting.config if setting else {}}
    # Terminal branch only (ignore client branch_id switching)
    _ = branch_id  # unused
    resolved_branch_id = resolve_terminal_branch_id(current_user)
    global_setting = Setting.query.filter_by(branch_id=None).first()
    global_config = global_setting.config if global_setting else {}
    branch_config: dict[str, Any] = {}
    if resolved_branch_id:
        bs = Setting.query.filter_by(branch_id=resolved_branch_id).first()
        if bs:
            branch_config = bs.config or {}
    return {"config": _merge_configs(global_config, branch_config)}


@settings_router.post("/")
@settings_router.put("/")
def update_settings(payload: dict[str, Any] | None = None, current_user: User = Depends(get_current_user)):
    if current_user.role not in ("owner", "manager"):
        raise HTTPException(status_code=403, detail={"message": "Not allowed"})
    data = payload or {}
    if "config" not in data:
        return JSONResponse(status_code=400, content={"message": "Missing config data"})
    branch_id = data.get("branch_id")
    if current_user.role == "manager":
        if branch_id is None:
            return JSONResponse(status_code=403, content={"message": "Managers cannot update global settings"})
        if int(branch_id) != int(current_user.branch_id or 0):
            return JSONResponse(status_code=403, content={"message": "Not allowed for this branch"})
    else:
        # Owner: global row (branch_id null) or this terminal's branch only
        if branch_id is not None and int(branch_id) != resolve_terminal_branch_id(current_user):
            return JSONResponse(status_code=403, content={"message": "Not allowed for this branch"})
    setting = Setting.query.filter_by(branch_id=branch_id).first()
    try:
        if not setting:
            setting = Setting(branch_id=branch_id, config=data["config"])
            db.session.add(setting)
        else:
            setting.config = data["config"]
        db.session.flush()
        terminal = resolve_terminal_branch_id(current_user)
        enqueue_sync_event(
            branch_id=terminal,
            entity_type="settings",
            entity_id=setting.id,
            event_type="settings_updated",
            payload={"scope_branch_id": branch_id, "keys": list((data.get("config") or {}).keys())},
        )
        db.session.commit()
        return {"message": "Settings updated", "config": setting.config}
    except Exception as exc:
        db.session.rollback()
        return JSONResponse(status_code=500, content={"message": "Error updating settings", "error": str(exc)})
