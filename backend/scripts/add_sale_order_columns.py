"""
Add order_type and order_snapshot to the sales table.
Safe to run multiple times; uses ADD COLUMN IF NOT EXISTS.

Run from project root:
  python -m backend.scripts.add_sale_order_columns
Or from backend/:
  python scripts/add_sale_order_columns.py
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
from sqlalchemy.exc import OperationalError, ProgrammingError

SALE_ADDITIONS = [
    ("order_type", "VARCHAR(20)", "takeaway | dine_in | delivery"),
    ("order_snapshot", "JSONB", "table or delivery customer details"),
]


def main():
    app = create_app()
    with app.app_context():
        for col_name, col_type_default, description in SALE_ADDITIONS:
            try:
                sql = f"ALTER TABLE sales ADD COLUMN IF NOT EXISTS {col_name} {col_type_default}"
                db.session.execute(text(sql))
                db.session.commit()
                print(f"Added column 'sales.{col_name}' ({description}).")
            except (OperationalError, ProgrammingError) as e:
                db.session.rollback()
                if "already exists" in str(e).lower() or "duplicate" in str(e).lower():
                    print(f"Column 'sales.{col_name}' already exists, skipping.")
                else:
                    print(f"Warning: {e}")
    print("Done.")


if __name__ == "__main__":
    main()
