from __future__ import annotations

import json
import math
import os
import time
from dataclasses import dataclass
from typing import Any
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import urlopen


GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json"
DISTANCE_URL = "https://maps.googleapis.com/maps/api/distancematrix/json"
DISTANCE_CACHE_TTL_SECONDS = max(60, int(os.getenv("DELIVERY_DISTANCE_CACHE_TTL", "3600") or "3600"))
ENABLE_HAVERSINE_FALLBACK = (os.getenv("ENABLE_HAVERSINE_FALLBACK", "1") or "1").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}


@dataclass
class _CacheEntry:
    expires_at: float
    payload: dict[str, Any]


_cache: dict[tuple[str, str], _CacheEntry] = {}


def _normalize_address_for_cache(value: str) -> str:
    return " ".join((value or "").strip().lower().split())


def _safe_float(v: Any) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _haversine_km(origin: tuple[float, float], dest: tuple[float, float]) -> float:
    lat1, lon1 = map(math.radians, origin)
    lat2, lon2 = map(math.radians, dest)
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = (math.sin(dlat / 2) ** 2) + math.cos(lat1) * math.cos(lat2) * (math.sin(dlon / 2) ** 2)
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return 6371.0 * c


def _http_json(url: str, timeout: float = 8.0) -> dict[str, Any]:
    with urlopen(url, timeout=timeout) as response:
        body = response.read().decode("utf-8")
    parsed = json.loads(body)
    return parsed if isinstance(parsed, dict) else {}


def _geocode(address: str, api_key: str) -> tuple[tuple[float, float] | None, str | None]:
    query = urlencode({"address": address, "key": api_key})
    data = _http_json(f"{GEOCODE_URL}?{query}")
    status = (data.get("status") or "").strip()
    if status != "OK":
        return None, status or "ERROR"
    results = data.get("results") or []
    if not isinstance(results, list) or not results:
        return None, "ZERO_RESULTS"
    loc = ((results[0] or {}).get("geometry") or {}).get("location") or {}
    lat = _safe_float(loc.get("lat"))
    lng = _safe_float(loc.get("lng"))
    if lat is None or lng is None:
        return None, "MISSING_COORDS"
    return (lat, lng), None


def _distance_matrix_km(
    origin: tuple[float, float],
    dest: tuple[float, float],
    api_key: str,
) -> tuple[float | None, float | None, str | None]:
    origins = f"{origin[0]},{origin[1]}"
    destinations = f"{dest[0]},{dest[1]}"
    query = urlencode(
        {
            "origins": origins,
            "destinations": destinations,
            "units": "metric",
            "mode": "driving",
            "key": api_key,
        }
    )
    data = _http_json(f"{DISTANCE_URL}?{query}")
    status = (data.get("status") or "").strip()
    if status != "OK":
        return None, None, status or "ERROR"
    rows = data.get("rows") or []
    if not isinstance(rows, list) or not rows:
        return None, None, "NO_ROWS"
    first = rows[0] or {}
    elements = first.get("elements") or []
    if not isinstance(elements, list) or not elements:
        return None, None, "NO_ELEMENTS"
    el = elements[0] or {}
    el_status = (el.get("status") or "").strip()
    if el_status != "OK":
        return None, None, el_status or "ELEMENT_ERROR"
    meters = _safe_float(((el.get("distance") or {}).get("value")))
    seconds = _safe_float(((el.get("duration") or {}).get("value")))
    if meters is None:
        return None, None, "NO_DISTANCE_VALUE"
    km = round(meters / 1000.0, 2)
    mins = round(seconds / 60.0, 1) if seconds is not None else None
    return km, mins, None


def compute_delivery_distance(branch_address: str, customer_address: str, nearest_landmark: str | None = None) -> dict[str, Any]:
    branch = (branch_address or "").strip()
    customer = (customer_address or "").strip()
    landmark = (nearest_landmark or "").strip()
    target = customer or landmark
    if not branch or not target:
        return {
            "found": False,
            "distance_km": None,
            "duration_min": None,
            "source": "unavailable",
            "message": "Branch or customer address / nearest landmark is missing.",
        }

    cache_key = (_normalize_address_for_cache(branch), _normalize_address_for_cache(target))
    now = time.time()
    cached = _cache.get(cache_key)
    if cached and cached.expires_at > now:
        return {**cached.payload, "source": "cached"}

    api_key = (os.getenv("GOOGLE_MAPS_API_KEY") or "").strip()
    if not api_key:
        return {
            "found": False,
            "distance_km": None,
            "duration_min": None,
            "source": "unavailable",
            "message": "Maps API key is not configured.",
        }

    try:
        origin, origin_err = _geocode(branch, api_key)
        dest, dest_err = _geocode(target, api_key)
        if origin is None or dest is None:
            return {
                "found": False,
                "distance_km": None,
                "duration_min": None,
                "source": "unavailable",
                "message": f"Could not geocode address ({origin_err or dest_err or 'unknown'}).",
            }

        distance_km, duration_min, route_err = _distance_matrix_km(origin, dest, api_key)
        if distance_km is not None:
            payload = {
                "found": True,
                "distance_km": distance_km,
                "duration_min": duration_min,
                "source": "google_route",
                "message": None,
            }
            _cache[cache_key] = _CacheEntry(expires_at=now + DISTANCE_CACHE_TTL_SECONDS, payload=payload)
            return payload

        if ENABLE_HAVERSINE_FALLBACK:
            crow_km = round(_haversine_km(origin, dest), 2)
            return {
                "found": True,
                "distance_km": crow_km,
                "duration_min": None,
                "source": "haversine_fallback",
                "message": f"Route API unavailable ({route_err or 'unknown'}). Showing estimate.",
            }
        return {
            "found": False,
            "distance_km": None,
            "duration_min": None,
            "source": "unavailable",
            "message": f"Route distance unavailable ({route_err or 'unknown'}).",
        }
    except (URLError, TimeoutError, ValueError, json.JSONDecodeError):
        return {
            "found": False,
            "distance_km": None,
            "duration_min": None,
            "source": "unavailable",
            "message": "Distance service is temporarily unavailable.",
        }
