"""Test users list/get/create/update and 404."""
import pytest
from app.models import db, Branch, User
from werkzeug.security import generate_password_hash


def _owner_headers(client, app):
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
    r = client.post("/api/auth/login", json={"username": "owner1", "password": "pass"})
    token = r.get_json()["token"]
    return {"Authorization": f"Bearer {token}"}


def test_users_list_requires_owner(client, app):
    with app.app_context():
        b = Branch(name="Main")
        db.session.add(b)
        db.session.flush()
        u = User(
            username="cashier1",
            password_hash=generate_password_hash("pass"),
            role="cashier",
            branch_id=b.id,
        )
        db.session.add(u)
        db.session.commit()
    r = client.post("/api/auth/login", json={"username": "cashier1", "password": "pass"})
    token = r.get_json()["token"]
    r2 = client.get("/api/users/", headers={"Authorization": f"Bearer {token}"})
    assert r2.status_code == 403


def test_users_get_404(client, app):
    h = _owner_headers(client, app)
    r = client.put(
        "/api/users/99999",
        headers=h,
        json={"username": "x", "password": "y", "role": "cashier"},
    )
    assert r.status_code == 404
    assert "not found" in (r.get_json().get("message") or "").lower()
