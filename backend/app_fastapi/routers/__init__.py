from app_fastapi.routers.auth import auth_router
from app_fastapi.routers.branches import branches_router
from app_fastapi.routers.health import health_router
from app_fastapi.routers.menu import menu_router
from app_fastapi.routers.modifiers import modifiers_router
from app_fastapi.routers.orders import orders_router
from app_fastapi.routers.printer import printer_router
from app_fastapi.routers.scanner import scanner_router
from app_fastapi.routers.settings import settings_router
from app_fastapi.routers.stock import stock_router
from app_fastapi.routers.users import users_router

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
