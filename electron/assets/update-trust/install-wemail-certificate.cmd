@echo off
setlocal

set "SCRIPT_DIR=%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%install-wemail-test-certificate.ps1"

echo.
echo Press any key to close this window.
pause >nul
