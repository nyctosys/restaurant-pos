import re

from app.models import Branch, Setting, SyncOutbox, User, db
from werkzeug.security import generate_password_hash


def _headers_for_user(client, app, *, username: str, role: str, branch_id: str | None):
    with app.app_context():
        user = User(
            username=username,
            password_hash=generate_password_hash("pass"),
            role=role,
            branch_id=branch_id,
        )
        db.session.add(user)
        db.session.commit()
    response = client.post("/api/auth/login", json={"username": username, "password": "pass"})
    token = response.get_json()["token"]
    return {"Authorization": f"Bearer {token}"}


def test_owner_branch_scoped_settings_ignore_stale_client_branch_id(client, app):
    with app.app_context():
        branch_a = Branch(name="Main")
        branch_b = Branch(name="Other")
        db.session.add_all([branch_a, branch_b])
        db.session.commit()
        branch_a_id = branch_a.id
        branch_b_id = branch_b.id

    headers = _headers_for_user(client, app, username="owner1", role="owner", branch_id=branch_a_id)

    response = client.put(
        "/api/settings/",
        headers=headers,
        json={"branch_id": branch_b_id, "config": {"sections": ["Burgers"]}},
    )

    assert response.status_code == 200
    with app.app_context():
        branch_a_settings = Setting.query.filter_by(branch_id=branch_a_id).first()
        branch_b_settings = Setting.query.filter_by(branch_id=branch_b_id).first()
        outbox = SyncOutbox.query.filter_by(entity_type="settings", event_type="settings_updated").one()
        assert branch_a_settings is not None
        assert branch_a_settings.config["sections"] == ["Burgers"]
        assert branch_b_settings is None
        assert outbox.branch_id == branch_a_id
        assert re.fullmatch(r"[0-9a-f]{32}", outbox.branch_id)


def test_manager_branch_scoped_settings_ignore_stale_client_branch_id(client, app):
    with app.app_context():
        branch_a = Branch(name="Main")
        branch_b = Branch(name="Other")
        db.session.add_all([branch_a, branch_b])
        db.session.commit()
        branch_a_id = branch_a.id
        branch_b_id = branch_b.id

    headers = _headers_for_user(client, app, username="manager1", role="manager", branch_id=branch_a_id)

    response = client.put(
        "/api/settings/",
        headers=headers,
        json={"branch_id": branch_b_id, "config": {"tables": ["T1", "T2"]}},
    )

    assert response.status_code == 200
    with app.app_context():
        branch_a_settings = Setting.query.filter_by(branch_id=branch_a_id).first()
        branch_b_settings = Setting.query.filter_by(branch_id=branch_b_id).first()
        assert branch_a_settings is not None
        assert branch_a_settings.config["tables"] == ["T1", "T2"]
        assert branch_b_settings is None


def test_manager_cannot_update_global_settings(client, app):
    with app.app_context():
        branch = Branch(name="Main")
        db.session.add(branch)
        db.session.commit()
        branch_id = branch.id

    headers = _headers_for_user(client, app, username="manager2", role="manager", branch_id=branch_id)

    response = client.put(
        "/api/settings/",
        headers=headers,
        json={"branch_id": None, "config": {"tax_enabled": True}},
    )

    assert response.status_code == 403
    assert "global settings" in (response.get_json().get("message") or "").lower()
