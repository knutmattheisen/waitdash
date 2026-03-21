'use strict';

// ─── State ────────────────────────────────────────
let refreshInterval  = 5000;
let refreshTimer     = null;
let currentAuthMode  = 'windows';
let hasServers       = false;
let activePaused     = false;
let blockingPaused   = false;
let showOther        = false;

// Sort state per table
const sortState = {
  'tbl-delta-waits':     {col:'delta_wait_time_ms', dir:'desc'},
  'tbl-cumulative-waits':{col:'wait_time_ms',       dir:'desc'},
  'tbl-active':          {col:'total_elapsed_ms',   dir:'desc'},
  'tbl-blocking':        {col:'wait_time_ms',        dir:'desc'},
};

// Last data cache for pause + re-sort
let lastWaits    = [];
let lastActive   = [];
let lastBlocking = [];

// ─── Wait Knowledge Base ──────────────────────────
const WAIT_INFO = {
  'SOS_SCHEDULER_YIELD':{severity:'high',description:'A thread voluntarily yielded the CPU scheduler after using its full quantum (4ms) without completing. Indicates CPU-intensive work.',causes:'Missing indexes causing large scans, non-sargable queries, parameter sniffing, too many parallel threads, CPU-bound hash/sort operations.',actions:'Identify top CPU queries via sys.dm_exec_query_stats. Check missing indexes. Review execution plans for large scans. Consider more CPU or reviewing MAXDOP.'},
  'CXPACKET':{severity:'medium',description:'Threads waiting for parallel query synchronization. One thread finishes its portion and waits for slower sibling threads.',causes:'High MAXDOP, skewed data distribution causing uneven parallel work, Cost Threshold for Parallelism set too low.',actions:'Check MAXDOP setting. Raise Cost Threshold for Parallelism (default 5 is too low — try 50). Look for skewed statistics on parallel query tables.'},
  'CXCONSUMER':{severity:'low',description:'Consumer thread in a parallel query waiting for the producer thread to provide rows. Introduced in SQL 2016 SP2.',causes:'Normal parallel query execution. Only concerning if combined with high CXPACKET.',actions:'Usually benign. Only act if combined wait times are very high.'},
  'PAGEIOLATCH_SH':{severity:'high',description:'Thread waiting for a data page to be read from disk into the buffer pool (shared latch — read operation).',causes:'Insufficient buffer pool (RAM), missing indexes causing full table scans, slow storage, large working set exceeding available memory.',actions:'Add RAM. Check storage latency (<1ms NVMe, <5ms SSD). Add missing indexes. Check for large table scans.'},
  'PAGEIOLATCH_EX':{severity:'high',description:'Thread waiting for a data page to be read from disk (exclusive latch — write/modify).',causes:'Heavy INSERT/UPDATE/DELETE workloads with slow storage.',actions:'Investigate storage performance. Review write-heavy queries. Consider faster storage for data files.'},
  'PAGEIOLATCH_UP':{severity:'high',description:'Thread waiting for a data page (update latch). Precursor to exclusive latch for modification.',causes:'Write-heavy workloads, slow storage, insufficient memory.',actions:'Review storage performance and write patterns.'},
  'WRITELOG':{severity:'high',description:'Thread waiting for transaction log records to be flushed to disk. Every committed transaction must wait for this.',causes:'Slow transaction log disk, high transaction rate, log on same spindle as data, VLF fragmentation.',actions:'Move transaction log to dedicated fast storage (NVMe/SSD). Batch small transactions. Check for implicit transactions. Disable auto-shrink.'},
  'LCK_M_S':{severity:'high',description:'Thread waiting to acquire a shared lock (read). Blocked by an incompatible exclusive or update lock.',causes:'Long-running transactions holding exclusive locks, missing indexes causing lock escalation.',actions:'Identify blocking chain. Consider READ_COMMITTED_SNAPSHOT. Review long-running transactions. Add indexes.'},
  'LCK_M_X':{severity:'high',description:'Thread waiting to acquire an exclusive lock (write). Blocked by any other lock on the resource.',causes:'Concurrent writes to the same rows/pages, missing indexes causing lock escalation, long transactions.',actions:'Review concurrent write patterns. Check lock escalation. Use sys.dm_os_waiting_tasks for blocking chain.'},
  'LCK_M_U':{severity:'high',description:'Thread waiting to acquire an update lock. SQL Server takes update locks before converting to exclusive.',causes:'High concurrency on UPDATE statements, missing indexes causing broad update ranges.',actions:'Add indexes to narrow UPDATE scope. Review transaction duration. Consider SNAPSHOT isolation.'},
  'RESOURCE_SEMAPHORE':{severity:'high',description:'Thread waiting for a memory grant to execute a query (sort, hash join, build operations).',causes:'Incorrect cardinality estimates leading to over-requested grants, missing indexes causing hash joins, insufficient max server memory.',actions:'Update statistics. Add missing indexes. Review queries in sys.dm_exec_query_memory_grants. Consider Resource Governor.'},
  'ASYNC_NETWORK_IO':{severity:'medium',description:'SQL Server has results ready but the client application is not reading them fast enough.',causes:'Application processing rows one-by-one, slow client network, heavy processing between fetches, row-by-row cursors.',actions:'Ensure applications fetch all results promptly. Use SET NOCOUNT ON. Review cursor usage. Check network bandwidth.'},
  'PAGELATCH_EX':{severity:'medium',description:'Thread waiting for an in-memory page latch (exclusive). Page is already in buffer pool — pure in-memory contention.',causes:'Tempdb contention (PFS/GAM/SGAM pages), sequential key inserts causing last-page contention.',actions:'For tempdb: add multiple data files (1 per CPU up to 8). For user tables: avoid sequential keys. Enable trace flag 1118/1117 on older SQL.'},
  'PAGELATCH_SH':{severity:'medium',description:'Thread waiting for a shared in-memory page latch.',causes:'Very frequently accessed pages, tempdb allocation page contention.',actions:'Same as PAGELATCH_EX. Review tempdb configuration.'},
  'THREADPOOL':{severity:'high',description:'No worker threads available to service new requests. SQL Server has exhausted its thread pool.',causes:'Too many simultaneous connections, long-running blocking chains, high parallelism consuming multiple threads per query.',actions:'URGENT: identify and kill blocking chains. Review max worker threads. Reduce connection count. Implement connection pooling properly.'},
  'IO_COMPLETION':{severity:'medium',description:'Thread waiting for non-data file I/O (backup, restore, sort spills to tempdb).',causes:'Slow tempdb storage causing query spills, backup I/O competing with workload.',actions:'Move tempdb to fast storage. Increase max server memory to reduce spills. Review backup I/O scheduling.'},
  'HADR_SYNC_COMMIT':{severity:'medium',description:'Primary replica waiting for synchronous secondary to harden log records before acknowledging commit.',causes:'Slow network between replicas, slow secondary storage, high transaction log volume.',actions:'Check network latency between AG replicas. Monitor secondary redo queue. Consider async commit if latency is acceptable.'},
};

const CAT_COLORS = {
  'CPU':'#f85149','I/O':'#58a6ff','Memory':'#bc8cff','Memory/Latch':'#bc8cff',
  'Locking/Blocking':'#e3794b','Locking':'#e3794b','Parallelism':'#d29922',
  'Network':'#3fb950','HA/AG':'#79c0ff','Latch':'#e3794b','Other':'#484f58',
};

// ─── Init ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  setupModal();
  setupTabs();
  setupServerSwitch();
  setupRefreshControl();
  setupThemeToggle();
  setupWaitPanel();
  setupPauseButtons();
  setupShowOtherToggle();
  setupTableSort();
  loadInitialConfig();
});

// ─── Theme ────────────────────────────────────────
function setupThemeToggle() {
  const saved = localStorage.getItem('wd-theme') || 'dark';
  applyTheme(saved);
  el('theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem('wd-theme', next);
  });
}
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  el('theme-toggle').textContent = t === 'dark' ? '🌙' : '☀️';
}

// ─── Config ───────────────────────────────────────
function loadInitialConfig() {
  fetch('/api/config')
    .then(r => r.json())
    .then(cfg => {
      refreshInterval = (cfg.refresh_seconds || 5) * 1000;
      el('refresh-select').value = String(refreshInterval);
      const servers = cfg.available_servers || [];
      hasServers = servers.length > 0;
      rebuildServerSelect(servers, cfg.current_server);
      if (hasServers) refresh(); else showNoServerState();
    })
    .catch(() => showNoServerState());
}

function showNoServerState() {
  el('no-server-hint').classList.remove('hidden');
  el('server-info-panel').classList.add('hidden');
  el('server-switcher-wrap').classList.add('hidden');
  setAmpel(null, []);
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
    name: el('f-name').value.trim() || host, host,
    port: parseInt(el('f-port').value) || 1433,
    instance: el('f-instance').value.trim(),
    auth_mode: currentAuthMode,
    user: el('f-user').value.trim(),
    password: el('f-password').value,
  };
  setConnectLoading(true);
  el('connect-error').classList.add('hidden');
  fetch('/api/server/add', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
    .then(r => r.json())
    .then(data => {
      setConnectLoading(false);
      if (data.error) { showConnectError(data.error); return; }
      closeModal();
      hasServers = true;
      loadInitialConfig();
    })
    .catch(err => { setConnectLoading(false); showConnectError('Request failed: ' + err.message); });
}
function showConnectError(msg) { const e=el('connect-error'); e.textContent='⚠ '+msg; e.classList.remove('hidden'); }
function setConnectLoading(loading) {
  el('connect-btn').disabled = loading;
  el('connect-btn-text').textContent = loading ? 'Connecting...' : 'Connect';
  el('connect-spinner').classList.toggle('hidden', !loading);
}

// ─── Server remove & switch ───────────────────────
document.addEventListener('DOMContentLoaded', () => {
  el('remove-server-btn').addEventListener('click', () => {
    const name = el('server-select').value;
    if (!name || !confirm(`Remove server "${name}"?`)) return;
    fetch('/api/server/remove?name='+encodeURIComponent(name))
      .then(r => r.json()).then(() => loadInitialConfig()).catch(console.error);
  });
});

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
    fetch('/api/switch?name='+encodeURIComponent(e.target.value))
      .then(() => refresh()).catch(console.error);
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
    btn.addEventListener('click', e => {
      if (e.target.classList.contains('tab-pause-btn')) return;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      el('tab-' + btn.dataset.tab).classList.add('active');

      // Show pause buttons on relevant tabs
      el('pause-active').classList.toggle('hidden', btn.dataset.tab !== 'active-requests');
      el('pause-blocking').classList.toggle('hidden', btn.dataset.tab !== 'blocking');
    });
  });
}

// ─── Pause buttons ────────────────────────────────
function setupPauseButtons() {
  el('pause-active').addEventListener('click', e => {
    e.stopPropagation();
    activePaused = !activePaused;
    el('pause-active').classList.toggle('paused', activePaused);
    el('pause-active').textContent = activePaused ? '▶' : '⏸';
    el('pause-active').title = activePaused ? 'Resume refresh' : 'Pause refresh';
    el('active-paused-badge').classList.toggle('hidden', !activePaused);
    if (!activePaused) renderActive(lastActive);
  });
  el('pause-blocking').addEventListener('click', e => {
    e.stopPropagation();
    blockingPaused = !blockingPaused;
    el('pause-blocking').classList.toggle('paused', blockingPaused);
    el('pause-blocking').textContent = blockingPaused ? '▶' : '⏸';
    el('pause-blocking').title = blockingPaused ? 'Resume refresh' : 'Pause refresh';
    el('blocking-paused-badge').classList.toggle('hidden', !blockingPaused);
    if (!blockingPaused) renderBlocking(lastBlocking);
  });
}

// ─── Show Other toggle ────────────────────────────
function setupShowOtherToggle() {
  el('show-other-toggle').addEventListener('change', e => {
    showOther = e.target.checked;
    renderTopWaitsBars(lastWaits);
  });
}

// ─── Table sort ───────────────────────────────────
function setupTableSort() {
  document.querySelectorAll('.resizable-table thead th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const table = th.closest('table').id;
      const col   = th.dataset.sort;
      const state = sortState[table];
      if (state.col === col) {
        state.dir = state.dir === 'desc' ? 'asc' : 'desc';
      } else {
        state.col = col;
        state.dir = 'desc';
      }
      // Update header icons
      th.closest('thead').querySelectorAll('th').forEach(h => {
        h.classList.remove('sorted-asc','sorted-desc');
        const icon = h.querySelector('.sort-icon');
        if (icon) icon.textContent = '⇅';
      });
      th.classList.add(state.dir === 'desc' ? 'sorted-desc' : 'sorted-asc');
      const icon = th.querySelector('.sort-icon');
      if (icon) icon.textContent = state.dir === 'desc' ? '↓' : '↑';

      // Re-render
      if (table === 'tbl-delta-waits' || table === 'tbl-cumulative-waits') renderWaits(lastWaits);
      if (table === 'tbl-active')   renderActive(lastActive);
      if (table === 'tbl-blocking') renderBlocking(lastBlocking);
    });
  });

  // Column resize handles
  document.querySelectorAll('.resizable-table thead th').forEach(th => {
    const handle = document.createElement('div');
    handle.className = 'col-resize-handle';
    th.appendChild(handle);
    let startX, startW;
    handle.addEventListener('mousedown', e => {
      e.stopPropagation();
      startX = e.pageX;
      startW = th.offsetWidth;
      const onMove = ev => { th.style.width = Math.max(60, startW + ev.pageX - startX) + 'px'; };
      const onUp   = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}

function sortData(data, col, dir) {
  return [...data].sort((a, b) => {
    let av = a[col] ?? '', bv = b[col] ?? '';
    if (typeof av === 'number' && typeof bv === 'number') {
      return dir === 'desc' ? bv - av : av - bv;
    }
    av = String(av).toLowerCase(); bv = String(bv).toLowerCase();
    if (av < bv) return dir === 'desc' ? 1 : -1;
    if (av > bv) return dir === 'desc' ? -1 : 1;
    return 0;
  });
}

// ─── Copy to clipboard ───────────────────────────
function setupCopyOnClick() {
  document.querySelectorAll('.resizable-table tbody').forEach(tbody => {
    tbody.addEventListener('click', e => {
      const td = e.target.closest('td');
      if (!td) return;
      // Don't copy if clicking a wait-type link
      if (e.target.classList.contains('td-wait')) return;
      const text = td.getAttribute('data-copy') || td.textContent.trim();
      if (!text || text === '—') return;
      navigator.clipboard.writeText(text).then(() => showCopyToast()).catch(() => {});
    });
  });
}

function showCopyToast() {
  const t = el('copy-toast');
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 1500);
}

// ─── Wait Panel ───────────────────────────────────
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
    sev.textContent = severityLabel(info.severity);
    sev.className   = 'wp-severity ' + info.severity;
    el('wp-description').textContent = info.description;
    el('wp-causes').textContent      = info.causes;
    el('wp-actions').textContent     = info.actions;
  } else {
    sev.textContent = 'ℹ Severity Unknown'; sev.className = 'wp-severity info';
    el('wp-description').textContent = 'No detailed description available for this wait type.';
    el('wp-causes').textContent      = 'Refer to the SQLskills Wait Library for details.';
    el('wp-actions').textContent     = 'Check the SQLskills library link below.';
  }
  el('wp-link').href = 'https://www.sqlskills.com/help/waits/' + encodeURIComponent(waitType.toLowerCase());
  el('wait-panel').classList.remove('hidden');
}
function closeWaitPanel() { el('wait-panel').classList.add('hidden'); }
function severityLabel(s) {
  return {high:'🔴 High Severity — Investigate immediately',medium:'🟡 Medium Severity — Monitor closely',low:'🟢 Low Severity — Usually benign',info:'ℹ Informational'}[s] || s;
}
function categorizeWaitJS(wt) {
  wt = wt.toUpperCase();
  if (wt.startsWith('LCK_M_')) return 'Locking/Blocking';
  if (wt.startsWith('PAGEIOLATCH_')) return 'I/O';
  if (wt.startsWith('PAGELATCH_')) return 'Memory/Latch';
  if (wt === 'WRITELOG' || wt.startsWith('IO_COMPLETION')) return 'I/O';
  if (wt === 'SOS_SCHEDULER_YIELD' || wt === 'THREADPOOL') return 'CPU';
  if (wt === 'CXPACKET' || wt === 'CXCONSUMER') return 'Parallelism';
  if (wt === 'RESOURCE_SEMAPHORE') return 'Memory';
  if (wt.startsWith('ASYNC_NETWORK_IO')) return 'Network';
  if (wt.startsWith('HADR_')) return 'HA/AG';
  return 'Other';
}

// ─── Ampel ────────────────────────────────────────
function setAmpel(status, reasons) {
  el('amp-red').className    = 'ampel-light' + (status === 'red'    ? ' on-red'    : '');
  el('amp-yellow').className = 'ampel-light' + (status === 'yellow' ? ' on-yellow' : '');
  el('amp-green').className  = 'ampel-light' + (status === 'green'  ? ' on-green'  : '');

  const tooltip = el('ampel-tooltip');
  const colors  = {red:'🔴',yellow:'🟡',green:'🟢'};
  const labels  = {red:'Critical',yellow:'Warning',green:'Healthy'};
  const color   = status || 'green';
  const items   = (reasons || []).map(r => `<li>${esc(r)}</li>`).join('');
  tooltip.innerHTML = `
    <div class="ampel-tooltip-title">${colors[color]||'⚪'} ${labels[color]||'Unknown'}</div>
    <ul>${items || '<li>All metrics within normal thresholds</li>'}</ul>`;
}

// ─── Main refresh ─────────────────────────────────
function refresh() {
  if (!hasServers) return;
  fetch('/api/all')
    .then(r => { if (!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
    .then(data => {
      if (data.no_servers) { showNoServerState(); return; }
      setStatus(true);
      renderOverview(data.overview);
      lastWaits    = data.waits    || [];
      lastActive   = data.active   || [];
      lastBlocking = data.blocking || [];
      renderWaits(lastWaits);
      if (!activePaused)   renderActive(lastActive);
      if (!blockingPaused) renderBlocking(lastBlocking);
      renderRecommendations(data.recommendations || []);
      renderCharts(lastWaits, data.overview);
      el('last-refresh').textContent = 'Last refresh: ' + new Date().toLocaleTimeString();
      setTimeout(setupCopyOnClick, 50);
    })
    .catch(err => { setStatus(false); console.error(err); })
    .finally(() => scheduleRefresh());

  fetch('/api/deadlocks')
    .then(r => r.json()).then(data => renderDeadlocks(data||[])).catch(()=>{});
}

function setStatus(ok) { el('status-dot').className = 'status-dot '+(ok?'ok':'error'); }

// ─── Overview ─────────────────────────────────────
function renderOverview(ov) {
  if (!ov) return;
  setAmpel(ov.health_status, ov.health_reasons);
  el('server-info-panel').classList.remove('hidden');
  el('no-server-hint').classList.add('hidden');

  setText('sip-name', ov.server_name || ov.current_server || '—');
  setText('sip-edition', (ov.edition||'').replace(/\s*\(64-bit\)/i,'').replace(/\s*\(RTM\)/i,'') || '—');
  setText('sip-level',  [ov.product_level, ov.product_update].filter(Boolean).join(' ') || '—');
  setText('sip-cpu',    ov.logical_cpus   ? ov.logical_cpus   + ' CPU' + (ov.logical_cpus   > 1 ? 's' : '') : '—');
  setText('sip-ram',    ov.physical_mem_gb ? ov.physical_mem_gb + ' GB RAM' : '—');
  if (ov.uptime_hours !== undefined) {
    const h=Math.floor(ov.uptime_hours), m=Math.floor((ov.uptime_hours-h)*60);
    setText('sip-uptime', 'Up '+h+'h '+m+'m');
  }

  const sig = ov.signal_wait_pct||0;
  el('kpi-signal-val').textContent = sig.toFixed(1)+'%';
  el('kpi-signal').className = 'kpi-card '+(sig>25?'pressure':sig>15?'warning':'ok');
  el('kpi-signal-val').className = 'kpi-value '+(sig>25?'red':sig>15?'yellow':'green');

  el('kpi-topcat-val').textContent = ov.top_wait_category||'None';
  el('kpi-topcat-val').className   = 'kpi-value white';

  el('kpi-blocked-val').textContent = ov.blocked_count||0;
  el('kpi-blocked').className = 'kpi-card '+(ov.blocked_count>0?'pressure':'');
  el('kpi-blocked-val').className = 'kpi-value '+(ov.blocked_count>0?'red':'green');

  el('kpi-active-val').textContent = ov.active_request_count||0;
  el('kpi-active-val').className   = 'kpi-value blue';

  if (ov.available_servers&&ov.available_servers.length) {
    rebuildServerSelect(ov.available_servers, ov.current_server);
    hasServers = true;
  }
}

// ─── Charts ───────────────────────────────────────
function renderCharts(waits, ov) {
  renderStackedBar(waits);
  renderTopWaitsBars(waits);
  renderSignalRes(ov);
}

function renderStackedBar(waits) {
  const catTotals = {};
  waits.forEach(w => {
    if (w.delta_wait_time_ms > 0 && (showOther || w.category !== 'Other')) {
      catTotals[w.category] = (catTotals[w.category]||0) + w.delta_wait_time_ms;
    }
  });

  const total = Object.values(catTotals).reduce((a,b)=>a+b,0);
  const bar     = el('stacked-bar-inner');
  const legend  = el('stacked-legend');

  if (total === 0) {
    bar.innerHTML = '<div style="width:100%;background:var(--bg3);height:100%;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--text-muted)">No delta waits</div>';
    legend.innerHTML = '';
    return;
  }

  // Sort by value desc
  const entries = Object.entries(catTotals).sort((a,b)=>b[1]-a[1]);

  bar.innerHTML = entries.map(([cat, val]) => {
    const pct  = (val/total*100).toFixed(1);
    const color = CAT_COLORS[cat] || '#484f58';
    return `<div class="stacked-segment" style="width:${pct}%;background:${color}" title="${cat}: ${pct}% (${fmtNum(val)} ms)" onclick="openWaitPanel('','')" data-cat="${esc(cat)}"></div>`;
  }).join('');

  legend.innerHTML = entries.map(([cat, val]) => {
    const pct   = (val/total*100).toFixed(1);
    const color = CAT_COLORS[cat] || '#484f58';
    return `<div class="legend-item"><div class="legend-dot" style="background:${color}"></div><span>${esc(cat)} <strong>${pct}%</strong></span></div>`;
  }).join('');
}

function renderTopWaitsBars(waits) {
  const container = el('top-waits-bars');
  const filtered  = waits
    .filter(w => w.delta_wait_time_ms > 0 && (showOther || w.category !== 'Other'))
    .slice(0, 10);

  if (filtered.length === 0) {
    container.innerHTML = '<div class="no-data" style="padding:16px">No delta waits this interval</div>';
    return;
  }

  const maxVal = filtered[0].delta_wait_time_ms; // already sorted desc

  container.innerHTML = filtered.map(w => {
    const pct   = maxVal > 0 ? (w.delta_wait_time_ms / maxVal * 100).toFixed(1) : 0;
    const color = CAT_COLORS[w.category] || '#484f58';
    const label = w.wait_type.length > 28 ? w.wait_type.substring(0,26)+'…' : w.wait_type;
    return `
      <div class="tw-row">
        <div class="tw-label" onclick="openWaitPanel('${esc(w.wait_type)}','${esc(w.category)}')" title="${esc(w.wait_type)}">${esc(label)}</div>
        <div class="tw-track">
          <div class="tw-fill" style="width:${pct}%;background:${color}"></div>
        </div>
        <div class="tw-val">${fmtNum(w.delta_wait_time_ms)}</div>
      </div>`;
  }).join('');
}

function renderSignalRes(ov) {
  if (!ov) return;
  const sig = ov.signal_wait_ms   || 0;
  const res = ov.resource_wait_ms || 0;
  const tot = sig + res;

  if (tot === 0) {
    el('sig-fill').style.width  = '0%';
    el('res-fill').style.width  = '0%';
    el('sig-val').textContent   = '0 ms';
    el('res-val').textContent   = '0 ms';
    el('sig-pct-label').textContent = 'No wait data';
    el('sig-pct-label').style.color = 'var(--text-muted)';
    return;
  }

  const sigPct = sig/tot*100;
  const resPct = res/tot*100;
  const sigColor = sigPct > 25 ? 'var(--red)' : sigPct > 15 ? 'var(--yellow)' : 'var(--green)';

  el('sig-fill').style.width  = sigPct.toFixed(1) + '%';
  el('sig-fill').style.background = sigColor;
  el('res-fill').style.width  = resPct.toFixed(1) + '%';
  el('sig-val').textContent   = fmtNum(sig) + ' ms';
  el('res-val').textContent   = fmtNum(res) + ' ms';

  const label = el('sig-pct-label');
  label.textContent = `Signal: ${sigPct.toFixed(1)}% ${sigPct>25?'⚠ CPU pressure':sigPct>15?'⚠ Elevated':'✓ Normal'}`;
  label.style.color = sigColor;
}

// ─── Tables ───────────────────────────────────────
function renderWaits(waits) {
  // Delta
  const deltaOnly = waits.filter(w => w.delta_wait_time_ms > 0 && (showOther || w.category !== 'Other'));
  const maxDelta  = Math.max(1, ...deltaOnly.map(w => w.delta_wait_time_ms));
  const sortedDelta = sortData(deltaOnly, sortState['tbl-delta-waits'].col, sortState['tbl-delta-waits'].dir);

  renderTable('tbl-delta-waits', sortedDelta, row => {
    const pct = (row.delta_wait_time_ms / maxDelta * 100).toFixed(0);
    return `
      <td data-copy="${esc(row.wait_type)}"><span class="td-wait" onclick="openWaitPanel('${esc(row.wait_type)}','${esc(row.category)}')" title="Click for details">${esc(row.wait_type)}</span></td>
      <td data-copy="${esc(row.category)}">${catBadge(row.category)}</td>
      <td class="td-number" data-copy="${row.delta_wait_time_ms}">
        <div class="delta-bar-wrap">
          <span>${fmtNum(row.delta_wait_time_ms)}</span>
          <div class="delta-bar-bg"><div class="delta-bar-fill" style="width:${pct}%"></div></div>
        </div>
      </td>
      <td class="td-number" data-copy="${row.delta_tasks_count}">${fmtNum(row.delta_tasks_count)}</td>
      <td class="td-number" data-copy="${row.avg_wait_ms.toFixed(2)}">${row.avg_wait_ms.toFixed(2)}</td>
      <td class="td-number" data-copy="${row.max_wait_time_ms}">${fmtNum(row.max_wait_time_ms)}</td>
      <td class="td-number" data-copy="${row.percent_of_total.toFixed(2)}">${row.percent_of_total.toFixed(2)}%</td>`;
  });

  // Cumulative
  const allWaits = showOther ? waits : waits.filter(w => w.category !== 'Other');
  const sortedCum = sortData(allWaits, sortState['tbl-cumulative-waits'].col, sortState['tbl-cumulative-waits'].dir);

  renderTable('tbl-cumulative-waits', sortedCum, row => `
    <td data-copy="${esc(row.wait_type)}"><span class="td-wait" onclick="openWaitPanel('${esc(row.wait_type)}','${esc(row.category)}')" title="Click for details">${esc(row.wait_type)}</span></td>
    <td data-copy="${esc(row.category)}">${catBadge(row.category)}</td>
    <td class="td-number" data-copy="${row.wait_time_ms}">${fmtNum(row.wait_time_ms)}</td>
    <td class="td-number" data-copy="${row.waiting_tasks_count}">${fmtNum(row.waiting_tasks_count)}</td>
    <td class="td-number" data-copy="${row.signal_wait_time_ms}">${fmtNum(row.signal_wait_time_ms)}</td>
    <td class="td-number" data-copy="${row.resource_wait_ms}">${fmtNum(row.resource_wait_ms)}</td>
    <td class="td-number" data-copy="${row.avg_wait_ms.toFixed(2)}">${row.avg_wait_ms.toFixed(2)}</td>
    <td class="td-number" data-copy="${row.max_wait_time_ms}">${fmtNum(row.max_wait_time_ms)}</td>
    <td class="td-number" data-copy="${row.percent_of_total.toFixed(2)}">${row.percent_of_total.toFixed(2)}%</td>`);
}

function renderActive(active) {
  const sorted = sortData(active, sortState['tbl-active'].col, sortState['tbl-active'].dir);
  renderTable('tbl-active', sorted, r => {
    const blocked   = r.blocking_session_id > 0;
    const statusCls = blocked ? 'blocked' : (r.status==='running'?'running':'suspended');
    return `
      <td class="td-number" data-copy="${r.session_id}"><span class="spid-badge ${blocked?'spid-blocked':''}">${r.session_id}</span></td>
      <td data-copy="${esc(r.status)}"><span class="status-badge status-${statusCls}">${esc(r.status)}</span></td>
      <td data-copy="${esc(r.wait_type)}"><span class="td-wait" onclick="openWaitPanel('${esc(r.wait_type)}','')">${esc(r.wait_type)||'—'}</span></td>
      <td class="td-number" data-copy="${r.wait_time_ms}">${fmtNum(r.wait_time_ms)}</td>
      <td class="td-number" data-copy="${r.blocking_session_id||''}">${r.blocking_session_id>0?`<span class="spid-blocking">${r.blocking_session_id}</span>`:'—'}</td>
      <td class="td-number" data-copy="${r.total_elapsed_ms}">${fmtNum(r.total_elapsed_ms)}</td>
      <td class="td-number" data-copy="${r.cpu_time}">${fmtNum(r.cpu_time)}</td>
      <td class="td-number" data-copy="${r.logical_reads}">${fmtNum(r.logical_reads)}</td>
      <td data-copy="${esc(r.database_name)}">${esc(r.database_name)}</td>
      <td data-copy="${esc(r.login_name)}">${esc(r.login_name)}</td>
      <td data-copy="${esc(r.host_name)}">${esc(r.host_name)}</td>
      <td class="td-sql" data-copy="${esc(r.sql_text)}" title="${esc(r.sql_text)}">${esc((r.sql_text||'').substring(0,80))}</td>`;
  });
}

function renderBlocking(blocking) {
  const sorted = sortData(blocking, sortState['tbl-blocking'].col, sortState['tbl-blocking'].dir);
  renderTable('tbl-blocking', sorted, b => `
    <td class="td-number" data-copy="${b.blocked_session_id}"><span class="spid-badge spid-blocked">${b.blocked_session_id}</span></td>
    <td class="td-number" data-copy="${b.blocking_session_id}"><span class="spid-badge spid-blocking">${b.blocking_session_id}</span></td>
    <td data-copy="${esc(b.wait_type)}"><span class="td-wait" onclick="openWaitPanel('${esc(b.wait_type)}','')">${esc(b.wait_type)}</span></td>
    <td data-copy="${esc(b.wait_resource)}" style="font-family:'Consolas',monospace;font-size:12px">${esc(b.wait_resource)}</td>
    <td class="td-number" data-copy="${b.wait_time_ms}">${fmtNum(b.wait_time_ms)}</td>
    <td class="td-sql" data-copy="${esc(b.blocked_sql)}" title="${esc(b.blocked_sql)}">${esc((b.blocked_sql||'').substring(0,80))}</td>
    <td class="td-sql" data-copy="${esc(b.blocking_sql)}" title="${esc(b.blocking_sql)}">${esc((b.blocking_sql||'').substring(0,80))}</td>`);
}

function renderRecommendations(recs) {
  const c = el('recs-container');
  if (!recs||recs.length===0) { c.innerHTML='<div class="no-data">No recommendations available.</div>'; return; }
  const icons={high:'🔴',medium:'🟡',info:'🟢'};
  c.innerHTML=recs.map(r=>`
    <div class="rec-card ${esc(r.severity)}">
      <div class="rec-icon">${icons[r.severity]||'ℹ️'}</div>
      <div class="rec-body"><div class="rec-cat">${esc(r.category)}</div><div class="rec-msg">${esc(r.message)}</div></div>
    </div>`).join('');
}

function renderDeadlocks(deadlocks) {
  const c=el('deadlocks-container');
  if(!deadlocks||deadlocks.length===0){c.innerHTML='<div class="no-data">No deadlocks found in system_health ring buffer.</div>';return;}
  c.innerHTML=deadlocks.map(d=>`
    <div class="deadlock-card">
      <div class="deadlock-header"><span class="deadlock-time">💀 ${esc(d.timestamp)}</span></div>
      <div class="deadlock-xml">${esc(d.xml_preview)}</div>
    </div>`).join('');
}

// ─── Helpers ──────────────────────────────────────
function el(id){return document.getElementById(id)}
function setText(id,val){const e=el(id);if(e)e.textContent=val}
function esc(str){if(!str)return'';return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
function fmtNum(n){if(n==null)return'0';return Number(n).toLocaleString()}
function catBadge(cat){const cls=(cat||'Other').replace(/[^a-zA-Z]/g,'-');return`<span class="cat-badge cat-${cls}">${esc(cat)}</span>`}

function renderTable(tableId,rows,rowFn){
  const tbody=document.querySelector(`#${tableId} tbody`);
  if(!tbody)return;
  if(!rows||rows.length===0){tbody.innerHTML=`<tr><td colspan="20" class="no-data">No data</td></tr>`;return;}
  tbody.innerHTML=rows.map(row=>`<tr>${rowFn(row)}</tr>`).join('');
}
