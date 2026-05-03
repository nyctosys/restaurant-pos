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


def _index_exists(table: str, index_name: str) -> bool:
    inspector = inspect(db.engine)
    try:
        return any(index.get("name") == index_name for index in inspector.get_indexes(table))
    except Exception:
        return False


def _ensure_index(table: str, index_name: str, ddl: str) -> None:
    if _index_exists(table, index_name):
        print(f"  - {index_name} already exists")
        return
    db.session.execute(text(ddl))
    print(f"  + Created {index_name}")


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
              branch_id VARCHAR(32) NOT NULL REFERENCES branches(id),
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
              branch_id VARCHAR(32) REFERENCES branches(id),
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


def _ensure_riders_table(dialect: str) -> None:
    id_type = "SERIAL PRIMARY KEY" if dialect == "postgresql" else "INTEGER PRIMARY KEY AUTOINCREMENT"
    ts_type = "TIMESTAMPTZ" if dialect == "postgresql" else "TIMESTAMP"
    if _table_exists("riders"):
        print("  - riders already exists")
        return
    db.session.execute(
        text(
            f"""
            CREATE TABLE riders (
              id {id_type},
              branch_id VARCHAR(32) NOT NULL REFERENCES branches(id),
              name VARCHAR(120) NOT NULL,
              is_available BOOLEAN NOT NULL DEFAULT TRUE,
              created_at {ts_type},
              archived_at {ts_type},
              CONSTRAINT uq_rider_branch_name UNIQUE (branch_id, name)
            )
            """
        )
    )
    print("  + Created riders")

def _ensure_idempotency_records_table(dialect: str) -> None:
    id_type = "SERIAL PRIMARY KEY" if dialect == "postgresql" else "INTEGER PRIMARY KEY AUTOINCREMENT"
    ts_type = "TIMESTAMPTZ" if dialect == "postgresql" else "TIMESTAMP"
    json_type = "JSONB" if dialect == "postgresql" else "JSON"
    if _table_exists("idempotency_records"):
        print("  - idempotency_records already exists")
        return
    db.session.execute(
        text(
            f"""
            CREATE TABLE idempotency_records (
              id {id_type},
              idempotency_key VARCHAR(128) NOT NULL UNIQUE,
              method VARCHAR(10) NOT NULL,
              path VARCHAR(255) NOT NULL,
              request_hash VARCHAR(64) NOT NULL,
              user_id INTEGER REFERENCES users(id),
              branch_id VARCHAR(32) REFERENCES branches(id),
              response_status INTEGER,
              response_body {json_type},
              state VARCHAR(20) NOT NULL DEFAULT 'processing',
              created_at {ts_type},
              updated_at {ts_type}
            )
            """
        )
    )
    print("  + Created idempotency_records")


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
            ColumnMigration(
                table="ingredients",
                column="brand_name",
                ddl="ALTER TABLE ingredients ADD COLUMN brand_name VARCHAR(120) NOT NULL DEFAULT ''",
            ),
            ColumnMigration(
                table="ingredients",
                column="preferred_supplier_id",
                ddl="ALTER TABLE ingredients ADD COLUMN preferred_supplier_id INTEGER REFERENCES suppliers(id)",
            ),
            ColumnMigration(
                table="ingredients",
                column="unit_conversions",
                ddl=f"ALTER TABLE ingredients ADD COLUMN unit_conversions {json_type}",
            ),
            ColumnMigration(
                table="sales",
                column="delivery_status",
                ddl="ALTER TABLE sales ADD COLUMN delivery_status VARCHAR(20) DEFAULT 'pending'",
            ),
            ColumnMigration(
                table="sales",
                column="assigned_rider_id",
                ddl="ALTER TABLE sales ADD COLUMN assigned_rider_id INTEGER REFERENCES riders(id)",
            ),
            ColumnMigration(
                table="sales",
                column="fulfillment_status",
                ddl="ALTER TABLE sales ADD COLUMN fulfillment_status VARCHAR(20) DEFAULT 'pending'",
            ),
        ]

        print("migrate_latest_schema_changes: starting ...")
        try:
            _ensure_stock_movement_preparation_value(dialect)
            _ensure_prepared_item_tables(dialect)
            _ensure_recipe_extra_costs_table(dialect)
            _ensure_riders_table(dialect)
            _ensure_idempotency_records_table(dialect)
            for migration in migrations:
                _apply_column_migration(migration)
            # Backward compatibility: old base_price was sale price.
            db.session.execute(
                text("UPDATE products SET sale_price = base_price WHERE sale_price IS NULL OR sale_price = 0")
            )
            from app.models import Product  # local import to avoid script startup side effects

            for product in Product.query.all():
                raw_variants = getattr(product, "variants", None)
                if isinstance(raw_variants, list) and len(raw_variants) > 0:
                    continue
                base_price = float(getattr(product, "base_price", 0) or 0)
                sale_price = float(getattr(product, "sale_price", base_price) or base_price)
                if sale_price <= 0:
                    sale_price = base_price if base_price > 0 else 1.0
                if base_price <= 0:
                    base_price = sale_price if sale_price > 0 else 1.0
                product.variants = [
                    {
                        "name": "Default",
                        "basePrice": round(base_price, 2),
                        "salePrice": round(sale_price, 2),
                        "sku": "",
                    }
                ]
            db.session.execute(
                text(
                    """
                    UPDATE sales
                    SET delivery_status = CASE
                      WHEN COALESCE(order_type, '') <> 'delivery' THEN NULL
                      WHEN status = 'completed' THEN 'assigned'
                      ELSE 'pending'
                    END
                    WHERE delivery_status IS NULL
                    """
                )
            )
            db.session.execute(
                text(
                    """
                    UPDATE sales
                    SET fulfillment_status = CASE
                      WHEN COALESCE(order_type, '') = 'takeaway' AND status = 'completed' THEN 'served'
                      WHEN COALESCE(order_type, '') = 'takeaway' THEN 'pending'
                      ELSE NULL
                    END
                    WHERE fulfillment_status IS NULL
                    """
                )
            )
            _ensure_combo_product_id_nullable(dialect)
            _ensure_index(
                "sales",
                "ix_sales_report_branch_created_status",
                "CREATE INDEX IF NOT EXISTS ix_sales_report_branch_created_status ON sales (branch_id, created_at, status)",
            )
            _ensure_index(
                "sales",
                "ix_sales_report_branch_created_payment",
                "CREATE INDEX IF NOT EXISTS ix_sales_report_branch_created_payment ON sales (branch_id, created_at, payment_method)",
            )
            _ensure_index(
                "sales",
                "ix_sales_report_branch_created_order_type",
                "CREATE INDEX IF NOT EXISTS ix_sales_report_branch_created_order_type ON sales (branch_id, created_at, order_type)",
            )
            _ensure_index(
                "idempotency_records",
                "ix_idempotency_records_user_path",
                "CREATE INDEX IF NOT EXISTS ix_idempotency_records_user_path ON idempotency_records (user_id, method, path)",
            )
            # Read-path indexes for larger branches (idempotent; safe if models already created them).
            extra_indexes: list[tuple[str, str, str]] = [
                ("users", "ix_users_branch_id", "CREATE INDEX IF NOT EXISTS ix_users_branch_id ON users (branch_id)"),
                ("products", "ix_products_archived_at", "CREATE INDEX IF NOT EXISTS ix_products_archived_at ON products (archived_at)"),
                ("modifiers", "ix_modifiers_ingredient_id", "CREATE INDEX IF NOT EXISTS ix_modifiers_ingredient_id ON modifiers (ingredient_id)"),
                ("combo_items", "ix_combo_items_combo_id", "CREATE INDEX IF NOT EXISTS ix_combo_items_combo_id ON combo_items (combo_id)"),
                (
                    "inventory_transactions",
                    "ix_inventory_transactions_branch_created",
                    "CREATE INDEX IF NOT EXISTS ix_inventory_transactions_branch_created ON inventory_transactions (branch_id, created_at)",
                ),
                (
                    "inventory_transactions",
                    "ix_inventory_transactions_reference",
                    "CREATE INDEX IF NOT EXISTS ix_inventory_transactions_reference ON inventory_transactions (reference_type, reference_id)",
                ),
                (
                    "sales",
                    "ix_sales_branch_archived_created",
                    "CREATE INDEX IF NOT EXISTS ix_sales_branch_archived_created ON sales (branch_id, archived_at, created_at)",
                ),
                ("sale_items", "ix_sale_items_sale_id", "CREATE INDEX IF NOT EXISTS ix_sale_items_sale_id ON sale_items (sale_id)"),
                ("sale_items", "ix_sale_items_product_id", "CREATE INDEX IF NOT EXISTS ix_sale_items_product_id ON sale_items (product_id)"),
                (
                    "recipe_items",
                    "ix_recipe_items_product_variant",
                    "CREATE INDEX IF NOT EXISTS ix_recipe_items_product_variant ON recipe_items (product_id, variant_key)",
                ),
                (
                    "recipe_items",
                    "ix_recipe_items_ingredient_id",
                    "CREATE INDEX IF NOT EXISTS ix_recipe_items_ingredient_id ON recipe_items (ingredient_id)",
                ),
                (
                    "recipe_prepared_items",
                    "ix_recipe_prepared_items_product_variant",
                    "CREATE INDEX IF NOT EXISTS ix_recipe_prepared_items_product_variant ON recipe_prepared_items (product_id, variant_key)",
                ),
                (
                    "purchase_order_items",
                    "ix_purchase_order_items_po_id",
                    "CREATE INDEX IF NOT EXISTS ix_purchase_order_items_po_id ON purchase_order_items (purchase_order_id)",
                ),
                (
                    "stock_movements",
                    "ix_stock_movements_branch_created",
                    "CREATE INDEX IF NOT EXISTS ix_stock_movements_branch_created ON stock_movements (branch_id, created_at)",
                ),
                (
                    "stock_movements",
                    "ix_stock_movements_ingredient_branch_created",
                    "CREATE INDEX IF NOT EXISTS ix_stock_movements_ingredient_branch_created ON stock_movements (ingredient_id, branch_id, created_at)",
                ),
                (
                    "stock_take_items",
                    "ix_stock_take_items_take_id",
                    "CREATE INDEX IF NOT EXISTS ix_stock_take_items_take_id ON stock_take_items (stock_take_id)",
                ),
                (
                    "prepared_item_stock_movements",
                    "ix_prepared_item_stock_mv_branch_created",
                    "CREATE INDEX IF NOT EXISTS ix_prepared_item_stock_mv_branch_created ON prepared_item_stock_movements (branch_id, created_at)",
                ),
                (
                    "prepared_item_stock_movements",
                    "ix_prepared_item_stock_mv_item_created",
                    "CREATE INDEX IF NOT EXISTS ix_prepared_item_stock_mv_item_created ON prepared_item_stock_movements (prepared_item_id, created_at)",
                ),
                (
                    "sync_outbox",
                    "ix_sync_outbox_branch_status",
                    "CREATE INDEX IF NOT EXISTS ix_sync_outbox_branch_status ON sync_outbox (branch_id, sync_status)",
                ),
                (
                    "sync_outbox",
                    "ix_sync_outbox_occurred_at",
                    "CREATE INDEX IF NOT EXISTS ix_sync_outbox_occurred_at ON sync_outbox (occurred_at)",
                ),
                (
                    "ingredient_branch_stocks",
                    "ix_ingredient_branch_stocks_branch_id",
                    "CREATE INDEX IF NOT EXISTS ix_ingredient_branch_stocks_branch_id ON ingredient_branch_stocks (branch_id)",
                ),
                (
                    "app_event_logs",
                    "ix_app_event_logs_branch_created",
                    "CREATE INDEX IF NOT EXISTS ix_app_event_logs_branch_created ON app_event_logs (branch_id, created_at)",
                ),
                (
                    "purchase_orders",
                    "ix_purchase_orders_branch_created",
                    "CREATE INDEX IF NOT EXISTS ix_purchase_orders_branch_created ON purchase_orders (branch_id, created_at)",
                ),
                (
                    "purchase_orders",
                    "ix_purchase_orders_supplier_id",
                    "CREATE INDEX IF NOT EXISTS ix_purchase_orders_supplier_id ON purchase_orders (supplier_id)",
                ),
            ]
            for table, iname, ddl in extra_indexes:
                if _table_exists(table):
                    _ensure_index(table, iname, ddl)
            db.session.commit()
            print("migrate_latest_schema_changes: complete.")
        except Exception:
            db.session.rollback()
            raise


if __name__ == "__main__":
    main()
