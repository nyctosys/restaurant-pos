"""
PostgreSQL migration: recipe_items.variant_key for per-variant BOM.

Idempotent: adds column only if missing.

Usage (from backend/):
  DATABASE_URL=postgresql://... python scripts/migrate_recipe_variant_key.py
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app import create_app
from app.models import db
from sqlalchemy import text


def migrate() -> None:
    app = create_app()
    with app.app_context():
        conn = db.session.connection()
        print("migrate_recipe_variant_key: starting ...")
        cr = conn.execute(
            text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name='recipe_items' AND column_name='variant_key'"
            )
        )
        if cr.fetchone():
            print("  [-] recipe_items.variant_key already exists")
        else:
            conn.execute(
                text(
                    """
                    ALTER TABLE recipe_items
                    ADD COLUMN variant_key VARCHAR(100) NOT NULL DEFAULT ''
                    """
                )
            )
            print("  [OK] Added recipe_items.variant_key")
        db.session.commit()
        print("migrate_recipe_variant_key: done")


if __name__ == "__main__":
    migrate()
