from __future__ import annotations
from datetime import datetime
from typing import Literal
from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator
from app.models import UnitOfMeasure


def _clean_optional_text(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = str(value).strip()
    return cleaned or None


def _clean_required_text(value: str) -> str:
    cleaned = str(value or "").strip()
    if not cleaned:
        raise ValueError("This field is required.")
    return cleaned


_UNIT_VALUES = {unit.value for unit in UnitOfMeasure}


def _normalize_unit(value: str) -> str:
    normalized = _clean_required_text(value).lower()
    if normalized not in _UNIT_VALUES:
        raise ValueError(f"Invalid unit '{normalized}'. Allowed: {', '.join(sorted(_UNIT_VALUES))}")
    return normalized

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
    linked_material_ids: list[int] | None = None

    _normalize_name = field_validator("name")(lambda cls, value: _clean_required_text(value))
    _normalize_sku = field_validator("sku")(lambda cls, value: _clean_optional_text(value))
    _normalize_contact_person = field_validator("contact_person")(lambda cls, value: _clean_optional_text(value))
    _normalize_phone = field_validator("phone")(lambda cls, value: _clean_optional_text(value))
    _normalize_email = field_validator("email")(lambda cls, value: _clean_optional_text(value))
    _normalize_address = field_validator("address")(lambda cls, value: _clean_optional_text(value))
    _normalize_notes = field_validator("notes")(lambda cls, value: _clean_optional_text(value))

    @field_validator("linked_material_ids")
    @classmethod
    def validate_linked_material_ids(cls, value: list[int] | None) -> list[int] | None:
        if value is None:
            return None
        normalized: list[int] = []
        seen: set[int] = set()
        for raw in value:
            item_id = int(raw)
            if item_id <= 0 or item_id in seen:
                continue
            seen.add(item_id)
            normalized.append(item_id)
        return normalized

class SupplierCreate(SupplierBase):
    pass

class SupplierUpdate(SupplierBase):
    name: str | None = None

    @field_validator("name")
    @classmethod
    def normalize_optional_name(cls, value: str | None) -> str | None:
        return _clean_optional_text(value)

class SupplierResponse(SupplierBase):
    id: int
    created_at: datetime
    updated_at: datetime | None = None


class IngredientBase(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str
    sku: str | None = None
    unit: str = Field(
        validation_alias=AliasChoices("unit", "unitOfMeasure"),
        serialization_alias="unitOfMeasure",
    )
    purchase_unit: str | None = None
    conversion_factor: float = 1.0
    brand_name: str | None = Field(
        default=None,
        validation_alias=AliasChoices("brand_name", "brandName"),
        serialization_alias="brandName",
    )
    current_stock: float = 0.0
    minimum_stock: float = 0.0
    reorder_quantity: float = 0.0
    last_purchase_price: float = 0.0
    average_cost: float = 0.0
    preferred_supplier_id: int | None = None
    category: str | None = None
    notes: str | None = None
    is_active: bool = True

    _normalize_name = field_validator("name")(lambda cls, value: _clean_required_text(value))
    _normalize_sku = field_validator("sku")(lambda cls, value: _clean_optional_text(value))
    _normalize_unit = field_validator("unit")(lambda cls, value: _normalize_unit(value))
    _normalize_purchase_unit = field_validator("purchase_unit")(lambda cls, value: _clean_optional_text(value))
    _normalize_brand = field_validator("brand_name")(lambda cls, value: _clean_optional_text(value))
    _normalize_category = field_validator("category")(lambda cls, value: _clean_optional_text(value))
    _normalize_notes = field_validator("notes")(lambda cls, value: _clean_optional_text(value))

class IngredientCreate(IngredientBase):
    pass

class IngredientBulkCreate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    ingredients: list[IngredientCreate]

class IngredientUpdate(IngredientBase):
    name: str | None = None
    unit: str | None = None

    @field_validator("name")
    @classmethod
    def normalize_optional_name(cls, value: str | None) -> str | None:
        return _clean_optional_text(value)

    @field_validator("unit")
    @classmethod
    def normalize_optional_unit(cls, value: str | None) -> str | None:
        return _clean_optional_text(value.lower() if isinstance(value, str) else value)

class IngredientResponse(IngredientBase):
    id: int
    created_at: datetime
    updated_at: datetime | None = None


class RecipeItemBase(BaseModel):
    model_config = ConfigDict(extra="ignore")
    ingredient_id: int
    quantity: float
    unit: str = Field(
        validation_alias=AliasChoices("unit", "unitOfMeasure"),
        serialization_alias="unitOfMeasure",
    )
    notes: str | None = None
    variant_key: str = ""

    _normalize_unit = field_validator("unit")(lambda cls, value: _normalize_unit(value))
    _normalize_notes = field_validator("notes")(lambda cls, value: _clean_optional_text(value))
    _normalize_variant_key = field_validator("variant_key")(lambda cls, value: str(value or "").strip())

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

    _normalize_unit = field_validator("unit")(lambda cls, value: _normalize_unit(value))
    _normalize_notes = field_validator("notes")(lambda cls, value: _clean_optional_text(value))


class PreparedItemCreate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str
    sku: str | None = None
    kind: Literal["sauce", "marination"] = "sauce"
    unit: str
    notes: str | None = None
    components: list[PreparedItemComponentBase] = Field(default_factory=list)

    _normalize_name = field_validator("name")(lambda cls, value: _clean_required_text(value))
    _normalize_sku = field_validator("sku")(lambda cls, value: _clean_optional_text(value))
    _normalize_unit = field_validator("unit")(lambda cls, value: _normalize_unit(value))
    _normalize_notes = field_validator("notes")(lambda cls, value: _clean_optional_text(value))


class PreparedItemUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str | None = None
    sku: str | None = None
    kind: Literal["sauce", "marination"] | None = None
    unit: str | None = None
    notes: str | None = None
    is_active: bool | None = None
    components: list[PreparedItemComponentBase] | None = None

    @field_validator("name")
    @classmethod
    def normalize_optional_name(cls, value: str | None) -> str | None:
        return _clean_optional_text(value)

    @field_validator("sku")
    @classmethod
    def normalize_optional_sku(cls, value: str | None) -> str | None:
        return _clean_optional_text(value)

    @field_validator("unit")
    @classmethod
    def normalize_optional_unit(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return _normalize_unit(value)

    @field_validator("notes")
    @classmethod
    def normalize_optional_notes(cls, value: str | None) -> str | None:
        return _clean_optional_text(value)


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

    _normalize_unit = field_validator("unit")(lambda cls, value: _normalize_unit(value))
    _normalize_notes = field_validator("notes")(lambda cls, value: _clean_optional_text(value))
    _normalize_variant_key = field_validator("variant_key")(lambda cls, value: str(value or "").strip())


class RecipePreparedItemCreate(RecipePreparedItemBase):
    product_id: int


class PurchaseOrderItemBase(BaseModel):
    model_config = ConfigDict(extra="ignore")
    ingredient_id: int
    quantity_ordered: float
    unit_price: float
    unit: str = Field(
        validation_alias=AliasChoices("unit", "unitOfMeasure"),
        serialization_alias="unitOfMeasure",
    )
    notes: str | None = None

    _normalize_unit = field_validator("unit")(lambda cls, value: _normalize_unit(value))
    _normalize_notes = field_validator("notes")(lambda cls, value: _clean_optional_text(value))

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
