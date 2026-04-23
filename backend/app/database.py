"""
Database initialization for the FastAPI application.

HTTP is served only by FastAPI (`app.main:app`). This module configures
SQLAlchemy (engine, per-request session via contextvars, schema) — no Flask runtime.
"""
import os
import time
from contextlib import contextmanager

from dotenv import load_dotenv

from app.db import bind_request_session, unbind_request_session
from app.models import db

load_dotenv()

# Shared config for tests (conftest sets TESTING) — not a Flask app.
APP_CONFIG = {
    "TESTING": False,
    "SECRET_KEY": os.environ.get("SECRET_KEY", "dev_secret_key_change_in_production"),
}


class AppShell:
    """Test/script compatibility shim (replaces Flask app shell)."""

    config = APP_CONFIG

    @contextmanager
    def app_context(self):
        """Scope DB session like Flask's app_context for tests and scripts."""
        token = bind_request_session()
        try:
            yield
        finally:
            unbind_request_session(token)


def create_app():
    """
    Initialize the database engine and create tables if needed.
    Kept for compatibility with tests and scripts that call create_app().
    """
    _init_database_core()
    return AppShell()


def _init_database_core() -> None:
    """Create engine, tables, and run lightweight migrations."""
    database_uri = os.environ.get(
        "DATABASE_URL",
        "postgresql://restaurant_pos:password123@127.0.0.1:5432/restaurant_pos",
    )
    db.init_engine(database_uri)

    _tok = bind_request_session()
    try:
        retries = 10
        for i in range(retries):
            try:
                db.create_all()
                print("Database tables created successfully.")
                from sqlalchemy import text
                from sqlalchemy.exc import OperationalError, ProgrammingError

                try:
                    db.session.execute(
                        text("ALTER TABLE sales ADD COLUMN status VARCHAR(20) DEFAULT 'completed'")
                    )
                    db.session.commit()
                    print("Added 'status' column to 'sales' table.")
                except (OperationalError, ProgrammingError):
                    db.session.rollback()
                try:
                    db.session.execute(text("ALTER TABLE sales ADD COLUMN kitchen_status VARCHAR(20)"))
                    db.session.commit()
                    print("Added 'kitchen_status' column to 'sales' table.")
                except (OperationalError, ProgrammingError):
                    db.session.rollback()
                try:
                    db.session.execute(
                        text(
                            "ALTER TABLE sales ADD COLUMN service_charge NUMERIC(12, 2) DEFAULT 0"
                        )
                    )
                    db.session.commit()
                    print("Added 'service_charge' column to 'sales' table.")
                except (OperationalError, ProgrammingError):
                    db.session.rollback()
                try:
                    dname = db.engine.dialect.name
                    col_sql = "TIMESTAMPTZ" if dname == "postgresql" else "TIMESTAMP"
                    db.session.execute(
                        text(f"ALTER TABLE sales ADD COLUMN kitchen_ready_at {col_sql}")
                    )
                    db.session.commit()
                    print("Added 'kitchen_ready_at' column to 'sales' table.")
                except (OperationalError, ProgrammingError):
                    db.session.rollback()
                try:
                    db.session.execute(
                        text(
                            "ALTER TABLE recipe_items ADD COLUMN variant_key VARCHAR(100) NOT NULL DEFAULT ''"
                        )
                    )
                    db.session.commit()
                    print("Added 'variant_key' column to 'recipe_items' table.")
                except (OperationalError, ProgrammingError):
                    db.session.rollback()
                try:
                    db.session.execute(text("ALTER TABLE suppliers ADD COLUMN sku VARCHAR(100)"))
                    db.session.commit()
                    print("Added 'sku' column to 'suppliers' table.")
                except (OperationalError, ProgrammingError):
                    db.session.rollback()
                break
            except Exception as e:
                if i < retries - 1:
                    print(f"DB not ready (attempt {i + 1}/{retries}), retrying in 2s... ({e})")
                    time.sleep(2)
                else:
                    print(f"Failed to create DB tables after {retries} attempts: {e}")
                    raise
    finally:
        unbind_request_session(_tok)
