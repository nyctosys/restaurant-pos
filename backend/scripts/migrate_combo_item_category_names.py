"""
Add combo_items.category_names for multi-category deal choices (idempotent).

Usage (from backend/):
  python scripts/migrate_combo_item_category_names.py
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from sqlalchemy import inspect, text

from app import create_app
from app.models import db


def migrate() -> None:
    app = create_app()
    with app.app_context():
        eng = db.engine
        insp = inspect(eng)
        cols = [c["name"] for c in insp.get_columns("combo_items")]
        print("migrate_combo_item_category_names: starting ...")
        if "category_names" in cols:
            print("  [-] combo_items.category_names already exists")
        else:
            dialect = eng.dialect.name
            col_sql = "JSONB NOT NULL DEFAULT '[]'::jsonb" if dialect == "postgresql" else "JSON NOT NULL DEFAULT '[]'"
            with eng.connect() as conn:
                conn.execute(text(f"ALTER TABLE combo_items ADD COLUMN category_names {col_sql}"))
                conn.commit()
            print("  [OK] Added combo_items.category_names")
        print("migrate_combo_item_category_names: done")


if __name__ == "__main__":
    migrate()
