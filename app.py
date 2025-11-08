"""
FastAPI application for sharkbyteIntegriTech.
Provides endpoints for screen description and other utilities.
"""

import os
from typing import Optional
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import google.generativeai as genai

from utils.screen_describer import ScreenDescriber, ScreenConfig
from screen_watcher_windows_gemini import (
    active_window_title, speak,
    MODEL_VISION, SCREEN_DOWNSCALE_MAX, DENYLIST_TITLES
)

# --- Gemini Setup ---
API_KEY = os.getenv("GEMINI_API_KEY")
if not API_KEY:
    raise RuntimeError("Set GEMINI_API_KEY environment variable before running.")
genai.configure(api_key=API_KEY)
vision = genai.GenerativeModel(MODEL_VISION)

# --- Initialize Screen Describer ---
config = ScreenConfig(
    max_edge=SCREEN_DOWNSCALE_MAX,
    denylist_titles=DENYLIST_TITLES
)

describer = ScreenDescriber(
    vision_generate=lambda x: vision.generate_content(x),
    active_window_title=active_window_title,
    speak=None,  # Disable TTS for API endpoints
    config=config
)

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

@app.get("/describe", summary="Describe current screen")
async def describe_screen(privacy_pause: bool = False):
    """
    Capture and describe the current screen using Gemini Vision.
    
    Args:
        privacy_pause: If True, respect privacy pause state.
    
    Returns:
        Dict with description status and content.
    """
    try:
        return describer.describe(paused=privacy_pause)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    # Run with: uvicorn app:app --reload --host 127.0.0.1 --port 8000
    import uvicorn

    uvicorn.run("app:app", host="127.0.0.1", port=8000, reload=True)
