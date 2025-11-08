import io, os, re, time, threading
from dataclasses import dataclass
from typing import List, Optional
import google.generativeai as genai
from PIL import Image, ImageGrab
import mss, pytesseract
from pynput import keyboard, mouse
import win32com.client

# --- Optional COM & voice libs ---
try: import pythoncom
except Exception: pythoncom = None
try: import speech_recognition as sr
except Exception: sr = None

# --- CONFIG ---
pytesseract.pytesseract.tesseract_cmd = r"C:\Users\sanga\Tesseract\tesseract.exe"
MODEL_VISION = "gemini-2.5-flash"
MODEL_TEXT   = "gemini-2.5-flash"
SCREEN_DOWNSCALE_MAX = 1600
CURSOR_CROP = (420, 240)
OCR_LANG = "eng"
DENYLIST_TITLES = ["password","bank","1password","lastpass","bitwarden","settings","windows security","microsoft account"]
PRIVACY_DEFAULT_PAUSED = False

# Voice tuning
MIC_DEVICE_HINT = None
SR_LANGUAGE = "en-US"
ADJUST_NOISE_DURATION = 1.0
ENERGY_BASELINE = 250
DYNAMIC_ENERGY = True
PAUSE_THRESHOLD = 0.5
NON_SPEECH_DURATION = 0.3
PHRASE_TIME_LIMIT = 4.0
START_TIMEOUT = 4.0
RETRY_ON_NO_SPEECH = 0
VOICE_ACTIVE = True       # starts listening immediately

# --- STATE ---
@dataclass
class State:
    paused: bool = PRIVACY_DEFAULT_PAUSED
    listening: bool = VOICE_ACTIVE

state = State()
current_mouse_pos = (0, 0)
pressed_keys = set()

# --- LLM SETUP ---
API_KEY = os.getenv("GEMINI_API_KEY")
if not API_KEY:
    raise RuntimeError("Set GEMINI_API_KEY environment variable before running.")
genai.configure(api_key=API_KEY)
vision = genai.GenerativeModel(MODEL_VISION)
text   = genai.GenerativeModel(MODEL_TEXT)

# --- UTIL ---
def speak(t, rate=0, volume=100):
    try:
        if pythoncom: pythoncom.CoInitialize()
        v = win32com.client.Dispatch("SAPI.SpVoice")
        v.Rate, v.Volume = rate, volume
        v.Speak(t)
    except Exception as e: print("[TTS]", e)
    finally:
        if pythoncom:
            try: pythoncom.CoUninitialize()
            except: pass

def sanitize_ascii(s, max_len=1800): return (s or "").replace("\u0000","").strip()[:max_len]

try: import win32gui
except: win32gui = None
def active_window_title():
    if not win32gui: return ""
    try: return win32gui.GetWindowText(win32gui.GetForegroundWindow()).lower()
    except: return ""
def should_block_by_title(t): return any(b in (t or "").lower() for b in DENYLIST_TITLES)

def downscale(img, max_edge):
    w,h = img.size; le = max(w,h)
    if le<=max_edge: return img
    sc = max_edge/le; return img.resize((int(w*sc),int(h*sc)))

def pil_to_bytes(img): buf=io.BytesIO(); img.save(buf,format="JPEG",quality=85); return buf.getvalue()
def capture_fullscreen():
    with mss.mss() as sct:
        m = sct.monitors[0]; raw=sct.grab(m)
        return Image.frombytes("RGB",(raw.width,raw.height),raw.rgb)
def capture_region(x,y,w,h): return ImageGrab.grab(bbox=(x,y,x+w,y+h))

# --- OCR HELPERS ---
def ocr_words_with_boxes(img):
    d=pytesseract.image_to_data(img,output_type=pytesseract.Output.DICT,lang=OCR_LANG)
    out=[]
    for i,t in enumerate(d["text"]):
        t=t.strip()
        if t: out.append({"text":t,"left":d["left"][i],"top":d["top"][i],"width":d["width"][i],"height":d["height"][i]})
    return out
def nearest_word_to_point(words,px,py):
    best,bestd=None,None
    for w in words:
        cx=w["left"]+w["width"]/2; cy=w["top"]+w["height"]/2
        d=(cx-px)**2+(cy-py)**2
        if bestd is None or d<bestd: best,bestd=w,d
    return best["text"] if best else None

# --- GEMINI ACTIONS ---
def extract_tldr(s):
    if not s: return None
    m=re.search(r"(?im)^\s*tl;?\s*d\r?\s*r[:\-]?\s*(.+)$",s)
    if m: return m.group(1).strip()
    lines=[ln.strip() for ln in s.splitlines() if ln.strip()]
    return lines[-1] if lines and len(lines[-1])<300 else None

def describe_screen():
    from utils.screen_describer import ScreenDescriber, ScreenConfig
    config = ScreenConfig(max_edge=SCREEN_DOWNSCALE_MAX, denylist_titles=DENYLIST_TITLES)
    describer = ScreenDescriber(
        vision_generate=lambda x: vision.generate_content(x),
        active_window_title=active_window_title,
        speak=speak,
        config=config
    )
    result = describer.describe(paused=state.paused)
    
    if result["status"] == "paused":
        print("[Paused]")
    elif result["status"] == "blocked":
        print(f"[Privacy] {result['title']}")
    elif result["status"] == "error":
        print(f"[Gemini describe] {result['error']}")
    else:
        print("\n[Description]\n", result["description"])

def define_word_under_mouse():
    if state.paused: return print("[Paused]")
    t=active_window_title()
    if should_block_by_title(t): return print(f"[Privacy] {t}")
    mx,my=current_mouse_pos; rw,rh=CURSOR_CROP; x,y=max(0,mx-rw//2),max(0,my-rh//2)
    img=capture_region(x,y,rw,rh)
    words=ocr_words_with_boxes(img)
    if not words: return print("No words near cursor.")
    w=nearest_word_to_point(words,rw//2,rh//2)
    if not w: return print("No word found.")
    try:
        r=text.generate_content(f"Define '{w}' in one sentence plus 2 examples and 3 synonyms.")
        out=sanitize_ascii(r.text)
        print(f"\n[Definition: {w}]\n",out)
        speak(f"Definition for {w}. {out}")
    except Exception as e: print("[Gemini define]",e)

# --- VOICE DETECTION ---
VOICE_HINT_I = re.compile(r"\bhey\s+gemini\b.*\bon\s+my\s+screen\b",re.I)
VOICE_HINT_W = re.compile(r"\bhey\s+gemini\b.*\bword\b.*\b(mouse|cursor)\b",re.I)

def _choose_mic():
    if sr is None: return None
    try:
        names=sr.Microphone.list_microphone_names()
        if MIC_DEVICE_HINT:
            for i,n in enumerate(names):
                if MIC_DEVICE_HINT.lower() in n.lower(): return i
        return None
    except Exception as e:
        print("[Mic list]",e); return None

def continuous_listener():
    if sr is None:
        print("[Voice] speech_recognition not installed.")
        return
    idx=_choose_mic(); r=sr.Recognizer()
    r.energy_threshold=ENERGY_BASELINE; r.dynamic_energy_threshold=DYNAMIC_ENERGY
    print("[Voice] Always-listening thread started.")
    with sr.Microphone(device_index=idx) as src:
        r.adjust_for_ambient_noise(src,duration=ADJUST_NOISE_DURATION)
        while True:
            if not state.listening:
                time.sleep(0.3); continue
            try:
                audio=r.listen(src,timeout=START_TIMEOUT,phrase_time_limit=PHRASE_TIME_LIMIT)
                said=r.recognize_google(audio,language=SR_LANGUAGE).lower()
                if said: print("[Heard]",said)
                if VOICE_HINT_I.search(said): describe_screen()
                elif VOICE_HINT_W.search(said): define_word_under_mouse()
            except sr.WaitTimeoutError: continue
            except sr.UnknownValueError: continue
            except Exception as e: print("[Voice loop]",e); time.sleep(1)

# --- HOTKEYS ---
def on_move(x,y): global current_mouse_pos; current_mouse_pos=(x,y)
def on_key_press(k): pressed_keys.add(k)
def on_key_release(k):
    if k in pressed_keys: pressed_keys.remove(k)
    alt_down=any(a in pressed_keys for a in (keyboard.Key.alt,keyboard.Key.alt_l,keyboard.Key.alt_r))
    if alt_down:
        if k==keyboard.KeyCode.from_char("i"): describe_screen()
        elif k==keyboard.KeyCode.from_char("w"): define_word_under_mouse()
        elif k==keyboard.KeyCode.from_char("p"):
            state.paused=not state.paused; speak("Privacy "+("paused" if state.paused else "resumed"))
        elif k==keyboard.KeyCode.from_char("l"):
            state.listening=not state.listening
            speak("Voice listening "+("on" if state.listening else "off"))
            print("[Voice listening]",state.listening)
        elif k==keyboard.KeyCode.from_char("q"):
            speak("Shutting down."); os._exit(0)

# --- MAIN ---
def main():
    print("LLM Screen Watcher (Always-Listening Mode)")
    print("Say:  'Hey Gemini, what’s on my screen?'  or  'Hey Gemini, what’s the word under my mouse?'")
    print("Hotkeys: Alt+I describe | Alt+W define | Alt+L toggle listening | Alt+P pause | Alt+Q quit\n")
    if sr is None:
        print("Install with:  pip install SpeechRecognition pyaudio\n")
    else:
        threading.Thread(target=continuous_listener,daemon=True).start()
    m_listener=mouse.Listener(on_move=on_move); m_listener.start()
    with keyboard.Listener(on_press=on_key_press,on_release=on_key_release) as kl: kl.join()

if __name__=="__main__": main()
