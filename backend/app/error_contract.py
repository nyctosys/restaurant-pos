"""
Unified JSON error shape for API responses.

Client-facing shape:
  { "error": str, "message": str, "requestId"?: str, "code"?: str, "details"?: any }

In development (APP_DEBUG=1), optional "debug" may be present on 500s.
"""
from __future__ import annotations

import os
from typing import Any

from fastapi import Request
from starlette.status import HTTP_500_INTERNAL_SERVER_ERROR

# HTTP status code -> short error title (stable, safe for clients)
_STATUS_TITLES: dict[int, str] = {
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    409: "Conflict",
    422: "Unprocessable Entity",
    429: "Too Many Requests",
    500: "Internal Server Error",
    503: "Service Unavailable",
}


def is_debug_mode() -> bool:
    return os.environ.get("APP_DEBUG", "").lower() in ("1", "true", "yes")


def http_error_title(status_code: int) -> str:
    return _STATUS_TITLES.get(status_code, "Error")


def request_id_from_request(request: Request) -> str | None:
    rid = getattr(request.state, "request_id", None)
    if isinstance(rid, str) and rid:
        return rid
    return None


def normalize_error_body(
    *,
    status_code: int,
    request: Request | None,
    detail: Any,
) -> dict[str, Any]:
    """
    Build a unified error dict from HTTPException.detail (str, dict, or list).
    """
    request_id = request_id_from_request(request) if request else None

    if isinstance(detail, dict):
        body: dict[str, Any] = {**detail}
        if "message" not in body and "detail" in body:
            body["message"] = str(body.pop("detail"))
        if "error" not in body:
            body["error"] = http_error_title(status_code)
        if "message" not in body:
            body["message"] = body.get("error", http_error_title(status_code))
    elif isinstance(detail, str):
        body = {
            "error": http_error_title(status_code),
            "message": detail,
        }
    elif isinstance(detail, list):
        # FastAPI / Pydantic validation errors
        body = {
            "error": http_error_title(status_code),
            "message": "Validation failed",
            "details": detail,
        }
    else:
        body = {
            "error": http_error_title(status_code),
            "message": str(detail) if detail is not None else http_error_title(status_code),
        }

    if request_id and "requestId" not in body:
        body["requestId"] = request_id
    return body


def internal_server_error_body(
    request: Request | None,
    *,
    public_message: str = "An unexpected error occurred.",
    exc: Exception | None = None,
) -> dict[str, Any]:
    request_id = request_id_from_request(request) if request else None
    body: dict[str, Any] = {
        "error": "Internal Server Error",
        "message": public_message,
    }
    if request_id:
        body["requestId"] = request_id
    if is_debug_mode() and exc is not None:
        body["debug"] = {"type": type(exc).__name__, "str": str(exc)}
    return body
