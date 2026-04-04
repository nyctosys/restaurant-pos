import pytest
from app.models import (
    Branch,
    Ingredient,
    IngredientBranchStock,
    Product,
    RecipeItem,
    User,
    db,
)
from app.services.branch_ingredient_stock import seed_branch_stocks_for_new_ingredient
from werkzeug.security import generate_password_hash


def _auth_headers(client, app):
    with app.app_context():
        user = User.query.filter_by(username="owner_deals").first()
        if not user:
            b = Branch(name="DealsBranch")
            db.session.add(b)
            db.session.flush()
            u = User(
                username="owner_deals",
                password_hash=generate_password_hash("pass"),
                role="owner",
                branch_id=b.id,
            )
            db.session.add(u)
            db.session.commit()
    r = client.post("/api/auth/login", json={"username": "owner_deals", "password": "pass"})
    token = r.get_json()["token"]
    return {"Authorization": f"Bearer {token}"}


def _set_branch_stock(ingredient_id: int, branch_id: int, level: float) -> None:
    row = IngredientBranchStock.query.filter_by(ingredient_id=ingredient_id, branch_id=branch_id).first()
    if row:
        row.current_stock = float(level)
    else:
        db.session.add(
            IngredientBranchStock(ingredient_id=ingredient_id, branch_id=branch_id, current_stock=float(level))
        )


def test_deals_creation_and_checkout(client, app):
    h = _auth_headers(client, app)

    r_b = client.post("/api/menu-items/", headers=h, json={"sku": "B-001", "title": "Burger", "base_price": 5.0, "section": "Mains"})
    id_burger = r_b.get_json()["id"]
    r_f = client.post("/api/menu-items/", headers=h, json={"sku": "F-001", "title": "Fries", "base_price": 3.0, "section": "Sides"})
    id_fries = r_f.get_json()["id"]

    with app.app_context():
        br = Branch.query.filter_by(name="DealsBranch").first()
        for pid, ing_name in [(id_burger, "beef"), (id_fries, "potato")]:
            ing = Ingredient(name=ing_name, unit="piece", current_stock=0.0)
            db.session.add(ing)
            db.session.flush()
            seed_branch_stocks_for_new_ingredient(ing.id, 0.0)
            _set_branch_stock(ing.id, br.id, 100.0)
            ing.current_stock = 100.0
            db.session.add(RecipeItem(product_id=pid, ingredient_id=ing.id, quantity=1.0, unit="piece"))
        db.session.commit()

    r_d = client.post(
        "/api/menu/deals/",
        headers=h,
        json={
            "title": "Burger Combo",
            "sku": "COMBO-1",
            "base_price": 7.0,
            "combo_items": [
                {"product_id": id_burger, "quantity": 1},
                {"product_id": id_fries, "quantity": 1},
            ],
        },
    )
    assert r_d.status_code == 200
    id_deal = r_d.get_json()["id"]

    r_dl = client.get("/api/menu/deals/", headers=h)
    deals = r_dl.get_json()["deals"]
    assert len(deals) > 0
    assert any(d["id"] == id_deal for d in deals)

    with app.app_context():
        br = Branch.query.filter_by(name="DealsBranch").first()

    r_checkout = client.post(
        "/api/orders/checkout",
        headers=h,
        json={
            "branch_id": br.id,
            "payment_method": "Cash",
            "items": [{"product_id": id_deal, "quantity": 2}],
        },
    )
    assert r_checkout.status_code == 201
    sale_id = r_checkout.get_json()["sale_id"]

    with app.app_context():
        br = Branch.query.filter_by(name="DealsBranch").first()
        ings = Ingredient.query.filter(Ingredient.name.in_(["beef", "potato"])).all()
        by_name = {i.name: i for i in ings}
        beef_row = IngredientBranchStock.query.filter_by(ingredient_id=by_name["beef"].id, branch_id=br.id).first()
        potato_row = IngredientBranchStock.query.filter_by(ingredient_id=by_name["potato"].id, branch_id=br.id).first()
        assert beef_row is not None and abs(float(beef_row.current_stock) - 98.0) < 1e-6
        assert potato_row is not None and abs(float(potato_row.current_stock) - 98.0) < 1e-6


def test_deals_checkout_with_ingredients(client, app):
    h = _auth_headers(client, app)

    r_ing1 = client.post(
        "/api/inventory-advanced/ingredients",
        headers=h,
        json={"name": "Patty", "sku": "ING-P", "unit": "piece", "current_stock": 0},
    )
    id_patty = r_ing1.get_json()["id"]

    r_p = client.post("/api/menu-items/", headers=h, json={"sku": "B-PATTY", "title": "Patty Burger", "base_price": 5.0, "section": "Mains"})
    id_burger = r_p.get_json()["id"]

    client.post(
        "/api/inventory-advanced/recipes",
        headers=h,
        json={"product_id": id_burger, "ingredient_id": id_patty, "quantity": 1, "unit": "piece"},
    )

    with app.app_context():
        br = Branch.query.filter_by(name="DealsBranch").first()
        seed_branch_stocks_for_new_ingredient(id_patty, 0.0)
        _set_branch_stock(id_patty, br.id, 10.0)
        db.session.get(Ingredient, id_patty).current_stock = 10.0
        db.session.commit()

    r_d = client.post(
        "/api/menu/deals/",
        headers=h,
        json={
            "title": "Double Deal",
            "sku": "DD-1",
            "base_price": 9.0,
            "combo_items": [{"product_id": id_burger, "quantity": 2}],
        },
    )
    id_deal = r_d.get_json()["id"]

    with app.app_context():
        br = Branch.query.filter_by(name="DealsBranch").first()

    r_checkout = client.post(
        "/api/orders/checkout",
        headers=h,
        json={"branch_id": br.id, "payment_method": "Cash", "items": [{"product_id": id_deal, "quantity": 1}]},
    )
    assert r_checkout.status_code == 201

    with app.app_context():
        br = Branch.query.filter_by(name="DealsBranch").first()
        row = IngredientBranchStock.query.filter_by(ingredient_id=id_patty, branch_id=br.id).first()
        assert row is not None
        assert abs(float(row.current_stock) - 8.0) < 1e-6


def test_deal_soft_delete_hides_from_list_blocks_new_sales(client, app):
    h = _auth_headers(client, app)

    r_b = client.post(
        "/api/menu-items/", headers=h, json={"sku": "B-SOFT", "title": "Burger", "base_price": 5.0, "section": "Mains"}
    )
    id_burger = r_b.get_json()["id"]
    r_f = client.post(
        "/api/menu-items/", headers=h, json={"sku": "F-SOFT", "title": "Fries", "base_price": 3.0, "section": "Sides"}
    )
    id_fries = r_f.get_json()["id"]

    with app.app_context():
        br = Branch.query.filter_by(name="DealsBranch").first()
        for pid, ing_name in [(id_burger, "beef_soft"), (id_fries, "potato_soft")]:
            ing = Ingredient(name=ing_name, unit="piece", current_stock=0.0)
            db.session.add(ing)
            db.session.flush()
            seed_branch_stocks_for_new_ingredient(ing.id, 0.0)
            _set_branch_stock(ing.id, br.id, 100.0)
            ing.current_stock = 100.0
            db.session.add(RecipeItem(product_id=pid, ingredient_id=ing.id, quantity=1.0, unit="piece"))
        db.session.commit()

    r_d = client.post(
        "/api/menu/deals/",
        headers=h,
        json={
            "title": "Soft Combo",
            "sku": "COMBO-SOFT",
            "base_price": 7.0,
            "combo_items": [
                {"product_id": id_burger, "quantity": 1},
                {"product_id": id_fries, "quantity": 1},
            ],
        },
    )
    assert r_d.status_code == 200
    id_deal = r_d.get_json()["id"]

    r_del = client.delete(f"/api/menu/deals/{id_deal}", headers=h)
    assert r_del.status_code == 200
    del_body = r_del.get_json()
    assert del_body.get("archived_at")
    assert "archived" in (del_body.get("message") or "").lower()

    with app.app_context():
        deal = db.session.get(Product, id_deal)
        assert deal is not None
        assert deal.archived_at is not None
        assert len(deal.combo_items) == 2

    r_dl = client.get("/api/menu/deals/", headers=h)
    deals = r_dl.get_json()["deals"]
    assert not any(d["id"] == id_deal for d in deals)

    with app.app_context():
        br = Branch.query.filter_by(name="DealsBranch").first()

    r_checkout = client.post(
        "/api/orders/checkout",
        headers=h,
        json={
            "branch_id": br.id,
            "payment_method": "Cash",
            "items": [{"product_id": id_deal, "quantity": 1}],
        },
    )
    assert r_checkout.status_code == 400
