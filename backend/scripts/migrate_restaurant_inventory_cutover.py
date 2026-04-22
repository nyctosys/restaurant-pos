"""
PostgreSQL migration: restaurant inventory cutover (branch ingredient stock + modifier depletion).

Run once against production/staging after deploying code that expects:
  - table ingredient_branch_stocks
  - modifiers.ingredient_id, modifiers.depletion_quantity

Idempotent: skips objects that already exist.

Legacy finished-goods tables (inventory, inventory_transactions) are NOT dropped here;
archive or drop them in a separate maintenance window if desired.

Usage (from backend/):
  DATABASE_URL=postgresql://... python scripts/migrate_restaurant_inventory_cutover.py
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

        print("migrate_restaurant_inventory_cutover: starting ...")

        # --- ingredient_branch_stocks ---
        r = conn.execute(
            text(
                """
                SELECT EXISTS (
                  SELECT FROM information_schema.tables
                  WHERE table_schema = 'public' AND table_name = 'ingredient_branch_stocks'
                )
                """
            )
        )
        exists_ib = bool(r.scalar())
        if not exists_ib:
            conn.execute(
                text(
                    """
                    CREATE TABLE ingredient_branch_stocks (
                      id SERIAL PRIMARY KEY,
                      ingredient_id INTEGER NOT NULL REFERENCES ingredients(id),
                      branch_id INTEGER NOT NULL REFERENCES branches(id),
                      current_stock DOUBLE PRECISION NOT NULL DEFAULT 0,
                      CONSTRAINT uq_ingredient_branch_stock UNIQUE (ingredient_id, branch_id),
                      CONSTRAINT ck_ingredient_branch_stock_nonneg CHECK (current_stock >= 0)
                    )
                    """
                )
            )
            print("  [OK] Created ingredient_branch_stocks")
        else:
            print("  [-] ingredient_branch_stocks already exists")

        # --- modifiers columns ---
        for col, ddl in (
            ("ingredient_id", "ALTER TABLE modifiers ADD COLUMN ingredient_id INTEGER REFERENCES ingredients(id)"),
            (
                "depletion_quantity",
                "ALTER TABLE modifiers ADD COLUMN depletion_quantity DOUBLE PRECISION NOT NULL DEFAULT 0",
            ),
        ):
            cr = conn.execute(
                text(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_name='modifiers' AND column_name=:c"
                ),
                {"c": col},
            )
            if cr.fetchone() is None:
                conn.execute(text(ddl))
                print(f"  [OK] Added modifiers.{col}")
            else:
                print(f"  [-] modifiers.{col} already exists")

        # --- backfill branch rows from master ingredient.current_stock ---
        # Assign legacy master quantity to the lowest branch id only; other branches get 0.
        conn.execute(
            text(
                """
                INSERT INTO ingredient_branch_stocks (ingredient_id, branch_id, current_stock)
                SELECT i.id, b.id,
                  CASE WHEN b.id = (SELECT MIN(id) FROM branches) THEN COALESCE(i.current_stock, 0) ELSE 0 END
                FROM ingredients i
                CROSS JOIN branches b
                WHERE NOT EXISTS (
                   SELECT 1 FROM ingredient_branch_stocks s
                   WHERE s.ingredient_id = i.id AND s.branch_id = b.id
                )
                """
            )
        )
        print("  [OK] Backfilled missing ingredient_branch_stocks rows (per-ingredient x per-branch)")

        db.session.commit()
        print("migrate_restaurant_inventory_cutover: complete.")


if __name__ == "__main__":
    migrate()
