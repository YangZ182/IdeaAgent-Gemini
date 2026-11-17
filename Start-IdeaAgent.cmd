@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
    echo Python environment is missing. See README.md for setup.
    pause
    exit /b 1
)
if not exist "InsightToast-demo\frontend\dist\index.html" (
    echo IdeaAgent frontend build is missing. See README.md for build commands.
    pause
    exit /b 1
)
set "PATH=%CD%\.tools\ffmpeg-7.1.1-full_build-shared\bin;%PATH%"
echo Open IdeaAgent at http://127.0.0.1:4344/
".venv\Scripts\python.exe" -m uvicorn idea_agent:app --host 127.0.0.1 --port 4344 --no-access-log
if errorlevel 1 pause
