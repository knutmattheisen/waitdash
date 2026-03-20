#!/bin/bash
# ─────────────────────────────────────────────────────
#  WaitDash Build Script — Linux / WSL cross-compile
#  Produces: waitdash.exe (Windows amd64)
# ─────────────────────────────────────────────────────

echo "[WaitDash] Downloading dependencies..."
go mod tidy

echo "[WaitDash] Cross-compiling for Windows amd64..."
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
  go build -ldflags="-s -w" -o waitdash.exe .

if [ $? -eq 0 ]; then
  echo ""
  echo "[WaitDash] BUILD SUCCESSFUL: waitdash.exe"
  echo ""
  echo "Deployment:"
  echo "  Copy waitdash.exe + servers.json to your Windows admin workstation"
  echo "  Edit servers.json for your SQL Server targets"
  echo "  Run: waitdash.exe"
  echo "  Open: http://localhost:9090"
else
  echo "[WaitDash] BUILD FAILED."
  exit 1
fi
