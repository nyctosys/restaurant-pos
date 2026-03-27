from flask import Blueprint, jsonify, request
from app.models import db, User, Branch
from werkzeug.security import generate_password_hash, check_password_hash
import jwt
from datetime import datetime, timedelta
import os

auth_bp = Blueprint('auth', __name__)
SECRET_KEY = os.environ.get('SECRET_KEY', 'dev_secret_key_change_in_production')

@auth_bp.route('/status', methods=['GET'])
def check_status():
    """
    Checks if the system has been initialized (i.e., if an owner exists).
    Used by the frontend to determine if it should route to /onboarding or /login.
    """
    owner_exists = User.query.filter_by(role='owner').first() is not None
    return jsonify({
        "initialized": owner_exists
    }), 200

@auth_bp.route('/setup', methods=['POST'])
def initial_setup():
    """
    Registers the first owner and the primary branch.
    Only allows execution if no owner exists yet.
    """
    if User.query.filter_by(role='owner').first():
        return jsonify({"error": "System is already initialized."}), 400

    data = request.get_json()
    if not data or not all(k in data for k in ("username", "password", "branch_name")):
        return jsonify({"error": "Missing required fields (username, password, branch_name)"}), 400

    # 1. Create Initial Branch
    try:
        new_branch = Branch(
            name=data['branch_name'],
            address=data.get('branch_address', ''),
            phone=data.get('branch_phone', '')
        )
        db.session.add(new_branch)
        db.session.flush() # Get the branch ID

        # 2. Create Owner User
        hashed_password = generate_password_hash(data['password'])
        new_owner = User(
            branch_id=new_branch.id,
            username=data['username'],
            password_hash=hashed_password,
            role='owner'
        )
        db.session.add(new_owner)
        db.session.commit()

        # 3. Generate initial token
        token = jwt.encode({
            'user_id': new_owner.id,
            'role': new_owner.role,
            'branch_id': new_branch.id,
            'exp': datetime.utcnow() + timedelta(days=30)
        }, SECRET_KEY, algorithm="HS256")

        return jsonify({
            "message": "System initialized successfully.",
            "token": token,
            "user": {
                "id": new_owner.id,
                "username": new_owner.username,
                "role": new_owner.role,
                "branch_id": new_owner.branch_id,
                "branch_name": new_branch.name
            }
        }), 201

    except Exception as e:
        db.session.rollback()
        return jsonify({"error": str(e)}), 500

@auth_bp.route('/login', methods=['POST'])
def login():
    data = request.get_json()
    if not data or not data.get('username') or not data.get('password'):
        return jsonify({'message': 'Missing credentials'}), 400

    user = User.query.filter_by(username=data['username']).first()

    if not user or not check_password_hash(user.password_hash, data['password']):
        return jsonify({'message': 'Invalid credentials'}), 401
    if getattr(user, 'archived_at', None):
        return jsonify({'message': 'Account is archived'}), 403

    token = jwt.encode({
        'user_id': user.id,
        'role': user.role,
        'branch_id': user.branch_id,
        'exp': datetime.utcnow() + timedelta(days=30)
    }, SECRET_KEY, algorithm="HS256")

    branch_name = ''
    if user.branch:
        branch_name = user.branch.name

    return jsonify({
        'token': token,
        'user': {
            'id': user.id,
            'username': user.username,
            'role': user.role,
            'branch_id': user.branch_id,
            'branch_name': branch_name
        }
    }), 200

@auth_bp.route('/branches', methods=['GET'])
def get_branches():
    branches = Branch.query.all()
    output = []
    for branch in branches:
        output.append({
            'id': branch.id,
            'name': branch.name,
            'address': branch.address,
            'phone': branch.phone
        })
    return jsonify({'branches': output}), 200
