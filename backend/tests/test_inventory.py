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


def test_bulk_restock_success_updates_multiple_ingredients(client, app):
    bid = _seed_user_branch(app)
    with app.app_context():
        ing1 = Ingredient(name="Rice", unit="kg", current_stock=0.0, average_cost=10.0, last_purchase_price=9.0)
        ing2 = Ingredient(name="Oil", unit="l", current_stock=0.0, average_cost=4.0, last_purchase_price=4.0)
        db.session.add_all([ing1, ing2])
        db.session.flush()
        seed_branch_stocks_for_new_ingredient(ing1.id, 0.0)
        seed_branch_stocks_for_new_ingredient(ing2.id, 0.0)
        row1 = IngredientBranchStock.query.filter_by(ingredient_id=ing1.id, branch_id=bid).first()
        row2 = IngredientBranchStock.query.filter_by(ingredient_id=ing2.id, branch_id=bid).first()
        row1.current_stock = 5.0
        row2.current_stock = 2.0
        db.session.commit()
        iid1, iid2 = ing1.id, ing2.id

    login = client.post("/api/auth/login", json={"username": "invuser", "password": "pass"})
    token = login.get_json()["token"]
    headers = {"Authorization": f"Bearer {token}"}

    res = client.post(
        "/api/stock/bulk-restock",
        headers=headers,
        json={
            "reason": "Vendor delivery",
            "items": [
                {"ingredient_id": iid1, "quantity": 3, "unit_cost": 100},
                {"ingredient_id": iid2, "quantity": 4},
            ],
        },
    )
    assert res.status_code == 200
    body = res.get_json()
    assert body.get("message") == "Bulk restock completed"
    assert len(body.get("results") or []) == 2
    assert body["results"][0]["average_cost"] == pytest.approx(43.75)
    assert body["results"][0]["last_purchase_price"] == pytest.approx(100.0)

    with app.app_context():
        row1 = IngredientBranchStock.query.filter_by(ingredient_id=iid1, branch_id=bid).first()
        row2 = IngredientBranchStock.query.filter_by(ingredient_id=iid2, branch_id=bid).first()
        ing1 = db.session.get(Ingredient, iid1)
        ing2 = db.session.get(Ingredient, iid2)
        assert row1.current_stock == pytest.approx(8.0)
        assert row2.current_stock == pytest.approx(6.0)
        assert ing1.average_cost == pytest.approx(43.75)
        assert ing1.last_purchase_price == pytest.approx(100.0)
        assert ing2.average_cost == pytest.approx(4.0)
        assert ing1.current_stock == pytest.approx(8.0)
        assert ing2.current_stock == pytest.approx(6.0)


def test_bulk_restock_explicit_zero_cost_updates_average_cost(client, app):
    bid = _seed_user_branch(app)
    with app.app_context():
        ing = Ingredient(name="Promo Sauce", unit="l", current_stock=0.0, average_cost=20.0, last_purchase_price=20.0)
        db.session.add(ing)
        db.session.flush()
        seed_branch_stocks_for_new_ingredient(ing.id, 0.0)
        row = IngredientBranchStock.query.filter_by(ingredient_id=ing.id, branch_id=bid).first()
        row.current_stock = 5.0
        db.session.commit()
        iid = ing.id

    login = client.post("/api/auth/login", json={"username": "invuser", "password": "pass"})
    token = login.get_json()["token"]
    headers = {"Authorization": f"Bearer {token}"}

    res = client.post(
        "/api/stock/bulk-restock",
        headers=headers,
        json={"items": [{"ingredient_id": iid, "quantity": 5, "unit_cost": 0}]},
    )
    assert res.status_code == 200
    body = res.get_json()
    assert body["results"][0]["average_cost"] == pytest.approx(10.0)
    assert body["results"][0]["last_purchase_price"] == pytest.approx(0.0)

    with app.app_context():
        ing = db.session.get(Ingredient, iid)
        assert ing.average_cost == pytest.approx(10.0)
        assert ing.last_purchase_price == pytest.approx(0.0)


def test_bulk_restock_unknown_ingredient_is_atomic(client, app):
    bid = _seed_user_branch(app)
    with app.app_context():
        ing = Ingredient(name="Sugar", unit="kg", current_stock=0.0, average_cost=8.0)
        db.session.add(ing)
        db.session.flush()
        seed_branch_stocks_for_new_ingredient(ing.id, 0.0)
        row = IngredientBranchStock.query.filter_by(ingredient_id=ing.id, branch_id=bid).first()
        row.current_stock = 5.0
        db.session.commit()
        iid = ing.id

    login = client.post("/api/auth/login", json={"username": "invuser", "password": "pass"})
    token = login.get_json()["token"]
    headers = {"Authorization": f"Bearer {token}"}

    res = client.post(
        "/api/stock/bulk-restock",
        headers=headers,
        json={
            "items": [
                {"ingredient_id": iid, "quantity": 2},
                {"ingredient_id": 999999, "quantity": 1},
            ]
        },
    )
    assert res.status_code == 404

    with app.app_context():
        row = IngredientBranchStock.query.filter_by(ingredient_id=iid, branch_id=bid).first()
        assert row.current_stock == pytest.approx(5.0)


def test_bulk_restock_validation_and_auth(client, app):
    _seed_user_branch(app)
    login = client.post("/api/auth/login", json={"username": "invuser", "password": "pass"})
    token = login.get_json()["token"]
    headers = {"Authorization": f"Bearer {token}"}

    no_items = client.post("/api/stock/bulk-restock", headers=headers, json={"items": []})
    assert no_items.status_code == 422

    bad_qty = client.post(
        "/api/stock/bulk-restock",
        headers=headers,
        json={"items": [{"ingredient_id": 1, "quantity": 0}]},
    )
    assert bad_qty.status_code == 422

    unauth = client.post("/api/stock/bulk-restock", json={"items": [{"ingredient_id": 1, "quantity": 1}]})
    assert unauth.status_code == 401
