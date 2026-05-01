from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func

from app.models import Ingredient, IngredientBranchStock, Setting, StockMovement, db
from app.services.branch_ingredient_stock import (
    InsufficientIngredientStock,
    adjust_branch_ingredient_stock,
    ensure_branch_stock_row,
    get_branch_stock,
)
from app.services.ingredient_master_stock import sync_ingredient_master_total

BRAND_DEDUCTION_HIGHEST_AVAILABLE = "highest_available"
BRAND_DEDUCTION_FIFO = "fifo"


def ingredient_display_name(ingredient: Ingredient | None) -> str:
    if ingredient is None:
        return "Unknown ingredient"
    name = (ingredient.name or "").strip() or f"ingredient #{ingredient.id}"
    brand = (getattr(ingredient, "brand_name", None) or "").strip()
    return f"{name} ({brand})" if brand else name


def _brand_strategy(branch_id: str) -> str:
    setting = Setting.query.filter_by(branch_id=branch_id).first() or Setting.query.filter_by(branch_id=None).first()
    config = setting.config if setting and isinstance(setting.config, dict) else {}
    raw = (
        config.get("inventory_brand_deduction_strategy")
        or config.get("inventoryBrandDeductionStrategy")
        or BRAND_DEDUCTION_HIGHEST_AVAILABLE
    )
    value = str(raw or "").strip().lower()
    if value == BRAND_DEDUCTION_FIFO:
        return BRAND_DEDUCTION_FIFO
    return BRAND_DEDUCTION_HIGHEST_AVAILABLE


def _matching_ingredients(base_ingredient: Ingredient) -> list[Ingredient]:
    if (getattr(base_ingredient, "brand_name", None) or "").strip():
        return [base_ingredient]

    normalized_name = (base_ingredient.name or "").strip().lower()
    normalized_unit = (base_ingredient.unit or "").strip().lower()
    if not normalized_name:
        return [base_ingredient]

    rows = (
        Ingredient.query.filter(func.lower(Ingredient.name) == normalized_name)
        .filter(func.lower(Ingredient.unit) == normalized_unit)
        .filter(Ingredient.is_active == True)  # noqa: E712
        .all()
    )
    if not rows:
        return [base_ingredient]

    seen: set[int] = set()
    ordered: list[Ingredient] = []
    for row in rows:
        if row.id in seen:
            continue
        seen.add(row.id)
        ordered.append(row)
    if base_ingredient.id not in seen:
        ordered.insert(0, base_ingredient)
    return ordered


def _candidate_oldest_inbound(branch_id: str, ingredient_ids: list[int]) -> dict[int, datetime]:
    if not ingredient_ids:
        return {}
    rows = (
        db.session.query(StockMovement.ingredient_id, func.min(StockMovement.created_at))
        .filter(StockMovement.branch_id == branch_id)
        .filter(StockMovement.ingredient_id.in_(ingredient_ids))
        .filter(StockMovement.quantity_change > 0)
        .group_by(StockMovement.ingredient_id)
        .all()
    )
    return {
        int(ingredient_id): created_at if created_at is not None else datetime.now(timezone.utc)
        for ingredient_id, created_at in rows
    }


def _sorted_candidates(branch_id: str, candidates: list[Ingredient]) -> list[tuple[Ingredient, float]]:
    if not candidates:
        return []

    stocks: dict[int, float] = {}
    for ingredient in candidates:
        ensure_branch_stock_row(ingredient.id, branch_id)
        row = (
            IngredientBranchStock.query.filter_by(ingredient_id=ingredient.id, branch_id=branch_id)
            .with_for_update()
            .first()
        )
        stocks[ingredient.id] = float(row.current_stock) if row is not None else get_branch_stock(ingredient.id, branch_id)

    strategy = _brand_strategy(branch_id)
    oldest_inbound = _candidate_oldest_inbound(branch_id, [ingredient.id for ingredient in candidates])

    def sort_key(entry: Ingredient) -> tuple[Any, ...]:
        stock = stocks.get(entry.id, 0.0)
        brand = (getattr(entry, "brand_name", None) or "").strip().lower()
        created_at = oldest_inbound.get(entry.id) or getattr(entry, "created_at", None) or datetime.now(timezone.utc)
        if strategy == BRAND_DEDUCTION_FIFO:
            return (created_at, -stock, brand, entry.id)
        return (-stock, brand == "", brand, entry.id)

    ordered = sorted(candidates, key=sort_key)
    return [(ingredient, stocks.get(ingredient.id, 0.0)) for ingredient in ordered]


def deduct_ingredient_stock(
    *,
    source_ingredient: Ingredient,
    required_quantity: float,
    branch_id: str,
    user_id: int,
    sale_id: int,
    reason: str,
    reference_type: str = "sale",
) -> list[dict[str, Any]]:
    candidates = _matching_ingredients(source_ingredient)
    ranked_candidates = _sorted_candidates(branch_id, candidates)
    total_available = sum(stock for _, stock in ranked_candidates)
    if total_available + 1e-9 < required_quantity:
        raise InsufficientIngredientStock(
            ingredient_display_name(source_ingredient),
            required_quantity,
            total_available,
        )

    remaining = float(required_quantity)
    allocations: list[dict[str, Any]] = []
    touched_ids: set[int] = set()

    for ingredient, available in ranked_candidates:
        if remaining <= 1e-9:
            break
        if available <= 1e-9:
            continue
        take_quantity = min(available, remaining)
        adjust_branch_ingredient_stock(
            ingredient.id,
            branch_id,
            -take_quantity,
            movement_type="sale_deduction",
            user_id=user_id,
            reference_id=sale_id,
            reference_type=reference_type,
            reason=reason,
            unit_cost=float(ingredient.average_cost or 0.0),
            allow_negative=False,
        )
        touched_ids.add(int(ingredient.id))
        allocations.append(
            {
                "ingredient_id": int(ingredient.id),
                "ingredient_name": ingredient.name,
                "brand_name": getattr(ingredient, "brand_name", None),
                "quantity": float(take_quantity),
                "unitOfMeasure": ingredient.unit,
            }
        )
        remaining -= take_quantity

    for ingredient_id in touched_ids:
        sync_ingredient_master_total(ingredient_id)

    if remaining > 1e-6:
        raise InsufficientIngredientStock(
            ingredient_display_name(source_ingredient),
            required_quantity,
            total_available - remaining,
        )

    return allocations


def restore_inventory_allocations(
    *,
    allocations: list[dict[str, Any]] | None,
    branch_id: str,
    user_id: int,
    sale_id: int,
    reason: str,
    reference_type: str = "sale",
) -> None:
    if not allocations:
        return

    touched_ids: set[int] = set()
    for allocation in allocations:
        ingredient_id = int(allocation.get("ingredient_id") or 0)
        quantity = float(allocation.get("quantity") or 0.0)
        if ingredient_id <= 0 or quantity <= 0:
            continue
        ingredient = db.session.get(Ingredient, ingredient_id)
        adjust_branch_ingredient_stock(
            ingredient_id,
            branch_id,
            quantity,
            movement_type="adjustment",
            user_id=user_id,
            reference_id=sale_id,
            reference_type=reference_type,
            reason=reason,
            unit_cost=float(ingredient.average_cost or 0.0) if ingredient else 0.0,
            allow_negative=False,
        )
        touched_ids.add(ingredient_id)

    for ingredient_id in touched_ids:
        sync_ingredient_master_total(ingredient_id)
