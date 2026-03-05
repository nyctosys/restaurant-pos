"""
Drop all tables and recreate them from models (fresh start).
All data will be lost. Use only when you want an empty database.

Run from project root:
  python -m backend.scripts.reset_db
Or from backend/:
  python scripts/reset_db.py
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


def main():
    app = create_app()
    with app.app_context():
        db.drop_all()
        print("Dropped all tables.")
        db.create_all()
        print("Created all tables. Database is fresh (no data).")


if __name__ == "__main__":
    main()
