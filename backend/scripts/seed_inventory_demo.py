"""
Insert demo restaurant inventory data for local testing (suppliers + ingredients + branch stock).

Idempotent: rows are keyed by fixed SKUs prefixed with SEED-. Re-running skips existing SKUs.

Requires at least one active branch (complete /setup and register a user first).

Usage (from backend/):
  python scripts/seed_inventory_demo.py

Or from repo root:
  cd backend && python scripts/seed_inventory_demo.py
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from dotenv import load_dotenv

load_dotenv()

from sqlalchemy import func

from app import create_app
from app.models import Branch, Ingredient, IngredientBranchStock, Supplier, UnitOfMeasure, db
from app.services.branch_ingredient_stock import seed_branch_stocks_for_new_ingredient


SEED_SKU_PREFIX = "SEED-DEMO-"

SUPPLIERS_SEED: list[tuple[str, str | None, str | None]] = [
    ("Lahore Fresh Produce", "Ahmed Khan", "+92-300-1112233"),
    ("National Spices & Dry Goods", "Sara Malik", "+92-321-4445566"),
]

# name, sku_suffix, unit, category, stock_per_branch, minimum_stock, preferred_supplier_index (0-based) or None
INGREDIENTS_SEED: list[tuple[str, str, UnitOfMeasure, str, float, float, int | None]] = [
    ("Basmati Rice", "RICE-01", UnitOfMeasure.KG, "Grains", 25.0, 5.0, 1),
    ("All-Purpose Flour", "FLOUR-01", UnitOfMeasure.KG, "Bakery", 40.0, 8.0, 1),
    ("Cooking Oil (canola)", "OIL-01", UnitOfMeasure.L, "Oils", 18.0, 4.0, 0),
    ("Chicken Boneless", "CHK-01", UnitOfMeasure.KG, "Protein", 15.0, 3.0, 0),
    ("Mutton Cubes", "MTN-01", UnitOfMeasure.KG, "Protein", 12.0, 2.0, 0),
    ("Mixed Vegetables (frozen)", "VEG-01", UnitOfMeasure.KG, "Produce", 20.0, 5.0, 0),
    ("Garam Masala (blend)", "SP-01", UnitOfMeasure.KG, "Spices", 3.0, 0.5, 1),
    ("Cheddar Cheese (block)", "CHZ-01", UnitOfMeasure.KG, "Dairy", 6.0, 1.0, 0),
    ("Naan Dough (prepared)", "NAAN-01", UnitOfMeasure.KG, "Prep", 10.0, 2.0, 1),
    ("Disposable Containers (500ml)", "PKG-01", UnitOfMeasure.PACK, "Packaging", 200.0, 40.0, None),
]


def _sync_ingredient_master_total(ingredient_id: int) -> None:
    total = (
        db.session.query(func.coalesce(func.sum(IngredientBranchStock.current_stock), 0.0))
        .filter(IngredientBranchStock.ingredient_id == ingredient_id)
        .scalar()
    )
    ing = db.session.get(Ingredient, ingredient_id)
    if ing is not None:
        ing.current_stock = float(total or 0.0)


def main() -> None:
    app = create_app()
    with app.app_context():
        branches = Branch.query.filter(Branch.archived_at.is_(None)).all()
        if not branches:
            print("No active branches found. Complete /setup first, then re-run this script.")
            return

        supplier_rows: list[Supplier] = []
        for name, contact, phone in SUPPLIERS_SEED:
            existing = Supplier.query.filter_by(name=name).first()
            if existing:
                supplier_rows.append(existing)
                print(f"Supplier exists (skip): {name}")
            else:
                s = Supplier(name=name, contact_person=contact or "", phone=phone or "", is_active=True)
                db.session.add(s)
                db.session.flush()
                supplier_rows.append(s)
                print(f"Supplier created: {name}")

        created_ing = 0
        skipped_ing = 0
        for name, suf, unit, category, stock, min_stock, sup_idx in INGREDIENTS_SEED:
            sku = f"{SEED_SKU_PREFIX}{suf}"
            if Ingredient.query.filter_by(sku=sku).first():
                skipped_ing += 1
                print(f"Ingredient exists (skip): {sku}")
                continue
            pref_id = supplier_rows[sup_idx].id if sup_idx is not None and sup_idx < len(supplier_rows) else None
            ing = Ingredient(
                name=name,
                sku=sku,
                unit=unit,
                current_stock=0.0,
                minimum_stock=min_stock,
                reorder_quantity=max(min_stock * 2, 1.0),
                last_purchase_price=0.0,
                average_cost=0.0,
                preferred_supplier_id=pref_id,
                category=category,
                notes="seed_inventory_demo.py",
                is_active=True,
            )
            db.session.add(ing)
            db.session.flush()
            seed_branch_stocks_for_new_ingredient(ing.id, stock)
            _sync_ingredient_master_total(ing.id)
            created_ing += 1
            print(f"Ingredient created: {name} ({sku}) @ {stock} per branch")

        db.session.commit()
        print(
            f"Done. Branches: {len(branches)}. "
            f"Suppliers ensured: {len(supplier_rows)}. "
            f"Ingredients created: {created_ing}, skipped: {skipped_ing}."
        )


if __name__ == "__main__":
    main()
