"""
Persisted application events for troubleshooting (Settings → App Logs).
"""
from __future__ import annotations

import logging
import traceback
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.db import get_request_session_optional
from app.models import AppEventLog, User, db

logger = logging.getLogger("app.events")

# Default retention; override via env in record_event prune
_RETENTION_DAYS = 30
_MAX_ROWS = 20_000


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _prune_if_needed(sess: Session) -> None:
    """Keep table bounded: drop old rows and cap total count."""
    try:
        cutoff = _now_utc() - timedelta(days=_RETENTION_DAYS)
        sess.query(AppEventLog).filter(AppEventLog.created_at < cutoff).delete(synchronize_session=False)
        count = sess.query(AppEventLog).count()
        if count > _MAX_ROWS:
            excess = count - _MAX_ROWS
            ids = (
                sess.query(AppEventLog.id)
                .order_by(AppEventLog.created_at.asc())
                .limit(excess)
                .all()
            )
            id_list = [i[0] for i in ids]
            if id_list:
                sess.query(AppEventLog).filter(AppEventLog.id.in_(id_list)).delete(synchronize_session=False)
        sess.commit()
    except Exception as exc:
        sess.rollback()
        logger.warning("app_event_log prune failed: %s", exc, exc_info=True)


def record_event(
    *,
    severity: str,
    message: str,
    request_id: str | None = None,
    user_id: int | None = None,
    branch_id: int | None = None,
    route: str | None = None,
    source: str = "backend",
    category: str | None = None,
    exc_type: str | None = None,
    stack_trace: str | None = None,
    context: dict[str, Any] | None = None,
) -> AppEventLog | None:
    """Insert one event row. Failures are logged and do not raise."""
    sess = get_request_session_optional()
    owns_sess = False
    if sess is None:
        if db.session_factory is None:
            logger.warning("app_event_log record skipped: database not initialized")
            return None
        sess = db.session_factory()
        owns_sess = True
    try:
        row = AppEventLog(
            created_at=_now_utc(),
            severity=severity[:16],
            message=message[:16_000],
            request_id=request_id[:128] if request_id else None,
            user_id=user_id,
            branch_id=branch_id,
            route=route[:1024] if route else None,
            source=source[:32],
            category=category[:128] if category else None,
            exc_type=exc_type[:255] if exc_type else None,
            stack_trace=stack_trace[:65_000] if stack_trace else None,
            context_json=context,
        )
        sess.add(row)
        sess.commit()
        _prune_if_needed(sess)
        return row
    except Exception as exc:
        sess.rollback()
        logger.warning("app_event_log record failed: %s", exc, exc_info=True)
        return None
    finally:
        if owns_sess:
            sess.close()


def record_unhandled_exception(
    *,
    exc: BaseException,
    request_id: str | None,
    route: str | None,
    user: User | None,
) -> None:
    """Persist a server error with traceback for Settings diagnostics."""
    uid = user.id if user else None
    bid = user.branch_id if user and user.branch_id else None
    stack = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
    record_event(
        severity="error",
        message=str(exc)[:2000] or type(exc).__name__,
        request_id=request_id,
        user_id=uid,
        branch_id=bid,
        route=route,
        source="backend",
        category="unhandled_exception",
        exc_type=type(exc).__name__,
        stack_trace=stack,
        context=None,
    )


def list_events(
    *,
    branch_id: int | None,
    role: str,
    severity: str | None = None,
    request_id: str | None = None,
    q: str | None = None,
    from_iso: str | None = None,
    to_iso: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> tuple[list[AppEventLog], int]:
    """
    Query persisted events. Owners see all; managers see their branch only.
    """
    query = AppEventLog.query
    if role == "owner":
        pass
    elif branch_id is not None:
        query = query.filter(
            or_(AppEventLog.branch_id == branch_id, AppEventLog.branch_id.is_(None))
        )
    else:
        query = query.filter(AppEventLog.branch_id.is_(None))

    if severity and severity != "all":
        query = query.filter(AppEventLog.severity == severity)
    if request_id:
        query = query.filter(AppEventLog.request_id == request_id[:128])
    if q:
        like = f"%{q[:200]}%"
        query = query.filter(
            or_(
                AppEventLog.message.ilike(like),
                AppEventLog.category.ilike(like),
                AppEventLog.exc_type.ilike(like),
            )
        )
    if from_iso:
        try:
            t = datetime.fromisoformat(from_iso.replace("Z", "+00:00"))
            query = query.filter(AppEventLog.created_at >= t)
        except ValueError:
            pass
    if to_iso:
        try:
            t = datetime.fromisoformat(to_iso.replace("Z", "+00:00"))
            query = query.filter(AppEventLog.created_at <= t)
        except ValueError:
            pass

    total = query.count()
    rows = (
        query.order_by(AppEventLog.created_at.desc())
        .offset(max(0, offset))
        .limit(min(500, max(1, limit)))
        .all()
    )
    return rows, total
