"""
Make sale_items.product_id nullable so products can be deleted while keeping
sale history (past sale lines show as "Unknown" or similar when product is removed).

Run from project root:
  python -m backend.scripts.allow_null_product_id_on_sale_items
Or from backend/:
  python scripts/allow_null_product_id_on_sale_items.py
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


def main():
    app = create_app()
    with app.app_context():
        try:
            # PostgreSQL
            db.session.execute(text("ALTER TABLE sale_items ALTER COLUMN product_id DROP NOT NULL"))
            db.session.commit()
            print("sale_items.product_id is now nullable (products can be deleted).")
        except (OperationalError, ProgrammingError) as e:
            db.session.rollback()
            err = str(e).lower()
            if "already" in err or "null" in err:
                print("sale_items.product_id is already nullable. Nothing to do.")
            else:
                raise


if __name__ == "__main__":
    main()
