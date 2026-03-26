from __future__ import annotations
from typing import Any
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from app.models import (
    db, User, Supplier, Ingredient, RecipeItem, PurchaseOrder, 
    PurchaseOrderItem, StockMovement, Product
)
from app_fastapi.deps import get_current_user
from app_fastapi.schemas.inventory_schemas import (
    SupplierCreate, SupplierUpdate, IngredientCreate, IngredientUpdate,
    RecipeItemCreate, PurchaseOrderCreate, PurchaseOrderReceive, StockMovementCreate
)

inventory_advanced_router = APIRouter(prefix="/api/inventory-advanced", tags=["inventory-advanced"])

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
def list_ingredients(current_user: User = Depends(get_current_user)):
    ingredients = Ingredient.query.filter_by(is_active=True).all()
    return {"ingredients": [{
        "id": i.id, "name": i.name, "sku": i.sku, "unit": i.unit.value if hasattr(i.unit, 'value') else i.unit,
        "current_stock": i.current_stock, "minimum_stock": i.minimum_stock,
        "reorder_quantity": i.reorder_quantity, "last_purchase_price": i.last_purchase_price,
        "average_cost": i.average_cost, "preferred_supplier_id": i.preferred_supplier_id,
        "category": i.category
    } for i in ingredients]}

@inventory_advanced_router.post("/ingredients")
def create_ingredient(payload: IngredientCreate, current_user: User = Depends(get_current_user)):
    i = Ingredient(**payload.model_dump())
    db.session.add(i)
    db.session.commit()
    return {"id": i.id, "message": "Ingredient created"}

@inventory_advanced_router.put("/ingredients/{ingredient_id}")
def update_ingredient(ingredient_id: int, payload: IngredientUpdate, current_user: User = Depends(get_current_user)):
    i = Ingredient.query.get(ingredient_id)
    if not i:
        return JSONResponse(status_code=404, content={"message": "Not found"})
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(i, k, v)
    db.session.commit()
    return {"message": "Ingredient updated"}


# --- Recipes (BOM) ---

@inventory_advanced_router.get("/recipes/{product_id}")
def get_recipe(product_id: int, current_user: User = Depends(get_current_user)):
    items = RecipeItem.query.filter_by(product_id=product_id).all()
    return {"recipe_items": [{
        "id": r.id, "ingredient_id": r.ingredient_id,
        "quantity": r.quantity, "unit": r.unit.value if hasattr(r.unit, 'value') else r.unit, "notes": r.notes
    } for r in items]}

@inventory_advanced_router.post("/recipes")
def add_recipe_item(payload: RecipeItemCreate, current_user: User = Depends(get_current_user)):
    r = RecipeItem(**payload.model_dump())
    db.session.add(r)
    db.session.commit()
    return {"id": r.id, "message": "Recipe item mapped"}

@inventory_advanced_router.delete("/recipes/{recipe_item_id}")
def delete_recipe_item(recipe_item_id: int, current_user: User = Depends(get_current_user)):
    r = RecipeItem.query.get(recipe_item_id)
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
    po = PurchaseOrder.query.get(po_id)
    if not po or po.status == "received":
        return JSONResponse(status_code=400, content={"message": "Invalid PO or already received"})
    
    po.status = "received"
    po.received_date = payload.received_date or datetime.utcnow()

    # Update ingredients stock
    for item in po.items:
        ing = item.ingredient
        
        # log movement
        sm = StockMovement(
            ingredient_id=ing.id,
            movement_type="purchase",
            quantity_change=item.quantity_ordered,
            quantity_before=ing.current_stock,
            quantity_after=ing.current_stock + item.quantity_ordered,
            unit_cost=item.unit_price,
            reference_id=po.id,
            reference_type="purchase_order",
            reason="PO Received",
            created_by=current_user.id,
            branch_id=po.branch_id
        )
        db.session.add(sm)

        # Update average cost
        total_value_before = ing.current_stock * ing.average_cost
        new_value = item.quantity_ordered * item.unit_price
        new_total_qty = ing.current_stock + item.quantity_ordered
        if new_total_qty > 0:
            ing.average_cost = (total_value_before + new_value) / new_total_qty
        
        ing.current_stock = new_total_qty
        ing.last_purchase_price = item.unit_price
        item.quantity_received = item.quantity_ordered

    db.session.commit()
    return {"message": "PO fully received, stock and costs updated"}

# --- Stock Movements (Manual adjustments) ---

@inventory_advanced_router.post("/movements")
def manual_stock_movement(payload: StockMovementCreate, current_user: User = Depends(get_current_user)):
    ing = Ingredient.query.get(payload.ingredient_id)
    if not ing:
        return JSONResponse(status_code=404, content={"message": "Ingredient not found"})
    
    qty_before = ing.current_stock
    qty_after = qty_before + payload.quantity_change
    
    sm = StockMovement(
        ingredient_id=ing.id,
        movement_type=payload.movement_type,
        quantity_change=payload.quantity_change,
        quantity_before=qty_before,
        quantity_after=qty_after,
        unit_cost=payload.unit_cost,
        reference_id=payload.reference_id,
        reference_type=payload.reference_type,
        reason=payload.reason,
        created_by=current_user.id,
        branch_id=payload.branch_id
    )
    db.session.add(sm)
    
    ing.current_stock = qty_after
    db.session.commit()
    
    return {"message": "Stock adjusted successfully", "new_stock": qty_after}
