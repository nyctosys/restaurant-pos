"""Test branches list/get and 404."""
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


def test_branches_list_requires_auth(client):
    r = client.get("/api/branches/")
    assert r.status_code == 401


def test_branches_get_404(client, app):
    h = _owner_headers(client, app)
    r = client.put("/api/branches/99999", headers=h, json={"name": "X", "address": "", "phone": ""})
    assert r.status_code == 404
    data = r.get_json()
    assert "not found" in (data.get("message") or "").lower()
