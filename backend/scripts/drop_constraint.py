from app import create_app
from app.models import db
from sqlalchemy import text

app = create_app()
with app.app_context():
    try:
        db.session.execute(text("ALTER TABLE sales DROP CONSTRAINT ck_sale_kitchen_status_valid;"))
        db.session.commit()
        print("Dropped ck_sale_kitchen_status_valid")
    except Exception as e:
        print(e)
        db.session.rollback()
