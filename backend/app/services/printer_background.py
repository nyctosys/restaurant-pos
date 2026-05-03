"""Run LAN/USB printer work after the HTTP response to keep checkout/finalize fast."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)


def run_print_receipt_job(receipt_data: dict[str, Any]) -> None:
    try:
        from app.services.printer_service import PrinterService

        PrinterService().print_receipt(receipt_data)
    except Exception:
        logger.exception("Deferred receipt print failed")


def run_print_kot_and_stamp_job(
    sale_id: int,
    kot_payload: dict[str, Any] | None,
    branch_id: str | None = None,
    operator_name: str | None = None,
) -> None:
    """Print KOT then persist kds_ticket_printed_at in a fresh app context (request session is closed).

    Pass ``kot_payload=None`` to build the payload inside this job (faster checkout/KOT HTTP responses).
    """
    try:
        from app.services.printer_service import PrinterService

        payload = kot_payload
        if payload is None:
            from app import database_shell
            from app.routers.orders import _build_kot_print_payload

            with database_shell.app_context():
                payload = _build_kot_print_payload(sale_id, branch_id, operator_name)

        ok = PrinterService().print_kot(payload)
        if not ok:
            return
        from app import database_shell
        from app.models import Sale, db

        with database_shell.app_context():
            sale = db.session.get(Sale, sale_id)
            if sale is None:
                return
            if getattr(sale, "kds_ticket_printed_at", None) is None:
                sale.kds_ticket_printed_at = datetime.now(timezone.utc)
                db.session.commit()
    except Exception:
        logger.exception("Deferred KOT print/stamp failed")
