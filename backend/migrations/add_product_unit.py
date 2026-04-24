"""
Migration: add `unit` column to products table (nullable VARCHAR 50).
Safe to run multiple times — skips if column already exists.
"""
import sys
import os

# Ensure backend package root is on the path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app import create_app
from app.models import db


def upgrade():
    app = create_app()
    with app.app_context():
        with db.engine.connect() as conn:
            from sqlalchemy import inspect, text
            inspector = inspect(db.engine)
            existing_cols = {c["name"] for c in inspector.get_columns("products")}
            if "unit" not in existing_cols:
                conn.execute(text("ALTER TABLE products ADD COLUMN unit VARCHAR(50)"))
                conn.commit()
                print("✅ Added `unit` column to products table.")
            else:
                print("ℹ️  `unit` column already exists on products — skipping.")


if __name__ == "__main__":
    upgrade()
