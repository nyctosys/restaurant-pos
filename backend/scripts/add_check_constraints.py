"""
Add check constraints to enforce non-negative amounts and valid status.
Safe to run multiple times; skips constraints that already exist.

Run from project root:
  python -m backend.scripts.add_check_constraints
Or from backend/:
  python scripts/add_check_constraints.py
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

# (constraint_name, table, check_expression)
CONSTRAINTS = [
    ("ck_product_base_price_non_neg", "products", "base_price >= 0"),
    ("ck_inventory_stock_non_neg", "inventory", "stock_level >= 0"),
    ("ck_sale_total_non_neg", "sales", "total_amount >= 0"),
    ("ck_sale_tax_non_neg", "sales", "tax_amount >= 0"),
    ("ck_sale_status_valid", "sales", "status IN ('completed', 'refunded')"),
    ("ck_sale_item_quantity_positive", "sale_items", "quantity > 0"),
    ("ck_sale_item_unit_price_non_neg", "sale_items", "unit_price >= 0"),
    ("ck_sale_item_subtotal_non_neg", "sale_items", "subtotal >= 0"),
]


def constraint_exists(session, name):
    """Check if a constraint already exists (PostgreSQL)."""
    r = session.execute(text("SELECT 1 FROM pg_constraint WHERE conname = :n"), {"n": name})
    return r.fetchone() is not None


def main():
    app = create_app()
    with app.app_context():
        for name, table, expr in CONSTRAINTS:
            try:
                if constraint_exists(db.session, name):
                    print(f"Constraint '{name}' already exists, skipping.")
                    continue
                sql = f"ALTER TABLE {table} ADD CONSTRAINT {name} CHECK ({expr})"
                db.session.execute(text(sql))
                db.session.commit()
                print(f"Added constraint '{name}' on {table}.")
            except (OperationalError, ProgrammingError) as e:
                db.session.rollback()
                if "already exists" in str(e).lower():
                    print(f"Constraint '{name}' already exists, skipping.")
                else:
                    print(f"Warning adding '{name}': {e}")
    print("Done.")


if __name__ == "__main__":
    main()
