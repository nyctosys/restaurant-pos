import pytest
from app.models import (
    Branch,
    Ingredient,
    IngredientBranchStock,
    Product,
    RecipeItem,
    Sale,
    SaleItem,
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


def _cashier_headers(client, app):
    with app.app_context():
        user = User.query.filter_by(username="cashier_deals").first()
        if not user:
            b = Branch.query.filter_by(name="DealsBranch").first()
            if not b:
                b = Branch(name="DealsBranch")
                db.session.add(b)
                db.session.flush()
            u = User(
                username="cashier_deals",
                password_hash=generate_password_hash("pass"),
                role="cashier",
                branch_id=b.id,
            )
            db.session.add(u)
            db.session.commit()
    r = client.post("/api/auth/login", json={"username": "cashier_deals", "password": "pass"})
    token = r.get_json()["token"]
    return {"Authorization": f"Bearer {token}"}


def _set_branch_stock(ingredient_id: int, branch_id: str, level: float) -> None:
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


def test_deal_edit_archive_restore_and_permanent_delete(client, app):
    h = _auth_headers(client, app)

    burger_res = client.post(
        "/api/menu-items/",
        headers=h,
        json={"sku": "EDIT-BURGER", "title": "Edit Burger", "base_price": 5.0, "section": "Mains"},
    )
    burger_id = burger_res.get_json()["id"]
    fries_res = client.post(
        "/api/menu-items/",
        headers=h,
        json={"sku": "EDIT-FRIES", "title": "Edit Fries", "base_price": 3.0, "section": "Sides"},
    )
    fries_id = fries_res.get_json()["id"]
    client.post(
        "/api/menu-items/",
        headers=h,
        json={"sku": "EDIT-DRINK", "title": "Edit Drink", "base_price": 2.0, "section": "Drinks"},
    )

    create_res = client.post(
        "/api/menu/deals/",
        headers=h,
        json={
            "title": "Editable Combo",
            "sku": "EDIT-COMBO",
            "base_price": 7.0,
            "variants": ["Regular"],
            "combo_items": [{"product_id": burger_id, "quantity": 1, "variant_key": "Regular"}],
        },
    )
    assert create_res.status_code == 200
    deal_id = create_res.get_json()["id"]

    update_res = client.put(
        f"/api/menu/deals/{deal_id}",
        headers=h,
        json={
            "title": "Edited Combo",
            "sku": "EDIT-COMBO-2",
            "sale_price": 8.5,
            "variants": ["Regular", "Large"],
            "combo_items": [
                {"product_id": fries_id, "quantity": 2, "variant_key": "Regular"},
                {"selection_type": "category", "category_name": "Drinks", "quantity": 1, "variant_key": "Large"},
            ],
        },
    )
    assert update_res.status_code == 200
    assert "updated" in update_res.get_json()["message"].lower()

    list_res = client.get("/api/menu/deals/", headers=h)
    edited = next(d for d in list_res.get_json()["deals"] if d["id"] == deal_id)
    assert edited["title"] == "Edited Combo"
    assert edited["sku"] == "EDIT-COMBO-2"
    assert edited["sale_price"] == 8.5
    assert edited["variants"] == []
    assert len(edited["combo_items"]) == 2
    assert any(ci["product_id"] == fries_id and ci["quantity"] == 2 for ci in edited["combo_items"])
    assert any(ci["selection_type"] == "category" and ci["category_name"] == "Drinks" for ci in edited["combo_items"])
    fries_row = next(ci for ci in edited["combo_items"] if ci.get("product_id") == fries_id)
    drinks_row = next(ci for ci in edited["combo_items"] if ci.get("selection_type") == "category")
    assert (fries_row.get("variant_key") or "") == "Regular"
    assert (drinks_row.get("variant_key") or "") == "Large"

    archive_res = client.patch(f"/api/menu/deals/{deal_id}/archive", headers=h)
    assert archive_res.status_code == 200
    assert archive_res.get_json()["archived_at"]

    active_list_res = client.get("/api/menu/deals/", headers=h)
    assert not any(d["id"] == deal_id for d in active_list_res.get_json()["deals"])

    archived_list_res = client.get("/api/menu/deals/?include_archived=1", headers=h)
    archived_deal = next(d for d in archived_list_res.get_json()["deals"] if d["id"] == deal_id)
    assert archived_deal["archived_at"]

    restore_res = client.patch(f"/api/menu/deals/{deal_id}/unarchive", headers=h)
    assert restore_res.status_code == 200
    with app.app_context():
        br = Branch.query.filter_by(name="DealsBranch").first()
        user = User.query.filter_by(username="owner_deals").first()
        sale = Sale(branch_id=br.id, user_id=user.id, total_amount=8.5, tax_amount=0, payment_method="Cash")
        db.session.add(sale)
        db.session.flush()
        db.session.add(
            SaleItem(sale_id=sale.id, product_id=deal_id, quantity=1, unit_price=8.5, subtotal=8.5)
        )
        db.session.commit()

    permanent_res = client.delete(f"/api/menu/deals/{deal_id}?permanent=1", headers=h)
    assert permanent_res.status_code == 200
    assert "permanently deleted" in permanent_res.get_json()["message"].lower()

    with app.app_context():
        assert db.session.get(Product, deal_id) is None
        assert SaleItem.query.filter_by(product_id=deal_id).count() == 0
        assert SaleItem.query.filter_by(product_id=None).count() >= 1


def test_deal_with_category_choices_lists_and_checks_out_selected_items(client, app):
    h = _auth_headers(client, app)

    bun_res = client.post(
        "/api/menu-items/",
        headers=h,
        json={"sku": "BUN-1", "title": "Zinger Bun", "base_price": 12.0, "section": "Buns"},
    )
    bun_id = bun_res.get_json()["id"]
    wrap_res = client.post(
        "/api/menu-items/",
        headers=h,
        json={"sku": "WRAP-1", "title": "Chicken Wrap", "base_price": 11.0, "section": "Wraps"},
    )
    wrap_id = wrap_res.get_json()["id"]
    coke_res = client.post(
        "/api/menu-items/",
        headers=h,
        json={"sku": "COKE-1", "title": "Coke", "base_price": 4.0, "section": "Drinks"},
    )
    coke_id = coke_res.get_json()["id"]
    fries_res = client.post(
        "/api/menu-items/",
        headers=h,
        json={"sku": "FRIES-1", "title": "Fries", "base_price": 5.0, "section": "Sides"},
    )
    fries_id = fries_res.get_json()["id"]

    with app.app_context():
        br = Branch.query.filter_by(name="DealsBranch").first()
        for pid, ing_name in [
            (bun_id, "bun_roll"),
            (wrap_id, "wrap_bread"),
            (coke_id, "soft_drink"),
            (fries_id, "fries_potato"),
        ]:
            ing = Ingredient(name=ing_name, unit="piece", current_stock=0.0)
            db.session.add(ing)
            db.session.flush()
            seed_branch_stocks_for_new_ingredient(ing.id, 0.0)
            _set_branch_stock(ing.id, br.id, 100.0)
            ing.current_stock = 100.0
            db.session.add(RecipeItem(product_id=pid, ingredient_id=ing.id, quantity=1.0, unit="piece"))
        db.session.commit()

    create_res = client.post(
        "/api/menu/deals/",
        headers=h,
        json={
            "title": "Pick Bun & Wrap Combo",
            "sku": "PICK-1",
            "base_price": 25.0,
            "combo_items": [
                {"selection_type": "category", "category_name": "Buns", "quantity": 1},
                {"selection_type": "category", "category_name": "Wraps", "quantity": 1},
                {"product_id": coke_id, "quantity": 1},
                {"product_id": fries_id, "quantity": 1},
            ],
        },
    )
    assert create_res.status_code == 200
    deal_id = create_res.get_json()["id"]

    list_res = client.get("/api/menu/deals/", headers=h)
    assert list_res.status_code == 200
    created_deal = next(d for d in list_res.get_json()["deals"] if d["id"] == deal_id)
    assert any(ci["selection_type"] == "category" and ci["category_name"] == "Buns" for ci in created_deal["combo_items"])
    assert any(ci["selection_type"] == "category" and ci["category_name"] == "Wraps" for ci in created_deal["combo_items"])
    assert any(ci["product_id"] == coke_id for ci in created_deal["combo_items"])

    with app.app_context():
        br = Branch.query.filter_by(name="DealsBranch").first()

    missing_selection_res = client.post(
        "/api/orders/checkout",
        headers=h,
        json={
            "branch_id": br.id,
            "payment_method": "Cash",
            "items": [{"product_id": deal_id, "quantity": 1}],
        },
    )
    assert missing_selection_res.status_code == 400

    choice_rows = [ci for ci in created_deal["combo_items"] if ci["selection_type"] == "category"]
    checkout_res = client.post(
        "/api/orders/checkout",
        headers=h,
        json={
            "branch_id": br.id,
            "payment_method": "Cash",
            "items": [
                {
                    "product_id": deal_id,
                    "quantity": 1,
                    "deal_selections": [
                        {"combo_item_id": next(ci["id"] for ci in choice_rows if ci["category_name"] == "Buns"), "product_id": bun_id},
                        {"combo_item_id": next(ci["id"] for ci in choice_rows if ci["category_name"] == "Wraps"), "product_id": wrap_id},
                    ],
                }
            ],
        },
    )
    assert checkout_res.status_code == 201

    with app.app_context():
        br = Branch.query.filter_by(name="DealsBranch").first()
        ingredient_rows = Ingredient.query.filter(
            Ingredient.name.in_(["bun_roll", "wrap_bread", "soft_drink", "fries_potato"])
        ).all()
        by_name = {row.name: row for row in ingredient_rows}
        for name in ["bun_roll", "wrap_bread", "soft_drink", "fries_potato"]:
            stock_row = IngredientBranchStock.query.filter_by(ingredient_id=by_name[name].id, branch_id=br.id).first()
            assert stock_row is not None
            assert abs(float(stock_row.current_stock) - 99.0) < 1e-6


def test_deal_category_choice_rejects_product_from_wrong_category(client, app):
    h = _auth_headers(client, app)

    bun_res = client.post(
        "/api/menu-items/",
        headers=h,
        json={"sku": "BUN-WRONG", "title": "Crispy Bun", "base_price": 12.0, "section": "Buns"},
    )
    bun_id = bun_res.get_json()["id"]
    coke_res = client.post(
        "/api/menu-items/",
        headers=h,
        json={"sku": "COKE-WRONG", "title": "Coke", "base_price": 4.0, "section": "Drinks"},
    )
    coke_id = coke_res.get_json()["id"]

    create_res = client.post(
        "/api/menu/deals/",
        headers=h,
        json={
            "title": "Pick a Bun",
            "sku": "PICK-BUN",
            "base_price": 15.0,
            "combo_items": [
                {"selection_type": "category", "category_name": "Buns", "quantity": 1},
            ],
        },
    )
    assert create_res.status_code == 200
    deal_id = create_res.get_json()["id"]

    list_res = client.get("/api/menu/deals/", headers=h)
    created_deal = next(d for d in list_res.get_json()["deals"] if d["id"] == deal_id)
    choice_row = created_deal["combo_items"][0]

    with app.app_context():
        br = Branch.query.filter_by(name="DealsBranch").first()

    bad_checkout = client.post(
        "/api/orders/checkout",
        headers=h,
        json={
            "branch_id": br.id,
            "payment_method": "Cash",
            "items": [
                {
                    "product_id": deal_id,
                    "quantity": 1,
                    "deal_selections": [{"combo_item_id": choice_row["id"], "product_id": coke_id}],
                }
            ],
        },
    )
    assert bad_checkout.status_code == 400


@pytest.mark.parametrize("path", ["/api/menu/deals/", "/api/inventory-advanced/deals/"])
def test_deal_create_requires_owner(client, app, path):
    owner_headers = _auth_headers(client, app)
    cashier_headers = _cashier_headers(client, app)

    r_b = client.post(
        "/api/menu-items/",
        headers=owner_headers,
        json={"sku": "AUTH-B", "title": "Auth Burger", "base_price": 5.0, "section": "Mains"},
    )
    burger_id = r_b.get_json()["id"]
    r_f = client.post(
        "/api/menu-items/",
        headers=owner_headers,
        json={"sku": "AUTH-F", "title": "Auth Fries", "base_price": 3.0, "section": "Sides"},
    )
    fries_id = r_f.get_json()["id"]

    r = client.post(
        path,
        headers=cashier_headers,
        json={
            "title": "Unauthorized Combo",
            "sku": f"AUTH-C-{path.split('/')[2]}",
            "base_price": 7.0,
            "combo_items": [
                {"product_id": burger_id, "quantity": 1},
                {"product_id": fries_id, "quantity": 1},
            ],
        },
    )
    assert r.status_code == 403
