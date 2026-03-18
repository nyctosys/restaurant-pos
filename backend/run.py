import os
from sqlalchemy import text
from sqlalchemy.exc import OperationalError, ProgrammingError
from app import create_app, socketio
from app.models import db

app = create_app()

if __name__ == '__main__':
    # Initialize DB tables if they don't exist
    with app.app_context():
        db.create_all()
        # Ensure status column is added to existing sales databases
        try:
            db.session.execute(text("ALTER TABLE sales ADD COLUMN status VARCHAR(20) DEFAULT 'completed'"))
            db.session.commit()
            print("Added 'status' column to 'sales' table.")
        except (OperationalError, ProgrammingError):
            # Column likely already exists or table wasn't created yet; ignore.
            db.session.rollback()
        
        print("Database tables ensured.")
        
    port = int(os.environ.get('PORT', 5000))
    # Production: use FLASK_ENV=production or FLASK_DEBUG=0. With eventlet installed,
    # socketio.run() uses eventlet for concurrent requests (Windows-compatible; no Gunicorn).
    debug = os.environ.get('FLASK_DEBUG', '').lower() in ('1', 'true', 'yes')
    if not debug and os.environ.get('FLASK_ENV', '').lower() == 'development':
        debug = True

    socketio.run(
        app,
        host='0.0.0.0',
        port=port,
        debug=debug,
        allow_unsafe_werkzeug=debug,
    )
