from datetime import datetime, timedelta, timezone

import jwt
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from werkzeug.security import generate_password_hash

from app.deps import SECRET_KEY
from app.idempotency import IdempotencyMiddleware
from app.main import RequestContextDBMiddleware
from app.models import Branch, IdempotencyRecord, User, db


def _seed_user(app):
    with app.app_context():
        branch = Branch(name="Main")
        db.session.add(branch)
        db.session.flush()
        user = User(
            username="idem",
            password_hash=generate_password_hash("pass"),
            role="owner",
            branch_id=branch.id,
        )
        db.session.add(user)
        db.session.commit()
        token = jwt.encode(
            {
                "user_id": user.id,
                "role": user.role,
                "branch_id": branch.id,
                "exp": datetime.now(timezone.utc) + timedelta(days=30),
            },
            SECRET_KEY,
            algorithm="HS256",
        )
        return token


def test_idempotency_does_not_replay_5xx_responses(app):
    token = _seed_user(app)
    calls = {"count": 0}
    test_app = FastAPI()

    @test_app.post("/api/orders/checkout")
    def flaky_checkout():
        calls["count"] += 1
        return JSONResponse(status_code=500, content={"attempt": calls["count"]})

    test_app.add_middleware(IdempotencyMiddleware)
    test_app.add_middleware(RequestContextDBMiddleware)
    client = TestClient(test_app, raise_server_exceptions=False)
    headers = {"Authorization": f"Bearer {token}", "X-Idempotency-Key": "idem-500"}

    first = client.post("/api/orders/checkout", headers=headers, json={"items": [1]})
    second = client.post("/api/orders/checkout", headers=headers, json={"items": [1]})

    assert first.status_code == 500
    assert second.status_code == 500
    assert first.json() == {"attempt": 1}
    assert second.json() == {"attempt": 2}
    assert second.headers.get("X-Idempotency-Replayed") == "false"
    assert calls["count"] == 2
    with app.app_context():
        record = IdempotencyRecord.query.filter_by(idempotency_key="idem-500").first()
        assert record is not None
        assert record.state == "failed"
        assert record.response_status is None
