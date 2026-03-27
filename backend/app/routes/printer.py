from flask import Blueprint, jsonify, request
from app.utils.auth_decorators import token_required

printer_bp = Blueprint('printer', __name__)

@printer_bp.route('/status', methods=['GET'])
@token_required
def printer_status(current_user):
    """Check if the USB printer is reachable."""
    try:
        from app.services.printer_service import PrinterService
        printer_service = PrinterService()
        connected = printer_service.connect()
        
        if connected:
            return jsonify({
                'status': 'connected',
                'message': 'USB printer is connected and ready'
            }), 200
        else:
            return jsonify({
                'status': 'disconnected',
                'message': 'USB printer not found or not configured'
            }), 200
    except Exception as e:
        return jsonify({
            'status': 'error',
            'message': str(e)
        }), 200

@printer_bp.route('/test-print', methods=['POST'])
@token_required
def test_print(current_user):
    """Fires a test print using current settings."""
    try:
        from app.services.printer_service import PrinterService
        printer_service = PrinterService()
        
        # Test receipt with layout matching designed receipt (subtotal, tax, total).
        # _test_print: use normal font size so test doesn't print super large.
        test_receipt = {
            'subtotal': 110.00,
            'tax_amount': 9.00,
            'tax_rate': 8,
            'total': 119.00,
            'operator': current_user.username,
            'branch': 'Test Branch',
            'items': [
                {'title': 'Classic T-Shirt', 'quantity': 1, 'unit_price': 25.00},
                {'title': 'Denim Jacket', 'quantity': 1, 'unit_price': 85.00}
            ],
            '_test_print': True,
        }
        
        success = printer_service.print_receipt(test_receipt)
        if success:
            return jsonify({'success': True, 'message': 'Test print completed'}), 200
        else:
            return jsonify({'success': False, 'message': 'Failed to print. Check USB connection.'}), 503
            
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500

@printer_bp.route('/print-receipt', methods=['POST'])
@token_required
def print_receipt(current_user):
    """Standalone endpoint to print a custom receipt payload."""
    data = request.get_json()
    if not data or 'receipt_data' not in data:
        return jsonify({'success': False, 'message': 'Missing receipt_data in payload'}), 400
        
    try:
        from app.services.printer_service import PrinterService
        printer_service = PrinterService()
        
        success = printer_service.print_receipt(data['receipt_data'])
        if success:
            return jsonify({'success': True}), 200
        else:
            return jsonify({'success': False, 'error': 'Hardware print failed'}), 503
            
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@printer_bp.route('/print-barcode-label', methods=['POST'])
@token_required
def print_barcode_label(current_user):
    """Print a barcode label (SKU + optional title) on the USB thermal printer. Works in Tauri (no browser print)."""
    data = request.get_json()
    if not data or 'sku' not in data:
        return jsonify({'success': False, 'message': 'Missing sku in payload'}), 400
    try:
        from app.services.printer_service import PrinterService
        printer_service = PrinterService()
        success = printer_service.print_barcode_label(
            sku=data['sku'],
            title=data.get('title') or ''
        )
        if success:
            return jsonify({'success': True}), 200
        return jsonify({'success': False, 'message': 'Printer not available or print failed'}), 503
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500
