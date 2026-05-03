"""Small process-local TTL cache for read-heavy API paths (no external deps)."""

from __future__ import annotations

import threading
import time
from typing import Any, Callable, TypeVar

T = TypeVar("T")


class TtlCache:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._data: dict[str, tuple[float, Any]] = {}

    def get(self, key: str) -> Any | None:
        now = time.monotonic()
        with self._lock:
            entry = self._data.get(key)
            if entry is None:
                return None
            exp, val = entry
            if now >= exp:
                del self._data[key]
                return None
            return val

    def set(self, key: str, value: Any, ttl_seconds: float) -> None:
        if ttl_seconds <= 0:
            return
        exp = time.monotonic() + ttl_seconds
        with self._lock:
            self._data[key] = (exp, value)

    def delete_prefix(self, prefix: str) -> None:
        with self._lock:
            for k in list(self._data.keys()):
                if k.startswith(prefix):
                    del self._data[k]

    def get_or_set(self, key: str, ttl_seconds: float, factory: Callable[[], T]) -> T:
        hit = self.get(key)
        if hit is not None:
            return hit  # type: ignore[return-value]
        val = factory()
        self.set(key, val, ttl_seconds)
        return val


settings_response_cache = TtlCache()

SETTINGS_CACHE_TTL_S = 20.0
SETTINGS_CACHE_KEY_PREFIX = "settings:get:"
