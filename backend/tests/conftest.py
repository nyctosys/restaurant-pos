"""
Pytest configuration and fixtures for backend tests.
Uses in-memory SQLite so tests do not touch the development database.
"""
import os
import pytest
from fastapi.testclient import TestClient

# Override DB to in-memory SQLite before app is imported
os.environ["DATABASE_URL"] = "sqlite:///:memory:"

from app import app as fastapi_app, flask_sqlalchemy_app
from app.models import db


@pytest.fixture
def app():
    flask_sqlalchemy_app.config["TESTING"] = True
    return flask_sqlalchemy_app


@pytest.fixture
def client(app):
    class _ResponseCompat:
        def __init__(self, response):
            self._response = response

        def get_json(self):
            return self._response.json()

        def __getattr__(self, name):
            return getattr(self._response, name)

    class _ClientCompat:
        def __init__(self, tc: TestClient):
            self._tc = tc

        def get(self, *args, **kwargs):
            return _ResponseCompat(self._tc.get(*args, **kwargs))

        def post(self, *args, **kwargs):
            return _ResponseCompat(self._tc.post(*args, **kwargs))

        def put(self, *args, **kwargs):
            return _ResponseCompat(self._tc.put(*args, **kwargs))

        def patch(self, *args, **kwargs):
            return _ResponseCompat(self._tc.patch(*args, **kwargs))

        def delete(self, *args, **kwargs):
            return _ResponseCompat(self._tc.delete(*args, **kwargs))

    tc = TestClient(fastapi_app, raise_server_exceptions=False)
    try:
        yield _ClientCompat(tc)
    finally:
        tc.close()


@pytest.fixture(autouse=True)
def reset_db(app):
    """Reset database before each test so tests do not depend on each other."""
    with app.app_context():
        db.drop_all()
        db.create_all()
    yield
