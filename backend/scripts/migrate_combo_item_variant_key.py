"""
Add combo_items.variant_key for per–deal-variant combo lines (idempotent).

Usage (from backend/):
  python scripts/migrate_combo_item_variant_key.py
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app import create_app
from app.models import db
from sqlalchemy import inspect, text


def migrate() -> None:
    app = create_app()
    with app.app_context():
        eng = db.engine
        insp = inspect(eng)
        cols = [c["name"] for c in insp.get_columns("combo_items")]
        print("migrate_combo_item_variant_key: starting ...")
        if "variant_key" in cols:
            print("  – combo_items.variant_key already exists")
        else:
            with eng.connect() as conn:
                conn.execute(
                    text(
                        "ALTER TABLE combo_items ADD COLUMN variant_key VARCHAR(100) NOT NULL DEFAULT ''"
                    )
                )
                conn.commit()
            print("  ✓ Added combo_items.variant_key")
        print("migrate_combo_item_variant_key: done")


if __name__ == "__main__":
    migrate()
