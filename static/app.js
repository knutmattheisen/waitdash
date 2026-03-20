'use strict';

// ─── State ────────────────────────────────────────
let refreshInterval = 5000;
let refreshTimer    = null;
let maxDeltaWait    = 1;
let currentAuthMode = 'windows';
let hasServers      = false;

// ─── Wait Type Knowledge Base ─────────────────────
const WAIT_INFO = {
  'SOS_SCHEDULER_YIELD': {
    severity: 'high',
    description: 'A thread voluntarily yielded the CPU scheduler after using its full quantum (4ms) without completing. Indicates CPU-intensive work.',
    causes: 'Missing indexes causing large scans, non-sargable queries, parameter sniffing issues, too many parallel threads competing, CPU-bound hash/sort operations.',
    actions: 'Identify top CPU-consuming queries via sys.dm_exec_query_stats. Check for missing indexes. Review execution plans for large scans. Consider increasing CPU or reviewing MAXDOP.',
  },
  'CXPACKET': {
    severity: 'medium',
    description: 'Threads waiting for parallel query synchronization. One thread finishes its portion and waits for slower sibling threads. Not always a problem on its own.',
    causes: 'High MAXDOP allowing too many parallel threads, skewed data distribution causing uneven parallel work, Cost Threshold for Parallelism set too low.',
    actions: 'Check MAXDOP setting (instance and query level). Raise Cost Threshold for Parallelism (default 5 is too low — try 50). Look for skewed statistics on tables in parallel queries.',
  },
  'CXCONSUMER': {
    severity: 'low',
    description: 'Consumer thread in a parallel query waiting for the producer thread to provide rows. Introduced in SQL 2016 SP2 to separate from CXPACKET.',
    causes: 'Normal parallel query execution. Only concerning if combined with high CXPACKET or skewed row distribution.',
    actions: 'Usually benign. Monitor alongside CXPACKET. Only act if combined wait times are very high.',
  },
  'PAGEIOLATCH_SH': {
    severity: 'high',
    description: 'Thread waiting for a data page to be read from disk into the buffer pool (shared latch — read operation).',
    causes: 'Insufficient buffer pool (RAM), missing indexes causing full table scans, slow storage subsystem, large working set exceeding available memory.',
    actions: 'Add RAM to increase buffer pool. Check storage latency (should be <1ms for NVMe, <5ms for SSD). Add missing indexes to reduce I/O. Check for large table scans.',
  },
  'PAGEIOLATCH_EX': {
    severity: 'high',
    description: 'Thread waiting for a data page to be read from disk into the buffer pool (exclusive latch — write/modify operation).',
    causes: 'Same as PAGEIOLATCH_SH but for write operations. Heavy INSERT/UPDATE/DELETE workloads with slow storage.',
    actions: 'Investigate storage performance. Review write-heavy queries. Consider faster storage for data files.',
  },
  'PAGEIOLATCH_UP': {
    severity: 'high',
    description: 'Thread waiting for a data page to be read from disk (update latch). Precursor to an exclusive latch for modification.',
    causes: 'Write-heavy workloads, slow storage, insufficient memory.',
    actions: 'Same as PAGEIOLATCH_EX — review storage performance and write patterns.',
  },
  'WRITELOG': {
    severity: 'high',
    description: 'Thread waiting for transaction log records to be flushed (hardened) to disk. Every committed transaction must wait for this.',
    causes: 'Slow transaction log disk (especially spinning disk), high transaction rate, log on same spindle as data, VLF fragmentation, auto-shrink on log.',
    actions: 'Move transaction log to dedicated fast storage (NVMe/SSD). Batch small transactions. Check for implicit transactions in applications. Disable auto-shrink.',
  },
  'LCK_M_S': {
    severity: 'high',
    description: 'Thread waiting to acquire a shared lock (read). Blocked by an incompatible exclusive or update lock held by another session.',
    causes: 'Long-running transactions holding exclusive locks, missing indexes causing lock escalation, high concurrency on hot tables.',
    actions: 'Identify blocking chain using sys.dm_exec_requests. Consider READ_COMMITTED_SNAPSHOT isolation level. Review long-running transactions. Add indexes to reduce scan scope.',
  },
  'LCK_M_X': {
    severity: 'high',
    description: 'Thread waiting to acquire an exclusive lock (write). Blocked by any other lock on the resource.',
    causes: 'Concurrent writes to the same rows/pages, missing indexes causing row-level locks to escalate to page/table locks, long transactions.',
    actions: 'Review concurrent write patterns. Check for lock escalation. Use sys.dm_os_waiting_tasks to identify the blocking chain. Consider partitioning hot tables.',
  },
  'LCK_M_U': {
    severity: 'high',
    description: 'Thread waiting to acquire an update lock. SQL Server takes update locks before converting to exclusive to prevent deadlocks.',
    causes: 'High concurrency on UPDATE statements, missing indexes causing broad update ranges.',
    actions: 'Add indexes to narrow UPDATE scope. Review transaction duration. Consider optimistic concurrency (SNAPSHOT isolation).',
  },
  'RESOURCE_SEMAPHORE': {
    severity: 'high',
    description: 'Thread waiting for a memory grant to execute a query (sort, hash join, build operations). Query cannot start until memory is available.',
    causes: 'Incorrect cardinality estimates leading to over-requested memory grants, missing indexes causing hash joins instead of nested loops, insufficient max server memory.',
    actions: 'Update statistics. Add missing indexes to improve join strategies. Review queries with large memory grants in sys.dm_exec_query_memory_grants. Consider Resource Governor.',
  },
  'ASYNC_NETWORK_IO': {
    severity: 'medium',
    description: 'SQL Server has results ready but the client application is not reading them fast enough. The server buffers results and waits.',
    causes: 'Application processing rows one-by-one instead of buffering, slow client network, application doing heavy processing between fetches, row-by-row cursors.',
    actions: 'Ensure applications fetch all results promptly. Use SET NOCOUNT ON. Review cursor usage. Check network bandwidth between app and SQL Server.',
  },
  'PAGELATCH_EX': {
    severity: 'medium',
    description: 'Thread waiting for an in-memory page latch (exclusive). Unlike PAGEIOLATCH, the page is already in the buffer pool — this is pure in-memory contention.',
    causes: 'Tempdb contention (PFS/GAM/SGAM pages), sequential key inserts causing last-page contention, hot allocation pages.',
    actions: 'For tempdb: add multiple data files (1 per CPU up to 8). For user tables: use NEWID() instead of sequential keys. Enable trace flag 1118/1117 on older SQL versions.',
  },
  'PAGELATCH_SH': {
    severity: 'medium',
    description: 'Thread waiting for a shared in-memory page latch. Hot page being read concurrently by many threads.',
    causes: 'Very frequently accessed pages, tempdb allocation page contention.',
    actions: 'Same as PAGELATCH_EX. Review tempdb configuration.',
  },
  'THREADPOOL': {
    severity: 'high',
    description: 'No worker threads available to service new requests. SQL Server has exhausted its worker thread pool. New connections queue up and timeout.',
    causes: 'Too many simultaneous connections, long-running blocking chains consuming threads, very high parallelism consuming multiple threads per query.',
    actions: 'URGENT: identify and kill blocking chains immediately. Review max worker threads setting. Reduce connection count. Implement connection pooling properly in the application.',
  },
  'IO_COMPLETION': {
    severity: 'medium',
    description: 'Thread waiting for non-data file I/O operations to complete (e.g., backup, restore, sort spills to tempdb).',
    causes: 'Slow tempdb storage causing query spills, backup I/O competing with workload, large sorts exceeding memory grants.',
    actions: 'Move tempdb to fast storage. Increase max server memory to reduce spills. Review backup I/O scheduling.',
  },
  'BACKUPIO': {
    severity: 'low',
    description: 'Thread waiting for backup I/O. Normal during backup operations.',
    causes: 'Active backup running.',
    actions: 'Expected during backups. If impacting production, schedule backups during low-activity windows or throttle with MAXTRANSFERSIZE/BUFFERCOUNT.',
  },
  'HADR_SYNC_COMMIT': {
    severity: 'medium',
    description: 'Primary replica waiting for synchronous secondary replica to harden log records before acknowledging commit. Directly adds to user transaction latency.',
    causes: 'Slow network between replicas, slow secondary storage, high transaction log volume, secondary replica under CPU or I/O pressure.',
    actions: 'Check network latency between AG replicas. Monitor secondary redo queue. Consider switching to asynchronous commit if latency is acceptable. Review secondary hardware.',
  },
};

// ─── Init ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  setupModal();
  setupTabs();
  setupServerSwitch();
  setupRefreshControl();
  setupThemeToggle();
  setupWaitPanel();
  loadInitialConfig();
});

// ─── Theme Toggle ─────────────────────────────────
function setupThemeToggle() {
  const btn = el('theme-toggle');
  const saved = localStorage.getItem('wd-theme') || 'dark';
  applyTheme(saved);
  btn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem('wd-theme', next);
  });
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  el('theme-toggle').textContent = theme === 'dark' ? '🌙' : '☀️';
}

// ─── Config load ──────────────────────────────────
function loadInitialConfig() {
  fetch('/api/config')
    .then(r => r.json())
    .then(cfg => {
      refreshInterval = (cfg.refresh_seconds || 5) * 1000;
      el('refresh-select').value = String(refreshInterval);
      const servers = cfg.available_servers || [];
      hasServers = servers.length > 0;
      rebuildServerSelect(servers, cfg.current_server);
      if (hasServers) { refresh(); } else { showNoServerState(); }
    })
    .catch(() => { showNoServerState(); });
}

function showNoServerState() {
  el('no-server-hint').classList.remove('hidden');
  el('server-info-panel').classList.add('hidden');
  el('server-switcher-wrap').classList.add('hidden');
  setAmpel(null);
  setStatus(false);
}

// ─── Modal ────────────────────────────────────────
function setupModal() {
  el('add-server-btn').addEventListener('click', openModal);
  el('modal-close-btn').addEventListener('click', closeModal);
  el('modal-overlay').addEventListener('click', e => { if (e.target === el('modal-overlay')) closeModal(); });
  document.querySelectorAll('.auth-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.auth-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentAuthMode = btn.dataset.auth;
      el('sql-auth-fields').classList.toggle('hidden', currentAuthMode !== 'sql');
    });
  });
  el('connect-btn').addEventListener('click', connectServer);
  ['f-name','f-host','f-port','f-instance','f-user','f-password'].forEach(id => {
    el(id).addEventListener('keydown', e => { if (e.key === 'Enter') connectServer(); });
  });
}

function openModal() {
  el('connect-error').classList.add('hidden');
  el('modal-overlay').classList.remove('hidden');
  setTimeout(() => el('f-host').focus(), 50);
}

function closeModal() { el('modal-overlay').classList.add('hidden'); }

function connectServer() {
  const host = el('f-host').value.trim();
  if (!host) { showConnectError('Please enter a host or IP address.'); return; }

  const payload = {
    name:      el('f-name').value.trim() || host,
    host,
    port:      parseInt(el('f-port').value) || 1433,
    instance:  el('f-instance').value.trim(),
    auth_mode: currentAuthMode,
    user:      el('f-user').value.trim(),
    password:  el('f-password').value,
  };

  setConnectLoading(true);
  el('connect-error').classList.add('hidden');

  fetch('/api/server/add', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload),
  })
  .then(r => r.json())
  .then(data => {
    setConnectLoading(false);
    if (data.error) { showConnectError(data.error); return; }
    closeModal();
    hasServers = true;
    el('server-switcher-wrap').classList.remove('hidden');
    el('no-server-hint').classList.add('hidden');
    loadInitialConfig();
  })
  .catch(err => { setConnectLoading(false); showConnectError('Request failed: ' + err.message); });
}

function showConnectError(msg) {
  const e = el('connect-error');
  e.textContent = '⚠ ' + msg;
  e.classList.remove('hidden');
}

function setConnectLoading(loading) {
  el('connect-btn').disabled = loading;
  el('connect-btn-text').textContent = loading ? 'Connecting...' : 'Connect';
  el('connect-spinner').classList.toggle('hidden', !loading);
}

// ─── Server remove ────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  el('remove-server-btn').addEventListener('click', () => {
    const name = el('server-select').value;
    if (!name) return;
    if (!confirm(`Remove server "${name}"?`)) return;
    fetch('/api/server/remove?name=' + encodeURIComponent(name))
      .then(r => r.json())
      .then(() => loadInitialConfig())
      .catch(console.error);
  });
});

// ─── Server select / switcher ─────────────────────
function rebuildServerSelect(servers, current) {
  const sel = el('server-select');
  sel.innerHTML = '';
  servers.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    sel.appendChild(opt);
  });
  if (current) sel.value = current;
  el('server-switcher-wrap').classList.toggle('hidden', servers.length === 0);
}

function setupServerSwitch() {
  el('server-select').addEventListener('change', e => {
    fetch('/api/switch?name=' + encodeURIComponent(e.target.value))
      .then(() => refresh())
      .catch(console.error);
  });
}

function setupRefreshControl() {
  el('refresh-select').addEventListener('change', e => {
    refreshInterval = parseInt(e.target.value);
    scheduleRefresh();
  });
}

function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  if (!hasServers) return;
  refreshTimer = setTimeout(refresh, refreshInterval);
}

// ─── Tabs ─────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      el('tab-' + btn.dataset.tab).classList.add('active');
    });
  });
}

// ─── Wait Detail Panel ────────────────────────────
function setupWaitPanel() {
  el('wp-close').addEventListener('click', closeWaitPanel);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeWaitPanel(); });
}

function openWaitPanel(waitType, category) {
  const info = WAIT_INFO[waitType];
  el('wp-type').textContent = waitType;
  el('wp-cat').textContent  = category || categorizeWaitJS(waitType);

  const sev = el('wp-severity');
  if (info) {
    sev.textContent  = severityLabel(info.severity);
    sev.className    = 'wp-severity ' + info.severity;
    el('wp-description').textContent = info.description;
    el('wp-causes').textContent      = info.causes;
    el('wp-actions').textContent     = info.actions;
  } else {
    sev.textContent  = 'ℹ Severity Unknown';
    sev.className    = 'wp-severity info';
    el('wp-description').textContent = 'No detailed description available for this wait type.';
    el('wp-causes').textContent      = 'Refer to the SQLskills Wait Library for details.';
    el('wp-actions').textContent     = 'Check the SQLskills library link below.';
  }
  el('wp-link').href = 'https://www.sqlskills.com/help/waits/' + encodeURIComponent(waitType.toLowerCase());
  el('wait-panel').classList.remove('hidden');
}

function closeWaitPanel() { el('wait-panel').classList.add('hidden'); }

function severityLabel(s) {
  return {high:'🔴 High Severity — Investigate immediately', medium:'🟡 Medium Severity — Monitor closely', low:'🟢 Low Severity — Usually benign', info:'ℹ Informational'}[s] || s;
}

function categorizeWaitJS(wt) {
  wt = wt.toUpperCase();
  if (wt.startsWith('LCK_M_')) return 'Locking/Blocking';
  if (wt.startsWith('PAGEIOLATCH_')) return 'I/O';
  if (wt.startsWith('PAGELATCH_')) return 'Memory/Latch';
  if (wt === 'WRITELOG' || wt.startsWith('IO_COMPLETION') || wt.startsWith('ASYNC_IO_COMPLETION')) return 'I/O';
  if (wt === 'SOS_SCHEDULER_YIELD' || wt === 'THREADPOOL') return 'CPU';
  if (wt === 'CXPACKET' || wt === 'CXCONSUMER') return 'Parallelism';
  if (wt === 'RESOURCE_SEMAPHORE') return 'Memory';
  if (wt.startsWith('ASYNC_NETWORK_IO')) return 'Network';
  if (wt.startsWith('HADR_')) return 'HA/AG';
  return 'Other';
}

// ─── Main refresh ─────────────────────────────────
function refresh() {
  if (!hasServers) return;
  fetch('/api/all')
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(data => {
      if (data.no_servers) { showNoServerState(); return; }
      setStatus(true);
      renderOverview(data.overview);
      renderWaits(data.waits || []);
      renderActive(data.active || []);
      renderBlocking(data.blocking || []);
      renderRecommendations(data.recommendations || []);
      renderCharts(data.waits || [], data.overview);
      el('last-refresh').textContent = 'Last refresh: ' + new Date().toLocaleTimeString();
    })
    .catch(err => { setStatus(false); console.error(err); })
    .finally(() => scheduleRefresh());

  fetch('/api/deadlocks')
    .then(r => r.json())
    .then(data => renderDeadlocks(data || []))
    .catch(() => {});
}

function setStatus(ok) { el('status-dot').className = 'status-dot ' + (ok ? 'ok' : 'error'); }

// ─── Ampel ────────────────────────────────────────
function setAmpel(status) {
  el('amp-red').className    = 'ampel-light' + (status === 'red'    ? ' on-red'    : '');
  el('amp-yellow').className = 'ampel-light' + (status === 'yellow' ? ' on-yellow' : '');
  el('amp-green').className  = 'ampel-light' + (status === 'green'  ? ' on-green'  : '');
}

// ─── Overview ─────────────────────────────────────
function renderOverview(ov) {
  if (!ov) return;
  setAmpel(ov.health_status || 'green');
  el('server-info-panel').classList.remove('hidden');
  el('no-server-hint').classList.add('hidden');

  setText('sip-name', ov.server_name || ov.current_server || '—');
  const edition = (ov.edition || '').replace(/\s*\(64-bit\)/i,'').replace(/\s*\(RTM\)/i,'');
  setText('sip-edition', edition || '—');
  setText('sip-level', [ov.product_level, ov.product_update].filter(Boolean).join(' ') || '—');
  setText('sip-cpu',   ov.logical_cpus  ? ov.logical_cpus  + ' CPU' + (ov.logical_cpus  > 1 ? 's' : '') : '—');
  setText('sip-ram',   ov.physical_mem_gb ? ov.physical_mem_gb + ' GB RAM' : '—');
  if (ov.uptime_hours !== undefined) {
    const h = Math.floor(ov.uptime_hours);
    const m = Math.floor((ov.uptime_hours - h) * 60);
    setText('sip-uptime', 'Up ' + h + 'h ' + m + 'm');
  }

  const sigPct = ov.signal_wait_pct || 0;
  el('kpi-signal-val').textContent = sigPct.toFixed(1) + '%';
  el('kpi-signal').className = 'kpi-card ' + (sigPct > 25 ? 'pressure' : sigPct > 15 ? 'warning' : 'ok');
  el('kpi-signal-val').className = 'kpi-value ' + (sigPct > 25 ? 'red' : sigPct > 15 ? 'yellow' : 'green');

  el('kpi-topcat-val').textContent = ov.top_wait_category || 'None';
  el('kpi-topcat-val').className   = 'kpi-value white';

  el('kpi-blocked-val').textContent = ov.blocked_count || 0;
  el('kpi-blocked').className = 'kpi-card ' + (ov.blocked_count > 0 ? 'pressure' : '');
  el('kpi-blocked-val').className = 'kpi-value ' + (ov.blocked_count > 0 ? 'red' : 'green');

  el('kpi-active-val').textContent = ov.active_request_count || 0;
  el('kpi-active-val').className   = 'kpi-value blue';

  if (ov.available_servers && ov.available_servers.length) {
    rebuildServerSelect(ov.available_servers, ov.current_server);
    hasServers = true;
  }
}

// ─── Waits tables ─────────────────────────────────
function renderWaits(waits) {
  const deltaOnly = waits.filter(w => w.delta_wait_time_ms > 0);
  maxDeltaWait = Math.max(1, ...deltaOnly.map(w => w.delta_wait_time_ms));

  renderTable('tbl-delta-waits', deltaOnly, row => {
    const pct = (row.delta_wait_time_ms / maxDeltaWait * 100).toFixed(0);
    return `
      <td><span class="td-wait" onclick="openWaitPanel('${esc(row.wait_type)}','${esc(row.category)}')" title="Click for details">${esc(row.wait_type)}</span></td>
      <td>${catBadge(row.category)}</td>
      <td class="td-number">
        <div class="delta-bar-wrap">
          <span>${fmtNum(row.delta_wait_time_ms)}</span>
          <div class="delta-bar-bg"><div class="delta-bar-fill" style="width:${pct}%"></div></div>
        </div>
      </td>
      <td class="td-number">${fmtNum(row.delta_tasks_count)}</td>
      <td class="td-number">${row.avg_wait_ms.toFixed(2)}</td>
      <td class="td-number">${fmtNum(row.max_wait_time_ms)}</td>
      <td class="td-number">${row.percent_of_total.toFixed(2)}%</td>`;
  });

  const cumulative = [...waits].sort((a,b) => b.wait_time_ms - a.wait_time_ms);
  renderTable('tbl-cumulative-waits', cumulative, row => `
    <td><span class="td-wait" onclick="openWaitPanel('${esc(row.wait_type)}','${esc(row.category)}')" title="Click for details">${esc(row.wait_type)}</span></td>
    <td>${catBadge(row.category)}</td>
    <td class="td-number">${fmtNum(row.wait_time_ms)}</td>
    <td class="td-number">${fmtNum(row.waiting_tasks_count)}</td>
    <td class="td-number">${fmtNum(row.signal_wait_time_ms)}</td>
    <td class="td-number">${fmtNum(row.resource_wait_ms)}</td>
    <td class="td-number">${row.avg_wait_ms.toFixed(2)}</td>
    <td class="td-number">${fmtNum(row.max_wait_time_ms)}</td>
    <td class="td-number">${row.percent_of_total.toFixed(2)}%</td>`);
}

// ─── Active requests ──────────────────────────────
function renderActive(active) {
  renderTable('tbl-active', active, r => {
    const blocked = r.blocking_session_id > 0;
    const statusCls = blocked ? 'blocked' : (r.status === 'running' ? 'running' : 'suspended');
    return `
      <td><span class="spid-badge ${blocked ? 'spid-blocked':''}">${r.session_id}</span></td>
      <td><span class="status-badge status-${statusCls}">${esc(r.status)}</span></td>
      <td><span class="td-wait" onclick="openWaitPanel('${esc(r.wait_type)}','')">${esc(r.wait_type)||'—'}</span></td>
      <td class="td-number">${fmtNum(r.wait_time_ms)}</td>
      <td class="td-number">${r.blocking_session_id>0?`<span class="spid-blocking">${r.blocking_session_id}</span>`:'—'}</td>
      <td class="td-number">${fmtNum(r.total_elapsed_ms)}</td>
      <td class="td-number">${fmtNum(r.cpu_time)}</td>
      <td class="td-number">${fmtNum(r.logical_reads)}</td>
      <td>${esc(r.database_name)}</td>
      <td>${esc(r.login_name)}</td>
      <td>${esc(r.host_name)}</td>
      <td class="td-sql" title="${esc(r.sql_text)}">${esc((r.sql_text||'').substring(0,80))}</td>`;
  });
}

// ─── Blocking ─────────────────────────────────────
function renderBlocking(blocking) {
  renderTable('tbl-blocking', blocking, b => `
    <td><span class="spid-badge spid-blocked">${b.blocked_session_id}</span></td>
    <td><span class="spid-badge spid-blocking">${b.blocking_session_id}</span></td>
    <td><span class="td-wait" onclick="openWaitPanel('${esc(b.wait_type)}','')">${esc(b.wait_type)}</span></td>
    <td style="font-family:'Consolas',monospace;font-size:12px">${esc(b.wait_resource)}</td>
    <td class="td-number">${fmtNum(b.wait_time_ms)}</td>
    <td class="td-sql" title="${esc(b.blocked_sql)}">${esc((b.blocked_sql||'').substring(0,80))}</td>
    <td class="td-sql" title="${esc(b.blocking_sql)}">${esc((b.blocking_sql||'').substring(0,80))}</td>`);
}

// ─── Recommendations ──────────────────────────────
function renderRecommendations(recs) {
  const container = el('recs-container');
  if (!recs || recs.length === 0) {
    container.innerHTML = '<div class="no-data">No recommendations available.</div>';
    return;
  }
  const icons = {high:'🔴', medium:'🟡', info:'🟢'};
  container.innerHTML = recs.map(r => `
    <div class="rec-card ${esc(r.severity)}">
      <div class="rec-icon">${icons[r.severity]||'ℹ️'}</div>
      <div class="rec-body">
        <div class="rec-cat">${esc(r.category)}</div>
        <div class="rec-msg">${esc(r.message)}</div>
      </div>
    </div>`).join('');
}

// ─── Deadlocks ────────────────────────────────────
function renderDeadlocks(deadlocks) {
  const container = el('deadlocks-container');
  if (!deadlocks || deadlocks.length === 0) {
    container.innerHTML = '<div class="no-data">No deadlocks found in system_health ring buffer.</div>';
    return;
  }
  container.innerHTML = deadlocks.map(d => `
    <div class="deadlock-card">
      <div class="deadlock-header"><span class="deadlock-time">💀 ${esc(d.timestamp)}</span></div>
      <div class="deadlock-xml">${esc(d.xml_preview)}</div>
    </div>`).join('');
}

// ─── Charts ───────────────────────────────────────
function renderCharts(waits, ov) {
  renderCategoryChart(waits);
  renderTopWaitsChart(waits);
  renderSignalChart(ov);
}

function getThemeColors() {
  const dark = document.documentElement.getAttribute('data-theme') !== 'light';
  return {
    bg:      dark ? '#161b22' : '#ffffff',
    bg2:     dark ? '#1c2230' : '#f6f8fa',
    text:    dark ? '#c9d1d9' : '#1f2328',
    muted:   dark ? '#6e7681' : '#656d76',
    accent:  dark ? '#58a6ff' : '#0969da',
    accentBg:dark ? '#1c3a5e' : '#ddf4ff',
  };
}

const CAT_COLORS = {
  'CPU':'#f85149','I/O':'#58a6ff','Memory':'#bc8cff','Memory/Latch':'#bc8cff',
  'Locking/Blocking':'#e3794b','Locking':'#e3794b','Parallelism':'#d29922',
  'Network':'#3fb950','HA/AG':'#79c0ff','CLR':'#ff7b72','Latch':'#e3794b','Other':'#484f58',
};

function renderCategoryChart(waits) {
  const canvas = el('chart-category');
  const ctx    = canvas.getContext('2d');
  const tc     = getThemeColors();

  const catTotals = {};
  waits.forEach(w => { if (w.delta_wait_time_ms > 0) catTotals[w.category] = (catTotals[w.category]||0) + w.delta_wait_time_ms; });
  const labels = Object.keys(catTotals).filter(k => catTotals[k] > 0);
  const values = labels.map(k => catTotals[k]);
  const total  = values.reduce((a,b) => a+b, 0);

  const W = canvas.width  = canvas.offsetWidth  * devicePixelRatio;
  const H = canvas.height = canvas.offsetHeight * devicePixelRatio;
  canvas.style.width  = canvas.offsetWidth  + 'px';
  canvas.style.height = canvas.offsetHeight + 'px';
  ctx.clearRect(0, 0, W, H);

  if (total === 0) { drawCenter(ctx, W, H, tc.muted, 'No delta waits'); return; }

  const cx=W*.35, cy=H/2, r=Math.min(cx,cy)*.78, ir=r*.5;
  let angle = -Math.PI/2;
  values.forEach((val,i)=>{
    const slice=(val/total)*2*Math.PI;
    ctx.beginPath(); ctx.moveTo(cx,cy); ctx.arc(cx,cy,r,angle,angle+slice); ctx.closePath();
    ctx.fillStyle=CAT_COLORS[labels[i]]||'#484f58'; ctx.fill();
    ctx.strokeStyle=tc.bg; ctx.lineWidth=2; ctx.stroke();
    angle+=slice;
  });
  ctx.beginPath(); ctx.arc(cx,cy,ir,0,2*Math.PI); ctx.fillStyle=tc.bg; ctx.fill();

  const lx=W*.68; let ly=H*.12; const lh=Math.min(H*.11,18*devicePixelRatio);
  ctx.font=`${Math.max(9,lh*.55)}px Segoe UI`;
  labels.forEach((label,i)=>{
    if(ly>H*.95)return;
    ctx.fillStyle=CAT_COLORS[label]||'#484f58';
    ctx.fillRect(lx-lh*.8,ly-lh*.45,lh*.5,lh*.5);
    ctx.fillStyle=tc.text; ctx.textAlign='left';
    ctx.fillText(`${label} ${((values[i]/total)*100).toFixed(1)}%`,lx,ly);
    ly+=lh;
  });
}

function renderTopWaitsChart(waits) {
  const canvas = el('chart-topwaits');
  const ctx    = canvas.getContext('2d');
  const tc     = getThemeColors();
  const top10  = waits.filter(w=>w.delta_wait_time_ms>0).slice(0,10);

  const W = canvas.width  = canvas.offsetWidth  * devicePixelRatio;
  const H = canvas.height = canvas.offsetHeight * devicePixelRatio;
  canvas.style.width  = canvas.offsetWidth  + 'px';
  canvas.style.height = canvas.offsetHeight + 'px';
  ctx.clearRect(0, 0, W, H);

  if (top10.length===0) { drawCenter(ctx,W,H,tc.muted,'No delta waits'); return; }

  const maxVal  = Math.max(...top10.map(w=>w.delta_wait_time_ms));
  const rowH    = H/top10.length;
  const barH    = rowH*.65;
  const labelW  = W*.42;
  const barArea = W-labelW-W*.2;
  const fs      = Math.max(10, barH*.58);

  ctx.font = `${fs}px Consolas,monospace`;

  top10.forEach((w,i)=>{
    const y      = i*rowH+(rowH-barH)/2;
    const barLen = (w.delta_wait_time_ms/maxVal)*barArea;

    // Background bar
    ctx.fillStyle=tc.accentBg;
    if(ctx.roundRect) ctx.roundRect(labelW,y,barArea,barH,3); else ctx.rect(labelW,y,barArea,barH);
    ctx.fill();

    // Value bar
    ctx.fillStyle=tc.accent;
    if(ctx.roundRect) ctx.roundRect(labelW,y,barLen,barH,3); else ctx.rect(labelW,y,barLen,barH);
    ctx.fill();

    // Wait type label
    ctx.fillStyle=tc.accent;
    ctx.textAlign='right';
    const label = w.wait_type.length > 26 ? w.wait_type.substring(0,24)+'…' : w.wait_type;
    ctx.fillText(label, labelW-6, y+barH*.73);

    // Value
    ctx.fillStyle=tc.muted;
    ctx.textAlign='left';
    ctx.fillText(fmtNum(w.delta_wait_time_ms), labelW+barLen+6, y+barH*.73);
  });
}

function renderSignalChart(ov) {
  if (!ov) return;
  const canvas = el('chart-signal');
  const ctx    = canvas.getContext('2d');
  const tc     = getThemeColors();

  const W = canvas.width  = canvas.offsetWidth  * devicePixelRatio;
  const H = canvas.height = canvas.offsetHeight * devicePixelRatio;
  canvas.style.width  = canvas.offsetWidth  + 'px';
  canvas.style.height = canvas.offsetHeight + 'px';
  ctx.clearRect(0, 0, W, H);

  const sig = ov.signal_wait_ms   || 0;
  const res = ov.resource_wait_ms || 0;
  const tot = sig + res;

  if (tot===0) { drawCenter(ctx,W,H,tc.muted,'No wait data yet'); return; }

  const cx=W/2, cy=H*.44, r=Math.min(cx,cy*.95)*.75, ir=r*.52;
  const sigPct=sig/tot;
  const sigColor = sigPct>.25 ? '#f85149' : '#d29922';

  ctx.beginPath(); ctx.moveTo(cx,cy);
  ctx.arc(cx,cy,r,-Math.PI/2,-Math.PI/2+sigPct*2*Math.PI); ctx.closePath();
  ctx.fillStyle=sigColor; ctx.fill();

  ctx.beginPath(); ctx.moveTo(cx,cy);
  ctx.arc(cx,cy,r,-Math.PI/2+sigPct*2*Math.PI,-Math.PI/2+2*Math.PI); ctx.closePath();
  ctx.fillStyle=tc.accent; ctx.fill();

  ctx.strokeStyle=tc.bg; ctx.lineWidth=2; ctx.stroke();
  ctx.beginPath(); ctx.arc(cx,cy,ir,0,2*Math.PI); ctx.fillStyle=tc.bg; ctx.fill();

  ctx.fillStyle=sigColor;
  ctx.font=`bold ${Math.max(11,ir*.42)}px Segoe UI`;
  ctx.textAlign='center';
  ctx.fillText((sigPct*100).toFixed(1)+'%',cx,cy+4);
  ctx.fillStyle=tc.muted;
  ctx.font=`${Math.max(9,ir*.28)}px Segoe UI`;
  ctx.fillText('Signal',cx,cy+ir*.38);

  const fs=Math.max(10,H*.058);
  ctx.font=`${fs}px Segoe UI`; ctx.textAlign='left';
  ctx.fillStyle=sigColor;
  ctx.fillText('▪ Signal: '+fmtNum(sig)+' ms', W*.05, H*.88);
  ctx.fillStyle=tc.accent;
  ctx.fillText('▪ Resource: '+fmtNum(res)+' ms', W*.05, H*.88+fs*1.4);
}

function drawCenter(ctx,W,H,color,msg) {
  ctx.fillStyle=color; ctx.font='13px Segoe UI';
  ctx.textAlign='center'; ctx.fillText(msg,W/2,H/2);
}

// ─── Helpers ──────────────────────────────────────
function el(id) { return document.getElementById(id); }
function setText(id,val) { const e=el(id); if(e) e.textContent=val; }

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function fmtNum(n) { if(n==null)return'0'; return Number(n).toLocaleString(); }

function catBadge(cat) {
  const cls=(cat||'Other').replace(/[^a-zA-Z]/g,'-');
  return `<span class="cat-badge cat-${cls}">${esc(cat)}</span>`;
}

function renderTable(tableId, rows, rowFn) {
  const tbody = document.querySelector(`#${tableId} tbody`);
  if (!tbody) return;
  if (!rows || rows.length===0) {
    tbody.innerHTML=`<tr><td colspan="20" class="no-data">No data</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(row=>`<tr>${rowFn(row)}</tr>`).join('');
}
