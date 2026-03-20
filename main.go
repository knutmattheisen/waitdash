package main

import (
	"database/sql"
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	_ "github.com/microsoft/go-mssqldb"
)

//go:embed static/*
var staticFiles embed.FS

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────

type ServerConfig struct {
	Name     string `json:"name"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Instance string `json:"instance"`
	AuthMode string `json:"auth_mode"` // "windows" or "sql"
	User     string `json:"user"`
	Password string `json:"password"`
}

type Config struct {
	Servers        []ServerConfig `json:"servers"`
	DefaultServer  string         `json:"default_server"`
	ListenPort     int            `json:"listen_port"`
	RefreshSeconds int            `json:"refresh_seconds"`
}

var globalConfig Config

func loadConfig() {
	data, err := os.ReadFile("servers.json")
	if err != nil {
		log.Println("No servers.json found, using defaults")
		globalConfig = Config{
			ListenPort:     9090,
			RefreshSeconds: 5,
			Servers: []ServerConfig{
				{
					Name:     "Local Default",
					Host:     "localhost",
					Port:     1433,
					AuthMode: "windows",
				},
			},
		}
		return
	}
	if err := json.Unmarshal(data, &globalConfig); err != nil {
		log.Fatalf("Invalid servers.json: %v", err)
	}
	if globalConfig.ListenPort == 0 {
		globalConfig.ListenPort = 9090
	}
	if globalConfig.RefreshSeconds == 0 {
		globalConfig.RefreshSeconds = 5
	}
}

// ─────────────────────────────────────────────
// Wait stats exclusion list
// ─────────────────────────────────────────────

var excludedWaits = map[string]bool{
	"SLEEP_TASK":                      true,
	"BROKER_TASK_STOP":                true,
	"BROKER_TO_FLUSH":                 true,
	"SQLTRACE_BUFFER_FLUSH":           true,
	"CLR_AUTO_EVENT":                  true,
	"CLR_MANUAL_EVENT":                true,
	"LAZYWRITER_SLEEP":                true,
	"REQUEST_FOR_DEADLOCK_SEARCH":     true,
	"XE_TIMER_EVENT":                  true,
	"XE_DISPATCHER_WAIT":              true,
	"FT_IFTS_SCHEDULER_IDLE_WAIT":     true,
	"DIRTY_PAGE_POLL":                 true,
	"HADR_FILESTREAM_IOMGR_IOCOMPLETION": true,
	"SP_SERVER_DIAGNOSTICS_SLEEP":     true,
	"WAIT_XTP_OFFLINE_CKPT_NEW_LOG":   true,
	"DISPATCHER_QUEUE_SEMAPHORE":      true,
	"BROKER_EVENTHANDLER":             true,
	"CHECKPOINT_QUEUE":                true,
	"DBMIRROR_EVENTS_QUEUE":           true,
	"SQLTRACE_INCREMENTAL_FLUSH_SLEEP": true,
	"ONDEMAND_TASK_MANAGER":           true,
	"SERVER_IDLE_CHECK":               true,
	"SLEEP_DBSTARTUP":                 true,
	"SLEEP_DCOMSTARTUP":               true,
	"SLEEP_MASTERDBREADY":             true,
	"SLEEP_MASTERMDREADY":             true,
	"SLEEP_MASTERUPGRADED":            true,
	"SLEEP_MSDBSTARTUP":               true,
	"SLEEP_SYSTEMTASK":                true,
	"SLEEP_TEMPDBSTARTUP":             true,
	"SNI_HTTP_ACCEPT":                 true,
	"WAITFOR":                         true,
	"XE_DISPATCHER_JOIN":              true,
}

// ─────────────────────────────────────────────
// Wait categories
// ─────────────────────────────────────────────

func categorizeWait(waitType string) string {
	wt := strings.ToUpper(waitType)
	switch {
	case strings.HasPrefix(wt, "LCK_M_"):
		return "Locking/Blocking"
	case strings.HasPrefix(wt, "PAGEIOLATCH_"):
		return "I/O"
	case strings.HasPrefix(wt, "PAGELATCH_"):
		return "Memory/Latch"
	case strings.HasPrefix(wt, "WRITELOG"):
		return "I/O"
	case strings.HasPrefix(wt, "IO_COMPLETION"):
		return "I/O"
	case strings.HasPrefix(wt, "ASYNC_IO_COMPLETION"):
		return "I/O"
	case wt == "SOS_SCHEDULER_YIELD":
		return "CPU"
	case wt == "CXPACKET" || wt == "CXCONSUMER" || wt == "CXROWSET_SYNC":
		return "Parallelism"
	case wt == "RESOURCE_SEMAPHORE" || wt == "RESOURCE_SEMAPHORE_QUERY_COMPILE":
		return "Memory"
	case strings.HasPrefix(wt, "ASYNC_NETWORK_IO") || wt == "NET_WAITFOR_PACKET":
		return "Network"
	case wt == "THREADPOOL":
		return "CPU"
	case strings.HasPrefix(wt, "HADR_"):
		return "HA/AG"
	case strings.HasPrefix(wt, "DBMIRROR"):
		return "HA/AG"
	case strings.HasPrefix(wt, "CLR_"):
		return "CLR"
	default:
		return "Other"
	}
}

// ─────────────────────────────────────────────
// Data types
// ─────────────────────────────────────────────

type WaitStat struct {
	WaitType           string  `json:"wait_type"`
	WaitingTasksCount  int64   `json:"waiting_tasks_count"`
	WaitTimeMs         int64   `json:"wait_time_ms"`
	MaxWaitTimeMs      int64   `json:"max_wait_time_ms"`
	SignalWaitTimeMs   int64   `json:"signal_wait_time_ms"`
	ResourceWaitMs     int64   `json:"resource_wait_ms"`
	AvgWaitMs          float64 `json:"avg_wait_ms"`
	PercentOfTotal     float64 `json:"percent_of_total"`
	Category           string  `json:"category"`
	DeltaWaitTimeMs    int64   `json:"delta_wait_time_ms"`
	DeltaTasksCount    int64   `json:"delta_tasks_count"`
}

type ActiveRequest struct {
	SessionID        int    `json:"session_id"`
	Status           string `json:"status"`
	Command          string `json:"command"`
	WaitType         string `json:"wait_type"`
	WaitTimeMs       int64  `json:"wait_time_ms"`
	WaitResource     string `json:"wait_resource"`
	BlockingSessionID int   `json:"blocking_session_id"`
	CPUTime          int64  `json:"cpu_time"`
	LogicalReads     int64  `json:"logical_reads"`
	Reads            int64  `json:"reads"`
	Writes           int64  `json:"writes"`
	TotalElapsedMs   int64  `json:"total_elapsed_ms"`
	DatabaseName     string `json:"database_name"`
	HostName         string `json:"host_name"`
	LoginName        string `json:"login_name"`
	ProgramName      string `json:"program_name"`
	SqlText          string `json:"sql_text"`
}

type BlockingChain struct {
	BlockedSessionID  int    `json:"blocked_session_id"`
	BlockingSessionID int    `json:"blocking_session_id"`
	WaitType          string `json:"wait_type"`
	WaitResource      string `json:"wait_resource"`
	WaitTimeMs        int64  `json:"wait_time_ms"`
	BlockedSQL        string `json:"blocked_sql"`
	BlockingSQL       string `json:"blocking_sql"`
}

type Overview struct {
	ServerName          string    `json:"server_name"`
	SQLVersion          string    `json:"sql_version"`
	StartTime           time.Time `json:"start_time"`
	CurrentTime         time.Time `json:"current_time"`
	UptimeHours         float64   `json:"uptime_hours"`
	SignalWaitPct        float64   `json:"signal_wait_pct"`
	TotalWaitMs         int64     `json:"total_wait_ms"`
	SignalWaitMs        int64     `json:"signal_wait_ms"`
	ResourceWaitMs      int64     `json:"resource_wait_ms"`
	BlockedCount        int       `json:"blocked_count"`
	ActiveRequestCount  int       `json:"active_request_count"`
	TopWaitCategory     string    `json:"top_wait_category"`
	CPUPressure         bool      `json:"cpu_pressure"`
	AvailableServers    []string  `json:"available_servers"`
	CurrentServer       string    `json:"current_server"`
}

type Recommendation struct {
	Severity string `json:"severity"` // "high", "medium", "info"
	Category string `json:"category"`
	Message  string `json:"message"`
}

type Deadlock struct {
	Timestamp   string `json:"timestamp"`
	VictimSPID  string `json:"victim_spid"`
	XMLPreview  string `json:"xml_preview"`
}

// ─────────────────────────────────────────────
// State
// ─────────────────────────────────────────────

type WaitSnapshot map[string]WaitStat

type ServerState struct {
	mu            sync.Mutex
	db            *sql.DB
	prevSnapshot  WaitSnapshot
	prevCheckTime time.Time
	history       []WaitSnapshot
	config        ServerConfig
}

var (
	stateMu       sync.RWMutex
	serverStates  = map[string]*ServerState{}
	activeServer  string
)

// ─────────────────────────────────────────────
// DB connection
// ─────────────────────────────────────────────

func buildConnString(sc ServerConfig) string {
	host := sc.Host
	if sc.Instance != "" {
		host = fmt.Sprintf("%s\\%s", host, sc.Instance)
	}
	port := sc.Port
	if port == 0 {
		port = 1433
	}

	if sc.AuthMode == "windows" {
		return fmt.Sprintf(
			"sqlserver://%s:%d?database=master&trusted_connection=yes&app+name=WaitDash",
			host, port,
		)
	}
	return fmt.Sprintf(
		"sqlserver://%s:%s@%s:%d?database=master&app+name=WaitDash",
		sc.User, sc.Password, host, port,
	)
}

func getOrCreateState(serverName string) (*ServerState, error) {
	stateMu.RLock()
	st, ok := serverStates[serverName]
	stateMu.RUnlock()
	if ok {
		return st, nil
	}

	var sc *ServerConfig
	for i := range globalConfig.Servers {
		if globalConfig.Servers[i].Name == serverName {
			sc = &globalConfig.Servers[i]
			break
		}
	}
	if sc == nil {
		return nil, fmt.Errorf("server not found: %s", serverName)
	}

	connStr := buildConnString(*sc)
	db, err := sql.Open("sqlserver", connStr)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(5)
	db.SetMaxIdleConns(2)
	db.SetConnMaxLifetime(5 * time.Minute)

	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("cannot connect to %s: %v", serverName, err)
	}

	st = &ServerState{db: db, config: *sc}

	stateMu.Lock()
	serverStates[serverName] = st
	stateMu.Unlock()

	return st, nil
}

func currentState() (*ServerState, error) {
	stateMu.RLock()
	name := activeServer
	stateMu.RUnlock()
	if name == "" {
		if len(globalConfig.Servers) == 0 {
			return nil, fmt.Errorf("no servers configured")
		}
		name = globalConfig.Servers[0].Name
		stateMu.Lock()
		activeServer = name
		stateMu.Unlock()
	}
	return getOrCreateState(name)
}

// ─────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────

const queryWaits = `
SELECT
    wait_type,
    waiting_tasks_count,
    wait_time_ms,
    max_wait_time_ms,
    signal_wait_time_ms
FROM sys.dm_os_wait_stats
WHERE wait_type NOT IN (
    'SLEEP_TASK','BROKER_TASK_STOP','BROKER_TO_FLUSH','SQLTRACE_BUFFER_FLUSH',
    'CLR_AUTO_EVENT','CLR_MANUAL_EVENT','LAZYWRITER_SLEEP',
    'REQUEST_FOR_DEADLOCK_SEARCH','XE_TIMER_EVENT','XE_DISPATCHER_WAIT',
    'FT_IFTS_SCHEDULER_IDLE_WAIT','DIRTY_PAGE_POLL',
    'HADR_FILESTREAM_IOMGR_IOCOMPLETION','SP_SERVER_DIAGNOSTICS_SLEEP',
    'WAIT_XTP_OFFLINE_CKPT_NEW_LOG','DISPATCHER_QUEUE_SEMAPHORE',
    'BROKER_EVENTHANDLER','CHECKPOINT_QUEUE','DBMIRROR_EVENTS_QUEUE',
    'SQLTRACE_INCREMENTAL_FLUSH_SLEEP','ONDEMAND_TASK_MANAGER',
    'SERVER_IDLE_CHECK','SLEEP_DBSTARTUP','SLEEP_DCOMSTARTUP',
    'SLEEP_MASTERDBREADY','SLEEP_MASTERMDREADY','SLEEP_MASTERUPGRADED',
    'SLEEP_MSDBSTARTUP','SLEEP_SYSTEMTASK','SLEEP_TEMPDBSTARTUP',
    'SNI_HTTP_ACCEPT','WAITFOR','XE_DISPATCHER_JOIN'
)
AND wait_time_ms > 0
ORDER BY wait_time_ms DESC
`

const queryActive = `
SELECT
    r.session_id,
    r.status,
    r.command,
    ISNULL(r.wait_type,'') AS wait_type,
    r.wait_time,
    ISNULL(r.wait_resource,'') AS wait_resource,
    ISNULL(r.blocking_session_id,0) AS blocking_session_id,
    r.cpu_time,
    r.logical_reads,
    r.reads,
    r.writes,
    r.total_elapsed_time,
    ISNULL(DB_NAME(r.database_id),'') AS database_name,
    ISNULL(s.host_name,'') AS host_name,
    ISNULL(s.login_name,'') AS login_name,
    ISNULL(s.program_name,'') AS program_name,
    ISNULL(SUBSTRING(
        st.text,
        (r.statement_start_offset/2)+1,
        CASE WHEN r.statement_end_offset=-1
             THEN LEN(CONVERT(nvarchar(max),st.text))*2
             ELSE r.statement_end_offset
        END - r.statement_start_offset)/2+1, 2000), '') AS sql_text
FROM sys.dm_exec_requests r
JOIN sys.dm_exec_sessions s ON r.session_id = s.session_id
OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) st
WHERE r.session_id != @@SPID
  AND s.is_user_process = 1
  AND r.status != 'background'
ORDER BY r.total_elapsed_time DESC
`

const queryOverview = `
SELECT
    @@SERVERNAME AS server_name,
    @@VERSION AS sql_version,
    sqlserver_start_time,
    GETDATE() AS current_time
FROM sys.dm_os_sys_info
`

const queryBlocking = `
SELECT
    r.session_id AS blocked_session_id,
    r.blocking_session_id,
    ISNULL(r.wait_type,'') AS wait_type,
    ISNULL(r.wait_resource,'') AS wait_resource,
    r.wait_time AS wait_time_ms,
    ISNULL(SUBSTRING(st.text,1,500),'') AS blocked_sql,
    ISNULL(SUBSTRING(st2.text,1,500),'') AS blocking_sql
FROM sys.dm_exec_requests r
LEFT JOIN sys.dm_exec_requests r2 ON r.blocking_session_id = r2.session_id
OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) st
OUTER APPLY sys.dm_exec_sql_text(r2.sql_handle) st2
WHERE r.blocking_session_id > 0
ORDER BY r.wait_time DESC
`

const queryDeadlocks = `
SELECT TOP 20
    xdr.value('@timestamp','datetime') AS deadlock_time,
    CAST(xdr.query('.') AS nvarchar(max)) AS deadlock_xml
FROM (
    SELECT CAST(target_data AS xml) AS target_data
    FROM sys.dm_xe_session_targets t
    JOIN sys.dm_xe_sessions s ON s.address = t.event_session_address
    WHERE s.name = 'system_health'
      AND t.target_name = 'ring_buffer'
) AS d
CROSS APPLY target_data.nodes('//RingBufferTarget/event[@name="xml_deadlock_report"]') AS XEventData(xdr)
ORDER BY deadlock_time DESC
`

// ─────────────────────────────────────────────
// Data fetch helpers
// ─────────────────────────────────────────────

func fetchWaits(st *ServerState) ([]WaitStat, error) {
	st.mu.Lock()
	defer st.mu.Unlock()

	rows, err := st.db.Query(queryWaits)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	current := WaitSnapshot{}
	for rows.Next() {
		var w WaitStat
		if err := rows.Scan(&w.WaitType, &w.WaitingTasksCount, &w.WaitTimeMs,
			&w.MaxWaitTimeMs, &w.SignalWaitTimeMs); err != nil {
			continue
		}
		w.ResourceWaitMs = w.WaitTimeMs - w.SignalWaitTimeMs
		if w.WaitingTasksCount > 0 {
			w.AvgWaitMs = float64(w.WaitTimeMs) / float64(w.WaitingTasksCount)
		}
		w.Category = categorizeWait(w.WaitType)
		current[w.WaitType] = w
	}

	// Compute totals for percent
	var totalMs int64
	for _, w := range current {
		totalMs += w.WaitTimeMs
	}

	// Compute deltas
	var result []WaitStat
	for wt, w := range current {
		if totalMs > 0 {
			w.PercentOfTotal = float64(w.WaitTimeMs) * 100.0 / float64(totalMs)
		}
		if prev, ok := st.prevSnapshot[wt]; ok {
			// Detect reset: if current < prev, skip delta
			if w.WaitTimeMs >= prev.WaitTimeMs {
				w.DeltaWaitTimeMs = w.WaitTimeMs - prev.WaitTimeMs
				w.DeltaTasksCount = w.WaitingTasksCount - prev.WaitingTasksCount
			}
		}
		result = append(result, w)
	}

	// Save snapshot for next delta
	st.prevSnapshot = current
	st.prevCheckTime = time.Now()

	// Keep history (max 100)
	st.history = append(st.history, current)
	if len(st.history) > 100 {
		st.history = st.history[1:]
	}

	// Sort by delta desc, then cumulative desc
	sort.Slice(result, func(i, j int) bool {
		if result[i].DeltaWaitTimeMs != result[j].DeltaWaitTimeMs {
			return result[i].DeltaWaitTimeMs > result[j].DeltaWaitTimeMs
		}
		return result[i].WaitTimeMs > result[j].WaitTimeMs
	})

	return result, nil
}

func fetchActive(st *ServerState) ([]ActiveRequest, error) {
	rows, err := st.db.Query(queryActive)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []ActiveRequest
	for rows.Next() {
		var r ActiveRequest
		if err := rows.Scan(
			&r.SessionID, &r.Status, &r.Command,
			&r.WaitType, &r.WaitTimeMs, &r.WaitResource,
			&r.BlockingSessionID, &r.CPUTime, &r.LogicalReads,
			&r.Reads, &r.Writes, &r.TotalElapsedMs,
			&r.DatabaseName, &r.HostName, &r.LoginName,
			&r.ProgramName, &r.SqlText,
		); err != nil {
			continue
		}
		// Filter out our own monitoring session
		if r.ProgramName == "WaitDash" {
			continue
		}
		result = append(result, r)
	}
	return result, nil
}

func fetchOverview(st *ServerState, waits []WaitStat, active []ActiveRequest) (Overview, error) {
	row := st.db.QueryRow(queryOverview)
	var ov Overview
	var startTime time.Time
	var currentTime time.Time
	if err := row.Scan(&ov.ServerName, &ov.SQLVersion, &startTime, &currentTime); err != nil {
		return ov, err
	}
	ov.StartTime = startTime
	ov.CurrentTime = currentTime
	ov.UptimeHours = currentTime.Sub(startTime).Hours()

	var totalWait, totalSignal int64
	catTotals := map[string]int64{}
	for _, w := range waits {
		totalWait += w.WaitTimeMs
		totalSignal += w.SignalWaitTimeMs
		catTotals[w.Category] += w.DeltaWaitTimeMs
	}
	ov.TotalWaitMs = totalWait
	ov.SignalWaitMs = totalSignal
	ov.ResourceWaitMs = totalWait - totalSignal
	if totalWait > 0 {
		ov.SignalWaitPct = float64(totalSignal) * 100.0 / float64(totalWait)
	}
	ov.CPUPressure = ov.SignalWaitPct > 25

	// Top category by delta
	var topCat string
	var topVal int64
	for cat, val := range catTotals {
		if val > topVal {
			topVal = val
			topCat = cat
		}
	}
	ov.TopWaitCategory = topCat

	blockedCount := 0
	for _, r := range active {
		if r.BlockingSessionID > 0 {
			blockedCount++
		}
	}
	ov.BlockedCount = blockedCount
	ov.ActiveRequestCount = len(active)

	var serverNames []string
	for _, s := range globalConfig.Servers {
		serverNames = append(serverNames, s.Name)
	}
	ov.AvailableServers = serverNames
	ov.CurrentServer = st.config.Name

	return ov, nil
}

func fetchBlocking(st *ServerState) ([]BlockingChain, error) {
	rows, err := st.db.Query(queryBlocking)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []BlockingChain
	for rows.Next() {
		var b BlockingChain
		if err := rows.Scan(
			&b.BlockedSessionID, &b.BlockingSessionID,
			&b.WaitType, &b.WaitResource, &b.WaitTimeMs,
			&b.BlockedSQL, &b.BlockingSQL,
		); err != nil {
			continue
		}
		result = append(result, b)
	}
	return result, nil
}

func buildRecommendations(waits []WaitStat, ov Overview) []Recommendation {
	var recs []Recommendation

	if ov.CPUPressure {
		recs = append(recs, Recommendation{
			Severity: "high",
			Category: "CPU",
			Message:  fmt.Sprintf("Signal wait %% is %.1f%% (>25%%) — significant CPU pressure detected. Check for runaway queries, high MAXDOP, or insufficient CPU.", ov.SignalWaitPct),
		})
	}

	for _, w := range waits {
		if w.DeltaWaitTimeMs == 0 {
			continue
		}
		wt := strings.ToUpper(w.WaitType)
		switch {
		case wt == "SOS_SCHEDULER_YIELD":
			recs = append(recs, Recommendation{
				Severity: "high", Category: "CPU",
				Message: "High SOS_SCHEDULER_YIELD — queries competing for CPU. Look for missing indexes, large scans, or parameter sniffing issues.",
			})
		case strings.HasPrefix(wt, "PAGEIOLATCH_"):
			recs = append(recs, Recommendation{
				Severity: "high", Category: "I/O",
				Message: fmt.Sprintf("%s — storage read I/O bottleneck. Check disk latency, missing indexes, or insufficient buffer pool.", w.WaitType),
			})
		case wt == "WRITELOG":
			recs = append(recs, Recommendation{
				Severity: "high", Category: "I/O",
				Message: "High WRITELOG — transaction log I/O bottleneck. Move log files to faster storage, reduce transaction frequency, check for implicit transactions.",
			})
		case wt == "RESOURCE_SEMAPHORE":
			recs = append(recs, Recommendation{
				Severity: "high", Category: "Memory",
				Message: "RESOURCE_SEMAPHORE — queries waiting for memory grants. Check for large sorts/hashes, missing indexes causing spills, or low max server memory.",
			})
		case wt == "CXPACKET" || wt == "CXCONSUMER":
			recs = append(recs, Recommendation{
				Severity: "medium", Category: "Parallelism",
				Message: fmt.Sprintf("%s — parallelism overhead. Review MAXDOP settings, Cost Threshold for Parallelism, and queries triggering parallel plans.", w.WaitType),
			})
		case strings.HasPrefix(wt, "LCK_M_"):
			recs = append(recs, Recommendation{
				Severity: "high", Category: "Locking",
				Message: fmt.Sprintf("%s — lock contention detected. Review transaction isolation levels, long-running transactions, and missing indexes on frequently locked tables.", w.WaitType),
			})
		case wt == "ASYNC_NETWORK_IO":
			recs = append(recs, Recommendation{
				Severity: "medium", Category: "Network",
				Message: "ASYNC_NETWORK_IO — clients are not consuming results fast enough. Check application-side result set processing, row buffering, and network throughput.",
			})
		case strings.HasPrefix(wt, "PAGELATCH_"):
			recs = append(recs, Recommendation{
				Severity: "medium", Category: "Latch",
				Message: "PAGELATCH — in-memory page latch contention. Check tempdb contention (add files), or hot pages in user tables (use GUID PKs with care).",
			})
		case wt == "THREADPOOL":
			recs = append(recs, Recommendation{
				Severity: "high", Category: "CPU",
				Message: "THREADPOOL — worker thread exhaustion. SQL Server cannot service requests. Reduce concurrent connections, check for blocking chains, or increase max worker threads carefully.",
			})
		}
	}

	if len(recs) == 0 {
		recs = append(recs, Recommendation{
			Severity: "info", Category: "General",
			Message: "No significant wait pressure detected in this interval. Instance appears healthy.",
		})
	}

	// Deduplicate by category+severity
	seen := map[string]bool{}
	var deduped []Recommendation
	for _, r := range recs {
		key := r.Category + r.Severity
		if !seen[key] {
			seen[key] = true
			deduped = append(deduped, r)
		}
	}
	return deduped
}

func fetchDeadlocks(st *ServerState) []Deadlock {
	rows, err := st.db.Query(queryDeadlocks)
	if err != nil {
		return nil
	}
	defer rows.Close()

	var result []Deadlock
	for rows.Next() {
		var d Deadlock
		var ts time.Time
		if err := rows.Scan(&ts, &d.XMLPreview); err != nil {
			continue
		}
		d.Timestamp = ts.Format("2006-01-02 15:04:05")
		if len(d.XMLPreview) > 1000 {
			d.XMLPreview = d.XMLPreview[:1000] + "..."
		}
		result = append(result, d)
	}
	return result
}

// ─────────────────────────────────────────────
// HTTP Handlers
// ─────────────────────────────────────────────

func jsonResponse(w http.ResponseWriter, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	json.NewEncoder(w).Encode(data)
}

func errResponse(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func handleSwitchServer(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if name == "" {
		errResponse(w, 400, "missing name param")
		return
	}
	_, err := getOrCreateState(name)
	if err != nil {
		errResponse(w, 500, err.Error())
		return
	}
	stateMu.Lock()
	activeServer = name
	stateMu.Unlock()
	jsonResponse(w, map[string]string{"status": "ok", "server": name})
}

func handleWaits(w http.ResponseWriter, r *http.Request) {
	st, err := currentState()
	if err != nil {
		errResponse(w, 500, err.Error())
		return
	}
	waits, err := fetchWaits(st)
	if err != nil {
		errResponse(w, 500, err.Error())
		return
	}
	jsonResponse(w, waits)
}

func handleActive(w http.ResponseWriter, r *http.Request) {
	st, err := currentState()
	if err != nil {
		errResponse(w, 500, err.Error())
		return
	}
	active, err := fetchActive(st)
	if err != nil {
		errResponse(w, 500, err.Error())
		return
	}
	jsonResponse(w, active)
}

func handleBlocking(w http.ResponseWriter, r *http.Request) {
	st, err := currentState()
	if err != nil {
		errResponse(w, 500, err.Error())
		return
	}
	blocking, err := fetchBlocking(st)
	if err != nil {
		errResponse(w, 500, err.Error())
		return
	}
	jsonResponse(w, blocking)
}

func handleOverview(w http.ResponseWriter, r *http.Request) {
	st, err := currentState()
	if err != nil {
		errResponse(w, 500, err.Error())
		return
	}
	waits, _ := fetchWaits(st)
	active, _ := fetchActive(st)
	ov, err := fetchOverview(st, waits, active)
	if err != nil {
		errResponse(w, 500, err.Error())
		return
	}
	jsonResponse(w, ov)
}

func handleRecommendations(w http.ResponseWriter, r *http.Request) {
	st, err := currentState()
	if err != nil {
		errResponse(w, 500, err.Error())
		return
	}
	waits, _ := fetchWaits(st)
	active, _ := fetchActive(st)
	ov, _ := fetchOverview(st, waits, active)
	recs := buildRecommendations(waits, ov)
	jsonResponse(w, recs)
}

func handleDeadlocks(w http.ResponseWriter, r *http.Request) {
	st, err := currentState()
	if err != nil {
		errResponse(w, 500, err.Error())
		return
	}
	dl := fetchDeadlocks(st)
	jsonResponse(w, dl)
}

func handleAllData(w http.ResponseWriter, r *http.Request) {
	st, err := currentState()
	if err != nil {
		errResponse(w, 500, err.Error())
		return
	}
	waits, _ := fetchWaits(st)
	active, _ := fetchActive(st)
	blocking, _ := fetchBlocking(st)
	ov, _ := fetchOverview(st, waits, active)
	recs := buildRecommendations(waits, ov)

	jsonResponse(w, map[string]interface{}{
		"overview":        ov,
		"waits":           waits,
		"active":          active,
		"blocking":        blocking,
		"recommendations": recs,
	})
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

func main() {
	loadConfig()

	// Default active server
	if len(globalConfig.Servers) > 0 {
		name := globalConfig.DefaultServer
		if name == "" {
			name = globalConfig.Servers[0].Name
		}
		activeServer = name
	}

	mux := http.NewServeMux()

	// API routes
	mux.HandleFunc("/api/all", handleAllData)
	mux.HandleFunc("/api/overview", handleOverview)
	mux.HandleFunc("/api/waits", handleWaits)
	mux.HandleFunc("/api/active", handleActive)
	mux.HandleFunc("/api/blocking", handleBlocking)
	mux.HandleFunc("/api/recommendations", handleRecommendations)
	mux.HandleFunc("/api/deadlocks", handleDeadlocks)
	mux.HandleFunc("/api/switch", handleSwitchServer)
	mux.HandleFunc("/api/config", func(w http.ResponseWriter, r *http.Request) {
		jsonResponse(w, map[string]interface{}{
			"refresh_seconds": globalConfig.RefreshSeconds,
		})
	})

	// Static files
	staticFS, err := fs.Sub(staticFiles, "static")
	if err != nil {
		log.Fatal(err)
	}
	mux.Handle("/", http.FileServer(http.FS(staticFS)))

	addr := fmt.Sprintf(":%d", globalConfig.ListenPort)
	log.Printf("WaitDash starting on http://localhost%s", addr)
	log.Printf("Active server: %s", activeServer)

	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}
