"""
Migrate branch identity from integer IDs to 32-char lowercase hex strings.

PostgreSQL production path:
  - generate a stable random hex ID for each existing branch
  - convert branches.id and every branch_id reference to varchar(32)
  - rewrite all references through the same mapping
  - restore foreign keys to branches.id

Run from backend directory:
  python scripts/migrate_branch_ids_to_hex.py
"""
from __future__ import annotations

import os
import re
import secrets
import sys
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import Connection


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

BRANCH_REF_TABLES = [
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
]

HEX_RE = re.compile(r"^[0-9a-f]{32}$")


def _database_url() -> str:
    load_dotenv(BACKEND_DIR / ".env")
    load_dotenv(BACKEND_DIR / ".env.production", override=False)
    return os.environ.get(
        "DATABASE_URL",
        "postgresql://restaurant_pos:password123@127.0.0.1:5432/restaurant_pos",
    )


def _q(conn: Connection, name: str) -> str:
    return conn.dialect.identifier_preparer.quote(name)


def _is_string_type(type_obj: object) -> bool:
    return "char" in str(type_obj).lower() or "text" in str(type_obj).lower()


def _column_type(inspector, table: str, column: str) -> object | None:
    for col in inspector.get_columns(table):
        if col["name"] == column:
            return col["type"]
    return None


def _new_hex(existing: set[str]) -> str:
    while True:
        value = secrets.token_hex(16)
        if value not in existing:
            existing.add(value)
            return value


def _drop_branch_fks(conn: Connection, inspector, tables: list[str]) -> list[tuple[str, str]]:
    dropped: list[tuple[str, str]] = []
    for table in tables:
        for fk in inspector.get_foreign_keys(table):
            if fk.get("referred_table") == "branches" and "branch_id" in (fk.get("constrained_columns") or []):
                name = fk.get("name")
                if name:
                    conn.execute(text(f'ALTER TABLE {_q(conn, table)} DROP CONSTRAINT {_q(conn, name)}'))
                    dropped.append((table, name))
    return dropped


def _restore_branch_fks(conn: Connection, dropped: list[tuple[str, str]]) -> None:
    for table, name in dropped:
        conn.execute(
            text(
                f'ALTER TABLE {_q(conn, table)} '
                f'ADD CONSTRAINT {_q(conn, name)} FOREIGN KEY (branch_id) REFERENCES branches(id)'
            )
        )


def migrate_postgres(conn: Connection) -> None:
    inspector = inspect(conn)
    tables = [t for t in BRANCH_REF_TABLES if t in inspector.get_table_names() and _column_type(inspector, t, "branch_id")]

    branch_id_type = _column_type(inspector, "branches", "id")
    if branch_id_type is None:
        raise RuntimeError("branches.id column not found")

    branch_rows = conn.execute(text("SELECT id FROM branches ORDER BY id")).scalars().all()
    branch_ids = [str(v) for v in branch_rows]
    already_hex = _is_string_type(branch_id_type) and all(HEX_RE.fullmatch(v or "") for v in branch_ids)
    if already_hex:
        print("branches.id already uses 32-char hex strings")
        return

    existing_hex = {v for v in branch_ids if HEX_RE.fullmatch(v or "")}
    mapping = {old: _new_hex(existing_hex) for old in branch_ids}
    print(f"migrating {len(mapping)} branch id(s) to hex")

    dropped = _drop_branch_fks(conn, inspector, tables)
    conn.execute(text("ALTER TABLE branches ALTER COLUMN id DROP DEFAULT"))

    for table in tables:
        conn.execute(text(f'ALTER TABLE {_q(conn, table)} ALTER COLUMN branch_id TYPE VARCHAR(32) USING branch_id::text'))
    conn.execute(text("ALTER TABLE branches ALTER COLUMN id TYPE VARCHAR(32) USING id::text"))

    for old_id, new_id in mapping.items():
        for table in tables:
            conn.execute(
                text(f'UPDATE {_q(conn, table)} SET branch_id = :new_id WHERE branch_id = :old_id'),
                {"new_id": new_id, "old_id": old_id},
            )
        conn.execute(
            text("UPDATE branches SET id = :new_id WHERE id = :old_id"),
            {"new_id": new_id, "old_id": old_id},
        )

    _restore_branch_fks(conn, dropped)
    print("branch hex migration complete")


def main() -> int:
    engine = create_engine(_database_url())
    if engine.dialect.name != "postgresql":
        raise RuntimeError("Branch ID migration currently supports PostgreSQL production databases only")
    with engine.begin() as conn:
        migrate_postgres(conn)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
