from app_fastapi.main import app, database_shell

# Backward-compatible aliases (legacy tests/scripts referenced Flask).
flask_sqlalchemy_app = database_shell
legacy_flask_app = database_shell

__all__ = ["app", "database_shell", "flask_sqlalchemy_app", "legacy_flask_app"]
