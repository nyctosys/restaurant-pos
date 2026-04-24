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


def _ingredient_to_dict(ingredient: Ingredient, branch_id: int) -> dict[str, Any]:
    unit = ingredient.unit or ""
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
            _ingredient_to_dict(i, bid)
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
        "ingredient_name": r.ingredient.name if r.ingredient else None,
        "brand_name": getattr(r.ingredient, "brand_name", None) if r.ingredient else None,
        "brandName": getattr(r.ingredient, "brand_name", None) if r.ingredient else None,
        "quantity": r.quantity, "unit": r.unit, "unitOfMeasure": r.unit, "notes": r.notes,
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
