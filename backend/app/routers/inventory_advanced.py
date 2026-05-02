from __future__ import annotations
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from app.models import (
    Ingredient,
    PreparedItem,
    PreparedItemComponent,
    Product,
    PurchaseOrder,
    PurchaseOrderItem,
    RecipeItem,
    RecipeExtraCost,
    RecipePreparedItem,
    Supplier,
    User,
    db,
)
from sqlalchemy import distinct
from app.services.branch_ingredient_stock import (
    InsufficientIngredientStock,
    adjust_branch_ingredient_stock,
    get_branch_stock,
    seed_branch_stocks_for_new_ingredient,
)
from app.services.ingredient_master_stock import sync_ingredient_master_total
from app.services.prepared_item_stock import (
    adjust_prepared_branch_stock,
    get_prepared_branch_stock,
    seed_prepared_branch_stocks_for_new_item,
    sync_prepared_master_total,
)
from app.services.unit_conversion import convert_quantity_to_unit, normalize_po_line_to_ingredient_base
from app.services.units import normalize_unit_token, to_base_unit
from app.services.product_pricing import recalculate_product_cost
from app.services.branch_scope import resolve_terminal_branch_id
from app.deps import get_current_user
from app.schemas.inventory_schemas import (
    SupplierCreate, SupplierUpdate, IngredientCreate, IngredientUpdate, IngredientBulkCreate,
    RecipeItemCreate, PurchaseOrderCreate, PurchaseOrderReceive, StockMovementCreate,
    PreparedItemCreate, PreparedItemUpdate, PreparedItemBatchCreate, RecipePreparedItemCreate, RecipeExtraCostCreate,
)

inventory_advanced_router = APIRouter(prefix="/api/inventory-advanced", tags=["inventory-advanced"])


def _resolve_inventory_branch(branch_id: str | None, current_user: User) -> str:
    _ = branch_id
    return resolve_terminal_branch_id(current_user)


def _recalculate_products_using_ingredient(ingredient_id: int) -> None:
    product_ids = (
        db.session.query(distinct(RecipeItem.product_id))
        .filter(RecipeItem.ingredient_id == ingredient_id)
        .all()
    )
    for (product_id,) in product_ids:
        product = db.session.get(Product, int(product_id))
        if product is not None:
            recalculate_product_cost(product)


def _recalculate_products_using_prepared_item(prepared_item_id: int) -> None:
    product_ids = (
        db.session.query(distinct(RecipePreparedItem.product_id))
        .filter(RecipePreparedItem.prepared_item_id == prepared_item_id)
        .all()
    )
    for (product_id,) in product_ids:
        product = db.session.get(Product, int(product_id))
        if product is not None:
            recalculate_product_cost(product)


def _ingredient_to_dict(ingredient: Ingredient, branch_id: str) -> dict[str, Any]:
    unit_raw = ingredient.unit or ""
    unit = unit_raw.value if hasattr(unit_raw, "value") else unit_raw
    brand_name = getattr(ingredient, "brand_name", None)
    return {
        "id": ingredient.id,
        "name": ingredient.name,
        "sku": ingredient.sku,
        "unit": unit,
        "unitOfMeasure": unit,
        "brand_name": brand_name,
        "brandName": brand_name,
        "current_stock": get_branch_stock(ingredient.id, branch_id),
        "minimum_stock": ingredient.minimum_stock,
        "reorder_quantity": ingredient.reorder_quantity,
        "last_purchase_price": ingredient.last_purchase_price,
        "average_cost": ingredient.average_cost,
        "purchase_unit": getattr(ingredient, "purchase_unit", None),
        "conversion_factor": float(getattr(ingredient, "conversion_factor", 1.0) or 1.0),
        "unit_conversions": getattr(ingredient, "unit_conversions", None) or {},
        "baseUnit": unit,
        "pricePerBaseUnit": float(ingredient.average_cost or 0.0),
        "preferred_supplier_id": ingredient.preferred_supplier_id,
        "category": ingredient.category,
        "notes": ingredient.notes,
        "branch_id": branch_id,
    }


def _supplier_to_dict(supplier: Supplier, linked_materials: list[Ingredient]) -> dict[str, Any]:
    linked = [
        {
            "id": ingredient.id,
            "name": ingredient.name,
            "sku": ingredient.sku,
            "brand_name": getattr(ingredient, "brand_name", None),
            "brandName": getattr(ingredient, "brand_name", None),
            "unit": ingredient.unit or "",
            "unitOfMeasure": ingredient.unit or "",
        }
        for ingredient in linked_materials
    ]
    return {
        "id": supplier.id,
        "name": supplier.name,
        "sku": supplier.sku,
        "contact_person": supplier.contact_person,
        "phone": supplier.phone,
        "email": supplier.email,
        "address": supplier.address,
        "notes": supplier.notes,
        "linked_material_ids": [ingredient["id"] for ingredient in linked],
        "linked_materials": linked,
    }


def _po_status_value(po: PurchaseOrder) -> str:
    return po.status.value if hasattr(po.status, "value") else str(po.status)


def _po_item_to_dict(item: PurchaseOrderItem) -> dict[str, Any]:
    ingredient = item.ingredient
    unit = item.unit.value if hasattr(item.unit, "value") else item.unit
    quantity_ordered = float(item.quantity_ordered or 0.0)
    quantity_received = float(item.quantity_received or 0.0)
    quantity_remaining = max(quantity_ordered - quantity_received, 0.0)
    return {
        "id": item.id,
        "ingredient_id": item.ingredient_id,
        "ingredient_name": ingredient.name if ingredient else None,
        "quantity_ordered": quantity_ordered,
        "quantity_received": quantity_received,
        "quantity_remaining": quantity_remaining,
        "unit_price": float(item.unit_price or 0.0),
        "unit": unit,
        "unitOfMeasure": unit,
        "notes": item.notes,
    }


def _normalize_purchase_order_payload(payload: PurchaseOrderCreate) -> tuple[dict[str, Any], list[dict[str, Any]]] | JSONResponse:
    data = payload.model_dump()
    items_data = data.pop("items", [])
    supplier = db.session.get(Supplier, data.get("supplier_id"))
    if not supplier or not supplier.is_active:
        return JSONResponse(status_code=400, content={"message": "Select an active supplier"})

    ingredient_ids = {int(item["ingredient_id"]) for item in items_data}
    ingredients_by_id = {
        ingredient.id: ingredient
        for ingredient in Ingredient.query.filter(Ingredient.id.in_(ingredient_ids)).all()
    } if ingredient_ids else {}
    missing_ids = sorted(ingredient_id for ingredient_id in ingredient_ids if ingredient_id not in ingredients_by_id)
    if missing_ids:
        return JSONResponse(status_code=400, content={"message": f"Material not found: {missing_ids[0]}"})

    unlinked_items = [
        ingredient
        for ingredient in ingredients_by_id.values()
        if ingredient.preferred_supplier_id != supplier.id
    ]
    if unlinked_items:
        return JSONResponse(
            status_code=400,
            content={"message": f"{unlinked_items[0].name} is not linked to {supplier.name}"},
        )

    normalized_items: list[dict[str, Any]] = []
    for raw in items_data:
        ing = db.session.get(Ingredient, int(raw.get("ingredient_id", 0)))
        if ing is None:
            return JSONResponse(status_code=404, content={"message": f"Ingredient {raw.get('ingredient_id')} not found"})
        try:
            pkg_override = raw.get("packaging_units_per_one")
            qty_b, price_b, unit_enum = normalize_po_line_to_ingredient_base(
                ing,
                float(raw.get("quantity_ordered", 0)),
                str(raw.get("unit", "")),
                float(raw.get("unit_price", 0)),
                packaging_units_per_one=float(pkg_override) if pkg_override is not None else None,
            )
        except ValueError as exc:
            return JSONResponse(status_code=400, content={"message": str(exc)})
        normalized_items.append(
            {
                "ingredient_id": int(raw["ingredient_id"]),
                "quantity_ordered": qty_b,
                "unit_price": price_b,
                "unit": unit_enum,
                "notes": raw.get("notes"),
            }
        )

    data["total_amount"] = sum(float(i["quantity_ordered"]) * float(i["unit_price"]) for i in normalized_items)
    return data, normalized_items


def _purchase_order_has_received_stock(po: PurchaseOrder) -> bool:
    return any(float(item.quantity_received or 0.0) > 0.000001 for item in po.items)


def _apply_supplier_material_links(supplier: Supplier, linked_material_ids: list[int] | None) -> None:
    if linked_material_ids is None:
        return

    ingredient_rows = (
        Ingredient.query.filter(Ingredient.id.in_(linked_material_ids)).all()
        if linked_material_ids
        else []
    )
    found_ids = {int(ingredient.id) for ingredient in ingredient_rows}
    missing_ids = sorted(material_id for material_id in linked_material_ids if material_id not in found_ids)
    if missing_ids:
        raise ValueError(f"Material not found: {missing_ids[0]}")

    Ingredient.query.filter_by(preferred_supplier_id=supplier.id).filter(~Ingredient.id.in_(found_ids or [-1])).update(
        {"preferred_supplier_id": None},
        synchronize_session=False,
    )
    for ingredient in ingredient_rows:
        ingredient.preferred_supplier_id = supplier.id


# --- Suppliers ---

@inventory_advanced_router.get("/suppliers")
def list_suppliers(current_user: User = Depends(get_current_user)):
    suppliers = Supplier.query.filter_by(is_active=True).all()
    supplier_ids = [supplier.id for supplier in suppliers]
    linked_by_supplier: dict[int, list[Ingredient]] = {supplier_id: [] for supplier_id in supplier_ids}
    if supplier_ids:
        linked_rows = Ingredient.query.filter(Ingredient.preferred_supplier_id.in_(supplier_ids)).order_by(Ingredient.name.asc()).all()
        for ingredient in linked_rows:
            supplier_id = int(ingredient.preferred_supplier_id or 0)
            linked_by_supplier.setdefault(supplier_id, []).append(ingredient)
    return {"suppliers": [_supplier_to_dict(supplier, linked_by_supplier.get(supplier.id, [])) for supplier in suppliers]}

@inventory_advanced_router.post("/suppliers")
def create_supplier(payload: SupplierCreate, current_user: User = Depends(get_current_user)):
    data = payload.model_dump()
    linked_material_ids = data.pop("linked_material_ids", None)
    sku = (data.get("sku") or "").strip() or None
    if sku and Supplier.query.filter_by(sku=sku).first():
        return JSONResponse(status_code=409, content={"message": "Supplier with this SKU already exists"})
    data["sku"] = sku
    try:
        s = Supplier(**data)
        db.session.add(s)
        db.session.flush()
        _apply_supplier_material_links(s, linked_material_ids)
        db.session.commit()
    except ValueError as exc:
        db.session.rollback()
        return JSONResponse(status_code=404, content={"message": str(exc)})
    return {"id": s.id, "message": "Supplier created", "supplier": _supplier_to_dict(s, list(s.ingredients))}


@inventory_advanced_router.put("/suppliers/{supplier_id}")
@inventory_advanced_router.patch("/suppliers/{supplier_id}")
def update_supplier(
    supplier_id: int,
    payload: SupplierUpdate,
    current_user: User = Depends(get_current_user),
):
    supplier = db.session.get(Supplier, supplier_id)
    if not supplier:
        return JSONResponse(status_code=404, content={"message": "Not found"})

    data = payload.model_dump(exclude_unset=True)
    linked_material_ids = data.pop("linked_material_ids", None)
    if "sku" in data:
        sku = (data.get("sku") or "").strip() or None
        existing = Supplier.query.filter_by(sku=sku).first() if sku else None
        if existing and existing.id != supplier.id:
            return JSONResponse(status_code=409, content={"message": "Supplier with this SKU already exists"})
        data["sku"] = sku

    try:
        for key, value in data.items():
            setattr(supplier, key, value)
        _apply_supplier_material_links(supplier, linked_material_ids)
        db.session.commit()
    except ValueError as exc:
        db.session.rollback()
        return JSONResponse(status_code=404, content={"message": str(exc)})
    return {"message": "Supplier updated", "supplier": _supplier_to_dict(supplier, list(supplier.ingredients))}


@inventory_advanced_router.delete("/suppliers/{supplier_id}")
def delete_supplier(
    supplier_id: int,
    current_user: User = Depends(get_current_user),
):
    supplier = db.session.get(Supplier, supplier_id)
    if not supplier:
        return JSONResponse(status_code=404, content={"message": "Not found"})

    supplier.is_active = False
    Ingredient.query.filter_by(preferred_supplier_id=supplier.id).update(
        {"preferred_supplier_id": None},
        synchronize_session=False,
    )
    db.session.commit()
    return {"message": "Supplier archived"}


# --- Ingredients ---

@inventory_advanced_router.get("/ingredients")
def list_ingredients(
    branch_id: str | None = None,
    current_user: User = Depends(get_current_user),
):
    bid = _resolve_inventory_branch(branch_id, current_user)
    ingredients = Ingredient.query.filter_by(is_active=True).all()
    return {
        "ingredients": [
            _ingredient_to_dict(i, bid)
            for i in ingredients
        ]
    }


@inventory_advanced_router.post("/ingredients")
def create_ingredient(payload: IngredientCreate, current_user: User = Depends(get_current_user)):
    data = payload.model_dump()
    brand_name = str(data.get("brand_name") or data.get("brandName") or "").strip()
    data["brand_name"] = brand_name
    i = Ingredient(**data)
    db.session.add(i)
    db.session.flush()
    seed_branch_stocks_for_new_ingredient(i.id, float(data.get("current_stock") or 0.0))
    sync_ingredient_master_total(i.id)
    db.session.commit()
    return {"id": i.id, "message": "Ingredient created"}


@inventory_advanced_router.post("/ingredients/bulk")
def create_ingredients_bulk(payload: IngredientBulkCreate, current_user: User = Depends(get_current_user)):
    results = []
    for ing_data in payload.ingredients:
        data = ing_data.model_dump()
        brand_name = str(data.get("brand_name") or data.get("brandName") or "").strip()
        data["brand_name"] = brand_name
        i = Ingredient(**data)
        db.session.add(i)
        db.session.flush()
        seed_branch_stocks_for_new_ingredient(i.id, float(data.get("current_stock") or 0.0))
        sync_ingredient_master_total(i.id)
        results.append({"id": i.id, "name": i.name})
    
    db.session.commit()
    return {"message": f"Successfully created {len(results)} ingredients", "results": results}


@inventory_advanced_router.put("/ingredients/{ingredient_id}")
def update_ingredient(ingredient_id: int, payload: IngredientUpdate, current_user: User = Depends(get_current_user)):
    i = db.session.get(Ingredient, ingredient_id)
    if not i:
        return JSONResponse(status_code=404, content={"message": "Not found"})
    data = payload.model_dump(exclude_unset=True)
    data.pop("current_stock", None)
    if "brand_name" in data or "brandName" in data:
        brand_name = str(data.get("brand_name") or data.get("brandName") or "").strip()
        data["brand_name"] = brand_name
        data.pop("brandName", None)
    should_recalculate = "average_cost" in data
    for k, v in data.items():
        setattr(i, k, v)
    if should_recalculate:
        _recalculate_products_using_ingredient(i.id)
    db.session.commit()
    return {"message": "Ingredient updated"}


# --- Prepared sauces / marinations ---

def _component_payload(component: PreparedItemComponent) -> dict[str, Any]:
    return {
        "id": component.id,
        "ingredient_id": component.ingredient_id,
        "quantity": component.quantity,
        "unit": component.unit.value if hasattr(component.unit, "value") else component.unit,
        "notes": component.notes,
    }


def _prepared_item_payload(item: PreparedItem, branch_id: str) -> dict[str, Any]:
    return {
        "id": item.id,
        "name": item.name,
        "sku": item.sku,
        "kind": item.kind,
        "unit": item.unit.value if hasattr(item.unit, "value") else item.unit,
        "current_stock": get_prepared_branch_stock(item.id, branch_id),
        "average_cost": item.average_cost,
        "notes": item.notes,
        "components": [_component_payload(c) for c in item.components],
        "branch_id": branch_id,
    }


def _replace_prepared_components(item: PreparedItem, components: list[Any]) -> None:
    item.components.clear()
    db.session.flush()
    for component in components:
        data = component.model_dump() if hasattr(component, "model_dump") else dict(component)
        ingredient = db.session.get(Ingredient, int(data.get("ingredient_id", 0)))
        if ingredient is None:
            raise ValueError(f"Ingredient not found: {data.get('ingredient_id')}")
        input_u = str(data.get("unit", "")).strip().lower()
        try:
            qty_base = to_base_unit(float(data.get("quantity", 0)), input_u, ingredient)
        except ValueError as exc:
            raise ValueError(str(exc)) from exc
        data["quantity"] = qty_base
        data["unit"] = ingredient.unit
        item.components.append(PreparedItemComponent(**data))


@inventory_advanced_router.get("/prepared-items")
def list_prepared_items(
    branch_id: str | None = None,
    current_user: User = Depends(get_current_user),
):
    bid = _resolve_inventory_branch(branch_id, current_user)
    items = PreparedItem.query.filter_by(is_active=True).order_by(PreparedItem.name.asc()).all()
    return {"prepared_items": [_prepared_item_payload(item, bid) for item in items]}


@inventory_advanced_router.post("/prepared-items")
def create_prepared_item(payload: PreparedItemCreate, current_user: User = Depends(get_current_user)):
    data = payload.model_dump()
    components = data.pop("components", [])
    sku = (data.get("sku") or "").strip() or None
    if sku and PreparedItem.query.filter_by(sku=sku).first():
        return JSONResponse(status_code=409, content={"message": "Prepared item with this SKU already exists"})
    data["sku"] = sku
    item = PreparedItem(**data)
    db.session.add(item)
    db.session.flush()
    try:
        _replace_prepared_components(item, components)
    except ValueError as exc:
        db.session.rollback()
        return JSONResponse(status_code=400, content={"message": str(exc)})
    seed_prepared_branch_stocks_for_new_item(item.id, 0.0)
    db.session.commit()
    return {"id": item.id, "message": "Prepared sauce/marination created"}


@inventory_advanced_router.put("/prepared-items/{prepared_item_id}")
def update_prepared_item(
    prepared_item_id: int,
    payload: PreparedItemUpdate,
    current_user: User = Depends(get_current_user),
):
    item = db.session.get(PreparedItem, prepared_item_id)
    if not item:
        return JSONResponse(status_code=404, content={"message": "Prepared item not found"})
    data = payload.model_dump(exclude_unset=True)
    components = data.pop("components", None)
    if "sku" in data:
        sku = (data.get("sku") or "").strip() or None
        existing = PreparedItem.query.filter_by(sku=sku).first() if sku else None
        if existing and existing.id != item.id:
            return JSONResponse(status_code=409, content={"message": "Prepared item with this SKU already exists"})
        data["sku"] = sku
    for key, value in data.items():
        setattr(item, key, value)
    if components is not None:
        try:
            _replace_prepared_components(item, components)
        except ValueError as exc:
            db.session.rollback()
            return JSONResponse(status_code=400, content={"message": str(exc)})
    if "average_cost" in data:
        _recalculate_products_using_prepared_item(item.id)
    db.session.commit()
    return {"message": "Prepared sauce/marination updated"}


@inventory_advanced_router.post("/prepared-items/{prepared_item_id}/batches")
def make_prepared_batch(
    prepared_item_id: int,
    payload: PreparedItemBatchCreate,
    current_user: User = Depends(get_current_user),
):
    item = db.session.get(PreparedItem, prepared_item_id)
    if not item or not item.is_active:
        return JSONResponse(status_code=404, content={"message": "Prepared item not found"})
    if not item.components:
        return JSONResponse(status_code=400, content={"message": "Add ingredients before making this sauce/marination"})

    branch_id = _resolve_inventory_branch(payload.branch_id, current_user)
    qty = float(payload.quantity)
    total_cost = 0.0
    try:
        for component in item.components:
            ing = component.ingredient
            if ing is None:
                continue
            needed = float(component.quantity) * qty
            total_cost += needed * float(ing.average_cost or 0.0)
            adjust_branch_ingredient_stock(
                ing.id,
                branch_id,
                -needed,
                movement_type="preparation",
                user_id=current_user.id,
                reference_id=item.id,
                reference_type="prepared_item",
                reason=payload.reason or f"Made {qty:g} {item.unit.value if hasattr(item.unit, 'value') else item.unit} {item.name}",
                unit_cost=float(ing.average_cost or 0.0),
                allow_negative=False,
            )
            sync_ingredient_master_total(ing.id)

        before = get_prepared_branch_stock(item.id, branch_id)
        total_value_before = before * float(item.average_cost or 0.0)
        new_total_qty = before + qty
        if new_total_qty > 0:
            item.average_cost = (total_value_before + total_cost) / new_total_qty
        _, after = adjust_prepared_branch_stock(
            item.id,
            branch_id,
            qty,
            movement_type="preparation",
            user_id=current_user.id,
            reference_id=item.id,
            reference_type="prepared_item",
            reason=payload.reason or f"Made {item.name}",
            allow_negative=False,
        )
        sync_prepared_master_total(item.id)
        db.session.commit()
        return {"message": "Batch made and ingredient stock deducted", "new_stock": after}
    except InsufficientIngredientStock as exc:
        db.session.rollback()
        return JSONResponse(status_code=400, content={"message": str(exc)})
    except Exception as exc:
        db.session.rollback()
        return JSONResponse(status_code=400, content={"message": str(exc)})


# --- Recipes (BOM) ---

@inventory_advanced_router.get("/recipes/{product_id}")
def get_recipe(product_id: int, current_user: User = Depends(get_current_user)):
    items = RecipeItem.query.filter_by(product_id=product_id).all()
    prepared_items = RecipePreparedItem.query.filter_by(product_id=product_id).all()
    extra_cost_items = RecipeExtraCost.query.filter_by(product_id=product_id).all()
    return {"recipe_items": [{
        "id": r.id, "ingredient_id": r.ingredient_id,
        "ingredient_name": r.ingredient.name if r.ingredient else None,
        "brand_name": getattr(r.ingredient, "brand_name", None) if r.ingredient else None,
        "brandName": getattr(r.ingredient, "brand_name", None) if r.ingredient else None,
        "quantity": r.quantity,
        "unit": r.unit.value if hasattr(r.unit, "value") else r.unit,
        "unitOfMeasure": r.unit.value if hasattr(r.unit, "value") else r.unit,
        "notes": r.notes,
        "variant_key": getattr(r, "variant_key", None) or "",
    } for r in items], "recipe_prepared_items": [{
        "id": r.id, "prepared_item_id": r.prepared_item_id,
        "quantity": r.quantity, "unit": r.unit.value if hasattr(r.unit, 'value') else r.unit, "notes": r.notes,
        "variant_key": getattr(r, "variant_key", None) or "",
    } for r in prepared_items], "recipe_extra_costs": [{
        "id": c.id,
        "product_id": c.product_id,
        "name": c.name,
        "amount": float(c.amount or 0.0),
        "variant_key": (c.variant_key or ""),
        "created_at": c.created_at.isoformat() if c.created_at else None,
    } for c in extra_cost_items]}

@inventory_advanced_router.post("/recipes")
def add_recipe_item(payload: RecipeItemCreate, current_user: User = Depends(get_current_user)):
    data = payload.model_dump()
    ingredient = db.session.get(Ingredient, int(data.get("ingredient_id", 0)))
    if ingredient is None:
        return JSONResponse(status_code=404, content={"message": "Ingredient not found"})
    input_u = str(data.get("unit", "")).strip().lower()
    try:
        qty_base = to_base_unit(float(data.get("quantity", 0)), input_u, ingredient)
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"message": str(exc)})
    data["quantity"] = qty_base
    data["unit"] = ingredient.unit
    if "variant_key" not in data or data.get("variant_key") is None:
        data["variant_key"] = ""
    else:
        data["variant_key"] = str(data["variant_key"]).strip()[:100]
    r = RecipeItem(**data)
    db.session.add(r)
    product = db.session.get(Product, r.product_id)
    if product is not None:
        recalculate_product_cost(product)
    db.session.commit()
    return {"id": r.id, "message": "Recipe item mapped"}

@inventory_advanced_router.delete("/recipes/{recipe_item_id}")
def delete_recipe_item(recipe_item_id: int, current_user: User = Depends(get_current_user)):
    r = db.session.get(RecipeItem, recipe_item_id)
    if r:
        product = db.session.get(Product, r.product_id)
        db.session.delete(r)
        db.session.flush()
        if product is not None:
            recalculate_product_cost(product)
        db.session.commit()
    return {"message": "Deleted"}


@inventory_advanced_router.post("/recipes/prepared-items")
def add_recipe_prepared_item(payload: RecipePreparedItemCreate, current_user: User = Depends(get_current_user)):
    data = payload.model_dump()
    prepared_item = db.session.get(PreparedItem, int(data.get("prepared_item_id", 0)))
    if prepared_item is None:
        return JSONResponse(status_code=404, content={"message": "Prepared item not found"})
    prepared_unit = prepared_item.unit.value if hasattr(prepared_item.unit, "value") else str(prepared_item.unit or "")
    try:
        qty_base = convert_quantity_to_unit(
            float(data.get("quantity", 0)),
            normalize_unit_token(str(data.get("unit", ""))),
            normalize_unit_token(prepared_unit),
        )
    except ValueError as exc:
        return JSONResponse(
            status_code=400,
            content={
                "message": (
                    f"Cannot convert recipe unit to prepared item unit ({prepared_unit}): {exc}"
                )
            },
        )
    data["quantity"] = qty_base
    data["unit"] = prepared_item.unit
    data["variant_key"] = str(data.get("variant_key") or "").strip()[:100]
    r = RecipePreparedItem(**data)
    db.session.add(r)
    product = db.session.get(Product, r.product_id)
    if product is not None:
        recalculate_product_cost(product)
    db.session.commit()
    return {"id": r.id, "message": "Prepared sauce/marination mapped"}


@inventory_advanced_router.delete("/recipes/prepared-items/{recipe_item_id}")
def delete_recipe_prepared_item(recipe_item_id: int, current_user: User = Depends(get_current_user)):
    r = db.session.get(RecipePreparedItem, recipe_item_id)
    if r:
        product = db.session.get(Product, r.product_id)
        db.session.delete(r)
        db.session.flush()
        if product is not None:
            recalculate_product_cost(product)
        db.session.commit()
    return {"message": "Deleted"}


@inventory_advanced_router.post("/recipes/extra-costs")
def add_recipe_extra_cost(payload: RecipeExtraCostCreate, current_user: User = Depends(get_current_user)):
    data = payload.model_dump()
    data["variant_key"] = str(data.get("variant_key") or "").strip()[:100]
    row = RecipeExtraCost(**data)
    db.session.add(row)
    product = db.session.get(Product, row.product_id)
    if product is not None:
        recalculate_product_cost(product)
    db.session.commit()
    return {"id": row.id, "message": "Extra cost mapped"}


@inventory_advanced_router.patch("/recipes/extra-costs/{extra_cost_id}")
def update_recipe_extra_cost(
    extra_cost_id: int,
    payload: dict[str, Any] | None = None,
    current_user: User = Depends(get_current_user),
):
    row = db.session.get(RecipeExtraCost, extra_cost_id)
    if row is None:
        return JSONResponse(status_code=404, content={"message": "Not found"})
    data = payload or {}
    if "name" in data:
        name = str(data.get("name") or "").strip()[:120]
        if not name:
            return JSONResponse(status_code=400, content={"message": "name is required"})
        row.name = name
    if "amount" in data:
        try:
            amount = float(data.get("amount") or 0.0)
        except (TypeError, ValueError):
            return JSONResponse(status_code=400, content={"message": "amount must be a number"})
        if amount < 0:
            return JSONResponse(status_code=400, content={"message": "amount must be non-negative"})
        row.amount = amount
    if "variant_key" in data:
        row.variant_key = str(data.get("variant_key") or "").strip()[:100]
    product = db.session.get(Product, row.product_id)
    if product is not None:
        recalculate_product_cost(product)
    db.session.commit()
    return {"message": "Extra cost updated", "id": row.id}


@inventory_advanced_router.delete("/recipes/extra-costs/{extra_cost_id}")
def delete_recipe_extra_cost(extra_cost_id: int, current_user: User = Depends(get_current_user)):
    row = db.session.get(RecipeExtraCost, extra_cost_id)
    if row:
        product = db.session.get(Product, row.product_id)
        db.session.delete(row)
        db.session.flush()
        if product is not None:
            recalculate_product_cost(product)
        db.session.commit()
    return {"message": "Deleted"}


# --- Purchase Orders ---

@inventory_advanced_router.get("/purchase-orders")
def list_purchase_orders(current_user: User = Depends(get_current_user)):
    pos = PurchaseOrder.query.order_by(PurchaseOrder.created_at.desc()).all()
    return {"purchase_orders": [{
        "id": p.id, "po_number": p.po_number, "supplier_id": p.supplier_id, "supplier_name": p.supplier.name if p.supplier else None,
        "status": _po_status_value(p),
        "total_amount": p.total_amount,
        "expected_delivery": p.expected_delivery.isoformat() if p.expected_delivery else None,
        "received_date": p.received_date.isoformat() if p.received_date else None,
        "created_at": p.created_at.isoformat(),
        "notes": p.notes,
        "items": [_po_item_to_dict(item) for item in p.items],
    } for p in pos]}

@inventory_advanced_router.post("/purchase-orders")
def create_purchase_order(payload: PurchaseOrderCreate, current_user: User = Depends(get_current_user)):
    normalized = _normalize_purchase_order_payload(payload)
    if isinstance(normalized, JSONResponse):
        return normalized
    data, normalized_items = normalized

    import uuid
    data['po_number'] = f"PO-{uuid.uuid4().hex[:6].upper()}"
    data['created_by'] = current_user.id

    po = PurchaseOrder(**data)
    db.session.add(po)
    db.session.flush()

    for item in normalized_items:
        poi = PurchaseOrderItem(**item, purchase_order_id=po.id)
        db.session.add(poi)

    db.session.commit()
    return {"id": po.id, "po_number": po.po_number, "message": "PO created"}


@inventory_advanced_router.put("/purchase-orders/{po_id}")
def update_purchase_order(po_id: int, payload: PurchaseOrderCreate, current_user: User = Depends(get_current_user)):
    po = db.session.get(PurchaseOrder, po_id)
    if not po:
        return JSONResponse(status_code=404, content={"message": "PO not found"})
    if _po_status_value(po) in {"received", "cancelled"} or _purchase_order_has_received_stock(po):
        return JSONResponse(
            status_code=400,
            content={"message": "Only purchase orders with no received stock can be edited"},
        )

    normalized = _normalize_purchase_order_payload(payload)
    if isinstance(normalized, JSONResponse):
        return normalized
    data, normalized_items = normalized

    po.supplier_id = data["supplier_id"]
    po.expected_delivery = data.get("expected_delivery")
    po.notes = data.get("notes")
    po.branch_id = data.get("branch_id") or po.branch_id
    po.total_amount = data["total_amount"]

    po.items.clear()
    db.session.flush()
    for item in normalized_items:
        db.session.add(PurchaseOrderItem(**item, purchase_order_id=po.id))

    db.session.commit()
    return {"id": po.id, "po_number": po.po_number, "message": "PO updated"}


@inventory_advanced_router.delete("/purchase-orders/{po_id}")
def delete_purchase_order(po_id: int, current_user: User = Depends(get_current_user)):
    po = db.session.get(PurchaseOrder, po_id)
    if not po:
        return JSONResponse(status_code=404, content={"message": "PO not found"})
    if _po_status_value(po) == "received" or _purchase_order_has_received_stock(po):
        return JSONResponse(
            status_code=400,
            content={"message": "Only purchase orders with no received stock can be deleted"},
        )

    try:
        db.session.delete(po)
        db.session.commit()
    except Exception as exc:
        db.session.rollback()
        return JSONResponse(
            status_code=500,
            content={"message": "Error deleting purchase order", "error": str(exc) or "Delete failed"},
        )
    return {"message": "PO deleted"}

@inventory_advanced_router.post("/purchase-orders/{po_id}/receive")
def receive_purchase_order(po_id: int, payload: PurchaseOrderReceive, current_user: User = Depends(get_current_user)):
    po = db.session.get(PurchaseOrder, po_id)
    if not po:
        return JSONResponse(status_code=404, content={"message": "PO not found"})
    status = _po_status_value(po)
    if status in {"received", "cancelled"}:
        return JSONResponse(status_code=400, content={"message": "Invalid PO or already received"})

    branch_id = po.branch_id or current_user.branch_id or resolve_terminal_branch_id(current_user)
    quantities_by_item_id: dict[int, float] | None = None
    quantities_by_ingredient_id: dict[int, float] | None = None

    if payload.items is not None:
        quantities_by_item_id = {}
        quantities_by_ingredient_id = {}
        for received_item in payload.items:
            qty = float(received_item.quantity_received or 0.0)
            if received_item.item_id is not None:
                quantities_by_item_id[int(received_item.item_id)] = (
                    quantities_by_item_id.get(int(received_item.item_id), 0.0) + qty
                )
            elif received_item.ingredient_id is not None:
                quantities_by_ingredient_id[int(received_item.ingredient_id)] = (
                    quantities_by_ingredient_id.get(int(received_item.ingredient_id), 0.0) + qty
                )
            else:
                return JSONResponse(status_code=400, content={"message": "Received item must include item_id or ingredient_id"})

    total_received = 0.0
    for item in po.items:
        ing = item.ingredient
        if ing is None:
            continue
        already_received = float(item.quantity_received or 0.0)
        remaining = max(float(item.quantity_ordered or 0.0) - already_received, 0.0)
        if payload.items is None:
            qty_add = remaining
        else:
            qty_add = float((quantities_by_item_id or {}).get(item.id, 0.0))
            if qty_add == 0.0:
                qty_add = float((quantities_by_ingredient_id or {}).get(item.ingredient_id, 0.0))
        if qty_add <= 0:
            continue
        if qty_add - remaining > 0.000001:
            db.session.rollback()
            return JSONResponse(
                status_code=400,
                content={"message": f"Received quantity for {ing.name} exceeds remaining order quantity"},
            )
        qty_before = get_branch_stock(ing.id, branch_id)
        total_value_before = qty_before * float(ing.average_cost or 0.0)
        new_value = qty_add * float(item.unit_price)
        new_total_qty = qty_before + qty_add
        if new_total_qty > 0:
            ing.average_cost = (total_value_before + new_value) / new_total_qty
        ing.last_purchase_price = float(item.unit_price)
        item.quantity_received = already_received + qty_add
        total_received += qty_add

        adjust_branch_ingredient_stock(
            ing.id,
            branch_id,
            qty_add,
            movement_type="purchase",
            user_id=current_user.id,
            reference_id=po.id,
            reference_type="purchase_order",
            reason="PO Received",
            unit_cost=float(item.unit_price),
            allow_negative=False,
        )
        sync_ingredient_master_total(ing.id)

    if total_received <= 0:
        db.session.rollback()
        return JSONResponse(status_code=400, content={"message": "Enter at least one received quantity"})

    all_received = all(
        max(float(item.quantity_ordered or 0.0) - float(item.quantity_received or 0.0), 0.0) <= 0.000001
        for item in po.items
    )
    if all_received:
        po.status = "received"
        po.received_date = payload.received_date or datetime.now(timezone.utc)
        message = "PO fully received, stock and costs updated"
    else:
        po.status = "partially_received"
        message = "Partial stock received; remaining quantities are still open"

    db.session.commit()
    return {
        "message": message,
        "status": _po_status_value(po),
        "items": [_po_item_to_dict(item) for item in po.items],
    }

@inventory_advanced_router.post("/purchase-orders/{po_id}/cancel")
def cancel_purchase_order(po_id: int, current_user: User = Depends(get_current_user)):
    po = db.session.get(PurchaseOrder, po_id)
    if not po:
        return JSONResponse(status_code=404, content={"message": "PO not found"})
    if _po_status_value(po) == "received":
        return JSONResponse(status_code=400, content={"message": "Cannot cancel a PO that has already been received. You must manually reverse the stock instead."})
    
    po.status = "cancelled"
    db.session.commit()
    return {"message": "PO cancelled successfully"}

# --- Stock Movements (Manual adjustments) ---

@inventory_advanced_router.post("/movements")
def manual_stock_movement(payload: StockMovementCreate, current_user: User = Depends(get_current_user)):
    ing = db.session.get(Ingredient, payload.ingredient_id)
    if not ing:
        return JSONResponse(status_code=404, content={"message": "Ingredient not found"})

    branch_id = _resolve_inventory_branch(payload.branch_id, current_user)
    qty_delta = float(payload.quantity_change)
    if getattr(payload, "input_unit", None):
        try:
            sign = -1.0 if qty_delta < 0 else 1.0
            qty_delta = sign * to_base_unit(abs(qty_delta), str(payload.input_unit), ing)
        except ValueError as exc:
            return JSONResponse(status_code=400, content={"message": str(exc)})
    try:
        _, qty_after = adjust_branch_ingredient_stock(
            ing.id,
            branch_id,
            qty_delta,
            movement_type=payload.movement_type,
            user_id=current_user.id,
            reference_id=payload.reference_id,
            reference_type=payload.reference_type,
            reason=payload.reason,
            unit_cost=float(payload.unit_cost or 0),
            allow_negative=False,
        )
        sync_ingredient_master_total(ing.id)
        db.session.commit()
        return {"message": "Stock adjusted successfully", "new_stock": qty_after}
    except Exception as exc:
        db.session.rollback()
        return JSONResponse(status_code=400, content={"message": str(exc)})
