from flask import Flask, jsonify, g, request
from flask_cors import CORS
from flask_socketio import SocketIO
from app.models import db
from app.errors import error_response, handle_http_error, handle_generic_exception
import os
import time
import uuid
import logging
from dotenv import load_dotenv

load_dotenv()
socketio = SocketIO(cors_allowed_origins="*")
request_logger = logging.getLogger("app.request")


def create_app():
    app = Flask(__name__)
    CORS(app)

    # Global error handlers (JSON responses for all errors)
    @app.errorhandler(400)
    def bad_request(e):
        return handle_http_error(e) if hasattr(e, "description") else error_response("Bad Request", str(e), 400)

    @app.errorhandler(404)
    def not_found(e):
        return handle_http_error(e) if hasattr(e, "description") else error_response("Not Found", str(e), 404)

    @app.errorhandler(500)
    def internal_error(e):
        return handle_http_error(e) if hasattr(e, "description") else error_response("Internal Server Error", str(e), 500)

    @app.errorhandler(Exception)
    def unhandled(e):
        from werkzeug.exceptions import HTTPException
        if isinstance(e, HTTPException):
            return handle_http_error(e)
        return handle_generic_exception(e)

    # Request logging middleware
    @app.before_request
    def before_request():
        g.start_time = time.perf_counter()
        g.request_id = uuid.uuid4().hex

    @app.after_request
    def after_request(response):
        if request.path == "/api/health" or request.path.startswith("/socket.io"):
            return response
        duration_ms = (time.perf_counter() - getattr(g, "start_time", 0)) * 1000
        request_logger.info(
            "method=%s path=%s status=%s duration_ms=%.2f request_id=%s",
            request.method,
            request.path,
            response.status_code,
            duration_ms,
            getattr(g, "request_id", ""),
        )
        response.headers["X-Request-ID"] = getattr(g, "request_id", "")
        return response

    # Configure Database
    # Defaulting to a local postgres instance if not specified in .env
    app.config['SQLALCHEMY_DATABASE_URI'] = os.environ.get('DATABASE_URL', 'postgresql://localhost/sootshoot')
    app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
    app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'dev_secret_key_change_in_production')

    db.init_app(app)
    socketio.init_app(app)

    # Create all database tables on startup with retry logic
    # (the postgres container may not be ready yet)
    import time
    with app.app_context():
        retries = 10
        for i in range(retries):
            try:
                db.create_all()
                print("Database tables created successfully.")
                # Ensure status column exists on sales table (migration for older DBs)
                from sqlalchemy import text
                from sqlalchemy.exc import OperationalError, ProgrammingError
                try:
                    db.session.execute(text("ALTER TABLE sales ADD COLUMN status VARCHAR(20) DEFAULT 'completed'"))
                    db.session.commit()
                    print("Added 'status' column to 'sales' table.")
                except (OperationalError, ProgrammingError):
                    db.session.rollback()
                break
            except Exception as e:
                if i < retries - 1:
                    print(f"DB not ready (attempt {i+1}/{retries}), retrying in 2s... ({e})")
                    time.sleep(2)
                else:
                    print(f"Failed to create DB tables after {retries} attempts: {e}")
                    raise

    # Basic health check route
    @app.route('/api/health', methods=['GET'])
    def health_check():
        return jsonify({"status": "healthy"}), 200

    # Register Blueprints
    from app.routes.auth import auth_bp
    from app.routes.products import products_bp
    from app.routes.sales import sales_bp
    from app.routes.scanner import scanner_bp
    from app.routes.settings import settings_bp
    from app.routes.inventory import inventory_bp
    from app.routes.users import users_bp
    from app.routes.branches import branches_bp
    from app.routes.printer import printer_bp
    
    app.register_blueprint(auth_bp, url_prefix='/api/auth')
    app.register_blueprint(products_bp, url_prefix='/api/products')
    app.register_blueprint(sales_bp, url_prefix='/api/sales')
    app.register_blueprint(scanner_bp, url_prefix='/api/scanner')
    app.register_blueprint(settings_bp, url_prefix='/api/settings')
    app.register_blueprint(inventory_bp, url_prefix='/api/inventory')
    app.register_blueprint(users_bp, url_prefix='/api/users')
    app.register_blueprint(branches_bp, url_prefix='/api/branches')
    app.register_blueprint(printer_bp, url_prefix='/api/printer')

    return app
