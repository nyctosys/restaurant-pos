"""Test global error handlers return consistent JSON."""
import pytest


def test_404_returns_json(client):
    r = client.get("/api/nonexistent")
    assert r.status_code == 404
    data = r.get_json()
    # FastAPI default: {"detail": "Not Found"}; legacy handlers: { "error", "message" }
    assert "detail" in data or ("error" in data and "message" in data)
    blob = str(data.get("detail", "")) + str(data.get("error", "")) + str(data.get("message", ""))
    assert "not found" in blob.lower()


def test_500_returns_json(client):
    # Route is provided by FastAPI app for error-handler verification.
    r = client.get("/api/test-raise")
    assert r.status_code == 500
    data = r.get_json()
    assert "error" in data
    assert "message" in data
    assert data.get("error") == "Internal Server Error"
    # Message should not expose internal details
    assert "test error" not in (data.get("message") or "")


def test_400_from_route_has_standard_shape(client, app):
    """Routes using error_response return { error, message }."""
    from app.models import db, Branch, User
    from werkzeug.security import generate_password_hash
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
    r = client.post(
        "/api/auth/login",
        json={"username": "owner1", "password": "pass"},
    )
    token = r.get_json()["token"]
    r2 = client.post(
        "/api/orders/checkout",
        headers={"Authorization": f"Bearer {token}"},
        json={"items": [], "payment_method": "Cash"},
    )
    assert r2.status_code == 400
    data = r2.get_json()
    assert "error" in data and "message" in data
    assert data.get("error") == "Bad Request"
