from flask import Blueprint, request, jsonify
from datetime import datetime
from app.models import db, Product, Inventory, SaleItem, RecipeItem
from app.utils.auth_decorators import token_required, owner_required

products_bp = Blueprint('products', __name__)

def _product_to_dict(product):
    return {
        'id': product.id,
        'sku': product.sku,
        'title': product.title,
        'base_price': float(product.base_price),
        'section': product.section or '',
        'variants': product.variants or [],
        'image_url': product.image_url or '',
        'is_deal': getattr(product, 'is_deal', False),
        'archived_at': product.archived_at.isoformat() if getattr(product, 'archived_at', None) else None,
    }

@products_bp.route('/', methods=['GET'])
@token_required
def get_products(current_user):
    include_archived = request.args.get('include_archived', '').lower() in ('1', 'true', 'yes')
    query = Product.query
    if not include_archived:
        query = query.filter(Product.archived_at == None)
    products = query.all()
    output = [_product_to_dict(p) for p in products]
    return jsonify({'products': output}), 200

def _parse_product_payload(data):
    """Validate and normalize payload for create/update. Returns (error_response, parsed_dict)."""
    if not data:
        return (jsonify({"message": "Missing required fields"}), 400), None
    for k in ("sku", "title", "base_price"):
        if k not in data:
            return (jsonify({"message": "Missing required fields"}), 400), None
    try:
        base_price = float(data['base_price'])
    except (TypeError, ValueError):
        return (jsonify({"message": "Base price must be a number"}), 400), None
    if base_price != base_price:  # NaN
        return (jsonify({"message": "Base price must be a number"}), 400), None
    if base_price < 0:
        return (jsonify({"message": "Base price cannot be negative"}), 400), None
    variants = data.get('variants')
    if variants is not None and not isinstance(variants, list):
        variants = []
    parsed = {
        'sku': (data['sku'] or '').strip(),
        'title': (data['title'] or '').strip(),
        'base_price': base_price,
        'section': (data.get('section') or '').strip() if data.get('section') is not None else '',
        'variants': variants if isinstance(variants, list) else [],
        'image_url': (data.get('image_url') or '').strip() or '',
    }
    if not parsed['sku'] or not parsed['title']:
        return (jsonify({"message": "SKU and title are required"}), 400), None
    return None, parsed


@products_bp.route('/', methods=['POST'])
@token_required
@owner_required
def create_product(current_user):
    data = request.get_json()
    err_resp, parsed = _parse_product_payload(data)
    if err_resp:
        return err_resp

    if Product.query.filter_by(sku=parsed['sku']).first():
        return jsonify({"message": "Product with this SKU already exists"}), 409

    try:
        new_product = Product(
            sku=parsed['sku'],
            title=parsed['title'],
            base_price=parsed['base_price'],
            section=parsed['section'],
            variants=parsed['variants'],
            image_url=parsed['image_url'],
        )
        db.session.add(new_product)
        db.session.commit()
        return jsonify({'message': 'Product created!', 'id': new_product.id}), 201
    except Exception as e:
        db.session.rollback()
        return jsonify({
            "message": "Error creating product",
            "error": str(e),
        }), 500

@products_bp.route('/<int:product_id>', methods=['PUT'])
@token_required
@owner_required
def update_product(current_user, product_id):
    product = Product.query.get_or_404(product_id)
    data = request.get_json() or {}

    if 'sku' in data and data['sku'] != product.sku:
        if Product.query.filter_by(sku=data['sku']).first():
            return jsonify({"message": "Product with this SKU already exists"}), 409
        product.sku = data['sku']

    if 'title' in data:
        product.title = data['title']
    if 'base_price' in data:
        try:
            bp = float(data['base_price'])
            if bp != bp or bp < 0:
                return jsonify({"message": "Base price must be a non-negative number"}), 400
            product.base_price = bp
        except (TypeError, ValueError):
            return jsonify({"message": "Base price must be a number"}), 400
    if 'section' in data:
        product.section = data['section']
    if 'variants' in data:
        product.variants = data['variants']
    if 'image_url' in data:
        product.image_url = data['image_url'] or ''

    try:
        db.session.commit()
        return jsonify({'message': 'Product updated!'}), 200
    except Exception as e:
        db.session.rollback()
        return jsonify({"message": "Error updating product", "error": str(e)}), 500

@products_bp.route('/<int:product_id>/archive', methods=['PATCH'])
@token_required
@owner_required
def archive_product(current_user, product_id):
    product = Product.query.get_or_404(product_id)
    try:
        product.archived_at = datetime.utcnow()
        db.session.commit()
        return jsonify({'message': 'Product archived', 'archived_at': product.archived_at.isoformat()}), 200
    except Exception as e:
        db.session.rollback()
        return jsonify({"message": "Error archiving product", "error": str(e)}), 500

@products_bp.route('/<int:product_id>/unarchive', methods=['PATCH'])
@token_required
@owner_required
def unarchive_product(current_user, product_id):
    product = Product.query.get_or_404(product_id)
    try:
        product.archived_at = None
        db.session.commit()
        return jsonify({'message': 'Product restored'}), 200
    except Exception as e:
        db.session.rollback()
        return jsonify({"message": "Error restoring product", "error": str(e)}), 500

@products_bp.route('/<int:product_id>', methods=['DELETE'])
@token_required
@owner_required
def delete_product(current_user, product_id):
    """Permanent delete: removes product, all inventory records; sale line items are kept with product_id=null."""
    product = Product.query.get_or_404(product_id)
    inv_count = Inventory.query.filter_by(product_id=product_id).count()
    sale_items_count = SaleItem.query.filter_by(product_id=product_id).count()
    try:
        SaleItem.query.filter_by(product_id=product_id).update({'product_id': None}, synchronize_session=False)
        Inventory.query.filter_by(product_id=product_id).delete()
        RecipeItem.query.filter_by(product_id=product_id).delete()
        db.session.delete(product)
        db.session.commit()
        return jsonify({
            'message': 'Product permanently deleted.',
            'related_deleted': {'inventory_rows': inv_count},
            'related_kept': {'sale_items_cleared': sale_items_count}
        }), 200
    except Exception as e:
        db.session.rollback()
        return jsonify({"message": "Error deleting product", "error": str(e)}), 500
