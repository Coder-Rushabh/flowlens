from fastapi import FastAPI

from .api import router

app = FastAPI(title="orders")
app.include_router(router, prefix="/api")


@app.get("/health")
def health():
    return {"ok": True}
