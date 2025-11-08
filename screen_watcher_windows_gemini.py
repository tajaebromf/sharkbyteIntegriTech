import io
import os
from dataclasses import dataclass
from typing import List, Optional
import re
import time

import google.generativeai as genai
from PIL import Image, ImageGrab
import mss
import pytesseract
from pynput import keyboard, mouse
import win32com.client
try:
    import pythoncom  # COM init for TTS on listener threads
except Exception:
    pythoncom = None

# === Optional voice input deps ===
try:
    import speech_recognition as sr
except Exception:
    sr = None  # fallback gracefully if not installed

pytesseract.pytesseract.tesseract_cmd = r"C:\Users\sanga\Tesseract\tesseract.exe"

# Windows: active window title for privacy guard
try:
    import win32gui
except Exception:
    win32gui = None

# ---------------- CONFIG ----------------
MODEL_VISION = "gemini-2.5-flash"
MODEL_TEXT   = "gemini-2.5-flash"

SCREEN_DOWNSCALE_MAX = 1600
CURSOR_CROP = (420, 240)
OCR_LANG = "eng"

DENYLIST_TITLES = [
    "password", "bank", "1password", "lastpass", "bitwarden",
    "settings", "windows security", "microsoft account"
]

PRIVACY_DEFAULT_PAUSED = False

# Voice behavior
VOICE_LISTEN_ON_HOTKEY = True             # hotkey triggers voice capture first
VOICE_TIMEOUT = 5.0                        # seconds to start speech
VOICE_PHRASE_TIME_LIMIT = 5.0              # max utterance length
BYPASS_DOUBLE_TAP_WINDOW = 0.5             # seconds (double-tap Alt+key = instant action)

# ---------------- STATE ----------------
@dataclass
class State:
    paused: bool = PRIVACY_DEFAULT_PAUSED

state = State()
current_mouse_pos = (0, 0)
pressed_keys = set()
last_hotkey_times = {"i": 0.0, "w": 0.0}

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
        monitor = sct.monitors[0]
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
        v.Rate = rate
        v.Volume = volume
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
    m = re.search(r'(?im)^\s*tl;?\s*d\r?\s*r[:\-]?\s*(.+)$', s)
    if m:
        return m.group(1).strip()
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

# ---------------- VOICE INPUT HELPERS ----------------
VOICE_HINT_I = re.compile(
    r"\bhey\s+gemini\b.*\b(what('?| i)s|whats)\b.*\bon\s+my\s+screen\b",
    re.IGNORECASE
)
VOICE_HINT_W = re.compile(
    r"\bhey\s+gemini\b.*\b(what('?| i)s|whats)\b.*\bword\b.*\bunder\b.*\b(mouse|cursor)\b",
    re.IGNORECASE
)

def listen_and_transcribe(timeout: float, phrase_time_limit: float) -> Optional[str]:
    if sr is None:
        print("[Voice] speech_recognition not installed; skipping voice input.")
        return None
    try:
        r = sr.Recognizer()
        with sr.Microphone() as source:
            r.adjust_for_ambient_noise(source, duration=0.3)
            audio = r.listen(source, timeout=timeout, phrase_time_limit=phrase_time_limit)
        try:
            text_result = r.recognize_google(audio)
            return (text_result or "").strip()
        except sr.UnknownValueError:
            return None
        except sr.RequestError as e:
            print(f"[Voice] Recognition request error: {e}")
            return None
    except Exception as e:
        print(f"[Voice] Error accessing microphone: {e}")
        return None

def ask_and_match(prompt_voice: str, matcher: re.Pattern) -> bool:
    """
    Speak a 'Listening...' cue, capture voice, check regex match.
    Return True if matched phrase, False if not; None/False mean 'fallback/auto-run'.
    """
    try:
        speak(prompt_voice, rate=0)
    except Exception:
        pass
    said = listen_and_transcribe(VOICE_TIMEOUT, VOICE_PHRASE_TIME_LIMIT)
    if said:
        print(f"[Heard] {said}")
        if matcher.search(said):
            return True
        else:
            print("[Voice] Phrase didn’t match trigger.")
            try:
                speak("I didn't catch the trigger.", rate=0)
            except Exception:
                pass
            return False
    else:
        print("[Voice] No speech detected (timeout).")
        return False

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

        tldr = extract_tldr(out)
        if tldr:
            speak("Summary. " + tldr, rate=0)
        else:
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

    # Modifier states
    alt_down = any(a in pressed_keys for a in (keyboard.Key.alt, keyboard.Key.alt_l, keyboard.Key.alt_r))
    shift_down = any(s in pressed_keys for s in (keyboard.Key.shift, keyboard.Key.shift_l, keyboard.Key.shift_r))

    # Helper: detect double-tap for bypass
    def is_double_tap(key_char: str) -> bool:
        now = time.time()
        prev = last_hotkey_times.get(key_char, 0.0)
        last_hotkey_times[key_char] = now
        return (now - prev) <= BYPASS_DOUBLE_TAP_WINDOW

    if alt_down:
        # Alt + i
        if k == keyboard.KeyCode.from_char('i'):
            bypass = shift_down or is_double_tap('i')
            if not VOICE_LISTEN_ON_HOTKEY or bypass or sr is None:
                describe_screen()
            else:
                ok = ask_and_match(
                    "Listening. Say: Hey Gemini, what's on my screen?",
                    VOICE_HINT_I
                )
                # If matched OR timed-out/not matched, we still proceed to keep flow snappy
                describe_screen()

        # Alt + w
        elif k == keyboard.KeyCode.from_char('w'):
            bypass = shift_down or is_double_tap('w')
            if not VOICE_LISTEN_ON_HOTKEY or bypass or sr is None:
                define_word_under_mouse()
            else:
                ok = ask_and_match(
                    "Listening. Say: Hey Gemini, what's the word under my mouse?",
                    VOICE_HINT_W
                )
                define_word_under_mouse()

        # Alt + p → pause/resume
        elif k == keyboard.KeyCode.from_char('p'):
            state.paused = not state.paused
            msg = f"[Privacy] {'Paused' if state.paused else 'Resumed'}."
            print(msg)
            try:
                speak("Privacy " + ("paused" if state.paused else "resumed"), rate=0)
            except Exception:
                pass

        # Alt + q → quit
        elif k == keyboard.KeyCode.from_char('q'):
            print("Quitting…")
            try:
                speak("Shutting down.", rate=0)
            except Exception:
                pass
            return False  # stop listener

def main():
    print("LLM Screen Watcher (Windows + Gemini + Voice Hotkeys)")
    print("Hotkeys:")
    print("  Alt+I → say:  'Hey Gemini, what's on my screen?'  (speaks TL;DR)")
    print("         Bypass voice: Alt+Shift+I OR double-tap Alt+I")
    print("  Alt+W → say:  'Hey Gemini, what's the word under my mouse?'  (speaks definition)")
    print("         Bypass voice: Alt+Shift+W OR double-tap Alt+W")
    print("  Alt+P → pause/resume   |   Alt+Q → quit")
    print("Make sure GEMINI_API_KEY is set. Keep this window open while running.\n")
    if sr is None:
        print("[Note] speech_recognition not installed — voice prompts will be skipped. Install with:")
        print("       pip install SpeechRecognition pyaudio\n")

    m_listener = mouse.Listener(on_move=on_move)
    m_listener.start()

    with keyboard.Listener(on_press=on_key_press, on_release=on_key_release) as k_listener:
        k_listener.join()

if __name__ == "__main__":
    main()
