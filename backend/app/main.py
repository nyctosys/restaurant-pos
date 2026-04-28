from __future__ import annotations

import contextlib
import logging
import time
import uuid
from typing import Any, Callable

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.datastructures import MutableHeaders

from app.database import create_app as init_database_shell
from app.db import bind_request_session, unbind_request_session
from app.services.app_event_log import record_unhandled_exception
from app.error_contract import internal_server_error_body, normalize_error_body, request_id_from_request
from app.logging_config import setup_logging
from app.realtime import scanner_hub
from app.request_context import set_request_id
from app.socketio_server import asgi_app as socketio_asgi_app, capture_main_loop
from app.routers import (
    auth_router,
    branches_router,
    health_router,
    menu_router,
    modifiers_router,
    orders_router,
    printer_router,
    scanner_router,
    settings_router,
    stock_router,
    users_router,
)
from app.routers.app_logs import app_logs_router
from app.routers.inventory_advanced import inventory_advanced_router
from app.routers.deals_router import deals_router, menu_deals_router
from app.routers.sync_outbox_admin import sync_outbox_admin_router

setup_logging()

request_logger = logging.getLogger("app.request")
errors_logger = logging.getLogger("app.errors")
# Initialize engine + schema once at import (FastAPI is the only HTTP server).
database_shell = init_database_shell()


def _incoming_request_id_from_scope(scope: dict[str, Any]) -> str:
    for k, v in scope.get("headers", []):
        key = k.decode("latin-1").lower()
        if key in ("x-request-id",):
            rid = v.decode("latin-1").strip()
            if 0 < len(rid) <= 128:
                return rid
    return uuid.uuid4().hex


class RequestContextDBMiddleware:
    """
    Pure ASGI middleware to preserve ContextVar behavior across Starlette internals.
    """

    def __init__(self, app: Callable):
        self.app = app

    async def __call__(self, scope, receive, send):  # type: ignore[no-untyped-def]
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request_id = _incoming_request_id_from_scope(scope)
        scope.setdefault("state", {})
        scope["state"]["request_id"] = request_id
        set_request_id(request_id)
        session_token = bind_request_session()
        start = time.perf_counter()
        status_code = 500

        async def send_wrapper(message):  # type: ignore[no-untyped-def]
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = int(message["status"])
                headers = MutableHeaders(scope=message)
                headers["X-Request-ID"] = request_id
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            duration_ms = (time.perf_counter() - start) * 1000
            path = scope.get("path", "")
            if path != "/api/health":
                request_logger.info(
                    "method=%s path=%s status=%s duration_ms=%.2f request_id=%s",
                    scope.get("method", ""),
                    path,
                    status_code,
                    duration_ms,
                    request_id,
                )
            unbind_request_session(session_token)
            set_request_id(None)


@contextlib.asynccontextmanager
async def _lifespan(app: FastAPI):  # type: ignore[type-arg]
    # Capture the main event loop so sync route threads can schedule socket emits.
    capture_main_loop()
    yield


app = FastAPI(title="Stalls POS API", lifespan=_lifespan)
# Bearer auth uses Authorization header; cookies are not required. allow_credentials=True
# with allow_origins=["*"] is invalid per CORS and browsers reject (Safari: "access control checks").
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(RequestContextDBMiddleware)


def _err_headers(request: Request) -> dict[str, str]:
    rid = request_id_from_request(request)
    return {"X-Request-ID": rid} if rid else {}


@app.exception_handler(HTTPException)
async def http_exception_json_handler(request: Request, exc: HTTPException):
    content = normalize_error_body(status_code=exc.status_code, request=request, detail=exc.detail)
    return JSONResponse(status_code=exc.status_code, content=content, headers=_err_headers(request))


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    content = normalize_error_body(status_code=422, request=request, detail=exc.errors())
    return JSONResponse(status_code=422, content=content, headers=_err_headers(request))


@app.exception_handler(Exception)
async def generic_exception_handler(request: Request, exc: Exception):
    request_id = getattr(request.state, "request_id", None)
    errors_logger.exception(
        "Unhandled exception request_id=%s path=%s: %s",
        request_id,
        request.url.path,
        exc,
    )
    try:
        record_unhandled_exception(
            exc=exc,
            request_id=request_id,
            route=request.url.path,
            user=None,
        )
    except Exception as persist_exc:
        errors_logger.warning(
            "Failed to persist app_event_logs row request_id=%s: %s",
            request_id,
            persist_exc,
            exc_info=True,
        )
    body = internal_server_error_body(request, exc=exc)
    return JSONResponse(status_code=500, content=body, headers=_err_headers(request))


@app.get("/api/test-raise")
async def test_raise():
    raise RuntimeError("Test exception")


@app.websocket("/api/scanner/ws")
async def scanner_ws(websocket: WebSocket):
    await scanner_hub.connect(websocket)
    try:
        while True:
            _ = await websocket.receive_text()
    except WebSocketDisconnect:
        await scanner_hub.disconnect(websocket)
    except Exception:
        await scanner_hub.disconnect(websocket)


app.include_router(health_router)
app.include_router(auth_router)
app.include_router(settings_router)
app.include_router(app_logs_router)
app.include_router(menu_router)
app.include_router(modifiers_router)
app.include_router(stock_router)
app.include_router(orders_router)
app.include_router(sync_outbox_admin_router)
app.include_router(users_router)
app.include_router(branches_router)
app.include_router(printer_router)
app.include_router(scanner_router)
app.include_router(inventory_advanced_router)
app.include_router(deals_router)
app.include_router(menu_deals_router)
app.mount("/socket.io", socketio_asgi_app)
