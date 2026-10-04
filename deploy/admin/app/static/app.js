'use strict';

/* =========================================================================
 * MMH 后台管理 —— 前端（原生 JS，无构建、无外部依赖）
 * ========================================================================= */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function pad(n) { return String(n).padStart(2, '0'); }

/* ---------------------------------------------------------------- 时区
 * 服务端在 /api/me 里给出当前配置的时区（{spec, offset}）。所有时间都按它渲染，
 * 而不是跟着浏览器走 —— 审计口径要可复现，换台电脑打开得看到同一个时刻。
 * IANA 名（含 '/'，如 Asia/Shanghai）交给 Intl，浏览器自带 tzdata、含夏令时；
 * 固定偏移（UTC+8）Intl 不认，自己加偏移量算。
 */
let TZINFO = null;

function parseOffsetMinutes(spec) {
  const m = /^(?:UTC|GMT)?\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i.exec(spec || '');
  if (!m) return null;
  const sign = m[1] === '+' ? 1 : -1;
  return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3] || '0', 10));
}

function zoneParts(d) {
  const spec = TZINFO && TZINFO.spec;
  if (spec) {
    if (spec.includes('/') || spec === 'UTC') {
      try {
        const f = new Intl.DateTimeFormat('en-CA', {
          timeZone: spec, hour12: false,
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit',
        });
        const o = {};
        for (const p of f.formatToParts(d)) o[p.type] = p.value;
        // hour12:false 在部分实现里把午夜给成 "24"，取模兜一下
        return { y: +o.year, m: +o.month, d: +o.day,
                 h: +o.hour % 24, mi: +o.minute, s: +o.second };
      } catch (e) { /* 不认识的 zone 名，落到下面用本地时区 */ }
    }
    const off = parseOffsetMinutes(spec);
    if (off !== null) {
      const s = new Date(d.getTime() + off * 60000);
      return { y: s.getUTCFullYear(), m: s.getUTCMonth() + 1, d: s.getUTCDate(),
               h: s.getUTCHours(), mi: s.getUTCMinutes(), s: s.getUTCSeconds() };
    }
  }
  return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(),
           h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds() };
}

function fmtTime(ts, withSec = true) {
  if (!ts) return '';
  const p = zoneParts(new Date(Number(ts) * 1000));
  const base = `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}`;
  return withSec ? `${base}:${pad(p.s)}` : base;
}

function tzLabel() {
  if (!TZINFO || !TZINFO.spec) return '浏览器本地时区';
  return `${TZINFO.spec}${TZINFO.offset ? '（' + TZINFO.offset + '）' : ''}`;
}

function applyTz(tz) {
  if (tz && tz.spec) TZINFO = { spec: tz.spec, offset: tz.offset, abbr: tz.abbr };
}

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return s + ' 秒前';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  return Math.floor(s / 86400) + ' 天前';
}

/* ---------------------------------------------------------------- 请求 */
async function api(method, path, body) {
  const opt = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(path, opt);
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }

  if (res.status === 401) { showLogin('会话已过期，请重新登录'); throw new Error('未登录'); }
  if (!res.ok) {
    throw new Error((data && data.error) || ('HTTP ' + res.status));
  }
  if (data && data.ok === false) throw new Error(data.error || '请求失败');
  return (data && Object.prototype.hasOwnProperty.call(data, 'data')) ? data.data : data;
}

/* ---------------------------------------------------------------- 提示 */
function toast(msg, kind = '') {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 3200);
  setTimeout(() => el.remove(), 3600);
}

/* ---------------------------------------------------------------- 弹层 */
function openModal({ title, body, footer, onMount, width }) {
  const host = $('#modalHost');
  const mask = document.createElement('div');
  mask.className = 'mask';
  mask.innerHTML = `
    <div class="modal" ${width ? `style="max-width:${width}px"` : ''}>
      <header>${esc(title)}<div class="spacer" style="flex:1"></div>
        <button class="ghost sm" data-close>关闭</button></header>
      <div class="body">${body || ''}</div>
      ${footer ? `<footer>${footer}</footer>` : ''}
    </div>`;
  host.appendChild(mask);
  const close = () => mask.remove();
  mask.addEventListener('click', e => {
    if (e.target === mask || e.target.hasAttribute('data-close')) close();
  });
  if (onMount) onMount(mask, close);
  return { el: mask, close };
}

function confirmDialog(title, message, okLabel = '确认', danger = true) {
  return new Promise(resolve => {
    const m = openModal({
      title,
      body: `<div class="note" style="font-size:13.5px;color:var(--text)">${message}</div>`,
      footer: `<button data-close>取消</button>
               <button class="${danger ? 'danger' : 'primary'}" data-ok>${esc(okLabel)}</button>`,
      width: 460,
      onMount(mask, close) {
        $('[data-ok]', mask).addEventListener('click', () => { close(); resolve(true); });
        mask.addEventListener('click', e => { if (e.target.hasAttribute('data-close')) resolve(false); });
      }
    });
    void m;
  });
}

/* ---------------------------------------------------------------- 登录 */
function showLogin(msg) {
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#loginErr').textContent = msg || '';
  setTimeout(() => $('#tokenInput').focus(), 30);
}

async function boot() {
  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('#loginBtn');
    btn.disabled = true; btn.textContent = '登录中…';
    try {
      await api('POST', '/api/login', { token: $('#tokenInput').value });
      $('#tokenInput').value = '';
      await startApp();
    } catch (err) {
      $('#loginErr').textContent = err.message;
    } finally {
      btn.disabled = false; btn.textContent = '登录';
    }
  });

  // 先探一次会话是否还有效
  try {
    const me = await api('GET', '/api/me');
    applyMe(me);
    await startApp();
  } catch (e) {
    showLogin();
  }
}

function applyMe(me) {
  if (me && me.github_repo) $('#brandRepo').textContent = me.github_repo;
  if (me && me.tz) TZINFO = me.tz;      // 所有 fmtTime 都按这个时区渲染
}

async function startApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  try { applyMe(await api('GET', '/api/me')); } catch (e) { /* 忽略 */ }
  await route();
}

/* ---------------------------------------------------------------- 路由 */
const TABS = ['overview', 'registrations', 'downloads', 'mail', 'mailtemplates',
              'regadmin', 'issues', 'audit', 'settings'];
let currentTab = 'overview';

async function route() {
  const hash = (location.hash || '#overview').slice(1);
  const tab = TABS.includes(hash) ? hash : 'overview';
  currentTab = tab;
  $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  const view = $('#view');
  view.innerHTML = '<div class="empty"><span class="spin"></span> 加载中…</div>';
  try {
    if (tab === 'overview') await renderOverview(view);
    else if (tab === 'registrations') await renderRegistrations(view);
    else if (tab === 'downloads') await renderDownloads(view);
    else if (tab === 'mail') await renderMail(view);
    else if (tab === 'mailtemplates') await renderMailTemplates(view);
    else if (tab === 'regadmin') await renderRegAdmin(view);
    else if (tab === 'issues') await renderIssues(view);
    else if (tab === 'audit') await renderAudit(view);
    else if (tab === 'settings') await renderSettings(view);
  } catch (err) {
    view.innerHTML = `<div class="err-box">加载失败：${esc(err.message)}</div>`;
  }
}

window.addEventListener('hashchange', route);

$('#tabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-tab]');
  if (b) location.hash = b.dataset.tab;
});
$('#refreshBtn').addEventListener('click', () => route());
$('#logoutBtn').addEventListener('click', async () => {
  try { await api('POST', '/api/logout'); } catch (e) { /* 忽略 */ }
  location.reload();
});

/* ---------------------------------------------------------------- 通用块 */
function metric(label, value, sub, cls = '') {
  return `<div class="metric ${cls}">
    <div class="label">${esc(label)}</div>
    <div class="value">${esc(value)}</div>
    ${sub ? `<div class="sub">${sub}</div>` : ''}
  </div>`;
}

function bars(pairs, total) {
  if (!pairs.length) return '<div class="empty">暂无数据</div>';
  const max = Math.max(...pairs.map(p => p[1]), 1);
  return `<div class="bars">` + pairs.map(([name, n]) => `
    <div class="row">
      <div class="name" title="${esc(name)}">${esc(name)}</div>
      <div class="track"><div class="fill" style="width:${(n / max * 100).toFixed(1)}%"></div></div>
      <div class="n">${esc(n)}</div>
    </div>`).join('') + `</div>`;
}

function objPairs(obj, labels) {
  return Object.entries(obj || {})
    .map(([k, v]) => [labels && labels[k] ? labels[k] : k, Number(v)])
    .filter(p => p[1] > 0)
    .sort((a, b) => b[1] - a[1]);
}

function card(title, bodyHtml, hint = '', tight = false) {
  return `<section class="card">
    <header><h2>${esc(title)}</h2>${hint ? `<span class="hint">${hint}</span>` : ''}</header>
    <div class="body ${tight ? 'tight' : ''}">${bodyHtml}</div>
  </section>`;
}

// 每行 IP 都标出归属，别让"本机探针 / VPS 自己的公网 IP"混在里面看不出来。
const IP_KIND_BADGE = {
  public: { cls: '', text: '公网' },
  loopback: { cls: 'warn', text: '本机' },
  private: { cls: 'warn', text: '内网' },
  unknown: { cls: 'accent', text: '无 IP' },
};

function ipBadge(kind) {
  const b = IP_KIND_BADGE[kind] || IP_KIND_BADGE.unknown;
  return ` <span class="badge ${b.cls}">${b.text}</span>`;
}

function setDots(regNew, mailNew, issuesOpen) {
  const set = (id, n) => {
    const el = $(id);
    if (!el) return;
    el.hidden = !n;
    el.textContent = n > 99 ? '99+' : n;
  };
  set('#dotReg', regNew);
  set('#dotMail', mailNew);
  set('#dotIss', issuesOpen);
}

/* =========================================================================
 * 概览
 * ========================================================================= */
async function renderOverview(view) {
  const data = await api('GET', '/api/overview');

  const reg = data.registrations || {};
  const dl = data.downloads || {};
  const ml = data.mail || {};
  const iss = data.issues || {};

  setDots(
    reg.ok ? (reg.totals.principals_active || 0) : 0,
    ml.ok ? (ml.new || 0) : 0,
    iss.ok ? (iss.open_issues || 0) : 0
  );

  const dlTotals = dl.ok ? dl.totals : {};
  const chPairs = dl.ok ? objPairs(dl.by_channel, dl.channel_labels) : [];

  let html = '';

  html += `<div class="grid c4" style="margin-bottom:16px">
    ${metric('注册用户', reg.ok ? reg.totals.principals : '—',
             reg.ok ? `设备 ${reg.totals.installations}（在用 ${reg.totals.installations_active}）` : '',
             reg.ok ? 'accent' : 'danger')}
    ${metric('累计下载', dl.ok ? dlTotals.external : '—',
             dl.ok ? `含本机/内网 ${dlTotals.internal}，共 ${dlTotals.all}` : '',
             dl.ok ? 'ok' : 'danger')}
    ${metric('今日下载', dl.ok ? dlTotals.today : '—',
             dl.ok ? `近 7 日 ${dlTotals.last7}` : '', '')}
    ${metric('未读邮件', ml.ok ? ml.new : '—',
             ml.ok ? `收件箱 ${ml.cur}，回收站 ${ml.trash}` : '',
             ml.ok && ml.new ? 'warn' : '')}
    ${metric('待办 Issue', iss.ok ? iss.open_issues : '—',
             iss.ok ? `PR ${iss.open_prs}` : (iss.error ? esc(iss.error).slice(0, 40) : ''),
             iss.ok ? '' : 'danger')}
  </div>`;

  html += `<div class="grid c2">`;

  // 下载
  html += card('下载渠道分布', dl.ok
    ? bars(chPairs, dlTotals.external) +
      `<div class="note" style="margin-top:10px">
         口径：排除本机/内网（loopback+private），含无 IP 的历史聚合导入行；
         统计窗口 ${esc(dl.days)} 天。</div>`
    : `<div class="err-box">${esc(dl.error)}</div>`, '', false);

  // 最近下载
  html += card('按日期 × 渠道', dl.ok && Object.keys(dl.date_channel || {}).length
    ? `<div class="scroll-x"><table>
        <thead><tr><th>日期</th><th class="num">合计</th><th>明细</th></tr></thead>
        <tbody>${Object.entries(dl.date_channel).map(([d, row]) => {
          const tot = Object.values(row).reduce((a, b) => a + b, 0);
          const detail = objPairs(row, dl.channel_labels)
            .map(([k, v]) => `${esc(k)} ${v}`).join(' · ');
          return `<tr><td class="mono">${esc(d)}</td><td class="num">${tot}</td>
                  <td>${detail || '—'}</td></tr>`;
        }).join('')}</tbody></table></div>`
    : '<div class="empty">暂无数据</div>');

  // 注册
  html += card('最近注册', reg.ok
    ? (reg.recent && reg.recent.length
        ? `<table><thead><tr><th>用户</th><th>状态</th><th class="num">身份</th>
            <th class="num">设备</th><th>注册时间</th></tr></thead><tbody>
            ${reg.recent.map(r => `<tr>
              <td><a href="#registrations" onclick="openPrincipal('${esc(r.id)}')">${esc(r.display_name || r.id.slice(0, 12))}</a></td>
              <td>${r.status === 'active' ? '<span class="badge ok">正常</span>'
                                          : '<span class="badge danger">已禁用</span>'}</td>
              <td class="num">${r.n_identities}</td>
              <td class="num">${r.n_installations}</td>
              <td class="mono">${esc((r.created_at || '').replace('T', ' ').slice(0, 16))}</td>
            </tr>`).join('')}</tbody></table>`
        : '<div class="empty">还没有任何注册用户</div>')
    : `<div class="err-box">${esc(reg.error)}</div>`);

  // 邮件
  html += card('邮件盯盘', ml.ok
    ? `<dl class="kv">
        <dt>监控信箱</dt><dd>${esc((ml.accounts || []).map(a => a.account).join('、') || '—')}</dd>
        <dt>未读 / 收件箱</dt><dd>${ml.new} / ${ml.cur}</dd>
        <dt>最新一封</dt><dd>${ml.latest_ts
          ? `${esc(ml.latest_from || '未知发件人')} · ${esc(ml.latest_subject)}<br>
             <span class="note">${esc(ago(ml.latest_ts))}（${esc(fmtTime(ml.latest_ts))}）</span>`
          : '—'}</dd>
        <dt>发信通道</dt><dd>${ml.smtp_ok
          ? '<span class="badge ok">Postfix 可达</span>'
          : `<span class="badge danger">不可达</span> <span class="note">${esc(ml.smtp_detail || '')}</span>`}</dd>
      </dl>
      <div style="margin-top:12px"><a class="btn" href="#mail">进入邮件盯盘 →</a></div>`
    : `<div class="err-box">${esc(ml.error)}</div>`);

  // Issue
  html += card('Issue 盯盘', iss.ok
    ? ((iss.items && iss.items.length)
        ? `<table><thead><tr><th>#</th><th>标题</th><th>标签</th><th>更新</th></tr></thead><tbody>
            ${iss.items.map(i => `<tr>
              <td class="mono">${i.is_pr ? 'PR ' : ''}${i.number}</td>
              <td><a href="#issues" onclick="openIssue(${i.number})">${esc(i.title)}</a></td>
              <td>${(i.labels || []).map(l =>
                  `<span class="label-chip" style="background:#${esc(l.color)}22;border-color:#${esc(l.color)}55">${esc(l.name)}</span>`).join('') || '—'}</td>
              <td class="note">${esc(ago(Math.floor(new Date(i.updated_at).getTime() / 1000)))}</td>
            </tr>`).join('')}</tbody></table>`
        : '<div class="empty">没有待处理的 issue</div>')
      + `<div class="note" style="margin-top:10px">仓库 <code>${esc(iss.repo)}</code>
         · 剩余配额 ${esc(iss.rate_remaining || '?')}</div>`
    : `<div class="err-box">${esc(iss.error)}</div>`);

  html += `</div>`;
  html += `<div class="note" style="text-align:center;color:var(--text-faint)">
      数据生成于 ${esc(data.ts ? fmtTime(data.ts) : data.time)}（${esc(tzLabel())}）</div>`;

  view.innerHTML = html;
}

/* =========================================================================
 * 自动用户注册
 * ========================================================================= */
let regState = { q: '', status: '' };

async function renderRegistrations(view) {
  const ov = await api('GET', '/api/registrations/overview');
  const list = await api('GET',
    `/api/registrations/principals?q=${encodeURIComponent(regState.q)}&status=${encodeURIComponent(regState.status)}`);

  const t = ov.totals;
  let html = `<div class="grid c4" style="margin-bottom:16px">
    ${metric('注册用户', t.principals, `正常 ${t.principals_active} · 禁用 ${t.principals_disabled}`, 'accent')}
    ${metric('登录身份', t.identities, (ov.by_provider || []).map(p => `${p.provider} ${p.n}`).join(' · '))}
    ${metric('已注册设备', t.installations, `在用 ${t.installations_active}`)}
    ${metric('数据库', ov.db_present ? '正常' : '缺失',
             `<span class="mono" style="font-size:11px">${esc(ov.db_path)}</span>`,
             ov.db_present ? 'ok' : 'danger')}
  </div>`;

  html += card('用户列表', `
    <div class="toolbar" style="margin-bottom:12px">
      <div class="grow"><input type="search" id="regQ" placeholder="搜索用户名 / ID / 邮箱 / 设备名"
             value="${esc(regState.q)}"></div>
      <div class="seg" id="regStatus">
        <button data-v="" class="${regState.status === '' ? 'active' : ''}">全部</button>
        <button data-v="active" class="${regState.status === 'active' ? 'active' : ''}">正常</button>
        <button data-v="disabled" class="${regState.status === 'disabled' ? 'active' : ''}">已禁用</button>
      </div>
      <button id="regSearch" class="primary">搜索</button>
    </div>
    ${list.items.length ? `<div class="scroll-x"><table>
      <thead><tr><th>用户</th><th>ID</th><th>状态</th><th>身份</th>
        <th class="num">设备</th><th>最近登录</th><th>注册时间</th><th></th></tr></thead>
      <tbody>${list.items.map(p => `
        <tr>
          <td><strong>${esc(p.display_name || '(未命名)')}</strong></td>
          <td class="mono">${esc(p.id.slice(0, 12))}…</td>
          <td>${p.status === 'active'
                ? '<span class="badge ok">正常</span>'
                : '<span class="badge danger">已禁用</span>'}</td>
          <td>${(p.providers || '').split(',').filter(Boolean)
                .map(x => `<span class="badge">${esc(x)}</span>`).join('') || '—'}</td>
          <td class="num">${p.n_installations}</td>
          <td class="note">${p.last_login_at
                ? esc(ago(Math.floor(new Date(p.last_login_at).getTime() / 1000)))
                : p.last_seen_at
                  ? esc(ago(Math.floor(new Date(p.last_seen_at).getTime() / 1000)))
                  : '—'}</td>
          <td class="mono">${esc((p.created_at || '').replace('T', ' ').slice(0, 16))}</td>
          <td><button class="sm" onclick="openPrincipal('${esc(p.id)}')">详情</button></td>
        </tr>`).join('')}</tbody></table></div>`
      : '<div class="empty">没有匹配的用户</div>'}`,
    `共 ${list.total} 条${regState.q || regState.status ? `，匹配 ${list.shown} 条` : ''}`, true);

  if (ov.daily && ov.daily.length) {
    html += card('注册趋势', bars(ov.daily.map(d => [d.d, d.n]).reverse()), '', false);
  }

  view.innerHTML = html;

  const doSearch = () => {
    regState.q = $('#regQ').value.trim();
    route();
  };
  $('#regSearch').addEventListener('click', doSearch);
  $('#regQ').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  $('#regStatus').addEventListener('click', e => {
    const b = e.target.closest('button[data-v]');
    if (b) { regState.status = b.dataset.v; route(); }
  });
}

async function openPrincipal(pid) {
  let d;
  try { d = await api('GET', `/api/registrations/principals/${encodeURIComponent(pid)}`); }
  catch (e) { toast(e.message, 'err'); return; }

  const p = d.principal;
  const active = p.status === 'active';

  const body = `
    <dl class="kv" style="margin-bottom:16px">
      <dt>用户 ID</dt><dd class="mono">${esc(p.id)}</dd>
      <dt>名称</dt><dd>${esc(p.display_name || '(未命名)')}</dd>
      <dt>状态</dt><dd>${active ? '<span class="badge ok">正常</span>'
                                : '<span class="badge danger">已禁用</span>'}</dd>
      <dt>注册时间</dt><dd>${esc(p.created_at)}</dd>
      <dt>更新时间</dt><dd>${esc(p.updated_at)}</dd>
      <dt>最近登录</dt><dd>${p.last_login_at
        ? esc(ago(Math.floor(new Date(p.last_login_at).getTime() / 1000)))
        : '—'}</dd>
    </dl>

    <h3 style="font-size:13px;margin:16px 0 8px">登录身份（${d.identities.length}）</h3>
    ${d.identities.length ? `<table><thead><tr><th>provider</th><th>subject</th><th>名称</th><th></th></tr></thead>
      <tbody>${d.identities.map(i => `<tr>
        <td><span class="badge">${esc(i.provider)}</span></td>
        <td class="mono">${esc(i.subject)}</td>
        <td>${esc(i.display_name || '—')}</td>
        <td><button class="sm danger" onclick="delIdentity('${esc(i.id)}','${esc(pid)}')">删除</button></td>
      </tr>`).join('')}</tbody></table>`
      : '<div class="note">无</div>'}

    <h3 style="font-size:13px;margin:18px 0 8px">已注册设备（${d.installations.length}）</h3>
    ${d.installations.length ? `<table><thead><tr><th>设备</th><th>平台</th><th>状态</th>
        <th>最近活跃</th><th></th></tr></thead>
      <tbody>${d.installations.map(t => `<tr>
        <td>${esc(t.device_name || '(未命名)')}<br>
            <span class="mono note">${esc(t.id.slice(0, 16))}…</span></td>
        <td>${esc(t.platform)}</td>
        <td>${t.status === 'active' ? '<span class="badge ok">在用</span>'
                                    : '<span class="badge danger">已禁用</span>'}</td>
        <td class="note">${t.last_seen_at
            ? esc(ago(Math.floor(new Date(t.last_seen_at).getTime() / 1000))) : '—'}</td>
        <td style="white-space:nowrap">
          <button class="sm" onclick="toggleInstallation('${esc(t.id)}','${t.status === 'active' ? 'disabled' : 'active'}','${esc(pid)}')">
            ${t.status === 'active' ? '禁用' : '启用'}</button>
          <button class="sm danger" onclick="delInstallation('${esc(t.id)}','${esc(pid)}')">删除</button>
        </td>
      </tr>`).join('')}</tbody></table>`
      : '<div class="note">无</div>'}
  `;

  const footer = `
    <button class="danger" onclick="delPrincipal('${esc(pid)}')">删除该用户</button>
    <button class="${active ? 'danger' : 'primary'}" onclick="togglePrincipal('${esc(pid)}','${active ? 'disabled' : 'active'}')">
      ${active ? '禁用账号（含全部设备）' : '恢复账号'}
    </button>`;

  openModal({ title: '用户详情', body, footer, width: 760 });
}

window.openPrincipal = openPrincipal;

window.togglePrincipal = async (pid, status) => {
  const verb = status === 'disabled' ? '禁用' : '恢复';
  if (status === 'disabled') {
    const ok = await confirmDialog('确认禁用该账号？',
      '禁用后会<b>级联禁用该用户的全部设备</b>，设备将无法继续同步。此操作可逆。', '禁用', true);
    if (!ok) return;
  }
  try {
    const r = await api('POST', `/api/registrations/principals/${encodeURIComponent(pid)}/status`, { status });
    toast(`已${verb}${r.cascaded_installations ? `（同时禁用 ${r.cascaded_installations} 台设备）` : ''}`, 'ok');
    $$('.mask').forEach(m => m.remove());
    route();
  } catch (e) { toast(e.message, 'err'); }
};

window.delPrincipal = async (pid) => {
  const ok = await confirmDialog('确认删除该用户？',
    '将<b>永久删除</b>该用户及其全部身份、设备记录，<b>不可恢复</b>。通常应该先禁用观察。', '永久删除', true);
  if (!ok) return;
  try {
    const r = await api('DELETE', `/api/registrations/principals/${encodeURIComponent(pid)}`);
    toast(`已删除（身份 ${r.identities}、设备 ${r.installations}）`, 'ok');
    $$('.mask').forEach(m => m.remove());
    route();
  } catch (e) { toast(e.message, 'err'); }
};

window.toggleInstallation = async (iid, status, pid) => {
  try {
    await api('POST', `/api/registrations/installations/${encodeURIComponent(iid)}/status`, { status });
    toast(status === 'disabled' ? '设备已禁用' : '设备已启用', 'ok');
    $$('.mask').forEach(m => m.remove());
    if (pid) openPrincipal(pid);
  } catch (e) { toast(e.message, 'err'); }
};

window.delInstallation = async (iid, pid) => {
  const ok = await confirmDialog('确认删除该设备？', '删除后该设备需重新注册。', '删除', true);
  if (!ok) return;
  try {
    await api('DELETE', `/api/registrations/installations/${encodeURIComponent(iid)}`);
    toast('设备已删除', 'ok');
    $$('.mask').forEach(m => m.remove());
    if (pid) openPrincipal(pid);
  } catch (e) { toast(e.message, 'err'); }
};

window.delIdentity = async (iid, pid) => {
  const ok = await confirmDialog('确认删除该登录身份？',
    '删除后用户将无法再用该身份登录（例如该邮箱/微信）。', '删除', true);
  if (!ok) return;
  try {
    await api('DELETE', `/api/registrations/identities/${encodeURIComponent(iid)}`);
    toast('身份已删除', 'ok');
    $$('.mask').forEach(m => m.remove());
    if (pid) openPrincipal(pid);
  } catch (e) { toast(e.message, 'err'); }
};

/* =========================================================================
 * 下载汇总
 * ========================================================================= */
let dlState = { days: 30, includeInternal: false };

async function renderDownloads(view) {
  const q = `days=${dlState.days}&include_internal=${dlState.includeInternal ? 1 : 0}`;
  const s = await api('GET', `/api/downloads/summary?${q}`);
  const recent = await api('GET',
    `/api/downloads/recent?limit=120&include_internal=${dlState.includeInternal ? 1 : 0}`);

  const t = s.totals;
  let html = `<div class="toolbar" style="margin-bottom:16px">
    <div class="seg" id="dlDays">
      ${[7, 30, 90, 365].map(d =>
        `<button data-v="${d}" class="${dlState.days === d ? 'active' : ''}">${d} 天</button>`).join('')}
    </div>
    <label class="chk"><input type="checkbox" id="dlInternal"
      ${dlState.includeInternal ? 'checked' : ''}> 含本机 / 内网记录</label>
    <div class="spacer" style="flex:1"></div>
    <button id="dlExport">导出 CSV</button>
  </div>`;

  html += `<div class="grid c4" style="margin-bottom:16px">
    ${metric('计入下载总数', t.external, `全部 ${t.all}（本机/内网 ${t.internal}）`, 'ok')}
    ${metric('今日', t.today, `${esc(s.days)} 天窗口内`, 'accent')}
    ${metric('近 7 日', t.last7, '')}
    ${metric('覆盖版本', t.versions, '')}
  </div>`;

  html += `<div class="grid c2">
    ${card('渠道分布', bars(objPairs(s.by_channel, s.channel_labels)))}
    ${card('客户端软件', bars(objPairs(s.by_client, s.client_labels)))}
    ${card('版本分布', bars(objPairs(s.by_version)))}
    ${card('IP 归属', bars(objPairs(s.by_ip_kind, {
        public: '公网（计入）', unknown: '无 IP（历史聚合，计入）',
        loopback: '本机 127.0.0.1（排除）', private: '内网（排除）'
      })))}
  </div>`;

  const dates = Object.keys(s.date_channel).sort().reverse();
  html += card('日期 × 渠道', dates.length ? `<div class="scroll-x"><table>
    <thead><tr><th>日期</th>${s.channels.map(c => `<th class="num">${esc(s.channel_labels[c] || c)}</th>`).join('')}<th class="num">合计</th></tr></thead>
    <tbody>${dates.map(d => {
      const row = s.date_channel[d];
      const vals = s.channels.map(c => row[c] || 0);
      return `<tr><td class="mono">${esc(d)}</td>
        ${vals.map(v => `<td class="num">${v || '·'}</td>`).join('')}
        <td class="num"><strong>${vals.reduce((a, b) => a + b, 0)}</strong></td></tr>`;
    }).join('')}</tbody></table></div>` : '<div class="empty">暂无数据</div>', '', true);

  html += card('最近下载明细', recent.items.length ? `<div class="scroll"><table>
    <thead><tr><th>时间</th><th>版本</th><th>文件</th><th>渠道</th><th>客户端</th><th>IP</th><th>来源</th></tr></thead>
    <tbody>${recent.items.map(r => `<tr>
      <td class="mono">${esc(r.time)}</td>
      <td>${esc(r.version || '—')}</td>
      <td class="mono" style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
          title="${esc(r.file)}">${esc(r.file)}</td>
      <td>${esc(s.channel_labels[r.channel] || r.channel)}</td>
      <td>${esc(s.client_labels[r.client] || r.client)}</td>
      <td class="mono">${esc(r.ip || '—')}${ipBadge(r.ip_kind)}</td>
      <td class="note">${esc(r.origin)}</td>
    </tr>`).join('')}</tbody></table></div>` : '<div class="empty">暂无数据</div>',
    `共 ${recent.items.length} 条 · ${dlState.includeInternal ? '含本机 / 内网' : '已排除本机 / 内网'}`, true);

  html += `<div class="note" style="text-align:center">
    数据源 <code>${esc(s.db_path)}</code> · 口径与 <code>fnapp.floatingice.win:4001/fnstore/</code> 一致：
    排除 <code>loopback</code> 与 <code>private</code>，保留 <code>unknown</code>（无 IP 的历史聚合导入行）。
    汇总数与下方明细表用的是同一套口径；要看被排除的记录，勾上「含本机 / 内网记录」。</div>`;

  view.innerHTML = html;

  $('#dlDays').addEventListener('click', e => {
    const b = e.target.closest('button[data-v]');
    if (b) { dlState.days = Number(b.dataset.v); route(); }
  });
  $('#dlInternal').addEventListener('change', e => {
    dlState.includeInternal = e.target.checked; route();
  });
  $('#dlExport').addEventListener('click', async () => {
    try {
      const r = await api('GET', `/api/downloads/export.csv?${q}`);
      const blob = new Blob(['\ufeff' + r.csv], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = r.filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast('已导出 ' + r.filename, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  });
}

/* =========================================================================
 * 邮件盯盘
 * ========================================================================= */
let mailState = { account: '', folder: 'cur', sel: null, data: null };

async function renderMail(view) {
  const acc = await api('GET', '/api/mail/accounts');
  if (!mailState.account && acc.accounts.length) mailState.account = acc.accounts[0].account;

  const list = await api('GET',
    `/api/mail/messages?account=${encodeURIComponent(mailState.account)}&folder=${mailState.folder}&limit=150`);

  let html = `<div class="toolbar" style="margin-bottom:16px">
    <div class="seg" id="mailAcc">
      ${acc.accounts.map(a => `<button data-v="${esc(a.account)}"
        class="${mailState.account === a.account ? 'active' : ''}">${esc(a.account)}
        <span class="badge ${a.counts.new ? 'warn' : ''}">${a.counts.new}</span></button>`).join('')}
    </div>
    <div class="seg" id="mailFolder">
      ${[['cur', '收件箱'], ['new', '未读'], ['trash', '回收站']].map(([v, label]) =>
        `<button data-v="${v}" class="${mailState.folder === v ? 'active' : ''}">${label}</button>`).join('')}
    </div>
    <div class="spacer" style="flex:1"></div>
    <button id="mailCompose" class="primary">写邮件</button>
  </div>`;

  html += `<div class="mail-layout">
    <section class="card" style="margin:0">
      <header><h2>${esc(mailState.account || '—')}</h2>
        <span class="hint">${list.items.length} 封</span></header>
      <div class="msg-list" id="msgList">
        ${list.items.length ? list.items.map(m => `
          <div class="msg ${m.seen ? '' : 'unread'} ${mailState.sel === m.key ? 'sel' : ''}"
               data-key="${esc(m.key)}">
            <div class="r1">
              <div class="from">${esc(m.from[0] ? (m.from[0].name || m.from[0].email) : '未知')}</div>
              <div class="when">${esc(fmtTime(m.date_ts, false))}</div>
            </div>
            <div class="subj">${esc(m.subject)}</div>
            <div class="prev">${esc(m.preview || '')}</div>
          </div>`).join('') : '<div class="empty">这个目录没有邮件</div>'}
      </div>
    </section>
    <section class="card" style="margin:0">
      <div id="mailDetail"><div class="empty">← 从左侧选择一封邮件</div></div>
    </section>
  </div>`;

  html += `<div class="note" style="margin-top:14px;text-align:center">
    邮件目录 <code>${esc(acc.root)}</code> · 回复经本机 Postfix（opendkim 签名）发出</div>`;

  view.innerHTML = html;

  $('#mailAcc').addEventListener('click', e => {
    const b = e.target.closest('button[data-v]');
    if (b) { mailState.account = b.dataset.v; mailState.sel = null; route(); }
  });
  $('#mailFolder').addEventListener('click', e => {
    const b = e.target.closest('button[data-v]');
    if (b) { mailState.folder = b.dataset.v; mailState.sel = null; route(); }
  });
  $('#mailCompose').addEventListener('click', composeMail);
  $('#msgList').addEventListener('click', e => {
    const el = e.target.closest('.msg[data-key]');
    if (el) openMessage(el.dataset.key);
  });

  if (mailState.sel) openMessage(mailState.sel, true);
}

async function openMessage(key, silent) {
  mailState.sel = key;
  $$('.msg').forEach(m => m.classList.toggle('sel', m.dataset.key === key));
  const host = $('#mailDetail');
  if (!host) return;
  if (!silent) host.innerHTML = '<div class="empty"><span class="spin"></span> 加载中…</div>';

  let m;
  try { m = await api('GET', `/api/mail/message/${encodeURIComponent(key)}`); }
  catch (e) { host.innerHTML = `<div class="err-box">${esc(e.message)}</div>`; return; }

  const isTrash = m.folder === 'trash';
  host.innerHTML = `
    <header style="display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--border);background:var(--panel-2)">
      <h2 style="margin:0;font-size:14px;font-weight:600;flex:1">${esc(m.subject)}</h2>
      <button class="sm" id="mTranslate">翻译</button>
      <button class="sm" id="mReply">回复</button>
      <button class="sm" id="mFlag">${m.seen ? '标为未读' : '标为已读'}</button>
      ${isTrash
        ? `<button class="sm" id="mRestore">还原</button>
           <button class="sm danger" id="mDelete">彻底删除</button>`
        : `<button class="sm danger" id="mTrash">移入回收站</button>`}
    </header>
    <div class="body" style="padding:16px">
      <dl class="kv" style="margin-bottom:14px">
        <dt>发件人</dt><dd>${m.from.map(a => `${esc(a.name)} &lt;${esc(a.email)}&gt;`).join(', ') || '—'}</dd>
        <dt>收件人</dt><dd>${m.to.map(a => esc(a.email)).join(', ') || '—'}</dd>
        ${m.cc.length ? `<dt>抄送</dt><dd>${m.cc.map(a => esc(a.email)).join(', ')}</dd>` : ''}
        <dt>时间</dt><dd>${esc(m.date)}</dd>
        <dt>大小</dt><dd>${fmtBytes(m.size)}</dd>
        ${m.attachments.length ? `<dt>附件</dt><dd>${m.attachments.map((a, i) =>
            `<a href="#" onclick="downloadAttachment('${esc(key)}',${i});return false">
              ${esc(a.filename)} <span class="note">(${fmtBytes(a.size)})</span></a>`).join('<br>')}</dd>` : ''}
      </dl>
      ${m.html
        ? `<iframe class="mail-html" sandbox="" srcdoc="${esc(m.html)}"></iframe>`
        : `<div class="mail-body">${esc(m.text || '(无正文)')}</div>`}
    </div>`;

  $('#mTranslate').addEventListener('click', () => translateMessage(m, host));
  $('#mReply').addEventListener('click', () => replyMail(m));
  $('#mFlag').addEventListener('click', () => mailFlag(key, !m.seen));
  const trash = $('#mTrash');
  if (trash) trash.addEventListener('click', () => mailMove(key, 'trash'));
  const restore = $('#mRestore');
  if (restore) restore.addEventListener('click', () => mailMove(key, 'cur'));
  const del = $('#mDelete');
  if (del) del.addEventListener('click', () => mailDelete(key));
}

/* 一键翻译（英→中，浏览器端调免费在线接口，零后端依赖）。
 * 翻译主题 + 正文，点击后把译文以「原版 / 译文」对照的形式插到正文下方。
 * 优先 Google 非官方端点（无需 key、支持 CORS、无长度硬限），失败回退 MyMemory。
 * 正文可能很长，按块切分翻译再拼接，避免单请求超长被拒。
 */
function _trSplit(text, max = 1400) {
  if (!text) return [];
  const parts = [];
  let cur = '';
  for (const line of String(text).split('\n')) {
    if (cur.length + line.length > max && cur) { parts.push(cur); cur = line; }
    else cur = cur ? cur + '\n' + line : line;
  }
  if (cur) parts.push(cur);
  return parts;
}

async function _trGoogle(text) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q='
    + encodeURIComponent(text);
  const res = await fetch(url);
  if (!res.ok) throw new Error('翻译接口响应 ' + res.status);
  const data = await res.json();
  const out = (Array.isArray(data) && Array.isArray(data[0]))
    ? data[0].map(seg => (seg && seg[0]) || '').join('')
    : '';
  if (!out) throw new Error('翻译接口返回为空');
  return out;
}

async function _trMyMemory(text) {
  const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text)
    + '&langpair=en|zh-CN';
  const res = await fetch(url);
  if (!res.ok) throw new Error('翻译接口响应 ' + res.status);
  const data = await res.json();
  const out = data && data.responseData && data.responseData.translatedText;
  if (!out) throw new Error('翻译接口返回为空');
  return out;
}

async function translateEnToZh(text) {
  const parts = _trSplit(text);
  const out = [];
  for (const p of parts) {
    let t = null;
    try { t = await _trGoogle(p); }
    catch (e) { try { t = await _trMyMemory(p); } catch (e2) { t = null; } }
    out.push(t != null ? t : p);
  }
  return out.join('\n');
}

async function translateMessage(m, host) {
  const btn = $('#mTranslate', host);
  const body = $('#mailTranslateHost', host);
  if (body && body.dataset.open === '1') {
    body.remove();
    if (btn) btn.textContent = '翻译';
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = '翻译中…'; }
  try {
    const [subjZh, textZh] = await Promise.all([
      translateEnToZh(m.subject || ''),
      translateEnToZh(m.text || ''),
    ]);
    const hostBody = $('#mailDetail .body');
    let box = hostBody.querySelector('#mailTranslateHost');
    if (!box) {
      box = document.createElement('div');
      box.id = 'mailTranslateHost';
      box.dataset.open = '1';
      box.className = 'mail-translate';
      box.innerHTML = `
        <div class="tr-title">中文翻译</div>
        <div class="tr-block"><div class="tr-label">主题</div>
          <div class="tr-orig">${esc(m.subject)}</div>
          <div class="tr-dst">${esc(subjZh)}</div></div>
        <div class="tr-block"><div class="tr-label">正文</div>
          <div class="tr-orig">${esc(m.text || '(无正文)')}</div>
          <div class="tr-dst">${esc(textZh || '(无正文)')}</div></div>`;
      hostBody.appendChild(box);
    }
    if (btn) btn.textContent = '收起译文';
  } catch (e) {
    toast('翻译失败：' + e.message, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

window.downloadAttachment = async (key, idx) => {
  try {
    const r = await api('GET', `/api/mail/attachment/${encodeURIComponent(key)}/${idx}`);
    const bin = atob(r.data_b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const blob = new Blob([buf], { type: r.content_type || 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = r.filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  } catch (e) { toast(e.message, 'err'); }
};

async function mailFlag(key, seen) {
  try {
    const r = await api('POST', '/api/mail/flag', { key, seen });
    toast(seen ? '已标为已读' : '已标为未读', 'ok');
    mailState.sel = r.key;
    route();
  } catch (e) { toast(e.message, 'err'); }
}

async function mailMove(key, target) {
  try {
    await api('POST', '/api/mail/move', { key, target });
    toast(target === 'trash' ? '已移入回收站' : '已还原', 'ok');
    mailState.sel = null;
    route();
  } catch (e) { toast(e.message, 'err'); }
}

async function mailDelete(key) {
  const ok = await confirmDialog('确认彻底删除？', '这封邮件将被<b>永久删除</b>，无法恢复。', '永久删除', true);
  if (!ok) return;
  try {
    await api('DELETE', '/api/mail/message', { key });
    toast('已删除', 'ok');
    mailState.sel = null;
    route();
  } catch (e) { toast(e.message, 'err'); }
}

function replyMail(m) {
  const body = `
    <dl class="kv" style="margin-bottom:12px">
      <dt>收件人</dt><dd><input type="text" id="rpTo" value="${esc(m.reply_to)}"></dd>
      <dt>主题</dt><dd><input type="text" id="rpSubj" value="${esc(m.reply_subject)}"></dd>
    </dl>
    <textarea id="rpBody" style="min-height:240px" placeholder="回复内容…"></textarea>
    <div class="note" style="margin-top:10px">
      将带上 <code>In-Reply-To</code> / <code>References</code>，从
      <code>${esc(m.to[0] ? m.to[0].email : '')}</code> 发出，经 opendkim 签名。
    </div>`;
  openModal({
    title: '回复邮件', body, width: 720,
    footer: `<button data-close>取消</button><button class="primary" data-send>发送</button>`,
    onMount(mask, close) {
      $('[data-send]', mask).addEventListener('click', async () => {
        const btn = $('[data-send]', mask);
        btn.disabled = true; btn.textContent = '发送中…';
        try {
          await api('POST', '/api/mail/reply', {
            key: m.key,
            to: $('#rpTo', mask).value.trim(),
            subject: $('#rpSubj', mask).value.trim(),
            body: $('#rpBody', mask).value
          });
          toast('已发送', 'ok');
          close();
          route();
        } catch (e) {
          toast(e.message, 'err');
          btn.disabled = false; btn.textContent = '发送';
        }
      });
    }
  });
}

function composeMail() {
  const body = `
    <dl class="kv" style="margin-bottom:12px">
      <dt>收件人</dt><dd><input type="text" id="cpTo" placeholder="多个用逗号分隔"></dd>
      <dt>抄送</dt><dd><input type="text" id="cpCc" placeholder="可留空"></dd>
      <dt>主题</dt><dd><input type="text" id="cpSubj"></dd>
    </dl>
    <textarea id="cpBody" style="min-height:240px"></textarea>`;
  openModal({
    title: '写邮件', body, width: 720,
    footer: `<button data-close>取消</button><button class="primary" data-send>发送</button>`,
    onMount(mask, close) {
      $('[data-send]', mask).addEventListener('click', async () => {
        const btn = $('[data-send]', mask);
        btn.disabled = true; btn.textContent = '发送中…';
        try {
          const to = $('#cpTo', mask).value.split(',').map(s => s.trim()).filter(Boolean);
          const cc = $('#cpCc', mask).value.split(',').map(s => s.trim()).filter(Boolean);
          if (!to.length) throw new Error('请填写收件人');
          await api('POST', '/api/mail/send', {
            to, cc, subject: $('#cpSubj', mask).value.trim(), body: $('#cpBody', mask).value
          });
          toast('已发送', 'ok');
          close();
        } catch (e) {
          toast(e.message, 'err');
          btn.disabled = false; btn.textContent = '发送';
        }
      });
    }
  });
}

/* =========================================================================
 * 邮件模板（认证服务器 mmh-registration 发出的验证码邮件文案）
 * =========================================================================
 * 数据源是注册库的 mail_templates 表；没有行时展示认证服务器内置的默认文案。
 * 保存即写库，认证服务器下次发信就生效，不用重建镜像/重启。
 * 预览走服务端同一套占位符替换，保证「看到的」就是「发出去的」。
 */
let mtState = { purpose: 'registration', lang: 'zh' };
let mtPreviewTimer = null;

async function renderMailTemplates(view) {
  const d = await api('GET', '/api/mail-templates');
  const items = d.items || [];
  if (!items.some(i => i.key === mtState.purpose)) {
    mtState.purpose = items.length ? items[0].key : 'registration';
  }
  const cur = items.find(i => i.key === mtState.purpose) || {};
  const langs = cur.langs || [];
  if (!langs.some(l => l.key === mtState.lang)) {
    mtState.lang = langs.length ? langs[0].key : 'zh';
  }
  const curLang = langs.find(l => l.key === mtState.lang) || {};
  const sample = d.sample || {};
  const limits = d.limits || {};

  let html = `<div class="toolbar" style="margin-bottom:16px">
    <div class="seg" id="mtPurposes">
      ${items.map(i => `<button data-v="${esc(i.key)}"
        class="${mtState.purpose === i.key ? 'active' : ''}">${esc(i.label)}
        ${(i.langs || []).some(l => l.is_custom) ? '<span class="badge warn">已自定义</span>' : ''}</button>`).join('')}
    </div>
    ${langs.length ? `<div class="seg" id="mtLangs">
      ${langs.map(l => `<button data-v="${esc(l.key)}"
        class="${mtState.lang === l.key ? 'active' : ''}">${esc(l.label)}
        ${l.default_lang ? '<span class="badge">默认</span>' : ''}</button>`).join('')}
    </div>` : ''}
    <div class="spacer" style="flex:1"></div>
    <span class="note">${esc(cur.audience || '')}</span>
  </div>`;

  if (!d.table_ok) {
    html += `<div class="err-box">
      注册库里还没有 <code>mail_templates</code> 表（006 迁移尚未应用），
      现在只能查看默认文案、<b>不能保存</b>。请先重启 <code>mmh-registration</code>
      容器让它跑迁移，再回来编辑。<br>
      <span class="note">注册库：<code>${esc(d.db_path)}</code></span>
    </div>`;
  }

  html += `<div class="grid c2">
    ${card('编辑模板', `
      <label class="field"><span>主题</span>
        <input type="text" id="mtSubject" value="${esc(curLang.subject || '')}"
               maxlength="${esc(limits.subject || 300)}"></label>
      <label class="field" style="margin-top:12px"><span>纯文本正文（HTML 客户端不可用时用它，不能为空）</span>
        <textarea id="mtText" style="min-height:200px">${esc(curLang.text || '')}</textarea></label>
      <label class="field" style="margin-top:12px"><span>HTML 正文（可留空 = 只发纯文本）</span>
        <textarea id="mtHtml" style="min-height:200px" spellcheck="false">${esc(curLang.html || '')}</textarea></label>
      <div class="note" style="margin-top:12px">
        可用占位符：${(d.placeholders || []).map(p =>
          `<code>{{${esc(p.name)}}}</code> ${esc(p.desc)}`).join(' · ')}<br>
        发送时由认证服务器替换；写错的占位符会原样发出去，预览里能看出来。
      </div>
      <div class="toolbar" style="margin-top:14px">
        <button class="primary" id="mtSave">保存</button>
        <button id="mtPreviewBtn">刷新预览</button>
        <button class="ghost" id="mtReset">恢复默认</button>
        <div class="spacer" style="flex:1"></div>
        <span class="note">${curLang.is_custom
          ? `已自定义${curLang.updated_at
              ? '（' + esc(String(curLang.updated_at).replace('T', ' ').slice(0, 16)) + ' UTC）' : ''}`
          : '当前用认证服务器内置默认文案'}</span>
      </div>`,
      curLang.is_custom ? '<span class="badge warn">已自定义</span>'
                        : '<span class="badge ok">默认</span>')}
    ${card('预览', `
      <div class="note" style="margin-bottom:10px">用样例值
        <code>${esc(sample.email || '')}</code> · <code>${esc(sample.code || '')}</code> ·
        <code>${esc(sample.expiresMinutes)}</code> 分钟渲染（不落库）。</div>
      <div class="note" style="margin-bottom:6px">主题</div>
      <div class="mail-body" id="mtPvSubject" style="max-height:none">—</div>
      <div class="note" style="margin:12px 0 6px">HTML 正文</div>
      <iframe class="mail-html" id="mtPvHtml" sandbox="" style="height:300px"></iframe>
      <div class="note" style="margin:12px 0 6px">纯文本正文</div>
      <div class="mail-body" id="mtPvText" style="max-height:260px">—</div>`)}
  </div>`;

  view.innerHTML = html;

  $('#mtPurposes').addEventListener('click', e => {
    const b = e.target.closest('button[data-v]');
    if (b) { mtState.purpose = b.dataset.v; route(); }
  });
  const langSeg = $('#mtLangs');
  if (langSeg) langSeg.addEventListener('click', e => {
    const b = e.target.closest('button[data-v]');
    if (b) { mtState.lang = b.dataset.v; route(); }
  });

  const schedulePreview = () => {
    clearTimeout(mtPreviewTimer);
    mtPreviewTimer = setTimeout(refreshMtPreview, 400);
  };
  ['#mtSubject', '#mtText', '#mtHtml'].forEach(sel => {
    const el = $(sel, view);
    if (el) el.addEventListener('input', schedulePreview);
  });

  $('#mtPreviewBtn').addEventListener('click', refreshMtPreview);

  $('#mtSave').addEventListener('click', async () => {
    const btn = $('#mtSave');
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      await api('POST', `/api/mail-templates/${encodeURIComponent(mtState.purpose)}/${encodeURIComponent(mtState.lang)}`, {
        subject: $('#mtSubject', view).value,
        text: $('#mtText', view).value,
        html: $('#mtHtml', view).value
      });
      toast('已保存，认证服务器下次发信即生效', 'ok');
      await route();
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false; btn.textContent = '保存';
    }
  });

  $('#mtReset').addEventListener('click', async () => {
    if (!curLang.is_custom) { toast('当前已是默认文案', ''); return; }
    const ok = await confirmDialog('恢复默认文案？',
      `将删除「${esc(cur.label || mtState.purpose)}」${esc(curLang.label || mtState.lang)}版的自定义文案，改回认证服务器内置的默认版本。`,
      '恢复默认', false);
    if (!ok) return;
    try {
      await api('POST', `/api/mail-templates/${encodeURIComponent(mtState.purpose)}/${encodeURIComponent(mtState.lang)}/reset`, {});
      toast('已恢复默认', 'ok');
      await route();
    } catch (err) { toast(err.message, 'err'); }
  });

  await refreshMtPreview();
}

async function refreshMtPreview() {
  const subj = $('#mtSubject'), text = $('#mtText'), html = $('#mtHtml');
  if (!subj || !text || !html) return;
  try {
    const r = await api('POST',
      `/api/mail-templates/${encodeURIComponent(mtState.purpose)}/${encodeURIComponent(mtState.lang)}/preview`,
      { subject: subj.value, text: text.value, html: html.value });
    const out = r.rendered || {};
    $('#mtPvSubject').textContent = out.subject || '(空主题)';
    $('#mtPvText').textContent = out.text || '(空正文)';
    const frame = $('#mtPvHtml');
    if (frame) {
      frame.srcdoc = out.html
        || '<p style="font-family:sans-serif;color:#888">（无 HTML 正文）</p>';
    }
  } catch (err) { toast(err.message, 'err'); }
}

/* =========================================================================
 * 认证服务管理端（验证码日志 / 健康与配置 / 发测试邮件）
 * ========================================================================= */
let regadmState = { purpose: '', q: '', offset: 0, limit: 100 };

async function renderRegAdmin(view) {
  const info = await api('GET', '/api/regadmin/info');
  const q = new URLSearchParams();
  if (regadmState.purpose) q.set('purpose', regadmState.purpose);
  if (regadmState.q) q.set('email', regadmState.q);
  q.set('offset', regadmState.offset);
  q.set('limit', regadmState.limit);
  const codes = await api('GET', `/api/regadmin/codes?${q.toString()}`);

  let html = '';

  // ---- 服务健康 / 配置 ----
  html += `<div class="grid c4" style="margin-bottom:16px">`;
  if (info.configured) {
    const mail = info.mail || {};
    const policy = info.policy || {};
    html += metric('服务', esc(info.service || 'mmh-registration'), '认证服务运行中', 'accent');
    html += metric('邮件通道', mail.configured ? '已配置' : '未配置',
      `SMTP ${esc(mail.host || '—')}:${esc(mail.port != null ? mail.port : '—')}`, mail.configured ? 'ok' : '');
    html += metric('验证码策略', `TTL ${esc(policy.codeTtlMinutes)}分`,
      `尝试 ${esc(policy.codeMaxAttempts)}次 / 小时 ${esc(policy.codeMaxSendsPerHour)}封`);
    const t = info.templates || {};
    const dl = t.defaultLang || {};
    html += metric('模板语言', `zh / en`, `registration→${esc(dl.registration || 'en')} · 重置→${esc(dl['password-reset'] || 'zh')}`);
  } else {
    html += metric('服务', '未配置', esc(info.note || '缺少 REGISTRATION_API_TOKEN'), '');
    html += metric('邮件通道', '—', '—', '');
    html += metric('验证码策略', '—', '—', '');
    html += metric('模板语言', '—', '—', '');
  }
  html += `</div>`;

  // ---- 发测试邮件 ----
  html += `<div style="margin-bottom:16px">
    <div class="card">
      <div class="row" style="gap:10px;align-items:end;flex-wrap:wrap">
        <div>
          <label class="lbl">用途</label>
          <select id="rgPurpose">
            <option value="registration">注册 (registration)</option>
            <option value="password-reset">重置密码 (password-reset)</option>
          </select>
        </div>
        <div>
          <label class="lbl">语言</label>
          <select id="rgLang">
            <option value="">（默认）</option>
            <option value="zh">中文</option>
            <option value="en">English</option>
          </select>
        </div>
        <div style="flex:1;min-width:220px">
          <label class="lbl">收件邮箱</label>
          <input type="email" id="rgTo" placeholder="test@example.com" style="width:100%">
        </div>
        <button class="primary" id="rgSend">发送测试邮件</button>
      </div>
      <div id="rgSendResult" class="sub" style="margin-top:8px"></div>
    </div>
  </div>`;

  // ---- 最近一小时统计 ----
  const lh = codes.last_hour || {};
  html += `<div class="grid c2" style="margin-bottom:16px">
    ${metric('近1小时 注册验证码', esc(lh.registration || 0), '发送条数')}
    ${metric('近1小时 重置密码验证码', esc(lh['password-reset'] || 0), '发送条数')}
  </div>`;

  // ---- 验证码日志 ----
  html += `<div class="card">
    <div class="row" style="gap:8px;margin-bottom:10px;flex-wrap:wrap">
      <select id="rgFilterPurpose">
        <option value="">全部用途</option>
        <option value="registration">注册</option>
        <option value="password-reset">重置密码</option>
      </select>
      <input type="search" id="rgFilterEmail" placeholder="按邮箱过滤" value="${esc(regadmState.q)}" style="max-width:220px">
      <button class="ghost sm" id="rgApply">筛选</button>
      <span class="spacer"></span>
      <span class="sub">共 ${esc(codes.total)} 条</span>
    </div>
    <table class="tbl">
      <thead><tr>
        <th>邮箱</th><th>用途</th><th>发送时间</th><th>过期</th><th>状态</th><th>尝试</th>
      </tr></thead>
      <tbody>
        ${(codes.items || []).map(c => `
          <tr>
            <td>${esc(c.email)}</td>
            <td>${esc(c.purpose === 'registration' ? '注册' : '重置密码')}</td>
            <td>${esc(c.created_at || '')}</td>
            <td>${esc(c.expires_at || '')}</td>
            <td>${c.used
              ? '<span class="badge ok">已使用</span>'
              : (c.expires_at && c.expires_at < new Date().toISOString() ? '<span class="badge">已过期</span>' : '<span class="badge ok">未使用</span>')}</td>
            <td>${esc(c.attempts)}</td>
          </tr>`).join('') || '<tr><td colspan="6" class="empty">暂无验证码记录</td></tr>'}
      </tbody>
    </table>
    <div class="row" style="gap:8px;margin-top:10px">
      <button class="ghost sm" id="rgPrev" ${codes.offset <= 0 ? 'disabled' : ''}>上一页</button>
      <span class="sub">第 ${Math.floor(codes.offset / codes.limit) + 1} 页</span>
      <button class="ghost sm" id="rgNext" ${codes.offset + codes.limit < codes.total ? '' : 'disabled'}>下一页</button>
      <span class="spacer"></span>
      <span class="sub">验证码仅存哈希，无法在此查看明文</span>
    </div>
  </div>`;

  view.innerHTML = html;

  $('#rgFilterPurpose').value = regadmState.purpose;
  $('#rgSend').addEventListener('click', async () => {
    const to = $('#rgTo').value.trim();
    const purpose = $('#rgPurpose').value;
    const lang = $('#rgLang').value;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) { toast('请输入有效邮箱', 'err'); return; }
    const btn = $('#rgSend');
    btn.disabled = true; btn.textContent = '发送中…';
    try {
      await api('POST', '/api/regadmin/test-mail', { to, purpose, lang: lang || undefined });
      $('#rgSendResult').textContent = '已通过认证服务真实通道发送，请检查收件箱 / 垃圾箱。';
      toast('测试邮件已发送');
    } catch (err) { toast(err.message, 'err'); }
    finally { btn.disabled = false; btn.textContent = '发送测试邮件'; }
  });
  $('#rgApply').addEventListener('click', () => {
    regadmState.purpose = $('#rgFilterPurpose').value;
    regadmState.q = $('#rgFilterEmail').value.trim();
    regadmState.offset = 0;
    renderRegAdmin(view);
  });
  $('#rgPrev').addEventListener('click', () => {
    regadmState.offset = Math.max(0, regadmState.offset - regadmState.limit);
    renderRegAdmin(view);
  });
  $('#rgNext').addEventListener('click', () => {
    regadmState.offset += regadmState.limit;
    renderRegAdmin(view);
  });
}

/* =========================================================================
 * Issue 盯盘
 * ========================================================================= */
let issState = { state: 'open', kind: 'issue', q: '' };

async function renderIssues(view) {
  const repo = await api('GET', '/api/issues/repo');
  const list = await api('GET',
    `/api/issues/list?state=${issState.state}&kind=${issState.kind}&q=${encodeURIComponent(issState.q)}&limit=50`);

  const tk = repo.token || {};
  let html = `<div class="grid c4" style="margin-bottom:16px">
    ${metric('仓库', repo.full_name || '—', esc(repo.description || '').slice(0, 60), 'accent')}
    ${metric('未关闭', repo.open_issues, `含 PR`, '')}
    ${metric('Star / Fork', `${repo.stars || 0} / ${repo.forks || 0}`,
             `默认分支 ${esc(repo.default_branch || '')}`)}
    ${metric('API 配额', `${repo.rate_remaining || '?'} / ${repo.rate_limit || '?'}`,
             tk.present ? `凭据 ${esc(tk.kind)}` : '<span class="err">未配置 token</span>',
             tk.present ? 'ok' : 'danger')}
  </div>`;

  if (!tk.present) {
    html += `<div class="err-box">
      未找到 GitHub token 文件 <code>${esc(tk.path)}</code>，只读查询可能仍可用，
      但<b>评论 / 关闭 / 打标签都会失败</b>。请把 token 写入该文件并 <code>chmod 600</code>。
    </div>`;
  }

  html += card('Issue / PR', `
    <div class="toolbar" style="margin-bottom:12px">
      <div class="seg" id="issState">
        ${[['open', '未关闭'], ['closed', '已关闭'], ['all', '全部']].map(([v, l]) =>
          `<button data-v="${v}" class="${issState.state === v ? 'active' : ''}">${l}</button>`).join('')}
      </div>
      <div class="seg" id="issKind">
        ${[['issue', 'Issue'], ['pr', 'PR'], ['all', '全部']].map(([v, l]) =>
          `<button data-v="${v}" class="${issState.kind === v ? 'active' : ''}">${l}</button>`).join('')}
      </div>
      <div class="grow"><input type="search" id="issQ" placeholder="搜索标题 / 正文关键词"
             value="${esc(issState.q)}"></div>
      <button id="issSearch" class="primary">搜索</button>
    </div>
    ${list.items.length ? `<div class="scroll-x"><table>
      <thead><tr><th>#</th><th>标题</th><th>作者</th><th>标签</th>
        <th class="num">评论</th><th>更新</th><th></th></tr></thead>
      <tbody>${list.items.map(i => `<tr>
        <td class="mono">${i.is_pr ? 'PR ' : ''}${i.number}</td>
        <td>${esc(i.title)}${i.draft ? ' <span class="badge">草稿</span>' : ''}</td>
        <td>${esc(i.user || '—')}</td>
        <td>${(i.labels || []).map(l =>
            `<span class="label-chip" style="background:#${esc(l.color)}22;border-color:#${esc(l.color)}55">${esc(l.name)}</span>`).join('') || '—'}</td>
        <td class="num">${i.comments}</td>
        <td class="note">${esc(ago(Math.floor(new Date(i.updated_at).getTime() / 1000)))}</td>
        <td><button class="sm" onclick="openIssue(${i.number})">打开</button></td>
      </tr>`).join('')}</tbody></table></div>`
      : '<div class="empty">没有匹配的条目</div>'}`,
    list.total !== undefined ? `搜索命中 ${list.total} 条` : '', true);

  view.innerHTML = html;

  const rerun = () => { issState.q = $('#issQ').value.trim(); route(); };
  $('#issSearch').addEventListener('click', rerun);
  $('#issQ').addEventListener('keydown', e => { if (e.key === 'Enter') rerun(); });
  $('#issState').addEventListener('click', e => {
    const b = e.target.closest('button[data-v]');
    if (b) { issState.state = b.dataset.v; route(); }
  });
  $('#issKind').addEventListener('click', e => {
    const b = e.target.closest('button[data-v]');
    if (b) { issState.kind = b.dataset.v; route(); }
  });
}

async function openIssue(num) {
  const host = $('#modalHost');
  const mask = document.createElement('div');
  mask.className = 'mask';
  mask.innerHTML = `<div class="modal" style="max-width:860px">
      <header>加载中… <span class="spin"></span></header>
      <div class="body"><div class="empty">正在读取 #${num}</div></div>
    </div>`;
  host.appendChild(mask);
  const close = () => mask.remove();
  mask.addEventListener('click', e => { if (e.target === mask) close(); });

  let d, labels = [];
  try {
    d = await api('GET', `/api/issues/${num}`);
    try { labels = (await api('GET', '/api/issues/labels')).items; } catch (e) { labels = []; }
  } catch (e) {
    mask.remove();
    toast(e.message, 'err');
    return;
  }

  const open = d.state === 'open';
  const labelChips = (d.labels || []).map(l =>
    `<span class="label-chip" style="background:#${esc(l.color)}22;border-color:#${esc(l.color)}55">${esc(l.name)}</span>`).join('');

  mask.innerHTML = `<div class="modal" style="max-width:860px">
    <header>
      <span class="badge ${open ? 'ok' : ''}">${open ? '未关闭' : '已关闭'}</span>
      <span style="flex:1">#${d.number} ${esc(d.title)}</span>
      <a class="btn sm" href="${esc(d.html_url)}" target="_blank" rel="noopener">GitHub ↗</a>
      <button class="ghost sm" data-close>关闭</button>
    </header>
    <div class="body">
      <div class="note" style="margin-bottom:12px">
        ${esc(d.user || '—')} 创建于 ${esc((d.created_at || '').replace('T', ' ').slice(0, 16))}
        · 更新 ${esc((d.updated_at || '').replace('T', ' ').slice(0, 16))}
        ${d.is_pr ? ' · <span class="badge">PR</span>' : ''}
      </div>
      <div class="mail-body" style="max-height:260px">${esc(d.body || '(无正文)')}</div>

      <h3 style="font-size:13px;margin:18px 0 8px">评论（${(d.comments_list || []).length}）</h3>
      ${(d.comments_list || []).map(c => `
        <div style="border:1px solid var(--border);border-radius:8px;margin-bottom:10px;overflow:hidden">
          <div class="note" style="padding:7px 12px;background:var(--panel-2);border-bottom:1px solid var(--border)">
            <strong>${esc(c.user)}</strong> · ${esc((c.created_at || '').replace('T', ' ').slice(0, 16))}
            ${c.author_association && c.author_association !== 'NONE'
              ? `<span class="badge accent">${esc(c.author_association)}</span>` : ''}
          </div>
          <div style="padding:11px 12px;white-space:pre-wrap;font-size:13px;line-height:1.6">${esc(c.body || '')}</div>
        </div>`).join('') || '<div class="note">暂无评论</div>'}

      <h3 style="font-size:13px;margin:18px 0 8px">发表评论</h3>
      <textarea id="issComment" style="min-height:120px" placeholder="支持 Markdown…"></textarea>
      <div style="margin-top:10px"><button class="primary" id="issCommentBtn">发表评论</button></div>

      <hr class="sep">
      <h3 style="font-size:13px;margin:0 0 8px">标签</h3>
      <div class="chip-row" style="margin-bottom:10px">${labelChips || '<span class="note">无</span>'}</div>
      <div class="toolbar">
        <select id="issLabelSel" style="max-width:220px">
          <option value="">— 选择标签 —</option>
          ${labels.map(l => `<option value="${esc(l.name)}">${esc(l.name)}</option>`).join('')}
        </select>
        <button id="issLabelAdd">添加</button>
        <button id="issLabelDel" class="danger">移除所选</button>
      </div>
    </div>
    <footer>
      <button class="${open ? 'danger' : 'primary'}" id="issToggleState">
        ${open ? '关闭 Issue' : '重新打开'}
      </button>
    </footer>
  </div>`;

  mask.addEventListener('click', e => { if (e.target.hasAttribute('data-close')) close(); });

  $('#issCommentBtn', mask).addEventListener('click', async () => {
    const body = $('#issComment', mask).value.trim();
    if (!body) { toast('评论内容不能为空', 'err'); return; }
    const btn = $('#issCommentBtn', mask);
    btn.disabled = true; btn.textContent = '提交中…';
    try {
      await api('POST', `/api/issues/${num}/comment`, { body });
      toast('评论已发表', 'ok');
      close(); openIssue(num); route();
    } catch (e) {
      toast(e.message, 'err');
      btn.disabled = false; btn.textContent = '发表评论';
    }
  });

  $('#issToggleState', mask).addEventListener('click', async () => {
    const target = open ? 'closed' : 'open';
    if (target === 'closed') {
      const ok = await confirmDialog('确认关闭该 Issue？', '关闭后仍可重新打开。', '关闭', false);
      if (!ok) return;
    }
    try {
      await api('POST', `/api/issues/${num}/state`,
        { state: target, state_reason: target === 'closed' ? 'completed' : undefined });
      toast(target === 'closed' ? '已关闭' : '已重新打开', 'ok');
      close(); openIssue(num); route();
    } catch (e) { toast(e.message, 'err'); }
  });

  $('#issLabelAdd', mask).addEventListener('click', async () => {
    const name = $('#issLabelSel', mask).value;
    if (!name) { toast('请先选择标签', 'err'); return; }
    try {
      await api('POST', `/api/issues/${num}/labels`, { add: [name] });
      toast('已添加标签 ' + name, 'ok');
      close(); openIssue(num); route();
    } catch (e) { toast(e.message, 'err'); }
  });

  $('#issLabelDel', mask).addEventListener('click', async () => {
    const name = $('#issLabelSel', mask).value;
    if (!name) { toast('请先选择标签', 'err'); return; }
    try {
      await api('POST', `/api/issues/${num}/labels`, { remove: [name] });
      toast('已移除标签 ' + name, 'ok');
      close(); openIssue(num); route();
    } catch (e) { toast(e.message, 'err'); }
  });
}

window.openIssue = openIssue;

/* =========================================================================
 * 审计
 * ========================================================================= */
async function renderAudit(view) {
  const d = await api('GET', '/api/audit?limit=300');
  view.innerHTML = card('操作审计', d.items.length ? `<div class="scroll"><table>
    <thead><tr><th>时间</th><th>操作</th><th>来源 IP</th><th>结果</th><th>详情</th></tr></thead>
    <tbody>${d.items.map(r => `<tr>
      <td class="mono">${esc(r.ts ? fmtTime(r.ts) : r.time)}</td>
      <td><code>${esc(r.action)}</code></td>
      <td class="mono">${esc(r.ip)}</td>
      <td>${r.ok ? '<span class="badge ok">成功</span>' : '<span class="badge danger">失败</span>'}</td>
      <td class="mono note" style="max-width:520px;word-break:break-all">${esc(JSON.stringify(r.detail))}</td>
    </tr>`).join('')}</tbody></table></div>`
    : '<div class="empty">还没有任何操作记录</div>',
    `最近 ${d.items.length} 条`, true);
}

/* =========================================================================
 * 设置
 * ========================================================================= */
async function renderSettings(view) {
  const d = await api('GET', '/api/settings');
  const a = d.auth || {};
  const e = d.env || {};

  const authRows = [
    ['口令来源', a.source_label],
    ['上次修改', a.changed_at
      ? `${fmtTime(a.changed_at)}（${ago(a.changed_at)}）` : '未通过 UI 改过'],
    ['会话有效期', `${Math.round((a.session_ttl || 0) / 86400)} 天`],
    ['新口令长度', `${a.token_min} – ${a.token_max} 位`],
    ['cookie 名', a.cookie_name],
    ['口令文件', a.token_path],
    ['签名盐', a.session_key_path],
  ];

  const envRows = [
    ['版本', `${e.app} v${e.version}`],
    ['监听', e.bind],
    ['数据目录', e.data_dir],
    ['下载统计库', e.stats_db_dir],
    ['自动注册库', e.reg_db],
    ['邮件根目录', e.vmail_root],
    ['盯的信箱', (e.mail_accounts || []).join('、') || '（自动发现）'],
    ['回复发件人', e.mail_from],
    ['SMTP', e.smtp],
    ['GitHub 仓库', e.github_repo],
    ['仓库白名单', (e.github_allowed_repos || []).join('、')],
    ['GitHub token', e.github_token_file],
  ];

  // 注意：不要用 .kv —— 那是邮件面板的 dt/dd 网格，会把 <table> 变成 grid
  const kv = rows => `<table class="kvtable">${rows.map(([k, v]) =>
    `<tr><th>${esc(k)}</th><td class="mono">${esc(v)}</td></tr>`).join('')}</table>`;

  const recover = a.has_env_fallback
    ? `<div class="note" style="margin-top:12px">忘记口令时：删掉 <code>${esc(a.token_path)}</code>，再重启容器（<code>docker compose restart mmh-admin</code>），即回落到 .env 里的 ADMIN_TOKEN。</div>`
    : `<div class="note" style="margin-top:12px">当前没有 .env 兜底口令。忘记就只能删掉 <code>${esc(a.token_path)}</code> 并给容器补一个 ADMIN_TOKEN 再重启。</div>`;

  // ---- 时区 ----
  const z = d.tz || {};
  const presets = z.presets || [];
  const isPreset = presets.some(p => p.spec === z.spec);
  const tzRows = [
    // 缺 tzdata 时 abbr 就是偏移串本身，别显示成 "UTC+08:00 UTC+08:00"
    ['当前时区', `${z.spec}（${z.offset}${z.abbr && z.abbr !== z.offset ? ' ' + z.abbr : ''}）`],
    ['现在', z.now],
    ['来源', z.source_label],
  ];
  const tzCard = `${kv(tzRows)}
    ${z.error ? `<div class="err-box" style="margin-top:10px">${esc(z.error)}</div>` : ''}
    ${z.note ? `<div class="note" style="margin-top:10px">⚠️ ${esc(z.note)}</div>` : ''}
    <form id="tzForm" autocomplete="off" style="margin-top:12px">
      <label class="field"><span>时区</span>
        <select id="tzSelect">
          ${presets.map(p => `<option value="${esc(p.spec)}"${p.spec === z.spec ? ' selected' : ''}>${esc(p.label)} — ${esc(p.spec)}</option>`).join('')}
          <option value="__custom__"${isPreset ? '' : ' selected'}>自定义…</option>
        </select></label>
      <label class="field" id="tzCustomWrap" style="margin-top:12px"${isPreset ? ' hidden' : ''}>
        <span>自定义（IANA 名，或固定偏移）</span>
        <input type="text" id="tzCustom" placeholder="Asia/Shanghai 或 UTC+8"
               value="${esc(isPreset ? '' : z.spec)}"></label>
      <div class="note" style="margin-top:12px">
        影响审计时间、服务日志、概览「数据生成于」、邮件 Date 头，以及页面上所有时间。
        保存后立即生效，不用重启。下载明细的时间写死 CST（与 fnstore 页面口径一致），不跟着变。
      </div>
      <div class="toolbar" style="margin-top:12px">
        <button type="submit" class="primary" id="tzBtn">保存时区</button>
        <button type="button" class="ghost" id="tzReset">恢复默认</button>
      </div>
    </form>`;

  view.innerHTML = `<div class="grid c2">
    ${card('时区', tzCard)}
    ${card('口令状态', kv(authRows) + recover)}
    ${card('修改口令', `<form id="pwForm" autocomplete="off">
      <div class="pw-grid">
        <label class="field"><span>当前口令</span>
          <input type="password" name="current" autocomplete="current-password" required></label>
        <label class="field"><span>新口令</span>
          <input type="password" name="new" autocomplete="new-password" required></label>
        <label class="field"><span>确认新口令</span>
          <input type="password" name="confirm" autocomplete="new-password" required></label>
      </div>
      <div class="note" style="margin-top:12px">
        ${a.token_min}–${a.token_max} 位，首尾与中间都不能有空白字符。
        改完之后所有已登录设备立即掉线（本机自动续上新票，不受影响）。
      </div>
      <div class="toolbar" style="margin-top:12px">
        <button type="submit" class="primary" id="pwBtn">修改口令</button>
        <button type="button" class="ghost" id="pwClear">清空</button>
      </div>
    </form>`)}
  </div>
  <div style="margin-top:14px">${card('服务信息', kv(envRows), '', true)}</div>`;

  // ---- 时区表单 ----
  const tzSel = $('#tzSelect', view);
  const tzWrap = $('#tzCustomWrap', view);
  tzSel.addEventListener('change', () => { tzWrap.hidden = tzSel.value !== '__custom__'; });
  const saveTz = async (body, label) => {
    const btn = $('#tzBtn', view);
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      const r = await api('POST', '/api/settings/timezone', body);
      if (r && r.tz) applyTz(r.tz);
      toast(`${label}：${r.tz.spec}`, 'ok');
      await route();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false; btn.textContent = '保存时区';
    }
  };
  $('#tzReset', view).addEventListener('click', () => saveTz({ reset: true }, '已恢复默认时区'));
  $('#tzForm', view).addEventListener('submit', ev => {
    ev.preventDefault();
    const spec = tzSel.value === '__custom__'
      ? $('#tzCustom', view).value.trim() : tzSel.value;
    if (!spec) { toast('请填写时区', 'err'); return; }
    saveTz({ spec }, '时区已改为');
  });

  const form = $('#pwForm', view);
  $('#pwClear', view).addEventListener('click', () => form.reset());
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    const fd = new FormData(form);
    const cur = fd.get('current'), nw = fd.get('new'), cf = fd.get('confirm');
    if (nw !== cf) { toast('两次输入的新口令不一致', 'err'); return; }
    const btn = $('#pwBtn', view);
    btn.disabled = true; btn.textContent = '提交中…';
    try {
      await api('POST', '/api/settings/password', { current: cur, new: nw, confirm: cf });
      form.reset();
      toast('口令已修改，旧会话已全部失效', 'ok');
      await route();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false; btn.textContent = '修改口令';
    }
  });
}

/* ---------------------------------------------------------------- 启动 */
boot();
