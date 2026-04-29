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


def _table_exists(table: str) -> bool:
    inspector = inspect(db.engine)
    try:
        return table in inspector.get_table_names()
    except Exception:
        return False


def _ensure_stock_movement_preparation_value(dialect: str) -> None:
    if dialect != "postgresql":
        return
    exists = db.session.execute(
        text(
            """
            SELECT 1
            FROM pg_enum e
            JOIN pg_type t ON e.enumtypid = t.oid
            WHERE t.typname = 'stockmovementtype' AND e.enumlabel = 'PREPARATION'
            """
        )
    ).scalar()
    if exists:
        print("  - stockmovementtype.PREPARATION already exists")
        return
    db.session.execute(text("ALTER TYPE stockmovementtype ADD VALUE IF NOT EXISTS 'PREPARATION'"))
    print("  + Added stockmovementtype.PREPARATION")


def _ensure_prepared_item_tables(dialect: str) -> None:
    float_type = "DOUBLE PRECISION" if dialect == "postgresql" else "FLOAT"
    id_type = "SERIAL PRIMARY KEY" if dialect == "postgresql" else "INTEGER PRIMARY KEY AUTOINCREMENT"
    ts_type = "TIMESTAMPTZ" if dialect == "postgresql" else "TIMESTAMP"

    table_ddls = {
        "prepared_items": f"""
            CREATE TABLE prepared_items (
              id {id_type},
              name VARCHAR(200) NOT NULL,
              sku VARCHAR(100) UNIQUE,
              kind VARCHAR(50) NOT NULL DEFAULT 'sauce',
              unit VARCHAR(6) NOT NULL DEFAULT 'KG',
              current_stock {float_type} NOT NULL DEFAULT 0,
              average_cost {float_type} NOT NULL DEFAULT 0,
              notes TEXT,
              is_active BOOLEAN DEFAULT TRUE,
              created_at {ts_type},
              updated_at {ts_type},
              CONSTRAINT ck_prepared_item_stock_nonneg CHECK (current_stock >= 0),
              CONSTRAINT ck_prepared_item_average_cost_nonneg CHECK (average_cost >= 0)
            )
        """,
        "prepared_item_components": f"""
            CREATE TABLE prepared_item_components (
              id {id_type},
              prepared_item_id INTEGER NOT NULL REFERENCES prepared_items(id),
              ingredient_id INTEGER NOT NULL REFERENCES ingredients(id),
              quantity {float_type} NOT NULL,
              unit VARCHAR(6) NOT NULL,
              notes VARCHAR(500)
            )
        """,
        "prepared_item_branch_stocks": f"""
            CREATE TABLE prepared_item_branch_stocks (
              id {id_type},
              prepared_item_id INTEGER NOT NULL REFERENCES prepared_items(id),
              branch_id INTEGER NOT NULL REFERENCES branches(id),
              current_stock {float_type} NOT NULL DEFAULT 0,
              CONSTRAINT uq_prepared_item_branch_stock UNIQUE (prepared_item_id, branch_id),
              CONSTRAINT ck_prepared_item_branch_stock_nonneg CHECK (current_stock >= 0)
            )
        """,
        "recipe_prepared_items": f"""
            CREATE TABLE recipe_prepared_items (
              id {id_type},
              product_id INTEGER NOT NULL REFERENCES products(id),
              prepared_item_id INTEGER NOT NULL REFERENCES prepared_items(id),
              quantity {float_type} NOT NULL,
              unit VARCHAR(6) NOT NULL,
              notes VARCHAR(500),
              variant_key VARCHAR(100) NOT NULL DEFAULT '',
              created_at {ts_type}
            )
        """,
        "prepared_item_stock_movements": f"""
            CREATE TABLE prepared_item_stock_movements (
              id {id_type},
              prepared_item_id INTEGER NOT NULL REFERENCES prepared_items(id),
              movement_type VARCHAR(50) NOT NULL,
              quantity_change {float_type} NOT NULL,
              quantity_before {float_type} NOT NULL,
              quantity_after {float_type} NOT NULL,
              reference_id INTEGER,
              reference_type VARCHAR(50),
              reason VARCHAR(500),
              created_by INTEGER REFERENCES users(id),
              branch_id INTEGER REFERENCES branches(id),
              created_at {ts_type}
            )
        """,
    }

    for table, ddl in table_ddls.items():
        if _table_exists(table):
            print(f"  - {table} already exists")
            continue
        db.session.execute(text(ddl))
        print(f"  + Created {table}")


def _ensure_combo_product_id_nullable(dialect: str) -> None:
    if dialect != "postgresql":
        print("  - Skipping combo_items.product_id nullability change on non-PostgreSQL DB")
        return
    db.session.execute(text("ALTER TABLE combo_items ALTER COLUMN product_id DROP NOT NULL"))
    print("  + combo_items.product_id now allows NULL for category-choice deal rows")


def _ensure_recipe_extra_costs_table(dialect: str) -> None:
    float_type = "DOUBLE PRECISION" if dialect == "postgresql" else "FLOAT"
    id_type = "SERIAL PRIMARY KEY" if dialect == "postgresql" else "INTEGER PRIMARY KEY AUTOINCREMENT"
    ts_type = "TIMESTAMPTZ" if dialect == "postgresql" else "TIMESTAMP"
    if _table_exists("recipe_extra_costs"):
        print("  - recipe_extra_costs already exists")
        return
    db.session.execute(
        text(
            f"""
            CREATE TABLE recipe_extra_costs (
              id {id_type},
              product_id INTEGER NOT NULL REFERENCES products(id),
              name VARCHAR(120) NOT NULL,
              amount {float_type} NOT NULL DEFAULT 0,
              variant_key VARCHAR(100) NOT NULL DEFAULT '',
              created_at {ts_type},
              CONSTRAINT ck_recipe_extra_cost_amount_nonneg CHECK (amount >= 0)
            )
            """
        )
    )
    print("  + Created recipe_extra_costs")


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
            ColumnMigration(
                table="sales",
                column="kds_ticket_printed_at",
                ddl=f"ALTER TABLE sales ADD COLUMN kds_ticket_printed_at {ts_type}",
            ),
            ColumnMigration(
                table="sales",
                column="modified_at",
                ddl=f"ALTER TABLE sales ADD COLUMN modified_at {ts_type}",
            ),
            ColumnMigration(
                table="sales",
                column="modification_snapshot",
                ddl=f"ALTER TABLE sales ADD COLUMN modification_snapshot {json_type}",
            ),
            # Menu combo variant support.
            ColumnMigration(
                table="combo_items",
                column="variant_key",
                ddl="ALTER TABLE combo_items ADD COLUMN variant_key VARCHAR(100) NOT NULL DEFAULT ''",
            ),
            ColumnMigration(
                table="combo_items",
                column="selection_type",
                ddl="ALTER TABLE combo_items ADD COLUMN selection_type VARCHAR(20) NOT NULL DEFAULT 'product'",
            ),
            ColumnMigration(
                table="combo_items",
                column="category_name",
                ddl="ALTER TABLE combo_items ADD COLUMN category_name VARCHAR(100)",
            ),
            ColumnMigration(
                table="products",
                column="sale_price",
                ddl="ALTER TABLE products ADD COLUMN sale_price NUMERIC(12, 2) DEFAULT 0",
            ),
        ]

        print("migrate_latest_schema_changes: starting ...")
        try:
            _ensure_stock_movement_preparation_value(dialect)
            _ensure_prepared_item_tables(dialect)
            _ensure_recipe_extra_costs_table(dialect)
            for migration in migrations:
                _apply_column_migration(migration)
            # Backward compatibility: old base_price was sale price.
            db.session.execute(
                text("UPDATE products SET sale_price = base_price WHERE sale_price IS NULL OR sale_price = 0")
            )
            _ensure_combo_product_id_nullable(dialect)
            db.session.commit()
            print("migrate_latest_schema_changes: complete.")
        except Exception:
            db.session.rollback()
            raise


if __name__ == "__main__":
    main()
