from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Awaitable, Callable

import jwt
from fastapi.responses import JSONResponse
from sqlalchemy.exc import IntegrityError
from starlette.datastructures import MutableHeaders
from starlette.types import Message, Receive, Scope, Send

from app.deps import SECRET_KEY, _extract_bearer
from app.models import IdempotencyRecord, User, db

CRITICAL_IDEMPOTENT_ROUTES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("POST", re.compile(r"^/api/orders/(checkout|kot|dine-in/kot)$")),
    ("PATCH", re.compile(r"^/api/orders/\d+/(items|kitchen-status|delivery-complete)$")),
    ("POST", re.compile(r"^/api/orders/\d+/(finalize|cancel-open|rollback)$")),
    ("POST", re.compile(r"^/api/stock/(update|bulk-restock)$")),
    ("POST", re.compile(r"^/api/inventory-advanced/prepared-items/\d+/batches$")),
    ("POST", re.compile(r"^/api/inventory-advanced/purchase-orders/\d+/(receive|cancel)$")),
    ("POST", re.compile(r"^/api/inventory-advanced/movements$")),
    ("POST", re.compile(r"^/api/inventory-advanced/recipes$")),
    ("POST", re.compile(r"^/api/inventory-advanced/recipes/prepared-items$")),
    ("POST", re.compile(r"^/api/inventory-advanced/recipes/extra-costs$")),
    ("PATCH", re.compile(r"^/api/inventory-advanced/recipes/extra-costs/\d+$")),
    ("DELETE", re.compile(r"^/api/inventory-advanced/recipes/\d+$")),
    ("DELETE", re.compile(r"^/api/inventory-advanced/recipes/prepared-items/\d+$")),
    ("DELETE", re.compile(r"^/api/inventory-advanced/recipes/extra-costs/\d+$")),
)


def _header_value(scope: Scope, name: str) -> str | None:
    needle = name.lower().encode("latin-1")
    for key, value in scope.get("headers", []):
        if key.lower() == needle:
            return value.decode("latin-1").strip()
    return None


def _is_critical_route(method: str, path: str) -> bool:
    return any(route_method == method and pattern.match(path) for route_method, pattern in CRITICAL_IDEMPOTENT_ROUTES)


async def _read_body(receive: Receive) -> bytes:
    chunks: list[bytes] = []
    more_body = True
    while more_body:
        message = await receive()
        if message["type"] != "http.request":
            continue
        chunks.append(message.get("body", b""))
        more_body = bool(message.get("more_body", False))
    return b"".join(chunks)


def _receive_from_body(body: bytes) -> Receive:
    sent = False

    async def receive() -> Message:
        nonlocal sent
        if sent:
            return {"type": "http.request", "body": b"", "more_body": False}
        sent = True
        return {"type": "http.request", "body": body, "more_body": False}

    return receive


def _current_user_from_scope(scope: Scope) -> User | None:
    token = _extract_bearer(_header_value(scope, "authorization"))
    if not token:
        return None
    try:
        data = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
        user_id = int(data["user_id"])
    except Exception:
        return None
    user = db.session.get(User, user_id)
    if user is None or getattr(user, "archived_at", None):
        return None
    return user


def _request_hash(method: str, path: str, query_string: bytes, body: bytes, user_id: int | None, branch_id: str | None) -> str:
    digest = hashlib.sha256()
    digest.update(method.encode("utf-8"))
    digest.update(b"\n")
    digest.update(path.encode("utf-8"))
    digest.update(b"?")
    digest.update(query_string)
    digest.update(b"\n")
    digest.update(str(user_id or "").encode("utf-8"))
    digest.update(b"\n")
    digest.update(str(branch_id or "").encode("utf-8"))
    digest.update(b"\n")
    digest.update(body)
    return digest.hexdigest()


def _json_conflict(message: str) -> JSONResponse:
    return JSONResponse(
        status_code=409,
        content={
            "error": "Idempotency Conflict",
            "message": message,
            "code": "idempotency_conflict",
        },
        headers={"X-Idempotency-Replayed": "false"},
    )


def _json_processing() -> JSONResponse:
    return JSONResponse(
        status_code=409,
        content={
            "error": "Request Already Processing",
            "message": "A request with this idempotency key is already processing.",
            "code": "idempotency_processing",
        },
        headers={"X-Idempotency-Replayed": "false"},
    )


class IdempotencyMiddleware:
    def __init__(self, app: Callable[[Scope, Receive, Send], Awaitable[None]]):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        method = str(scope.get("method") or "").upper()
        path = str(scope.get("path") or "")
        raw_key = _header_value(scope, "x-idempotency-key")
        if not raw_key or len(raw_key) > 128 or not _is_critical_route(method, path):
            await self.app(scope, receive, send)
            return

        body = await _read_body(receive)
        user = _current_user_from_scope(scope)
        if user is None:
            await self.app(scope, _receive_from_body(body), send)
            return

        branch_id = str(getattr(user, "branch_id", "") or "") or None
        user_id = int(user.id)
        request_hash = _request_hash(method, path, scope.get("query_string", b""), body, user_id, branch_id)
        record = IdempotencyRecord.query.filter_by(idempotency_key=raw_key).first()
        if record is not None:
            if record.request_hash != request_hash:
                await _json_conflict("Idempotency key was already used for a different request.")(scope, receive, send)
                return
            if record.state == "completed" and record.response_status is not None:
                response = JSONResponse(
                    status_code=int(record.response_status),
                    content=record.response_body if record.response_body is not None else {},
                    headers={"X-Idempotency-Replayed": "true"},
                )
                await response(scope, receive, send)
                return
            if record.state == "processing":
                await _json_processing()(scope, receive, send)
                return
            record.state = "processing"
            record.response_status = None
            record.response_body = None
        else:
            record = IdempotencyRecord(
                idempotency_key=raw_key,
                method=method,
                path=path,
                request_hash=request_hash,
                user_id=user_id,
                branch_id=branch_id,
                state="processing",
            )
            db.session.add(record)
        try:
            db.session.commit()
        except IntegrityError:
            db.session.rollback()
            await _json_processing()(scope, receive, send)
            return

        response_start: Message | None = None
        response_body = bytearray()

        async def capture_send(message: Message) -> None:
            nonlocal response_start
            if message["type"] == "http.response.start":
                response_start = dict(message)
                headers = MutableHeaders(scope=response_start)
                headers["X-Idempotency-Replayed"] = "false"
                return
            if message["type"] == "http.response.body":
                response_body.extend(message.get("body", b""))
                return
            await send(message)

        await self.app(scope, _receive_from_body(body), capture_send)

        status = int(response_start["status"]) if response_start else 500
        if status < 500:
            parsed_body: Any
            try:
                parsed_body = json.loads(response_body.decode("utf-8") or "{}")
            except Exception:
                parsed_body = {"raw": response_body.decode("utf-8", errors="replace")}
            record = IdempotencyRecord.query.filter_by(idempotency_key=raw_key).first()
            if record is not None:
                record.response_status = status
                record.response_body = parsed_body
                record.state = "completed"
                db.session.commit()
        else:
            record = IdempotencyRecord.query.filter_by(idempotency_key=raw_key).first()
            if record is not None:
                record.state = "failed"
                record.response_status = None
                record.response_body = None
                db.session.commit()

        if response_start is not None:
            await send(response_start)
        await send({"type": "http.response.body", "body": bytes(response_body), "more_body": False})
