"""Test sales: checkout success and validation, refund, bad scenarios."""
import pytest
from app.models import db, User, Branch, Product, Inventory, Sale, SaleItem, Setting
from werkzeug.security import generate_password_hash


def _setup_owner_and_branch(app):
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
        return u.id, b.id


def _get_token(client, username="owner1", password="pass"):
    r = client.post("/api/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200
    return r.get_json()["token"]


def _create_product_and_inventory(app, branch_id, title="Widget", stock=10):
    with app.app_context():
        p = Product(sku="SKU1", title=title, base_price=10.0)
        db.session.add(p)
        db.session.flush()
        inv = Inventory(branch_id=branch_id, product_id=p.id, variant_sku_suffix="", stock_level=stock)
        db.session.add(inv)
        db.session.commit()
        return p.id


def test_checkout_success(client, app):
    client.post(
        "/api/auth/setup",
        json={"username": "owner1", "password": "pass", "branch_name": "Main"},
    )
    token = _get_token(client)
    with app.app_context():
        b = Branch.query.filter_by(name="Main").first()
        bid = b.id
    pid = _create_product_and_inventory(app, bid, "Widget", 10)

    r = client.post(
        "/api/orders/checkout",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "items": [{"product_id": pid, "quantity": 2}],
            "payment_method": "Cash",
            "branch_id": bid,
        },
    )
    assert r.status_code == 201
    data = r.get_json()
    assert "sale_id" in data
    assert data.get("total") == 20.0  # 2 * 10


def test_checkout_empty_cart(client, app):
    client.post(
        "/api/auth/setup",
        json={"username": "owner1", "password": "pass", "branch_name": "Main"},
    )
    token = _get_token(client)
    r = client.post(
        "/api/orders/checkout",
        headers={"Authorization": f"Bearer {token}"},
        json={"items": [], "payment_method": "Cash", "branch_id": 1},
    )
    assert r.status_code == 400
    assert "cart" in (r.get_json().get("message") or "").lower()


def test_checkout_missing_payment_method(client, app):
    client.post(
        "/api/auth/setup",
        json={"username": "owner1", "password": "pass", "branch_name": "Main"},
    )
    token = _get_token(client)
    r = client.post(
        "/api/orders/checkout",
        headers={"Authorization": f"Bearer {token}"},
        json={"items": [{"product_id": 1, "quantity": 1}], "branch_id": 1},
    )
    assert r.status_code == 400


def test_checkout_invalid_product_id(client, app):
    client.post(
        "/api/auth/setup",
        json={"username": "owner1", "password": "pass", "branch_name": "Main"},
    )
    token = _get_token(client)
    with app.app_context():
        b = Branch.query.filter_by(name="Main").first()
        bid = b.id
    r = client.post(
        "/api/orders/checkout",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "items": [{"product_id": 99999, "quantity": 1}],
            "payment_method": "Cash",
            "branch_id": bid,
        },
    )
    assert r.status_code == 400
    assert "not found" in (r.get_json().get("message") or "").lower()


def test_checkout_insufficient_stock(client, app):
    client.post(
        "/api/auth/setup",
        json={"username": "owner1", "password": "pass", "branch_name": "Main"},
    )
    token = _get_token(client)
    with app.app_context():
        b = Branch.query.filter_by(name="Main").first()
        bid = b.id
    pid = _create_product_and_inventory(app, bid, "Widget", 2)  # only 2 in stock

    r = client.post(
        "/api/orders/checkout",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "items": [{"product_id": pid, "quantity": 5}],
            "payment_method": "Cash",
            "branch_id": bid,
        },
    )
    assert r.status_code == 400
    assert "insufficient" in (r.get_json().get("message") or "").lower()


def test_checkout_negative_quantity_rejected(client, app):
    client.post(
        "/api/auth/setup",
        json={"username": "owner1", "password": "pass", "branch_name": "Main"},
    )
    token = _get_token(client)
    with app.app_context():
        b = Branch.query.filter_by(name="Main").first()
        bid = b.id
    pid = _create_product_and_inventory(app, bid, "Widget", 10)

    r = client.post(
        "/api/orders/checkout",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "items": [{"product_id": pid, "quantity": -1}],
            "payment_method": "Cash",
            "branch_id": bid,
        },
    )
    assert r.status_code == 400
    assert "quantity" in (r.get_json().get("message") or "").lower()


def test_checkout_zero_quantity_rejected(client, app):
    client.post(
        "/api/auth/setup",
        json={"username": "owner1", "password": "pass", "branch_name": "Main"},
    )
    token = _get_token(client)
    with app.app_context():
        b = Branch.query.filter_by(name="Main").first()
        bid = b.id
    pid = _create_product_and_inventory(app, bid, "Widget", 10)

    r = client.post(
        "/api/orders/checkout",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "items": [{"product_id": pid, "quantity": 0}],
            "payment_method": "Cash",
            "branch_id": bid,
        },
    )
    assert r.status_code == 400


def test_refund_success(client, app):
    client.post(
        "/api/auth/setup",
        json={"username": "owner1", "password": "pass", "branch_name": "Main"},
    )
    token = _get_token(client)
    with app.app_context():
        b = Branch.query.filter_by(name="Main").first()
        bid = b.id
    pid = _create_product_and_inventory(app, bid, "Widget", 10)
    r = client.post(
        "/api/orders/checkout",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "items": [{"product_id": pid, "quantity": 2}],
            "payment_method": "Cash",
            "branch_id": bid,
        },
    )
    assert r.status_code == 201
    sale_id = r.get_json()["sale_id"]

    r2 = client.post(
        f"/api/orders/{sale_id}/rollback",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r2.status_code == 200
    assert "rolled back" in (r2.get_json().get("message") or "").lower()


def test_refund_already_refunded_returns_400(client, app):
    client.post(
        "/api/auth/setup",
        json={"username": "owner1", "password": "pass", "branch_name": "Main"},
    )
    token = _get_token(client)
    with app.app_context():
        b = Branch.query.filter_by(name="Main").first()
        bid = b.id
    pid = _create_product_and_inventory(app, bid, "Widget", 10)
    r = client.post(
        "/api/orders/checkout",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "items": [{"product_id": pid, "quantity": 1}],
            "payment_method": "Cash",
            "branch_id": bid,
        },
    )
    sale_id = r.get_json()["sale_id"]
    client.post(f"/api/orders/{sale_id}/rollback", headers={"Authorization": f"Bearer {token}"})

    r2 = client.post(
        f"/api/orders/{sale_id}/rollback",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r2.status_code == 400
    assert "already refunded" in (r2.get_json().get("message") or "").lower()


def test_refund_nonexistent_sale_returns_404(client, app):
    client.post(
        "/api/auth/setup",
        json={"username": "owner1", "password": "pass", "branch_name": "Main"},
    )
    token = _get_token(client)
    r = client.post(
        "/api/orders/99999/rollback",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 404
