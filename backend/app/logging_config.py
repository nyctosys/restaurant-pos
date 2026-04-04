"""
Centralized logging setup for the FastAPI app and SQLAlchemy stack.
Uses stdout for container-friendly aggregation; level via LOG_LEVEL env.
"""
from __future__ import annotations

import logging
import os
import sys


def setup_logging() -> None:
    """Idempotent logging bootstrap. Call once at process startup."""
    level_name = os.environ.get("LOG_LEVEL", "INFO").upper()
    level = getattr(logging, level_name, logging.INFO)

    fmt = "%(asctime)s %(levelname)s [%(name)s] %(message)s"
    datefmt = "%Y-%m-%dT%H:%M:%S"

    root = logging.getLogger()
    # Avoid duplicate handlers if setup_logging is called twice (e.g. tests)
    if not root.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(logging.Formatter(fmt=fmt, datefmt=datefmt))
        root.addHandler(handler)
    root.setLevel(level)

    # App loggers
    for name in ("app.request", "app.errors", "app.events"):
        logging.getLogger(name).setLevel(level)

    # Reduce noisy defaults from the ASGI stack
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("uvicorn.error").setLevel(logging.INFO)
