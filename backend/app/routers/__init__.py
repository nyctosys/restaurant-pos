from app.routers.auth import auth_router
from app.routers.branches import branches_router
from app.routers.health import health_router
from app.routers.menu import menu_router
from app.routers.modifiers import modifiers_router
from app.routers.orders import orders_router
from app.routers.printer import printer_router
from app.routers.scanner import scanner_router
from app.routers.settings import settings_router
from app.routers.stock import stock_router
from app.routers.users import users_router

__all__ = [
    "auth_router",
    "branches_router",
    "health_router",
    "menu_router",
    "modifiers_router",
    "orders_router",
    "printer_router",
    "scanner_router",
    "settings_router",
    "stock_router",
    "users_router",
]
