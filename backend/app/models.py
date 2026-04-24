from sqlalchemy import CheckConstraint
from datetime import datetime, timezone

from app.db import db


def utc_now() -> datetime:
    return datetime.now(timezone.utc)

class Branch(db.Model):
    __tablename__ = 'branches'
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(255), nullable=False)
    address = db.Column(db.Text)
    phone = db.Column(db.String(50))
    created_at = db.Column(db.DateTime(timezone=True), default=utc_now)
    archived_at = db.Column(db.DateTime(timezone=True), nullable=True)

    users = db.relationship('User', backref='branch', lazy=True)
    inventory = db.relationship('Inventory', backref='branch', lazy=True)
    sales = db.relationship('Sale', backref='branch', lazy=True)
    settings = db.relationship('Setting', backref='branch', uselist=False)

class User(db.Model):
    __tablename__ = 'users'
    id = db.Column(db.Integer, primary_key=True)
    branch_id = db.Column(db.Integer, db.ForeignKey('branches.id'), nullable=True) # Null for Global Owner
    username = db.Column(db.String(100), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    pin_hash = db.Column(db.String(255))
    role = db.Column(db.String(50), default='cashier')  # owner, manager, cashier, inventory_manager, kitchen, ...
    created_at = db.Column(db.DateTime(timezone=True), default=utc_now)
    archived_at = db.Column(db.DateTime(timezone=True), nullable=True)

    sales = db.relationship('Sale', backref='user', lazy=True)

class Setting(db.Model):
    __tablename__ = 'settings'
    id = db.Column(db.Integer, primary_key=True)
    branch_id = db.Column(db.Integer, db.ForeignKey('branches.id'), unique=True, nullable=True) # Null for global
    config = db.Column(db.JSON, nullable=False, default={})

class Product(db.Model):
    __tablename__ = 'products'
    __table_args__ = (CheckConstraint('base_price >= 0', name='ck_product_base_price_non_neg'),)
    id = db.Column(db.Integer, primary_key=True)
    sku = db.Column(db.String(100), unique=True, nullable=False)
    title = db.Column(db.String(255), nullable=False)
    base_price = db.Column(db.Numeric(12, 2), nullable=False)
    section = db.Column(db.String(100), nullable=True, default='')
    variants = db.Column(db.JSON, nullable=False, default=[])
    image_url = db.Column(db.Text, nullable=True, default='')  # URL or data URL for product image (base64 can be large)
    created_at = db.Column(db.DateTime(timezone=True), default=utc_now)
    archived_at = db.Column(db.DateTime(timezone=True), nullable=True)
    is_deal = db.Column(db.Boolean, default=False)
    unit = db.Column(db.String(50), nullable=True)

    inventory = db.relationship('Inventory', backref='product', lazy=True)
    sale_items = db.relationship('SaleItem', backref='product', lazy=True)
    recipe_items = db.relationship('RecipeItem', back_populates='product', cascade="all, delete-orphan")
    combo_items = db.relationship('ComboItem', back_populates='combo', foreign_keys='ComboItem.combo_id', cascade="all, delete-orphan")

class Modifier(db.Model):
    __tablename__ = 'modifiers'
    __table_args__ = (
        CheckConstraint('price >= 0', name='ck_modifier_price_non_neg'),
    )

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(255), unique=True, nullable=False)
    price = db.Column(db.Numeric(12, 2), nullable=True, default=0)
    created_at = db.Column(db.DateTime(timezone=True), default=utc_now)
    archived_at = db.Column(db.DateTime(timezone=True), nullable=True)
    # Optional BOM link: when set, selling this modifier deducts ingredient at this branch.
    ingredient_id = db.Column(db.Integer, db.ForeignKey('ingredients.id'), nullable=True)
    depletion_quantity = db.Column(db.Float, nullable=True)

    ingredient = db.relationship('Ingredient', foreign_keys=[ingredient_id], lazy=True)

class ComboItem(db.Model):
    __tablename__ = 'combo_items'
    id = db.Column(db.Integer, primary_key=True)
    combo_id = db.Column(db.Integer, db.ForeignKey('products.id'), nullable=False)
    product_id = db.Column(db.Integer, db.ForeignKey('products.id'), nullable=False)
    quantity = db.Column(db.Integer, nullable=False, default=1)
    # When set, this line applies only to deal lines sold with this variant label (empty = base / all).
    variant_key = db.Column(db.String(100), nullable=False, default='')

    combo = db.relationship('Product', foreign_keys=[combo_id], back_populates='combo_items')
    child_product = db.relationship('Product', foreign_keys=[product_id])

class Inventory(db.Model):
    __tablename__ = 'inventory'
    id = db.Column(db.Integer, primary_key=True)
    branch_id = db.Column(db.Integer, db.ForeignKey('branches.id'), nullable=False)
    product_id = db.Column(db.Integer, db.ForeignKey('products.id'), nullable=False)
    variant_sku_suffix = db.Column(db.String(50), default='')
    stock_level = db.Column(db.Integer, default=0)

    __table_args__ = (
        db.UniqueConstraint('branch_id', 'product_id', 'variant_sku_suffix', name='_branch_product_variant_uc'),
        CheckConstraint('stock_level >= 0', name='ck_inventory_stock_non_neg'),
    )


class InventoryTransaction(db.Model):
    """Ledger of stock level changes for reporting (day/week/month/year/custom)."""
    __tablename__ = 'inventory_transactions'
    id = db.Column(db.Integer, primary_key=True)
    branch_id = db.Column(db.Integer, db.ForeignKey('branches.id'), nullable=False)
    product_id = db.Column(db.Integer, db.ForeignKey('products.id'), nullable=False)
    variant_sku_suffix = db.Column(db.String(50), default='')
    delta = db.Column(db.Integer, nullable=False)  # positive = in, negative = out
    reason = db.Column(db.String(32), nullable=False)  # 'adjustment', 'sale', 'refund'
    user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=True)
    reference_type = db.Column(db.String(32), nullable=True)  # 'sale', 'sale_refund', or None
    reference_id = db.Column(db.Integer, nullable=True)  # e.g. sale_id
    created_at = db.Column(db.DateTime(timezone=True), default=utc_now)


class Sale(db.Model):
    __tablename__ = 'sales'
    __table_args__ = (
        CheckConstraint('total_amount >= 0', name='ck_sale_total_non_neg'),
        CheckConstraint('tax_amount >= 0', name='ck_sale_tax_non_neg'),
        CheckConstraint("status IN ('completed', 'refunded', 'open')", name='ck_sale_status_valid'),
    )
    id = db.Column(db.Integer, primary_key=True)
    branch_id = db.Column(db.Integer, db.ForeignKey('branches.id'), nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    total_amount = db.Column(db.Numeric(12, 2), nullable=False)
    tax_amount = db.Column(db.Numeric(12, 2), nullable=False)
    payment_method = db.Column(db.String(50)) # cash, card
    created_at = db.Column(db.DateTime(timezone=True), default=utc_now)
    status = db.Column(db.String(20), default='completed') # completed, refunded
    discount_amount = db.Column(db.Numeric(12, 2), nullable=True, default=0)
    discount_id = db.Column(db.String(64), nullable=True)
    discount_snapshot = db.Column(db.JSON, nullable=True)  # { name, type, value } for receipt/audit
    delivery_charge = db.Column(db.Numeric(12, 2), nullable=True, default=0)
    service_charge = db.Column(db.Numeric(12, 2), nullable=True, default=0)
    archived_at = db.Column(db.DateTime(timezone=True), nullable=True)
    order_type = db.Column(db.String(20), nullable=True)  # takeaway, dine_in, delivery
    order_snapshot = db.Column(db.JSON, nullable=True)  # dine_in: { table_name }; delivery: { customer_name, phone, address }
    # Kitchen display workflow (open dine-in / KOT tickets)
    kitchen_status = db.Column(db.String(20), nullable=True)  # placed | preparing | ready
    kitchen_ready_at = db.Column(db.DateTime(timezone=True), nullable=True)  # set when status → ready; KDS drops after 24h

    items = db.relationship('SaleItem', backref='sale', lazy=True, cascade="all, delete-orphan")

class SaleItem(db.Model):
    __tablename__ = 'sale_items'
    __table_args__ = (
        CheckConstraint('quantity > 0', name='ck_sale_item_quantity_positive'),
        CheckConstraint('unit_price >= 0', name='ck_sale_item_unit_price_non_neg'),
        CheckConstraint('subtotal >= 0', name='ck_sale_item_subtotal_non_neg'),
    )
    id = db.Column(db.Integer, primary_key=True)
    sale_id = db.Column(db.Integer, db.ForeignKey('sales.id', ondelete='CASCADE'), nullable=False)
    product_id = db.Column(db.Integer, db.ForeignKey('products.id'), nullable=True)  # NULL when product deleted
    variant_sku_suffix = db.Column(db.String(50), default='')
    quantity = db.Column(db.Integer, nullable=False)
    unit_price = db.Column(db.Numeric(12, 2), nullable=False)
    subtotal = db.Column(db.Numeric(12, 2), nullable=False)
    modifiers = db.Column(db.JSON, nullable=True, default=None)  # e.g. [{"ingredient_id": 1, "name": "Cheese Slice", "qty": 1}]
    parent_sale_item_id = db.Column(db.Integer, db.ForeignKey('sale_items.id'), nullable=True)  # For deal child items
    inventory_allocations = db.Column(db.JSON, nullable=True, default=None)  # ingredient deduction audit trail for void/restore

    children = db.relationship('SaleItem', backref=db.backref('parent', remote_side='SaleItem.id'), lazy=True)

    

    # ============================================================
# ADDED INVENTORY MODELS
# ============================================================

import enum

# --- Enums ---

class PurchaseOrderStatus(str, enum.Enum):
    DRAFT = "draft"
    SENT = "sent"
    PARTIALLY_RECEIVED = "partially_received"
    RECEIVED = "received"
    CANCELLED = "cancelled"


class StockMovementType(str, enum.Enum):
    PURCHASE = "purchase"
    SALE_DEDUCTION = "sale_deduction"
    WASTAGE = "wastage"
    ADJUSTMENT = "adjustment"
    STOCK_TAKE = "stock_take"
    TRANSFER = "transfer"


class UnitOfMeasure(str, enum.Enum):
    KG = "kg"
    G = "g"
    L = "l"
    ML = "ml"
    PIECE = "piece"
    DOZEN = "dozen"
    PACK = "pack"
    CAN = "can"
    BOTTLE = "bottle"


# --- Supplier ---

class Supplier(db.Model):
    __tablename__ = "suppliers"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(200), nullable=False)
    sku = db.Column(db.String(100), unique=True)
    contact_person = db.Column(db.String(200))
    phone = db.Column(db.String(50))
    email = db.Column(db.String(200))
    address = db.Column(db.Text)
    notes = db.Column(db.Text)
    is_active = db.Column(db.Boolean, default=True)
    created_at = db.Column(db.DateTime(timezone=True), default=utc_now)
    updated_at = db.Column(db.DateTime(timezone=True), onupdate=utc_now)

    ingredients = db.relationship("Ingredient", back_populates="preferred_supplier")
    purchase_orders = db.relationship("PurchaseOrder", back_populates="supplier")


# --- Ingredient (Raw Material) ---

class Ingredient(db.Model):
    __tablename__ = "ingredients"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(200), nullable=False)
    sku = db.Column(db.String(100), unique=True)
    unit = db.Column(db.Enum(UnitOfMeasure), nullable=False, default=UnitOfMeasure.KG)
    current_stock = db.Column(db.Float, default=0.0)
    minimum_stock = db.Column(db.Float, default=0.0)   # Low-stock threshold
    reorder_quantity = db.Column(db.Float, default=0.0)
    last_purchase_price = db.Column(db.Float, default=0.0)
    average_cost = db.Column(db.Float, default=0.0)    # Moving average
    preferred_supplier_id = db.Column(db.Integer, db.ForeignKey("suppliers.id"), nullable=True)
    category = db.Column(db.String(100))
    notes = db.Column(db.Text)
    is_active = db.Column(db.Boolean, default=True)
    created_at = db.Column(db.DateTime(timezone=True), default=utc_now)
    updated_at = db.Column(db.DateTime(timezone=True), onupdate=utc_now)

    preferred_supplier = db.relationship("Supplier", back_populates="ingredients")
    recipe_items = db.relationship("RecipeItem", back_populates="ingredient")
    stock_movements = db.relationship("StockMovement", back_populates="ingredient")
    purchase_order_items = db.relationship("PurchaseOrderItem", back_populates="ingredient")
    stock_take_items = db.relationship("StockTakeItem", back_populates="ingredient")
    branch_stocks = db.relationship(
        "IngredientBranchStock", back_populates="ingredient", cascade="all, delete-orphan"
    )


class IngredientBranchStock(db.Model):
    """Per-branch on-hand quantity for a raw ingredient (restaurant inventory truth)."""

    __tablename__ = "ingredient_branch_stocks"
    __table_args__ = (
        db.UniqueConstraint("ingredient_id", "branch_id", name="uq_ingredient_branch_stock"),
        CheckConstraint("current_stock >= 0", name="ck_ingredient_branch_stock_nonneg"),
    )

    id = db.Column(db.Integer, primary_key=True)
    ingredient_id = db.Column(db.Integer, db.ForeignKey("ingredients.id"), nullable=False)
    branch_id = db.Column(db.Integer, db.ForeignKey("branches.id"), nullable=False)
    current_stock = db.Column(db.Float, nullable=False, default=0.0)

    ingredient = db.relationship("Ingredient", back_populates="branch_stocks")
    branch = db.relationship("Branch", lazy=True)


# --- Recipe / Bill of Materials ---

class RecipeItem(db.Model):
    __tablename__ = "recipe_items"

    id = db.Column(db.Integer, primary_key=True)
    product_id = db.Column(db.Integer, db.ForeignKey("products.id"), nullable=False)
    ingredient_id = db.Column(db.Integer, db.ForeignKey("ingredients.id"), nullable=False)
    quantity = db.Column(db.Float, nullable=False)   # Per 1 unit of product sold
    unit = db.Column(db.Enum(UnitOfMeasure), nullable=False)
    notes = db.Column(db.String(500))
    # Empty = base BOM for the product; non-empty = BOM for that menu variant label (matches SaleItem.variant_sku_suffix)
    variant_key = db.Column(db.String(100), nullable=False, default="")
    created_at = db.Column(db.DateTime(timezone=True), default=utc_now)

    product = db.relationship("Product", back_populates="recipe_items")
    ingredient = db.relationship("Ingredient", back_populates="recipe_items")


# --- Purchase Order ---

class PurchaseOrder(db.Model):
    __tablename__ = "purchase_orders"

    id = db.Column(db.Integer, primary_key=True)
    po_number = db.Column(db.String(100), unique=True)
    supplier_id = db.Column(db.Integer, db.ForeignKey("suppliers.id"), nullable=False)
    status = db.Column(db.Enum(PurchaseOrderStatus), default=PurchaseOrderStatus.DRAFT)
    order_date = db.Column(db.DateTime(timezone=True), default=utc_now)
    expected_delivery = db.Column(db.DateTime(timezone=True), nullable=True)
    received_date = db.Column(db.DateTime(timezone=True), nullable=True)
    notes = db.Column(db.Text)
    total_amount = db.Column(db.Float, default=0.0)
    created_by = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True)
    branch_id = db.Column(db.Integer, db.ForeignKey("branches.id"), nullable=True)
    created_at = db.Column(db.DateTime(timezone=True), default=utc_now)
    updated_at = db.Column(db.DateTime(timezone=True), onupdate=utc_now)

    supplier = db.relationship("Supplier", back_populates="purchase_orders")
    items = db.relationship("PurchaseOrderItem", back_populates="purchase_order", cascade="all, delete-orphan")


class PurchaseOrderItem(db.Model):
    __tablename__ = "purchase_order_items"

    id = db.Column(db.Integer, primary_key=True)
    purchase_order_id = db.Column(db.Integer, db.ForeignKey("purchase_orders.id"), nullable=False)
    ingredient_id = db.Column(db.Integer, db.ForeignKey("ingredients.id"), nullable=False)
    quantity_ordered = db.Column(db.Float, nullable=False)
    quantity_received = db.Column(db.Float, default=0.0)
    unit_price = db.Column(db.Float, default=0.0)
    unit = db.Column(db.Enum(UnitOfMeasure), nullable=False)
    notes = db.Column(db.String(500))

    purchase_order = db.relationship("PurchaseOrder", back_populates="items")
    ingredient = db.relationship("Ingredient", back_populates="purchase_order_items")


# --- Stock Movement Ledger ---

class StockMovement(db.Model):
    __tablename__ = "stock_movements"

    id = db.Column(db.Integer, primary_key=True)
    ingredient_id = db.Column(db.Integer, db.ForeignKey("ingredients.id"), nullable=False)
    movement_type = db.Column(db.Enum(StockMovementType), nullable=False)
    quantity_change = db.Column(db.Float, nullable=False)   # + for in, - for out
    quantity_before = db.Column(db.Float, nullable=False)
    quantity_after = db.Column(db.Float, nullable=False)
    unit_cost = db.Column(db.Float, default=0.0)
    reference_id = db.Column(db.Integer, nullable=True)     # PO id, Sale id, etc.
    reference_type = db.Column(db.String(50), nullable=True)
    reason = db.Column(db.String(500))
    created_by = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True)
    branch_id = db.Column(db.Integer, db.ForeignKey("branches.id"), nullable=True)
    created_at = db.Column(db.DateTime(timezone=True), default=utc_now)

    ingredient = db.relationship("Ingredient", back_populates="stock_movements")


# --- Physical Stock Take ---

class StockTake(db.Model):
    __tablename__ = "stock_takes"

    id = db.Column(db.Integer, primary_key=True)
    reference_number = db.Column(db.String(100), unique=True)
    status = db.Column(db.String(50), default="in_progress")   # in_progress, completed
    notes = db.Column(db.Text)
    created_by = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True)
    branch_id = db.Column(db.Integer, db.ForeignKey("branches.id"), nullable=True)
    completed_at = db.Column(db.DateTime(timezone=True), nullable=True)
    created_at = db.Column(db.DateTime(timezone=True), default=utc_now)

    items = db.relationship("StockTakeItem", back_populates="stock_take", cascade="all, delete-orphan")


class StockTakeItem(db.Model):
    __tablename__ = "stock_take_items"

    id = db.Column(db.Integer, primary_key=True)
    stock_take_id = db.Column(db.Integer, db.ForeignKey("stock_takes.id"), nullable=False)
    ingredient_id = db.Column(db.Integer, db.ForeignKey("ingredients.id"), nullable=False)
    expected_quantity = db.Column(db.Float, nullable=False)
    actual_quantity = db.Column(db.Float, nullable=True)
    discrepancy = db.Column(db.Float, nullable=True)         # actual - expected
    notes = db.Column(db.String(500))

    stock_take = db.relationship("StockTake", back_populates="items")
    ingredient = db.relationship("Ingredient", back_populates="stock_take_items")


class SyncOutbox(db.Model):
    """Durable outbox for branch-scoped mutations (future admin sync worker)."""

    __tablename__ = "sync_outbox"

    id = db.Column(db.Integer, primary_key=True)
    branch_id = db.Column(db.Integer, db.ForeignKey("branches.id"), nullable=False)
    entity_type = db.Column(db.String(64), nullable=False)
    entity_id = db.Column(db.Integer, nullable=True)
    event_type = db.Column(db.String(64), nullable=False)
    payload = db.Column(db.JSON, nullable=False, default=dict)
    occurred_at = db.Column(db.DateTime(timezone=True), default=utc_now)
    sync_status = db.Column(db.String(32), nullable=False, default="pending")
    attempt_count = db.Column(db.Integer, nullable=False, default=0)
    last_error = db.Column(db.Text, nullable=True)
    synced_at = db.Column(db.DateTime(timezone=True), nullable=True)


class AppEventLog(db.Model):
    """Persisted diagnostics for Settings → App Logs (server-side errors and events)."""

    __tablename__ = "app_event_logs"

    id = db.Column(db.Integer, primary_key=True)
    created_at = db.Column(db.DateTime(timezone=True), default=utc_now, index=True)
    severity = db.Column(db.String(16), nullable=False, default="error")  # info | warn | error
    source = db.Column(db.String(32), nullable=False, default="backend")
    category = db.Column(db.String(128), nullable=True)
    message = db.Column(db.Text, nullable=False)
    request_id = db.Column(db.String(128), nullable=True, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True)
    branch_id = db.Column(db.Integer, db.ForeignKey("branches.id"), nullable=True)
    route = db.Column(db.String(1024), nullable=True)
    exc_type = db.Column(db.String(255), nullable=True)
    stack_trace = db.Column(db.Text, nullable=True)
    context_json = db.Column(db.JSON, nullable=True)
