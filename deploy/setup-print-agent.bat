@echo off
chcp 65001 >nul
setlocal EnableExtensions
title KRS POS - Print Agent Setup

REM ============================================================================
REM  KRS POS - Local Silent Print Agent - one-click installer (Windows)
REM ----------------------------------------------------------------------------
REM  Run this file ONCE on a shop PC, with krs-print-agent.exe sitting NEXT TO
REM  it in the same folder. It:
REM    1. Copies krs-print-agent.exe to %LOCALAPPDATA%\KrsPrintAgent\.
REM    2. Sets the thermal receipt printer (XP-80C) as the Windows DEFAULT and
REM       locks that default (LegacyDefaultPrinterMode=1) so it sticks.
REM    3. Registers the agent to auto-start HIDDEN on every Windows logon (a
REM       .vbs launcher in the user Startup folder - NO console window, no admin).
REM    4. Starts the agent now and pings http://127.0.0.1:9100/health.
REM
REM  After this runs, the cashier just opens the POS in ANY normal browser -
REM  receipts print silently with no print dialog. No desktop shortcut needed.
REM
REM  Safe to re-run: it stops any running agent, re-copies the .exe, and
REM  re-applies every setting (idempotent).
REM
REM  SMARTSCREEN: a .bat / .exe downloaded from the internet may trigger a
REM  Windows security warning. If you see it, click "More info" then "Run anyway".
REM
REM  ELEVATION: setting the CURRENT USER's default printer + a per-user Startup
REM  entry does NOT need administrator rights. If the default does not stick, the
REM  "%PRINTER%" driver is probably not installed yet (install it, or run this
REM  once as Administrator). This script never fails silently - it echoes the
REM  current default printer and the agent health result at the end.
REM
REM  UNINSTALL: change ACTION below from "install" to "uninstall", then run this
REM  file again. It stops the agent and removes the folder + Startup entry.
REM ============================================================================

REM ---- CONFIG (edit per shop if needed) -------------------------------------
set "ACTION=install"
set "PRINTER=XP-80C"
set "PORT=9100"
set "SRC_EXE=%~dp0krs-print-agent.exe"
set "AGENT_DIR=%LOCALAPPDATA%\KrsPrintAgent"
set "AGENT_EXE=%AGENT_DIR%\krs-print-agent.exe"
set "LAUNCH_VBS=%AGENT_DIR%\launch-hidden.vbs"
set "STARTUP_SHORTCUT=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\KRS Print Agent.lnk"

if /i "%ACTION%"=="uninstall" goto :uninstall

REM ---- Pre-flight: the .exe must sit next to this .bat ----------------------
if not exist "%SRC_EXE%" goto :no_exe

echo.
echo ============================================================
echo   KRS POS - Print Agent Setup
echo ============================================================
echo   Source .exe : "%SRC_EXE%"
echo   Install dir : %AGENT_DIR%
echo   Printer     : %PRINTER%
echo   Autostart   : %STARTUP_SHORTCUT%
echo   Health URL  : http://127.0.0.1:%PORT%/health
echo ============================================================
echo.

REM ---- 1) Stop any running agent so the .exe can be replaced -----------------
REM  On Windows a running .exe is file-locked; copying over it fails. Kill first
REM  (also lets a re-run cleanly pick up a newer build). Ignore "not found".
echo [1/6] Stopping any running agent ...
taskkill /F /IM krs-print-agent.exe /T >nul 2>&1

REM ---- 2) Create the install folder + copy the .exe -------------------------
echo [2/6] Installing agent to "%AGENT_DIR%" ...
if not exist "%AGENT_DIR%" mkdir "%AGENT_DIR%"
copy /Y "%SRC_EXE%" "%AGENT_EXE%" >nul
if not exist "%AGENT_EXE%" (
  echo   ERROR: failed to copy the agent .exe. Close any running copy and retry.
  echo   ไม่สามารถคัดลอกไฟล์ .exe ได้ - ปิดโปรแกรมที่เปิดค้างแล้วลองใหม่
  pause
  endlocal
  exit /b 1
)

REM ---- 3) Set the receipt printer as the Windows default (and LOCK it) -------
REM  Disable "Let Windows manage my default printer" so the default STICKS, then
REM  set it. LegacyDefaultPrinterMode=1 (HKCU, no admin) is the classic manual
REM  default mode; without it Windows auto-switches to the last-used printer.
echo [3/6] Locking the default printer to "%PRINTER%" ...
reg add "HKCU\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Windows" /v LegacyDefaultPrinterMode /t REG_DWORD /d 1 /f >nul
rundll32 printui.dll,PrintUIEntry /y /n "%PRINTER%"

REM ---- 4) Write the hidden launcher + register autostart --------------------
REM  A tiny .vbs launches the console .exe with window mode 0 (fully HIDDEN - no
REM  console flash on boot), better than a WindowStyle=7 (minimised) shortcut.
REM  The Startup .lnk runs wscript.exe on that .vbs at every logon.
echo [4/6] Registering hidden autostart ...
> "%LAUNCH_VBS%" echo Set sh = CreateObject("WScript.Shell")
>>"%LAUNCH_VBS%" echo sh.CurrentDirectory = "%AGENT_DIR%"
>>"%LAUNCH_VBS%" echo sh.Run """%AGENT_EXE%""", 0, False
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws=New-Object -ComObject WScript.Shell; $sc=$ws.CreateShortcut($env:STARTUP_SHORTCUT); $sc.TargetPath='wscript.exe'; $sc.Arguments=[char]34 + $env:LAUNCH_VBS + [char]34; $sc.WindowStyle=7; $sc.WorkingDirectory=$env:AGENT_DIR; $sc.Description='KRS Print Agent'; $sc.Save(); Write-Host ('  Startup  : ' + $env:STARTUP_SHORTCUT)"

REM ---- 5) Start the agent now (hidden, via the same launcher) ---------------
echo [5/6] Starting the agent ...
wscript.exe "%LAUNCH_VBS%"

REM ---- 6) Wait, then verify it answers on the health endpoint ---------------
echo [6/6] Verifying the agent responds on port %PORT% ...
timeout /t 2 /nobreak >nul
set "AGENT_OK="
curl -s http://127.0.0.1:%PORT%/health 2>nul | findstr /C:"krs-print-agent" >nul 2>&1 && set "AGENT_OK=1"

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
if defined AGENT_OK (
  echo   สถานะ Print Agent / Agent status: กำลังทำงาน RUNNING  ^(http://127.0.0.1:%PORT%^)
) else (
  echo   สถานะ Print Agent / Agent status: ยังไม่ตอบสนอง NOT RESPONDING
  echo     - ตรวจสอบว่าไม่มีโปรแกรมอื่นใช้พอร์ต %PORT% / check nothing else uses port %PORT%
  echo     - ลองรันไฟล์นี้อีกครั้ง / try running this file again
)
echo.
echo  [TH] เปิดระบบขาย (POS) ในเบราว์เซอร์ปกติได้เลย - เมื่อกดยืนยันชำระเงิน
echo       ใบเสร็จจะพิมพ์ออกเครื่อง "%PRINTER%" ทันที โดยไม่มีหน้าต่างสั่งพิมพ์
echo       ไม่ต้องใช้ไอคอนพิเศษบนเดสก์ท็อปอีกต่อไป
echo.
echo  [EN] Open the POS in ANY normal browser. On payment confirm the receipt
echo       prints silently to "%PRINTER%" with no dialog. No special desktop
echo       icon is needed anymore. The agent auto-starts hidden on every logon.
echo.
echo  ------------------------------------------------------------
echo   ทดสอบการพิมพ์ / SELF-TEST (print a Thai sample receipt now):
echo       "%AGENT_EXE%" --test
echo.
echo   เปลี่ยนรหัสภาษาไทย (codepage) หรือชื่อเครื่องพิมพ์ โดยไม่ต้อง build ใหม่:
echo   Change the Thai codepage / printer WITHOUT a rebuild - either set an
echo   environment variable, OR create a file next to the .exe:
echo       "%AGENT_DIR%\config.local.json"   e.g.  { "THAI_CODEPAGE": 21, "PRINTER_NAME": "%PRINTER%" }
echo   หรือไฟล์ .env :  "%AGENT_DIR%\.env"    e.g.  KRS_THAI_CODEPAGE=21
echo   (ลองค่า 20 -^> 21 -^> 18 -^> 17 จนภาษาไทยถูกต้อง / try 20 -^> 21 -^> 18 -^> 17)
echo   หลังแก้ไฟล์ ให้ปิดแล้วเปิดเครื่องใหม่ หรือรันไฟล์นี้อีกครั้ง / then reboot or re-run this file.
echo  ------------------------------------------------------------
echo.
echo  ถ้าเครื่องพิมพ์เริ่มต้นด้านบนไม่ใช่ "%PRINTER%" ให้ติดตั้งไดรเวอร์ก่อน
echo  แล้วรันไฟล์นี้อีกครั้ง (หรือรันแบบ Run as administrator หนึ่งครั้ง)
echo  If the default printer above is not "%PRINTER%", install its driver first,
echo  then run this file again (or Run as administrator once).
echo.
pause
endlocal
exit /b 0

:no_exe
echo.
echo ============================================================
echo   ไม่พบไฟล์ krs-print-agent.exe  /  AGENT .EXE NOT FOUND
echo ============================================================
echo.
echo  [TH] ไม่พบไฟล์ "krs-print-agent.exe" ในโฟลเดอร์เดียวกับไฟล์ติดตั้งนี้
echo       กรุณาดาวน์โหลด krs-print-agent.exe แล้ววางไว้ในโฟลเดอร์เดียวกับ
echo       ไฟล์ setup-print-agent.bat นี้ จากนั้นดับเบิลคลิกอีกครั้ง
echo  [EN] "krs-print-agent.exe" was not found next to this installer.
echo       Download krs-print-agent.exe and place it in the SAME folder as
echo       this setup-print-agent.bat, then double-click this file again.
echo.
echo  Looked for:
echo    "%SRC_EXE%"
echo.
pause
endlocal
exit /b 1

:uninstall
echo.
echo ============================================================
echo   KRS POS - Print Agent UNINSTALL
echo ============================================================
echo.
echo  Stopping agent, removing Startup entry, and deleting "%AGENT_DIR%" ...
taskkill /F /IM krs-print-agent.exe /T >nul 2>&1
if exist "%STARTUP_SHORTCUT%" del /Q "%STARTUP_SHORTCUT%" >nul 2>&1
if exist "%LAUNCH_VBS%" del /Q "%LAUNCH_VBS%" >nul 2>&1
if exist "%AGENT_EXE%" del /Q "%AGENT_EXE%" >nul 2>&1
if exist "%AGENT_DIR%" rmdir /S /Q "%AGENT_DIR%" >nul 2>&1
echo.
echo  ถอนการติดตั้งเรียบร้อย / Uninstalled.
echo  (ค่าเครื่องพิมพ์เริ่มต้นของ Windows ไม่ได้ถูกเปลี่ยน / the Windows default
echo   printer setting was left as-is - change it manually if you wish.)
echo.
pause
endlocal
exit /b 0
