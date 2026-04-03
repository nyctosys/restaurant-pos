"""
SQLAlchemy database layer for FastAPI (no Flask).

Session scope is bound per request via a ContextVar key, and sessions are created
lazily per thread within that request scope. This avoids cross-thread reuse when
FastAPI executes sync routes in a worker thread.

Provides Flask-SQLAlchemy–compatible `db.Model`, `db.Column`, and `Model.query`.
"""
from __future__ import annotations

import threading
import uuid
from contextvars import ContextVar, Token
from typing import Any

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Integer,
    JSON,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    create_engine,
)
from sqlalchemy.orm import DeclarativeBase, Session, backref, relationship, sessionmaker
from sqlalchemy.pool import StaticPool


class Base(DeclarativeBase):
    """Declarative base for all ORM models."""


_request_scope_id: ContextVar[str | None] = ContextVar("request_scope_id", default=None)
_scope_lock = threading.Lock()
_sessions_by_scope: dict[str, dict[int, Session]] = {}


def _current_thread_id() -> int:
    return threading.get_ident()


def _get_or_create_session_for_scope(*, create: bool) -> Session | None:
    scope_id = _request_scope_id.get()
    if not scope_id:
        return None
    tid = _current_thread_id()
    with _scope_lock:
        per_thread = _sessions_by_scope.get(scope_id)
        if per_thread is None:
            if not create:
                return None
            per_thread = {}
            _sessions_by_scope[scope_id] = per_thread
        sess = per_thread.get(tid)
        if sess is None and create:
            if db.session_factory is None:
                raise RuntimeError("Database not initialized.")
            sess = db.session_factory()
            per_thread[tid] = sess
        return sess


class _SessionProxy:
    """Delegates to the current request-thread Session (set lazily per scope+thread)."""

    def __getattr__(self, name: str) -> Any:
        s = _get_or_create_session_for_scope(create=True)
        if s is None:
            raise RuntimeError(
                "No database session bound to this context. "
                "Use within FastAPI request middleware or app.app_context() in tests."
            )
        return getattr(s, name)


class SQLAlchemy:
    """Application-scoped DB registry (replaces Flask-SQLAlchemy)."""

    Model = Base

    def __init__(self) -> None:
        self.engine = None
        self.session_factory: sessionmaker[Session] | None = None

    def init_engine(self, database_uri: str) -> None:
        if self.engine is not None:
            return
        kwargs: dict[str, object] = {"pool_pre_ping": True}
        # SQLite in tests: sync routes run in FastAPI's thread pool; allow cross-thread use.
        if database_uri.startswith("sqlite"):
            kwargs["connect_args"] = {"check_same_thread": False}
            if ":memory:" in database_uri:
                kwargs["poolclass"] = StaticPool
        self.engine = create_engine(database_uri, **kwargs)
        self.session_factory = sessionmaker(bind=self.engine, autoflush=True, autocommit=False)

    def create_all(self) -> None:
        if self.engine is None:
            raise RuntimeError("Database not initialized.")
        Base.metadata.create_all(self.engine)

    def drop_all(self) -> None:
        if self.engine is None:
            raise RuntimeError("Database not initialized.")
        Base.metadata.drop_all(self.engine)


db = SQLAlchemy()
db.session = _SessionProxy()  # type: ignore[assignment]

# Flask-SQLAlchemy–style aliases used across models
db.Column = Column
db.Integer = Integer
db.String = String
db.Text = Text
db.Boolean = Boolean
db.DateTime = DateTime
db.Float = Float
db.Numeric = Numeric
db.JSON = JSON
db.ForeignKey = ForeignKey
db.Enum = Enum
db.UniqueConstraint = UniqueConstraint
db.relationship = relationship
db.backref = backref


class _QueryProperty:
    def __get__(self, obj, cls):  # type: ignore[no-untyped-def]
        if cls is None:
            cls = type(obj)
        return db.session.query(cls)


Base.query = _QueryProperty()  # type: ignore[misc, assignment]


def bind_request_session() -> Token:
    """Bind a request scope token; sessions are lazily created per thread in this scope."""
    if db.session_factory is None:
        raise RuntimeError("Database not initialized.")
    return _request_scope_id.set(uuid.uuid4().hex)


def unbind_request_session(token: Token) -> None:
    """Close all thread-bound sessions in this scope and reset context."""
    scope_id = _request_scope_id.get()
    _request_scope_id.reset(token)
    if not scope_id:
        return
    with _scope_lock:
        scope_sessions = _sessions_by_scope.pop(scope_id, {})
    for sess in scope_sessions.values():
        try:
            sess.close()
        except Exception:
            # Best-effort cleanup; request teardown must not crash the response path.
            pass


def get_request_session_optional() -> Session | None:
    """Current request-thread session, or None if not created / outside request scope."""
    return _get_or_create_session_for_scope(create=False)
