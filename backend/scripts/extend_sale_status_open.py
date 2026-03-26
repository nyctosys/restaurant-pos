"""
One-off migration: allow Sale.status = 'open' for unpaid dine-in tabs (KOT before payment).

Run from backend/:
  python scripts/extend_sale_status_open.py
"""

from __future__ import annotations

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


def main() -> None:
    app = create_app()
    with app.app_context():
        db.session.execute(text("ALTER TABLE sales DROP CONSTRAINT IF EXISTS ck_sale_status_valid"))
        db.session.execute(
            text(
                "ALTER TABLE sales ADD CONSTRAINT ck_sale_status_valid "
                "CHECK (status IN ('completed', 'refunded', 'open'))"
            )
        )
        db.session.commit()
        print("Migration OK: ck_sale_status_valid now includes 'open'.")


if __name__ == "__main__":
    main()
