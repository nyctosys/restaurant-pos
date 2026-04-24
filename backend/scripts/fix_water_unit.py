import sys
sys.path.insert(0, '.')
from app import create_app
from app.models import db
from sqlalchemy import text

app = create_app()
with app.app_context():
    with db.engine.connect() as conn:
        result = conn.execute(text("UPDATE products SET unit = 'ml' WHERE lower(title) LIKE '%water%'"))
        conn.commit()
        print('Updated', result.rowcount, 'row(s)')
    from app.models import Product
    p = Product.query.filter(Product.title.ilike('%water%')).first()
    print('Verify unit now:', repr(p.unit) if p else 'not found')
