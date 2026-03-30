from __future__ import annotations

import logging
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.exception_handlers import http_exception_handler
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app import create_app as create_flask_app
from app_fastapi.realtime import scanner_hub
from app_fastapi.socketio_server import asgi_app as socketio_asgi_app
from app_fastapi.routers import (
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

request_logger = logging.getLogger("app.request")
legacy_flask_app = create_flask_app()


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield


app = FastAPI(title="Stalls POS API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/socket.io", socketio_asgi_app)


@app.middleware("http")
async def request_context_and_logging(request: Request, call_next):
    # Flask-SQLAlchemy models depend on Flask app context.
    ctx = legacy_flask_app.app_context()
    ctx.push()
    start = time.perf_counter()
    request_id = uuid.uuid4().hex
    try:
        response = await call_next(request)
    except Exception:
        ctx.pop()
        raise
    duration_ms = (time.perf_counter() - start) * 1000
    is_health = request.url.path == "/api/health"
    if not is_health:
        request_logger.info(
            "method=%s path=%s status=%s duration_ms=%.2f request_id=%s",
            request.method,
            request.url.path,
            response.status_code,
            duration_ms,
            request_id,
        )
        response.headers["X-Request-ID"] = request_id
    ctx.pop()
    return response


@app.exception_handler(HTTPException)
async def http_exception_json_handler(request: Request, exc: HTTPException):
    if isinstance(exc.detail, dict):
        return JSONResponse(status_code=exc.status_code, content=exc.detail)
    return await http_exception_handler(request, exc)


@app.exception_handler(Exception)
async def generic_exception_handler(_: Request, exc: Exception):
    logging.getLogger("app.errors").exception("Unhandled exception: %s", exc)
    return JSONResponse(
        status_code=500,
        content={"error": "Internal Server Error", "message": "An unexpected error occurred."},
    )


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
app.include_router(menu_router)
app.include_router(stock_router)
app.include_router(modifiers_router)
app.include_router(orders_router)
app.include_router(users_router)
app.include_router(branches_router)
app.include_router(printer_router)
app.include_router(scanner_router)
