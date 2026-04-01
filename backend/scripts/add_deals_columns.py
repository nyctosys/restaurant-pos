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

def main():
    app = create_app()
    with app.app_context():
        # 1. Add 'is_deal' column to products
        try:
            sql = "ALTER TABLE products ADD COLUMN IF NOT EXISTS is_deal BOOLEAN DEFAULT FALSE"
            db.session.execute(text(sql))
            db.session.commit()
            print("Added column 'products.is_deal'.")
        except (OperationalError, ProgrammingError) as e:
            db.session.rollback()
            if "already exists" in str(e).lower() or "duplicate" in str(e).lower():
                print("Column 'products.is_deal' already exists, skipping.")
            else:
                print(f"Warning: {e}")

        # 2. Create the ComboItem table and any other missing tables
        print("Creating any missing tables (including combo_items)...")
        db.create_all()
        print("Done creating tables.")

    print("Database sync complete.")

if __name__ == "__main__":
    main()
