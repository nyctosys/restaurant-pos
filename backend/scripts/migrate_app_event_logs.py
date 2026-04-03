"""
Create app_event_logs table on existing PostgreSQL databases.

Run once after deploy:
  DATABASE_URL=... python -m scripts.migrate_app_event_logs
"""
from __future__ import annotations

import os
import sys

# Allow running from backend/
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import create_app  # noqa: E402
from app.models import AppEventLog, db  # noqa: E402


def main() -> None:
    create_app()
    engine = db.engine
    if engine is None:
        print("Database not initialized.")
        return
    if engine.dialect.name != "postgresql":
        print("Skipping: not PostgreSQL; use db.create_all() for SQLite dev.")
        return
    AppEventLog.__table__.create(engine, checkfirst=True)
    print("app_event_logs: OK (created if missing)")


if __name__ == "__main__":
    main()
