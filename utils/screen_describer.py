"""
Screen description utilities that can be used by both the CLI tool and FastAPI endpoints.
Provides a ScreenDescriber class that handles screenshot capture, privacy checks, and Gemini vision API calls.
"""

import io, re
from typing import Callable, Optional, Dict, Any, Union
from dataclasses import dataclass
from PIL import Image
import mss
from PIL import ImageGrab

@dataclass
class ScreenConfig:
    """Configuration for screen capture and processing."""
    max_edge: int = 1600
    denylist_titles: list[str] = None

    def __post_init__(self):
        if self.denylist_titles is None:
            self.denylist_titles = ["password", "bank", "1password", "lastpass", "bitwarden",
                                  "settings", "windows security", "microsoft account"]

def capture_fullscreen() -> Image.Image:
    """Capture the full screen using mss."""
    with mss.mss() as sct:
        m = sct.monitors[0]
        raw = sct.grab(m)
        return Image.frombytes("RGB", (raw.width, raw.height), raw.rgb)

def capture_region(x: int, y: int, w: int, h: int) -> Image.Image:
    """Capture a specific region of the screen."""
    return ImageGrab.grab(bbox=(x, y, x+w, y+h))

def downscale(img: Image.Image, max_edge: int) -> Image.Image:
    """Downscale image if its largest edge exceeds max_edge."""
    w, h = img.size
    le = max(w, h)
    if le <= max_edge:
        return img
    sc = max_edge/le
    return img.resize((int(w*sc), int(h*sc)))

def pil_to_bytes(img: Image.Image) -> bytes:
    """Convert PIL Image to JPEG bytes."""
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return buf.getvalue()

def extract_tldr(s: str) -> Optional[str]:
    """Extract TL;DR from text or return last line if no explicit TL;DR."""
    if not s:
        return None
    m = re.search(r"(?im)^\s*tl;?\s*d\r?\s*r[:\-]?\s*(.+)$", s)
    if m:
        return m.group(1).strip()
    lines = [ln.strip() for ln in s.splitlines() if ln.strip()]
    return lines[-1] if lines and len(lines[-1]) < 300 else None

def sanitize_ascii(s: str, max_len: int = 1800) -> str:
    """Clean and truncate string."""
    return (s or "").replace("\u0000", "").strip()[:max_len]

class ScreenDescriber:
    """
    Handles screen capture, privacy checks, and description generation using Gemini Vision API.
    """
    def __init__(
        self,
        vision_generate: Callable[[bytes], str],
        active_window_title: Callable[[], str],
        speak: Optional[Callable[[str], None]] = None,
        config: Optional[ScreenConfig] = None
    ):
        self.vision_generate = vision_generate
        self.active_window_title = active_window_title
        self.speak = speak or (lambda *_: None)  # No-op if no speak function provided
        self.config = config or ScreenConfig()

    def should_block_by_title(self, title: str) -> bool:
        """Check if window title matches privacy denylist."""
        return any(b in (title or "").lower() for b in self.config.denylist_titles)

    def describe(self, paused: bool = False) -> Dict[str, Any]:
        """
        Capture and describe the current screen.
        
        Args:
            paused: If True, skip capture and return paused status.
            
        Returns:
            Dict with status and description/error info.
        """
        if paused:
            return {"status": "paused"}

        title = self.active_window_title()
        if self.should_block_by_title(title):
            return {"status": "blocked", "title": title}

        try:
            # Capture and process screen
            img = capture_fullscreen()
            img = downscale(img, self.config.max_edge)
            image_bytes = pil_to_bytes(img)

            # Get description from vision API
            result = self.vision_generate([
                "Describe this screenshot briefly and finish with a TL;DR.",
                {"mime_type": "image/jpeg", "data": image_bytes}
            ])
            text = sanitize_ascii(result.text)
            tldr = extract_tldr(text) or text[:150]

            # Optionally speak summary
            self.speak(f"Summary. {tldr}")

            return {
                "status": "ok",
                "description": text,
                "tldr": tldr,
            }

        except Exception as e:
            return {
                "status": "error",
                "error": str(e),
                "error_type": type(e).__name__
            }