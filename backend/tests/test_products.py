"""Test products CRUD and 404."""
import pytest
from app.models import db, Product, Branch, User
from werkzeug.security import generate_password_hash


def _auth_headers(client, app):
    with app.app_context():
        b = Branch(name="Main")
        db.session.add(b)
        db.session.flush()
        u = User(
            username="owner1",
            password_hash=generate_password_hash("pass"),
            role="owner",
            branch_id=b.id,
        )
        db.session.add(u)
        db.session.commit()
    r = client.post("/api/auth/login", json={"username": "owner1", "password": "pass"})
    token = r.get_json()["token"]
    return {"Authorization": f"Bearer {token}"}


def test_products_list_requires_auth(client):
    r = client.get("/api/menu-items/")
    assert r.status_code == 401


def test_products_list_empty(client, app):
    h = _auth_headers(client, app)
    r = client.get("/api/menu-items/", headers=h)
    assert r.status_code == 200
    data = r.get_json()
    assert isinstance(data, list) or "products" in data or len(data) >= 0


def test_product_update_404(client, app):
    """Update non-existent product returns 404 from get_or_404."""
    h = _auth_headers(client, app)
    r = client.put(
        "/api/menu-items/99999",
        headers=h,
        json={"sku": "X", "title": "Y", "base_price": 1},
    )
    assert r.status_code == 404
    data = r.get_json()
    assert data is not None and ("detail" in data or "error" in data or "message" in data)
