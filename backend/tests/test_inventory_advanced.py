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
        "unit": "kg"
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
