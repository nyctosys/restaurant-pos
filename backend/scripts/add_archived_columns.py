"""
Add archived_at columns to products, sales, branches, users for archive functionality.
Safe to run multiple times (checks for column existence where possible).

Run from project root:
  python -m backend.scripts.add_archived_columns
Or from backend/:
  python scripts/add_archived_columns.py
"""
import os
import sys

if __name__ == "__main__":
    backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if backend_dir not in sys.path:
        sys.path.insert(0, backend_dir)
    os.chdir(backend_dir)

from dotenv import load_dotenv
load_dotenv()

from app import create_app
from app.models import db
from sqlalchemy import text


def main():
    app = create_app()
    with app.app_context():
        tables_columns = [
            ("products", "archived_at"),
            ("sales", "archived_at"),
            ("branches", "archived_at"),
            ("users", "archived_at"),
        ]
        for table, column in tables_columns:
            try:
                conn = db.session.connection()
                dialect = conn.dialect.name
                if dialect == 'postgresql':
                    r = conn.execute(text("""
                        SELECT 1 FROM information_schema.columns
                        WHERE table_name = :t AND column_name = :c
                    """), {"t": table, "c": column})
                    exists = r.scalar() is not None
                else:
                    exists = False
                if exists:
                    print(f"{table}.{column} already exists, skipping.")
                else:
                    if dialect == 'postgresql':
                        conn.execute(text(f'ALTER TABLE {table} ADD COLUMN {column} TIMESTAMP WITH TIME ZONE'))
                    else:
                        conn.execute(text(f'ALTER TABLE {table} ADD COLUMN {column} DATETIME'))
                    db.session.commit()
                    print(f"Added {table}.{column}.")
            except Exception as e:
                if 'already exists' in str(e).lower() or 'duplicate' in str(e).lower():
                    print(f"{table}.{column} already exists, skipping.")
                    db.session.rollback()
                else:
                    db.session.rollback()
                    raise
        print("Done.")


if __name__ == "__main__":
    main()
