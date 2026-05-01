"""Enqueue branch-scoped events for a future admin-panel sync worker."""

from __future__ import annotations

from typing import Any

from app.models import SyncOutbox, db


def enqueue_sync_event(
    *,
    branch_id: str,
    entity_type: str,
    entity_id: int | None,
    event_type: str,
    payload: dict[str, Any],
) -> None:
    row = SyncOutbox(
        branch_id=branch_id,
        entity_type=entity_type,
        entity_id=entity_id,
        event_type=event_type,
        payload=payload,
    )
    db.session.add(row)
