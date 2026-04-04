from __future__ import annotations

import asyncio
from typing import Any

from fastapi import WebSocket


class ScannerWebSocketHub:
    def __init__(self) -> None:
        self._connections: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self._connections.add(websocket)

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._connections.discard(websocket)

    async def broadcast_scan(self, barcode: str) -> None:
        payload: dict[str, Any] = {"type": "scan_event", "barcode": barcode}
        async with self._lock:
            sockets = list(self._connections)
        dead: list[WebSocket] = []
        for ws in sockets:
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        if dead:
            async with self._lock:
                for ws in dead:
                    self._connections.discard(ws)


scanner_hub = ScannerWebSocketHub()
