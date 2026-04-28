from __future__ import annotations

import asyncio
import logging
from typing import Any

import socketio

logger = logging.getLogger(__name__)

# Stored at ASGI startup so sync thread-pool handlers can schedule emits
# back onto the main event loop via run_coroutine_threadsafe.
_main_loop: asyncio.AbstractEventLoop | None = None


class RealtimeEvents:
    ORDER_CREATED = "ORDER_CREATED"
    ORDER_UPDATED = "ORDER_UPDATED"
    ORDER_STATUS_CHANGED = "ORDER_STATUS_CHANGED"
    ORDER_READY = "order_ready"


sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins="*")
# Mounted under "/socket.io" by FastAPI; empty path avoids "/socket.io/socket.io" duplication.
asgi_app = socketio.ASGIApp(sio, socketio_path="")


def capture_main_loop() -> None:
    """
    Call this from an async startup hook (lifespan or on_event) so we can
    schedule coroutines from sync thread-pool workers.
    """
    global _main_loop
    try:
        _main_loop = asyncio.get_running_loop()
        logger.debug("socketio_server: captured main event loop %s", _main_loop)
    except RuntimeError:
        logger.warning("socketio_server: capture_main_loop called outside async context — socket emits may fail")


async def emit_event(event: str, payload: dict[str, Any]) -> None:
    """Emit a Socket.IO broadcast. Must be awaited from an async context."""
    await sio.emit(event, payload)


def schedule_emit_event(event: str, payload: dict[str, Any]) -> None:
    """
    Schedule a Socket.IO emit safely from a sync thread-pool worker.

    Uses run_coroutine_threadsafe to post the coroutine onto the main
    asyncio event loop (captured at startup). Falls back to a no-op warning
    if the loop isn't available so that mutations are never aborted.
    """
    loop = _main_loop
    if loop is not None and loop.is_running():
        asyncio.run_coroutine_threadsafe(emit_event(event, payload), loop)
    else:
        # Loop not ready (e.g. during testing or early startup) — skip silently.
        logger.debug(
            "socketio_server: skipping emit '%s' — main loop not available", event
        )
