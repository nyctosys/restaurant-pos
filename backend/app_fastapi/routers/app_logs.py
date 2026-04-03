"""
Query and ingest persisted app events (Settings → App Logs, server + optional client reports).
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

from app.models import User
from app.services.app_event_log import list_events, record_event
from app.services.branch_scope import resolve_terminal_branch_id
from app_fastapi.deps import get_current_user, require_owner_or_manager

app_logs_router = APIRouter(prefix="/api/settings", tags=["settings"])


def _serialize_row(row: Any) -> dict[str, Any]:
    return {
        "id": row.id,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "severity": row.severity,
        "source": row.source,
        "category": row.category,
        "message": row.message,
        "requestId": row.request_id,
        "user_id": row.user_id,
        "branch_id": row.branch_id,
        "route": row.route,
        "exc_type": row.exc_type,
        "stack_trace": row.stack_trace,
        "context": row.context_json,
    }


@app_logs_router.get("/app-events")
def get_app_events(
    severity: str | None = Query(None, description="info | warn | error | all"),
    request_id: str | None = Query(None, alias="requestId"),
    q: str | None = Query(None, description="Search message/category/exc_type"),
    from_ts: str | None = Query(None, alias="from"),
    to_ts: str | None = Query(None, alias="to"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    current_user: User = Depends(require_owner_or_manager),
):
    if current_user.role == "owner":
        scope_branch: int | None = None
    else:
        scope_branch = resolve_terminal_branch_id(current_user)
    rows, total = list_events(
        branch_id=scope_branch,
        role=current_user.role or "",
        severity=severity,
        request_id=request_id,
        q=q,
        from_iso=from_ts,
        to_iso=to_ts,
        limit=limit,
        offset=offset,
    )
    return {"events": [_serialize_row(r) for r in rows], "total": total}


class ClientEventIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    severity: str = Field(default="error")
    message: str = Field(..., max_length=8000)
    request_id: str | None = Field(None, max_length=128, alias="requestId")
    route: str | None = Field(None, max_length=1024)
    context: dict[str, Any] | None = None


@app_logs_router.post("/app-events/client")
def post_client_app_event(
    payload: ClientEventIn,
    current_user: User = Depends(require_owner_or_manager),
):
    """Browser-reported errors for correlation with API request IDs."""
    if payload.severity not in ("info", "warn", "error"):
        raise HTTPException(status_code=400, detail={"message": "severity must be info, warn, or error"})
    if current_user.role == "owner":
        bid: int | None = current_user.branch_id
    else:
        bid = resolve_terminal_branch_id(current_user)
    record_event(
        severity=payload.severity,
        message=f"[client] {payload.message}",
        request_id=payload.request_id,
        user_id=current_user.id,
        branch_id=bid,
        route=payload.route,
        source="frontend",
        category="client_report",
        context=payload.context,
    )
    return {"ok": True}
