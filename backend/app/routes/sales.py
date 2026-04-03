from flask import Blueprint, request, jsonify
from sqlalchemy import func
from datetime import datetime, timedelta, time
from app.models import db, Sale, SaleItem, Inventory, InventoryTransaction, Product, Setting, StockMovement
from app.services.recipe_variants import combo_items_for_variant
from app.utils.auth_decorators import token_required, owner_required
from app.errors import error_response
from app.order_metadata import normalize_order_type_and_snapshot

sales_bp = Blueprint('sales', __name__)

@sales_bp.route('/checkout', methods=['POST'])
@token_required
def checkout(current_user):
    data = request.get_json()
    if not data or 'items' not in data or 'payment_method' not in data:
        return error_response("Bad Request", "Missing necessary checkout data", 400)

    _ = data.get('notes')

    items = data['items']
    if not items:
        return error_response("Bad Request", "Cart is empty", 400)
    # Validate each item has product_id and positive quantity before starting transaction
    for idx, item in enumerate(items):
        if not isinstance(item, dict):
            return error_response("Bad Request", f"Item at index {idx} must be an object", 400)
        pid = item.get('product_id')
        if pid is None:
            return error_response("Bad Request", f"Item at index {idx} missing product_id", 400)
        try:
            qty = int(item.get('quantity', 0))
        except (TypeError, ValueError):
            return error_response("Bad Request", f"Item at index {idx} quantity must be a positive integer", 400)
        if qty <= 0:
            return error_response("Bad Request", f"Item at index {idx} quantity must be positive", 400)

    # Ensure this is a branch user (owners might need a branch selected to sell)
    branch_id = data.get('branch_id')
    
    # Security: Non-owners are locked to their own branch
    if current_user.role != 'owner':
        branch_id = current_user.branch_id
    elif not branch_id:
        branch_id = current_user.branch_id or 1

    if not branch_id:
        return error_response("Bad Request", "Branch ID must be provided or linked to the user", 400)

    order_type_norm, order_snapshot_norm, order_err = normalize_order_type_and_snapshot(data)
    if order_err:
        return error_response("Bad Request", order_err, 400)

    total_amount = 0.0
    
    # Fetch tax settings: when tax_enabled is off, no tax; otherwise use rate for this payment method
    setting = Setting.query.filter_by(branch_id=branch_id).first()
    if not setting:
        setting = Setting.query.filter_by(branch_id=None).first()
    
    tax_rate = 0.0
    if setting and setting.config.get('tax_enabled', True):
        rates_by_method = setting.config.get('tax_rates_by_payment_method') or {}
        payment_method = data.get('payment_method') or 'Cash'
        if isinstance(rates_by_method.get(payment_method), (int, float)):
            tax_rate = float(rates_by_method[payment_method]) / 100.0
        elif 'tax_percentage' in (setting.config or {}):
            tax_rate = float(setting.config['tax_percentage']) / 100.0
    
    tax_amount = 0.0
    
    try:
        # Start Transaction (handled implicitly by SQLAlchemy session)
        new_sale = Sale(
            branch_id=branch_id,
            user_id=current_user.id,
            total_amount=0,  # temp
            tax_amount=0,    # temp
            payment_method=data['payment_method'],
            order_type=order_type_norm,
            order_snapshot=order_snapshot_norm,
        )
        db.session.add(new_sale)
        db.session.flush()  # Get Sale ID

        for item in items:
            product = Product.query.get(item['product_id'])
            if product is None:
                db.session.rollback()
                return error_response("Bad Request", f"Product ID {item['product_id']} not found", 400)
            
            def deduct_product(p, qty, item_v_suffix):
                if not p.is_deal:
                    # 1. Deduct finished goods Inventory
                    inventory = Inventory.query.filter_by(
                        branch_id=branch_id, 
                        product_id=p.id,
                        variant_sku_suffix=item_v_suffix
                    ).first()

                    if not inventory or inventory.stock_level < qty:
                        return False, f"Insufficient stock for {p.title}"

                    inventory.stock_level -= qty
                    db.session.add(InventoryTransaction(
                        branch_id=branch_id,
                        product_id=p.id,
                        variant_sku_suffix=item_v_suffix,
                        delta=-qty,
                        reason='sale',
                        user_id=current_user.id,
                        reference_type='sale',
                        reference_id=new_sale.id,
                    ))

                    # 2. Deduct Raw Materials based on recipe_items
                    if hasattr(p, 'recipe_items'):
                        for recipe_item in p.recipe_items:
                            ingredient = recipe_item.ingredient
                            if ingredient:
                                total_ing_qty = recipe_item.quantity * qty
                                if ingredient.current_stock < total_ing_qty:
                                    return False, f"Insufficient raw material: {ingredient.name}"
                                
                                qty_before = ingredient.current_stock
                                qty_after = qty_before - total_ing_qty
                                ingredient.current_stock = qty_after
                                
                                sm = StockMovement(
                                    ingredient_id=ingredient.id,
                                    movement_type='sale',
                                    quantity_change=-total_ing_qty,
                                    quantity_before=qty_before,
                                    quantity_after=qty_after,
                                    unit_cost=ingredient.average_cost,
                                    reference_id=new_sale.id,
                                    reference_type='sale',
                                    reason=f"Sold {qty}x {p.title}",
                                    created_by=current_user.id,
                                    branch_id=branch_id
                                )
                                db.session.add(sm)
                else:
                    # It is a Deal/Combo, recursively deduct child products (variant-scoped combo lines)
                    for combo_item in combo_items_for_variant(p, item_v_suffix):
                        child = combo_item.child_product
                        if child:
                            success, err = deduct_product(child, qty * combo_item.quantity, "")
                            if not success:
                                return False, f"In combo {p.title}: {err}"
                return True, ""

            success, err_msg = deduct_product(product, item['quantity'], item.get('variant_sku_suffix', ''))
            if not success:
                db.session.rollback()
                return error_response("Bad Request", err_msg, 400)

            unit_price = float(product.base_price)  # Ignoring variant pricing delta for now
            subtotal = unit_price * item['quantity']
            total_amount += subtotal

            # Create Sale Item
            sale_item = SaleItem(
                sale_id=new_sale.id,
                product_id=product.id,
                variant_sku_suffix=item.get('variant_sku_suffix', ''),
                quantity=item['quantity'],
                unit_price=unit_price,
                subtotal=subtotal
            )
            db.session.add(sale_item)

        # Apply discount if provided
        discount_amount = 0.0
        discount_id = None
        discount_snapshot = None
        discount_data = data.get('discount')
        if discount_data and isinstance(discount_data, dict):
            d_type = discount_data.get('type')
            d_value = float(discount_data.get('value', 0) or 0)
            if d_type == 'percent' and 0 <= d_value <= 100:
                discount_amount = total_amount * (d_value / 100.0)
            elif d_type == 'fixed' and d_value >= 0:
                discount_amount = min(float(d_value), total_amount)
            if discount_amount > 0:
                discount_id = discount_data.get('id')
                discount_snapshot = {
                    'name': discount_data.get('name') or 'Discount',
                    'type': d_type,
                    'value': d_value
                }

        discounted_subtotal = total_amount - discount_amount
        new_sale.discount_amount = discount_amount
        new_sale.discount_id = discount_id
        new_sale.discount_snapshot = discount_snapshot
        new_sale.tax_amount = discounted_subtotal * tax_rate
        new_sale.total_amount = discounted_subtotal + new_sale.tax_amount

        db.session.commit()
        
        # Trigger Printing Strategy
        from app.services.printer_service import PrinterService
        printer_service = PrinterService()
        
        # Prepare data for receipt
        branch_name = 'Main Branch'
        if branch_id:
            from app.models import Branch
            branch_obj = Branch.query.get(branch_id)
            if branch_obj:
                branch_name = branch_obj.name

        discount_name = None
        if discount_snapshot and isinstance(discount_snapshot, dict):
            discount_name = discount_snapshot.get('name') or 'Discount'

        receipt_items = []
        for i in items:
            product = Product.query.get(i.get('product_id'))
            title = product.title if product else 'Item'
            unit_price = float(product.base_price) if product else 0.0
            receipt_items.append({
                'title': str(title),
                'quantity': int(i.get('quantity', 1)),
                'unit_price': unit_price,
            })
        receipt_data = {
            'total': float(new_sale.total_amount),
            'subtotal': float(total_amount),
            'tax_amount': float(new_sale.tax_amount),
            'tax_rate': float(tax_rate),
            'discount_amount': float(discount_amount),
            'discount_name': discount_name or 'Discount',
            'operator': current_user.username,
            'branch': branch_name,
            'branch_id': branch_id,
            'items': receipt_items,
            'order_type': order_type_norm,
            'order_snapshot': order_snapshot_norm,
        }
        
        # We trigger printing sync for now, in a real app this should be a Celery background task
        print_success = printer_service.print_receipt(receipt_data)
        if not print_success:
            print("[WARNING] Hardware print failed, but transaction succeeded.")

        return jsonify({
            "message": "Checkout successful", 
            "sale_id": new_sale.id,
            "total": float(new_sale.total_amount),
            "print_success": print_success
        }), 201

    except Exception as e:
        db.session.rollback()
        return error_response("Bad Request", f"Checkout failed: {str(e)}", 400)

def get_time_filter_ranges(time_filter, start_date_str, end_date_str):
    now = datetime.utcnow()
    tz_offset = timedelta(hours=5) # Assuming +05:00 based on previous logs, maybe parameterize later if needed
    local_now = now + tz_offset
    
    start_dt = None
    end_dt = None
    
    if time_filter == 'today':
        start_dt = datetime.combine(local_now.date(), time.min) - tz_offset
        end_dt = datetime.combine(local_now.date(), time.max) - tz_offset
    elif time_filter == 'week':
        start_of_week = local_now - timedelta(days=local_now.weekday())
        start_dt = datetime.combine(start_of_week.date(), time.min) - tz_offset
        end_dt = datetime.combine(local_now.date(), time.max) - tz_offset
    elif time_filter == 'month':
        start_of_month = local_now.replace(day=1)
        start_dt = datetime.combine(start_of_month.date(), time.min) - tz_offset
        end_dt = datetime.combine(local_now.date(), time.max) - tz_offset
    elif time_filter == 'year':
        start_of_year = local_now.replace(month=1, day=1)
        start_dt = datetime.combine(start_of_year.date(), time.min) - tz_offset
        end_dt = datetime.combine(local_now.date(), time.max) - tz_offset
    elif time_filter == 'custom' and start_date_str and end_date_str:
        try:
            # Parse YYYY-MM-DD
            start_local = datetime.strptime(start_date_str, "%Y-%m-%d")
            end_local = datetime.strptime(end_date_str, "%Y-%m-%d")
            start_dt = datetime.combine(start_local.date(), time.min) - tz_offset
            end_dt = datetime.combine(end_local.date(), time.max) - tz_offset
        except ValueError:
            pass
            
    return start_dt, end_dt

@sales_bp.route('/', methods=['GET'])
@token_required
def get_sales(current_user):
    time_filter = request.args.get('time_filter', 'today')
    start_date = request.args.get('start_date')
    end_date = request.args.get('end_date')
    branch_id = request.args.get('branch_id')
    include_archived = request.args.get('include_archived', '').lower() in ('1', 'true', 'yes')

    start_dt, end_dt = get_time_filter_ranges(time_filter, start_date, end_date)

    query = Sale.query
    if not include_archived and hasattr(Sale, 'archived_at'):
        query = query.filter(Sale.archived_at == None)

    if current_user.role != 'owner':
        query = query.filter_by(branch_id=current_user.branch_id)
    elif branch_id:
        query = query.filter_by(branch_id=int(branch_id))
    else:
        if current_user.branch_id:
            query = query.filter_by(branch_id=current_user.branch_id)

    if start_dt and end_dt:
        query = query.filter(Sale.created_at >= start_dt, Sale.created_at <= end_dt)

    sales = query.order_by(Sale.created_at.desc()).all()

    output = []
    for sale in sales:
        out = {
            'id': sale.id,
            'branch_id': sale.branch_id,
            'user_id': sale.user_id,
            'total_amount': float(sale.total_amount),
            'created_at': sale.created_at.isoformat(),
            'payment_method': sale.payment_method,
            'status': getattr(sale, 'status', 'completed')
        }
        if hasattr(sale, 'archived_at') and sale.archived_at:
            out['archived_at'] = sale.archived_at.isoformat()
        output.append(out)
    return jsonify({'sales': output}), 200

@sales_bp.route('/analytics', methods=['GET'])
@token_required
def get_analytics(current_user):
    time_filter = request.args.get('time_filter', 'today')
    start_date = request.args.get('start_date')
    end_date = request.args.get('end_date')
    branch_id = request.args.get('branch_id')
    
    start_dt, end_dt = get_time_filter_ranges(time_filter, start_date, end_date)

    query = Sale.query.filter(Sale.status != 'refunded')
    
    if current_user.role != 'owner':
        query = query.filter(Sale.branch_id == current_user.branch_id)
    elif branch_id:
        query = query.filter(Sale.branch_id == int(branch_id))
    else:
        if current_user.branch_id:
             query = query.filter(Sale.branch_id == current_user.branch_id)
        
    if start_dt and end_dt:
        query = query.filter(Sale.created_at >= start_dt, Sale.created_at <= end_dt)
        
    total_sales = db.session.query(func.sum(Sale.total_amount)).filter(Sale.id.in_([s.id for s in query.all()])).scalar() or 0.0
    total_transactions = query.count()
    
    # Most selling product
    most_selling = None
    if total_transactions > 0:
        sale_ids = [s.id for s in query.all()]
        top_product_row = db.session.query(
            SaleItem.product_id, 
            func.sum(SaleItem.quantity).label('total_qty')
        ).filter(
            SaleItem.sale_id.in_(sale_ids)
        ).group_by(
            SaleItem.product_id
        ).order_by(func.sum(SaleItem.quantity).desc()).first()
        
        if top_product_row:
            product = Product.query.get(top_product_row.product_id)
            if product:
                most_selling = {
                    'id': product.id,
                    'title': product.title,
                    'total_sold': int(top_product_row.total_qty)
                }

    return jsonify({
        'total_sales': float(total_sales),
        'total_transactions': total_transactions,
        'most_selling_product': most_selling
    }), 200

@sales_bp.route('/<int:sale_id>', methods=['GET'])
@token_required
def get_sale_details(current_user, sale_id):
    sale = Sale.query.get_or_404(sale_id)
    if current_user.role != 'owner' and sale.branch_id != current_user.branch_id:
        return error_response("Forbidden", "Unauthorized", 403)
        
    items = []
    for item in sale.items:
        product_title = item.product.title if item.product else 'Unknown'
        items.append({
            'id': item.id,
            'product_id': item.product_id,
            'product_title': product_title,
            'variant_sku_suffix': item.variant_sku_suffix,
            'quantity': item.quantity,
            'unit_price': float(item.unit_price),
            'subtotal': float(item.subtotal)
        })
        
    out = {
        'id': sale.id,
        'user_id': sale.user_id,
        'operator_name': sale.user.username if sale.user else 'Unknown',
        'branch_id': sale.branch_id,
        'total_amount': float(sale.total_amount),
        'tax_amount': float(sale.tax_amount),
        'payment_method': sale.payment_method,
        'created_at': sale.created_at.isoformat(),
        'status': getattr(sale, 'status', 'completed'),
        'discount_amount': float(getattr(sale, 'discount_amount', 0) or 0),
        'discount_snapshot': getattr(sale, 'discount_snapshot', None),
        'items': items
    }
    if hasattr(sale, 'archived_at') and sale.archived_at:
        out['archived_at'] = sale.archived_at.isoformat()
    return jsonify(out), 200

@sales_bp.route('/<int:sale_id>/rollback', methods=['POST'])
@token_required
def rollback_sale(current_user, sale_id):
    if current_user.role != 'owner': # Maybe only owner can rollback? Or allow branch managers if any.
        pass # allow seller to rollback for now? usually admins/managers do it. Letting any user from branch do it for now.
        
    sale = Sale.query.get_or_404(sale_id)
    
    if current_user.role != 'owner' and sale.branch_id != current_user.branch_id:
        return error_response("Forbidden", "Unauthorized", 403)
        
    if getattr(sale, 'status', 'completed') == 'refunded':
        return error_response("Bad Request", "Sale already refunded", 400)

    try:
        sale.status = 'refunded'
        for item in sale.items:
            product = Product.query.get(item.product_id)
            if not product:
                continue

            def refund_product(p, qty, item_v_suffix):
                if not p.is_deal:
                    inventory = Inventory.query.filter_by(
                        branch_id=sale.branch_id,
                        product_id=p.id,
                        variant_sku_suffix=item_v_suffix
                    ).first()
                    if inventory is not None:
                        inventory.stock_level += qty
                        db.session.add(InventoryTransaction(
                            branch_id=sale.branch_id,
                            product_id=p.id,
                            variant_sku_suffix=item_v_suffix,
                            delta=qty,
                            reason='refund',
                            user_id=current_user.id,
                            reference_type='sale_refund',
                            reference_id=sale_id,
                        ))
                    if hasattr(p, 'recipe_items'):
                        for recipe_item in p.recipe_items:
                            ingredient = recipe_item.ingredient
                            if ingredient:
                                total_ing_qty = recipe_item.quantity * qty
                                qty_before = ingredient.current_stock
                                qty_after = qty_before + total_ing_qty
                                ingredient.current_stock = qty_after
                                sm = StockMovement(
                                    ingredient_id=ingredient.id,
                                    movement_type='adjustment',
                                    quantity_change=total_ing_qty,
                                    quantity_before=qty_before,
                                    quantity_after=qty_after,
                                    unit_cost=ingredient.average_cost,
                                    reference_id=sale_id,
                                    reference_type='sale_refund',
                                    reason=f"Refunded {qty}x {p.title}",
                                    created_by=current_user.id,
                                    branch_id=sale.branch_id
                                )
                                db.session.add(sm)
                else:
                    for combo_item in combo_items_for_variant(p, item_v_suffix):
                        child = combo_item.child_product
                        if child:
                            refund_product(child, qty * combo_item.quantity, "")

            refund_product(product, item.quantity, item.variant_sku_suffix or '')
        db.session.commit()
        return jsonify({"message": "Sale rolled back successfully"}), 200
    except Exception as e:
        db.session.rollback()
        return error_response("Internal Server Error", f"Rollback failed: {str(e)}", 500)

@sales_bp.route('/<int:sale_id>/archive', methods=['PATCH'])
@token_required
def archive_sale(current_user, sale_id):
    from datetime import datetime
    sale = Sale.query.get_or_404(sale_id)
    if current_user.role != 'owner' and sale.branch_id != current_user.branch_id:
        return error_response("Forbidden", "Unauthorized", 403)
    if not hasattr(sale, 'archived_at'):
        return error_response("Bad Request", "Archive not supported", 400)
    try:
        sale.archived_at = datetime.utcnow()
        db.session.commit()
        return jsonify({'message': 'Transaction archived', 'archived_at': sale.archived_at.isoformat()}), 200
    except Exception as e:
        db.session.rollback()
        return error_response("Internal Server Error", str(e), 500)

@sales_bp.route('/<int:sale_id>/unarchive', methods=['PATCH'])
@token_required
def unarchive_sale(current_user, sale_id):
    sale = Sale.query.get_or_404(sale_id)
    if current_user.role != 'owner' and sale.branch_id != current_user.branch_id:
        return error_response("Forbidden", "Unauthorized", 403)
    if not hasattr(sale, 'archived_at'):
        return error_response("Bad Request", "Unarchive not supported", 400)
    try:
        sale.archived_at = None
        db.session.commit()
        return jsonify({'message': 'Transaction restored'}), 200
    except Exception as e:
        db.session.rollback()
        return error_response("Internal Server Error", str(e), 500)

@sales_bp.route('/<int:sale_id>', methods=['DELETE'])
@token_required
@owner_required
def delete_sale_permanent(current_user, sale_id):
    """Permanent delete: removes the sale and all its line items. Cannot be undone."""
    sale = Sale.query.get_or_404(sale_id)
    if current_user.role != 'owner' and sale.branch_id != current_user.branch_id:
        return error_response("Forbidden", "Unauthorized", 403)
    items_count = len(sale.items)
    try:
        db.session.delete(sale)  # cascade deletes sale_items
        db.session.commit()
        return jsonify({
            'message': 'Transaction permanently deleted.',
            'related_deleted': {'sale_items': items_count}
        }), 200
    except Exception as e:
        db.session.rollback()
        return error_response("Internal Server Error", str(e), 500)

@sales_bp.route('/<int:sale_id>/print', methods=['POST'])
@token_required
def print_sale(current_user, sale_id):
    sale = Sale.query.get_or_404(sale_id)
    if current_user.role != 'owner' and sale.branch_id != current_user.branch_id:
        return error_response("Forbidden", "Unauthorized", 403)

    discount_amount = float(getattr(sale, 'discount_amount', 0) or 0)
    discounted_subtotal = float(sale.total_amount) - float(sale.tax_amount)
    subtotal = discounted_subtotal + discount_amount
    tax_rate = (float(sale.tax_amount) / discounted_subtotal) if discounted_subtotal else 0
    discount_name = None
    if getattr(sale, 'discount_snapshot', None) and isinstance(sale.discount_snapshot, dict):
        discount_name = sale.discount_snapshot.get('name') or 'Discount'

    from app.services.printer_service import PrinterService
    printer_service = PrinterService()

    receipt_data = {
        'total': float(sale.total_amount),
        'subtotal': subtotal,
        'tax_amount': float(sale.tax_amount),
        'tax_rate': tax_rate,
        'discount_amount': discount_amount,
        'discount_name': discount_name,
        'operator': sale.user.username if sale.user else 'Unknown',
        'branch': sale.branch.name if sale.branch else 'Main Branch',
        'branch_id': sale.branch_id,
        'items': [
            {
                'title': i.product.title if i.product else 'Unknown',
                'quantity': i.quantity,
                'unit_price': float(i.unit_price)
            } for i in sale.items
        ]
    }
    
    print_success = printer_service.print_receipt(receipt_data)
    
    if print_success:
        return jsonify({'message': 'Print job sent successfully'}), 200
    else:
        return jsonify({'message': 'Printer unavailable'}), 503
