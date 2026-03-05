"""
Add discount-related columns to the sales table.
Safe to run multiple times; uses ADD COLUMN IF NOT EXISTS.

Run from project root:
  python -m backend.scripts.add_sale_discount_columns
Or from backend/:
  python scripts/add_sale_discount_columns.py
"""
import os
import sys

# Allow running as script or as module from backend/
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

# Columns to add on sales (name, type, description)
SALE_ADDITIONS = [
    ("discount_amount", "NUMERIC(12, 2) DEFAULT 0", "Discount amount applied at checkout"),
    ("discount_id", "VARCHAR(64)", "ID of the discount preset used"),
    ("discount_snapshot", "JSONB", "Snapshot of discount (name, type, value) for receipt/audit"),
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
