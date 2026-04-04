"""Small helpers shared across FastAPI routers."""


def yes(v: str | None) -> bool:
    """Parse typical truthy query-string flags: 1, true, yes (case-insensitive)."""
    return (v or "").lower() in ("1", "true", "yes")
