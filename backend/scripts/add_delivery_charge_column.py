"""Add delivery_charge column to sales (PostgreSQL)."""

from sqlalchemy import inspect, text

from app import create_app
from app.models import db


def main() -> None:
    app = create_app()
    with app.app_context():
        inspector = inspect(db.engine)
        columns = {col["name"] for col in inspector.get_columns("sales")}
        if "delivery_charge" in columns:
            print("sales.delivery_charge already exists")
            return
        db.session.execute(text("ALTER TABLE sales ADD COLUMN delivery_charge NUMERIC(12, 2) DEFAULT 0"))
        db.session.commit()
        print("Added sales.delivery_charge")


if __name__ == "__main__":
    main()
