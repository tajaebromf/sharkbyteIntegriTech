from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(
    title="sharkbyteIntegriTech API",
    description="A small FastAPI skeleton for the sharkbyteIntegriTech project.",
    version="0.1.0",
)


class Item(BaseModel):
    name: str
    description: Optional[str] = None
    price: float
    tax: Optional[float] = None


@app.on_event("startup")
async def startup_event():
    # place lightweight startup init here (no screen_watcher integration)
    print("Starting sharkbyteIntegriTech FastAPI app...")


@app.on_event("shutdown")
async def shutdown_event():
    print("Shutting down sharkbyteIntegriTech FastAPI app...")


@app.get("/", summary="Root")
async def read_root():
    return {"message": "Welcome to sharkbyteIntegriTech FastAPI", "status": "ok"}


@app.get("/health", summary="Health check")
async def health_check():
    return {"status": "healthy"}


@app.post("/items", summary="Create an item")
async def create_item(item: Item):
    # simple example of business logic: calculate price with tax
    try:
        price_with_tax = item.price + (item.tax or 0.0)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    return {"name": item.name, "price": item.price, "price_with_tax": price_with_tax}


if __name__ == "__main__":
    # Run with: uvicorn app:app --reload --host 127.0.0.1 --port 8000
    import uvicorn

    uvicorn.run("app:app", host="127.0.0.1", port=8000, reload=True)
