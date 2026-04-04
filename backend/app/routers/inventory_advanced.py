from __future__ import annotations
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from app.models import (
    Ingredient,
    Product,
    PurchaseOrder,
    PurchaseOrderItem,
    RecipeItem,
    Supplier,
    User,
    db,
)
from app.services.branch_ingredient_stock import (
    adjust_branch_ingredient_stock,
    get_branch_stock,
    seed_branch_stocks_for_new_ingredient,
)
from app.services.ingredient_master_stock import sync_ingredient_master_total
from app.services.branch_scope import resolve_terminal_branch_id
from app.deps import get_current_user
from app.schemas.inventory_schemas import (
    SupplierCreate, SupplierUpdate, IngredientCreate, IngredientUpdate,
    RecipeItemCreate, PurchaseOrderCreate, PurchaseOrderReceive, StockMovementCreate
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
        "id": s.id, "name": s.name, "contact_person": s.contact_person,
        "phone": s.phone, "email": s.email, "address": s.address, 
        "notes": s.notes
    } for s in suppliers]}

@inventory_advanced_router.post("/suppliers")
def create_supplier(payload: SupplierCreate, current_user: User = Depends(get_current_user)):
    s = Supplier(**payload.model_dump())
    db.session.add(s)
    db.session.commit()
    return {"id": s.id, "message": "Supplier created"}


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


# --- Recipes (BOM) ---

@inventory_advanced_router.get("/recipes/{product_id}")
def get_recipe(product_id: int, current_user: User = Depends(get_current_user)):
    items = RecipeItem.query.filter_by(product_id=product_id).all()
    return {"recipe_items": [{
        "id": r.id, "ingredient_id": r.ingredient_id,
        "quantity": r.quantity, "unit": r.unit.value if hasattr(r.unit, 'value') else r.unit, "notes": r.notes,
        "variant_key": getattr(r, "variant_key", None) or "",
    } for r in items]}

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
