"""
Production readiness verifier for Stalls POS.

Read-only by default. Use --apply-migrations to run the repo's idempotent
schema catch-up scripts before verification.

Usage from repo root:
  python backend/scripts/verify_production.py
  python backend/scripts/verify_production.py --apply-migrations
  python backend/scripts/verify_production.py --base-url http://127.0.0.1:5001
"""
from __future__ import annotations

import argparse
import importlib.util
import os
import platform
import subprocess
import sys
import time
import types
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

from dotenv import load_dotenv
from sqlalchemy import inspect, text
from sqlalchemy.engine import make_url


BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_DIR.parent
FRONTEND_DIR = REPO_ROOT / "frontend"

if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


LATEST_REQUIRED_COLUMNS: dict[str, set[str]] = {
    "sales": {
        "delivery_charge",
        "order_type",
        "order_snapshot",
        "kitchen_ready_at",
        "kds_ticket_printed_at",
        "modified_at",
        "modification_snapshot",
        "delivery_status",
        "assigned_rider_id",
    },
    "combo_items": {"variant_key", "selection_type", "category_name"},
    "products": {"sale_price"},
}

LATEST_REQUIRED_TABLES = {
    "prepared_items",
    "prepared_item_components",
    "prepared_item_branch_stocks",
    "recipe_prepared_items",
    "prepared_item_stock_movements",
    "recipe_extra_costs",
    "riders",
}


@dataclass
class CheckReport:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def ok(self, message: str) -> None:
        print(f"[OK] {message}")

    def warn(self, message: str) -> None:
        self.warnings.append(message)
        print(f"[WARN] {message}")

    def fail(self, message: str) -> None:
        self.errors.append(message)
        print(f"[FAIL] {message}")


def _load_env() -> None:
    load_dotenv(BACKEND_DIR / ".env")
    load_dotenv(BACKEND_DIR / ".env.production", override=False)


def _run_command(args: list[str], cwd: Path, report: CheckReport, timeout: int | None = None) -> bool:
    printable = " ".join(args)
    print(f"[RUN] {printable}")
    try:
        proc = subprocess.run(args, cwd=cwd, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        report.fail(f"Command timed out after {timeout}s: {printable}")
        return False
    if proc.returncode != 0:
        report.fail(f"Command failed with exit code {proc.returncode}: {printable}")
        return False
    report.ok(f"Command passed: {printable}")
    return True


def apply_migrations(report: CheckReport) -> bool:
    """Run safe, idempotent schema catch-up scripts."""
    commands = [
        [sys.executable, "scripts/migrate_latest_schema_changes.py"],
        [sys.executable, "scripts/sync_db_schema.py"],
    ]
    passed = True
    for command in commands:
        passed = _run_command(command, BACKEND_DIR, report) and passed
    return passed


def check_files(report: CheckReport) -> None:
    required_paths = [
        BACKEND_DIR / "app" / "main.py",
        BACKEND_DIR / "requirements.txt",
        FRONTEND_DIR / "package.json",
    ]
    for path in required_paths:
        if path.exists():
            report.ok(f"Found {path.relative_to(REPO_ROOT)}")
        else:
            report.fail(f"Missing {path.relative_to(REPO_ROOT)}")

    dist_index = FRONTEND_DIR / "dist" / "index.html"
    if dist_index.exists():
        report.ok("Frontend production build exists at frontend/dist/index.html")
    else:
        report.warn("frontend/dist/index.html is missing; run `npm run build` before production use")


def check_environment(report: CheckReport) -> str:
    database_url = os.environ.get("DATABASE_URL", "")
    secret_key = os.environ.get("SECRET_KEY", "")
    port = os.environ.get("PORT", "5001")

    report.ok(f"Python {platform.python_version()} on {platform.system()}")
    if database_url:
        report.ok("DATABASE_URL is set")
    else:
        report.fail("DATABASE_URL is not set; backend will fall back to local PostgreSQL defaults")

    if database_url.startswith("sqlite"):
        report.warn("DATABASE_URL points to SQLite; production should normally use PostgreSQL")
    if secret_key in {"", "dev_secret_key_change_in_production", "your_secret_key_change_in_production"}:
        report.fail("SECRET_KEY is missing or still uses a development/template value")
    else:
        report.ok("SECRET_KEY is set to a non-template value")
    report.ok(f"Expected backend port is {port}")
    return port


def _metadata_schema_drift(inspector, metadata_tables: Iterable) -> tuple[list[str], list[str]]:
    existing_tables = set(inspector.get_table_names())
    missing_tables: list[str] = []
    missing_columns: list[str] = []

    for table in metadata_tables:
        if table.name not in existing_tables:
            missing_tables.append(table.name)
            continue
        existing_columns = {col["name"] for col in inspector.get_columns(table.name)}
        for column in table.columns:
            if column.name not in existing_columns:
                missing_columns.append(f"{table.name}.{column.name}")

    return missing_tables, missing_columns


def _load_models_without_app_startup():
    """Load app.db and app.models without executing app/__init__.py or app/main.py."""
    app_dir = BACKEND_DIR / "app"
    package = types.ModuleType("app")
    package.__path__ = [str(app_dir)]  # type: ignore[attr-defined]
    sys.modules["app"] = package

    for module_name, path in (
        ("app.db", app_dir / "db.py"),
        ("app.models", app_dir / "models.py"),
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


def _database_url_with_timeout(database_url: str, timeout_seconds: int) -> str:
    try:
        url = make_url(database_url)
    except Exception:
        return database_url
    if url.drivername.startswith("postgresql") and "connect_timeout" not in url.query:
        url = url.update_query_dict({"connect_timeout": str(timeout_seconds)})
    return url.render_as_string(hide_password=False)


def _check_latest_schema_contract(inspector, report: CheckReport) -> None:
    existing_tables = set(inspector.get_table_names())
    missing_latest_tables = sorted(LATEST_REQUIRED_TABLES - existing_tables)
    for table in missing_latest_tables:
        report.fail(f"Latest schema table missing: {table}")

    for table, required_columns in sorted(LATEST_REQUIRED_COLUMNS.items()):
        if table not in existing_tables:
            report.fail(f"Latest schema table missing: {table}")
            continue
        existing_columns = {col["name"] for col in inspector.get_columns(table)}
        for column in sorted(required_columns - existing_columns):
            report.fail(f"Latest schema column missing: {table}.{column}")


def _check_postgres_specifics(connection, inspector, report: CheckReport) -> None:
    if connection.dialect.name != "postgresql":
        return

    preparation_exists = connection.execute(
        text(
            """
            SELECT 1
            FROM pg_enum e
            JOIN pg_type t ON e.enumtypid = t.oid
            WHERE t.typname = 'stockmovementtype' AND e.enumlabel = 'PREPARATION'
            """
        )
    ).scalar()
    if preparation_exists:
        report.ok("PostgreSQL enum stockmovementtype contains PREPARATION")
    else:
        report.fail("PostgreSQL enum stockmovementtype is missing PREPARATION")

    if "combo_items" in inspector.get_table_names():
        product_id = next(
            (col for col in inspector.get_columns("combo_items") if col["name"] == "product_id"),
            None,
        )
        if product_id and product_id.get("nullable") is True:
            report.ok("combo_items.product_id allows NULL for category-choice deals")
        elif product_id:
            report.fail("combo_items.product_id is still NOT NULL; latest deal schema is not applied")


def check_database(report: CheckReport, timeout_seconds: int) -> bool:
    db = _load_models_without_app_startup()
    database_url = os.environ.get(
        "DATABASE_URL",
        "postgresql://restaurant_pos:password123@127.0.0.1:5432/restaurant_pos",
    )
    db.init_engine(_database_url_with_timeout(database_url, timeout_seconds))
    if db.engine is None:
        report.fail("Database engine did not initialize")
        return False

    started = time.time()
    try:
        with db.engine.connect() as connection:
            connection.execute(text("SELECT 1")).scalar()
            elapsed_ms = int((time.time() - started) * 1000)
            report.ok(f"Database connection works ({db.engine.dialect.name}, {elapsed_ms} ms)")

            inspector = inspect(connection)
            table_names = inspector.get_table_names()
            report.ok(f"Database has {len(table_names)} tables")

            missing_tables, missing_columns = _metadata_schema_drift(
                inspector,
                db.Model.metadata.sorted_tables,
            )
            for table in sorted(missing_tables):
                report.fail(f"Model table missing from database: {table}")
            for column in sorted(missing_columns):
                report.fail(f"Model column missing from database: {column}")
            if not missing_tables and not missing_columns:
                report.ok("Database schema matches SQLAlchemy model tables and columns")

            _check_latest_schema_contract(inspector, report)
            _check_postgres_specifics(connection, inspector, report)

            branch_count = connection.execute(text("SELECT COUNT(*) FROM branches")).scalar()
            user_count = connection.execute(text("SELECT COUNT(*) FROM users")).scalar()
            report.ok(f"Seed check: branches={branch_count}, users={user_count}")
            if int(user_count or 0) == 0:
                report.warn("No users exist; first-run setup may still be required")
    except Exception as exc:
        report.fail(f"Database verification failed: {exc}")
        return False
    return True


def check_backend_import(report: CheckReport) -> None:
    env = os.environ.copy()
    env["PYTHONPATH"] = str(BACKEND_DIR)
    command = [sys.executable, "-c", "from app.main import app; print(app.title)"]
    try:
        proc = subprocess.run(command, cwd=BACKEND_DIR, env=env, text=True, timeout=30)
    except subprocess.TimeoutExpired:
        report.fail("FastAPI app startup import timed out after 30s")
        return
    if proc.returncode != 0:
        report.fail("FastAPI app startup import failed")
        return
    report.ok("FastAPI app imports successfully")


def check_http_health(base_url: str, report: CheckReport) -> None:
    url = f"{base_url.rstrip('/')}/api/health"
    try:
        with urlopen(url, timeout=5) as response:
            body = response.read().decode("utf-8", errors="replace")
            if response.status == 200 and '"healthy"' in body:
                report.ok(f"Backend health endpoint is healthy: {url}")
            else:
                report.fail(f"Backend health endpoint returned unexpected response: {response.status} {body}")
    except HTTPError as exc:
        report.fail(f"Backend health endpoint failed: HTTP {exc.code} at {url}")
    except URLError as exc:
        report.fail(f"Backend health endpoint is not reachable at {url}: {exc.reason}")
    except Exception as exc:
        report.fail(f"Backend health endpoint check failed at {url}: {exc}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Verify Stalls POS production readiness.")
    parser.add_argument(
        "--apply-migrations",
        action="store_true",
        help="Run idempotent schema catch-up scripts before verification.",
    )
    parser.add_argument(
        "--base-url",
        default=None,
        help="Backend base URL to health-check. Defaults to http://127.0.0.1:$PORT.",
    )
    parser.add_argument(
        "--skip-http",
        action="store_true",
        help="Skip the live /api/health HTTP check.",
    )
    parser.add_argument(
        "--db-timeout",
        type=int,
        default=5,
        help="Database connection timeout in seconds for PostgreSQL checks.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = CheckReport()

    _load_env()
    print("Stalls POS production verification")
    print(f"repo={REPO_ROOT}")

    if args.apply_migrations and not apply_migrations(report):
        return 1

    check_files(report)
    port = check_environment(report)
    database_ok = check_database(report, args.db_timeout)
    if database_ok:
        check_backend_import(report)
    else:
        report.warn("Skipped FastAPI startup import because database verification failed")

    if not args.skip_http:
        base_url = args.base_url or f"http://127.0.0.1:{port}"
        check_http_health(base_url, report)
    else:
        report.warn("Skipped live backend HTTP health check")

    print("")
    print(f"Summary: errors={len(report.errors)}, warnings={len(report.warnings)}")
    if report.errors:
        print("Production verification FAILED.")
        return 1
    print("Production verification PASSED.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
