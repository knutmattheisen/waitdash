# WaitDash — SQL Server Wait Statistics Dashboard

Portable, zero-install DBA tool for near real-time SQL Server wait analysis.
Single Windows executable. No Node.js, Python, .NET runtime or installer required.

## What it does

- Delta and cumulative wait statistics (sys.dm_os_wait_stats)
- Active request monitoring with SQL text preview
- Blocking chain detection
- Wait category classification (CPU, I/O, Memory, Locking, Parallelism, Network)
- Signal vs Resource wait analysis with CPU pressure warning
- Automated recommendations based on observed patterns
- Deadlock visibility from system_health extended event session
- Dark theme, live charts, auto-refresh, multi-server switching

## Requirements

| Component     | Requirement                                |
|---------------|--------------------------------------------|
| Your PC       | Windows, no runtime needed                 |
| SQL Server    | 2012+ (any edition that supports sys DMVs) |
| Permissions   | VIEW SERVER STATE on monitored instances   |
| Windows Auth  | Domain-joined machine + domain account     |
| SQL Auth      | Valid login with VIEW SERVER STATE         |

## Deployment

1. Copy `waitdash.exe` and `servers.json` to any folder on your admin PC
2. Edit `servers.json` — define your SQL Server targets
3. Double-click `waitdash.exe` (or run from cmd)
4. Open browser: http://localhost:9090

## Building from source

Requirements: Go 1.21 or later

**Windows:**
```
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

## servers.json

```json
{
  "listen_port": 9090,
  "refresh_seconds": 5,
  "default_server": "PROD-SQL01",
  "servers": [
    {
      "name":      "PROD-SQL01",
      "host":      "PROD-SQL01",
      "port":      1433,
      "instance":  "",
      "auth_mode": "windows"
    },
    {
      "name":      "DEV Server",
      "host":      "192.168.1.50",
      "port":      1433,
      "auth_mode": "sql",
      "user":      "sa",
      "password":  "secret"
    }
  ]
}
```

| Field         | Values                | Notes                                        |
|---------------|-----------------------|----------------------------------------------|
| auth_mode     | "windows" or "sql"    | Windows auth requires domain-joined machine  |
| instance      | "" or "INST_NAME"     | Named instance, leave blank for default      |
| port          | 1433 (default)        | Change for named instances or non-standard   |

## Permissions (minimum required)

```sql
GRANT VIEW SERVER STATE TO [your_login];
```

## What WaitDash is NOT

- Not a per-database tool — sys.dm_os_wait_stats is instance-level
- Not a historical trend database — in-memory only (100 snapshots max)
- Not a replacement for full APM tools like SolarWinds, SQL Sentry, etc.
- Not for production monitoring at scale — designed for DBA admin workstations

## Architecture

```
[Browser] ──── HTTP ──── [waitdash.exe :9090] ──── SQL ──── [SQL Server]
                          │
                          └─ Serves HTML/CSS/JS (embedded)
                          └─ /api/* endpoints
                          └─ servers.json (config)
```

The executable embeds all frontend assets. Only `waitdash.exe` + `servers.json` needed.
