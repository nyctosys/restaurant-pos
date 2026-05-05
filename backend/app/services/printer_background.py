"""Run LAN/USB printer work after the HTTP response to keep checkout/finalize fast.

This module owns a single in-process print dispatcher so receipt/KOT jobs are
serialized and customer receipts always get priority over KOT jobs.
"""

from __future__ import annotations

import logging
import os
import queue
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from itertools import count
from typing import Any

logger = logging.getLogger(__name__)

_job_counter = count(1)
_job_seq = count(1)
_queue_lock = threading.Lock()
_worker_started = False
_print_jobs: queue.PriorityQueue["_QueuedPrintJob"] = queue.PriorityQueue()


@dataclass(order=True)
class _QueuedPrintJob:
    priority: int
    seq: int
    job_id: int
    label: str
    fn: Any
    args: tuple[Any, ...]


def _run_inline_for_tests() -> bool:
    # Keep unit/integration tests deterministic (assertions run right after API call).
    return bool(os.getenv("PYTEST_CURRENT_TEST"))


def _start_worker_if_needed() -> None:
    global _worker_started
    if _worker_started:
        return
    with _queue_lock:
        if _worker_started:
            return
        worker = threading.Thread(
            target=_print_worker_loop,
            name="pos-printer-dispatcher",
            daemon=True,
        )
        worker.start()
        _worker_started = True


def _print_worker_loop() -> None:
    while True:
        job = _print_jobs.get()
        try:
            logger.info("Print job started", extra={"job_id": job.job_id, "label": job.label})
            job.fn(*job.args)
        except Exception:
            logger.exception(
                "Print job failed",
                extra={"job_id": job.job_id, "label": job.label},
            )
        finally:
            _print_jobs.task_done()


def _queue_print_job(priority: int, label: str, fn: Any, *args: Any) -> None:
    if _run_inline_for_tests():
        fn(*args)
        return
    _start_worker_if_needed()
    job_id = next(_job_counter)
    seq = next(_job_seq)
    _print_jobs.put(
        _QueuedPrintJob(
            priority=priority,
            seq=seq,
            job_id=job_id,
            label=label,
            fn=fn,
            args=args,
        )
    )
    logger.info(
        "Print job queued",
        extra={"job_id": job_id, "label": label, "priority": priority},
    )


def _do_print_receipt(receipt_data: dict[str, Any]) -> None:
    try:
        from app.services.printer_service import PrinterService

        PrinterService().print_receipt(receipt_data)
    except Exception:
        logger.exception("Deferred receipt print failed")


def _do_print_kot_modification(mod_payload: dict[str, Any]) -> None:
    """Deferred KOT modification slip — runs after HTTP response is sent."""
    try:
        from app.services.printer_service import PrinterService

        PrinterService().print_kot_modification(mod_payload)
    except Exception:
        logger.exception("Deferred KOT modification print failed")


def _do_print_kot_and_stamp(
    sale_id: int,
    kot_payload: dict[str, Any] | None,
    branch_id: str | None = None,
    operator_name: str | None = None,
) -> None:
    """Print KOT then persist kds_ticket_printed_at in a fresh app context."""
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


def run_print_receipt_job(receipt_data: dict[str, Any]) -> None:
    # Highest priority: customer receipt should never sit behind KOT backlog.
    _queue_print_job(0, "receipt", _do_print_receipt, receipt_data)


def run_print_kot_modification_job(mod_payload: dict[str, Any]) -> None:
    _queue_print_job(1, "kot-modification", _do_print_kot_modification, mod_payload)


def run_print_kot_and_stamp_job(
    sale_id: int,
    kot_payload: dict[str, Any] | None,
    branch_id: str | None = None,
    operator_name: str | None = None,
) -> None:
    """Queue KOT print + stamp after response.

    Pass ``kot_payload=None`` to build payload in the print worker (keeps API fast).
    """
    _queue_print_job(
        1,
        "kot-and-stamp",
        _do_print_kot_and_stamp,
        sale_id,
        kot_payload,
        branch_id,
        operator_name,
    )
