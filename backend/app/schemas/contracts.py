from __future__ import annotations

from typing import Any, Literal

from pydantic import AliasChoices, BaseModel, ConfigDict, Field


class ErrorEnvelope(BaseModel):
    error: str | None = None
    message: str
    details: Any | None = None


class LoginRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    username: str
    password: str


class SetupRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    username: str
    password: str
    branch_name: str = Field(validation_alias=AliasChoices("branch_name", "branchName"))
    branch_address: str | None = Field(default="", validation_alias=AliasChoices("branch_address", "branchAddress"))
    branch_phone: str | None = Field(default="", validation_alias=AliasChoices("branch_phone", "branchPhone"))


class CheckoutItem(BaseModel):
    model_config = ConfigDict(extra="ignore")
    product_id: int
    quantity: int
    modifier_ids: list[int] = Field(default_factory=list)


class DiscountPayload(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str | None = None
    name: str | None = None
    type: Literal["percent", "fixed"] | None = None
    value: float | int | None = 0


class OrderSnapshotPayload(BaseModel):
    """Dine-in: table_name. Delivery: customer_name, phone, address."""

    model_config = ConfigDict(extra="ignore")
    table_name: str | None = None
    customer_name: str | None = None
    phone: str | None = None
    address: str | None = None


class CheckoutRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    items: list[CheckoutItem]
    payment_method: str
    branch_id: int | None = None
    discount: DiscountPayload | None = None
    order_type: str | None = None
    order_snapshot: OrderSnapshotPayload | None = None
    notes: str | None = None
