@echo off
setlocal

set "INSTALL_DIR=%~dp0"
set "SCRIPT=%INSTALL_DIR%resources\assets\update-trust\install-wemail-test-certificate.ps1"
set "EXE=%INSTALL_DIR%WeMailDesktop.exe"

if not exist "%EXE%" set "EXE=%INSTALL_DIR%WeMail.exe"

if not exist "%SCRIPT%" (
  echo WeMail certificate installer was not found:
  echo %SCRIPT%
  echo.
  echo Please run this script from the WeMail installation directory.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -WeMailExe "%EXE%"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if "%EXIT_CODE%"=="0" (
  echo WeMail certificate trust has been installed. Restart WeMail and try updating again.
) else (
  echo WeMail certificate trust installation failed with exit code %EXIT_CODE%.
)

echo.
echo Press any key to close this window.
pause >nul
exit /b %EXIT_CODE%
