@echo off
echo Starting RAG-Debugger server...
echo.
call venv\Scripts\activate.bat
python -m uvicorn main_demo:app --host 0.0.0.0 --port 8000
