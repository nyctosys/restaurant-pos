"""Test auth: setup, login, token required, user not found after decode."""
import pytest
from app import create_app
from app.models import db, User, Branch
from werkzeug.security import generate_password_hash


def test_setup_creates_owner_and_returns_token(client):
    r = client.post(
        "/api/auth/setup",
        json={"username": "owner1", "password": "pass123", "branch_name": "Main"},
    )
    assert r.status_code == 201
    data = r.get_json()
    assert "token" in data
    assert data.get("user", {}).get("role") == "owner"


def test_setup_fails_when_already_initialized(client):
    client.post(
        "/api/auth/setup",
        json={"username": "owner1", "password": "pass123", "branch_name": "Main"},
    )
    r = client.post(
        "/api/auth/setup",
        json={"username": "owner2", "password": "pass456", "branch_name": "Other"},
    )
    assert r.status_code == 400
    assert "already initialized" in (r.get_json().get("error") or "").lower()


def test_login_success(client, app):
    with app.app_context():
        b = Branch(name="Main")
        db.session.add(b)
        db.session.flush()
        u = User(
            username="cashier1",
            password_hash=generate_password_hash("secret"),
            role="cashier",
            branch_id=b.id,
        )
        db.session.add(u)
        db.session.commit()
    r = client.post("/api/auth/login", json={"username": "cashier1", "password": "secret"})
    assert r.status_code == 200
    assert "token" in r.get_json()


def test_login_invalid_credentials(client, app):
    with app.app_context():
        b = Branch(name="Main")
        db.session.add(b)
        db.session.flush()
        u = User(
            username="u1",
            password_hash=generate_password_hash("right"),
            role="cashier",
            branch_id=b.id,
        )
        db.session.add(u)
        db.session.commit()
    r = client.post("/api/auth/login", json={"username": "u1", "password": "wrong"})
    assert r.status_code == 401


def test_token_required_rejects_missing_token(client):
    # Use trailing slash to match Flask route and avoid 308 redirect
    r = client.get("/api/products/")
    assert r.status_code == 401
    data = r.get_json()
    assert "token" in (data.get("message") or "").lower() or "missing" in (data.get("message") or "").lower()


def test_token_required_rejects_invalid_token(client):
    r = client.get(
        "/api/products/",
        headers={"Authorization": "Bearer invalid-token"},
    )
    assert r.status_code == 401


def test_token_valid_but_user_deleted_returns_401(client, app):
    """User deleted after token was issued -> 401 User not found."""
    import jwt
    import os
    from datetime import datetime, timedelta

    with app.app_context():
        b = Branch(name="Main")
        db.session.add(b)
        db.session.flush()
        u = User(
            username="deleted_user",
            password_hash=generate_password_hash("x"),
            role="cashier",
            branch_id=b.id,
        )
        db.session.add(u)
        db.session.commit()
        user_id = u.id
        secret = os.environ.get("SECRET_KEY", "dev_secret_key_change_in_production")
        token = jwt.encode(
            {"user_id": user_id, "exp": datetime.utcnow() + timedelta(hours=1)},
            secret,
            algorithm="HS256",
        )
        db.session.delete(u)
        db.session.commit()

    r = client.get(
        "/api/products/",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 401
    assert "not found" in (r.get_json().get("message") or "").lower()
