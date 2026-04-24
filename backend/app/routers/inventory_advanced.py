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
    RecipePreparedItem,
    Supplier,
    User,
    db,
)
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
from app.services.branch_scope import resolve_terminal_branch_id
from app.deps import get_current_user
from app.schemas.inventory_schemas import (
    SupplierCreate, SupplierUpdate, IngredientCreate, IngredientUpdate, IngredientBulkCreate,
    RecipeItemCreate, PurchaseOrderCreate, PurchaseOrderReceive, StockMovementCreate,
    PreparedItemCreate, PreparedItemUpdate, PreparedItemBatchCreate, RecipePreparedItemCreate,
)

inventory_advanced_router = APIRouter(prefix="/api/inventory-advanced", tags=["inventory-advanced"])


def _resolve_inventory_branch(branch_id: int | None, current_user: User) -> int:
    _ = branch_id
    return resolve_terminal_branch_id(current_user)


# --- Suppliers ---

@inventory_advanced_router.get("/suppliers")
def list_suppliers(current_user: User = Depends(get_current_user)):
    suppliers = Supplier.query.filter_by(is_active=True).all()
    return {"suppliers": [{
        "id": s.id, "name": s.name, "sku": s.sku, "contact_person": s.contact_person,
        "phone": s.phone, "email": s.email, "address": s.address, 
        "notes": s.notes
    } for s in suppliers]}

@inventory_advanced_router.post("/suppliers")
def create_supplier(payload: SupplierCreate, current_user: User = Depends(get_current_user)):
    data = payload.model_dump()
    sku = (data.get("sku") or "").strip() or None
    if sku and Supplier.query.filter_by(sku=sku).first():
        return JSONResponse(status_code=409, content={"message": "Supplier with this SKU already exists"})
    data["sku"] = sku
    s = Supplier(**data)
    db.session.add(s)
    db.session.commit()
    return {"id": s.id, "message": "Supplier created"}


@inventory_advanced_router.put("/suppliers/{supplier_id}")
def update_supplier(
    supplier_id: int,
    payload: SupplierUpdate,
    current_user: User = Depends(get_current_user),
):
    supplier = db.session.get(Supplier, supplier_id)
    if not supplier:
        return JSONResponse(status_code=404, content={"message": "Not found"})

    data = payload.model_dump(exclude_unset=True)
    if "sku" in data:
        sku = (data.get("sku") or "").strip() or None
        existing = Supplier.query.filter_by(sku=sku).first() if sku else None
        if existing and existing.id != supplier.id:
            return JSONResponse(status_code=409, content={"message": "Supplier with this SKU already exists"})
        data["sku"] = sku

    for key, value in data.items():
        setattr(supplier, key, value)

    db.session.commit()
    return {"message": "Supplier updated"}


# --- Ingredients ---

@inventory_advanced_router.get("/ingredients")
def list_ingredients(
    branch_id: int | None = None,
    current_user: User = Depends(get_current_user),
):
    bid = _resolve_inventory_branch(branch_id, current_user)
    ingredients = Ingredient.query.filter_by(is_active=True).all()
    return {
        "ingredients": [
            {
                "id": i.id,
                "name": i.name,
                "sku": i.sku,
                "unit": i.unit.value if hasattr(i.unit, "value") else i.unit,
                "purchase_unit": i.purchase_unit,
                "conversion_factor": i.conversion_factor,
                "current_stock": get_branch_stock(i.id, bid),
                "minimum_stock": i.minimum_stock,
                "reorder_quantity": i.reorder_quantity,
                "last_purchase_price": i.last_purchase_price,
                "average_cost": i.average_cost,
                "preferred_supplier_id": i.preferred_supplier_id,
                "category": i.category,
                "branch_id": bid,
            }
            for i in ingredients
        ]
    }


@inventory_advanced_router.post("/ingredients")
def create_ingredient(payload: IngredientCreate, current_user: User = Depends(get_current_user)):
    data = payload.model_dump()
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
    for k, v in data.items():
        setattr(i, k, v)
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


def _prepared_item_payload(item: PreparedItem, branch_id: int) -> dict[str, Any]:
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
        item.components.append(PreparedItemComponent(**data))


@inventory_advanced_router.get("/prepared-items")
def list_prepared_items(
    branch_id: int | None = None,
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
    _replace_prepared_components(item, components)
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
        _replace_prepared_components(item, components)
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
    return {"recipe_items": [{
        "id": r.id, "ingredient_id": r.ingredient_id,
        "quantity": r.quantity, "unit": r.unit.value if hasattr(r.unit, 'value') else r.unit, "notes": r.notes,
        "variant_key": getattr(r, "variant_key", None) or "",
    } for r in items], "recipe_prepared_items": [{
        "id": r.id, "prepared_item_id": r.prepared_item_id,
        "quantity": r.quantity, "unit": r.unit.value if hasattr(r.unit, 'value') else r.unit, "notes": r.notes,
        "variant_key": getattr(r, "variant_key", None) or "",
    } for r in prepared_items]}

@inventory_advanced_router.post("/recipes")
def add_recipe_item(payload: RecipeItemCreate, current_user: User = Depends(get_current_user)):
    data = payload.model_dump()
    if "variant_key" not in data or data.get("variant_key") is None:
        data["variant_key"] = ""
    else:
        data["variant_key"] = str(data["variant_key"]).strip()[:100]
    r = RecipeItem(**data)
    db.session.add(r)
    db.session.commit()
    return {"id": r.id, "message": "Recipe item mapped"}

@inventory_advanced_router.delete("/recipes/{recipe_item_id}")
def delete_recipe_item(recipe_item_id: int, current_user: User = Depends(get_current_user)):
    r = db.session.get(RecipeItem, recipe_item_id)
    if r:
        db.session.delete(r)
        db.session.commit()
    return {"message": "Deleted"}


@inventory_advanced_router.post("/recipes/prepared-items")
def add_recipe_prepared_item(payload: RecipePreparedItemCreate, current_user: User = Depends(get_current_user)):
    data = payload.model_dump()
    data["variant_key"] = str(data.get("variant_key") or "").strip()[:100]
    r = RecipePreparedItem(**data)
    db.session.add(r)
    db.session.commit()
    return {"id": r.id, "message": "Prepared sauce/marination mapped"}


@inventory_advanced_router.delete("/recipes/prepared-items/{recipe_item_id}")
def delete_recipe_prepared_item(recipe_item_id: int, current_user: User = Depends(get_current_user)):
    r = db.session.get(RecipePreparedItem, recipe_item_id)
    if r:
        db.session.delete(r)
        db.session.commit()
    return {"message": "Deleted"}


# --- Purchase Orders ---

@inventory_advanced_router.get("/purchase-orders")
def list_purchase_orders(current_user: User = Depends(get_current_user)):
    pos = PurchaseOrder.query.order_by(PurchaseOrder.created_at.desc()).all()
    return {"purchase_orders": [{
        "id": p.id, "po_number": p.po_number, "supplier_id": p.supplier_id,
        "status": p.status.value if hasattr(p.status, 'value') else p.status, 
        "total_amount": p.total_amount,
        "expected_delivery": p.expected_delivery.isoformat() if p.expected_delivery else None,
        "received_date": p.received_date.isoformat() if p.received_date else None,
        "created_at": p.created_at.isoformat()
    } for p in pos]}

@inventory_advanced_router.post("/purchase-orders")
def create_purchase_order(payload: PurchaseOrderCreate, current_user: User = Depends(get_current_user)):
    data = payload.model_dump()
    items_data = data.pop('items', [])
    
    import uuid
    data['po_number'] = f"PO-{uuid.uuid4().hex[:6].upper()}"
    data['created_by'] = current_user.id
    
    total = sum(i['quantity_ordered'] * i['unit_price'] for i in items_data)
    data['total_amount'] = total

    po = PurchaseOrder(**data)
    db.session.add(po)
    db.session.flush()

    for item in items_data:
        poi = PurchaseOrderItem(**item, purchase_order_id=po.id)
        db.session.add(poi)
    
    db.session.commit()
    return {"id": po.id, "po_number": po.po_number, "message": "PO created"}

@inventory_advanced_router.post("/purchase-orders/{po_id}/receive")
def receive_purchase_order(po_id: int, payload: PurchaseOrderReceive, current_user: User = Depends(get_current_user)):
    po = db.session.get(PurchaseOrder, po_id)
    if not po or po.status == "received":
        return JSONResponse(status_code=400, content={"message": "Invalid PO or already received"})

    po.status = "received"
    po.received_date = payload.received_date or datetime.now(timezone.utc)

    branch_id = int(po.branch_id or current_user.branch_id or 1)

    for item in po.items:
        ing = item.ingredient
        if ing is None:
            continue
        qty_add = float(item.quantity_ordered)
        qty_before = get_branch_stock(ing.id, branch_id)
        total_value_before = qty_before * float(ing.average_cost or 0.0)
        new_value = qty_add * float(item.unit_price)
        new_total_qty = qty_before + qty_add
        if new_total_qty > 0:
            ing.average_cost = (total_value_before + new_value) / new_total_qty
        ing.last_purchase_price = float(item.unit_price)
        item.quantity_received = item.quantity_ordered

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

    db.session.commit()
    return {"message": "PO fully received, stock and costs updated"}

@inventory_advanced_router.post("/purchase-orders/{po_id}/cancel")
def cancel_purchase_order(po_id: int, current_user: User = Depends(get_current_user)):
    po = db.session.get(PurchaseOrder, po_id)
    if not po:
        return JSONResponse(status_code=404, content={"message": "PO not found"})
    if po.status == "received":
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
    try:
        _, qty_after = adjust_branch_ingredient_stock(
            ing.id,
            branch_id,
            float(payload.quantity_change),
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
