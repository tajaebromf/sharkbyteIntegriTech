# Requirements: 
Python 3.11 or higher
Gemini API Key

# Running the FastAPI app (Windows PowerShell)
1) Create a virtual environment (optional but recommended):

   python -m venv .venv
   
   .\.venv\Scripts\Activate.ps1

3) Install dependencies:

   python -m pip install --upgrade pip; python -m pip install -r requirements.txt

4) Initialize your Gemini Api Key using: 

   $env:GEMINI_API_KEY =""

6) Run the app with uvicorn:

      development with auto-reload
   uvicorn app:app --reload --host 127.0.0.1 --port 8000

7) API docs

   - Open http://127.0.0.1:8000/docs for Swagger UI
   - Open http://127.0.0.1:8000/redoc for ReDoc

Notes:
- The file `app.py` is a minimal skeleton and intentionally does NOT integrate with the
  `screen_watcher_windows_gemini` module.
