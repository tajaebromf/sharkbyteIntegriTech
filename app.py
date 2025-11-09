"""
FastAPI application for sharkbyteIntegriTech.
Provides endpoints for screen description and other utilities.
"""

import os
from typing import Optional
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import google.generativeai as genai
from fastapi import Body
from pydantic import BaseModel
import base64
from io import BytesIO
from PIL import Image

from utils.screen_describer import ScreenDescriber, ScreenConfig
from screen_watcher_windows_gemini import (
    active_window_title, speak, capture_region,
    MODEL_VISION, MODEL_TEXT, SCREEN_DOWNSCALE_MAX,
    DENYLIST_TITLES, CURSOR_CROP, OCR_LANG
)


# --- Gemini Setup ---
API_KEY = os.getenv("GEMINI_API_KEY")
if not API_KEY:
    raise RuntimeError("Set GEMINI_API_KEY environment variable before running.")
genai.configure(api_key=API_KEY)
vision = genai.GenerativeModel(MODEL_VISION)
text = genai.GenerativeModel(MODEL_TEXT)

# --- Initialize utilities ---
screen_config = ScreenConfig(
    max_edge=SCREEN_DOWNSCALE_MAX,
    denylist_titles=DENYLIST_TITLES
)

describer = ScreenDescriber(
    vision_generate=lambda x: vision.generate_content(x),
    active_window_title=active_window_title,
    speak=None,  # Disable TTS for API endpoints
    config=screen_config
)

from utils.word_definer import WordDefiner, WordDefinerConfig
word_config = WordDefinerConfig(
    cursor_crop=CURSOR_CROP,
    ocr_lang=OCR_LANG,
    denylist_titles=DENYLIST_TITLES
)

definer = WordDefiner(
    text_generate=lambda x: text.generate_content(x),
    capture_region=capture_region,
    active_window_title=active_window_title,
    speak=None,  # Disable TTS for API endpoints
    config=word_config
)

app = FastAPI(
    title="sharkbyteIntegriTech API",
    description="Screen description and analysis API with mouse tracking.",
    version="0.1.0",
)

# Mount the mouse tracker
from utils.mouse_tracker import router as mouse_router
app.mount("/mouse", mouse_router)

class AnnotatePayload(BaseModel):
    image_base64: str
    question: str = ""
    page_url: str = ""
    selection: str = ""

@app.post("/annotate", summary="Receive screenshot + question and return TL;DR & answer")
async def annotate(payload: AnnotatePayload):
    try:
        # decode image
        raw = base64.b64decode(payload.image_base64)
        img = Image.open(BytesIO(raw)).convert("RGB")

        # 1) Ask Gemini Vision for a concise TL;DR of the screen
        tldr_prompt = """Give a concise TL;DR (1-2 sentences) of the MAIN CONTENT on this webpage.

CRITICAL RULES:
- Focus ONLY on the primary webpage content (articles, documentation, main text)
- IGNORE any sidebars, toolbars, extensions, or overlay UI elements on the right side
- DO NOT mention annotation tools, browser extensions, or helper applications
- Describe what the webpage is about, not what tools are being used to view it

Example good output: "This is an MDN documentation page about getting started with React, covering prerequisites and setup instructions."
Example bad output: "This screen shows an MDN page with a Browser Buddy tool..."

TL;DR:"""

        tldr_resp = vision.generate_content([tldr_prompt, img])
        tldr_text = (tldr_resp.text or "").strip()

        # 2) If the user asked a question, ask Gemini using the same image for context
        answer_text = ""
        if payload.question:
            qa_prompt = f"""Answer this question using ONLY the MAIN WEBPAGE CONTENT visible on screen.

CRITICAL RULES:
- Focus on the primary webpage content (center/left area)
- IGNORE any sidebar tools, extensions, or UI overlays on the right
- Answer from the perspective of a helpful assistant explaining the webpage content
- Be educational and concise
- DO NOT mention browser extensions, annotation tools, or sidebar UI
- Have a friendly and engaging tone.
- If the user's question is not answered by the webpage content, search the web for the answer while keeping the context in mind.
USER'S QUESTION: {payload.question}

ANSWER:"""
            qa_resp = vision.generate_content([qa_prompt, img])
            answer_text = (qa_resp.text or "").strip()

        return {"tldr": tldr_text, "answer": answer_text}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

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
    Capture and describe the current screen using Gemini Vision. Ignore the page annotation app on the right side of the screen,
    as well as any other apps in the toolbar on the bottom of the screen.
    
    Args:
        privacy_pause: If True, respect privacy pause state.
    
    Returns:
        Dict with description status and content.
    """
    try:
        return describer.describe(paused=privacy_pause)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/define", summary="Define word at screen coordinates")
async def define_word(x: int, y: int, privacy_pause: bool = False, custom_prompt: str = None):
    """
    Find and define the word nearest to the given screen coordinates.
    
    Args:
        x: Screen X coordinate
        y: Screen Y coordinate
        privacy_pause: If True, respect privacy pause state
        custom_prompt: Optional custom prompt for word definition
        
    Returns:
        Dict with word and definition info
    """
    try:
        return definer.define_word_at_point(
            x=x,
            y=y,
            paused=privacy_pause,
            custom_prompt=custom_prompt
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/define/current", summary="Define word at current mouse position")
async def define_word_at_mouse(privacy_pause: bool = False, custom_prompt: str = None):
    """
    Find and define the word nearest to the current mouse position.
    Uses the mouse tracker service to get coordinates.
    
    Args:
        privacy_pause: If True, respect privacy pause state
        custom_prompt: Optional custom prompt for word definition
        
    Returns:
        Dict with word and definition info, including mouse position
    """
    try:
        # Get current mouse position from tracker
        from utils.mouse_tracker import tracker
        x, y = tracker.get_position()
        
        # Get definition
        result = definer.define_word_at_point(
            x=x,
            y=y,
            paused=privacy_pause,
            custom_prompt=custom_prompt
        )
        
        # Add mouse position to result
        result["mouse_position"] = {"x": x, "y": y}
        return result
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    # Run with: uvicorn app:app --reload --host 127.0.0.1 --port 8000
    import uvicorn

    uvicorn.run("app:app", host="127.0.0.1", port=8000, reload=True)
