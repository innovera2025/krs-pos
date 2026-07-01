@echo off
chcp 65001 >nul
setlocal EnableExtensions
title KRS POS - Kiosk Print Setup
REM  *** IN-PRODUCT COPY — served at /kiosk-print-setup.bat by Next.js static asset ***
REM  *** Keep in sync with deploy/kiosk-print-setup.bat (the canonical source). ***

REM ============================================================================
REM  KRS POS - One-click silent thermal-receipt printing setup (Windows)
REM ----------------------------------------------------------------------------
REM  Run this file ONCE on a shop PC. It:
REM    1. Finds Microsoft Edge (preferred) or Google Chrome.
REM    2. Sets the thermal receipt printer as the Windows DEFAULT printer.
REM    3. Creates a Desktop shortcut "KRS POS" that launches the POS in an
REM       isolated browser instance with Chromium's --kiosk-printing flag, so
REM       window.print() prints SILENTLY to the default printer (no dialog).
REM
REM  Safe to re-run: it just overwrites the shortcut and re-applies settings.
REM
REM  NOTE ON ELEVATION: setting the *current user's* default printer with
REM  printui /y does NOT require administrator rights. If it does not stick,
REM  the "%PRINTER%" driver is probably not installed yet (install it, or run
REM  this file as Administrator once). This script never fails silently: it
REM  echoes the current default printer at the end so you can confirm.
REM ============================================================================

REM ---- CONFIG (edit these per shop if needed) --------------------------------
REM  NOTE: ?kiosk=1 tells the web app this is the kiosk shortcut session.
REM  The app persists this to localStorage -> suppresses the onboarding modal.
REM  Keep in sync with public/kiosk-print-setup.bat (the in-product download copy).
set "POS_URL=https://krspos.innoveraappcenter.com/?kiosk=1"
set "PRINTER=XP-80C"
set "PROFILE_DIR=%LOCALAPPDATA%\KrsPosKiosk"

REM ---- Resolve Program Files roots ------------------------------------------
REM  Capture %ProgramFiles(x86)% on its own line: the "(x86)" in the name
REM  breaks batch parsing if used inside an if-block, so store it in PFX86.
set "PF=%ProgramFiles%"
set "PFX86=%ProgramFiles(x86)%"

REM ---- Candidate browser executables (Edge first, then Chrome) ---------------
set "EDGE1=%PFX86%\Microsoft\Edge\Application\msedge.exe"
set "EDGE2=%PF%\Microsoft\Edge\Application\msedge.exe"
set "CHROME1=%PF%\Google\Chrome\Application\chrome.exe"
set "CHROME2=%PFX86%\Google\Chrome\Application\chrome.exe"

set "BROWSER="
set "BROWSER_NAME="
if not defined BROWSER if exist "%EDGE1%"   ( set "BROWSER=%EDGE1%"   & set "BROWSER_NAME=Microsoft Edge" )
if not defined BROWSER if exist "%EDGE2%"   ( set "BROWSER=%EDGE2%"   & set "BROWSER_NAME=Microsoft Edge" )
if not defined BROWSER if exist "%CHROME1%" ( set "BROWSER=%CHROME1%" & set "BROWSER_NAME=Google Chrome" )
if not defined BROWSER if exist "%CHROME2%" ( set "BROWSER=%CHROME2%" & set "BROWSER_NAME=Google Chrome" )

if not defined BROWSER goto :no_browser

echo.
echo ============================================================
echo   KRS POS - Kiosk Print Setup
echo ============================================================
echo   Browser : %BROWSER_NAME%
echo             "%BROWSER%"
echo   Printer : %PRINTER%
echo   POS URL : %POS_URL%
echo   Profile : %PROFILE_DIR%
echo ============================================================
echo.

REM ---- 1) Set the receipt printer as the Windows default printer -------------
echo [1/3] Setting "%PRINTER%" as the Windows default printer ...
rundll32 printui.dll,PrintUIEntry /y /n "%PRINTER%"

REM ---- 2) Create the isolated browser profile directory ---------------------
echo [2/3] Preparing isolated browser profile ...
if not exist "%PROFILE_DIR%" mkdir "%PROFILE_DIR%"

REM ---- 3) Create / overwrite the Desktop "KRS POS" shortcut -----------------
REM  Built via WScript.Shell in PowerShell. The batch vars are already
REM  environment variables, so PowerShell reads them as $env:...  We use
REM  [char]34 for the embedded double quotes around the profile path to avoid
REM  any cmd/PowerShell quote-escaping issues. Resulting Arguments are exactly:
REM    --kiosk-printing --user-data-dir="<PROFILE_DIR>" --app=<POS_URL>
echo [3/3] Creating Desktop shortcut "KRS POS" ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$q=[char]34; $ws=New-Object -ComObject WScript.Shell; $desktop=[Environment]::GetFolderPath('Desktop'); $lnk=Join-Path $desktop 'KRS POS.lnk'; $sc=$ws.CreateShortcut($lnk); $sc.TargetPath=$env:BROWSER; $sc.Arguments='--kiosk-printing --user-data-dir=' + $q + $env:PROFILE_DIR + $q + ' --app=' + $env:POS_URL; $sc.WorkingDirectory=Split-Path $env:BROWSER; $sc.IconLocation=$env:BROWSER + ',0'; $sc.Description='KRS POS kiosk-print'; $sc.Save(); Write-Host ('  Shortcut : ' + $lnk); Write-Host ('  Arguments: ' + $sc.Arguments)"

REM ---- Confirm the current default printer (non-silent verification) ---------
set "CURDEF="
for /f "usebackq delims=" %%D in (`powershell -NoProfile -Command "(Get-CimInstance Win32_Printer | Where-Object { $_.Default -eq $true }).Name"`) do set "CURDEF=%%D"
if not defined CURDEF set "CURDEF=(unknown)"

echo.
echo ============================================================
echo   ตั้งค่าเสร็จสมบูรณ์!  /  SETUP COMPLETE!
echo ============================================================
echo.
echo   เครื่องพิมพ์เริ่มต้นปัจจุบัน / Current default printer: %CURDEF%
echo.
echo  [TH] เปิดระบบขายหน้าร้าน (POS) โดยดับเบิลคลิกไอคอน "KRS POS"
echo       บนหน้าจอเดสก์ท็อปเท่านั้น (อย่าเปิดจากเบราว์เซอร์ปกติ)
echo       - ครั้งแรกต้องเข้าสู่ระบบ (login) หนึ่งครั้ง จากนั้นระบบจะจำไว้
echo       - เมื่อกดยืนยันการชำระเงิน ใบเสร็จจะพิมพ์ออกเครื่อง "%PRINTER%"
echo         ทันที โดยไม่มีหน้าต่างสั่งพิมพ์
echo.
echo  [EN] Open the POS ONLY by double-clicking the "KRS POS" icon on the
echo       Desktop (do not use your everyday browser window).
echo       - First launch needs a one-time POS login; it is remembered after.
echo       - On payment confirm the receipt prints silently to "%PRINTER%"
echo         with no print dialog.
echo.
echo  ถ้าเครื่องพิมพ์เริ่มต้นด้านบนไม่ใช่ "%PRINTER%" ให้ติดตั้งไดรเวอร์
echo  ของเครื่องพิมพ์ก่อน แล้วรันไฟล์นี้อีกครั้ง (หรือรันแบบ Run as administrator)
echo  If the default printer above is not "%PRINTER%", install its driver
echo  first, then run this file again (or Run as administrator once).
echo.
pause
endlocal
exit /b 0

:no_browser
echo.
echo ============================================================
echo   ไม่พบเบราว์เซอร์  /  NO SUPPORTED BROWSER FOUND
echo ============================================================
echo.
echo  [TH] ไม่พบ Microsoft Edge หรือ Google Chrome บนเครื่องนี้
echo       กรุณาติดตั้ง Microsoft Edge หรือ Google Chrome ก่อน
echo       แล้วดับเบิลคลิกไฟล์นี้อีกครั้ง
echo  [EN] Neither Microsoft Edge nor Google Chrome was found on this PC.
echo       Please install Microsoft Edge or Google Chrome, then double-click
echo       this file again.
echo.
echo  Checked:
echo    "%EDGE1%"
echo    "%EDGE2%"
echo    "%CHROME1%"
echo    "%CHROME2%"
echo.
pause
endlocal
exit /b 1
