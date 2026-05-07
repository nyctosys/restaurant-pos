"""
Insert comprehensive restaurant POS demo data for local testing.

Creates suppliers, ingredients, prepared items (sauces/marinades),
menu items, recipes (ingredient + prepared item BOM), and deals.

Idempotent: records use fixed SKUs prefixed with SEED-DEMO-.
Re-running the script skips existing rows and only creates missing data.

Requires at least one active branch (complete /setup first).

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
from app.models import (
    Branch,
    ComboItem,
    Ingredient,
    IngredientBranchStock,
    PreparedItem,
    PreparedItemComponent,
    Product,
    RecipeItem,
    RecipePreparedItem,
    Supplier,
    UnitOfMeasure,
    db,
)
from app.services.branch_ingredient_stock import seed_branch_stocks_for_new_ingredient
from app.services.prepared_item_stock import (
    seed_prepared_branch_stocks_for_new_item,
    sync_prepared_master_total,
)
from app.services.prepared_item_costing import compute_prepared_item_average_cost


SEED_SKU_PREFIX = "SEED-DEMO-"

SUPPLIERS_SEED: list[tuple[str, str | None, str | None]] = [
    ("Lahore Fresh Produce", "Ahmed Khan", "+92-300-1112233"),
    ("National Spices & Dry Goods", "Sara Malik", "+92-321-4445566"),
    ("Punjab Dairy Depot", "Hassan Raza", "+92-333-1112299"),
    ("Karachi Proteins Market", "Nida Farooq", "+92-331-9487765"),
    ("Metro Packaging House", "Usman Ali", "+92-302-8811221"),
]

# name, sku_suffix, unit, category, stock_per_branch, minimum_stock, average_cost, preferred_supplier_index (0-based) or None
INGREDIENTS_SEED: list[tuple[str, str, UnitOfMeasure, str, float, float, float, int | None]] = [
    ("Chicken Boneless", "ING-CHK-01", UnitOfMeasure.KG, "Protein", 26.0, 6.0, 950.0, 3),
    ("Chicken Wings", "ING-CHK-02", UnitOfMeasure.KG, "Protein", 18.0, 5.0, 620.0, 3),
    ("Ground Beef", "ING-BEF-01", UnitOfMeasure.KG, "Protein", 16.0, 4.0, 1400.0, 3),
    ("Mozzarella Cheese", "ING-DAI-01", UnitOfMeasure.KG, "Dairy", 14.0, 4.0, 1650.0, 2),
    ("Mayonnaise", "ING-SAU-01", UnitOfMeasure.KG, "Sauce Base", 9.0, 2.0, 520.0, 1),
    ("Tomato Paste", "ING-SAU-02", UnitOfMeasure.KG, "Sauce Base", 11.0, 3.0, 360.0, 1),
    ("Soy Sauce", "ING-SAU-03", UnitOfMeasure.L, "Sauce Base", 8.0, 2.0, 280.0, 1),
    ("Vinegar", "ING-SAU-04", UnitOfMeasure.L, "Sauce Base", 8.0, 2.0, 180.0, 1),
    ("Garlic Paste", "ING-SPC-01", UnitOfMeasure.KG, "Spices", 6.0, 1.5, 420.0, 1),
    ("Red Chilli Flakes", "ING-SPC-02", UnitOfMeasure.KG, "Spices", 3.5, 0.8, 900.0, 1),
    ("Garam Masala", "ING-SPC-03", UnitOfMeasure.KG, "Spices", 3.5, 0.8, 1200.0, 1),
    ("Black Pepper", "ING-SPC-04", UnitOfMeasure.KG, "Spices", 2.5, 0.6, 1600.0, 1),
    ("Fresh Lettuce", "ING-PRD-01", UnitOfMeasure.KG, "Produce", 10.0, 3.0, 220.0, 0),
    ("Onion", "ING-PRD-02", UnitOfMeasure.KG, "Produce", 22.0, 5.0, 140.0, 0),
    ("French Fries (Frozen)", "ING-SID-01", UnitOfMeasure.KG, "Sides", 35.0, 8.0, 380.0, 0),
]

PREPARED_ITEMS_SEED: list[dict[str, object]] = [
    {"name": "Garlic Mayo Sauce", "sku": "PRP-SAU-01", "kind": "sauce", "unit": UnitOfMeasure.KG, "stock": 12.0, "minimum": 3.0},
    {"name": "Chipotle Mayo", "sku": "PRP-SAU-02", "kind": "sauce", "unit": UnitOfMeasure.KG, "stock": 11.0, "minimum": 2.0},
    {"name": "Spicy Ranch", "sku": "PRP-SAU-03", "kind": "sauce", "unit": UnitOfMeasure.KG, "stock": 10.0, "minimum": 2.0},
    {"name": "Honey Mustard", "sku": "PRP-SAU-04", "kind": "sauce", "unit": UnitOfMeasure.KG, "stock": 9.0, "minimum": 2.0},
    {"name": "Buffalo Glaze", "sku": "PRP-SAU-05", "kind": "sauce", "unit": UnitOfMeasure.KG, "stock": 8.0, "minimum": 2.0},
    {"name": "Teriyaki Glaze", "sku": "PRP-SAU-06", "kind": "sauce", "unit": UnitOfMeasure.KG, "stock": 8.0, "minimum": 2.0},
    {"name": "Tandoori Chicken Marinade", "sku": "PRP-MAR-01", "kind": "marination", "unit": UnitOfMeasure.KG, "stock": 14.0, "minimum": 4.0},
    {"name": "Peri Peri Marinade", "sku": "PRP-MAR-02", "kind": "marination", "unit": UnitOfMeasure.KG, "stock": 13.0, "minimum": 3.0},
    {"name": "BBQ Chicken Marinade", "sku": "PRP-MAR-03", "kind": "marination", "unit": UnitOfMeasure.KG, "stock": 13.0, "minimum": 3.0},
    {"name": "Lemon Herb Marinade", "sku": "PRP-MAR-04", "kind": "marination", "unit": UnitOfMeasure.KG, "stock": 10.0, "minimum": 3.0},
]

PRODUCTS_SEED: list[dict[str, object]] = [
    {"sku": "PROD-01", "title": "Zinger Burger", "section": "Mains", "base_price": 650.0, "variants": []},
    {"sku": "PROD-02", "title": "Beef Smash Burger", "section": "Mains", "base_price": 790.0, "variants": []},
    {"sku": "PROD-03", "title": "Peri Peri Wrap", "section": "Mains", "base_price": 620.0, "variants": []},
    {"sku": "PROD-04", "title": "Chicken Shawarma Plate", "section": "Mains", "base_price": 860.0, "variants": []},
    {"sku": "PROD-05", "title": "Crispy Wings 6pc", "section": "Starters", "base_price": 560.0, "variants": []},
    {"sku": "PROD-06", "title": "Tandoori Wings 8pc", "section": "Starters", "base_price": 690.0, "variants": []},
    {"sku": "PROD-07", "title": "Loaded Fries", "section": "Sides", "base_price": 520.0, "variants": []},
    {"sku": "PROD-08", "title": "Cheese Fries", "section": "Sides", "base_price": 450.0, "variants": []},
    {"sku": "PROD-09", "title": "Club Sandwich", "section": "Mains", "base_price": 610.0, "variants": []},
    {"sku": "PROD-10", "title": "Chicken Burger Meal", "section": "Mains", "base_price": 980.0, "variants": []},
    {"sku": "PROD-11", "title": "Mint Lemonade", "section": "Beverages", "base_price": 220.0, "variants": []},
    {"sku": "PROD-12", "title": "Chocolate Shake", "section": "Beverages", "base_price": 390.0, "variants": []},
]

DEALS_SEED: list[dict[str, object]] = [
    {"sku": "DEAL-01", "title": "Zinger Duo Deal", "sale_price": 1199.0, "items": [("PROD-01", 2), ("PROD-11", 2)]},
    {"sku": "DEAL-02", "title": "Wings Family Deal", "sale_price": 1649.0, "items": [("PROD-05", 1), ("PROD-06", 1), ("PROD-07", 1)]},
    {"sku": "DEAL-03", "title": "Burger + Fries Combo", "sale_price": 899.0, "items": [("PROD-01", 1), ("PROD-08", 1)]},
    {"sku": "DEAL-04", "title": "Beef Lovers Combo", "sale_price": 1350.0, "items": [("PROD-02", 1), ("PROD-07", 1), ("PROD-12", 1)]},
    {"sku": "DEAL-05", "title": "Wrap Meal", "sale_price": 840.0, "items": [("PROD-03", 1), ("PROD-11", 1)]},
]


def _seed_prepared_item_components(
    ingredient_by_name: dict[str, Ingredient],
    prepared_by_name: dict[str, PreparedItem],
) -> None:
    recipes: list[tuple[str, list[tuple[str, float]]]] = [
        ("Garlic Mayo Sauce", [("Mayonnaise", 0.70), ("Garlic Paste", 0.20), ("Black Pepper", 0.02)]),
        ("Chipotle Mayo", [("Mayonnaise", 0.65), ("Tomato Paste", 0.20), ("Red Chilli Flakes", 0.05)]),
        ("Spicy Ranch", [("Mayonnaise", 0.60), ("Vinegar", 0.10), ("Black Pepper", 0.02), ("Garlic Paste", 0.08)]),
        ("Honey Mustard", [("Mayonnaise", 0.45), ("Vinegar", 0.10), ("Garam Masala", 0.01)]),
        ("Buffalo Glaze", [("Tomato Paste", 0.50), ("Vinegar", 0.20), ("Red Chilli Flakes", 0.08)]),
        ("Teriyaki Glaze", [("Soy Sauce", 0.55), ("Vinegar", 0.10), ("Garlic Paste", 0.05)]),
        ("Tandoori Chicken Marinade", [("Garlic Paste", 0.25), ("Garam Masala", 0.04), ("Vinegar", 0.10)]),
        ("Peri Peri Marinade", [("Garlic Paste", 0.20), ("Red Chilli Flakes", 0.10), ("Vinegar", 0.12)]),
        ("BBQ Chicken Marinade", [("Tomato Paste", 0.45), ("Garlic Paste", 0.12), ("Black Pepper", 0.03)]),
        ("Lemon Herb Marinade", [("Garlic Paste", 0.20), ("Black Pepper", 0.03), ("Vinegar", 0.10)]),
    ]
    for prepared_name, components in recipes:
        prepared = prepared_by_name.get(prepared_name)
        if prepared is None or prepared.components:
            continue
        for ingredient_name, quantity in components:
            ingredient = ingredient_by_name.get(ingredient_name)
            if ingredient is None:
                continue
            db.session.add(
                PreparedItemComponent(
                    prepared_item_id=prepared.id,
                    ingredient_id=ingredient.id,
                    quantity=quantity,
                    unit=UnitOfMeasure.KG if ingredient.unit != UnitOfMeasure.L else UnitOfMeasure.L,
                )
            )


def _seed_menu_recipes(
    ingredient_by_name: dict[str, Ingredient],
    prepared_by_name: dict[str, PreparedItem],
    product_by_title: dict[str, Product],
) -> None:
    ingredient_lines: list[tuple[str, list[tuple[str, float, UnitOfMeasure]]]] = [
        ("Zinger Burger", [("Chicken Boneless", 0.20, UnitOfMeasure.KG), ("Fresh Lettuce", 0.03, UnitOfMeasure.KG), ("Onion", 0.03, UnitOfMeasure.KG)]),
        ("Beef Smash Burger", [("Ground Beef", 0.18, UnitOfMeasure.KG), ("Mozzarella Cheese", 0.03, UnitOfMeasure.KG), ("Onion", 0.03, UnitOfMeasure.KG)]),
        ("Peri Peri Wrap", [("Chicken Boneless", 0.18, UnitOfMeasure.KG), ("Fresh Lettuce", 0.02, UnitOfMeasure.KG), ("Onion", 0.02, UnitOfMeasure.KG)]),
        ("Chicken Shawarma Plate", [("Chicken Boneless", 0.25, UnitOfMeasure.KG), ("Fresh Lettuce", 0.04, UnitOfMeasure.KG), ("Onion", 0.04, UnitOfMeasure.KG)]),
        ("Crispy Wings 6pc", [("Chicken Wings", 0.28, UnitOfMeasure.KG)]),
        ("Tandoori Wings 8pc", [("Chicken Wings", 0.35, UnitOfMeasure.KG)]),
        ("Loaded Fries", [("French Fries (Frozen)", 0.30, UnitOfMeasure.KG), ("Mozzarella Cheese", 0.04, UnitOfMeasure.KG)]),
        ("Cheese Fries", [("French Fries (Frozen)", 0.24, UnitOfMeasure.KG), ("Mozzarella Cheese", 0.03, UnitOfMeasure.KG)]),
    ]
    prepared_lines: list[tuple[str, list[tuple[str, float, UnitOfMeasure]]]] = [
        ("Zinger Burger", [("Garlic Mayo Sauce", 0.03, UnitOfMeasure.KG), ("Peri Peri Marinade", 0.03, UnitOfMeasure.KG)]),
        ("Beef Smash Burger", [("Chipotle Mayo", 0.03, UnitOfMeasure.KG)]),
        ("Peri Peri Wrap", [("Peri Peri Marinade", 0.04, UnitOfMeasure.KG), ("Spicy Ranch", 0.02, UnitOfMeasure.KG)]),
        ("Chicken Shawarma Plate", [("Lemon Herb Marinade", 0.05, UnitOfMeasure.KG), ("Garlic Mayo Sauce", 0.03, UnitOfMeasure.KG)]),
        ("Crispy Wings 6pc", [("Buffalo Glaze", 0.05, UnitOfMeasure.KG)]),
        ("Tandoori Wings 8pc", [("Tandoori Chicken Marinade", 0.06, UnitOfMeasure.KG)]),
        ("Loaded Fries", [("Chipotle Mayo", 0.03, UnitOfMeasure.KG)]),
        ("Cheese Fries", [("Honey Mustard", 0.02, UnitOfMeasure.KG)]),
    ]

    for product_title, lines in ingredient_lines:
        product = product_by_title.get(product_title)
        if product is None:
            continue
        has_base = RecipeItem.query.filter_by(product_id=product.id, variant_key="").first() is not None
        if has_base:
            continue
        for ingredient_name, quantity, unit in lines:
            ingredient = ingredient_by_name.get(ingredient_name)
            if ingredient is None:
                continue
            db.session.add(
                RecipeItem(
                    product_id=product.id,
                    ingredient_id=ingredient.id,
                    quantity=quantity,
                    unit=unit,
                    variant_key="",
                    notes="seed_inventory_demo.py",
                )
            )

    for product_title, lines in prepared_lines:
        product = product_by_title.get(product_title)
        if product is None:
            continue
        has_base = RecipePreparedItem.query.filter_by(product_id=product.id, variant_key="").first() is not None
        if has_base:
            continue
        for prepared_name, quantity, unit in lines:
            prepared = prepared_by_name.get(prepared_name)
            if prepared is None:
                continue
            db.session.add(
                RecipePreparedItem(
                    product_id=product.id,
                    prepared_item_id=prepared.id,
                    quantity=quantity,
                    unit=unit,
                    variant_key="",
                    notes="seed_inventory_demo.py",
                )
            )


def _seed_deals(product_by_sku_suffix: dict[str, Product]) -> tuple[int, int]:
    created = 0
    skipped = 0
    for row in DEALS_SEED:
        deal_sku = f"{SEED_SKU_PREFIX}{row['sku']}"
        existing = Product.query.filter_by(sku=deal_sku).first()
        if existing:
            skipped += 1
            continue
        deal = Product(
            sku=deal_sku,
            title=str(row["title"]),
            base_price=0.0,
            sale_price=float(row["sale_price"]),
            section="Deals",
            variants=[],
            is_deal=True,
        )
        db.session.add(deal)
        db.session.flush()
        for sku_suffix, qty in row["items"]:
            child = product_by_sku_suffix.get(str(sku_suffix))
            if child is None:
                continue
            db.session.add(
                ComboItem(
                    combo_id=deal.id,
                    product_id=child.id,
                    quantity=int(qty),
                    selection_type="product",
                    category_name=None,
                    variant_key="",
                )
            )
        created += 1
    return created, skipped


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
        repaired_ing_cost = 0
        ingredient_by_name: dict[str, Ingredient] = {}
        for name, suf, unit, category, stock, min_stock, avg_cost, sup_idx in INGREDIENTS_SEED:
            sku = f"{SEED_SKU_PREFIX}{suf}"
            existing_ing = Ingredient.query.filter_by(sku=sku).first()
            if existing_ing:
                skipped_ing += 1
                if float(existing_ing.average_cost or 0.0) <= 0:
                    existing_ing.average_cost = avg_cost
                    existing_ing.last_purchase_price = avg_cost
                    repaired_ing_cost += 1
                print(f"Ingredient exists (skip): {sku}")
                ingredient_by_name[name] = existing_ing
                continue
            pref_id = supplier_rows[sup_idx].id if sup_idx is not None and sup_idx < len(supplier_rows) else None
            ing = Ingredient(
                name=name,
                sku=sku,
                unit=unit,
                current_stock=0.0,
                minimum_stock=min_stock,
                reorder_quantity=max(min_stock * 2, 1.0),
                last_purchase_price=avg_cost,
                average_cost=avg_cost,
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
            ingredient_by_name[name] = ing
            print(f"Ingredient created: {name} ({sku}) @ {stock} per branch")

        if not ingredient_by_name:
            for name, suf, *_ in INGREDIENTS_SEED:
                ing = Ingredient.query.filter_by(sku=f"{SEED_SKU_PREFIX}{suf}").first()
                if ing is not None:
                    ingredient_by_name[name] = ing

        created_prepared = 0
        skipped_prepared = 0
        prepared_by_name: dict[str, PreparedItem] = {}
        for row in PREPARED_ITEMS_SEED:
            sku = f"{SEED_SKU_PREFIX}{row['sku']}"
            existing_prepared = PreparedItem.query.filter_by(sku=sku).first()
            if existing_prepared:
                skipped_prepared += 1
                prepared_by_name[str(row["name"])] = existing_prepared
                continue
            prepared = PreparedItem(
                name=str(row["name"]),
                sku=sku,
                kind=str(row["kind"]),
                unit=row["unit"],
                current_stock=0.0,
                minimum_stock=float(row["minimum"]),
                average_cost=0.0,
                notes="seed_inventory_demo.py",
                is_active=True,
            )
            db.session.add(prepared)
            db.session.flush()
            seed_prepared_branch_stocks_for_new_item(prepared.id, float(row["stock"]))
            sync_prepared_master_total(prepared.id)
            prepared_by_name[str(row["name"])] = prepared
            created_prepared += 1

        if not prepared_by_name:
            for row in PREPARED_ITEMS_SEED:
                prepared = PreparedItem.query.filter_by(sku=f"{SEED_SKU_PREFIX}{row['sku']}").first()
                if prepared is not None:
                    prepared_by_name[str(row["name"])] = prepared

        _seed_prepared_item_components(ingredient_by_name, prepared_by_name)
        db.session.flush()

        repaired_prepared_cost = 0
        for prepared in prepared_by_name.values():
            computed = compute_prepared_item_average_cost(prepared)
            if computed is not None and (
                float(prepared.average_cost or 0.0) <= 0
                or str(prepared.notes or "") == "seed_inventory_demo.py"
            ):
                prepared.average_cost = computed
                repaired_prepared_cost += 1

        created_products = 0
        skipped_products = 0
        product_by_title: dict[str, Product] = {}
        product_by_sku_suffix: dict[str, Product] = {}
        for row in PRODUCTS_SEED:
            sku = f"{SEED_SKU_PREFIX}{row['sku']}"
            existing_product = Product.query.filter_by(sku=sku).first()
            if existing_product:
                skipped_products += 1
                product_by_title[str(row["title"])] = existing_product
                product_by_sku_suffix[str(row["sku"])] = existing_product
                continue
            product = Product(
                sku=sku,
                title=str(row["title"]),
                base_price=float(row["base_price"]),
                sale_price=float(row["base_price"]),
                section=str(row["section"]),
                variants=list(row["variants"]),
                is_deal=False,
            )
            db.session.add(product)
            db.session.flush()
            created_products += 1
            product_by_title[str(row["title"])] = product
            product_by_sku_suffix[str(row["sku"])] = product

        if not product_by_title:
            for row in PRODUCTS_SEED:
                product = Product.query.filter_by(sku=f"{SEED_SKU_PREFIX}{row['sku']}").first()
                if product is not None:
                    product_by_title[str(row["title"])] = product
                    product_by_sku_suffix[str(row["sku"])] = product

        _seed_menu_recipes(ingredient_by_name, prepared_by_name, product_by_title)
        created_deals, skipped_deals = _seed_deals(product_by_sku_suffix)

        db.session.commit()
        print(
            "Done.\n"
            f"Branches: {len(branches)}\n"
            f"Suppliers ensured: {len(supplier_rows)}\n"
            f"Ingredients created/skipped: {created_ing}/{skipped_ing}\n"
            f"Ingredient costs repaired: {repaired_ing_cost}\n"
            f"Prepared items created/skipped: {created_prepared}/{skipped_prepared}\n"
            f"Prepared item costs recalculated: {repaired_prepared_cost}\n"
            f"Menu items created/skipped: {created_products}/{skipped_products}\n"
            f"Deals created/skipped: {created_deals}/{skipped_deals}\n"
            "Includes seeded sauces, marinades, ingredients, recipes, products, and deals."
        )


if __name__ == "__main__":
    main()
