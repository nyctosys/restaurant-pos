import sys

with open('backend/app/models.py', 'r') as f:
    lines = f.readlines()

# Find the start of the inserted code
start_idx = len(lines)
for i, line in enumerate(lines):
    if "# ADD THESE MODELS" in line:
        start_idx = i - 1
        break

new_content = "".join(lines[:start_idx]) + """
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
    contact_person = db.Column(db.String(200))
    phone = db.Column(db.String(50))
    email = db.Column(db.String(200))
    address = db.Column(db.Text)
    notes = db.Column(db.Text)
    is_active = db.Column(db.Boolean, default=True)
    created_at = db.Column(db.DateTime(timezone=True), default=datetime.utcnow)
    updated_at = db.Column(db.DateTime(timezone=True), onupdate=datetime.utcnow)

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
    created_at = db.Column(db.DateTime(timezone=True), default=datetime.utcnow)
    updated_at = db.Column(db.DateTime(timezone=True), onupdate=datetime.utcnow)

    preferred_supplier = db.relationship("Supplier", back_populates="ingredients")
    recipe_items = db.relationship("RecipeItem", back_populates="ingredient")
    stock_movements = db.relationship("StockMovement", back_populates="ingredient")
    purchase_order_items = db.relationship("PurchaseOrderItem", back_populates="ingredient")
    stock_take_items = db.relationship("StockTakeItem", back_populates="ingredient")


# --- Recipe / Bill of Materials ---

class RecipeItem(db.Model):
    __tablename__ = "recipe_items"

    id = db.Column(db.Integer, primary_key=True)
    product_id = db.Column(db.Integer, db.ForeignKey("products.id"), nullable=False)
    ingredient_id = db.Column(db.Integer, db.ForeignKey("ingredients.id"), nullable=False)
    quantity = db.Column(db.Float, nullable=False)   # Per 1 unit of product sold
    unit = db.Column(db.Enum(UnitOfMeasure), nullable=False)
    notes = db.Column(db.String(500))
    created_at = db.Column(db.DateTime(timezone=True), default=datetime.utcnow)

    product = db.relationship("Product", back_populates="recipe_items")
    ingredient = db.relationship("Ingredient", back_populates="recipe_items")


# --- Purchase Order ---

class PurchaseOrder(db.Model):
    __tablename__ = "purchase_orders"

    id = db.Column(db.Integer, primary_key=True)
    po_number = db.Column(db.String(100), unique=True)
    supplier_id = db.Column(db.Integer, db.ForeignKey("suppliers.id"), nullable=False)
    status = db.Column(db.Enum(PurchaseOrderStatus), default=PurchaseOrderStatus.DRAFT)
    order_date = db.Column(db.DateTime(timezone=True), default=datetime.utcnow)
    expected_delivery = db.Column(db.DateTime(timezone=True), nullable=True)
    received_date = db.Column(db.DateTime(timezone=True), nullable=True)
    notes = db.Column(db.Text)
    total_amount = db.Column(db.Float, default=0.0)
    created_by = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True)
    branch_id = db.Column(db.Integer, db.ForeignKey("branches.id"), nullable=True)
    created_at = db.Column(db.DateTime(timezone=True), default=datetime.utcnow)
    updated_at = db.Column(db.DateTime(timezone=True), onupdate=datetime.utcnow)

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
    created_at = db.Column(db.DateTime(timezone=True), default=datetime.utcnow)

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
    created_at = db.Column(db.DateTime(timezone=True), default=datetime.utcnow)

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
"""

with open('backend/app/models.py', 'w') as f:
    f.write(new_content)
