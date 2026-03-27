from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from app.models import Setting, User, db
from app_fastapi.deps import get_current_user, require_owner
from app_fastapi.routers.common import yes

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
        setting = Setting.query.filter_by(branch_id=None).first()
        return {"config": setting.config if setting else {}}
    resolved_branch_id = branch_id if current_user.role == "owner" and branch_id else current_user.branch_id
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
def update_settings(payload: dict[str, Any] | None = None, _: User = Depends(require_owner)):
    data = payload or {}
    if "config" not in data:
        return JSONResponse(status_code=400, content={"message": "Missing config data"})
    branch_id = data.get("branch_id")
    setting = Setting.query.filter_by(branch_id=branch_id).first()
    try:
        if not setting:
            setting = Setting(branch_id=branch_id, config=data["config"])
            db.session.add(setting)
        else:
            setting.config = data["config"]
        db.session.commit()
        return {"message": "Settings updated", "config": setting.config}
    except Exception as exc:
        db.session.rollback()
        return JSONResponse(status_code=500, content={"message": "Error updating settings", "error": str(exc)})
