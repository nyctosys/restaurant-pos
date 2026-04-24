import sys
sys.path.insert(0, '.')
from app import create_app
from app.models import db, Product, RecipeItem
from app.routers.menu import _product_to_dict
from sqlalchemy.orm import joinedload

app = create_app()
with app.app_context():
    try:
        products = Product.query.options(joinedload(Product.recipe_items)).all()
        for p in products:
            d = _product_to_dict(p)
            print(p.title, '| DB unit:', repr(p.unit), '| API unit:', repr(d.get('unit')), '| API uom:', repr(d.get('unitOfMeasure')))
    except Exception as e:
        import traceback
        traceback.print_exc()
