"""
Standard error response shape and helpers for global error handling.
"""
import logging
from flask import jsonify

logger = logging.getLogger("app.errors")


def error_response(error: str, message: str, status_code: int, details=None):
    """Build a consistent JSON error response."""
    payload = {"error": error, "message": message}
    if details is not None:
        payload["details"] = details
    return jsonify(payload), status_code


def handle_http_error(e):
    """Handle HTTP-like exceptions (Werkzeug or custom)."""
    if hasattr(e, "code") and hasattr(e, "description"):
        return error_response(
            e.name if hasattr(e, "name") else "Error",
            str(e.description) if e.description else str(e),
            e.code,
        )
    return error_response("Error", str(e), getattr(e, "code", 500))


def handle_generic_exception(e):
    """Log full traceback and return 500 JSON; do not expose internals to client."""
    logger.exception("Unhandled exception: %s", e)
    return error_response(
        "Internal Server Error",
        "An unexpected error occurred.",
        500,
    )
