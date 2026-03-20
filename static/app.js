'use strict';

// ─── State ────────────────────────────────────────
let refreshInterval = 5000;
let refreshTimer    = null;
let maxDeltaWait    = 1;   // For bar scaling

// ─── Init ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadConfig();
  setupTabs();
  setupServerSwitch();
  setupRefreshControl();
  refresh();
});

function loadConfig() {
  fetch('/api/config')
    .then(r => r.json())
    .then(cfg => {
      refreshInterval = (cfg.refresh_seconds || 5) * 1000;
      document.getElementById('refresh-select').value = String(refreshInterval);
      scheduleRefresh();
    })
    .catch(() => scheduleRefresh());
}

// ─── Tabs ─────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    });
  });
}

// ─── Server switcher ──────────────────────────────
function setupServerSwitch() {
  document.getElementById('server-select').addEventListener('change', e => {
    const name = e.target.value;
    fetch('/api/switch?name=' + encodeURIComponent(name))
      .then(() => refresh())
      .catch(console.error);
  });
}

function setupRefreshControl() {
  document.getElementById('refresh-select').addEventListener('change', e => {
    refreshInterval = parseInt(e.target.value);
    scheduleRefresh();
  });
}

function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { refresh(); }, refreshInterval);
}

// ─── Main refresh cycle ───────────────────────────
function refresh() {
  fetch('/api/all')
    .then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(data => {
      setStatus(true);
      renderOverview(data.overview);
      renderWaits(data.waits || []);
      renderActive(data.active || []);
      renderBlocking(data.blocking || []);
      renderRecommendations(data.recommendations || []);
      renderCharts(data.waits || [], data.overview);
      document.getElementById('last-refresh').textContent =
        'Last refresh: ' + new Date().toLocaleTimeString();
    })
    .catch(err => {
      setStatus(false);
      console.error('Fetch error:', err);
    })
    .finally(() => scheduleRefresh());

  // Deadlocks fetched separately (heavier query)
  fetch('/api/deadlocks')
    .then(r => r.json())
    .then(data => renderDeadlocks(data || []))
    .catch(() => {});
}

function setStatus(ok) {
  const dot = document.getElementById('status-dot');
  dot.className = 'status-dot ' + (ok ? 'ok' : 'error');
}

// ─── Overview / KPIs ──────────────────────────────
function renderOverview(ov) {
  if (!ov) return;

  // Header
  setText('hdr-server', ov.current_server || '—');
  const ver = (ov.sql_version || '').split('\n')[0].substring(0, 60);
  setText('hdr-version', ver || '—');
  el('hdr-version').title = ov.sql_version || '';

  if (ov.start_time) {
    setText('hdr-starttime', fmtDateTime(ov.start_time));
  }
  if (ov.uptime_hours !== undefined) {
    const h = Math.floor(ov.uptime_hours);
    const m = Math.floor((ov.uptime_hours - h) * 60);
    setText('hdr-uptime', `${h}h ${m}m`);
  }
  setText('hdr-now', new Date().toLocaleTimeString());

  // Server select
  const sel = document.getElementById('server-select');
  if (ov.available_servers && ov.available_servers.length && sel.options.length === 0) {
    ov.available_servers.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    });
  }
  if (ov.current_server) sel.value = ov.current_server;

  // Signal wait %
  const sigPct  = ov.signal_wait_pct || 0;
  const sigCard = el('kpi-signal');
  const sigVal  = el('kpi-signal-val');
  sigVal.textContent = sigPct.toFixed(1) + '%';
  sigCard.className  = 'kpi-card ' + (sigPct > 25 ? 'pressure' : sigPct > 15 ? 'warning' : 'ok');
  sigVal.className   = 'kpi-value '  + (sigPct > 25 ? 'red'      : sigPct > 15 ? 'yellow'  : 'green');

  // Top wait category
  const topCat = el('kpi-topcat-val');
  topCat.textContent = ov.top_wait_category || 'None';
  topCat.className   = 'kpi-value white';

  // Blocked
  const blVal  = el('kpi-blocked-val');
  const blCard = el('kpi-blocked');
  blVal.textContent = ov.blocked_count || 0;
  blCard.className  = 'kpi-card ' + (ov.blocked_count > 0 ? 'pressure' : '');
  blVal.className   = 'kpi-value ' + (ov.blocked_count > 0 ? 'red' : 'green');

  // Active
  const actVal = el('kpi-active-val');
  actVal.textContent = ov.active_request_count || 0;
  actVal.className   = 'kpi-value blue';
}

// ─── Waits tables ─────────────────────────────────
function renderWaits(waits) {
  const deltaOnly = waits.filter(w => w.delta_wait_time_ms > 0);

  // Recalc max delta for bar
  maxDeltaWait = Math.max(1, ...deltaOnly.map(w => w.delta_wait_time_ms));

  // Delta waits table
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
      <td class="td-number">${row.percent_of_total.toFixed(2)}%</td>
    `;
  });

  // Cumulative waits table (sorted by total desc)
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
    <td class="td-number">${row.percent_of_total.toFixed(2)}%</td>
  `);
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
      <td class="td-sql" title="${esc(r.sql_text)}">${esc(r.sql_text || '').substring(0, 80)}</td>
    `;
  });
}

// ─── Blocking ─────────────────────────────────────
function renderBlocking(blocking) {
  renderTable('tbl-blocking', blocking, b => `
    <td><span class="spid-badge spid-blocked">${b.blocked_session_id}</span></td>
    <td><span class="spid-badge spid-blocking">${b.blocking_session_id}</span></td>
    <td class="td-wait">${esc(b.wait_type)}</td>
    <td style="font-family:var(--font-mono);font-size:11px">${esc(b.wait_resource)}</td>
    <td class="td-number">${fmtNum(b.wait_time_ms)}</td>
    <td class="td-sql" title="${esc(b.blocked_sql)}">${esc(b.blocked_sql || '').substring(0, 80)}</td>
    <td class="td-sql" title="${esc(b.blocking_sql)}">${esc(b.blocking_sql || '').substring(0, 80)}</td>
  `);
}

// ─── Recommendations ──────────────────────────────
function renderRecommendations(recs) {
  const container = document.getElementById('recs-container');
  if (!recs || recs.length === 0) {
    container.innerHTML = '<div class="no-data">No recommendations available.</div>';
    return;
  }
  const icons = { high: '🔴', medium: '🟡', info: '🟢' };
  container.innerHTML = recs.map(r => `
    <div class="rec-card ${esc(r.severity)}">
      <div class="rec-icon">${icons[r.severity] || 'ℹ️'}</div>
      <div class="rec-body">
        <div class="rec-cat">${esc(r.category)}</div>
        <div class="rec-msg">${esc(r.message)}</div>
      </div>
    </div>
  `).join('');
}

// ─── Deadlocks ────────────────────────────────────
function renderDeadlocks(deadlocks) {
  const container = document.getElementById('deadlocks-container');
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
    </div>
  `).join('');
}

// ─── Charts ───────────────────────────────────────
let chartCategory = null;
let chartTopWaits = null;
let chartSignal   = null;

function renderCharts(waits, ov) {
  renderCategoryChart(waits);
  renderTopWaitsChart(waits);
  renderSignalChart(ov);
}

// Category donut chart
function renderCategoryChart(waits) {
  const canvas = document.getElementById('chart-category');
  const ctx    = canvas.getContext('2d');

  const catTotals = {};
  waits.forEach(w => {
    if (w.delta_wait_time_ms > 0) {
      catTotals[w.category] = (catTotals[w.category] || 0) + w.delta_wait_time_ms;
    }
  });

  const labels = Object.keys(catTotals).filter(k => catTotals[k] > 0);
  const values = labels.map(k => catTotals[k]);
  const total  = values.reduce((a, b) => a + b, 0);

  if (total === 0) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#6e7681';
    ctx.font = '12px Segoe UI';
    ctx.textAlign = 'center';
    ctx.fillText('No delta waits', canvas.width / 2, canvas.height / 2);
    return;
  }

  const colors = {
    'CPU':              '#f85149',
    'I/O':              '#58a6ff',
    'Memory':           '#bc8cff',
    'Memory/Latch':     '#bc8cff',
    'Locking/Blocking': '#e3794b',
    'Locking':          '#e3794b',
    'Parallelism':      '#d29922',
    'Network':          '#3fb950',
    'HA/AG':            '#79c0ff',
    'CLR':              '#ff7b72',
    'Latch':            '#e3794b',
    'Other':            '#484f58',
  };

  const W = canvas.width  = canvas.offsetWidth  * devicePixelRatio;
  const H = canvas.height = canvas.offsetHeight * devicePixelRatio;
  canvas.style.width  = canvas.offsetWidth  + 'px';
  canvas.style.height = canvas.offsetHeight + 'px';

  ctx.clearRect(0, 0, W, H);

  const cx     = W * 0.38;
  const cy     = H / 2;
  const radius = Math.min(cx, cy) * 0.78;
  const inner  = radius * 0.55;

  let startAngle = -Math.PI / 2;
  values.forEach((val, i) => {
    const slice = (val / total) * 2 * Math.PI;
    const color = colors[labels[i]] || '#484f58';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, startAngle, startAngle + slice);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#0d1117';
    ctx.lineWidth = 2;
    ctx.stroke();
    startAngle += slice;
  });

  // Inner hole
  ctx.beginPath();
  ctx.arc(cx, cy, inner, 0, 2 * Math.PI);
  ctx.fillStyle = '#161b22';
  ctx.fill();

  // Legend
  const legendX = W * 0.72;
  let   legendY = H * 0.1;
  const lineH   = H * 0.12;
  ctx.font = `${Math.max(10, H * 0.07)}px Segoe UI`;

  labels.forEach((label, i) => {
    const color = colors[label] || '#484f58';
    const pct   = ((values[i] / total) * 100).toFixed(1);
    ctx.fillStyle = color;
    ctx.fillRect(legendX - W * 0.06, legendY - lineH * 0.4, lineH * 0.5, lineH * 0.5);
    ctx.fillStyle = '#c9d1d9';
    ctx.fillText(`${label} ${pct}%`, legendX, legendY);
    legendY += lineH;
    if (legendY > H * 0.95) return;
  });
}

// Top 10 delta waits bar chart
function renderTopWaitsChart(waits) {
  const canvas = document.getElementById('chart-topwaits');
  const ctx    = canvas.getContext('2d');

  const top10 = waits
    .filter(w => w.delta_wait_time_ms > 0)
    .slice(0, 10);

  const W = canvas.width  = canvas.offsetWidth  * devicePixelRatio;
  const H = canvas.height = canvas.offsetHeight * devicePixelRatio;
  canvas.style.width  = canvas.offsetWidth  + 'px';
  canvas.style.height = canvas.offsetHeight + 'px';
  ctx.clearRect(0, 0, W, H);

  if (top10.length === 0) {
    ctx.fillStyle = '#6e7681';
    ctx.font = '12px Segoe UI';
    ctx.textAlign = 'center';
    ctx.fillText('No delta waits this interval', W / 2, H / 2);
    return;
  }

  const maxVal   = Math.max(...top10.map(w => w.delta_wait_time_ms));
  const barH     = H / top10.length * 0.7;
  const rowH     = H / top10.length;
  const labelW   = W * 0.38;
  const barArea  = W - labelW - W * 0.15;

  ctx.font = `${Math.max(9, barH * 0.55)}px Consolas`;

  top10.forEach((w, i) => {
    const y      = i * rowH + rowH * 0.15;
    const barLen = (w.delta_wait_time_ms / maxVal) * barArea;

    // Bar
    ctx.fillStyle = '#58a6ff';
    ctx.beginPath();
    ctx.roundRect(labelW, y, barLen, barH, 2);
    ctx.fill();

    // Label
    ctx.fillStyle = '#79c0ff';
    ctx.textAlign = 'right';
    ctx.fillText(w.wait_type.substring(0, 22), labelW - 6, y + barH * 0.72);

    // Value
    ctx.fillStyle = '#6e7681';
    ctx.textAlign = 'left';
    ctx.fillText(fmtNum(w.delta_wait_time_ms), labelW + barLen + 5, y + barH * 0.72);
  });
}

// Signal vs Resource pie
function renderSignalChart(ov) {
  if (!ov) return;
  const canvas = document.getElementById('chart-signal');
  const ctx    = canvas.getContext('2d');

  const W = canvas.width  = canvas.offsetWidth  * devicePixelRatio;
  const H = canvas.height = canvas.offsetHeight * devicePixelRatio;
  canvas.style.width  = canvas.offsetWidth  + 'px';
  canvas.style.height = canvas.offsetHeight + 'px';
  ctx.clearRect(0, 0, W, H);

  const sig = ov.signal_wait_ms    || 0;
  const res = ov.resource_wait_ms  || 0;
  const tot = sig + res;

  if (tot === 0) {
    ctx.fillStyle = '#6e7681';
    ctx.font = '12px Segoe UI';
    ctx.textAlign = 'center';
    ctx.fillText('No wait data', W / 2, H / 2);
    return;
  }

  const cx = W / 2;
  const cy = H / 2;
  const r  = Math.min(cx, cy) * 0.75;
  const ir = r * 0.5;

  const sigPct = sig / tot;
  const resPct = res / tot;

  // Signal slice
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + sigPct * 2 * Math.PI);
  ctx.closePath();
  ctx.fillStyle = sig / tot > 0.25 ? '#f85149' : '#d29922';
  ctx.fill();

  // Resource slice
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, r, -Math.PI / 2 + sigPct * 2 * Math.PI, -Math.PI / 2 + 2 * Math.PI);
  ctx.closePath();
  ctx.fillStyle = '#58a6ff';
  ctx.fill();

  // Separator
  ctx.strokeStyle = '#161b22';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Hole
  ctx.beginPath();
  ctx.arc(cx, cy, ir, 0, 2 * Math.PI);
  ctx.fillStyle = '#161b22';
  ctx.fill();

  // Center text
  const sigLabel = (sigPct * 100).toFixed(1) + '%';
  ctx.fillStyle  = sig / tot > 0.25 ? '#f85149' : '#d29922';
  ctx.font       = `bold ${Math.max(12, ir * 0.45)}px Segoe UI`;
  ctx.textAlign  = 'center';
  ctx.fillText(sigLabel, cx, cy - ir * 0.05);
  ctx.fillStyle = '#6e7681';
  ctx.font      = `${Math.max(9, ir * 0.28)}px Segoe UI`;
  ctx.fillText('Signal', cx, cy + ir * 0.35);

  // Labels below
  const fs = Math.max(9, H * 0.06);
  ctx.font = `${fs}px Segoe UI`;
  ctx.textAlign = 'left';
  ctx.fillStyle = sig / tot > 0.25 ? '#f85149' : '#d29922';
  ctx.fillText('▪ Signal: ' + fmtNum(sig) + ' ms', W * 0.05, H - fs * 2.2);
  ctx.fillStyle = '#58a6ff';
  ctx.fillText('▪ Resource: ' + fmtNum(res) + ' ms', W * 0.05, H - fs * 0.8);
}

// ─── Helpers ──────────────────────────────────────
function el(id) { return document.getElementById(id); }
function setText(id, val) { const e = el(id); if (e) e.textContent = val; }

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtNum(n) {
  if (n == null) return '0';
  return Number(n).toLocaleString();
}

function fmtDateTime(iso) {
  try { return new Date(iso).toLocaleString(); }
  catch { return iso; }
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
