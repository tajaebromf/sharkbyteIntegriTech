import io
import os
from dataclasses import dataclass
from typing import List, Optional
import re

import google.generativeai as genai
from PIL import Image, ImageGrab
import mss
import pytesseract
from pynput import keyboard, mouse
import win32com.client
# If pythoncom isn't present, we'll handle it in speak()
try:
    import pythoncom  # for CoInitialize/CoUninitialize on listener threads
except Exception:
    pythoncom = None

pytesseract.pytesseract.tesseract_cmd = r"C:\Users\sanga\Tesseract\tesseract.exe"

# Windows: active window title for privacy guard
try:
    import win32gui
except Exception:
    win32gui = None

# ---------------- CONFIG ----------------
MODEL_VISION = "gemini-2.5-flash"
MODEL_TEXT   = "gemini-2.5-flash"

SCREEN_DOWNSCALE_MAX = 1600          # downscale long edge to limit bandwidth
CURSOR_CROP = (420, 240)             # region around cursor for OCR
OCR_LANG = "eng"

# Add window titles you never want to capture
DENYLIST_TITLES = [
    "password", "bank", "1password", "lastpass", "bitwarden",
    "settings", "windows security", "microsoft account"
]

PRIVACY_DEFAULT_PAUSED = False

# ---------------- STATE ----------------
@dataclass
class State:
    paused: bool = PRIVACY_DEFAULT_PAUSED

state = State()
current_mouse_pos = (0, 0)
pressed_keys = set()

# ---------------- LLM SETUP ----------------
API_KEY = os.getenv("GEMINI_API_KEY")
if not API_KEY:
    raise RuntimeError("Set GEMINI_API_KEY environment variable before running.")

genai.configure(api_key=API_KEY)
vision = genai.GenerativeModel(MODEL_VISION)
text   = genai.GenerativeModel(MODEL_TEXT)

# ---------------- UTIL ----------------
def downscale(img: Image.Image, max_long_edge: int) -> Image.Image:
    w, h = img.size
    long_edge = max(w, h)
    if long_edge <= max_long_edge:
        return img
    scale = max_long_edge / long_edge
    return img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)

def pil_to_bytes(img: Image.Image, fmt="JPEG", quality=85) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format=fmt, quality=quality)
    return buf.getvalue()

def capture_fullscreen() -> Image.Image:
    with mss.mss() as sct:
        monitor = sct.monitors[0]  # virtual full desktop
        raw = sct.grab(monitor)
        return Image.frombytes("RGB", (raw.width, raw.height), raw.rgb)

def capture_region(x: int, y: int, w: int, h: int) -> Image.Image:
    bbox = (x, y, x + w, y + h)
    return ImageGrab.grab(bbox=bbox)

def sanitize_ascii(s: str, max_len: int = 1800) -> str:
    return (s or "").replace("\u0000", "").strip()[:max_len]

def active_window_title() -> str:
    if not win32gui:
        return ""
    try:
        hwnd = win32gui.GetForegroundWindow()
        title = win32gui.GetWindowText(hwnd) or ""
        return title.lower().strip()
    except Exception:
        return ""

def should_block_by_title(title: str) -> bool:
    title = (title or "").lower()
    return any(bad in title for bad in DENYLIST_TITLES)

# ---- Windows TTS (thread-safe via COM init) ----
def speak(text: str, rate: int = 0, volume: int = 100):
    pc = pythoncom
    try:
        if pc:
            pc.CoInitialize()
        v = win32com.client.Dispatch("SAPI.SpVoice")
        v.Rate = rate      # -10 (slow) to +10 (fast)
        v.Volume = volume  # 0 to 100
        v.Speak(text)
    except Exception as e:
        print(f"[TTS error] {e}")
    finally:
        try:
            if pc:
                pc.CoUninitialize()
        except Exception:
            pass

def extract_tldr(s: str) -> Optional[str]:
    if not s:
        return None
    # Look for a TL;DR / TLDR line first
    m = re.search(r'(?im)^\s*tl;?\s*d\r?\s*r[:\-]?\s*(.+)$', s)
    if m:
        return m.group(1).strip()
    # Fallback: last short non-empty line
    lines = [ln.strip() for ln in s.strip().splitlines() if ln.strip()]
    if lines:
        last = lines[-1]
        if len(last) <= 300:
            return last
    return None

# ---------------- OCR HELPERS ----------------
def ocr_words_with_boxes(img: Image.Image) -> List[dict]:
    data = pytesseract.image_to_data(img, output_type=pytesseract.Output.DICT, lang=OCR_LANG)
    words = []
    for i in range(len(data["text"])):
        wtext = (data["text"][i] or "").strip()
        if not wtext:
            continue
        words.append({
            "text": wtext,
            "left": data["left"][i],
            "top": data["top"][i],
            "width": data["width"][i],
            "height": data["height"][i],
        })
    return words

def nearest_word_to_point(words: List[dict], px: int, py: int) -> Optional[str]:
    best = None
    best_d2 = None
    for w in words:
        cx = w["left"] + w["width"] // 2
        cy = w["top"] + w["height"] // 2
        d2 = (cx - px)**2 + (cy - py)**2
        if best_d2 is None or d2 < best_d2:
            best, best_d2 = w, d2
    return best["text"] if best else None

# ---------------- FEATURES ----------------
def describe_screen():
    if state.paused:
        print("[PAUSED] Not capturing.")
        return

    title = active_window_title()
    if should_block_by_title(title):
        print(f"[Privacy] Blocked capture due to window title: '{title}'")
        return

    img = capture_fullscreen()
    img = downscale(img, SCREEN_DOWNSCALE_MAX)
    img_bytes = pil_to_bytes(img)

    prompt = (
        "You are a helpful visual assistant.\n"
        "Describe this screenshot for a user who asked: 'What image is on my screen?'\n"
        "Be concise but complete: identify main elements, UI context, any charts/tables, and notable text.\n"
        "If it appears to be a code editor/IDE, mention clues (language, file names). "
        "If it looks like a known website/app, say which (if obvious). "
        "Finish with a single-line TL;DR: <one-line summary>."
    )

    try:
        resp = vision.generate_content([prompt, {"mime_type":"image/jpeg", "data": img_bytes}])
        out = sanitize_ascii(resp.text)
        print("\n=== Screen Description ===")
        print(out)
        print("==========================\n")

        # 🔊 Speak only the TL;DR (Alt+I behavior)
        tldr = extract_tldr(out)
        if tldr:
            speak("Summary. " + tldr, rate=0)
        else:
            # Fallback: speak first ~200 chars
            speak("Summary. " + out[:200], rate=0)

    except Exception as e:
        print(f"[Error describing screen] {e}")

def define_word_under_mouse():
    if state.paused:
        print("[PAUSED] Not capturing.")
        return

    title = active_window_title()
    if should_block_by_title(title):
        print(f"[Privacy] Blocked capture due to window title: '{title}'")
        return

    mx, my = current_mouse_pos
    rw, rh = CURSOR_CROP
    x = max(0, mx - rw // 2)
    y = max(0, my - rh // 2)

    img = capture_region(x, y, rw, rh)
    words = ocr_words_with_boxes(img)
    if not words:
        print("Couldn't read text near the cursor.")
        return

    # Point relative to crop center
    local_x = rw // 2
    local_y = rh // 2
    word = nearest_word_to_point(words, local_x, local_y)
    if not word:
        print("Couldn't locate a word under the cursor.")
        return

    prompt = (
        f"Define the word: '{word}'. "
        "Provide a simple definition, 2 brief example sentences, and 3 synonyms. "
        "If multiple parts of speech are possible, put the most likely first."
    )

    try:
        resp = text.generate_content(prompt)
        answer = sanitize_ascii(resp.text)
        print(f"\n=== Definition: {word} ===")
        print(answer)
        print("===========================\n")
        # 🔊 Speak the definition (Alt+W behavior)
        speak(f"Definition for {word}. {answer}", rate=0)

    except Exception as e:
        print(f"[Error defining word] {e}")

# ---------------- INPUT (hotkeys & mouse) ----------------
def on_move(x, y):
    global current_mouse_pos
    current_mouse_pos = (x, y)

def on_key_press(k):
    pressed_keys.add(k)

def on_key_release(k):
    # Track key up
    if k in pressed_keys:
        pressed_keys.remove(k)

    # Check if Alt is down
    alt_down = any(a in pressed_keys for a in (keyboard.Key.alt, keyboard.Key.alt_l, keyboard.Key.alt_r))

    if alt_down:
        # Alt + i → describe (with TL;DR TTS)
        if k == keyboard.KeyCode.from_char('i'):
            describe_screen()
        # Alt + w → define word at cursor (with TTS)
        elif k == keyboard.KeyCode.from_char('w'):
            define_word_under_mouse()
        # Alt + p → pause/resume
        elif k == keyboard.KeyCode.from_char('p'):
            state.paused = not state.paused
            print(f"[Privacy] {'Paused' if state.paused else 'Resumed'}.")
        # Alt + q → quit
        elif k == keyboard.KeyCode.from_char('q'):
            print("Quitting…")
            return False  # stop listener

def main():
    print("LLM Screen Watcher (Windows + Gemini)")
    print("Hotkeys: Alt+I describe + speak TL;DR | Alt+W define + speak | Alt+P pause/resume | Alt+Q quit")
    print("Make sure GEMINI_API_KEY is set. Keep this window open while running.\n")

    m_listener = mouse.Listener(on_move=on_move)
    m_listener.start()

    with keyboard.Listener(on_press=on_key_press, on_release=on_key_release) as k_listener:
        k_listener.join()

if __name__ == "__main__":
    main()
