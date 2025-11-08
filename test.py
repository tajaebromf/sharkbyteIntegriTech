import google.generativeai as genai
import os

# Option 1: if you already exported the environment variable earlier
genai.configure(api_key=os.getenv("GEMINI_API_KEY"))

# Option 2: quick test (hardcode your key here)
# genai.configure(api_key="AIzaSyDuLxMt-l62UEWpHu8qFXKXyYpk2JR065Y")

for m in genai.list_models():
    if "generateContent" in getattr(m, "supported_generation_methods", []):
        print(m.name)
