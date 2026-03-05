from flask import Blueprint, request, jsonify
from app.models import db, Inventory, Product
from app.utils.auth_decorators import token_required, owner_required

inventory_bp = Blueprint('inventory', __name__)

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
    
    try:
        db.session.commit()
        return jsonify({"message": "Stock updated", "stock_level": record.stock_level}), 200
    except Exception as e:
        db.session.rollback()
        return jsonify({"message": "Error updating stock", "error": str(e)}), 500
