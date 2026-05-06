"""
Refresh/repair DB schema to match backend models WITHOUT losing data.

This is for deployed systems: it does NOT drop tables and does NOT delete rows.
It runs the repo's existing idempotent repair/migration scripts in a safe order.

Usage (from repo root):
  python backend/scripts/refresh_db_safe.py

Usage (from backend/):
  python scripts/refresh_db_safe.py

Optional:
  python backend/scripts/refresh_db_safe.py --database-url "postgresql://..."
  python backend/scripts/refresh_db_safe.py --backup

Notes:
- `--backup` uses `pg_dump` if available in PATH (PostgreSQL only).
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path


BACKEND_DIR = Path(__file__).resolve().parents[1]


def _load_dotenvs() -> None:
    # Keep dependencies minimal; dotenv is already in backend/requirements.txt.
    try:
        from dotenv import load_dotenv  # type: ignore
    except Exception:
        return

    load_dotenv(BACKEND_DIR / ".env")
    load_dotenv(BACKEND_DIR / ".env.production", override=False)


def _looks_like_postgres_url(database_url: str) -> bool:
    return database_url.startswith("postgresql://") or database_url.startswith("postgres://")


def _safe_filename(s: str) -> str:
    return re.sub(r"[^a-zA-Z0-9._-]+", "_", s).strip("_")


def _pg_dump_backup(database_url: str) -> Path:
    ts = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    out_dir = BACKEND_DIR / "backups"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"pg_dump_{ts}.dump"

    # We avoid parsing the URL ourselves; pg_dump accepts it directly.
    # Custom format (-Fc) is compact and restorable via pg_restore.
    cmd = ["pg_dump", database_url, "-Fc", "-f", str(out_path)]
    subprocess.run(cmd, check=True)
    return out_path


def _run_python_module(path: Path, argv: list[str]) -> None:
    # Execute a repo script in-process so it shares env + sys.path defaults.
    import runpy

    old_argv = sys.argv[:]
    try:
        sys.argv = [str(path), *argv]
        runpy.run_path(str(path), run_name="__main__")
    finally:
        sys.argv = old_argv


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Safely refresh DB schema (no data loss): repair missing tables/columns and apply idempotent migrations."
    )
    parser.add_argument(
        "--database-url",
        default=None,
        help="Database URL. Defaults to DATABASE_URL env var (loaded from backend/.env and backend/.env.production).",
    )
    parser.add_argument(
        "--backup",
        action="store_true",
        help="Before applying changes, run pg_dump backup (PostgreSQL only; requires pg_dump in PATH).",
    )
    args = parser.parse_args()

    _load_dotenvs()
    database_url = args.database_url or os.environ.get("DATABASE_URL")

    if not database_url:
        print(
            "[ERROR] DATABASE_URL is not set. Provide --database-url or set DATABASE_URL in backend/.env / backend/.env.production.",
            file=sys.stderr,
        )
        return 2

    if args.backup:
        if not _looks_like_postgres_url(database_url):
            print("[WARN] --backup requested but DB does not look like PostgreSQL; skipping backup.")
        else:
            try:
                out = _pg_dump_backup(database_url)
                print(f"[OK] Backup created: {out}")
            except FileNotFoundError:
                print("[WARN] pg_dump not found in PATH; skipping backup.")
            except subprocess.CalledProcessError as exc:
                print(f"[ERROR] pg_dump failed: {exc}", file=sys.stderr)
                return 3

    # Ensure backend package root is importable for repo scripts.
    if str(BACKEND_DIR) not in sys.path:
        sys.path.insert(0, str(BACKEND_DIR))

    # Run the existing safe repair script first (handles schema drift and type fixes).
    print("[INFO] Running fix_production_schema.py (safe repair)...")
    os.environ["DATABASE_URL"] = database_url
    _run_python_module(BACKEND_DIR / "scripts" / "fix_production_schema.py", ["--database-url", database_url])

    # Then run targeted idempotent migrations (adds specific columns/tables/indexes + backfills).
    print("[INFO] Running migrate_latest_schema_changes.py (idempotent migrations)...")
    _run_python_module(BACKEND_DIR / "scripts" / "migrate_latest_schema_changes.py", [])

    # Finally, best-effort metadata sync to create any newly-added tables and add any missing nullable/defaulted columns.
    print("[INFO] Running sync_db_schema.py (best-effort metadata sync)...")
    _run_python_module(BACKEND_DIR / "scripts" / "sync_db_schema.py", [])

    print("[OK] refresh_db_safe complete (no data dropped).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

