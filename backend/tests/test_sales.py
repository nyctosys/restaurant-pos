"""Test sales: checkout success and validation, refund, bad scenarios (recipe-only inventory)."""
from datetime import datetime, timedelta, timezone

import pytest
from app.models import (
    Branch,
    ComboItem,
    Ingredient,
    IngredientBranchStock,
    Modifier,
    Product,
    RecipeItem,
    Sale,
    User,
    db,
)
from app.services.branch_ingredient_stock import seed_branch_stocks_for_new_ingredient
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
    r = client.post("/api/auth/login", json={"username": username, "password": "pass"})
    assert r.status_code == 200
    return r.get_json()["token"]


def _set_branch_ingredient_stock(ingredient_id: int, branch_id: int, level: float) -> None:
    row = IngredientBranchStock.query.filter_by(ingredient_id=ingredient_id, branch_id=branch_id).first()
    if row:
        row.current_stock = float(level)
    else:
        db.session.add(
            IngredientBranchStock(ingredient_id=ingredient_id, branch_id=branch_id, current_stock=float(level))
        )


def _create_menu_item_with_recipe(app, branch_id: int, title: str = "Widget", stock: float = 100.0, recipe_qty: float = 1.0):
    """One menu item with a single-ingredient BOM; returns (product_id, ingredient_id)."""
    with app.app_context():
        ing = Ingredient(name=f"ing-{title}", unit="piece", current_stock=0.0)
        db.session.add(ing)
        db.session.flush()
        seed_branch_stocks_for_new_ingredient(ing.id, 0.0)
        _set_branch_ingredient_stock(ing.id, branch_id, stock)
        ing.current_stock = float(stock)

        p = Product(sku=f"SKU-{title}", title=title, base_price=10.0)
        db.session.add(p)
        db.session.flush()
        db.session.add(
            RecipeItem(product_id=p.id, ingredient_id=ing.id, quantity=recipe_qty, unit="piece")
        )
        db.session.commit()
        return p.id, ing.id


def test_checkout_success(client, app):
    client.post(
        "/api/auth/setup",
        json={"username": "owner1", "password": "pass", "branch_name": "Main"},
    )
    token = _get_token(client)
    with app.app_context():
        b = Branch.query.filter_by(name="Main").first()
        bid = b.id
    pid, iid = _create_menu_item_with_recipe(app, bid, "Widget", stock=100.0, recipe_qty=1.0)

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
    assert data.get("total") == 20.0

    with app.app_context():
        row = IngredientBranchStock.query.filter_by(ingredient_id=iid, branch_id=bid).first()
        assert row is not None
        assert abs(float(row.current_stock) - 98.0) < 1e-6


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
    pid, _ = _create_menu_item_with_recipe(app, bid, "Widget", stock=2.0, recipe_qty=1.0)

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
    pid, _ = _create_menu_item_with_recipe(app, bid, "Widget", stock=10.0)

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
    pid, _ = _create_menu_item_with_recipe(app, bid, "Widget", stock=10.0)

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
    pid, iid = _create_menu_item_with_recipe(app, bid, "Widget", stock=100.0)
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

    with app.app_context():
        row = IngredientBranchStock.query.filter_by(ingredient_id=iid, branch_id=bid).first()
        assert row is not None
        assert abs(float(row.current_stock) - 100.0) < 1e-6


def test_refund_already_refunded_returns_400(client, app):
    client.post(
        "/api/auth/setup",
        json={"username": "owner1", "password": "pass", "branch_name": "Main"},
    )
    token = _get_token(client)
    with app.app_context():
        b = Branch.query.filter_by(name="Main").first()
        bid = b.id
    pid, _ = _create_menu_item_with_recipe(app, bid, "Widget", stock=10.0)
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
    pid, _ = _create_menu_item_with_recipe(app, bid, "Burger", stock=50.0)

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


def test_delivery_checkout_custom_delivery_charge(client, app):
    client.post(
        "/api/auth/setup",
        json={"username": "owner1", "password": "pass", "branch_name": "Main"},
    )
    token = _get_token(client)
    with app.app_context():
        b = Branch.query.filter_by(name="Main").first()
        bid = b.id
    pid, _ = _create_menu_item_with_recipe(app, bid, "Burger2", stock=50.0)

    r = client.post(
        "/api/orders/checkout",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "items": [{"product_id": pid, "quantity": 1}],
            "payment_method": "Cash",
            "branch_id": bid,
            "order_type": "delivery",
            "delivery_charge": 125.0,
            "order_snapshot": {
                "customer_name": "Ali",
                "phone": "03001234567",
                "address": "Street 1",
            },
        },
    )
    assert r.status_code == 201
    data = r.get_json()
    assert data["total"] == 135.0
    details = client.get(
        f"/api/orders/{data['sale_id']}",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert details.get_json()["delivery_charge"] == 125.0


def test_dine_in_checkout_service_charge(client, app):
    client.post(
        "/api/auth/setup",
        json={"username": "owner1", "password": "pass", "branch_name": "Main"},
    )
    token = _get_token(client)
    with app.app_context():
        b = Branch.query.filter_by(name="Main").first()
        bid = b.id
    pid, _ = _create_menu_item_with_recipe(app, bid, "Soup", stock=50.0)

    r = client.post(
        "/api/orders/checkout",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "items": [{"product_id": pid, "quantity": 1}],
            "payment_method": "Cash",
            "branch_id": bid,
            "order_type": "dine_in",
            "order_snapshot": {"table_name": "T5"},
            "service_charge": 40.0,
        },
    )
    assert r.status_code == 201
    data = r.get_json()
    assert data["total"] == 50.0
    details = client.get(
        f"/api/orders/{data['sale_id']}",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert details.get_json()["service_charge"] == 40.0


def test_dine_in_kds_expands_deals_and_preserves_modifiers(client, app):
    client.post(
        "/api/auth/setup",
        json={"username": "owner1", "password": "pass", "branch_name": "Main"},
    )
    token = _get_token(client)
    with app.app_context():
        branch = Branch.query.filter_by(name="Main").first()
        bid = branch.id

        cheese = Ingredient(name="Extra Cheese", unit="piece", current_stock=0.0)
        patty = Ingredient(name="Patty", unit="piece", current_stock=0.0)
        potato = Ingredient(name="Potato", unit="piece", current_stock=0.0)
        burger = Product(sku="BURGER1", title="Burger", base_price=12)
        fries = Product(sku="FRIES1", title="Fries", base_price=6)
        deal = Product(sku="DEAL1", title="Burger Deal", base_price=15, is_deal=True)
        db.session.add_all([cheese, patty, potato, burger, fries, deal])
        db.session.flush()

        for ing, level in [(cheese, 5.0), (patty, 50.0), (potato, 50.0)]:
            seed_branch_stocks_for_new_ingredient(ing.id, 0.0)
            _set_branch_ingredient_stock(ing.id, bid, level)
            ing.current_stock = level

        db.session.add(RecipeItem(product_id=burger.id, ingredient_id=patty.id, quantity=1.0, unit="piece"))
        db.session.add(RecipeItem(product_id=fries.id, ingredient_id=potato.id, quantity=1.0, unit="piece"))

        mod = Modifier(name="Extra Cheese", price=0, ingredient_id=cheese.id, depletion_quantity=1.0)
        db.session.add(mod)

        db.session.add_all(
            [
                ComboItem(combo_id=deal.id, product_id=burger.id, quantity=1),
                ComboItem(combo_id=deal.id, product_id=fries.id, quantity=2),
            ]
        )
        db.session.commit()
        deal_id = deal.id
        cheese_id = cheese.id
        mod_id = mod.id

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
                    "modifier_ids": [mod_id],
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
    assert len(detail_items[0]["modifiers"]) >= 1
    assert detail_items[0]["modifiers"][0]["name"] == "Extra Cheese"
    assert len(detail_items[0]["children"]) == 2

    cancel_res = client.post(
        f"/api/orders/{sale_id}/cancel-open",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert cancel_res.status_code == 200

    with app.app_context():
        ch = IngredientBranchStock.query.filter_by(ingredient_id=cheese_id, branch_id=bid).first()
        assert ch is not None
        assert abs(float(ch.current_stock) - 5.0) < 1e-6


def test_kitchen_lists_kot_and_legacy_null_order_type(client, app):
    """KDS must show open KOTs; legacy rows may have NULL order_type before backfill."""
    client.post(
        "/api/auth/setup",
        json={"username": "owner1", "password": "pass", "branch_name": "Main"},
    )
    token = _get_token(client)
    with app.app_context():
        branch = Branch.query.filter_by(name="Main").first()
        bid = branch.id
        ing = Ingredient(name="Patty", unit="piece", current_stock=0.0)
        burger = Product(sku="BK1", title="Burger", base_price=12)
        db.session.add_all([ing, burger])
        db.session.flush()
        seed_branch_stocks_for_new_ingredient(ing.id, 0.0)
        _set_branch_ingredient_stock(ing.id, bid, 50.0)
        ing.current_stock = 50.0
        db.session.add(RecipeItem(product_id=burger.id, ingredient_id=ing.id, quantity=1.0, unit="piece"))
        db.session.commit()
        pid = burger.id

    create_res = client.post(
        "/api/orders/dine-in/kot",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "order_snapshot": {"table_name": "T1"},
            "items": [{"product_id": pid, "quantity": 1, "modifier_ids": []}],
        },
    )
    assert create_res.status_code == 201
    sale_id = create_res.get_json()["sale_id"]

    kds = client.get("/api/orders/kitchen", headers={"Authorization": f"Bearer {token}"})
    assert kds.status_code == 200
    orders = kds.get_json()["orders"]
    assert len(orders) == 1
    assert orders[0]["id"] == sale_id
    assert orders[0]["kitchen_status"] == "placed"

    with app.app_context():
        sale = Sale.query.get(sale_id)
        assert sale is not None
        sale.order_type = None
        db.session.commit()

    kds2 = client.get("/api/orders/kitchen", headers={"Authorization": f"Bearer {token}"})
    assert kds2.status_code == 200
    assert len(kds2.get_json()["orders"]) == 1


def test_kitchen_drops_ready_after_one_day(client, app):
    """READY tickets disappear from KDS 24h after being marked ready."""
    client.post(
        "/api/auth/setup",
        json={"username": "owner1", "password": "pass", "branch_name": "Main"},
    )
    token = _get_token(client)
    with app.app_context():
        branch = Branch.query.filter_by(name="Main").first()
        bid = branch.id
        ing = Ingredient(name="Patty2", unit="piece", current_stock=0.0)
        burger = Product(sku="BK2", title="Burger2", base_price=12)
        db.session.add_all([ing, burger])
        db.session.flush()
        seed_branch_stocks_for_new_ingredient(ing.id, 0.0)
        _set_branch_ingredient_stock(ing.id, bid, 50.0)
        ing.current_stock = 50.0
        db.session.add(RecipeItem(product_id=burger.id, ingredient_id=ing.id, quantity=1.0, unit="piece"))
        db.session.commit()
        pid = burger.id

    create_res = client.post(
        "/api/orders/dine-in/kot",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "order_snapshot": {"table_name": "T1"},
            "items": [{"product_id": pid, "quantity": 1, "modifier_ids": []}],
        },
    )
    assert create_res.status_code == 201
    sale_id = create_res.get_json()["sale_id"]

    assert (
        client.patch(
            f"/api/orders/{sale_id}/kitchen-status",
            headers={"Authorization": f"Bearer {token}"},
            json={"kitchen_status": "preparing"},
        ).status_code
        == 200
    )
    assert (
        client.patch(
            f"/api/orders/{sale_id}/kitchen-status",
            headers={"Authorization": f"Bearer {token}"},
            json={"kitchen_status": "ready"},
        ).status_code
        == 200
    )

    with app.app_context():
        sale = Sale.query.get(sale_id)
        assert sale is not None
        assert sale.kitchen_ready_at is not None
        sale.kitchen_ready_at = datetime.now(timezone.utc) - timedelta(days=2)
        db.session.commit()

    kds = client.get("/api/orders/kitchen", headers={"Authorization": f"Bearer {token}"})
    assert kds.status_code == 200
    assert len(kds.get_json()["orders"]) == 0


def test_checkout_variant_uses_variant_specific_bom(client, app):
    """Selling a variant deducts ingredients from variant-scoped recipe rows when present."""
    client.post(
        "/api/auth/setup",
        json={"username": "owner1", "password": "pass", "branch_name": "Main"},
    )
    token = _get_token(client)
    with app.app_context():
        b = Branch.query.filter_by(name="Main").first()
        bid = b.id
        ing_base = Ingredient(name="ing-base", unit="piece", current_stock=0.0)
        ing_large = Ingredient(name="ing-large", unit="piece", current_stock=0.0)
        db.session.add_all([ing_base, ing_large])
        db.session.flush()
        for ing in (ing_base, ing_large):
            seed_branch_stocks_for_new_ingredient(ing.id, 0.0)
            _set_branch_ingredient_stock(ing.id, bid, 100.0)
            ing.current_stock = 100.0

        p = Product(sku="VAR-PIZZA", title="Pizza", base_price=10.0, variants=["Regular", "Large"])
        db.session.add(p)
        db.session.flush()
        db.session.add(
            RecipeItem(product_id=p.id, ingredient_id=ing_base.id, quantity=1.0, unit="piece", variant_key="")
        )
        db.session.add(
            RecipeItem(product_id=p.id, ingredient_id=ing_large.id, quantity=3.0, unit="piece", variant_key="Large")
        )
        db.session.commit()
        pid = p.id
        i_base = ing_base.id
        i_large = ing_large.id

    r = client.post(
        "/api/orders/checkout",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "items": [{"product_id": pid, "quantity": 1, "variant_sku_suffix": "Large"}],
            "payment_method": "Cash",
            "branch_id": bid,
        },
    )
    assert r.status_code == 201

    with app.app_context():
        row_b = IngredientBranchStock.query.filter_by(ingredient_id=i_base, branch_id=bid).first()
        row_l = IngredientBranchStock.query.filter_by(ingredient_id=i_large, branch_id=bid).first()
        assert row_b is not None and abs(float(row_b.current_stock) - 100.0) < 1e-6
        assert row_l is not None and abs(float(row_l.current_stock) - 97.0) < 1e-6
