from flask import Blueprint, request, jsonify
from datetime import datetime
from app.models import db, Branch, User, Inventory, Sale, Setting
from app.utils.auth_decorators import token_required, owner_required

branches_bp = Blueprint('branches', __name__)


def _branch_to_dict(b):
    d = {
        'id': b.id,
        'name': b.name,
        'address': b.address or '',
        'phone': b.phone or '',
        'user_count': len(b.users),
        'created_at': b.created_at.isoformat() if b.created_at else None
    }
    if hasattr(b, 'archived_at') and b.archived_at:
        d['archived_at'] = b.archived_at.isoformat()
    return d


@branches_bp.route('/', methods=['GET'])
@token_required
def get_branches(current_user):
    """List all branches with user count. Use include_archived=1 to include archived."""
    include_archived = request.args.get('include_archived', '').lower() in ('1', 'true', 'yes')
    query = Branch.query.order_by(Branch.created_at.asc())
    if not include_archived and hasattr(Branch, 'archived_at'):
        query = query.filter(Branch.archived_at == None)
    branches = query.all()
    output = [_branch_to_dict(b) for b in branches]
    return jsonify(output), 200


@branches_bp.route('/', methods=['POST'])
@token_required
@owner_required
def create_branch(current_user):
    """Create a new branch."""
    data = request.get_json()
    if not data or not data.get('name', '').strip():
        return jsonify({'message': 'Branch name is required'}), 400

    # Check for duplicate name
    existing = Branch.query.filter(
        db.func.lower(Branch.name) == data['name'].strip().lower()
    ).first()
    if existing:
        return jsonify({'message': 'A branch with that name already exists'}), 409

    try:
        branch = Branch(
            name=data['name'].strip(),
            address=data.get('address', '').strip(),
            phone=data.get('phone', '').strip()
        )
        db.session.add(branch)
        db.session.commit()
        return jsonify({
            'id': branch.id,
            'name': branch.name,
            'address': branch.address,
            'phone': branch.phone,
            'user_count': 0,
            'message': 'Branch created successfully'
        }), 201
    except Exception as e:
        db.session.rollback()
        return jsonify({'message': f'Error creating branch: {str(e)}'}), 500


@branches_bp.route('/<int:branch_id>', methods=['PUT'])
@token_required
@owner_required
def update_branch(current_user, branch_id):
    """Update an existing branch."""
    branch = Branch.query.get(branch_id)
    if not branch:
        return jsonify({'message': 'Branch not found'}), 404

    data = request.get_json()
    if not data:
        return jsonify({'message': 'No data provided'}), 400

    name = data.get('name', '').strip()
    if not name:
        return jsonify({'message': 'Branch name is required'}), 400

    # Check for duplicate name (excluding self)
    existing = Branch.query.filter(
        db.func.lower(Branch.name) == name.lower(),
        Branch.id != branch_id
    ).first()
    if existing:
        return jsonify({'message': 'A branch with that name already exists'}), 409

    try:
        branch.name = name
        branch.address = data.get('address', branch.address or '').strip()
        branch.phone = data.get('phone', branch.phone or '').strip()
        db.session.commit()
        return jsonify({
            'id': branch.id,
            'name': branch.name,
            'address': branch.address,
            'phone': branch.phone,
            'message': 'Branch updated successfully'
        }), 200
    except Exception as e:
        db.session.rollback()
        return jsonify({'message': f'Error updating branch: {str(e)}'}), 500


@branches_bp.route('/<int:branch_id>/archive', methods=['PATCH'])
@token_required
@owner_required
def archive_branch(current_user, branch_id):
    branch = Branch.query.get_or_404(branch_id)
    if not hasattr(branch, 'archived_at'):
        return jsonify({'message': 'Archive not supported'}), 400
    try:
        branch.archived_at = datetime.utcnow()
        db.session.commit()
        return jsonify({'message': 'Branch archived', 'archived_at': branch.archived_at.isoformat()}), 200
    except Exception as e:
        db.session.rollback()
        return jsonify({'message': str(e)}), 500

@branches_bp.route('/<int:branch_id>/unarchive', methods=['PATCH'])
@token_required
@owner_required
def unarchive_branch(current_user, branch_id):
    branch = Branch.query.get_or_404(branch_id)
    if not hasattr(branch, 'archived_at'):
        return jsonify({'message': 'Unarchive not supported'}), 400
    try:
        branch.archived_at = None
        db.session.commit()
        return jsonify({'message': 'Branch restored'}), 200
    except Exception as e:
        db.session.rollback()
        return jsonify({'message': str(e)}), 500

@branches_bp.route('/<int:branch_id>', methods=['DELETE'])
@token_required
@owner_required
def delete_branch(current_user, branch_id):
    """Permanent delete. If cascade=1, reassigns users and deletes inventory, sales, settings, then branch.
    Otherwise blocked if users or inventory exist."""
    branch = Branch.query.get(branch_id)
    if not branch:
        return jsonify({'message': 'Branch not found'}), 404

    cascade = request.args.get('cascade', '').lower() in ('1', 'true', 'yes')

    if cascade:
        try:
            users_count = len(branch.users)
            inv_count = Inventory.query.filter_by(branch_id=branch_id).count()
            sales_count = Sale.query.filter_by(branch_id=branch_id).count()
            setting = Setting.query.filter_by(branch_id=branch_id).first()

            for u in branch.users:
                u.branch_id = None
            Inventory.query.filter_by(branch_id=branch_id).delete()
            for sale in Sale.query.filter_by(branch_id=branch_id).all():
                db.session.delete(sale)
            if setting:
                db.session.delete(setting)
            db.session.delete(branch)
            db.session.commit()
            return jsonify({
                'message': 'Branch permanently deleted.',
                'related_deleted': {
                    'users_reassigned': users_count,
                    'inventory_rows': inv_count,
                    'sales': sales_count,
                    'settings': 1 if setting else 0
                }
            }), 200
        except Exception as e:
            db.session.rollback()
            return jsonify({'message': f'Error deleting branch: {str(e)}'}), 500
    else:
        if len(branch.users) > 0:
            return jsonify({
                'message': f'Cannot delete branch "{branch.name}" — it has {len(branch.users)} user(s). Reassign them or use permanent delete with cascade.'
            }), 409
        if len(branch.inventory) > 0:
            return jsonify({
                'message': f'Cannot delete branch "{branch.name}" — it has inventory. Use permanent delete with cascade to remove everything.'
            }), 409
        try:
            setting = Setting.query.filter_by(branch_id=branch_id).first()
            if setting:
                db.session.delete(setting)
            db.session.delete(branch)
            db.session.commit()
            return jsonify({'message': 'Branch deleted successfully'}), 200
        except Exception as e:
            db.session.rollback()
            return jsonify({'message': str(e)}), 500


@branches_bp.route('/<int:branch_id>/users', methods=['GET'])
@token_required
@owner_required
def get_branch_users(current_user, branch_id):
    """List users belonging to a specific branch."""
    branch = Branch.query.get(branch_id)
    if not branch:
        return jsonify({'message': 'Branch not found'}), 404

    users = User.query.filter_by(branch_id=branch_id).order_by(User.created_at.asc()).all()
    output = []
    for u in users:
        output.append({
            'id': u.id,
            'username': u.username,
            'role': u.role,
            'created_at': u.created_at.isoformat() if u.created_at else None
        })
    return jsonify(output), 200
