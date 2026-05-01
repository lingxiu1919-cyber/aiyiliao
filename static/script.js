/* ── state ── */
let isLoggedIn = false;
let authMode = 'login';
let guestResults = null;

/* ── auth UI ── */
function showLogin() { authMode = 'login'; openAuthModal(); }
function showRegister() { authMode = 'register'; openAuthModal(); }

function openAuthModal() {
  document.getElementById('authModal').classList.remove('hidden');
  document.getElementById('authTitle').textContent = authMode === 'login' ? '🔑 登录' : '📝 注册';
  document.getElementById('authSubmitBtn').textContent = authMode === 'login' ? '登录' : '注册';
  document.getElementById('authToggle').innerHTML = authMode === 'login'
    ? '没有账号？<a href="#" onclick="toggleAuthMode(event)">立即注册</a>'
    : '已有账号？<a href="#" onclick="toggleAuthMode(event)">去登录</a>';
  document.getElementById('authError').textContent = '';
  document.getElementById('authUsername').value = '';
  document.getElementById('authPassword').value = '';
}

function toggleAuthMode(e) {
  e.preventDefault();
  authMode = authMode === 'login' ? 'register' : 'login';
  openAuthModal();
}

function closeAuthModal() {
  document.getElementById('authModal').classList.add('hidden');
}

async function handleAuth(e) {
  e.preventDefault();
  const username = document.getElementById('authUsername').value.trim();
  const password = document.getElementById('authPassword').value;
  const endpoint = authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
  document.getElementById('authError').textContent = '';

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ username, password })
    });
    const data = await resp.json();
    if (data.error) {
      document.getElementById('authError').textContent = data.error;
      return false;
    }
    onLoginSuccess(data.username);
  } catch (err) {
    document.getElementById('authError').textContent = '网络错误';
  }
  return false;
}

function onLoginSuccess(username) {
  isLoggedIn = true;
  closeAuthModal();
  document.getElementById('authButtons').classList.add('hidden');
  document.getElementById('userArea').classList.remove('hidden');
  document.getElementById('userDisplay').textContent = '👤 ' + username;
  document.getElementById('historyCard').classList.remove('hidden');
  document.getElementById('savePrompt').classList.add('hidden');
  loadHistory();
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  isLoggedIn = false;
  document.getElementById('authButtons').classList.remove('hidden');
  document.getElementById('userArea').classList.add('hidden');
  document.getElementById('historyCard').classList.add('hidden');
  document.getElementById('reportList').innerHTML = '';
}

function dismissSavePrompt() {
  document.getElementById('savePrompt').classList.add('hidden');
}

async function checkLogin() {
  try {
    const resp = await fetch('/api/auth/me');
    const data = await resp.json();
    if (data.logged_in) {
      isLoggedIn = true;
      document.getElementById('authButtons').classList.add('hidden');
      document.getElementById('userArea').classList.remove('hidden');
      document.getElementById('userDisplay').textContent = '👤 ' + data.username;
      document.getElementById('historyCard').classList.remove('hidden');
      loadHistory();
    }
  } catch (e) { /* guest mode */ }
}

/* ── upload logic ── */
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const uploadPreview = document.getElementById('uploadPreview');
const previewImg = document.getElementById('previewImg');
const btnClearUpload = document.getElementById('btnClearUpload');
const btnAnalyze = document.getElementById('btnAnalyze');
const uploadSpinner = document.getElementById('uploadSpinner');
const resultSection = document.getElementById('resultSection');
const historySection = document.getElementById('historySection');
const reportList = document.getElementById('reportList');
let currentFile = null;

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => { e.preventDefault(); dropZone.classList.remove('dragover'); handleFiles(e.dataTransfer.files); });
fileInput.addEventListener('change', () => handleFiles(fileInput.files));

function handleFiles(files) {
  if (!files.length) return;
  const file = files[0];
  if (!file.type.startsWith('image/') && file.type !== 'application/pdf') { alert('请上传图片或PDF文件'); return; }
  currentFile = file;
  const reader = new FileReader();
  reader.onload = e => {
    previewImg.src = e.target.result;
    dropZone.style.display = 'none'; uploadPreview.classList.remove('hidden'); btnAnalyze.disabled = false;
  };
  reader.readAsDataURL(file);
}

btnClearUpload.addEventListener('click', () => {
  currentFile = null; fileInput.value = '';
  uploadPreview.classList.add('hidden');
  dropZone.style.display = 'block';
  btnAnalyze.disabled = true;
});

/* ── analyze (base64 for Cloudflare Workers) ── */
btnAnalyze.addEventListener('click', async () => {
  if (!currentFile) return;
  btnAnalyze.disabled = true;
  uploadSpinner.classList.remove('hidden');
  resultSection.classList.add('hidden');
  historySection.classList.add('hidden');

  try {
    // Read file as base64 (strip the data:image/xxx;base64, prefix)
    const reader = new FileReader();
    const base64Promise = new Promise((resolve, reject) => {
      reader.onload = e => {
        const full = e.target.result;
        const comma = full.indexOf(',');
        const base64 = comma >= 0 ? full.slice(comma + 1) : full;
        const ext = currentFile.name.split('.').pop() || 'jpg';
        resolve({ image_base64: base64, filename: currentFile.name, ext });
      };
      reader.onerror = reject;
    });
    reader.readAsDataURL(currentFile);
    const { image_base64, filename, ext } = await base64Promise;

    const resp = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_base64, filename, ext }),
    });

    if (resp.status === 401) {
      alert('登录后才能保存结果，请先登录或注册');
      showLogin();
      return;
    }
    const data = await resp.json();
    if (data.error) { alert('错误: ' + data.error); return; }
    renderResult(data);
    if (!isLoggedIn) {
      document.getElementById('savePrompt').classList.remove('hidden');
    } else {
      loadHistory();
    }
  } catch (e) {
    alert('请求失败: ' + e.message);
  } finally {
    uploadSpinner.classList.add('hidden');
    btnAnalyze.disabled = false;
  }
});

/* ── render result ── */
function renderResult(data) {
  resultSection.classList.remove('hidden');

  const ex = data.extraction || data;
  document.getElementById('reportMeta').innerHTML = `
    <span><strong>类型：</strong>${esc(ex.report_type || '未知')}</span>
    <span><strong>日期：</strong>${esc(ex.report_date || '未知')}</span>
    <span><strong>医院：</strong>${esc(ex.hospital_name || '未知')}</span>
  `;

  const items = ex.items || [];
  if (items.length) {
    let html = '<table class="items-table"><thead><tr><th>项目</th><th>结果</th><th>单位</th><th>参考范围</th></tr></thead><tbody>';
    items.forEach(it => {
      const cls = it.flag === 'H' || it.flag === 'h' ? 'flag-up' : it.flag === 'L' || it.flag === 'l' ? 'flag-down' : '';
      html += `<tr><td><strong>${esc(it.name)}</strong></td><td class="${cls}">${esc(it.value)}</td><td>${esc(it.unit)}</td><td>${esc(it.reference_range)}</td></tr>`;
    });
    html += '</tbody></table>';
    document.getElementById('itemsTable').innerHTML = html;
  } else {
    document.getElementById('itemsTable').innerHTML = '<p class="hint">未识别出化验项目</p>';
  }

  const a = data.analysis || {};
  document.getElementById('aiAnalysis').innerHTML = `
    <p><strong>📝 总结：</strong>${esc(a.summary || '无')}</p>
    <p><strong>💡 建议：</strong>${esc(a.recommendations || '无')}</p>
    <p><strong>📅 建议复检：</strong>${esc(a.next_checkup || '无')}</p>
  `;

  resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ── history ── */
async function loadHistory() {
  if (!isLoggedIn) return;
  try {
    const resp = await fetch('/api/reports');
    if (resp.status === 401) { logout(); return; }
    const reports = await resp.json();
    if (!reports.length) {
      reportList.innerHTML = '<p class="report-empty">暂无历史记录，上传第一张化验单开始吧</p>';
      return;
    }
    let html = '';
    reports.forEach(r => {
      const date = r.report_date || r.created_at || '?';
      const summary = r.summary ? r.summary.slice(0, 50) + (r.summary.length > 50 ? '…' : '') : '无摘要';
      html += `<div class="report-item" data-id="${r.id}">
        <div class="ri-left" onclick="viewReport(${r.id})">
          <div class="ri-type">${esc(r.report_type || '未知类型')}</div>
          <div class="ri-date">${esc(date)}</div>
          <div class="ri-summary">${esc(summary)}</div>
        </div>
        <button class="ri-delete" onclick="deleteReport(${r.id}, event)" title="删除">🗑</button>
      </div>`;
    });
    reportList.innerHTML = html;
    if (reports.length > 0) {
      const latest = reports[0];
      if (latest.report_type) checkTrend(latest.report_type);
    }
  } catch (e) {
    reportList.innerHTML = '<p class="report-empty">加载失败</p>';
  }
}

async function viewReport(id) {
  try {
    const resp = await fetch(`/api/reports/${id}`);
    if (resp.status === 401) { logout(); return; }
    const data = await resp.json();
    if (data.error) { alert(data.error); return; }
    renderResult(data);
    if (data.report_type) checkTrend(data.report_type);
  } catch (e) { alert('加载失败: ' + e.message); }
}

async function deleteReport(id, ev) {
  ev.stopPropagation();
  if (!confirm('确定删除此报告？')) return;
  await fetch(`/api/reports/${id}`, { method: 'DELETE' });
  loadHistory();
}

async function checkTrend(type) {
  try {
    const resp = await fetch('/api/reports', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ report_type: type })
    });
    if (resp.status === 401) return;
    const data = await resp.json();
    if (data.error || !data.trend_items || data.trend_items.length < 1) {
      historySection.classList.add('hidden');
      return;
    }
    historySection.classList.remove('hidden');

    if (data.overall_assessment || data.suggestion) {
      document.getElementById('trendAnalysis').innerHTML = `
        <p><strong>📊 整体趋势：</strong>${esc(data.overall_assessment || '')}</p>
        <p><strong>💡 基于趋势的建议：</strong>${esc(data.suggestion || '')}</p>
      `;
    }

    let chartsHtml = '';
    if (data.trend_items) {
      data.trend_items.slice(0, 6).forEach(ti => {
        const values = ti.changes || [];
        const labels = values.map(v => v.date || '?');
        const nums = values.map(v => parseFloat(v.value));
        if (nums.some(n => !isNaN(n))) {
          const chartId = 'chart_' + Math.random().toString(36).slice(2, 8);
          chartsHtml += `<div class="trend-chart"><h4>📈 ${esc(ti.name)} ${ti.trend ? '— ' + esc(ti.trend) : ''}</h4>
            <p class="hint" style="margin-top:4px;color:${ti.attention ? '#c62828' : '#666'}">${esc(ti.attention || '正常')}</p>
            <canvas id="${chartId}" height="150"></canvas></div>`;
          setTimeout(() => drawChart(chartId, labels, nums), 100);
        }
      });
    }
    document.getElementById('trendCharts').innerHTML = chartsHtml;
  } catch (e) {
    historySection.classList.add('hidden');
  }
}

/* ── mini chart ── */
function drawChart(canvasId, labels, values) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  const w = Math.min(rect.width - 32, 600);
  const h = 150;
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  ctx.scale(dpr, dpr);

  const pad = { top: 20, bottom: 30, left: 50, right: 20 };
  const cw = w - pad.left - pad.right;
  const ch = h - pad.top - pad.bottom;
  ctx.clearRect(0, 0, w, h);

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const padding = range * 0.15;
  const yMin = min - padding;
  const yMax = max + padding;
  const yRange = yMax - yMin;

  ctx.strokeStyle = '#eee'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + ch - (i / 4) * ch;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
    ctx.fillStyle = '#999'; ctx.font = '11px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText((yMin + (i / 4) * yRange).toFixed(1), pad.left - 5, y + 4);
  }

  ctx.strokeStyle = '#1a73e8'; ctx.lineWidth = 2.5; ctx.lineJoin = 'round';
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = pad.left + (i / (values.length - 1 || 1)) * cw;
    const y = pad.top + ch - ((v - yMin) / yRange) * ch;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();

  values.forEach((v, i) => {
    const x = pad.left + (i / (values.length - 1 || 1)) * cw;
    const y = pad.top + ch - ((v - yMin) / yRange) * ch;
    ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#1a73e8'; ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
  });

  ctx.fillStyle = '#555'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
  labels.forEach((l, i) => {
    const x = pad.left + (i / (values.length - 1 || 1)) * cw;
    ctx.fillText(l, x, h - 8);
  });
}

/* ── helpers ── */
function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s ?? '');
  return d.innerHTML;
}

function goBack() {
  resultSection.classList.add('hidden');
  historySection.classList.add('hidden');
  if (isLoggedIn) loadHistory();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ── init ── */
checkLogin();
