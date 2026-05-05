from __future__ import annotations

import pytest
from werkzeug.security import generate_password_hash

from app.models import Branch, Ingredient, IngredientBranchStock, Product, RecipeItem, User, db
from app.services.branch_ingredient_stock import seed_branch_stocks_for_new_ingredient


def _setup_owner_and_menu_item(app):
    with app.app_context():
        branch = Branch(name="Main")
        db.session.add(branch)
        db.session.flush()

        user = User(
            username="owner-printer",
            password_hash=generate_password_hash("pass"),
            role="owner",
            branch_id=branch.id,
        )
        db.session.add(user)
        db.session.flush()

        ingredient = Ingredient(name="ing-printer", unit="piece", current_stock=0.0)
        db.session.add(ingredient)
        db.session.flush()
        seed_branch_stocks_for_new_ingredient(ingredient.id, 0.0)
        row = IngredientBranchStock.query.filter_by(ingredient_id=ingredient.id, branch_id=branch.id).first()
        if row is not None:
            row.current_stock = 100.0
        ingredient.current_stock = 100.0

        product = Product(sku="SKU-PRINTER", title="Printer Item", base_price=10.0)
        db.session.add(product)
        db.session.flush()

        db.session.add(RecipeItem(product_id=product.id, ingredient_id=ingredient.id, quantity=1.0, unit="piece"))
        db.session.commit()
        return branch.id, product.id


def _login_token(client):
    r = client.post("/api/auth/login", json={"username": "owner-printer", "password": "pass"})
    assert r.status_code == 200
    return r.get_json()["token"]


@pytest.mark.parametrize(
    ("order_type", "order_snapshot"),
    [
        ("dine_in", {"table_name": "T1"}),
        ("takeaway", None),
        (
            "delivery",
            {
                "customer_name": "Ali",
                "phone": "03001234567",
                "address": "Street 1",
                "rider_name": "Hamza",
            },
        ),
    ],
)
def test_finalize_open_order_always_triggers_receipt_print(client, app, monkeypatch, order_type, order_snapshot):
    branch_id, product_id = _setup_owner_and_menu_item(app)
    token = _login_token(client)
    headers = {"Authorization": f"Bearer {token}"}

    receipt_calls: list[dict] = []
    kot_calls: list[dict] = []

    def _fake_print_kot(self, kot_data):
        kot_calls.append(kot_data)
        return True

    def _fake_print_receipt(self, receipt_data):
        receipt_calls.append(receipt_data)
        return True

    monkeypatch.setattr("app.services.printer_service.PrinterService.print_kot", _fake_print_kot)
    monkeypatch.setattr("app.services.printer_service.PrinterService.print_receipt", _fake_print_receipt)

    kot_payload = {
        "order_type": order_type,
        "items": [{"product_id": product_id, "quantity": 1}],
    }
    if order_snapshot is not None:
        kot_payload["order_snapshot"] = order_snapshot

    create = client.post("/api/orders/kot", headers=headers, json=kot_payload)
    assert create.status_code == 201
    sale_id = create.get_json()["sale_id"]
    assert len(kot_calls) == 1
    assert kot_calls[0].get("order_type") == order_type

    finalize_payload = {"payment_method": "Cash", "discount": None}
    if order_type == "delivery":
        finalize_payload["delivery_charge"] = 300
    if order_type == "dine_in":
        finalize_payload["service_charge"] = 0

    paid = client.post(f"/api/orders/{sale_id}/finalize", headers=headers, json=finalize_payload)
    assert paid.status_code == 200
    assert paid.get_json().get("print_success") is True
    assert len(receipt_calls) == 1
    assert receipt_calls[0].get("order_type") == order_type


@pytest.mark.parametrize("order_type", ["dine_in", "takeaway", "delivery"])
@pytest.mark.parametrize("payment_method", ["Cash", "Card", "Online Transfer"])
def test_paid_checkout_queues_receipt_before_kot_for_every_order_type_and_payment_method(
    client, app, monkeypatch, order_type, payment_method
):
    _branch_id, product_id = _setup_owner_and_menu_item(app)
    token = _login_token(client)
    headers = {"Authorization": f"Bearer {token}"}

    print_order: list[str] = []

    def _fake_print_kot(self, kot_data):
        print_order.append(f"kot:{kot_data.get('order_type')}")
        return True

    def _fake_print_receipt(self, receipt_data):
        print_order.append(f"receipt:{receipt_data.get('order_type')}")
        return True

    monkeypatch.setattr("app.services.printer_service.PrinterService.print_kot", _fake_print_kot)
    monkeypatch.setattr("app.services.printer_service.PrinterService.print_receipt", _fake_print_receipt)

    payload = {
        "order_type": order_type,
        "payment_method": payment_method,
        "items": [{"product_id": product_id, "quantity": 1}],
    }
    if order_type == "dine_in":
        payload["order_snapshot"] = {"table_name": "T1"}
        payload["service_charge"] = 0
    elif order_type == "delivery":
        payload["order_snapshot"] = {
            "customer_name": "Ali",
            "phone": "03001234567",
            "address": "Street 1",
            "rider_name": "Hamza",
        }
        payload["delivery_charge"] = 300

    paid = client.post("/api/orders/checkout", headers=headers, json=payload)
    assert paid.status_code == 201
    assert paid.get_json().get("print_success") is True
    assert print_order[:2] == [f"receipt:{order_type}", f"kot:{order_type}"]


def test_printer_status_probe_releases_connection(client, app, monkeypatch):
    branch_id, _ = _setup_owner_and_menu_item(app)
    _ = branch_id
    token = _login_token(client)
    headers = {"Authorization": f"Bearer {token}"}

    calls = {"connect": 0, "disconnect": 0}

    def _fake_connect(self, printer_kind="receipt"):
        calls["connect"] += 1
        return True

    def _fake_disconnect(self):
        calls["disconnect"] += 1
        return None

    monkeypatch.setattr("app.services.printer_service.PrinterService.connect", _fake_connect)
    monkeypatch.setattr("app.services.printer_service.PrinterService._disconnect", _fake_disconnect)

    res = client.get("/api/printer/status", headers=headers)
    assert res.status_code == 200
    body = res.get_json()
    assert body.get("status") == "connected"
    assert calls["connect"] == 1
    assert calls["disconnect"] == 1


def test_kot_creation_can_skip_immediate_print(client, app, monkeypatch):
    branch_id, product_id = _setup_owner_and_menu_item(app)
    token = _login_token(client)
    headers = {"Authorization": f"Bearer {token}"}

    calls = {"kot": 0}

    def _fake_print_kot(self, kot_data):
        calls["kot"] += 1
        return True

    monkeypatch.setattr("app.services.printer_service.PrinterService.print_kot", _fake_print_kot)

    create = client.post(
        "/api/orders/kot",
        headers=headers,
        json={
            "order_type": "takeaway",
            "skip_kot_print": True,
            "items": [{"product_id": product_id, "quantity": 1}],
        },
    )
    assert create.status_code == 201
    body = create.get_json()
    assert body["sale_id"] > 0
    assert body.get("print_success") is None
    assert calls["kot"] == 0


def test_print_kot_endpoint_prints_existing_sale(client, app, monkeypatch):
    branch_id, product_id = _setup_owner_and_menu_item(app)
    token = _login_token(client)
    headers = {"Authorization": f"Bearer {token}"}

    calls: list[dict] = []

    def _fake_print_kot(self, kot_data):
        calls.append(kot_data)
        return True

    monkeypatch.setattr("app.services.printer_service.PrinterService.print_kot", _fake_print_kot)

    create = client.post(
        "/api/orders/kot",
        headers=headers,
        json={
            "order_type": "takeaway",
            "skip_kot_print": True,
            "items": [{"product_id": product_id, "quantity": 1}],
        },
    )
    assert create.status_code == 201
    sale_id = create.get_json()["sale_id"]

    printed = client.post(f"/api/orders/{sale_id}/print-kot", headers=headers)
    assert printed.status_code == 200
    body = printed.get_json()
    assert body.get("print_success") is True
    assert len(calls) == 1
    assert calls[0].get("sale_id") == sale_id
    assert calls[0].get("order_type") == "takeaway"


def test_deferred_receipt_print_retries_transient_failure(app, monkeypatch):
    branch_id, _ = _setup_owner_and_menu_item(app)
    calls: list[dict] = []

    def _flaky_print_receipt(self, receipt_data):
        calls.append(receipt_data)
        return len(calls) >= 2

    monkeypatch.setattr("app.services.printer_service.PrinterService.print_receipt", _flaky_print_receipt)

    from app.services.printer_background import run_print_receipt_job

    run_print_receipt_job({"branch_id": branch_id, "items": [], "total": 0})

    assert len(calls) == 2
