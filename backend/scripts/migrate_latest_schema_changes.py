"""
Apply latest schema changes that may be missing in existing databases.

This script is idempotent and safe to run multiple times.

Usage (from backend/):
  python scripts/migrate_latest_schema_changes.py
"""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass

from sqlalchemy import inspect, text

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app import create_app  # noqa: E402
from app.models import db  # noqa: E402


@dataclass(frozen=True)
class ColumnMigration:
    table: str
    column: str
    ddl: str


def _column_exists(table: str, column: str) -> bool:
    inspector = inspect(db.engine)
    try:
        columns = {col["name"] for col in inspector.get_columns(table)}
    except Exception:
        return False
    return column in columns


def _apply_column_migration(migration: ColumnMigration) -> None:
    if _column_exists(migration.table, migration.column):
        print(f"  - {migration.table}.{migration.column} already exists")
        return
    db.session.execute(text(migration.ddl))
    print(f"  + Added {migration.table}.{migration.column}")


def main() -> None:
    app = create_app()
    with app.app_context():
        dialect = db.engine.dialect.name
        json_type = "JSONB" if dialect == "postgresql" else "JSON"
        ts_type = "TIMESTAMPTZ" if dialect == "postgresql" else "TIMESTAMP"

        migrations: list[ColumnMigration] = [
            # Sales fields used by dine-in/delivery and receipts.
            ColumnMigration(
                table="sales",
                column="delivery_charge",
                ddl="ALTER TABLE sales ADD COLUMN delivery_charge NUMERIC(12, 2) DEFAULT 0",
            ),
            ColumnMigration(
                table="sales",
                column="order_type",
                ddl="ALTER TABLE sales ADD COLUMN order_type VARCHAR(20)",
            ),
            ColumnMigration(
                table="sales",
                column="order_snapshot",
                ddl=f"ALTER TABLE sales ADD COLUMN order_snapshot {json_type}",
            ),
            # Kitchen workflow timestamp.
            ColumnMigration(
                table="sales",
                column="kitchen_ready_at",
                ddl=f"ALTER TABLE sales ADD COLUMN kitchen_ready_at {ts_type}",
            ),
            # Menu combo variant support.
            ColumnMigration(
                table="combo_items",
                column="variant_key",
                ddl="ALTER TABLE combo_items ADD COLUMN variant_key VARCHAR(100) NOT NULL DEFAULT ''",
            ),
        ]

        print("migrate_latest_schema_changes: starting ...")
        try:
            for migration in migrations:
                _apply_column_migration(migration)
            db.session.commit()
            print("migrate_latest_schema_changes: complete.")
        except Exception:
            db.session.rollback()
            raise


if __name__ == "__main__":
    main()
