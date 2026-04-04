"""App event logs API and correlation with request IDs."""
import pytest

from app.models import Branch, User, db
from werkzeug.security import generate_password_hash


def test_500_includes_request_id_header_and_body(client):
    r = client.get("/api/test-raise")
    assert r.status_code == 500
    assert "X-Request-ID" in r.headers
    data = r.get_json()
    assert data.get("error") == "Internal Server Error"
    assert data.get("requestId") == r.headers["X-Request-ID"]


def test_app_events_get_requires_auth(client):
    r = client.get("/api/settings/app-events")
    assert r.status_code == 401


def test_app_events_get_returns_persisted_unhandled_exception(client):
    from app import flask_sqlalchemy_app

    with flask_sqlalchemy_app.app_context():
        b = Branch(name="Main2")
        db.session.add(b)
        db.session.flush()
        u = User(
            username="logowner2",
            password_hash=generate_password_hash("pass"),
            role="owner",
            branch_id=b.id,
        )
        db.session.add(u)
        db.session.commit()

    client.post("/api/auth/login", json={"username": "logowner2", "password": "pass"})
    r = client.post("/api/auth/login", json={"username": "logowner2", "password": "pass"})
    token = r.get_json()["token"]

    r_err = client.get("/api/test-raise", headers={"Authorization": f"Bearer {token}"})
    assert r_err.status_code == 500
    rid = r_err.get_json().get("requestId")

    r_list = client.get(
        "/api/settings/app-events",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r_list.status_code == 200
    payload = r_list.get_json()
    assert "events" in payload and "total" in payload
    assert payload["total"] >= 1
    match = [e for e in payload["events"] if e.get("requestId") == rid]
    assert len(match) == 1
    assert match[0].get("category") == "unhandled_exception"
    assert "Test exception" in (match[0].get("message") or "")


def test_app_events_filter_by_request_id(client):
    from app import flask_sqlalchemy_app

    with flask_sqlalchemy_app.app_context():
        b = Branch(name="Main3")
        db.session.add(b)
        db.session.flush()
        u = User(
            username="logowner3",
            password_hash=generate_password_hash("pass"),
            role="owner",
            branch_id=b.id,
        )
        db.session.add(u)
        db.session.commit()

    r = client.post("/api/auth/login", json={"username": "logowner3", "password": "pass"})
    token = r.get_json()["token"]
    r_err = client.get("/api/test-raise", headers={"Authorization": f"Bearer {token}"})
    rid = r_err.get_json()["requestId"]

    r_list = client.get(
        f"/api/settings/app-events?requestId={rid}",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r_list.status_code == 200
    assert r_list.get_json()["total"] >= 1
