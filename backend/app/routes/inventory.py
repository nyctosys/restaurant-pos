from datetime import datetime, timedelta, time as dt_time
from flask import Blueprint, request, jsonify
from app.models import db, Inventory, InventoryTransaction, Product
from app.utils.auth_decorators import token_required, owner_required

inventory_bp = Blueprint('inventory', __name__)


def _stock_transactions_time_range(time_filter, start_date_str, end_date_str):
    """Return (start_dt, end_dt) in UTC for stock transaction reporting."""
    now = datetime.utcnow()
    tz_offset = timedelta(hours=5)
    local_now = now + tz_offset
    start_dt = end_dt = None
    if time_filter == 'today':
        start_dt = datetime.combine(local_now.date(), dt_time.min) - tz_offset
        end_dt = datetime.combine(local_now.date(), dt_time.max) - tz_offset
    elif time_filter == 'week':
        start_of_week = local_now - timedelta(days=local_now.weekday())
        start_dt = datetime.combine(start_of_week.date(), dt_time.min) - tz_offset
        end_dt = datetime.combine(local_now.date(), dt_time.max) - tz_offset
    elif time_filter == 'month':
        start_of_month = local_now.replace(day=1)
        start_dt = datetime.combine(start_of_month.date(), dt_time.min) - tz_offset
        end_dt = datetime.combine(local_now.date(), dt_time.max) - tz_offset
    elif time_filter == 'year':
        start_of_year = local_now.replace(month=1, day=1)
        start_dt = datetime.combine(start_of_year.date(), dt_time.min) - tz_offset
        end_dt = datetime.combine(local_now.date(), dt_time.max) - tz_offset
    elif time_filter == 'custom' and start_date_str and end_date_str:
        try:
            start_local = datetime.strptime(start_date_str, "%Y-%m-%d")
            end_local = datetime.strptime(end_date_str, "%Y-%m-%d")
            start_dt = datetime.combine(start_local.date(), dt_time.min) - tz_offset
            end_dt = datetime.combine(end_local.date(), dt_time.max) - tz_offset
        except ValueError:
            pass
    return start_dt, end_dt

@inventory_bp.route('/', methods=['GET'])
@token_required
def get_inventory(current_user):
    branch_id = request.args.get('branch_id', type=int)
    
    # Security: Non-owners are hard-locked to their branch
    if current_user.role != 'owner':
        branch_id = current_user.branch_id
    elif not branch_id:
        # For owners, if no branch specified, default to their assigned branch or first available
        branch_id = current_user.branch_id or 1
        
    records = Inventory.query.filter_by(branch_id=branch_id).all()
    # Group by product_id
    stock_map = {}
    for r in records:
        if r.product_id not in stock_map:
            stock_map[r.product_id] = {}
        stock_map[r.product_id][r.variant_sku_suffix] = r.stock_level
        
    return jsonify({"inventory": stock_map}), 200

@inventory_bp.route('/update', methods=['POST'])
@token_required
def update_inventory(current_user):
    data = request.get_json()
    branch_id = data.get('branch_id')
    
    # Security: Non-owners cannot update other branches
    if current_user.role != 'owner':
        branch_id = current_user.branch_id
    elif not branch_id:
        branch_id = current_user.branch_id or 1
        
    product_id = data.get('product_id')
    variant_sku_suffix = data.get('variant_sku_suffix', '') # Empty string means no variant
    stock_delta = data.get('stock_delta', 0)
    
    if not product_id:
        return jsonify({"message": "product_id required"}), 400
        
    record = Inventory.query.filter_by(
        branch_id=branch_id, 
        product_id=product_id, 
        variant_sku_suffix=variant_sku_suffix
    ).first()
    
    if not record:
        record = Inventory(
            branch_id=branch_id,
            product_id=product_id,
            variant_sku_suffix=variant_sku_suffix,
            stock_level=0
        )
        db.session.add(record)
        
    record.stock_level += stock_delta

    tx = InventoryTransaction(
        branch_id=branch_id,
        product_id=product_id,
        variant_sku_suffix=variant_sku_suffix,
        delta=stock_delta,
        reason='adjustment',
        user_id=current_user.id,
        reference_type=None,
        reference_id=None,
    )
    db.session.add(tx)

    try:
        db.session.commit()
        return jsonify({"message": "Stock updated", "stock_level": record.stock_level}), 200
    except Exception as e:
        db.session.rollback()
        return jsonify({"message": "Error updating stock", "error": str(e)}), 500


@inventory_bp.route('/transactions', methods=['GET'])
@token_required
def get_stock_transactions(current_user):
    """List stock movements for reporting (day/week/month/year/custom)."""
    time_filter = request.args.get('time_filter', 'today')
    start_date = request.args.get('start_date')
    end_date = request.args.get('end_date')
    branch_id = request.args.get('branch_id', type=int)

    if current_user.role != 'owner':
        branch_id = current_user.branch_id
    elif not branch_id:
        branch_id = current_user.branch_id or 1

    start_dt, end_dt = _stock_transactions_time_range(time_filter, start_date, end_date)
    query = InventoryTransaction.query.filter_by(branch_id=branch_id)
    if start_dt and end_dt:
        query = query.filter(
            InventoryTransaction.created_at >= start_dt,
            InventoryTransaction.created_at <= end_dt,
        )
    transactions = query.order_by(InventoryTransaction.created_at.desc()).limit(500).all()

    product_ids = {t.product_id for t in transactions}
    products = {p.id: p for p in Product.query.filter(Product.id.in_(product_ids)).all()} if product_ids else {}

    out = []
    for t in transactions:
        p = products.get(t.product_id)
        out.append({
            'id': t.id,
            'product_id': t.product_id,
            'product_title': p.title if p else None,
            'variant_sku_suffix': t.variant_sku_suffix or '',
            'delta': t.delta,
            'reason': t.reason,
            'reference_type': t.reference_type,
            'reference_id': t.reference_id,
            'created_at': t.created_at.isoformat(),
        })
    return jsonify({'transactions': out}), 200
