"""Test request logging middleware adds X-Request-ID and logs."""
import pytest


def test_health_route_does_not_require_request_id(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    # Middleware may still add header; we just check health works
    assert r.get_json().get("status") == "healthy"


def test_api_returns_request_id(client):
    r = client.get("/api/menu-items/")
    assert "X-Request-ID" in r.headers
    assert len(r.headers["X-Request-ID"]) > 0
