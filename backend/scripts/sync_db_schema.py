"""
Best-effort DB schema sync script.

What it does:
- Creates missing tables from SQLAlchemy models.
- Adds missing columns to existing tables.

What it does NOT do:
- Drop columns/tables.
- Rename columns.
- Alter existing column types/constraints.

Usage (from repo root):
  python backend/scripts/sync_db_schema.py
"""
from __future__ import annotations

import os
import sys
from typing import Any

from sqlalchemy import inspect, text
from sqlalchemy.schema import DefaultClause

# Allow `from app ...` imports when running as a script.
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from app import create_app  # noqa: E402
from app.models import db  # noqa: E402


def _sql_type(col: Any, dialect_name: str) -> str:
    return col.type.compile(dialect=db.engine.dialect)


def _default_sql(col: Any) -> str:
    sd = col.server_default
    if sd is None:
        return ""
    arg = getattr(sd, "arg", None)
    if arg is None:
        return ""
    # Handle text('...') and plain literals.
    if hasattr(arg, "text"):
        return f" DEFAULT {arg.text}"
    return f" DEFAULT {arg}"


def _column_ddl(table_name: str, col: Any) -> str:
    # SQLite ALTER TABLE is limited. Keep DDL simple and portable.
    parts = [f"ALTER TABLE {table_name} ADD COLUMN {col.name} {_sql_type(col, db.engine.dialect.name)}"]

    # Preserve server-side defaults where possible.
    parts.append(_default_sql(col))

    # Add NOT NULL only when safe-ish.
    # If NOT NULL and no server default, this may fail on non-empty tables.
    if not col.nullable:
        has_default = col.server_default is not None
        if has_default:
            parts.append(" NOT NULL")

    return "".join(parts)


def sync_schema() -> None:
    app = create_app()
    with app.app_context():
        engine = db.engine
        metadata = db.Model.metadata

        print("sync_db_schema: starting")
        print(f"dialect={engine.dialect.name}")

        # Step 1: create missing tables/indexes known by metadata.
        metadata.create_all(bind=engine, checkfirst=True)
        print("create_all: done")

        inspector = inspect(engine)
        table_names = set(inspector.get_table_names())

        added = 0
        skipped_not_nullable = 0

        # Step 2: add missing columns for existing tables.
        for table in metadata.sorted_tables:
            if table.name not in table_names:
                # create_all should already have created it, but keep safe.
                continue

            existing_cols = {c["name"] for c in inspector.get_columns(table.name)}

            for col in table.columns:
                if col.name in existing_cols:
                    continue

                # Safety: skip NOT NULL column with no server default.
                # This commonly fails on populated tables.
                if (not col.nullable) and (col.server_default is None):
                    print(
                        f"SKIP {table.name}.{col.name}: NOT NULL without server_default (manual migration needed)"
                    )
                    skipped_not_nullable += 1
                    continue

                ddl = _column_ddl(table.name, col)
                print(f"ADD {table.name}.{col.name}")
                db.session.execute(text(ddl))
                added += 1

        db.session.commit()
        print("sync_db_schema: complete")
        print(f"columns_added={added}")
        print(f"skipped_not_nullable_without_default={skipped_not_nullable}")


if __name__ == "__main__":
    sync_schema()
