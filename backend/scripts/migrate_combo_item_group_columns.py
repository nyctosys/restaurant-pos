"""
Add combo_items.group_label, choice_group_key, distinct_picks_in_group (idempotent).

Run from repo root:
  python backend/scripts/migrate_combo_item_group_columns.py
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from sqlalchemy import inspect, text  # noqa: E402

from app import database_shell  # noqa: E402


def main() -> None:
    with database_shell.app_context():
        from app.models import db

        engine = db.engine
        insp = inspect(engine)
        cols = [c["name"] for c in insp.get_columns("combo_items")]
        stmts: list[str] = []
        if "group_label" not in cols:
            stmts.append("ALTER TABLE combo_items ADD COLUMN group_label VARCHAR(120)")
        if "choice_group_key" not in cols:
            stmts.append("ALTER TABLE combo_items ADD COLUMN choice_group_key VARCHAR(80)")
        if "distinct_picks_in_group" not in cols:
            stmts.append(
                "ALTER TABLE combo_items ADD COLUMN distinct_picks_in_group BOOLEAN NOT NULL DEFAULT 0"
            )
        if not stmts:
            print("migrate_combo_item_group_columns: columns already present")
            return
        for sql in stmts:
            print("migrate_combo_item_group_columns:", sql)
            db.session.execute(text(sql))
        db.session.commit()
        print("migrate_combo_item_group_columns: done")


if __name__ == "__main__":
    main()
