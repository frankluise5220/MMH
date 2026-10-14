/**
 * 配置页 —— 自包含单页（内联 CSS/JS，零外部资源，无构建步骤）。
 *
 * 为什么不用框架：这个服务刻意保持「零依赖、零编译」，页面也照此办理 ——
 * 群晖上不需要 npm 装任何东西就能改 UI。
 *
 * 注意：本文件用模板字符串承载整页 HTML，因此**客户端 JS 里不使用反引号**，
 * 一律用引号 + 字符串拼接，避免与外层模板冲突。
 */

export function renderPage(options = {}) {
  const logout = options.authEnabled
    ? '<a class="pill" href="/logout" style="text-decoration:none;color:var(--muted)">退出</a>'
    : "";
  const defaultPasswordWarning = options.usingDefaultPassword
    ? '<div class="msg warn" style="display:block">当前仍在使用<b>初始密码</b>，' +
      '请到「配置 → 访问控制」改成自己的密码 —— 改完所有已登录的浏览器会被登出。</div>'
    : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MMH Bug Harness</title>
<style>
  :root{
    --bg:#f6f7f9; --panel:#fff; --panel2:#fbfcfd; --border:#e3e6ea; --border2:#eef1f4;
    --text:#1f2328; --muted:#6b7280; --faint:#9aa4b2;
    --accent:#2563eb; --accent-soft:#eff4ff;
    --ok:#15803d; --ok-soft:#ecfdf3; --warn:#b45309; --warn-soft:#fffbeb;
    --err:#b91c1c; --err-soft:#fef2f2;
    --radius:8px; --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);
    font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;}
  a{color:var(--accent);text-decoration:none}
  header{background:var(--panel);border-bottom:1px solid var(--border);padding:12px 20px;
    display:flex;align-items:center;gap:16px;flex-wrap:wrap;position:sticky;top:0;z-index:10}
  h1{font-size:15px;margin:0;font-weight:650;letter-spacing:.2px}
  h1 small{font-weight:400;color:var(--faint);margin-left:8px;font-size:12px}
  .pills{display:flex;gap:8px;flex-wrap:wrap;margin-left:auto;align-items:center}
  .pill{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;
    border:1px solid var(--border);background:var(--panel2);color:var(--muted);font-size:12px;white-space:nowrap}
  .pill b{color:var(--text);font-weight:600}
  .dot{width:7px;height:7px;border-radius:50%;background:var(--faint);flex:none}
  .dot.ok{background:var(--ok)} .dot.warn{background:var(--warn)} .dot.err{background:var(--err)}
  nav{display:flex;gap:2px;padding:0 20px;background:var(--panel);border-bottom:1px solid var(--border);
    position:sticky;top:53px;z-index:9}
  nav button{appearance:none;border:0;background:none;padding:9px 14px;font-size:13px;color:var(--muted);
    cursor:pointer;border-bottom:2px solid transparent;font-weight:500}
  nav button:hover{color:var(--text)}
  nav button.on{color:var(--accent);border-bottom-color:var(--accent);font-weight:600}
  main{padding:18px 20px 60px;max-width:1080px;margin:0 auto}
  section{display:none} section.on{display:block}
  .card{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:14px;overflow:hidden}
  .card>h2{margin:0;font-size:13px;font-weight:650;padding:11px 14px;border-bottom:1px solid var(--border2);
    display:flex;align-items:center;gap:8px;background:var(--panel2)}
  .card>h2 .desc{font-weight:400;color:var(--faint);font-size:12px}
  .card>h2 .right{margin-left:auto;display:flex;gap:8px;align-items:center}
  .body{padding:4px 14px 12px}
  .row{display:grid;grid-template-columns:210px 1fr;gap:12px;padding:9px 0;border-bottom:1px dashed var(--border2);align-items:start}
  .row:last-child{border-bottom:0}
  .row>label{padding-top:4px}
  .row .lbl{font-weight:550}
  .row .hint{color:var(--faint);font-size:11.5px;margin-top:3px;line-height:1.45}
  input[type=text],input[type=password],input[type=number],select{
    width:100%;padding:6px 9px;border:1px solid var(--border);border-radius:6px;background:#fff;
    font-size:13px;font-family:inherit;color:var(--text)}
  input:focus,select:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
  input[type=checkbox]{width:15px;height:15px;accent-color:var(--accent);margin-top:3px}
  .src{display:inline-block;font-size:11px;padding:1px 6px;border-radius:4px;margin-left:6px;
    border:1px solid var(--border);color:var(--faint);background:var(--panel2);font-weight:400}
  .src.config{color:var(--accent);border-color:#c7d7fe;background:var(--accent-soft)}
  .src.env,.src.file{color:var(--warn);border-color:#fde68a;background:var(--warn-soft)}
  .btn{appearance:none;border:1px solid var(--border);background:#fff;color:var(--text);
    padding:5px 11px;border-radius:6px;font-size:12.5px;cursor:pointer;font-family:inherit;font-weight:500}
  .btn:hover{background:var(--panel2)}
  .btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
  .btn.primary:hover{filter:brightness(1.06)}
  .btn.danger{color:var(--err);border-color:#fecaca}
  .btn:disabled{opacity:.5;cursor:not-allowed}
  .btn.sm{padding:3px 8px;font-size:11.5px}
  .bar{display:flex;gap:10px;align-items:center;position:sticky;bottom:0;background:var(--panel);
    border:1px solid var(--border);border-radius:var(--radius);padding:10px 14px;margin-top:4px;
    box-shadow:0 -2px 12px rgba(16,24,40,.05)}
  .bar .grow{flex:1;color:var(--muted);font-size:12.5px}
  .msg{padding:8px 11px;border-radius:6px;font-size:12.5px;margin:8px 0;white-space:pre-wrap;display:none}
  .msg.ok{display:block;background:var(--ok-soft);color:var(--ok);border:1px solid #bbf7d0}
  .msg.err{display:block;background:var(--err-soft);color:var(--err);border:1px solid #fecaca}
  .msg.warn{display:block;background:var(--warn-soft);color:var(--warn);border:1px solid #fde68a}
  .stats{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}
  .stat{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:10px 14px;min-width:104px}
  .stat .n{font-size:19px;font-weight:650;line-height:1.2}
  .stat .k{color:var(--faint);font-size:11.5px;margin-top:2px}
  table{width:100%;border-collapse:collapse;font-size:12.5px}
  th{text-align:left;color:var(--faint);font-weight:550;padding:7px 10px;border-bottom:1px solid var(--border2);
    font-size:11.5px;background:var(--panel2)}
  td{padding:7px 10px;border-bottom:1px solid var(--border2);vertical-align:top}
  tbody tr:hover{background:var(--panel2);cursor:pointer}
  .tag{display:inline-block;font-size:11px;padding:1px 6px;border-radius:4px;border:1px solid var(--border);
    background:var(--panel2);color:var(--muted);white-space:nowrap}
  .tag.high{color:var(--err);border-color:#fecaca;background:var(--err-soft)}
  .tag.medium{color:var(--warn);border-color:#fde68a;background:var(--warn-soft)}
  .tag.low{color:var(--muted)}
  .tag.pending{color:var(--accent);border-color:#c7d7fe;background:var(--accent-soft)}
  .tag.claimed{color:var(--warn);border-color:#fde68a;background:var(--warn-soft)}
  .tag.done{color:var(--ok);border-color:#bbf7d0;background:var(--ok-soft)}
  pre{margin:0;background:#0f172a;color:#e2e8f0;padding:12px 14px;border-radius:6px;overflow:auto;
    font-family:var(--mono);font-size:12px;line-height:1.6;max-height:460px}
  pre.light{background:var(--panel2);color:var(--text);border:1px solid var(--border)}
  .empty{color:var(--faint);padding:22px;text-align:center;font-size:12.5px}
  .detail{position:fixed;inset:0;background:rgba(15,23,42,.42);z-index:50;display:none;overflow:auto;padding:28px 16px}
  .detail.on{display:block}
  .detail .inner{background:var(--panel);border-radius:10px;max-width:900px;margin:0 auto;overflow:hidden}
  .detail .hd{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--panel)}
  .detail .hd h3{margin:0;font-size:14px;font-weight:650;flex:1}
  .detail .bd{padding:14px 16px}
  .thumbs{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}
  .thumbs img{max-width:190px;border:1px solid var(--border);border-radius:6px;display:block}
  .kv{display:grid;grid-template-columns:110px 1fr;gap:4px 12px;font-size:12.5px;margin-bottom:12px}
  .kv .k{color:var(--faint)}
  .mono{font-family:var(--mono);font-size:12px}
  .flex{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  @media(max-width:720px){.row{grid-template-columns:1fr}.kv{grid-template-columns:1fr}}
</style>
</head>
<body>
<header>
  <h1>MMH Bug Harness<small>issue + 反馈邮件 → 规范化修复任务</small></h1>
  <div class="pills" id="pills"><span class="pill"><span class="dot"></span>加载中…</span></div>
  ${logout}
</header>
<nav>
  <button data-tab="config" class="on">配置</button>
  <button data-tab="tasks">任务看板</button>
  <button data-tab="ops">运维</button>
</nav>
<main>
  ${defaultPasswordWarning}
  <section id="tab-config" class="on">
    <div id="config-mount"></div>
    <div class="bar">
      <span class="grow" id="save-hint">修改后点保存；空值 = 清除该键的页面覆盖，回落到环境变量或默认值</span>
      <button class="btn" id="btn-reload">放弃修改</button>
      <button class="btn primary" id="btn-save">保存配置</button>
    </div>
    <div class="msg" id="save-msg"></div>
  </section>

  <section id="tab-tasks">
    <div class="stats" id="task-stats"></div>
    <div class="card">
      <h2>任务列表 <span class="desc">点任意一行查看完整任务规格</span>
        <span class="right"><button class="btn sm" id="btn-tasks-refresh">刷新</button></span>
      </h2>
      <div id="task-table"></div>
    </div>
  </section>

  <section id="tab-ops">
    <div class="card">
      <h2>运行状态</h2>
      <div class="body"><div class="kv" id="ops-status"></div></div>
    </div>
    <div class="card">
      <h2>操作
        <span class="right">
          <button class="btn primary" id="btn-rescan">立即扫描一轮</button>
          <button class="btn" id="btn-dryrun-hint">演练模式说明</button>
        </span>
      </h2>
      <div class="body"><div class="msg" id="ops-msg"></div>
        <div style="color:var(--muted);font-size:12.5px">
          扫描为异步执行：点完按钮后看下面日志里的「开始一轮扫描 / 本轮结束」。
          常驻进程默认每 5 分钟自动扫一轮（可在配置页调整）。
        </div>
      </div>
    </div>
    <div class="card">
      <h2>最近日志 <span class="desc">内存环形缓冲，最多 500 行</span>
        <span class="right">
          <label class="flex" style="color:var(--muted);font-size:12px;cursor:pointer">
            <input type="checkbox" id="log-auto" checked style="width:13px;height:13px"> 自动刷新
          </label>
          <button class="btn sm" id="btn-log-refresh">刷新</button>
        </span>
      </h2>
      <div class="body"><pre id="log-box">（加载中…）</pre></div>
    </div>
  </section>
</main>

<div class="detail" id="detail"><div class="inner">
  <div class="hd"><h3 id="detail-title">任务详情</h3><button class="btn sm" id="detail-close">关闭</button></div>
  <div class="bd" id="detail-body"></div>
</div></div>

<script>
(function(){
  "use strict";
  var S = { config:null, tasks:null, changed:{}, tab:"config", logTimer:null, statusTimer:null };

  function q(id){ return document.getElementById(id); }
  function esc(s){
    return String(s===undefined||s===null?"":s)
      .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
      .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
  }
  function api(path, opts){
    opts = opts || {};
    if(opts.body && typeof opts.body !== "string"){ opts.body = JSON.stringify(opts.body); opts.headers = Object.assign({"content-type":"application/json"}, opts.headers||{}); }
    return fetch(path, opts).then(function(r){
      // 会话过期 / 改过密码 → 直接回登录页，不弹错误信息
      if(r.status === 401){ location.href = "/login"; return new Promise(function(){}); }
      return r.json().catch(function(){ return {ok:false,error:"响应不是 JSON（HTTP "+r.status+"）"}; })
        .then(function(data){ if(!r.ok && data.ok===undefined) data.ok=false; return data; });
    });
  }
  function msg(el, kind, text){ el.className = "msg " + kind; el.textContent = text; }
  function clearMsg(el){ el.className = "msg"; el.textContent = ""; }
  function fmtTime(iso){ if(!iso) return "—"; try{ return new Date(iso).toLocaleString("zh-CN",{hour12:false}); }catch(e){ return iso; } }

  /* ---------------- 顶部状态 ---------------- */
  function loadStatus(){
    return api("/api/status").then(function(d){
      var counts = d.counts || {};
      var ok = d.lastCycleError ? "err" : "ok";
      var html = "";
      html += '<span class="pill"><span class="dot '+ok+'"></span>服务 <b>'+(d.lastCycleError?"异常":"正常")+'</b></span>';
      html += '<span class="pill">GitHub 轮询 <b>'+esc(fmtTime(d.lastGithubPollAt))+'</b></span>';
      html += '<span class="pill">邮件轮询 <b>'+esc(fmtTime(d.lastImapPollAt))+'</b></span>';
      html += '<span class="pill">待处理 <b>'+(counts.pending||0)+'</b></span>';
      html += '<span class="pill">已完成 <b>'+(counts.done||0)+'</b></span>';
      if(d.dryRun) html += '<span class="pill"><span class="dot warn"></span>演练模式</span>';
      q("pills").innerHTML = html;
      renderOpsStatus(d);
    }).catch(function(){ q("pills").innerHTML = '<span class="pill"><span class="dot err"></span>接口不可达</span>'; });
  }
  function renderOpsStatus(d){
    var rows = [
      ["运行时长", Math.floor((d.uptimeSec||0)/60) + " 分钟"],
      ["最近一轮", fmtTime(d.lastCycleAt)],
      ["最近轮询 GitHub", fmtTime(d.lastGithubPollAt)],
      ["最近轮询 邮件", fmtTime(d.lastImapPollAt)],
      ["任务计数", JSON.stringify(d.counts||{})],
      ["演练模式", d.dryRun ? "开启（只打印不落盘）" : "关闭"],
      ["最近错误", d.lastCycleError || "无"]
    ];
    q("ops-status").innerHTML = rows.map(function(r){
      return '<div class="k">'+esc(r[0])+'</div><div>'+esc(r[1])+'</div>';
    }).join("");
  }

  /* ---------------- 配置 ---------------- */
  function srcLabel(s){
    return {config:"页面",env:"环境变量",file:".env",default:"默认值"}[s] || s;
  }
  function fieldControl(f){
    var v = f.value === undefined ? "" : f.value;
    if(f.type === "boolean"){
      return '<label class="flex" style="cursor:pointer"><input type="checkbox" data-env="'+esc(f.env)+'" data-type="boolean"'+(v==="true"||v===true?" checked":"")+'> <span style="color:var(--muted);font-size:12px">'+(v==="true"?"开启":"关闭")+'</span></label>';
    }
    if(f.type === "select"){
      var opts = (f.options||[]).map(function(o){
        return '<option value="'+esc(o.value)+'"'+(String(v)===String(o.value)?" selected":"")+'>'+esc(o.label)+'</option>';
      }).join("");
      return '<select data-env="'+esc(f.env)+'" data-type="select">'+opts+'</select>';
    }
    if(f.type === "password"){
      var extra = f.isSet ? ' placeholder="已配置 '+esc(f.masked)+'，留空则不修改"' : ' placeholder="未配置"';
      return '<input type="password" data-env="'+esc(f.env)+'" data-type="password" value="" autocomplete="new-password"'+extra+'>';
    }
    var t = f.type === "number" ? "number" : "text";
    var attrs = f.type === "number" ? ' min="'+(f.min===undefined?"":f.min)+'" max="'+(f.max===undefined?"":f.max)+'"' : "";
    return '<input type="'+t+'" data-env="'+esc(f.env)+'" data-type="'+esc(f.type)+'" value="'+esc(v)+'"'+attrs+'>';
  }
  function renderConfig(){
    var view = S.config;
    if(!view){ q("config-mount").innerHTML = '<div class="empty">加载中…</div>'; return; }
    var html = "";
    view.groups.forEach(function(g){
      var testable = ["github","imap","ai"].indexOf(g.id) >= 0;
      html += '<div class="card"><h2>'+esc(g.title)+' <span class="desc">'+esc(g.description||"")+'</span>';
      if(testable){
        html += '<span class="right"><button class="btn sm" data-test="'+esc(g.id)+'">测试连接</button></span>';
      }
      html += '</h2><div class="body">';
      html += '<div class="msg" id="test-msg-'+esc(g.id)+'"></div>';
      g.fields.forEach(function(f){
        html += '<div class="row"><label>';
        html += '<div class="lbl">'+esc(f.label)+'<span class="src '+esc(f.source)+'">'+esc(srcLabel(f.source))+'</span></div>';
        if(f.hint) html += '<div class="hint">'+esc(f.hint)+'</div>';
        html += '</label><div>';
        html += fieldControl(f);
        if(f.needsRestart) html += '<div class="hint" style="color:var(--warn)">⚠ 改动需重启容器才生效</div>';
        if(f.type === "password" && f.isSet){
          html += '<div style="margin-top:6px"><button class="btn sm danger" data-clear="'+esc(f.env)+'">清除已存密钥</button></div>';
        }
        if(f.overridden){
          html += '<div style="margin-top:6px"><button class="btn sm" data-clear="'+esc(f.env)+'">清除页面覆盖</button></div>';
        }
        html += '</div></div>';
      });
      html += '</div></div>';
    });
    html += '<div class="card"><h2>配置文件</h2><div class="body" style="padding:12px 14px">'
      + '<div class="hint">页面保存的值写入 <span class="mono">'+esc(view.configFile)+'</span>（权限 600），'
      + '优先级高于环境变量与 .env。密钥不回传到浏览器，只显示掩码。</div></div></div>';
    q("config-mount").innerHTML = html;

    q("config-mount").addEventListener("input", function(e){
      var t = e.target;
      if(!t.dataset || !t.dataset.env) return;
      if(t.dataset.type === "boolean"){
        S.changed[t.dataset.env] = t.checked ? "true" : "false";
        t.parentElement.querySelector("span").textContent = t.checked ? "开启" : "关闭";
        return;
      }
      if(t.dataset.type === "password" && t.value === ""){ delete S.changed[t.dataset.env]; return; }
      S.changed[t.dataset.env] = t.value;
    });
    q("config-mount").addEventListener("change", function(e){
      var t = e.target;
      if(t.tagName === "SELECT" && t.dataset.env) S.changed[t.dataset.env] = t.value;
    });
    q("config-mount").addEventListener("click", function(e){
      var b = e.target.closest ? e.target.closest("button") : null;
      if(!b) return;
      if(b.dataset.test) return runTest(b);
      if(b.dataset.clear){
        if(!confirm("清除 " + b.dataset.clear + " 的已存值？清除后回落到环境变量或默认值。")) return;
        S.changed[b.dataset.clear] = "";
        var input = q("config-mount").querySelector('[data-env="'+b.dataset.clear+'"]');
        if(input && input.type === "password") input.value = "";
        b.textContent = "待清除";
        b.disabled = true;
      }
    });
  }
  function runTest(btn){
    var target = btn.dataset.test;
    var box = q("test-msg-" + target);
    btn.disabled = true; var old = btn.textContent; btn.textContent = "测试中…";
    msg(box, "warn", "正在测试连接…");
    api("/api/config/test", {method:"POST", body:{target:target}}).then(function(d){
      if(d.ok){
        msg(box, "ok", d.message + (d.detail && d.detail.length ? "\\n" + d.detail.join("\\n") : ""));
      } else {
        msg(box, "err", d.message || "测试失败");
      }
    }).catch(function(e){ msg(box, "err", String(e)); })
      .then(function(){ btn.disabled = false; btn.textContent = old; });
  }
  function loadConfig(){
    return api("/api/config").then(function(d){
      if(!d.ok){ q("config-mount").innerHTML = '<div class="empty">配置读取失败：'+esc(d.error||"")+'</div>'; return; }
      S.config = d; S.changed = {};
      renderConfig();
    });
  }
  function saveConfig(){
    var keys = Object.keys(S.changed);
    if(!keys.length){ msg(q("save-msg"), "warn", "没有改动"); return; }
    var btn = q("btn-save"); btn.disabled = true; btn.textContent = "保存中…";
    api("/api/config", {method:"POST", body:{patch:S.changed}}).then(function(d){
      if(d.ok){
        msg(q("save-msg"), "ok", "已保存 " + (d.keys||[]).length + " 项到 " + d.configFile
          + (d.needsRestart ? "\\n⚠ 端口改动需重启容器生效" : "\\n轮询间隔等改动下一轮即生效"));
        return loadConfig();
      }
      msg(q("save-msg"), "err", "保存失败：\\n" + (d.errors||[d.error||"未知错误"]).join("\\n"));
    }).catch(function(e){ msg(q("save-msg"), "err", String(e)); })
      .then(function(){ btn.disabled = false; btn.textContent = "保存配置"; });
  }

  /* ---------------- 任务看板 ---------------- */
  function loadTasks(){
    return api("/api/tasks").then(function(d){
      S.tasks = d;
      var c = d.counts || {};
      q("task-stats").innerHTML = ["pending","claimed","done","skipped"].map(function(k){
        return '<div class="stat"><div class="n">'+(c[k]||0)+'</div><div class="k">'+esc(k)+'</div></div>';
      }).join("");
      if(!d.tasks || !d.tasks.length){
        q("task-table").innerHTML = '<div class="empty">还没有任务。确认配置页里的 GitHub / 邮箱已填好，然后到「运维」点「立即扫描一轮」。</div>';
        return;
      }
      var rows = d.tasks.map(function(t){
        return '<tr data-id="'+esc(t.id)+'">'
          + '<td class="mono">'+esc(t.id)+'</td>'
          + '<td><span class="tag '+esc(t.status)+'">'+esc(t.status)+'</span></td>'
          + '<td><span class="tag '+esc(t.priority)+'">'+esc(t.priority)+'</span></td>'
          + '<td>'+esc(t.title)+'</td>'
          + '<td>'+esc(t.source === "github" ? "GitHub" : "邮件")+'</td>'
          + '<td class="mono" style="color:var(--faint)">'+esc(t.dir||"")+'</td>'
          + '<td style="color:var(--faint);white-space:nowrap">'+esc(fmtTime(t.createdAt))+'</td>'
          + '</tr>';
      }).join("");
      q("task-table").innerHTML = '<table><thead><tr><th>ID</th><th>状态</th><th>优先级</th><th>标题</th>'
        + '<th>来源</th><th>目录</th><th>创建时间</th></tr></thead><tbody>' + rows + '</tbody></table>';
      q("task-table").querySelector("tbody").addEventListener("click", function(e){
        var tr = e.target.closest ? e.target.closest("tr") : null;
        if(tr && tr.dataset.id) openTask(tr.dataset.id);
      });
    });
  }
  function openTask(id){
    q("detail-title").textContent = "任务 " + id;
    q("detail-body").innerHTML = '<div class="empty">加载中…</div>';
    q("detail").classList.add("on");
    api("/api/tasks/" + encodeURIComponent(id)).then(function(d){
      if(!d.ok){ q("detail-body").innerHTML = '<div class="empty">'+esc(d.error||"读取失败")+'</div>'; return; }
      var t = d.task || {};
      var html = '<div class="kv">'
        + '<div class="k">状态</div><div><span class="tag '+esc(t.status)+'">'+esc(t.status)+'</span> <span class="tag '+esc(t.priority)+'">'+esc(t.priority)+'</span> <span class="tag">'+esc(t.verdict||"")+'</span></div>'
        + '<div class="k">来源</div><div>'+ (t.sourceUrl ? '<a href="'+esc(t.sourceUrl)+'" target="_blank" rel="noreferrer">'+esc(t.sourceUrl)+'</a>' : esc(t.source === "imap" ? "反馈邮件" : "GitHub")) +'</div>'
        + '<div class="k">目录</div><div class="mono">'+esc(t.dir||"")+'</div>'
        + '<div class="k">模型</div><div>'+esc(t.model||"(未使用模型)")+'</div>'
        + '<div class="k">生成时间</div><div>'+esc(fmtTime(t.createdAt))+'</div>'
        + '</div>';
      if(d.assets && d.assets.length){
        html += '<div style="font-weight:600;margin-bottom:6px">附件</div><div class="thumbs">'
          + d.assets.map(function(a){ return '<a href="'+esc(a.url)+'" target="_blank" rel="noreferrer"><img src="'+esc(a.url)+'" alt="'+esc(a.name)+'"></a>'; }).join("")
          + '</div>';
      }
      html += '<div style="font-weight:600;margin:12px 0 6px">task.md</div><pre class="light">'+esc(d.markdown||"")+'</pre>';
      q("detail-body").innerHTML = html;
    });
  }

  /* ---------------- 运维 ---------------- */
  function loadLogs(){
    return api("/api/logs?lines=200").then(function(d){
      var box = q("log-box");
      var atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
      box.textContent = (d.lines||[]).map(function(l){ return l.ts + " [" + l.level.toUpperCase() + "] " + l.message; }).join("\\n") || "（暂无日志）";
      if(atBottom) box.scrollTop = box.scrollHeight;
    });
  }
  function rescan(){
    var btn = q("btn-rescan"); btn.disabled = true; btn.textContent = "已触发…";
    api("/api/rescan", {method:"POST"}).then(function(d){
      msg(q("ops-msg"), d.ok ? "ok" : "warn", d.message || d.error || "");
    }).catch(function(e){ msg(q("ops-msg"), "err", String(e)); })
      .then(function(){ setTimeout(function(){ btn.disabled = false; btn.textContent = "立即扫描一轮"; loadStatus(); loadLogs(); }, 1500); });
  }

  /* ---------------- Tab 与启动 ---------------- */
  function switchTab(name){
    S.tab = name;
    Array.prototype.forEach.call(document.querySelectorAll("nav button"), function(b){
      b.classList.toggle("on", b.dataset.tab === name);
    });
    Array.prototype.forEach.call(document.querySelectorAll("main section"), function(s){
      s.classList.toggle("on", s.id === "tab-" + name);
    });
    if(name === "tasks") loadTasks();
    if(name === "ops"){ loadLogs(); loadStatus(); }
  }
  document.querySelector("nav").addEventListener("click", function(e){
    var b = e.target.closest ? e.target.closest("button") : null;
    if(b && b.dataset.tab) switchTab(b.dataset.tab);
  });
  q("btn-save").addEventListener("click", saveConfig);
  q("btn-reload").addEventListener("click", function(){ clearMsg(q("save-msg")); loadConfig(); });
  q("btn-tasks-refresh").addEventListener("click", loadTasks);
  q("btn-rescan").addEventListener("click", rescan);
  q("btn-log-refresh").addEventListener("click", loadLogs);
  q("btn-dryrun-hint").addEventListener("click", function(){
    msg(q("ops-msg"), "warn", "演练模式在「配置 → 运行参数」里打开：只打印将要生成的任务，不写文件、不改状态库，适合先看模型分诊结果是否靠谱。");
  });
  q("detail-close").addEventListener("click", function(){ q("detail").classList.remove("on"); });
  q("detail").addEventListener("click", function(e){ if(e.target === q("detail")) q("detail").classList.remove("on"); });
  document.addEventListener("keydown", function(e){ if(e.key === "Escape") q("detail").classList.remove("on"); });

  loadConfig().then(loadStatus);
  loadStatus();
  S.statusTimer = setInterval(function(){
    loadStatus();
    if(S.tab === "ops" && q("log-auto").checked) loadLogs();
  }, 5000);
})();
</script>
</body>
</html>`;
}

/**
 * 登录页。只在设置了 HARNESS_UI_PASSWORD 时才会被看到。
 * 表单走原生 POST（不依赖 JS），失败时服务端直接重渲染本页并带错误。
 */
export function renderLogin({ error = "" } = {}) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 · MMH Bug Harness</title>
<style>
  :root{--bg:#f6f7f9;--panel:#fff;--border:#e3e6ea;--text:#1f2328;--muted:#6b7280;--faint:#9aa4b2;
    --accent:#2563eb;--accent-soft:#eff4ff;--err:#b91c1c;--err-soft:#fef2f2;--radius:8px}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center;
    font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;padding:20px}
  .card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:26px 26px 22px;width:100%;max-width:360px;
    box-shadow:0 8px 28px rgba(16,24,40,.07)}
  h1{font-size:15px;margin:0 0 4px;font-weight:650}
  p.sub{margin:0 0 18px;color:var(--faint);font-size:12.5px}
  label{display:block;font-weight:550;margin-bottom:6px}
  input[type=password]{width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;font-family:inherit}
  input[type=password]:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
  button{margin-top:14px;width:100%;padding:9px;border:0;border-radius:6px;background:var(--accent);color:#fff;
    font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
  button:hover{filter:brightness(1.06)}
  .err{margin-top:14px;padding:8px 11px;border-radius:6px;background:var(--err-soft);color:var(--err);
    border:1px solid #fecaca;font-size:12.5px}
  .foot{margin-top:16px;color:var(--faint);font-size:11.5px;line-height:1.6}
</style>
</head>
<body>
  <form class="card" method="post" action="/login">
    <h1>MMH Bug Harness</h1>
    <p class="sub">issue + 反馈邮件 → 规范化修复任务</p>
    <label for="password">页面访问密码</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
    <button type="submit">登录</button>
    ${error ? `<div class="err">${error.replace(/[<>&"]/g, "")}</div>` : ""}
    <div class="foot">密码由 <span style="font-family:ui-monospace,monospace">HARNESS_UI_PASSWORD</span> 配置。<br>想关闭登录，在配置页把「页面访问密码」清空即可。</div>
  </form>
</body>
</html>`;
}
