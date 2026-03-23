# WaitDash v0.4 — SQL Server Wait Statistics Dashboard

Portable, zero-install DBA tool for near real-time SQL Server wait analysis.
Single Windows executable. No Node.js, Python, .NET runtime or installer required.

---

## Features

- **Server management via UI** — add, switch and remove SQL Server targets directly in the dashboard, no manual JSON editing required
- **Delta & cumulative wait statistics** — sys.dm_os_wait_stats with per-interval delta calculation
- **Wait Type Detail Panel** — click any wait type for description, severity, causes and recommended actions, with direct link to SQLskills Wait Library
- **SQLskills Goldstandard exclusion list** — 60+ benign background waits filtered out, only actionable waits shown
- **Other waits hidden by default** — toggle to show/hide non-categorized waits
- **Active request monitoring** — running queries with SQL text preview, excludes sleeping sessions and WaitDash itself
- **Blocking chain detection** — blocked/blocking sessions with SQL previews
- **Pause button** — freeze Active Requests or Blocking view while refresh continues in background
- **Sortable columns** — click any column header to sort ascending/descending
- **Resizable columns** — drag column header edges to resize
- **Copy to clipboard** — click any table cell to copy its value
- **Wait category classification** — CPU, I/O, Memory, Locking/Blocking, Parallelism, Network, HA/AG
- **Stacked category bar** — Redgate-style horizontal stacked bar for wait category distribution
- **Signal vs Resource wait bars** — with CPU pressure indicator and thresholds
- **Health Ampel** — green/yellow/red with mouseover tooltip explaining current status and reasons
- **Server info panel** — Edition, patch level, CPU count, RAM, uptime
- **Automated recommendations** — based on observed wait patterns
- **Deadlock visibility** — from system_health extended event session (last 20)
- **Dark/Light theme toggle** — preference saved in browser
- **TLS encrypted connections** — all SQL Server connections use encrypted transport
- **Auto-refresh** — configurable 5s/10s/30s/60s, no full page reload

---

## Requirements

| Component    | Requirement                                          |
|--------------|------------------------------------------------------|
| Your PC      | Windows, no runtime needed after build               |
| SQL Server   | 2012+ (any edition supporting sys DMVs)              |
| Permissions  | `VIEW SERVER STATE` on monitored instances           |
| Windows Auth | Domain-joined machine running under a domain account |
| SQL Auth     | Valid SQL login with `VIEW SERVER STATE`             |

---

## Deployment

1. Download `waitdash.exe` from GitHub Releases
2. Place `waitdash.exe` in any folder on your admin PC
3. Double-click `waitdash.exe`
4. Open browser: **http://localhost:9090**
5. Click **+ Add Server** to connect your first SQL Server instance

No configuration file editing required — everything is managed through the UI.
Connection settings are saved automatically to `servers.json` in the same folder.

---

## Permissions (minimum required)

```sql
GRANT VIEW SERVER STATE TO [your_login];
```

---

## Building from source

Requirements: Go 1.21 or later

**Windows:**
```bat
build.bat
```

**Linux / WSL (cross-compile for Windows):**
```bash
chmod +x build.sh
./build.sh
```

**Manual:**
```bash
go mod tidy
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w" -o waitdash.exe .
```

---

## servers.json (auto-managed)

The file is written automatically by the UI. You can also edit it manually if needed:

```json
{
  "listen_port": 9090,
  "refresh_seconds": 5,
  "default_server": "PROD-SQL01",
  "servers": [
    {
      "name":      "PROD-SQL01",
      "host":      "PROD-SQL01.domain.local",
      "port":      1433,
      "instance":  "",
      "auth_mode": "windows"
    },
    {
      "name":      "DEV-SQL01",
      "host":      "192.168.1.50",
      "port":      1433,
      "instance":  "",
      "auth_mode": "sql",
      "user":      "sa",
      "password":  "YourPassword"
    }
  ]
}
```

| Field       | Values             | Notes                                       |
|-------------|--------------------|---------------------------------------------|
| auth_mode   | "windows" or "sql" | Windows auth requires domain-joined machine |
| instance    | "" or "INST_NAME"  | Named instance, leave blank for default     |
| port        | 1433 (default)     | Change for named instances or non-standard  |

---

## What WaitDash is NOT

- Not a per-database tool — sys.dm_os_wait_stats is instance-level only
- Not a historical trend database — in-memory snapshots only (last 100 per server)
- Not a replacement for full APM tools like SolarWinds DPA, SQL Sentry, Redgate Monitor
- Not designed for production-scale monitoring — built for DBA admin workstations

---

## Architecture

```
[Browser] ──── HTTP ──── [waitdash.exe :9090] ──── TLS/SQL ──── [SQL Server]
                          │
                          ├─ Serves HTML/CSS/JS (embedded in binary)
                          ├─ /api/* endpoints
                          └─ servers.json (auto-managed config)
```

The executable embeds all frontend assets. Only `waitdash.exe` needed to run.
`servers.json` is created automatically on first server connection.

---

## Changelog

### v0.4
- Charts completely redesigned: stacked horizontal bar, HTML-based top waits bars, signal/resource bars
- Sortable and resizable table columns
- Copy-to-clipboard on all table cells
- Pause button for Active Requests and Blocking tabs
- Health Ampel mouseover tooltip with reasons
- Other waits hidden by default with toggle
- Extended exclusion list (SQLskills Goldstandard + PVS_PREALLOCATE, OLEDB, SLEEP_BPOOL_FLUSH, PREEMPTIVE_XE_DISPATCHER, BACKUPBUFFER, BACKUPIO)
- Active Requests query fixed

### v0.3
- Wait Type Detail Panel (slide-in on click)
- Dark/Light theme toggle
- SQLskills Goldstandard exclusion list
- Server info panel in header (Edition, patch level, CPU, RAM, uptime)
- Health Ampel (green/yellow/red)
- Logo: by DBO Dominik Böttger · powered by Claude.AI

### v0.2
- Server management via UI (no manual JSON editing)
- TLS encrypted SQL connections
- Connect dialog with Windows/SQL Auth toggle
- Fixed Active Requests query

### v0.1
- Initial release
