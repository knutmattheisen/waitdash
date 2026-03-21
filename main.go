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

type ServerConfig struct {
	Name     string `json:"name"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Instance string `json:"instance"`
	AuthMode string `json:"auth_mode"`
	User     string `json:"user"`
	Password string `json:"password"`
}

type Config struct {
	Servers        []ServerConfig `json:"servers"`
	DefaultServer  string         `json:"default_server"`
	ListenPort     int            `json:"listen_port"`
	RefreshSeconds int            `json:"refresh_seconds"`
}

var (
	globalConfig   Config
	configFilePath = "servers.json"
	configMu       sync.Mutex
)

func loadConfig() {
	data, err := os.ReadFile(configFilePath)
	if err != nil {
		globalConfig = Config{ListenPort: 9090, RefreshSeconds: 5, Servers: []ServerConfig{}}
		return
	}
	if err := json.Unmarshal(data, &globalConfig); err != nil {
		globalConfig = Config{ListenPort: 9090, RefreshSeconds: 5}
		return
	}
	if globalConfig.ListenPort == 0 {
		globalConfig.ListenPort = 9090
	}
	if globalConfig.RefreshSeconds == 0 {
		globalConfig.RefreshSeconds = 5
	}
}

func saveConfig() error {
	configMu.Lock()
	defer configMu.Unlock()
	data, err := json.MarshalIndent(globalConfig, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(configFilePath, data, 0644)
}

func categorizeWait(waitType string) string {
	wt := strings.ToUpper(waitType)
	switch {
	case strings.HasPrefix(wt, "LCK_M_"):
		return "Locking/Blocking"
	case strings.HasPrefix(wt, "PAGEIOLATCH_"):
		return "I/O"
	case strings.HasPrefix(wt, "PAGELATCH_"):
		return "Memory/Latch"
	case wt == "WRITELOG" || strings.HasPrefix(wt, "IO_COMPLETION") || strings.HasPrefix(wt, "ASYNC_IO_COMPLETION"):
		return "I/O"
	case wt == "SOS_SCHEDULER_YIELD" || wt == "THREADPOOL":
		return "CPU"
	case wt == "CXPACKET" || wt == "CXCONSUMER" || wt == "CXROWSET_SYNC":
		return "Parallelism"
	case wt == "RESOURCE_SEMAPHORE" || wt == "RESOURCE_SEMAPHORE_QUERY_COMPILE":
		return "Memory"
	case strings.HasPrefix(wt, "ASYNC_NETWORK_IO") || wt == "NET_WAITFOR_PACKET":
		return "Network"
	case strings.HasPrefix(wt, "HADR_") || strings.HasPrefix(wt, "DBMIRROR"):
		return "HA/AG"
	default:
		return "Other"
	}
}

type WaitStat struct {
	WaitType          string  `json:"wait_type"`
	WaitingTasksCount int64   `json:"waiting_tasks_count"`
	WaitTimeMs        int64   `json:"wait_time_ms"`
	MaxWaitTimeMs     int64   `json:"max_wait_time_ms"`
	SignalWaitTimeMs  int64   `json:"signal_wait_time_ms"`
	ResourceWaitMs    int64   `json:"resource_wait_ms"`
	AvgWaitMs         float64 `json:"avg_wait_ms"`
	PercentOfTotal    float64 `json:"percent_of_total"`
	Category          string  `json:"category"`
	DeltaWaitTimeMs   int64   `json:"delta_wait_time_ms"`
	DeltaTasksCount   int64   `json:"delta_tasks_count"`
}

type ActiveRequest struct {
	SessionID         int    `json:"session_id"`
	Status            string `json:"status"`
	Command           string `json:"command"`
	WaitType          string `json:"wait_type"`
	WaitTimeMs        int64  `json:"wait_time_ms"`
	WaitResource      string `json:"wait_resource"`
	BlockingSessionID int    `json:"blocking_session_id"`
	CPUTime           int64  `json:"cpu_time"`
	LogicalReads      int64  `json:"logical_reads"`
	Reads             int64  `json:"reads"`
	Writes            int64  `json:"writes"`
	TotalElapsedMs    int64  `json:"total_elapsed_ms"`
	DatabaseName      string `json:"database_name"`
	HostName          string `json:"host_name"`
	LoginName         string `json:"login_name"`
	ProgramName       string `json:"program_name"`
	SqlText           string `json:"sql_text"`
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

type HealthReason struct {
	Level   string `json:"level"`
	Reasons []string `json:"reasons"`
}

type Overview struct {
	ServerName         string       `json:"server_name"`
	SQLVersion         string       `json:"sql_version"`
	Edition            string       `json:"edition"`
	ProductLevel       string       `json:"product_level"`
	ProductUpdate      string       `json:"product_update"`
	LicenseType        string       `json:"license_type"`
	PhysicalMemGB      int          `json:"physical_mem_gb"`
	LogicalCPUs        int          `json:"logical_cpus"`
	MaxServerMemMB     int64        `json:"max_server_mem_mb"`
	StartTime          time.Time    `json:"start_time"`
	CurrentTime        time.Time    `json:"current_time"`
	UptimeHours        float64      `json:"uptime_hours"`
	SignalWaitPct      float64      `json:"signal_wait_pct"`
	TotalWaitMs        int64        `json:"total_wait_ms"`
	SignalWaitMs       int64        `json:"signal_wait_ms"`
	ResourceWaitMs     int64        `json:"resource_wait_ms"`
	BlockedCount       int          `json:"blocked_count"`
	ActiveRequestCount int          `json:"active_request_count"`
	TopWaitCategory    string       `json:"top_wait_category"`
	CPUPressure        bool         `json:"cpu_pressure"`
	HealthStatus       string       `json:"health_status"`
	HealthReasons      []string     `json:"health_reasons"`
	AvailableServers   []string     `json:"available_servers"`
	CurrentServer      string       `json:"current_server"`
	CategoryTotals     map[string]int64 `json:"category_totals"`
}

type Recommendation struct {
	Severity string `json:"severity"`
	Category string `json:"category"`
	Message  string `json:"message"`
}

type Deadlock struct {
	Timestamp  string `json:"timestamp"`
	XMLPreview string `json:"xml_preview"`
}

type WaitSnapshot map[string]WaitStat

type ServerState struct {
	mu           sync.Mutex
	db           *sql.DB
	prevSnapshot WaitSnapshot
	history      []WaitSnapshot
	config       ServerConfig
}

var (
	stateMu      sync.RWMutex
	serverStates = map[string]*ServerState{}
	activeServer string
)

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
			"sqlserver://%s:%d?database=master&trusted_connection=yes&encrypt=true&TrustServerCertificate=true&app+name=WaitDash",
			host, port,
		)
	}
	return fmt.Sprintf(
		"sqlserver://%s:%s@%s:%d?database=master&encrypt=true&TrustServerCertificate=true&app+name=WaitDash",
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
			return nil, fmt.Errorf("no_servers")
		}
		name = globalConfig.Servers[0].Name
		stateMu.Lock()
		activeServer = name
		stateMu.Unlock()
	}
	return getOrCreateState(name)
}

// ─────────────────────────────────────────────
// SQLskills Goldstandard + Extended exclusion list
// ─────────────────────────────────────────────
const queryWaits = `
SELECT wait_type, waiting_tasks_count, wait_time_ms, max_wait_time_ms, signal_wait_time_ms
FROM sys.dm_os_wait_stats
WHERE wait_type NOT IN (
    N'BACKUPBUFFER', N'BACKUPIO', N'BACKUPTHREAD',
    N'BROKER_EVENTHANDLER', N'BROKER_RECEIVE_WAITFOR', N'BROKER_TASK_STOP',
    N'BROKER_TO_FLUSH', N'BROKER_TRANSMITTER',
    N'CHECKPOINT_QUEUE', N'CHKPT',
    N'CLR_AUTO_EVENT', N'CLR_MANUAL_EVENT', N'CLR_SEMAPHORE',
    N'CXCONSUMER',
    N'DBMIRROR_DBM_EVENT', N'DBMIRROR_EVENTS_QUEUE', N'DBMIRROR_WORKER_QUEUE',
    N'DBMIRRORING_CMD', N'DIRTY_PAGE_POLL', N'DISPATCHER_QUEUE_SEMAPHORE',
    N'EXECSYNC', N'FSAGENT',
    N'FT_IFTS_SCHEDULER_IDLE_WAIT', N'FT_IFTSHC_MUTEX',
    N'HADR_CLUSAPI_CALL', N'HADR_FILESTREAM_IOMGR_IOCOMPLETION',
    N'HADR_WORK_QUEUE', N'HADR_TRANSPORT_DBRLIST',
    N'IMPPROV_IOWAIT', N'INTERNAL_TESTING',
    N'IO_QUEUE_LIMIT', N'IO_RETRY',
    N'LAZYWRITER_SLEEP', N'LOGMGR_QUEUE', N'LOGMGR_RESERVE_APPEND',
    N'LOWFAIL_MEMMGR_QUEUE', N'MEMORY_ALLOCATION_EXT',
    N'MSQL_DQ', N'MSQL_XACT_MGR_MUTEX', N'MSQL_XACT_MUTEX',
    N'MSQL_XP', N'MSSEARCH',
    N'NET_WAITFOR_PACKET', N'NODE_CACHE_MUTEX',
    N'OLEDB',
    N'ONDEMAND_TASK_MANAGER',
    N'PARALLEL_REDO_DRAIN_WORKER', N'PARALLEL_REDO_LOG_CACHE',
    N'PARALLEL_REDO_TRAN_LIST', N'PARALLEL_REDO_WORKER_SYNC',
    N'PARALLEL_REDO_WORKER_WAIT_WORK',
    N'PREEMPTIVE_XE_DISPATCHER',
    N'PRINT_ROLLBACK_PROGRESS',
    N'PVS_PREALLOCATE',
    N'PWAIT_ALL_COMPONENTS_INITIALIZED', N'PWAIT_DIRECTLOGCONSUMER_GETNEXT',
    N'QDS_ASYNC_QUEUE', N'QDS_CLEANUP_STALE_QUERIES_TASK_MAIN_LOOP_SLEEP',
    N'QDS_PERSIST_TASK_MAIN_LOOP_SLEEP', N'QDS_SHUTDOWN_QUEUE',
    N'REDO_THREAD_PENDING_WORK', N'REQUEST_FOR_DEADLOCK_SEARCH',
    N'RESOURCE_QUEUE',
    N'SERVER_IDLE_CHECK',
    N'SLEEP_BPOOL_FLUSH',
    N'SLEEP_DBSTARTUP', N'SLEEP_DCOMSTARTUP', N'SLEEP_MASTERDBREADY',
    N'SLEEP_MASTERMDREADY', N'SLEEP_MASTERUPGRADED', N'SLEEP_MSDBSTARTUP',
    N'SLEEP_SYSTEMTASK', N'SLEEP_TASK', N'SLEEP_TEMPDBSTARTUP',
    N'SNI_HTTP_ACCEPT', N'SOS_WORK_DISPATCHER',
    N'SP_SERVER_DIAGNOSTICS_SLEEP',
    N'SQLTRACE_BUFFER_FLUSH', N'SQLTRACE_INCREMENTAL_FLUSH_SLEEP',
    N'SQLTRACE_WAIT_ENTRIES',
    N'WAIT_XTP_OFFLINE_CKPT_NEW_LOG',
    N'WAITFOR', N'WAITFOR_TASKSHUTDOWN',
    N'WAIT_XTP_HOST_WAIT',
    N'XE_DISPATCHER_JOIN', N'XE_DISPATCHER_WAIT',
    N'XE_TIMER_EVENT', N'XE_TIMER_MUTEX', N'XE_TIMER_TASK_DONE',
    N'XIO_CREDENTIAL_MGR_WAITSFOR'
)
AND wait_time_ms > 0
ORDER BY wait_time_ms DESC`

const queryActive = `
SELECT
    r.session_id, r.status, r.command,
    ISNULL(r.wait_type, '') AS wait_type,
    r.wait_time,
    ISNULL(r.wait_resource, '') AS wait_resource,
    ISNULL(r.blocking_session_id, 0) AS blocking_session_id,
    r.cpu_time, r.logical_reads, r.reads, r.writes, r.total_elapsed_time,
    ISNULL(DB_NAME(r.database_id), '') AS database_name,
    ISNULL(s.host_name, '') AS host_name,
    ISNULL(s.login_name, '') AS login_name,
    ISNULL(s.program_name, '') AS program_name,
    ISNULL(
        SUBSTRING(
            ISNULL(st.text, ''),
            (r.statement_start_offset / 2) + 1,
            (CASE r.statement_end_offset
                WHEN -1 THEN DATALENGTH(ISNULL(st.text, ''))
                ELSE r.statement_end_offset
             END - r.statement_start_offset) / 2 + 1
        ), ''
    ) AS sql_text
FROM sys.dm_exec_requests r
INNER JOIN sys.dm_exec_sessions s ON r.session_id = s.session_id
OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) AS st
WHERE r.session_id <> @@SPID
  AND s.is_user_process = 1
  AND s.status <> 'sleeping'
  AND ISNULL(s.program_name, '') NOT LIKE '%WaitDash%'
ORDER BY r.total_elapsed_time DESC`

const queryServerInfo = `
SELECT
    CAST(SERVERPROPERTY('ServerName') AS nvarchar(256)),
    @@VERSION,
    CAST(SERVERPROPERTY('Edition') AS nvarchar(256)),
    CAST(SERVERPROPERTY('ProductLevel') AS nvarchar(50)),
    CAST(ISNULL(SERVERPROPERTY('ProductUpdateLevel'), '') AS nvarchar(50)),
    CAST(ISNULL(SERVERPROPERTY('LicenseType'), 'Disabled') AS nvarchar(50)),
    CAST(physical_memory_kb / 1024 / 1024 AS int),
    cpu_count,
    sqlserver_start_time,
    GETDATE()
FROM sys.dm_os_sys_info`

const queryBlocking = `
SELECT
    r.session_id, r.blocking_session_id,
    ISNULL(r.wait_type, ''), ISNULL(r.wait_resource, ''),
    r.wait_time,
    ISNULL(SUBSTRING(ISNULL(st.text, ''), 1, 500), ''),
    ISNULL(SUBSTRING(ISNULL(st2.text, ''), 1, 500), '')
FROM sys.dm_exec_requests r
LEFT JOIN sys.dm_exec_requests r2 ON r.blocking_session_id = r2.session_id
OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) st
OUTER APPLY sys.dm_exec_sql_text(r2.sql_handle) st2
WHERE r.blocking_session_id > 0
ORDER BY r.wait_time DESC`

const queryDeadlocks = `
SELECT TOP 20
    xdr.value('@timestamp', 'datetime'),
    CAST(xdr.query('.') AS nvarchar(max))
FROM (
    SELECT CAST(target_data AS xml) AS target_data
    FROM sys.dm_xe_session_targets t
    JOIN sys.dm_xe_sessions s ON s.address = t.event_session_address
    WHERE s.name = 'system_health' AND t.target_name = 'ring_buffer'
) d
CROSS APPLY target_data.nodes('//RingBufferTarget/event[@name="xml_deadlock_report"]') AS x(xdr)
ORDER BY xdr.value('@timestamp', 'datetime') DESC`

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

	var totalMs int64
	for _, w := range current {
		totalMs += w.WaitTimeMs
	}

	var result []WaitStat
	for wt, w := range current {
		if totalMs > 0 {
			w.PercentOfTotal = float64(w.WaitTimeMs) * 100.0 / float64(totalMs)
		}
		if st.prevSnapshot != nil {
			if prev, ok := st.prevSnapshot[wt]; ok && w.WaitTimeMs >= prev.WaitTimeMs {
				w.DeltaWaitTimeMs = w.WaitTimeMs - prev.WaitTimeMs
				w.DeltaTasksCount = w.WaitingTasksCount - prev.WaitingTasksCount
			}
		}
		result = append(result, w)
	}

	st.prevSnapshot = current
	st.history = append(st.history, current)
	if len(st.history) > 100 {
		st.history = st.history[1:]
	}

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
		result = append(result, r)
	}
	return result, nil
}

func fetchOverview(st *ServerState, waits []WaitStat, active []ActiveRequest) (Overview, error) {
	var ov Overview
	row := st.db.QueryRow(queryServerInfo)
	if err := row.Scan(
		&ov.ServerName, &ov.SQLVersion, &ov.Edition,
		&ov.ProductLevel, &ov.ProductUpdate, &ov.LicenseType,
		&ov.PhysicalMemGB, &ov.LogicalCPUs,
		&ov.StartTime, &ov.CurrentTime,
	); err != nil {
		return ov, err
	}
	ov.UptimeHours = ov.CurrentTime.Sub(ov.StartTime).Hours()

	var maxMem int64
	if err := st.db.QueryRow(`SELECT CAST(value_in_use AS bigint) FROM sys.configurations WHERE name='max server memory (MB)'`).Scan(&maxMem); err == nil {
		ov.MaxServerMemMB = maxMem
	}

	ov.CategoryTotals = map[string]int64{}
	var totalWait, totalSignal int64
	for _, w := range waits {
		totalWait += w.WaitTimeMs
		totalSignal += w.SignalWaitTimeMs
		if w.DeltaWaitTimeMs > 0 {
			ov.CategoryTotals[w.Category] += w.DeltaWaitTimeMs
		}
	}
	ov.TotalWaitMs = totalWait
	ov.SignalWaitMs = totalSignal
	ov.ResourceWaitMs = totalWait - totalSignal
	if totalWait > 0 {
		ov.SignalWaitPct = float64(totalSignal) * 100.0 / float64(totalWait)
	}
	ov.CPUPressure = ov.SignalWaitPct > 25

	var topCat string
	var topVal int64
	for cat, val := range ov.CategoryTotals {
		if val > topVal {
			topVal = val
			topCat = cat
		}
	}
	ov.TopWaitCategory = topCat
	if ov.TopWaitCategory == "" {
		ov.TopWaitCategory = "None"
	}

	for _, r := range active {
		if r.BlockingSessionID > 0 {
			ov.BlockedCount++
		}
	}
	ov.ActiveRequestCount = len(active)

	// Health status with detailed reasons
	var reasons []string
	if ov.BlockedCount > 0 {
		reasons = append(reasons, fmt.Sprintf("%d blocked session(s) detected", ov.BlockedCount))
	}
	if ov.CPUPressure {
		reasons = append(reasons, fmt.Sprintf("Signal wait %% is %.1f%% (threshold: >25%%) — CPU pressure", ov.SignalWaitPct))
	}
	if ov.SignalWaitPct > 15 && !ov.CPUPressure {
		reasons = append(reasons, fmt.Sprintf("Signal wait %% is %.1f%% (threshold: >15%%) — elevated CPU usage", ov.SignalWaitPct))
	}
	if ov.ActiveRequestCount > 20 {
		reasons = append(reasons, fmt.Sprintf("%d active requests (threshold: >20)", ov.ActiveRequestCount))
	}

	switch {
	case ov.BlockedCount > 0 || ov.CPUPressure:
		ov.HealthStatus = "red"
	case ov.SignalWaitPct > 15 || ov.ActiveRequestCount > 20:
		ov.HealthStatus = "yellow"
	default:
		ov.HealthStatus = "green"
		reasons = append(reasons, "All metrics within normal thresholds")
	}
	ov.HealthReasons = reasons

	for _, s := range globalConfig.Servers {
		ov.AvailableServers = append(ov.AvailableServers, s.Name)
	}
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
		recs = append(recs, Recommendation{Severity: "high", Category: "CPU",
			Message: fmt.Sprintf("Signal wait %% is %.1f%% (>25%%) — significant CPU pressure. Check for runaway queries, high MAXDOP, or insufficient CPU.", ov.SignalWaitPct)})
	}
	seen := map[string]bool{}
	for _, w := range waits {
		if w.DeltaWaitTimeMs == 0 {
			continue
		}
		wt := strings.ToUpper(w.WaitType)
		var rec *Recommendation
		switch {
		case wt == "SOS_SCHEDULER_YIELD" && !seen["cpu"]:
			seen["cpu"] = true
			rec = &Recommendation{Severity: "high", Category: "CPU", Message: "High SOS_SCHEDULER_YIELD — queries competing for CPU. Check missing indexes, large scans, parameter sniffing."}
		case strings.HasPrefix(wt, "PAGEIOLATCH_") && !seen["io"]:
			seen["io"] = true
			rec = &Recommendation{Severity: "high", Category: "I/O", Message: fmt.Sprintf("%s — storage read I/O bottleneck. Check disk latency, missing indexes, insufficient buffer pool.", w.WaitType)}
		case wt == "WRITELOG" && !seen["wlog"]:
			seen["wlog"] = true
			rec = &Recommendation{Severity: "high", Category: "I/O", Message: "High WRITELOG — transaction log I/O bottleneck. Move log to faster storage, reduce transaction frequency."}
		case wt == "RESOURCE_SEMAPHORE" && !seen["mem"]:
			seen["mem"] = true
			rec = &Recommendation{Severity: "high", Category: "Memory", Message: "RESOURCE_SEMAPHORE — queries waiting for memory grants. Check for large sorts/hashes, missing indexes causing spills."}
		case wt == "CXPACKET" && !seen["par"]:
			seen["par"] = true
			rec = &Recommendation{Severity: "medium", Category: "Parallelism", Message: "CXPACKET — parallelism overhead. Review MAXDOP and Cost Threshold for Parallelism."}
		case strings.HasPrefix(wt, "LCK_M_") && !seen["lck"]:
			seen["lck"] = true
			rec = &Recommendation{Severity: "high", Category: "Locking", Message: fmt.Sprintf("%s — lock contention. Review isolation levels and long-running transactions.", w.WaitType)}
		case wt == "ASYNC_NETWORK_IO" && !seen["net"]:
			seen["net"] = true
			rec = &Recommendation{Severity: "medium", Category: "Network", Message: "ASYNC_NETWORK_IO — clients not consuming results fast enough."}
		case strings.HasPrefix(wt, "PAGELATCH_") && !seen["latch"]:
			seen["latch"] = true
			rec = &Recommendation{Severity: "medium", Category: "Latch", Message: "PAGELATCH — in-memory page latch contention. Check tempdb file count."}
		case wt == "THREADPOOL" && !seen["tp"]:
			seen["tp"] = true
			rec = &Recommendation{Severity: "high", Category: "CPU", Message: "THREADPOOL — worker thread exhaustion. Reduce concurrent connections or check blocking chains."}
		}
		if rec != nil {
			recs = append(recs, *rec)
		}
	}
	if len(recs) == 0 {
		recs = append(recs, Recommendation{Severity: "info", Category: "General", Message: "No significant wait pressure detected. Instance appears healthy."})
	}
	return recs
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

func handleAddServer(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		errResponse(w, 405, "method not allowed")
		return
	}
	var sc ServerConfig
	if err := json.NewDecoder(r.Body).Decode(&sc); err != nil {
		errResponse(w, 400, "invalid JSON: "+err.Error())
		return
	}
	if sc.Name == "" {
		sc.Name = sc.Host
	}
	if sc.Port == 0 {
		sc.Port = 1433
	}
	connStr := buildConnString(sc)
	db, err := sql.Open("sqlserver", connStr)
	if err != nil {
		errResponse(w, 500, "driver error: "+err.Error())
		return
	}
	db.SetConnMaxLifetime(10 * time.Second)
	if err := db.Ping(); err != nil {
		db.Close()
		errResponse(w, 500, "connection failed: "+err.Error())
		return
	}
	db.Close()

	found := false
	for i, s := range globalConfig.Servers {
		if s.Name == sc.Name {
			globalConfig.Servers[i] = sc
			found = true
			break
		}
	}
	if !found {
		globalConfig.Servers = append(globalConfig.Servers, sc)
	}

	stateMu.Lock()
	if st, ok := serverStates[sc.Name]; ok {
		st.db.Close()
		delete(serverStates, sc.Name)
	}
	activeServer = sc.Name
	stateMu.Unlock()

	saveConfig()
	jsonResponse(w, map[string]string{"status": "ok", "server": sc.Name})
}

func handleRemoveServer(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if name == "" {
		errResponse(w, 400, "missing name")
		return
	}
	var newList []ServerConfig
	for _, s := range globalConfig.Servers {
		if s.Name != name {
			newList = append(newList, s)
		}
	}
	globalConfig.Servers = newList

	stateMu.Lock()
	if st, ok := serverStates[name]; ok {
		st.db.Close()
		delete(serverStates, name)
	}
	if activeServer == name {
		if len(globalConfig.Servers) > 0 {
			activeServer = globalConfig.Servers[0].Name
		} else {
			activeServer = ""
		}
	}
	stateMu.Unlock()

	saveConfig()
	jsonResponse(w, map[string]string{"status": "ok"})
}

func handleSwitchServer(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if name == "" {
		errResponse(w, 400, "missing name")
		return
	}
	if _, err := getOrCreateState(name); err != nil {
		errResponse(w, 500, err.Error())
		return
	}
	stateMu.Lock()
	activeServer = name
	stateMu.Unlock()
	jsonResponse(w, map[string]string{"status": "ok", "server": name})
}

func handleAllData(w http.ResponseWriter, r *http.Request) {
	st, err := currentState()
	if err != nil {
		if err.Error() == "no_servers" {
			jsonResponse(w, map[string]interface{}{
				"no_servers":        true,
				"available_servers": []string{},
				"current_server":    "",
			})
			return
		}
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

func handleDeadlocks(w http.ResponseWriter, r *http.Request) {
	st, err := currentState()
	if err != nil {
		jsonResponse(w, []Deadlock{})
		return
	}
	jsonResponse(w, fetchDeadlocks(st))
}

func handleConfig(w http.ResponseWriter, r *http.Request) {
	var serverNames []string
	for _, s := range globalConfig.Servers {
		serverNames = append(serverNames, s.Name)
	}
	jsonResponse(w, map[string]interface{}{
		"refresh_seconds":   globalConfig.RefreshSeconds,
		"available_servers": serverNames,
		"current_server":    activeServer,
	})
}

func main() {
	loadConfig()

	if len(globalConfig.Servers) > 0 {
		name := globalConfig.DefaultServer
		if name == "" {
			name = globalConfig.Servers[0].Name
		}
		activeServer = name
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/all", handleAllData)
	mux.HandleFunc("/api/deadlocks", handleDeadlocks)
	mux.HandleFunc("/api/switch", handleSwitchServer)
	mux.HandleFunc("/api/server/add", handleAddServer)
	mux.HandleFunc("/api/server/remove", handleRemoveServer)
	mux.HandleFunc("/api/config", handleConfig)

	staticFS, err := fs.Sub(staticFiles, "static")
	if err != nil {
		log.Fatal(err)
	}
	mux.Handle("/", http.FileServer(http.FS(staticFS)))

	addr := fmt.Sprintf(":%d", globalConfig.ListenPort)
	log.Printf("WaitDash v0.4 → http://localhost%s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}
