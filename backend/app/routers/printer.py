from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from app.models import User
from app.services.printer_service import PrinterService
from app.deps import get_current_user

printer_router = APIRouter(prefix="/api/printer", tags=["printer"])


@printer_router.get("/status")
def printer_status(_: User = Depends(get_current_user)):
    printer_service = PrinterService()
    try:
        connected = printer_service.connect()
        if connected:
            return {"status": "connected", "message": "Printer is connected and ready"}
        return {"status": "disconnected", "message": "Printer not found or not configured"}
    except Exception as exc:
        return {"status": "error", "message": str(exc)}
    finally:
        # Status checks should never keep handles open; fresh handles are safer per print job.
        printer_service._disconnect()


@printer_router.post("/test-print")
def test_print(current_user: User = Depends(get_current_user)):
    try:
        printer_service = PrinterService()
        test_receipt = {
            "subtotal": 110.00,
            "tax_amount": 9.00,
            "tax_rate": 8,
            "total": 119.00,
            "operator": current_user.username,
            "branch": "Test Branch",
            "items": [{"title": "Item A", "quantity": 1, "unit_price": 25.00}, {"title": "Item B", "quantity": 1, "unit_price": 85.00}],
            "_test_print": True,
        }
        ok = printer_service.print_receipt(test_receipt)
        if ok:
            return {"success": True, "message": "Test print completed"}
        return JSONResponse(status_code=503, content={"success": False, "message": "Failed to print. Check printer connection and settings."})
    except Exception as exc:
        return JSONResponse(status_code=500, content={"success": False, "message": str(exc)})


@printer_router.post("/test-kot-print")
def test_kot_print(current_user: User = Depends(get_current_user)):
    try:
        printer_service = PrinterService()
        test_kot = {
            "sale_id": "TEST-KOT",
            "branch": "Test Branch",
            "operator": current_user.username,
            "table_name": "T-01",
            "items": [
                {"title": "Chicken Burger", "quantity": 2, "variant_sku_suffix": "Large", "modifiers": ["Extra Cheese"]},
                {"title": "Fries", "quantity": 1, "modifiers": []},
            ],
        }
        ok = printer_service.print_kot(test_kot)
        if ok:
            return {"success": True, "message": "Test KOT print completed"}
        return JSONResponse(status_code=503, content={"success": False, "message": "Failed to print KOT. Check printer connection and settings."})
    except Exception as exc:
        return JSONResponse(status_code=500, content={"success": False, "message": str(exc)})


@printer_router.post("/print-receipt")
def print_receipt(payload: dict[str, Any] | None = None, _: User = Depends(get_current_user)):
    data = payload or {}
    if "receipt_data" not in data:
        return JSONResponse(status_code=400, content={"success": False, "message": "Missing receipt_data in payload"})
    try:
        ok = PrinterService().print_receipt(data["receipt_data"])
        if ok:
            return {"success": True}
        return JSONResponse(status_code=503, content={"success": False, "error": "Hardware print failed"})
    except Exception as exc:
        return JSONResponse(status_code=500, content={"success": False, "error": str(exc)})


@printer_router.post("/print-barcode-label")
def print_barcode_label(payload: dict[str, Any] | None = None, _: User = Depends(get_current_user)):
    data = payload or {}
    if "sku" not in data:
        return JSONResponse(status_code=400, content={"success": False, "message": "Missing sku in payload"})
    try:
        ok = PrinterService().print_barcode_label(sku=data["sku"], title=data.get("title") or "")
        if ok:
            return {"success": True}
        return JSONResponse(status_code=503, content={"success": False, "message": "Printer not available or print failed"})
    except Exception as exc:
        return JSONResponse(status_code=500, content={"success": False, "error": str(exc)})
