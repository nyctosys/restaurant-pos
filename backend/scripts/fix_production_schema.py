"""
Repair production database schema drift for Stalls POS.

This script is idempotent. It does not drop tables, drop columns, rename data,
or delete rows. It only:
- creates tables missing from the current SQLAlchemy models,
- adds columns missing from existing tables,
- applies safe PostgreSQL compatibility fixes used by the current app,
- backfills safe defaults for newly added nullable/defaulted fields.

Usage from repo root:
  python backend/scripts/fix_production_schema.py

Usage from backend/:
  python scripts/fix_production_schema.py
"""
from __future__ import annotations

import argparse
import importlib.util
import os
import sys
import types
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import DatabaseError, ProgrammingError


BACKEND_DIR = Path(__file__).resolve().parents[1]
APP_DIR = BACKEND_DIR / "app"
DEFAULT_DATABASE_URL = "postgresql://restaurant_pos:password123@127.0.0.1:5432/restaurant_pos"


@dataclass
class RepairReport:
    tables_created: int = 0
    columns_added: int = 0
    fixes_applied: int = 0
    warnings: list[str] | None = None

    def __post_init__(self) -> None:
        if self.warnings is None:
            self.warnings = []

    def info(self, message: str) -> None:
        print(f"[INFO] {message}")

    def ok(self, message: str) -> None:
        print(f"[OK] {message}")

    def warn(self, message: str) -> None:
        assert self.warnings is not None
        self.warnings.append(message)
        print(f"[WARN] {message}")


def _load_env() -> None:
    load_dotenv(BACKEND_DIR / ".env")
    load_dotenv(BACKEND_DIR / ".env.production", override=False)


def _load_models_without_app_startup():
    """Load app.db and app.models without importing app/__init__.py or app/main.py."""
    package = types.ModuleType("app")
    package.__path__ = [str(APP_DIR)]  # type: ignore[attr-defined]
    sys.modules["app"] = package

    for module_name, path in (
        ("app.db", APP_DIR / "db.py"),
        ("app.models", APP_DIR / "models.py"),
    ):
        if module_name in sys.modules:
            continue
        spec = importlib.util.spec_from_file_location(module_name, path)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"Could not load {module_name} from {path}")
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        spec.loader.exec_module(module)

    return sys.modules["app.db"].db


def _quote(engine: Engine, identifier: str) -> str:
    return engine.dialect.identifier_preparer.quote(identifier)


def _literal_default(value: str) -> str:
    escaped = value.replace("'", "''")
    return f"'{escaped}'"


def _column_type_sql(column: Any, engine: Engine) -> str:
    table_name = column.table.name
    column_name = column.name
    dialect_name = engine.dialect.name

    # Production has historical enum drift. New app code works with strings, and
    # the app startup path already normalizes unit enum columns to VARCHAR.
    if column_name in {"unit", "status", "movement_type"}:
        if column_name == "unit":
            return "VARCHAR(50)"
        if column_name == "status":
            return "VARCHAR(50)"
        return "VARCHAR(50)"

    if dialect_name == "postgresql" and table_name in {"sales", "sale_items", "settings", "products", "sync_outbox", "app_event_logs"}:
        if column_name.endswith("_snapshot") or column_name in {"modifiers", "inventory_allocations", "config", "variants", "payload", "context_json"}:
            return "JSONB"

    return column.type.compile(dialect=engine.dialect)


def _default_for_column(table_name: str, column_name: str) -> str | None:
    defaults = {
        ("products", "sale_price"): "0",
        ("products", "section"): _literal_default(""),
        ("products", "variants"): "'[]'",
        ("products", "image_url"): _literal_default(""),
        ("products", "is_deal"): "FALSE",
        ("products", "unit"): _literal_default("piece"),
        ("sales", "status"): _literal_default("completed"),
        ("sales", "discount_amount"): "0",
        ("sales", "delivery_charge"): "0",
        ("sales", "service_charge"): "0",
        ("sales", "delivery_status"): _literal_default("pending"),
        ("sales", "fulfillment_status"): _literal_default("pending"),
        ("sale_items", "variant_sku_suffix"): _literal_default(""),
        ("combo_items", "quantity"): "1",
        ("combo_items", "selection_type"): _literal_default("product"),
        ("combo_items", "variant_key"): _literal_default(""),
        ("ingredients", "conversion_factor"): "1.0",
        ("ingredients", "current_stock"): "0.0",
        ("ingredients", "minimum_stock"): "0.0",
        ("ingredients", "reorder_quantity"): "0.0",
        ("ingredients", "last_purchase_price"): "0.0",
        ("ingredients", "average_cost"): "0.0",
        ("ingredients", "brand_name"): _literal_default(""),
        ("ingredients", "is_active"): "TRUE",
        ("recipe_items", "variant_key"): _literal_default(""),
        ("recipe_prepared_items", "variant_key"): _literal_default(""),
        ("recipe_extra_costs", "amount"): "0.0",
        ("prepared_items", "kind"): _literal_default("sauce"),
        ("prepared_items", "unit"): _literal_default("kg"),
        ("prepared_items", "current_stock"): "0.0",
        ("prepared_items", "average_cost"): "0.0",
        ("prepared_items", "is_active"): "TRUE",
        ("prepared_item_branch_stocks", "current_stock"): "0.0",
        ("riders", "is_available"): "TRUE",
        ("sync_outbox", "sync_status"): _literal_default("pending"),
        ("sync_outbox", "attempt_count"): "0",
        ("app_event_logs", "severity"): _literal_default("error"),
        ("app_event_logs", "source"): _literal_default("backend"),
    }
    return defaults.get((table_name, column_name))


def _add_missing_columns(engine: Engine, connection: Connection, metadata: Any, report: RepairReport) -> None:
    inspector = inspect(connection)
    table_names = set(inspector.get_table_names())

    for table in metadata.sorted_tables:
        if table.name not in table_names:
            continue

        existing_columns = {column["name"] for column in inspector.get_columns(table.name)}
        for column in table.columns:
            if column.name in existing_columns:
                continue

            default_sql = _default_for_column(table.name, column.name)
            type_sql = _column_type_sql(column, engine)
            table_sql = _quote(engine, table.name)
            column_sql = _quote(engine, column.name)

            ddl = f"ALTER TABLE {table_sql} ADD COLUMN {column_sql} {type_sql}"
            if default_sql is not None:
                ddl += f" DEFAULT {default_sql}"
            # Keep new columns nullable even when the ORM model is non-nullable.
            # This avoids failing on populated production tables; application
            # writes still send valid values, and backfills below cover known cases.
            report.info(f"Adding missing column {table.name}.{column.name}")
            connection.execute(text(ddl))
            report.columns_added += 1


def _create_missing_tables(engine: Engine, metadata: Any, report: RepairReport) -> None:
    with engine.connect() as connection:
        before = set(inspect(connection).get_table_names())
    metadata.create_all(bind=engine, checkfirst=True)
    with engine.connect() as connection:
        after = set(inspect(connection).get_table_names())
    created = sorted(after - before)
    for table in created:
        report.ok(f"Created missing table {table}")
    report.tables_created += len(created)


def _safe_execute(connection: Connection, sql: str, report: RepairReport, message: str) -> None:
    try:
        with connection.begin_nested():
            connection.execute(text(sql))
        report.ok(message)
        report.fixes_applied += 1
    except (DatabaseError, ProgrammingError) as exc:
        report.warn(f"{message} skipped: {exc.__class__.__name__}: {exc}")


def _apply_postgres_fixes(connection: Connection, report: RepairReport) -> None:
    if connection.dialect.name != "postgresql":
        return

    enum_exists = connection.execute(
        text("SELECT 1 FROM pg_type WHERE typname = 'stockmovementtype'")
    ).scalar()
    if enum_exists:
        _safe_execute(
            connection,
            "ALTER TYPE stockmovementtype ADD VALUE IF NOT EXISTS 'PREPARATION'",
            report,
            "Ensured stockmovementtype enum contains PREPARATION",
        )

    for table_name in (
        "ingredients",
        "recipe_items",
        "purchase_order_items",
        "prepared_items",
        "prepared_item_components",
        "prepared_item_prepared_components",
        "recipe_prepared_items",
    ):
        exists = connection.execute(
            text(
                """
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND table_name = :table_name
                  AND column_name = 'unit'
                """
            ),
            {"table_name": table_name},
        ).scalar()
        if exists:
            _safe_execute(
                connection,
                f"ALTER TABLE {_quote(connection.engine, table_name)} ALTER COLUMN unit TYPE VARCHAR(50) USING unit::text",
                report,
                f"Ensured {table_name}.unit is VARCHAR-compatible",
            )

    for table_name in (
        "users",
        "settings",
        "inventory",
        "inventory_transactions",
        "sales",
        "ingredient_branch_stocks",
        "prepared_item_branch_stocks",
        "prepared_item_stock_movements",
        "purchase_orders",
        "stock_movements",
        "stock_takes",
        "sync_outbox",
        "riders",
        "app_event_logs",
        "idempotency_records",
    ):
        exists = connection.execute(
            text(
                """
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND table_name = :table_name
                  AND column_name = 'branch_id'
                """
            ),
            {"table_name": table_name},
        ).scalar()
        if exists:
            _safe_execute(
                connection,
                f"ALTER TABLE {_quote(connection.engine, table_name)} ALTER COLUMN branch_id TYPE VARCHAR(32) USING branch_id::text",
                report,
                f"Ensured {table_name}.branch_id is VARCHAR-compatible",
            )

    combo_product_id_exists = connection.execute(
        text(
            """
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'combo_items'
              AND column_name = 'product_id'
            """
        )
    ).scalar()
    if combo_product_id_exists:
        _safe_execute(
            connection,
            "ALTER TABLE combo_items ALTER COLUMN product_id DROP NOT NULL",
            report,
            "Ensured combo_items.product_id allows category-choice rows",
        )


def _backfill_safe_defaults(connection: Connection, report: RepairReport) -> None:
    statements = [
        (
            "UPDATE products SET sale_price = base_price WHERE sale_price IS NULL OR sale_price = 0",
            "Backfilled products.sale_price from products.base_price",
        ),
        (
            "UPDATE products SET unit = 'piece' WHERE unit IS NULL OR TRIM(unit) = ''",
            "Backfilled products.unit",
        ),
        (
            "UPDATE products SET section = '' WHERE section IS NULL",
            "Backfilled products.section",
        ),
        (
            "UPDATE products SET image_url = '' WHERE image_url IS NULL",
            "Backfilled products.image_url",
        ),
        (
            "UPDATE products SET is_deal = FALSE WHERE is_deal IS NULL",
            "Backfilled products.is_deal",
        ),
        (
            "UPDATE combo_items SET selection_type = 'product' WHERE selection_type IS NULL OR TRIM(selection_type) = ''",
            "Backfilled combo_items.selection_type",
        ),
        (
            "UPDATE combo_items SET variant_key = '' WHERE variant_key IS NULL",
            "Backfilled combo_items.variant_key",
        ),
        (
            "UPDATE sales SET delivery_charge = 0 WHERE delivery_charge IS NULL",
            "Backfilled sales.delivery_charge",
        ),
        (
            "UPDATE sales SET service_charge = 0 WHERE service_charge IS NULL",
            "Backfilled sales.service_charge",
        ),
        (
            """
            UPDATE sales
            SET delivery_status = CASE
              WHEN COALESCE(order_type, '') <> 'delivery' THEN NULL
              WHEN status = 'completed' THEN 'assigned'
              ELSE 'pending'
            END
            WHERE delivery_status IS NULL
            """,
            "Backfilled sales.delivery_status",
        ),
        (
            """
            UPDATE sales
            SET fulfillment_status = CASE
              WHEN COALESCE(order_type, '') = 'takeaway' AND status = 'completed' THEN 'served'
              WHEN COALESCE(order_type, '') = 'takeaway' THEN 'pending'
              ELSE NULL
            END
            WHERE fulfillment_status IS NULL
            """,
            "Backfilled sales.fulfillment_status",
        ),
        (
            "UPDATE ingredients SET brand_name = '' WHERE brand_name IS NULL",
            "Backfilled ingredients.brand_name",
        ),
        (
            "UPDATE recipe_items SET variant_key = '' WHERE variant_key IS NULL",
            "Backfilled recipe_items.variant_key",
        ),
    ]

    inspector = inspect(connection)
    existing_tables = set(inspector.get_table_names())
    existing_columns_by_table = {
        table: {column["name"] for column in inspector.get_columns(table)}
        for table in existing_tables
    }

    for sql, message in statements:
        lowered = sql.lower()
        table_name = lowered.split("update ", 1)[1].split()[0].strip('"')
        if table_name not in existing_tables:
            continue
        # Avoid noisy failures if the target production DB is several versions old.
        if table_name == "products" and "sale_price" in lowered and "sale_price" not in existing_columns_by_table[table_name]:
            continue
        if table_name == "combo_items" and "combo_items" not in existing_tables:
            continue
        try:
            with connection.begin_nested():
                connection.execute(text(sql))
            report.ok(message)
            report.fixes_applied += 1
        except (DatabaseError, ProgrammingError) as exc:
            report.warn(f"{message} skipped: {exc.__class__.__name__}: {exc}")


def repair_schema(database_url: str) -> RepairReport:
    report = RepairReport()
    db = _load_models_without_app_startup()
    engine = create_engine(database_url, pool_pre_ping=True)

    # Make the repo's db object usable for type compilation and metadata helpers.
    db.engine = engine

    report.info(f"Connected using dialect={engine.dialect.name}")
    _create_missing_tables(engine, db.Model.metadata, report)

    with engine.begin() as connection:
        _add_missing_columns(engine, connection, db.Model.metadata, report)
        _apply_postgres_fixes(connection, report)
        _backfill_safe_defaults(connection, report)

    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Fix production database schema drift.")
    parser.add_argument(
        "--database-url",
        default=None,
        help="Database URL to repair. Defaults to DATABASE_URL or the app's local PostgreSQL default.",
    )
    args = parser.parse_args()

    _load_env()
    database_url = args.database_url or os.environ.get("DATABASE_URL") or DEFAULT_DATABASE_URL

    report = repair_schema(database_url)
    print(
        "fix_production_schema: complete "
        f"(tables_created={report.tables_created}, "
        f"columns_added={report.columns_added}, "
        f"fixes_applied={report.fixes_applied}, "
        f"warnings={len(report.warnings or [])})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
