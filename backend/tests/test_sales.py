"""Test sales: checkout success and validation, refund, bad scenarios."""
import pytest
from app.models import ComboItem, Ingredient, Inventory, Branch, Product, Sale, SaleItem, Setting, User, db
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


def test_delivery_checkout_adds_flat_delivery_charge(client, app):
    client.post(
        "/api/auth/setup",
        json={"username": "owner1", "password": "pass", "branch_name": "Main"},
    )
    token = _get_token(client)
    with app.app_context():
        b = Branch.query.filter_by(name="Main").first()
        bid = b.id
    pid = _create_product_and_inventory(app, bid, "Burger", 10)

    r = client.post(
        "/api/orders/checkout",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "items": [{"product_id": pid, "quantity": 2}],
            "payment_method": "Cash",
            "branch_id": bid,
            "order_type": "delivery",
            "order_snapshot": {
                "customer_name": "Ali",
                "phone": "03001234567",
                "address": "Street 1",
            },
        },
    )
    assert r.status_code == 201
    data = r.get_json()
    assert data["total"] == 320.0

    sale_id = data["sale_id"]
    details = client.get(
        f"/api/orders/{sale_id}",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert details.status_code == 200
    assert details.get_json()["delivery_charge"] == 300.0


def test_dine_in_kds_expands_deals_and_preserves_modifiers(client, app):
    client.post(
        "/api/auth/setup",
        json={"username": "owner1", "password": "pass", "branch_name": "Main"},
    )
    token = _get_token(client)
    with app.app_context():
        branch = Branch.query.filter_by(name="Main").first()
        bid = branch.id

        cheese = Ingredient(name="Extra Cheese", current_stock=5, average_cost=1)
        burger = Product(sku="BURGER1", title="Burger", base_price=12)
        fries = Product(sku="FRIES1", title="Fries", base_price=6)
        deal = Product(sku="DEAL1", title="Burger Deal", base_price=15, is_deal=True)
        db.session.add_all([cheese, burger, fries, deal])
        db.session.flush()

        db.session.add_all(
            [
                Inventory(branch_id=bid, product_id=burger.id, variant_sku_suffix="", stock_level=10),
                Inventory(branch_id=bid, product_id=fries.id, variant_sku_suffix="", stock_level=10),
                ComboItem(combo_id=deal.id, product_id=burger.id, quantity=1),
                ComboItem(combo_id=deal.id, product_id=fries.id, quantity=2),
            ]
        )
        db.session.commit()
        deal_id = deal.id
        burger_id = burger.id
        fries_id = fries.id
        cheese_id = cheese.id

    create_res = client.post(
        "/api/orders/dine-in/kot",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "branch_id": bid,
            "order_snapshot": {"table_name": "T1"},
            "items": [
                {
                    "product_id": deal_id,
                    "quantity": 1,
                    "modifiers": ["Extra Cheese"],
                }
            ],
        },
    )
    assert create_res.status_code == 201
    sale_id = create_res.get_json()["sale_id"]

    active_res = client.get(
        f"/api/orders/active?branch_id={bid}&include_items=1",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert active_res.status_code == 200
    sales = active_res.get_json()["sales"]
    assert len(sales) == 1
    items = sales[0]["items"]
    assert len(items) == 1
    assert items[0]["product_title"] == "Burger Deal"
    assert items[0]["is_deal"] is True
    assert items[0]["modifiers"] == ["Extra Cheese"]
    assert [child["product_title"] for child in items[0]["children"]] == ["Burger", "Fries"]
    assert [child["quantity"] for child in items[0]["children"]] == [1, 2]

    detail_res = client.get(
        f"/api/orders/{sale_id}",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert detail_res.status_code == 200
    detail_items = detail_res.get_json()["items"]
    assert len(detail_items) == 1
    assert detail_items[0]["product_title"] == "Burger Deal"
    assert detail_items[0]["modifiers"] == ["Extra Cheese"]
    assert len(detail_items[0]["children"]) == 2

    cancel_res = client.post(
        f"/api/orders/{sale_id}/cancel-open",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert cancel_res.status_code == 200

    with app.app_context():
        burger_inventory = Inventory.query.filter_by(branch_id=bid, product_id=burger_id, variant_sku_suffix="").first()
        fries_inventory = Inventory.query.filter_by(branch_id=bid, product_id=fries_id, variant_sku_suffix="").first()
        cheese = Ingredient.query.get(cheese_id)
        assert burger_inventory.stock_level == 10
        assert fries_inventory.stock_level == 10
        assert cheese.current_stock == 5
