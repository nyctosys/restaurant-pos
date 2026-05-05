"""Run LAN/USB printer work after the HTTP response to keep checkout/finalize fast.

This module owns a single in-process print dispatcher so receipt/KOT jobs are
serialized and customer receipts always get priority over KOT jobs.
"""

from __future__ import annotations

import logging
import os
import queue
import threading
from collections import deque
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

_MAX_JOB_LOGS = 250
_job_logs_lock = threading.Lock()
_job_logs: deque["PrintJobLogEntry"] = deque(maxlen=_MAX_JOB_LOGS)


@dataclass(frozen=True)
class PrintJobLogEntry:
    job_id: int
    label: str
    status: str  # queued|started|succeeded|failed
    at: str
    message: str | None = None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _append_job_log(job_id: int, label: str, status: str, message: str | None = None) -> None:
    with _job_logs_lock:
        _job_logs.append(
            PrintJobLogEntry(
                job_id=int(job_id),
                label=str(label),
                status=str(status),
                at=_now_iso(),
                message=(str(message)[:800] if message else None),
            )
        )


def get_recent_print_job_logs(limit: int = 50) -> list[dict[str, Any]]:
    """Return most recent print job events (sanitized, in-memory)."""
    try:
        n = int(limit or 50)
    except (TypeError, ValueError):
        n = 50
    n = max(1, min(250, n))
    with _job_logs_lock:
        items = list(_job_logs)[-n:]
    return [
        {
            "job_id": e.job_id,
            "label": e.label,
            "status": e.status,
            "at": e.at,
            "message": e.message,
        }
        for e in reversed(items)
    ]


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
            _append_job_log(job.job_id, job.label, "started")
            ok = job.fn(*job.args)
            if ok is False:
                _append_job_log(job.job_id, job.label, "failed", "Printer reported failure")
            else:
                _append_job_log(job.job_id, job.label, "succeeded")
        except Exception:
            logger.exception(
                "Print job failed",
                extra={"job_id": job.job_id, "label": job.label},
            )
            _append_job_log(job.job_id, job.label, "failed", "Unhandled exception while printing")
        finally:
            _print_jobs.task_done()


def _queue_print_job(priority: int, label: str, fn: Any, *args: Any) -> int | None:
    if _run_inline_for_tests():
        fn(*args)
        return None
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
    _append_job_log(job_id, label, "queued")
    return int(job_id)


def _do_print_receipt(receipt_data: dict[str, Any]) -> bool:
    try:
        from app.services.printer_service import PrinterService

        return bool(PrinterService().print_receipt(receipt_data))
    except Exception:
        logger.exception("Deferred receipt print failed")
        return False


def _do_print_kot_modification(mod_payload: dict[str, Any]) -> bool:
    """Deferred KOT modification slip — runs after HTTP response is sent."""
    try:
        from app.services.printer_service import PrinterService

        return bool(PrinterService().print_kot_modification(mod_payload))
    except Exception:
        logger.exception("Deferred KOT modification print failed")
        return False


def _do_print_kot_and_stamp(
    sale_id: int,
    kot_payload: dict[str, Any] | None,
    branch_id: str | None = None,
    operator_name: str | None = None,
) -> bool:
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
            return False
        from app import database_shell
        from app.models import Sale, db

        with database_shell.app_context():
            sale = db.session.get(Sale, sale_id)
            if sale is None:
                return
            if getattr(sale, "kds_ticket_printed_at", None) is None:
                sale.kds_ticket_printed_at = datetime.now(timezone.utc)
                db.session.commit()
        return True
    except Exception:
        logger.exception("Deferred KOT print/stamp failed")
        return False


def run_print_receipt_job(receipt_data: dict[str, Any]) -> int | None:
    # Highest priority: customer receipt should never sit behind KOT backlog.
    return _queue_print_job(0, "receipt", _do_print_receipt, receipt_data)


def run_print_kot_modification_job(mod_payload: dict[str, Any]) -> int | None:
    return _queue_print_job(1, "kot-modification", _do_print_kot_modification, mod_payload)


def run_print_kot_and_stamp_job(
    sale_id: int,
    kot_payload: dict[str, Any] | None,
    branch_id: str | None = None,
    operator_name: str | None = None,
) -> int | None:
    """Queue KOT print + stamp after response.

    Pass ``kot_payload=None`` to build payload in the print worker (keeps API fast).
    """
    return _queue_print_job(
        1,
        "kot-and-stamp",
        _do_print_kot_and_stamp,
        sale_id,
        kot_payload,
        branch_id,
        operator_name,
    )
