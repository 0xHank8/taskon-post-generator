@echo off
setlocal DisableDelayedExpansion
pushd "%~dp0" || goto folder_error

if not exist "server.mjs" goto folder_error
for %%N in ("node.exe" "%ProgramFiles%\nodejs\node.exe") do (
  "%%~N" -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)" >nul 2>&1
  if not errorlevel 1 (
    set "TASKON_NODE=%%~N"
    goto launch
  )
)

echo Node.js 24 or newer is required. Install it from https://nodejs.org/ and try again.
pause
popd
exit /b 1

:launch
"%TASKON_NODE%" --use-system-ca ".\server.mjs" --open
set "TASKON_EXIT=%errorlevel%"
if not "%TASKON_EXIT%"=="0" pause
popd
exit /b %TASKON_EXIT%

:folder_error
echo Could not find the app files. Extract the entire folder, then run Start-TaskOn.cmd again.
pause
exit /b 1
