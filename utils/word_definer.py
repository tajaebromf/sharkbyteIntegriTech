"""
Word definition utilities that handle OCR-based word detection and definition generation.
"""

from dataclasses import dataclass
from typing import Callable, Optional, Dict, Any, Tuple, List
from PIL import Image
import pytesseract

@dataclass
class WordDefinerConfig:
    """Configuration for word detection and OCR."""
    cursor_crop: Tuple[int, int] = (420, 240)  # width, height of region around cursor
    ocr_lang: str = "eng"
    denylist_titles: List[str] = None

    def __post_init__(self):
        if self.denylist_titles is None:
            self.denylist_titles = ["password", "bank", "1password", "lastpass", "bitwarden",
                                  "settings", "windows security", "microsoft account"]

def ocr_words_with_boxes(img: Image.Image, lang: str = "eng") -> List[Dict[str, Any]]:
    """Extract words and their bounding boxes from image using OCR."""
    d = pytesseract.image_to_data(img, output_type=pytesseract.Output.DICT, lang=lang)
    out = []
    for i, t in enumerate(d["text"]):
        t = t.strip()
        if t:
            out.append({
                "text": t,
                "left": d["left"][i],
                "top": d["top"][i],
                "width": d["width"][i],
                "height": d["height"][i]
            })
    return out

def nearest_word_to_point(words: List[Dict[str, Any]], px: int, py: int) -> Optional[str]:
    """Find the word closest to the given point."""
    best, bestd = None, None
    for w in words:
        cx = w["left"] + w["width"]/2
        cy = w["top"] + w["height"]/2
        d = (cx-px)**2 + (cy-py)**2
        if bestd is None or d < bestd:
            best, bestd = w, d
    return best["text"] if best else None

class WordDefiner:
    """
    Handles word detection via OCR and definition generation using LLM.
    """
    def __init__(
        self,
        text_generate: Callable[[str], Any],
        capture_region: Callable[[int, int, int, int], Image.Image],
        active_window_title: Callable[[], str],
        speak: Optional[Callable[[str], None]] = None,
        config: Optional[WordDefinerConfig] = None
    ):
        """
        Initialize WordDefiner with required dependencies.

        Args:
            text_generate: Function to generate text definitions (e.g., Gemini text model)
            capture_region: Function to capture screen region (x,y,w,h -> PIL Image)
            active_window_title: Function to get active window title
            speak: Optional TTS function
            config: Optional configuration
        """
        self.text_generate = text_generate
        self.capture_region = capture_region
        self.active_window_title = active_window_title
        self.speak = speak or (lambda *_: None)
        self.config = config or WordDefinerConfig()

    def should_block_by_title(self, title: str) -> bool:
        """Check if window title matches privacy denylist."""
        return any(b in (title or "").lower() for b in self.config.denylist_titles)

    def define_word_at_point(
        self,
        x: int,
        y: int,
        paused: bool = False,
        custom_prompt: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Find and define the word nearest to the given screen coordinates.

        Args:
            x: Screen X coordinate
            y: Screen Y coordinate
            paused: If True, skip processing
            custom_prompt: Optional custom prompt for the LLM

        Returns:
            Dict with status and definition info
        """
        if paused:
            return {"status": "paused"}

        title = self.active_window_title()
        if self.should_block_by_title(title):
            return {"status": "blocked", "title": title}

        try:
            # Calculate region around point
            rw, rh = self.config.cursor_crop
            cap_x = max(0, x - rw//2)
            cap_y = max(0, y - rh//2)
            
            # Capture and process region
            img = self.capture_region(cap_x, cap_y, rw, rh)
            words = ocr_words_with_boxes(img, self.config.ocr_lang)
            
            if not words:
                return {"status": "no_words", "message": "No words found in region"}
            
            # Find nearest word
            word = nearest_word_to_point(words, rw//2, rh//2)
            if not word:
                return {"status": "no_word", "message": "No word found at position"}

            # Generate definition
            prompt = custom_prompt or f"Define '{word}' in one sentence plus 2 examples and 3 synonyms."
            result = self.text_generate(prompt)
            
            # Optional TTS
            self.speak(f"Definition for {word}. {result.text}")
            
            return {
                "status": "ok",
                "word": word,
                "definition": result.text,
                "region": {
                    "x": cap_x,
                    "y": cap_y,
                    "width": rw,
                    "height": rh
                }
            }

        except Exception as e:
            return {
                "status": "error",
                "error": str(e),
                "error_type": type(e).__name__
            }