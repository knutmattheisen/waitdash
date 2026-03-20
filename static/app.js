'use strict';

// ─── State ────────────────────────────────────────
let refreshInterval = 5000;
let refreshTimer    = null;
let maxDeltaWait    = 1;
let currentAuthMode = 'windows';
let hasServers      = false;

// ─── Init ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  setupModal();
  setupTabs();
  setupServerSwitch();
  setupRefreshControl();
  loadInitialConfig();
});

// ─── Config load ──────────────────────────────────
function loadInitialConfig() {
  fetch('/api/config')
    .then(r => r.json())
    .then(cfg => {
      refreshInterval = (cfg.refresh_seconds || 5) * 1000;
      document.getElementById('refresh-select').value = String(refreshInterval);

      const servers = cfg.available_servers || [];
      hasServers = servers.length > 0;
      rebuildServerSelect(servers, cfg.current_server);

      if (hasServers) {
        scheduleRefresh();
        refresh();
      } else {
        showNoServerState();
      }
    })
    .catch(() => {
      showNoServerState();
      scheduleRefresh();
    });
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
  el('modal-overlay').addEventListener('click', e => {
    if (e.target === el('modal-overlay')) closeModal();
  });

  // Auth toggle
  document.querySelectorAll('.auth-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.auth-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentAuthMode = btn.dataset.auth;
      el('sql-auth-fields').classList.toggle('hidden', currentAuthMode !== 'sql');
    });
  });

  el('connect-btn').addEventListener('click', connectServer);

  // Enter key in form
  ['f-name','f-host','f-port','f-instance','f-user','f-password'].forEach(id => {
    el(id).addEventListener('keydown', e => {
      if (e.key === 'Enter') connectServer();
    });
  });
}

function openModal() {
  el('modal-overlay').classList.remove('hidden');
  el('connect-error').classList.add('hidden');
  el('f-host').focus();
}

function closeModal() {
  el('modal-overlay').classList.add('hidden');
}

function connectServer() {
  const host = el('f-host').value.trim();
  if (!host) {
    showConnectError('Please enter a host or IP address.');
    return;
  }

  const payload = {
    name:      el('f-name').value.trim() || host,
    host:      host,
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
    if (data.error) {
      showConnectError(data.error);
      return;
    }
    closeModal();
    hasServers = true;
    el('server-switcher-wrap').classList.remove('hidden');
    el('no-server-hint').classList.add('hidden');

    // Reload config and refresh
    loadInitialConfig();
  })
  .catch(err => {
    setConnectLoading(false);
    showConnectError('Request failed: ' + err.message);
  });
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
    if (!confirm(`Remove server "${name}" from WaitDash?`)) return;

    fetch('/api/server/remove?name=' + encodeURIComponent(name))
      .then(r => r.json())
      .then(() => loadInitialConfig())
      .catch(console.error);
  });
});

// ─── Server select ────────────────────────────────
function rebuildServerSelect(servers, current) {
  const sel = el('server-select');
  sel.innerHTML = '';
  servers.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  });
  if (current) sel.value = current;

  if (servers.length > 0) {
    el('server-switcher-wrap').classList.remove('hidden');
  } else {
    el('server-switcher-wrap').classList.add('hidden');
  }
}

function setupServerSwitch() {
  el('server-select').addEventListener('change', e => {
    const name = e.target.value;
    fetch('/api/switch?name=' + encodeURIComponent(name))
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

// ─── Main refresh ─────────────────────────────────
function refresh() {
  if (!hasServers) return;

  fetch('/api/all')
    .then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(data => {
      if (data.no_servers) {
        showNoServerState();
        return;
      }
      setStatus(true);
      renderOverview(data.overview);
      renderWaits(data.waits || []);
      renderActive(data.active || []);
      renderBlocking(data.blocking || []);
      renderRecommendations(data.recommendations || []);
      renderCharts(data.waits || [], data.overview);
      el('last-refresh').textContent = 'Last refresh: ' + new Date().toLocaleTimeString();
    })
    .catch(err => {
      setStatus(false);
      console.error('Fetch error:', err);
    })
    .finally(() => scheduleRefresh());

  fetch('/api/deadlocks')
    .then(r => r.json())
    .then(data => renderDeadlocks(data || []))
    .catch(() => {});
}

function setStatus(ok) {
  el('status-dot').className = 'status-dot ' + (ok ? 'ok' : 'error');
}

// ─── Ampel ────────────────────────────────────────
function setAmpel(status) {
  el('amp-red').className    = 'ampel-light' + (status === 'red'    ? ' on-red'    : '');
  el('amp-yellow').className = 'ampel-light' + (status === 'yellow' ? ' on-yellow' : '');
  el('amp-green').className  = 'ampel-light' + (status === 'green'  ? ' on-green'  : '');
}

// ─── Overview ─────────────────────────────────────
function renderOverview(ov) {
  if (!ov) return;

  // Ampel
  setAmpel(ov.health_status || 'green');

  // Server info panel
  el('server-info-panel').classList.remove('hidden');
  el('no-server-hint').classList.add('hidden');

  setText('sip-name', ov.server_name || ov.current_server || '—');

  // Edition: strip "(64-bit)" etc for brevity
  const edition = (ov.edition || '').replace(/\s*\(64-bit\)/i, '').replace(/\s*\(RTM\)/i, '');
  setText('sip-edition', edition || '—');

  const level = [ov.product_level, ov.product_update].filter(Boolean).join(' ');
  setText('sip-level', level || '—');

  setText('sip-cpu', ov.logical_cpus ? ov.logical_cpus + ' CPU' + (ov.logical_cpus > 1 ? 's' : '') : '—');
  setText('sip-ram', ov.physical_mem_gb ? ov.physical_mem_gb + ' GB RAM' : '—');

  if (ov.uptime_hours !== undefined) {
    const h = Math.floor(ov.uptime_hours);
    const m = Math.floor((ov.uptime_hours - h) * 60);
    setText('sip-uptime', 'Up ' + h + 'h ' + m + 'm');
  }

  // KPI: Signal wait
  const sigPct  = ov.signal_wait_pct || 0;
  const sigCard = el('kpi-signal');
  const sigVal  = el('kpi-signal-val');
  sigVal.textContent = sigPct.toFixed(1) + '%';
  sigCard.className  = 'kpi-card ' + (sigPct > 25 ? 'pressure' : sigPct > 15 ? 'warning' : 'ok');
  sigVal.className   = 'kpi-value '  + (sigPct > 25 ? 'red'      : sigPct > 15 ? 'yellow'  : 'green');

  // KPI: Top wait category
  const topCat = el('kpi-topcat-val');
  topCat.textContent = ov.top_wait_category || 'None';
  topCat.className   = 'kpi-value white';

  // KPI: Blocked
  const blVal  = el('kpi-blocked-val');
  const blCard = el('kpi-blocked');
  blVal.textContent = ov.blocked_count || 0;
  blCard.className  = 'kpi-card ' + (ov.blocked_count > 0 ? 'pressure' : '');
  blVal.className   = 'kpi-value ' + (ov.blocked_count > 0 ? 'red' : 'green');

  // KPI: Active
  const actVal = el('kpi-active-val');
  actVal.textContent = ov.active_request_count || 0;
  actVal.className   = 'kpi-value blue';

  // Server select sync
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
      <td class="td-wait">${esc(row.wait_type)}</td>
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

  const cumulative = [...waits].sort((a, b) => b.wait_time_ms - a.wait_time_ms);
  renderTable('tbl-cumulative-waits', cumulative, row => `
    <td class="td-wait">${esc(row.wait_type)}</td>
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
      <td><span class="spid-badge ${blocked ? 'spid-blocked' : ''}">${r.session_id}</span></td>
      <td><span class="status-badge status-${statusCls}">${esc(r.status)}</span></td>
      <td class="td-wait">${esc(r.wait_type) || '—'}</td>
      <td class="td-number">${fmtNum(r.wait_time_ms)}</td>
      <td class="td-number">${r.blocking_session_id > 0 ? `<span class="spid-blocking">${r.blocking_session_id}</span>` : '—'}</td>
      <td class="td-number">${fmtNum(r.total_elapsed_ms)}</td>
      <td class="td-number">${fmtNum(r.cpu_time)}</td>
      <td class="td-number">${fmtNum(r.logical_reads)}</td>
      <td>${esc(r.database_name)}</td>
      <td>${esc(r.login_name)}</td>
      <td>${esc(r.host_name)}</td>
      <td class="td-sql" title="${esc(r.sql_text)}">${esc((r.sql_text || '').substring(0, 80))}</td>`;
  });
}

// ─── Blocking ─────────────────────────────────────
function renderBlocking(blocking) {
  renderTable('tbl-blocking', blocking, b => `
    <td><span class="spid-badge spid-blocked">${b.blocked_session_id}</span></td>
    <td><span class="spid-badge spid-blocking">${b.blocking_session_id}</span></td>
    <td class="td-wait">${esc(b.wait_type)}</td>
    <td style="font-family:var(--mono);font-size:11px">${esc(b.wait_resource)}</td>
    <td class="td-number">${fmtNum(b.wait_time_ms)}</td>
    <td class="td-sql" title="${esc(b.blocked_sql)}">${esc((b.blocked_sql || '').substring(0, 80))}</td>
    <td class="td-sql" title="${esc(b.blocking_sql)}">${esc((b.blocking_sql || '').substring(0, 80))}</td>`);
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
      <div class="rec-icon">${icons[r.severity] || 'ℹ️'}</div>
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
      <div class="deadlock-header">
        <span class="deadlock-time">💀 ${esc(d.timestamp)}</span>
      </div>
      <div class="deadlock-xml">${esc(d.xml_preview)}</div>
    </div>`).join('');
}

// ─── Charts ───────────────────────────────────────
function renderCharts(waits, ov) {
  renderCategoryChart(waits);
  renderTopWaitsChart(waits);
  renderSignalChart(ov);
}

function renderCategoryChart(waits) {
  const canvas = el('chart-category');
  const ctx    = canvas.getContext('2d');

  const catTotals = {};
  waits.forEach(w => {
    if (w.delta_wait_time_ms > 0)
      catTotals[w.category] = (catTotals[w.category] || 0) + w.delta_wait_time_ms;
  });

  const labels = Object.keys(catTotals).filter(k => catTotals[k] > 0);
  const values = labels.map(k => catTotals[k]);
  const total  = values.reduce((a, b) => a + b, 0);

  const W = canvas.width  = canvas.offsetWidth  * devicePixelRatio;
  const H = canvas.height = canvas.offsetHeight * devicePixelRatio;
  canvas.style.width  = canvas.offsetWidth  + 'px';
  canvas.style.height = canvas.offsetHeight + 'px';
  ctx.clearRect(0, 0, W, H);

  if (total === 0) {
    drawCenterText(ctx, W, H, 'No delta waits this interval');
    return;
  }

  const colors = {
    'CPU':'#f85149','I/O':'#58a6ff','Memory':'#bc8cff','Memory/Latch':'#bc8cff',
    'Locking/Blocking':'#e3794b','Locking':'#e3794b','Parallelism':'#d29922',
    'Network':'#3fb950','HA/AG':'#79c0ff','CLR':'#ff7b72','Latch':'#e3794b','Other':'#484f58',
  };

  const cx = W * 0.35, cy = H / 2;
  const r  = Math.min(cx, cy) * 0.78;
  const ir = r * 0.5;

  let angle = -Math.PI / 2;
  values.forEach((val, i) => {
    const slice = (val / total) * 2 * Math.PI;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, angle, angle + slice);
    ctx.closePath();
    ctx.fillStyle = colors[labels[i]] || '#484f58';
    ctx.fill();
    ctx.strokeStyle = '#0d1117';
    ctx.lineWidth = 2;
    ctx.stroke();
    angle += slice;
  });

  ctx.beginPath();
  ctx.arc(cx, cy, ir, 0, 2 * Math.PI);
  ctx.fillStyle = '#161b22';
  ctx.fill();

  const legendX = W * 0.68;
  let   legendY = H * 0.12;
  const lineH   = Math.min(H * 0.11, 18 * devicePixelRatio);
  ctx.font = `${Math.max(9, lineH * 0.55)}px Segoe UI`;

  labels.forEach((label, i) => {
    if (legendY > H * 0.95) return;
    const color = colors[label] || '#484f58';
    const pct   = ((values[i] / total) * 100).toFixed(1);
    ctx.fillStyle = color;
    ctx.fillRect(legendX - lineH * 0.8, legendY - lineH * 0.45, lineH * 0.5, lineH * 0.5);
    ctx.fillStyle = '#c9d1d9';
    ctx.textAlign = 'left';
    ctx.fillText(`${label} ${pct}%`, legendX, legendY);
    legendY += lineH;
  });
}

function renderTopWaitsChart(waits) {
  const canvas = el('chart-topwaits');
  const ctx    = canvas.getContext('2d');

  const top10 = waits.filter(w => w.delta_wait_time_ms > 0).slice(0, 10);

  const W = canvas.width  = canvas.offsetWidth  * devicePixelRatio;
  const H = canvas.height = canvas.offsetHeight * devicePixelRatio;
  canvas.style.width  = canvas.offsetWidth  + 'px';
  canvas.style.height = canvas.offsetHeight + 'px';
  ctx.clearRect(0, 0, W, H);

  if (top10.length === 0) {
    drawCenterText(ctx, W, H, 'No delta waits this interval');
    return;
  }

  const maxVal  = Math.max(...top10.map(w => w.delta_wait_time_ms));
  const rowH    = H / top10.length;
  const barH    = rowH * 0.65;
  const labelW  = W * 0.40;
  const barArea = W - labelW - W * 0.18;
  const fs      = Math.max(9, barH * 0.52);

  ctx.font = `${fs}px Consolas`;

  top10.forEach((w, i) => {
    const y      = i * rowH + (rowH - barH) / 2;
    const barLen = (w.delta_wait_time_ms / maxVal) * barArea;

    ctx.fillStyle = '#1c3a5e';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(labelW, y, barArea, barH, 2);
    else ctx.rect(labelW, y, barArea, barH);
    ctx.fill();

    ctx.fillStyle = '#58a6ff';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(labelW, y, barLen, barH, 2);
    else ctx.rect(labelW, y, barLen, barH);
    ctx.fill();

    ctx.fillStyle = '#79c0ff';
    ctx.textAlign = 'right';
    ctx.fillText(w.wait_type.substring(0, 24), labelW - 6, y + barH * 0.72);

    ctx.fillStyle = '#6e7681';
    ctx.textAlign = 'left';
    ctx.fillText(fmtNum(w.delta_wait_time_ms), labelW + barLen + 5, y + barH * 0.72);
  });
}

function renderSignalChart(ov) {
  if (!ov) return;
  const canvas = el('chart-signal');
  const ctx    = canvas.getContext('2d');

  const W = canvas.width  = canvas.offsetWidth  * devicePixelRatio;
  const H = canvas.height = canvas.offsetHeight * devicePixelRatio;
  canvas.style.width  = canvas.offsetWidth  + 'px';
  canvas.style.height = canvas.offsetHeight + 'px';
  ctx.clearRect(0, 0, W, H);

  const sig = ov.signal_wait_ms   || 0;
  const res = ov.resource_wait_ms || 0;
  const tot = sig + res;

  if (tot === 0) {
    drawCenterText(ctx, W, H, 'No wait data yet');
    return;
  }

  const cx = W / 2, cy = H * 0.44;
  const r  = Math.min(cx, cy * 0.95) * 0.75;
  const ir = r * 0.52;

  const sigPct = sig / tot;

  // Signal arc
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + sigPct * 2 * Math.PI);
  ctx.closePath();
  ctx.fillStyle = sigPct > 0.25 ? '#f85149' : '#d29922';
  ctx.fill();

  // Resource arc
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, r, -Math.PI / 2 + sigPct * 2 * Math.PI, -Math.PI / 2 + 2 * Math.PI);
  ctx.closePath();
  ctx.fillStyle = '#58a6ff';
  ctx.fill();

  ctx.strokeStyle = '#161b22';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy, ir, 0, 2 * Math.PI);
  ctx.fillStyle = '#161b22';
  ctx.fill();

  // Center label
  ctx.fillStyle  = sigPct > 0.25 ? '#f85149' : '#d29922';
  ctx.font       = `bold ${Math.max(11, ir * 0.42)}px Segoe UI`;
  ctx.textAlign  = 'center';
  ctx.fillText((sigPct * 100).toFixed(1) + '%', cx, cy + 4);
  ctx.fillStyle = '#6e7681';
  ctx.font      = `${Math.max(9, ir * 0.28)}px Segoe UI`;
  ctx.fillText('Signal', cx, cy + ir * 0.38);

  // Legend below
  const fs = Math.max(9, H * 0.058);
  ctx.font  = `${fs}px Segoe UI`;
  ctx.textAlign = 'left';
  const ly = H * 0.88;
  ctx.fillStyle = sigPct > 0.25 ? '#f85149' : '#d29922';
  ctx.fillText('▪ Signal: ' + fmtNum(sig) + ' ms', W * 0.05, ly);
  ctx.fillStyle = '#58a6ff';
  ctx.fillText('▪ Resource: ' + fmtNum(res) + ' ms', W * 0.05, ly + fs * 1.4);
}

function drawCenterText(ctx, W, H, msg) {
  ctx.fillStyle = '#6e7681';
  ctx.font = `12px Segoe UI`;
  ctx.textAlign = 'center';
  ctx.fillText(msg, W / 2, H / 2);
}

// ─── Helpers ──────────────────────────────────────
function el(id) { return document.getElementById(id); }
function setText(id, val) { const e = el(id); if (e) e.textContent = val; }

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtNum(n) {
  if (n == null) return '0';
  return Number(n).toLocaleString();
}

function catBadge(cat) {
  const cls = (cat || 'Other').replace(/[^a-zA-Z]/g, '-');
  return `<span class="cat-badge cat-${cls}">${esc(cat)}</span>`;
}

function renderTable(tableId, rows, rowFn) {
  const tbody = document.querySelector(`#${tableId} tbody`);
  if (!tbody) return;
  if (!rows || rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="20" class="no-data">No data</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(row => `<tr>${rowFn(row)}</tr>`).join('');
}
