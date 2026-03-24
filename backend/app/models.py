from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import CheckConstraint
from datetime import datetime

db = SQLAlchemy()

class Branch(db.Model):
    __tablename__ = 'branches'
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(255), nullable=False)
    address = db.Column(db.Text)
    phone = db.Column(db.String(50))
    created_at = db.Column(db.DateTime(timezone=True), default=datetime.utcnow)
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
    created_at = db.Column(db.DateTime(timezone=True), default=datetime.utcnow)
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
    created_at = db.Column(db.DateTime(timezone=True), default=datetime.utcnow)
    archived_at = db.Column(db.DateTime(timezone=True), nullable=True)

    inventory = db.relationship('Inventory', backref='product', lazy=True)
    sale_items = db.relationship('SaleItem', backref='product', lazy=True)

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
    created_at = db.Column(db.DateTime(timezone=True), default=datetime.utcnow)


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
    created_at = db.Column(db.DateTime(timezone=True), default=datetime.utcnow)
    status = db.Column(db.String(20), default='completed') # completed, refunded
    discount_amount = db.Column(db.Numeric(12, 2), nullable=True, default=0)
    discount_id = db.Column(db.String(64), nullable=True)
    discount_snapshot = db.Column(db.JSON, nullable=True)  # { name, type, value } for receipt/audit
    archived_at = db.Column(db.DateTime(timezone=True), nullable=True)
    order_type = db.Column(db.String(20), nullable=True)  # takeaway, dine_in, delivery
    order_snapshot = db.Column(db.JSON, nullable=True)  # dine_in: { table_name }; delivery: { customer_name, phone, address }

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
