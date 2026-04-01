"""Add modifiers and parent_sale_item_id columns to sale_items (PostgreSQL)."""
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app import create_app
from app.models import db
from sqlalchemy import text

app = create_app()

def migrate():
    with app.app_context():
        print("Starting migration: add modifiers + parent_sale_item_id to sale_items ...")
        conn = db.session.connection()

        # Check which columns already exist
        result = conn.execute(text(
            "SELECT column_name FROM information_schema.columns WHERE table_name='sale_items'"
        ))
        existing = {row[0] for row in result}
        print(f"  Existing columns: {existing}")

        if 'modifiers' not in existing:
            conn.execute(text("ALTER TABLE sale_items ADD COLUMN modifiers JSON"))
            print("  ✓ Added modifiers column")
        else:
            print("  – modifiers already exists")

        if 'parent_sale_item_id' not in existing:
            conn.execute(text(
                "ALTER TABLE sale_items ADD COLUMN parent_sale_item_id INTEGER REFERENCES sale_items(id)"
            ))
            print("  ✓ Added parent_sale_item_id column")
        else:
            print("  – parent_sale_item_id already exists")

        db.session.commit()
        print("Migration complete.")

if __name__ == "__main__":
    migrate()
