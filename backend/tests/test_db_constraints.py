"""Test DB check constraints: negative values rejected, rollback on violation."""
import pytest
from app.models import db, Sale, SaleItem, Product, Branch, User, Ingredient, IngredientBranchStock
from werkzeug.security import generate_password_hash


def test_sale_item_quantity_positive_enforced(app):
    with app.app_context():
        b = Branch(name="Main")
        db.session.add(b)
        db.session.flush()
        u = User(
            username="u1",
            password_hash=generate_password_hash("x"),
            role="cashier",
            branch_id=b.id,
        )
        db.session.add(u)
        db.session.flush()
        s = Sale(
            branch_id=b.id,
            user_id=u.id,
            total_amount=10,
            tax_amount=0,
            payment_method="Cash",
        )
        db.session.add(s)
        db.session.flush()
        p = Product(sku="SKU1", title="X", base_price=10)
        db.session.add(p)
        db.session.flush()
        try:
            item = SaleItem(
                sale_id=s.id,
                product_id=p.id,
                quantity=0,
                unit_price=10,
                subtotal=0,
            )
            db.session.add(item)
            db.session.commit()
            pytest.fail("Expected constraint violation")
        except Exception as e:
            db.session.rollback()
            assert "quantity" in str(e).lower() or "check" in str(e).lower() or "constraint" in str(e).lower()


def test_ingredient_branch_stock_non_negative_enforced(app):
    with app.app_context():
        b = Branch(name="Main")
        db.session.add(b)
        db.session.flush()
        ing = Ingredient(name="Sugar", unit="kg", current_stock=0.0)
        db.session.add(ing)
        db.session.flush()
        row = IngredientBranchStock(ingredient_id=ing.id, branch_id=b.id, current_stock=-1.0)
        db.session.add(row)
        try:
            db.session.commit()
            pytest.fail("Expected constraint violation for negative ingredient branch stock")
        except Exception as e:
            db.session.rollback()
            assert "stock" in str(e).lower() or "check" in str(e).lower() or "constraint" in str(e).lower()
