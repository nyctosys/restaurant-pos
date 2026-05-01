"""Single-branch (terminal-scoped) resolution: no client-driven branch switching."""

from __future__ import annotations

from fastapi import HTTPException, status

from app.models import Branch, User


def resolve_terminal_branch_id(user: User) -> str:
    """
    Return the branch ID for this authenticated terminal user.
    Ignores request payload branch switching — callers must not use `branch_id` from clients for scoping.
    """
    if user.branch_id is not None:
        return str(user.branch_id)
    q = Branch.query
    if hasattr(Branch, "archived_at"):
        q = q.filter(Branch.archived_at.is_(None))
    branches = q.order_by(Branch.id.asc()).all()
    if not branches:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"message": "No branch configured. Complete setup or assign a branch to this user."},
        )
    if len(branches) == 1:
        return str(branches[0].id)
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail={
            "message": (
                "Multiple branches are configured. Assign this user to a branch in Settings → Users "
                "so the terminal (including kitchen display) can scope orders correctly."
            )
        },
    )
