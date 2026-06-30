@echo off
REM ============================================================
REM  Start the YC Co-Founder Filter server in the project venv.
REM  Double-click this file (no VS Code / no activation needed).
REM ============================================================
setlocal
cd /d "%~dp0"

set "PY=%~dp0.venv\Scripts\python.exe"
set "PORT=8791"

if not exist "%PY%" (
    echo [ERROR] venv Python not found at "%PY%"
    echo Create it first:  python -m venv .venv  ^&^&  .venv\Scripts\python -m pip install -r requirements.txt
    echo.
    pause
    exit /b 1
)

REM --- Free the port if a previous server is still holding it ---
for /f "tokens=5" %%P in ('netstat -ano -p tcp ^| findstr /r /c:":%PORT% .*LISTENING"') do (
    echo [info] Port %PORT% busy ^(PID %%P^) - stopping it...
    taskkill /F /PID %%P >nul 2>&1
)

echo [info] Starting server on http://localhost:%PORT%  (press Ctrl+C to stop)
echo.
"%PY%" run_server.py

echo.
echo [info] Server stopped.
pause
