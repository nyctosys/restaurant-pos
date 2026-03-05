from flask import Blueprint, request, jsonify
from app.models import db, Setting
from app.utils.auth_decorators import token_required, owner_required

settings_bp = Blueprint('settings', __name__)

def _merge_configs(global_config, branch_config):
    """Merge global config as base with branch config overrides.
    
    Branch-specific keys override global ones, but global keys
    that are absent from the branch config are preserved (e.g. sections).
    """
    if not global_config:
        return branch_config or {}
    if not branch_config:
        return global_config
    
    merged = {**global_config, **branch_config}
    return merged

@settings_bp.route('/', methods=['GET'])
@token_required
def get_settings(current_user):
    # When global_only=1, return only global config (e.g. for hardware / printer VID-PID)
    if request.args.get('global_only') in ('1', 'true', 'yes'):
        global_setting = Setting.query.filter_by(branch_id=None).first()
        global_config = global_setting.config if global_setting else {}
        return jsonify({"config": global_config}), 200

    branch_id_str = request.args.get('branch_id')
    
    if current_user.role == 'owner' and branch_id_str:
        branch_id = int(branch_id_str)
    else:
        branch_id = current_user.branch_id

    # Always fetch the global config as a base
    global_setting = Setting.query.filter_by(branch_id=None).first()
    global_config = global_setting.config if global_setting else {}

    # Fetch branch-specific config if a branch is specified
    branch_config = {}
    if branch_id:
        branch_setting = Setting.query.filter_by(branch_id=branch_id).first()
        if branch_setting:
            branch_config = branch_setting.config or {}

    # Merge: global as base, branch overrides on top
    merged = _merge_configs(global_config, branch_config)
    
    return jsonify({"config": merged}), 200

@settings_bp.route('/', methods=['POST', 'PUT'])
@token_required
@owner_required
def update_settings(current_user):
    data = request.get_json()
    if not data or 'config' not in data:
        return jsonify({"message": "Missing config data"}), 400
        
    # Owners can pass branch_id (or null for global). Otherwise default to their own branch.
    branch_id = data.get('branch_id') if 'branch_id' in data else current_user.branch_id
    
    setting = Setting.query.filter_by(branch_id=branch_id).first()
    
    try:
        if not setting:
            setting = Setting(branch_id=branch_id, config=data['config'])
            db.session.add(setting)
        else:
            setting.config = data['config']
            
        db.session.commit()
        return jsonify({"message": "Settings updated", "config": setting.config}), 200
    except Exception as e:
        db.session.rollback()
        return jsonify({"message": "Error updating settings", "error": str(e)}), 500
