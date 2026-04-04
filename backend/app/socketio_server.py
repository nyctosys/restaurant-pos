from __future__ import annotations

from typing import Any

import socketio


class RealtimeEvents:
    ORDER_CREATED = "ORDER_CREATED"
    ORDER_UPDATED = "ORDER_UPDATED"
    ORDER_STATUS_CHANGED = "ORDER_STATUS_CHANGED"


sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins="*")
# Mounted under "/socket.io" by FastAPI; empty path avoids "/socket.io/socket.io" duplication.
asgi_app = socketio.ASGIApp(sio, socketio_path="")


async def emit_event(event: str, payload: dict[str, Any]) -> None:
    # Broadcast to all clients. If we later need per-branch rooms, we can add that here.
    await sio.emit(event, payload)

