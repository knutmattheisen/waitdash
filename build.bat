@echo off
REM ─────────────────────────────────────────────────────
REM  WaitDash Build Script — Windows
REM  Requirements: Go 1.21+ installed
REM  Run from the project root directory
REM ─────────────────────────────────────────────────────

echo [WaitDash] Downloading dependencies...
go mod tidy

echo [WaitDash] Building Windows executable...
set GOOS=windows
set GOARCH=amd64
set CGO_ENABLED=0

go build -ldflags="-s -w" -o waitdash.exe .

if %ERRORLEVEL% EQU 0 (
    echo.
    echo [WaitDash] BUILD SUCCESSFUL: waitdash.exe
    echo.
    echo Deployment:
    echo   Copy waitdash.exe and servers.json to your admin workstation
    echo   Edit servers.json to match your SQL Server targets
    echo   Run: waitdash.exe
    echo   Open: http://localhost:9090
    echo.
) else (
    echo.
    echo [WaitDash] BUILD FAILED. Check errors above.
)
