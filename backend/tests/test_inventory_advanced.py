import pytest
from app.models import db, Branch, User, Product, Supplier, Ingredient, RecipeItem, PurchaseOrder, PurchaseOrderItem
from werkzeug.security import generate_password_hash

def _auth_headers(client, app):
    with app.app_context():
        # Clean up any previous test state to avoid unique constraint errors
        user = User.query.filter_by(username="owner1").first()
        if not user:
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


def test_create_supplier_and_ingredient(client, app):
    h = _auth_headers(client, app)
    # 1. Create supplier
    r1 = client.post("/api/inventory-advanced/suppliers", headers=h, json={
        "name": "Test Supplier",
        "sku": "SUP-TEST-SUPPLIER",
        "contact_person": "John",
        "email": "john@example.com"
    })
    assert r1.status_code == 200
    sup_id = r1.get_json()["id"]

    # 2. Create ingredient linked to supplier
    r2 = client.post("/api/inventory-advanced/ingredients", headers=h, json={
        "name": "Test Flour",
        "sku": "ING-001",
        "unit": "kg",
        "reorder_quantity": 10.0,
        "preferred_supplier_id": sup_id
    })
    assert r2.status_code == 200
    ing_id = r2.get_json()["id"]

    # Verify ingredient creation
    r3 = client.get("/api/inventory-advanced/ingredients", headers=h)
    ingredients = r3.get_json()["ingredients"]
    assert any(i["id"] == ing_id for i in ingredients)

    r_suppliers = client.get("/api/inventory-advanced/suppliers", headers=h)
    suppliers = r_suppliers.get_json()["suppliers"]
    created_supplier = next(s for s in suppliers if s["id"] == sup_id)
    assert created_supplier["sku"] == "SUP-TEST-SUPPLIER"


def test_update_supplier_sku(client, app):
    h = _auth_headers(client, app)
    create = client.post(
        "/api/inventory-advanced/suppliers",
        headers=h,
        json={"name": "Fresh Farms", "sku": "SUP-FRESH-FARMS"},
    )
    sup_id = create.get_json()["id"]

    update = client.put(
        f"/api/inventory-advanced/suppliers/{sup_id}",
        headers=h,
        json={"sku": "SUP-FRESH-FARMS-002", "phone": "12345"},
    )
    assert update.status_code == 200

    listed = client.get("/api/inventory-advanced/suppliers", headers=h)
    suppliers = listed.get_json()["suppliers"]
    supplier = next(s for s in suppliers if s["id"] == sup_id)
    assert supplier["sku"] == "SUP-FRESH-FARMS-002"
    assert supplier["phone"] == "12345"


def test_recipe_mapping_and_product_deletion(client, app):
    h = _auth_headers(client, app)

    # 1. Create a menu item
    r1 = client.post("/api/menu-items/", headers=h, json={
        "sku": "PROD-001",
        "title": "Burger",
        "base_price": 5.99,
        "section": "Mains",
    })
    assert r1.status_code == 201
    prod_id = r1.get_json()["id"]

    # 2. Create an ingredient
    r2 = client.post("/api/inventory-advanced/ingredients", headers=h, json={
        "name": "Bun",
        "sku": "ING-BUN",
        "unit": "piece"
    })
    ing_id = r2.get_json()["id"]

    # 3. Map RecipeItem
    r3 = client.post("/api/inventory-advanced/recipes", headers=h, json={
        "product_id": prod_id,
        "ingredient_id": ing_id,
        "quantity": 1.0,
        "unit": "piece"
    })
    assert r3.status_code == 200

    # 4. Try deleting the product (Bug fix verification)
    r4 = client.delete(f"/api/menu-items/{prod_id}", headers=h)
    assert r4.status_code == 200
    assert r4.get_json()["message"] == 'Product permanently deleted.'

    # Verify recipe item was cascaded/deleted
    with app.app_context():
        ri = RecipeItem.query.filter_by(product_id=prod_id).first()
        assert ri is None


def test_purchase_order_flow(client, app):
    h = _auth_headers(client, app)
    
    # Setup supplier and ingredient
    r1 = client.post("/api/inventory-advanced/suppliers", headers=h, json={"name": "Veg Supplier"})
    sup_id = r1.get_json()["id"]
    r2 = client.post("/api/inventory-advanced/ingredients", headers=h, json={
        "name": "Tomatoes",
        "sku": "ING-TOM",
        "unit": "kg",
        "preferred_supplier_id": sup_id,
    })
    ing_id = r2.get_json()["id"]

    # 1. Create Draft PO
    r3 = client.post("/api/inventory-advanced/purchase-orders", headers=h, json={
        "supplier_id": sup_id,
        "items": [
            {
                "ingredient_id": ing_id,
                "quantity_ordered": 20,
                "unit_price": 2.50,
                "unit": "kg"
            }
        ]
    })
    assert r3.status_code == 200
    po_id = r3.get_json()["id"]

    # 2. Receive PO
    r4 = client.post(f"/api/inventory-advanced/purchase-orders/{po_id}/receive", headers=h, json={
        "received_date": "2023-10-25T10:00:00Z"
    })
    assert r4.status_code == 200

    # 3. Verify stock increased
    r5 = client.get("/api/inventory-advanced/ingredients", headers=h)
    ings = r5.get_json()["ingredients"]
    tom = next(i for i in ings if i["id"] == ing_id)
    assert tom["current_stock"] == 20
    assert tom["last_purchase_price"] == 2.50


def test_purchase_order_rejects_material_from_another_supplier(client, app):
    h = _auth_headers(client, app)
    veg_supplier = client.post("/api/inventory-advanced/suppliers", headers=h, json={"name": "Veg Supplier"})
    dairy_supplier = client.post("/api/inventory-advanced/suppliers", headers=h, json={"name": "Dairy Supplier"})
    veg_supplier_id = veg_supplier.get_json()["id"]
    dairy_supplier_id = dairy_supplier.get_json()["id"]
    ingredient = client.post("/api/inventory-advanced/ingredients", headers=h, json={
        "name": "Milk",
        "sku": "ING-MILK",
        "unit": "l",
        "preferred_supplier_id": dairy_supplier_id,
    })
    ingredient_id = ingredient.get_json()["id"]

    response = client.post("/api/inventory-advanced/purchase-orders", headers=h, json={
        "supplier_id": veg_supplier_id,
        "items": [
            {
                "ingredient_id": ingredient_id,
                "quantity_ordered": 10,
                "unit_price": 180,
                "unit": "l",
            }
        ],
    })

    assert response.status_code == 400
    assert "not linked" in response.get_json()["message"]


def test_prepared_item_batch_deducts_ingredients(client, app):
    h = _auth_headers(client, app)
    r_ing = client.post("/api/inventory-advanced/ingredients", headers=h, json={
        "name": "Yogurt",
        "sku": "ING-YOG",
        "unit": "kg",
        "current_stock": 10,
        "average_cost": 300,
    })
    ing_id = r_ing.get_json()["id"]

    r_prepared = client.post("/api/inventory-advanced/prepared-items", headers=h, json={
        "name": "Garlic Sauce",
        "sku": "SAUCE-GARLIC",
        "kind": "sauce",
        "unit": "kg",
        "components": [{"ingredient_id": ing_id, "quantity": 0.5, "unit": "kg"}],
    })
    assert r_prepared.status_code == 200
    prepared_id = r_prepared.get_json()["id"]

    r_batch = client.post(
        f"/api/inventory-advanced/prepared-items/{prepared_id}/batches",
        headers=h,
        json={"quantity": 4},
    )
    assert r_batch.status_code == 200

    ingredients = client.get("/api/inventory-advanced/ingredients", headers=h).get_json()["ingredients"]
    yogurt = next(i for i in ingredients if i["id"] == ing_id)
    assert yogurt["current_stock"] == 8

    prepared_items = client.get("/api/inventory-advanced/prepared-items", headers=h).get_json()["prepared_items"]
    garlic = next(i for i in prepared_items if i["id"] == prepared_id)
    assert garlic["current_stock"] == 4


def test_recipe_can_deduct_prepared_sauce_on_sale(client, app):
    h = _auth_headers(client, app)
    r_ing = client.post("/api/inventory-advanced/ingredients", headers=h, json={
        "name": "Chilli Paste",
        "sku": "ING-CHILLI-PASTE",
        "unit": "kg",
        "current_stock": 5,
        "average_cost": 500,
    })
    ing_id = r_ing.get_json()["id"]
    r_prepared = client.post("/api/inventory-advanced/prepared-items", headers=h, json={
        "name": "Hot Sauce",
        "sku": "SAUCE-HOT",
        "kind": "sauce",
        "unit": "kg",
        "components": [{"ingredient_id": ing_id, "quantity": 0.25, "unit": "kg"}],
    })
    prepared_id = r_prepared.get_json()["id"]
    assert client.post(
        f"/api/inventory-advanced/prepared-items/{prepared_id}/batches",
        headers=h,
        json={"quantity": 2},
    ).status_code == 200

    r_product = client.post("/api/menu-items/", headers=h, json={
        "sku": "PROD-WINGS",
        "title": "Hot Wings",
        "base_price": 900,
        "section": "Mains",
    })
    assert r_product.status_code == 201
    product_id = r_product.get_json()["id"]
    r_map = client.post("/api/inventory-advanced/recipes/prepared-items", headers=h, json={
        "product_id": product_id,
        "prepared_item_id": prepared_id,
        "quantity": 0.2,
        "unit": "kg",
    })
    assert r_map.status_code == 200

    r_sale = client.post("/api/orders/checkout", headers=h, json={
        "items": [{"product_id": product_id, "quantity": 3}],
        "payment_method": "cash",
    })
    assert r_sale.status_code == 201

    prepared_items = client.get("/api/inventory-advanced/prepared-items", headers=h).get_json()["prepared_items"]
    hot_sauce = next(i for i in prepared_items if i["id"] == prepared_id)
    assert hot_sauce["current_stock"] == pytest.approx(1.4)


def test_recipe_rejects_ingredient_unit_mismatch(client, app):
    h = _auth_headers(client, app)
    r_product = client.post("/api/menu-items/", headers=h, json={
        "sku": "PROD-UNIT-M1",
        "title": "Unit Test Item",
        "base_price": 100,
        "section": "Mains",
    })
    assert r_product.status_code == 201
    product_id = r_product.get_json()["id"]
    r_ing = client.post("/api/inventory-advanced/ingredients", headers=h, json={
        "name": "Milk",
        "sku": "ING-MILK",
        "unit": "ml",
    })
    ing_id = r_ing.get_json()["id"]
    r_map = client.post("/api/inventory-advanced/recipes", headers=h, json={
        "product_id": product_id,
        "ingredient_id": ing_id,
        "quantity": 50,
        "unit": "kg",
    })
    assert r_map.status_code == 400
    assert "Unit mismatch" in (r_map.get_json().get("message") or "")


def test_recipe_rejects_prepared_item_unit_mismatch(client, app):
    h = _auth_headers(client, app)
    r_product = client.post("/api/menu-items/", headers=h, json={
        "sku": "PROD-UNIT-M2",
        "title": "Unit Test Sauce Item",
        "base_price": 100,
        "section": "Mains",
    })
    assert r_product.status_code == 201
    product_id = r_product.get_json()["id"]
    r_ing = client.post("/api/inventory-advanced/ingredients", headers=h, json={
        "name": "Water",
        "sku": "ING-WATER-U",
        "unit": "l",
    })
    ing_id = r_ing.get_json()["id"]
    r_prepared = client.post("/api/inventory-advanced/prepared-items", headers=h, json={
        "name": "White Sauce",
        "sku": "SAUCE-WHITE-U",
        "kind": "sauce",
        "unit": "l",
        "components": [{"ingredient_id": ing_id, "quantity": 0.1, "unit": "l"}],
    })
    assert r_prepared.status_code == 200
    prepared_id = r_prepared.get_json()["id"]
    r_map = client.post("/api/inventory-advanced/recipes/prepared-items", headers=h, json={
        "product_id": product_id,
        "prepared_item_id": prepared_id,
        "quantity": 0.05,
        "unit": "kg",
    })
    assert r_map.status_code == 400
    assert "Unit mismatch" in (r_map.get_json().get("message") or "")
