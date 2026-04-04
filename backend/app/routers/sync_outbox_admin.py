"""Owner-only observability for the sync outbox (no remote sync yet)."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.models import SyncOutbox, User, db
from app.deps import require_owner

sync_outbox_admin_router = APIRouter(prefix="/api/sync-outbox", tags=["sync-outbox"])


@sync_outbox_admin_router.get("/health")
def sync_outbox_health(_: User = Depends(require_owner)):
    pending = db.session.query(SyncOutbox).filter(SyncOutbox.sync_status == "pending").count()
    failed = db.session.query(SyncOutbox).filter(SyncOutbox.sync_status == "failed").count()
    synced = db.session.query(SyncOutbox).filter(SyncOutbox.sync_status == "synced").count()
    return {"pending": pending, "failed": failed, "synced": synced}
