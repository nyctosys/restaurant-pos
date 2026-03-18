"""Test inventory get/update and invalid branch/product."""
import pytest
from app.models import db, Branch, User, Product, Inventory
from werkzeug.security import generate_password_hash


def _auth_headers(client, app, role="owner"):
    with app.app_context():
        b = Branch(name="Main")
        db.session.add(b)
        db.session.flush()
        u = User(
            username="owner1",
            password_hash=generate_password_hash("pass"),
            role=role,
            branch_id=b.id,
        )
        db.session.add(u)
        db.session.commit()
    r = client.post("/api/auth/login", json={"username": "owner1", "password": "pass"})
    token = r.get_json()["token"]
    return {"Authorization": f"Bearer {token}"}


def test_inventory_list_requires_auth(client):
    r = client.get("/api/stock/")
    assert r.status_code == 401


def test_inventory_update_success(client, app):
    h = _auth_headers(client, app)
    with app.app_context():
        b = Branch.query.filter_by(name="Main").first()
        p = Product(sku="SKU1", title="X", base_price=10)
        db.session.add(p)
        db.session.flush()
        inv = Inventory(branch_id=b.id, product_id=p.id, stock_level=5)
        db.session.add(inv)
        db.session.commit()
        bid, pid = b.id, p.id
    r = client.post(
        "/api/stock/update",
        headers=h,
        json={"branch_id": bid, "product_id": pid, "stock_delta": 3},
    )
    assert r.status_code == 200
    data = r.get_json()
    assert data.get("stock_level") == 8


def test_stock_transactions_requires_auth(client):
    r = client.get("/api/stock/transactions?time_filter=today")
    assert r.status_code == 401


def test_stock_transactions_returns_list(client, app):
    h = _auth_headers(client, app)
    r = client.get("/api/stock/transactions?time_filter=today", headers=h)
    assert r.status_code == 200
    data = r.get_json()
    assert "transactions" in data
    assert isinstance(data["transactions"], list)
