from __future__ import annotations
from datetime import datetime
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field

class SupplierBase(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str
    sku: str | None = None
    contact_person: str | None = None
    phone: str | None = None
    email: str | None = None
    address: str | None = None
    notes: str | None = None
    is_active: bool = True

class SupplierCreate(SupplierBase):
    pass

class SupplierUpdate(SupplierBase):
    name: str | None = None

class SupplierResponse(SupplierBase):
    id: int
    created_at: datetime
    updated_at: datetime | None = None


class IngredientBase(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str
    sku: str | None = None
    unit: str
    purchase_unit: str | None = None
    conversion_factor: float = 1.0
    current_stock: float = 0.0
    minimum_stock: float = 0.0
    reorder_quantity: float = 0.0
    last_purchase_price: float = 0.0
    average_cost: float = 0.0
    preferred_supplier_id: int | None = None
    category: str | None = None
    notes: str | None = None
    is_active: bool = True

class IngredientCreate(IngredientBase):
    pass

class IngredientBulkCreate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    ingredients: list[IngredientCreate]

class IngredientUpdate(IngredientBase):
    name: str | None = None
    unit: str | None = None

class IngredientResponse(IngredientBase):
    id: int
    created_at: datetime
    updated_at: datetime | None = None


class RecipeItemBase(BaseModel):
    model_config = ConfigDict(extra="ignore")
    ingredient_id: int
    quantity: float
    unit: str
    notes: str | None = None
    variant_key: str = ""

class RecipeItemCreate(RecipeItemBase):
    product_id: int

class RecipeItemResponse(RecipeItemBase):
    id: int
    product_id: int
    created_at: datetime


class PreparedItemComponentBase(BaseModel):
    model_config = ConfigDict(extra="ignore")
    ingredient_id: int
    quantity: float = Field(gt=0)
    unit: str
    notes: str | None = None


class PreparedItemCreate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str
    sku: str | None = None
    kind: Literal["sauce", "marination"] = "sauce"
    unit: str
    notes: str | None = None
    components: list[PreparedItemComponentBase] = Field(default_factory=list)


class PreparedItemUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str | None = None
    sku: str | None = None
    kind: Literal["sauce", "marination"] | None = None
    unit: str | None = None
    notes: str | None = None
    is_active: bool | None = None
    components: list[PreparedItemComponentBase] | None = None


class PreparedItemBatchCreate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    quantity: float = Field(gt=0)
    reason: str | None = None
    branch_id: int | None = None


class RecipePreparedItemBase(BaseModel):
    model_config = ConfigDict(extra="ignore")
    prepared_item_id: int
    quantity: float = Field(gt=0)
    unit: str
    notes: str | None = None
    variant_key: str = ""


class RecipePreparedItemCreate(RecipePreparedItemBase):
    product_id: int


class PurchaseOrderItemBase(BaseModel):
    model_config = ConfigDict(extra="ignore")
    ingredient_id: int
    quantity_ordered: float
    unit_price: float
    unit: str
    notes: str | None = None

class PurchaseOrderCreate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    supplier_id: int
    expected_delivery: datetime | None = None
    notes: str | None = None
    branch_id: int | None = None
    items: list[PurchaseOrderItemBase]

class PurchaseOrderReceive(BaseModel):
    model_config = ConfigDict(extra="ignore")
    received_date: datetime | None = None

class StockMovementCreate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    ingredient_id: int
    movement_type: Literal["purchase", "sale_deduction", "preparation", "wastage", "adjustment", "stock_take", "transfer"]
    quantity_change: float
    unit_cost: float = 0.0
    reference_id: int | None = None
    reference_type: str | None = None
    reason: str | None = None
    branch_id: int | None = None


class BulkRestockLine(BaseModel):
    model_config = ConfigDict(extra="ignore")
    ingredient_id: int
    quantity: float = Field(gt=0)
    unit_cost: float | None = Field(default=None, ge=0)


class BulkRestockRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    items: list[BulkRestockLine] = Field(min_length=1, max_length=200)
    reason: str | None = None
