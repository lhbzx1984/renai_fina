'use strict';
/**
 * 主应用登录守卫
 *
 * 关键技巧：本文件必须在 app.js 之前加载。DOMContentLoaded 监听器按注册顺序执行，
 * 所以本文件的监听器先跑——它同步地把 App.init 替换成空函数，再做异步登录检查。
 * 等 app.js 的监听器执行 App.init() 时，调用的是那个空函数，于是不初始化。
 * 登录成功后再还原真正的 init 并调用。这样 1900 行的 app.js 一行都不用改。
 */
(function () {
  if (location.protocol === 'file:') return; // file:// 下没有后端，交给 index.html 的提示

  const GATE_ID = '__authGate';

  /* ---------- 样式（自包含，不污染 app.css） ---------- */
  function injectStyle() {
    if (document.getElementById('__authGateStyle')) return;
    const s = document.createElement('style');
    s.id = '__authGateStyle';
    s.textContent = `
#${GATE_ID}{position:fixed;inset:0;z-index:999999;background:linear-gradient(165deg,#123c4d 0%,#1a5f7a 55%,#1e6d8c 100%);
  display:flex;align-items:center;justify-content:center;padding:20px;overflow-y:auto}
#${GATE_ID} .ag-box{width:100%;max-width:430px;background:#fff;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.3);padding:28px 28px 24px}
#${GATE_ID} .ag-mark{font-size:28px;text-align:center}
#${GATE_ID} h1{font-size:18px;text-align:center;margin-top:4px}
#${GATE_ID} .ag-sub{text-align:center;color:#8b9aa8;font-size:11.5px;letter-spacing:1px;margin-bottom:18px}
#${GATE_ID} .ag-tabs{display:flex;gap:4px;background:#f0f4f7;padding:3px;border-radius:8px;margin-bottom:18px}
#${GATE_ID} .ag-tab{flex:1;text-align:center;padding:7px 4px;border-radius:6px;cursor:pointer;font-size:13px;color:#5a6b7c;transition:.15s}
#${GATE_ID} .ag-tab.on{background:#fff;color:#1a5f7a;font-weight:600;box-shadow:0 1px 3px rgba(0,0,0,.08)}
#${GATE_ID} .ag-field{margin-bottom:12px}
#${GATE_ID} label{display:block;font-size:12.5px;color:#5a6b7c;margin-bottom:5px;font-weight:600}
#${GATE_ID} input,#${GATE_ID} select{width:100%;border:1px solid #e3e9ef;border-radius:8px;padding:8px 11px;outline:none;font-size:14px}
#${GATE_ID} input:focus,#${GATE_ID} select:focus{border-color:#2a8ca8}
#${GATE_ID} .ag-row{display:flex;gap:8px}
#${GATE_ID} .ag-row>*{flex:1}
#${GATE_ID} .ag-row .ag-fix{flex:0 0 108px}
#${GATE_ID} .ag-btn{border:1px solid #e3e9ef;background:#fff;padding:9px 14px;border-radius:8px;cursor:pointer;font-size:14px;transition:.15s}
#${GATE_ID} .ag-btn:hover{border-color:#2a8ca8;color:#1a5f7a}
#${GATE_ID} .ag-btn.pri{background:#1a5f7a;border-color:#1a5f7a;color:#fff;width:100%}
#${GATE_ID} .ag-btn.pri:hover{background:#2a8ca8;color:#fff}
#${GATE_ID} .ag-btn:disabled{opacity:.55;cursor:not-allowed}
#${GATE_ID} .ag-hint{font-size:11.5px;color:#8b9aa8;margin-top:4px;line-height:1.5}
#${GATE_ID} .ag-alert{padding:9px 12px;border-radius:8px;font-size:12.5px;margin-bottom:12px;border-left:3px solid}
#${GATE_ID} .ag-alert.err{background:#fbeae8;border-color:#c0392b;color:#8f2b20}
#${GATE_ID} .ag-alert.ok{background:#e6f6ec;border-color:#1f8a5b;color:#166240}
#${GATE_ID} .ag-alert.info{background:#e8f3f7;border-color:#2a8ca8;color:#14536b}
#${GATE_ID} .ag-foot{text-align:center;margin-top:14px;font-size:12px;color:#8b9aa8}
#${GATE_ID} .ag-foot a{color:#1a5f7a;cursor:pointer;text-decoration:none}
#${GATE_ID} .ag-code{font-family:ui-monospace,Consolas,monospace;background:#fff8e1;border:1px dashed #c8811a;padding:2px 6px;border-radius:4px;color:#8a5d0e}
.ag-chip{display:flex;align-items:center;gap:7px;font-size:12.5px;color:#5a6b7c;background:#f4f7f9;border:1px solid #e3e9ef;
  padding:4px 10px;border-radius:20px;margin-right:8px}
.ag-chip b{color:#1c2530}
.ag-chip a{cursor:pointer;color:#1a5f7a;text-decoration:none}
`;
    document.head.appendChild(s);
  }

  /* ---------- 状态 ---------- */
  let cfg = null;
  let me = null;

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  async function json(method, url, body) {
    const opt = { method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    const res = await fetch(url, opt);
    const ct = res.headers.get('content-type') || '';
    const d = ct.includes('json') ? await res.json() : {};
    if (!res.ok || d.ok === false) throw new Error(d.error || ('HTTP ' + res.status));
    return d.data;
  }

  /* ---------- 遮罩 UI ---------- */
  function render(tab) {
    let el = document.getElementById(GATE_ID);
    if (!el) {
      injectStyle();
      el = document.createElement('div');
      el.id = GATE_ID;
      document.body.appendChild(el);
      document.body.style.overflow = 'hidden';
    }
    el.innerHTML = boxHtml(tab || 'login');
    bind(el, tab || 'login');
  }

  function boxHtml(tab) {
    const org = cfg && cfg.org_name ? cfg.org_name : '天津仁爱学院';
    const tabs = `<div class="ag-tabs">
      <div class="ag-tab${tab === 'login' ? ' on' : ''}" data-tab="login">登录</div>
      <div class="ag-tab${tab === 'reg' ? ' on' : ''}" data-tab="reg">注册</div>
      <div class="ag-tab${tab === 'reset' ? ' on' : ''}" data-tab="reset">找回密码</div>
    </div>`;

    let body = '';
    if (tab === 'login') {
      body = `
        <div id="agAlert"></div>
        <div class="ag-field"><label>账号</label>
          <input id="agAccount" placeholder="登录名 / 邮箱 / 手机号" autocomplete="username"></div>
        <div class="ag-field"><label>密码</label>
          <input id="agPass" type="password" placeholder="登录密码" autocomplete="current-password"></div>
        <button class="ag-btn pri" id="agLogin">登 录</button>
        <div class="ag-foot">还没有账号？<a data-tab="reg">立即注册</a></div>`;
    } else if (tab === 'reg') {
      const closed = cfg && cfg.register_open === false;
      if (closed) {
        body = `<div class="ag-alert err">当前未开放自助注册，请联系系统管理员开通账号。</div>
          <div class="ag-foot"><a data-tab="login">返回登录</a></div>`;
      } else {
        const emailOk = !!(cfg && cfg.email_ready);
        // 邮箱未配好时说清楚后果，别让用户填完才发现收不到验证码
        const seg = emailOk ? '' :
          '<div class="ag-alert err">验证码邮箱尚未配置，暂时无法自助注册。请联系系统管理员开通账号。</div>';
        const target = `<div class="ag-field"><label>邮箱<span style="color:#c0392b">*</span></label>
             <input id="agEmail" placeholder="you@example.com" autocomplete="email"></div>`;
        body = `
          <div id="agAlert"></div>
          ${seg}
          <div class="ag-row">
            <div class="ag-field"><label>登录名<span style="color:#c0392b">*</span></label>
              <input id="agUser" placeholder="3-32 位字母数字" autocomplete="username"></div>
            <div class="ag-field"><label>姓名<span style="color:#c0392b">*</span></label>
              <input id="agName" placeholder="真实姓名"></div>
          </div>
          ${target}
          <div class="ag-field"><label>工号 / 学号</label><input id="agJob" placeholder="选填，便于管理员核对身份"></div>
          <div class="ag-field"><label>验证码<span style="color:#c0392b">*</span></label>
            <div class="ag-row">
              <input id="agCode" placeholder="6 位验证码" autocomplete="one-time-code">
              <button class="ag-btn ag-fix" id="agSend">获取验证码</button>
            </div>
            <div class="ag-hint" id="agCodeHint"></div></div>
          <div class="ag-row">
            <div class="ag-field"><label>密码<span style="color:#c0392b">*</span></label>
              <input id="agPwd" type="password" placeholder="至少 8 位" autocomplete="new-password"></div>
            <div class="ag-field"><label>确认密码<span style="color:#c0392b">*</span></label>
              <input id="agPwd2" type="password" autocomplete="new-password"></div>
          </div>
          <div class="ag-field"><label>申请说明</label>
            <input id="agReason" placeholder="选填，如：数智传媒与设计艺术学院 教师"></div>
          <button class="ag-btn pri" id="agReg">提交注册</button>
          <div class="ag-foot">已有账号？<a data-tab="login">去登录</a></div>`;
      }
    } else {
      const seg = (cfg && cfg.email_ready) ? '' :
        '<div class="ag-alert err">验证码邮箱尚未配置，无法自助找回密码。请联系系统管理员重置。</div>';
      body = `
        <div id="agAlert"></div>
        ${seg}
        <div class="ag-field"><label>邮箱<span style="color:#c0392b">*</span></label>
          <input id="agRTarget" placeholder="注册时填写的邮箱" autocomplete="username"></div>
        <div class="ag-field"><label>验证码<span style="color:#c0392b">*</span></label>
          <div class="ag-row">
            <input id="agRCode" placeholder="6 位验证码" autocomplete="one-time-code">
            <button class="ag-btn ag-fix" id="agRSend">获取验证码</button>
          </div>
          <div class="ag-hint" id="agRHint"></div></div>
        <div class="ag-field"><label>新密码<span style="color:#c0392b">*</span></label>
          <input id="agRPwd" type="password" placeholder="至少 8 位" autocomplete="new-password"></div>
        <button class="ag-btn pri" id="agReset">重置密码</button>
        <div class="ag-foot"><a data-tab="login">返回登录</a></div>`;
    }

    return `<div class="ag-box">
      <div class="ag-mark">🔐</div>
      <h1>${esc(org)}</h1>
      <div class="ag-sub">报销管理系统 · 账号登录</div>
      ${tabs}${body}
    </div>`;
  }

  function alertBox(html, cls) {
    const a = document.getElementById('agAlert');
    if (a) a.innerHTML = `<div class="ag-alert ${cls || 'err'}">${html}</div>`;
  }

  function bind(el, tab) {
    el.querySelectorAll('[data-tab]').forEach((n) => {
      n.onclick = () => render(n.dataset.tab);
    });

    if (tab === 'login') {
      const acc = el.querySelector('#agAccount'), pw = el.querySelector('#agPass');
      // 元素缺失时只告警，不让整页脚本中断（旧版 JS 撞上新结构会直接抛 null.onclick）
      if (!acc || !pw) return console.warn('[auth-guard] 登录表单元素缺失');
      const go = () => doLogin(acc.value.trim(), pw.value);
      const btn = el.querySelector('#agLogin');
      if (btn) btn.onclick = go; else console.warn('[auth-guard] #agLogin 缺失');
      pw.onkeydown = (e) => { if (e.key === 'Enter') go(); };
      acc.onkeydown = (e) => { if (e.key === 'Enter') pw.focus(); };
      setTimeout(() => acc.focus(), 60);
    }

    if (tab === 'reg') {
      const btn = el.querySelector('#agSend');
      if (btn) btn.onclick = () => sendCode(
        'email', el.querySelector('#agEmail').value.trim(),
        'register', btn, el.querySelector('#agCodeHint'));
      const rb = el.querySelector('#agReg');
      if (rb) rb.onclick = () => doRegister(el);
    }

    if (tab === 'reset') {
      const btn = el.querySelector('#agRSend');
      if (btn) btn.onclick = () => sendCode('email', el.querySelector('#agRTarget').value.trim(), 'reset', btn, el.querySelector('#agRHint'));
      const rb = el.querySelector('#agReset');
      if (rb) rb.onclick = () => doReset(el); else console.warn('[auth-guard] #agReset 缺失');
    }
  }

  /* ---------- 动作 ---------- */
  async function sendCode(ch, target, purpose, btn, hintEl) {
    if (!target) return alertBox('请先填写邮箱');
    btn.disabled = true; btn.textContent = '发送中…';
    try {
      const d = await json('POST', '/api/auth/code/send', { channel: 'email', target, purpose });
      const msg = `验证码邮件已发送，${Math.round(d.ttl / 60)} 分钟内有效`;
      if (hintEl) hintEl.textContent = msg;
      let left = d.wait || 60;
      btn.textContent = left + 's';
      const t = setInterval(() => {
        left--;
        if (left <= 0) { clearInterval(t); btn.disabled = false; btn.textContent = '重新获取'; }
        else btn.textContent = left + 's';
      }, 1000);
    } catch (e) {
      alertBox(esc(e.message));
      btn.disabled = false; btn.textContent = '获取验证码';
    }
  }

  async function doLogin(account, password) {
    if (!account || !password) return alertBox('请输入账号和密码');
    const btn = document.getElementById('agLogin');
    if (btn) { btn.disabled = true; btn.textContent = '登录中…'; }
    try {
      const d = await json('POST', '/api/auth/login', { account, password });
      // 登录响应里就带用户信息，直接用它，避免顶栏渲染出空名字
      if (d && d.user) me = d.user;
      onLoggedIn();
    } catch (e) {
      alertBox(esc(e.message));
      if (btn) { btn.disabled = false; btn.textContent = '登 录'; }
    }
  }

  async function doRegister(el) {
    const v = (id) => { const n = el.querySelector(id); return n ? n.value.trim() : ''; };
    const body = {
      username: v('#agUser'), name: v('#agName'),
      job_no: v('#agJob'), code: v('#agCode'),
      password: v('#agPwd'), reason: v('#agReason'),
      channel: 'email', email: v('#agEmail'),
    };
    if (!body.email) return alertBox('请填写邮箱');
    if (!body.username || !body.name) return alertBox('登录名与姓名必填');
    if (v('#agPwd') !== v('#agPwd2')) return alertBox('两次输入的密码不一致');
    if (!body.code) return alertBox('请填写验证码');

    const btn = document.getElementById('agReg');
    btn.disabled = true; btn.textContent = '提交中…';
    try {
      const d = await json('POST', '/api/auth/register', body);
      if (d.auto_approved) {
        // 白名单命中：直接帮他登录，少一步操作
        const lg = await json('POST', '/api/auth/login', { account: body.username, password: body.password });
        if (lg && lg.user) me = lg.user;
        return onLoggedIn();
      }
      el.querySelector('.ag-box').innerHTML =
        `<div class="ag-mark">⏳</div><h1>注册申请已提交</h1>
         <div class="ag-sub">PENDING APPROVAL</div>
         <div class="ag-alert ok">账号 <b>${esc(body.username)}</b> 已创建，等待管理员审批。<br>
         审批通过后即可用此账号登录，无需重新注册。</div>
         <div class="ag-foot"><a data-tab="login">返回登录</a></div>`;
      el.querySelectorAll('[data-tab]').forEach((n) => { n.onclick = () => render(n.dataset.tab); });
    } catch (e) {
      alertBox(esc(e.message));
      btn.disabled = false; btn.textContent = '提交注册';
    }
  }

  async function doReset(el) {
    const v = (id) => { const n = el.querySelector(id); return n ? n.value.trim() : ''; };
    const target = v('#agRTarget'), code = v('#agRCode'), password = v('#agRPwd');
    if (!target) return alertBox('请填写邮箱');
    if (!code) return alertBox('请填写验证码');
    if (password.length < 8) return alertBox('新密码至少 8 位');
    try {
      await json('POST', '/api/auth/password/reset', { channel: 'email', target, code, password });
      alertBox('密码已重置，请用新密码登录。', 'ok');
      setTimeout(() => render('login'), 1200);
    } catch (e) { alertBox(esc(e.message)); }
  }

  /* ---------- 顶栏用户区 ---------- */
  function mountChip() {
    if (!me || document.getElementById('agChip')) return;
    const bar = document.querySelector('.topbar');
    if (!bar) return;
    const chip = document.createElement('span');
    chip.className = 'ag-chip';
    chip.id = 'agChip';
    chip.innerHTML = `<span>👤</span><b>${esc(me.name)}</b>
      <a id="agPwdBtn" title="修改密码">改密</a><a id="agOut">退出</a>`;
    const anchor = document.getElementById('btnGuide');
    if (anchor) bar.insertBefore(chip, anchor); else bar.insertBefore(chip, bar.firstChild);
    chip.querySelector('#agOut').onclick = async () => {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => ({}));
      location.reload();
    };
    chip.querySelector('#agPwdBtn').onclick = changePwd;
  }

  function changePwd() {
    const mask = document.getElementById('modalMask'), box = document.getElementById('modalBox');
    if (!mask || !box) return;
    box.className = 'modal';
    box.innerHTML =
      `<div class="modal-head"><h3>修改密码</h3><button class="modal-close" id="agPwdX">&times;</button></div>
       <div class="modal-body">
         <div class="field"><label>当前密码</label><input class="input" type="password" id="agOld" autocomplete="current-password"></div>
         <div class="field"><label>新密码</label><input class="input" type="password" id="agNew" autocomplete="new-password"></div>
         <div class="field"><label>确认新密码</label><input class="input" type="password" id="agNew2" autocomplete="new-password"></div>
         <div class="hint">至少 8 位，不能是纯数字或纯字母。</div>
       </div>
       <div class="modal-foot"><button class="btn" id="agPwdCancel">取消</button>
       <button class="btn btn-primary" id="agPwdOk">保存</button></div>`;
    mask.classList.add('show');
    const close = () => { mask.classList.remove('show'); box.innerHTML = ''; };
    box.querySelector('#agPwdX').onclick = close;
    box.querySelector('#agPwdCancel').onclick = close;
    box.querySelector('#agPwdOk').onclick = async () => {
      const o = box.querySelector('#agOld').value;
      const n1 = box.querySelector('#agNew').value;
      const n2 = box.querySelector('#agNew2').value;
      if (n1 !== n2) return window.toast && toast('两次输入不一致', 'warn');
      try {
        await json('POST', '/api/auth/password/change', { old_password: o, new_password: n1 });
        close();
        if (window.toast) toast('密码已修改', 'ok');
      } catch (e) { if (window.toast) toast(e.message, 'err'); }
    };
  }

  /* ---------- 生命周期 ---------- */
  let passed = false;

  function removeGate() {
    const el = document.getElementById(GATE_ID);
    if (el) el.remove();
    document.body.style.overflow = '';
  }

  function onLoggedIn() {
    removeGate();
    if (passed) return location.reload();
    passed = true;
    // 还原真正的 App.init 并执行——此时 app.js 的 DOMContentLoaded 早已跑完
    App.init = realInit;
    realInit();
    // 若登录响应没带用户信息（如从持久会话恢复），兜底再拉一次
    if (!me) {
      json('GET', '/api/auth/me').then((d) => { me = d.user; mountChip(); }).catch(() => { });
    } else {
      mountChip();
    }
  }

  let realInit = null;

  document.addEventListener('DOMContentLoaded', async () => {
    // 同步部分：先把 App.init 顶掉，确保 app.js 的监听器执行时不会真的初始化
    realInit = App.init.bind(App);
    App.init = function () { /* 登录门禁期间不初始化 */ };

    // 让 Api 在收到「请先登录」时自动弹回登录框（会话过期场景）
    const origCall = Api.call.bind(Api);
    Api.call = async function (m, u, b) {
      try { return await origCall(m, u, b); }
      catch (e) {
        if (e && /请先登录/.test(e.message)) { passed = false; render('login'); }
        throw e;
      }
    };

    try { cfg = await json('GET', '/api/auth/config'); } catch (e) { cfg = null; }

    if (cfg && cfg.require_login === false) {
      // 管理员关闭了强制登录：直接放行，保持旧行为
      passed = true;
      App.init = realInit;
      realInit();
      return;
    }

    try {
      const d = await json('GET', '/api/auth/me');
      me = d.user;
      passed = true;
      App.init = realInit;
      realInit();
      mountChip();
    } catch (e) {
      render('login');
    }
  });

  window.__authGuard = { render, get user() { return me; } };
})();
