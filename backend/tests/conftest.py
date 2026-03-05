"""
Pytest configuration and fixtures for backend tests.
Uses in-memory SQLite so tests do not touch the development database.
"""
import os
import pytest

# Override DB to in-memory SQLite before app is imported
os.environ["DATABASE_URL"] = "sqlite:///:memory:"

from app import create_app
from app.models import db, User, Branch, Product, Inventory, Sale, SaleItem, Setting


@pytest.fixture
def app():
    app = create_app()
    app.config["TESTING"] = True
    return app


@pytest.fixture
def client(app):
    return app.test_client()


@pytest.fixture(autouse=True)
def reset_db(app):
    """Reset database before each test so tests do not depend on each other."""
    with app.app_context():
        db.drop_all()
        db.create_all()
    yield
