from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app.models import Product
from app.realtime import scanner_hub
from app.services.product_pricing import effective_sale_price

scanner_router = APIRouter(prefix="/api/scanner", tags=["scanner"])


@scanner_router.post("/webhook")
async def scanner_webhook(payload: dict[str, Any] | None = None):
    data = payload or {}
    barcode = data.get("barcode")
    if not barcode:
        return JSONResponse(status_code=400, content={"message": "Invalid payload — 'barcode' field required"})
    await scanner_hub.broadcast_scan(str(barcode))
    return {"status": "received", "barcode": str(barcode)}


@scanner_router.get("/lookup/{barcode}")
def scanner_lookup(barcode: str):
    product = Product.query.filter_by(sku=barcode).first()
    if not product:
        return JSONResponse(status_code=404, content={"found": False, "message": f"No product found for barcode: {barcode}"})
    return {
        "found": True,
        "product": {
            "id": product.id,
            "sku": product.sku,
            "title": product.title,
            "base_price": float(product.base_price),
            "sale_price": effective_sale_price(product),
            "section": product.section or "",
            "variants": product.variants or [],
        },
    }
