@echo off
REM Convenience wrapper; resolve paths relative to this checkout.
setlocal
set "WEMAIL_REPO_ROOT=%~dp0.."
if not defined PLAYWRIGHT_BROWSERS_PATH set "PLAYWRIGHT_BROWSERS_PATH=%WEMAIL_REPO_ROOT%\.playwright-browsers"

echo [run-browser-tests.bat] PLAYWRIGHT_BROWSERS_PATH=%PLAYWRIGHT_BROWSERS_PATH%
echo [run-browser-tests.bat] Running: npm run test:browser %*
echo.

pushd "%WEMAIL_REPO_ROOT%" || exit /b 1
call npm run test:browser %*
set "WEMAIL_TEST_EXIT=%ERRORLEVEL%"
popd
exit /b %WEMAIL_TEST_EXIT%
