from typing import List, Optional
from pydantic import BaseModel
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from app.models import db, User, Product, ComboItem
from app_fastapi.deps import get_current_user

deals_router = APIRouter(prefix="/api/inventory-advanced/deals", tags=["deals"])

class ComboItemCreate(BaseModel):
    product_id: int
    quantity: int

class DealCreate(BaseModel):
    title: str
    sku: str
    base_price: float
    variants: Optional[List[dict]] = []
    combo_items: List[ComboItemCreate]

@deals_router.get("/")
def list_deals(current_user: User = Depends(get_current_user)):
    # Returns all products that are deals
    deals = Product.query.filter_by(is_deal=True, archived_at=None).all()
    output = []
    for d in deals:
        items = []
        for ci in d.combo_items:
            items.append({
                "id": ci.id,
                "product_id": ci.product_id,
                "product_title": ci.child_product.title if ci.child_product else "Unknown",
                "quantity": ci.quantity
            })
        output.append({
            "id": d.id,
            "sku": d.sku,
            "title": d.title,
            "base_price": float(d.base_price),
            "combo_items": items
        })
    return {"deals": output}

@deals_router.post("/")
def create_deal(payload: DealCreate, current_user: User = Depends(get_current_user)):
    # Create the Product
    existing = Product.query.filter_by(sku=payload.sku).first()
    if existing:
        return JSONResponse(status_code=400, content={"message": "SKU already exists"})
        
    combo = Product(
        sku=payload.sku,
        title=payload.title,
        base_price=payload.base_price,
        variants=payload.variants,
        is_deal=True,
        section="Deals"
    )
    db.session.add(combo)
    db.session.flush()
    
    # Add ComboItems
    for ci_data in payload.combo_items:
        ci = ComboItem(
            combo_id=combo.id,
            product_id=ci_data.product_id,
            quantity=ci_data.quantity
        )
        db.session.add(ci)
        
    db.session.commit()
    return {"id": combo.id, "message": "Deal created successfully"}

@deals_router.delete("/{deal_id}")
def delete_deal(deal_id: int, current_user: User = Depends(get_current_user)):
    deal = Product.query.get(deal_id)
    if not deal or not deal.is_deal:
        return JSONResponse(status_code=404, content={"message": "Deal not found"})
        
    db.session.delete(deal) # Will cascade delete combo_items
    db.session.commit()
    return {"message": "Deal deleted permanently"}
