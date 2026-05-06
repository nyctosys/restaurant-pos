from datetime import datetime, timezone

from app.models import Branch, Product, Sale, SaleItem, User, db


def _login_owner(client):
    client.post(
        "/api/auth/setup",
        json={"username": "owner1", "password": "pass", "branch_name": "Main"},
    )
    res = client.post("/api/auth/login", json={"username": "owner1", "password": "pass"})
    assert res.status_code == 200
    return res.get_json()["token"]


def test_detailed_report_groups_payment_methods_and_order_types(client, app):
    token = _login_owner(client)
    now = datetime.now(timezone.utc)

    with app.app_context():
        branch = Branch.query.filter_by(name="Main").first()
        user = User.query.filter_by(username="owner1").first()
        product = Product(sku="REPORT-ITEM", title="Report Burger", base_price=100, sale_price=100)
        db.session.add(product)
        db.session.flush()

        sales = [
            Sale(branch_id=branch.id, user_id=user.id, total_amount=100, tax_amount=0, payment_method="Cash", status="completed", order_type="takeaway", created_at=now),
            Sale(branch_id=branch.id, user_id=user.id, total_amount=250, tax_amount=0, payment_method="Cash", status="completed", order_type="delivery", delivery_charge=50, created_at=now),
            Sale(branch_id=branch.id, user_id=user.id, total_amount=300, tax_amount=0, payment_method="Online Transfer", status="completed", order_type="dine_in", service_charge=25, created_at=now),
            Sale(branch_id=branch.id, user_id=user.id, total_amount=400, tax_amount=0, payment_method="Card", status="completed", order_type="delivery", delivery_charge=75, created_at=now),
            Sale(branch_id=branch.id, user_id=user.id, total_amount=999, tax_amount=0, payment_method="Cash", status="refunded", order_type="takeaway", created_at=now),
            Sale(branch_id=branch.id, user_id=user.id, total_amount=111, tax_amount=0, payment_method=None, status="open", order_type="dine_in", created_at=now),
        ]
        db.session.add_all(sales)
        db.session.flush()
        db.session.add_all(
            [
                SaleItem(sale_id=sales[0].id, product_id=product.id, quantity=2, unit_price=50, subtotal=100),
                SaleItem(sale_id=sales[1].id, product_id=product.id, quantity=1, unit_price=200, subtotal=200),
            ]
        )
        db.session.commit()

    res = client.get("/api/orders/report?time_filter=today", headers={"Authorization": f"Bearer {token}"})

    assert res.status_code == 200
    data = res.get_json()
    assert data["totals"]["orders"] == 4
    assert data["totals"]["received_amount"] == 1050.0
    assert data["totals"]["profit_amount"] == 0.0
    assert data["totals"]["refunded_orders"] == 1
    assert data["totals"]["open_orders"] == 1
    assert data["payment_methods"]["cash"] == {"orders": 2, "amount": 350.0}
    assert data["payment_methods"]["online_transfer"] == {"orders": 1, "amount": 300.0}
    assert data["payment_methods"]["card"] == {"orders": 1, "amount": 400.0}
    assert data["order_types"]["delivery"] == {"orders": 2, "amount": 650.0}
    assert data["order_types"]["dine_in"] == {"orders": 1, "amount": 300.0}
    assert data["order_types"]["takeaway"] == {"orders": 1, "amount": 100.0}
    assert data["totals"]["delivery_charge"] == 125.0
    assert data["totals"]["service_charge"] == 25.0
    assert data["most_selling_product"]["title"] == "Report Burger"
    assert data["most_selling_product"]["total_sold"] == 3
