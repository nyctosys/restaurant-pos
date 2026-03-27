"""
Add missing columns to the products table (e.g. image_url, created_at)
and to the sales table (discount columns).
Safe to run multiple times; uses ADD COLUMN IF NOT EXISTS.

Run from project root:
  python -m scripts.add_product_columns
Or from backend/:
  python scripts/add_product_columns.py
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

# Columns that may be missing on older DBs (name, type, default)
# image_url as TEXT to support base64 data URLs (can be very long)
PRODUCT_ADDITIONS = [
    ("image_url", "TEXT DEFAULT ''", "Product image URL or data URL"),
    ("created_at", "TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP", "Product creation time"),
]


def main():
    app = create_app()
    with app.app_context():
        for col_name, col_type_default, description in PRODUCT_ADDITIONS:
            try:
                # PostgreSQL: ADD COLUMN IF NOT EXISTS
                sql = f"ALTER TABLE products ADD COLUMN IF NOT EXISTS {col_name} {col_type_default}"
                db.session.execute(text(sql))
                db.session.commit()
                print(f"Added column 'products.{col_name}' ({description}).")
            except (OperationalError, ProgrammingError) as e:
                db.session.rollback()
                # Column exists or table missing
                if "already exists" in str(e).lower() or "duplicate" in str(e).lower():
                    print(f"Column 'products.{col_name}' already exists, skipping.")
                else:
                    print(f"Warning: {e}")

        # Widen image_url to TEXT if it was created as VARCHAR(512) (base64 data URLs need more space)
        try:
            db.session.execute(text("ALTER TABLE products ALTER COLUMN image_url TYPE TEXT"))
            db.session.commit()
            print("Ensured 'products.image_url' is TEXT.")
        except (OperationalError, ProgrammingError) as e:
            db.session.rollback()
            if "type" in str(e).lower() or "already" in str(e).lower():
                pass  # Already TEXT or no-op
            else:
                print(f"Warning (image_url alter): {e}")

    print("Done.")


if __name__ == "__main__":
    main()
