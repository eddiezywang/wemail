@echo off
REM Run browser E2E tests with D: drive paths for Playwright browsers and temp
REM This is a convenience wrapper — `npm run test:browser` also works.

echo [run-browser-tests.bat] Setting D: drive paths for Playwright...
set PLAYWRIGHT_BROWSERS_PATH=D:\git\wemail\.playwright-browsers
set TEMP=D:\git\wemail\.tmp
set TMP=D:\git\wemail\.tmp

echo [run-browser-tests.bat] PLAYWRIGHT_BROWSERS_PATH=%PLAYWRIGHT_BROWSERS_PATH%
echo [run-browser-tests.bat] Running: npm run test:browser %*
echo.

npm run test:browser %*
