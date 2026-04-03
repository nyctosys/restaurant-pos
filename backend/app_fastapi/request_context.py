"""
Request-scoped identifiers for correlation across logs, errors, and persisted events.
"""
from __future__ import annotations

from contextvars import ContextVar

_request_id_ctx: ContextVar[str | None] = ContextVar("request_id", default=None)


def get_request_id() -> str | None:
    return _request_id_ctx.get()


def set_request_id(request_id: str | None) -> None:
    _request_id_ctx.set(request_id)
