from fastapi import APIRouter

health_router = APIRouter(tags=["health"])


@health_router.get("/api/health")
def health_check():
    return {"status": "healthy"}
