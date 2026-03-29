import pytest
from app.models import db, Branch, User, Product, Supplier, Ingredient, RecipeItem, PurchaseOrder, Inventory
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

def test_deals_creation_and_checkout(client, app):
    h = _auth_headers(client, app)
    
    # 1. Setup product A (Burger) and product B (Fries)
    r_b = client.post("/api/menu-items/", headers=h, json={"sku": "B-001", "title": "Burger", "base_price": 5.0})
    id_burger = r_b.get_json()["id"]
    r_f = client.post("/api/menu-items/", headers=h, json={"sku": "F-001", "title": "Fries", "base_price": 3.0})
    id_fries = r_f.get_json()["id"]

    # 2. Add some inventory to both
    with app.app_context():
        br = Branch.query.filter_by(name="DealsBranch").first()
        db.session.add(Inventory(branch_id=br.id, product_id=id_burger, stock_level=10))
        db.session.add(Inventory(branch_id=br.id, product_id=id_fries, stock_level=10))
        db.session.commit()

    # 3. Create a deal (Burger + Fries)
    r_d = client.post("/api/inventory-advanced/deals/", headers=h, json={
        "title": "Burger Combo",
        "sku": "COMBO-1",
        "base_price": 7.0,
        "combo_items": [
            {"product_id": id_burger, "quantity": 1},
            {"product_id": id_fries, "quantity": 1}
        ]
    })
    assert r_d.status_code == 200
    id_deal = r_d.get_json()["id"]

    # Verify deal exists
    r_dl = client.get("/api/inventory-advanced/deals/", headers=h)
    deals = r_dl.get_json()["deals"]
    assert len(deals) > 0
    assert any(d["id"] == id_deal for d in deals)

    # 4. Checkout the Deal
    r_checkout = client.post("/api/sales/checkout", headers=h, json={
        "branch_id": br.id,
        "payment_method": "Cash",
        "items": [
            {"product_id": id_deal, "quantity": 2} # Buy 2 combos
        ]
    })
    assert r_checkout.status_code == 201
    sale_id = r_checkout.get_json()["sale_id"]

    # 5. Verify standard inventory deduction for child products
    with app.app_context():
        inv_burger = Inventory.query.filter_by(product_id=id_burger).first()
        inv_fries = Inventory.query.filter_by(product_id=id_fries).first()
        # Started at 10, bought 2 combos (1 burger each) = 8
        assert inv_burger.stock_level == 8
        assert inv_fries.stock_level == 8

def test_deals_checkout_with_ingredients(client, app):
    h = _auth_headers(client, app)

    # Ingredients
    r_ing1 = client.post("/api/inventory-advanced/ingredients", headers=h, json={"name": "Patty", "sku": "ING-P", "unit": "piece"})
    id_patty = r_ing1.get_json()["id"]

    # Product (Burger with Patty)
    r_p = client.post("/api/menu-items/", headers=h, json={"sku": "B-PATTY", "title": "Patty Burger", "base_price": 5.0})
    id_burger = r_p.get_json()["id"]

    # Map recipe
    client.post("/api/inventory-advanced/recipes", headers=h, json={
        "product_id": id_burger,
        "ingredient_id": id_patty,
        "quantity": 1,
        "unit": "piece"
    })

    # Add inventory
    with app.app_context():
        br = Branch.query.filter_by(name="DealsBranch").first()
        db.session.add(Inventory(branch_id=br.id, product_id=id_burger, stock_level=5))
        ing = Ingredient.query.get(id_patty)
        ing.current_stock = 10
        db.session.commit()

    # Create deal
    r_d = client.post("/api/inventory-advanced/deals/", headers=h, json={
        "title": "Double Deal",
        "sku": "DD-1",
        "base_price": 9.0,
        "combo_items": [{"product_id": id_burger, "quantity": 2}] # Deal has 2 burgers
    })
    id_deal = r_d.get_json()["id"]

    # Checkout 1 Deal
    r_checkout = client.post("/api/sales/checkout", headers=h, json={
        "branch_id": br.id,
        "payment_method": "Cash",
        "items": [{"product_id": id_deal, "quantity": 1}]
    })
    assert r_checkout.status_code == 201

    # Verify inventory and ingredient stock
    with app.app_context():
        inv_burger = Inventory.query.filter_by(product_id=id_burger).first()
        assert inv_burger.stock_level == 3 # 5 - 2

        patty = Ingredient.query.get(id_patty)
        assert patty.current_stock == 8 # 10 - 2
