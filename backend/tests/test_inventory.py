"""Ingredient stock map and manual adjustment (branch-scoped)."""
import pytest
from app.models import db, Branch, User, Ingredient, IngredientBranchStock
from app.services.branch_ingredient_stock import seed_branch_stocks_for_new_ingredient
from werkzeug.security import generate_password_hash


def _seed_user_branch(app):
    with app.app_context():
        b = Branch(name="Main")
        db.session.add(b)
        db.session.flush()
        u = User(
            username="invuser",
            password_hash=generate_password_hash("pass"),
            role="owner",
            branch_id=b.id,
        )
        db.session.add(u)
        db.session.commit()
        return b.id


def test_stock_list_requires_auth(client):
    r = client.get("/api/stock/")
    assert r.status_code == 401


def test_stock_update_and_list(client, app):
    bid = _seed_user_branch(app)
    with app.app_context():
        ing = Ingredient(name="Flour", unit="kg", current_stock=0.0)
        db.session.add(ing)
        db.session.flush()
        seed_branch_stocks_for_new_ingredient(ing.id, 0.0)
        row = IngredientBranchStock.query.filter_by(ingredient_id=ing.id, branch_id=bid).first()
        row.current_stock = 5.0
        db.session.commit()
        iid = ing.id

    r = client.post("/api/auth/login", json={"username": "invuser", "password": "pass"})
    token = r.get_json()["token"]
    h = {"Authorization": f"Bearer {token}"}

    r = client.get("/api/stock/", headers=h)
    assert r.status_code == 200
    inv = r.get_json()["ingredient_stock"]
    assert str(iid) in inv
    assert inv[str(iid)] == 5

    r2 = client.post(
        "/api/stock/update",
        headers=h,
        json={"ingredient_id": iid, "stock_delta": 3, "branch_id": bid},
    )
    assert r2.status_code == 200
    assert r2.get_json().get("stock_level") == 8

    r3 = client.get("/api/stock/transactions?time_filter=today", headers=h)
    assert r3.status_code == 200
    assert len(r3.get_json().get("transactions") or []) >= 1


def test_stock_transactions_requires_auth(client):
    r = client.get("/api/stock/transactions?time_filter=today")
    assert r.status_code == 401
