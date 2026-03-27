from functools import wraps
from flask import request, jsonify
import jwt
import os
from app.models import User

SECRET_KEY = os.environ.get('SECRET_KEY', 'dev_secret_key_change_in_production')

def token_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        token = None
        if 'Authorization' in request.headers:
            parts = request.headers['Authorization'].split()
            if len(parts) == 2 and parts[0].lower() == 'bearer':
                token = parts[1]

        if not token:
            return jsonify({'message': 'Token is missing!'}), 401

        try:
            data = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
            current_user = User.query.get(data['user_id'])
            if not current_user:
                return jsonify({'message': 'User not found!'}), 401
        except jwt.ExpiredSignatureError:
            return jsonify({'message': 'Session expired. Please log in again.', 'code': 'token_expired'}), 401
        except jwt.InvalidTokenError:
            return jsonify({'message': 'Invalid session. Please log in again.', 'code': 'token_invalid'}), 401
        except Exception:
            return jsonify({'message': 'Invalid session. Please log in again.'}), 401

        return f(current_user, *args, **kwargs)

    return decorated

def owner_required(f):
    @wraps(f)
    def decorated(current_user, *args, **kwargs):
        if current_user.role != 'owner':
            return jsonify({'message': 'Owner privileges required!'}), 403
        return f(current_user, *args, **kwargs)
    return decorated
