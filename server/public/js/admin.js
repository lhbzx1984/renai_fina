'use strict';
/** 后台管理：登录、用户审批与管理、认证/短信配置、操作日志 */

const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

/**
 * 安全绑定点击。
 * 曾经踩过的坑：删掉短信功能时，页面里的按钮没了，但 JS 里那行
 * `$(...).onclick = ...` 还在 —— 结果登录成功后 bindNav() 抛
 * "Cannot set properties of null"，整个后台停在半初始化状态。
 * 一个按钮对不上不该让整页瘫痪，所以这里缺失只告警、不中断。
 */
function on(sel, fn) {
  const el = $(sel);
  if (!el) { console.warn('[admin] 元素不存在，跳过绑定：' + sel); return null; }
  el.onclick = fn;
  return el;
}

/** on() 的通用版：任意事件类型，缺失同样只告警 */
function onEvt(sel, evt, fn) {
  const el = $(sel);
  if (!el) { console.warn('[admin] 元素不存在，跳过绑定：' + sel); return null; }
  el[evt] = fn;
  return el;
}

/* 未捕获错误要看得见：否则脚本崩在半路，界面只是「没反应」，根本无从排查 */
window.addEventListener('error', (e) => {
  console.error('[admin] 未捕获错误：', e.message, e.filename, e.lineno);
  try { toast('页面脚本错误：' + e.message, 'err'); } catch (_) { /* toast 容器也可能不在 */ }
});

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function toast(msg, type) {
  const wrap = $('#toastWrap');
  if (!wrap) { console.warn('[admin] 提示容器缺失：' + msg); return; }
  const el = document.createElement('div');
  el.className = 'toast ' + (type || 'info');
  el.innerHTML = `<span class="ico">${{ ok: '✓', err: '✕', warn: '!' }[type] || 'i'}</span><span>${esc(msg)}</span>`;
  wrap.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, type === 'err' ? 4800 : 2600);
}

async function api(method, url, body) {
  const opt = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(url, opt); }
  catch (e) { throw new Error('无法连接服务器'); }
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('json')) { if (!res.ok) throw new Error('HTTP ' + res.status); return {}; }
  const d = await res.json();
  if (!res.ok || d.ok === false) {
    if (res.status === 401) { showLogin(); throw new Error(d.error || '请先登录'); }
    throw new Error(d.error || '请求失败');
  }
  return d.data;
}

function modal(title, bodyHtml, buttons) {
  const box = $('#modal');
  box.innerHTML =
    `<div class="modal-head"><h3>${esc(title)}</h3><button class="modal-close" data-close>&times;</button></div>` +
    `<div class="modal-body">${bodyHtml}</div>` +
    `<div class="modal-foot">${buttons.map((b, i) => `<button class="btn ${b.cls || ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div>`;
  $('#mask').classList.add('show');
  const close = () => { $('#mask').classList.remove('show'); box.innerHTML = ''; };
  const x = box.querySelector('[data-close]');
  if (x) x.onclick = close;
  on('#mask', (e) => { if (e.target === $('#mask')) close(); });
  $$('[data-i]', box).forEach((btn) => {
    btn.onclick = async () => {
      const b = buttons[Number(btn.dataset.i)];
      if (!b.onClick) return close();
      btn.disabled = true;
      const txt = btn.textContent; btn.textContent = '处理中…';
      try { const r = await b.onClick(close); if (r !== false) close(); }
      catch (e) { toast(e.message, 'err'); }
      finally { btn.disabled = false; btn.textContent = txt; }
    };
  });
}

const STATUS_TAG = {
  pending: ['gold', '待审批'], active: ['green', '正常'],
  disabled: ['grey', '已停用'], rejected: ['red', '已驳回'],
};
const ROLE_TAG = { super_admin: ['purple', '超级管理员'], admin: ['', '管理员'], user: ['grey', '普通用户'] };

const Admin = {
  me: null,
  view: 'overview',

  /* ---------- 启动 ---------- */
  async boot() {
    try {
      const d = await api('GET', '/api/auth/me');
      this.me = d.user;
      if (this.me.role !== 'admin' && this.me.role !== 'super_admin') {
        $('#loginTip').innerHTML =
          '<div class="alert err">当前账号「' + esc(this.me.name) +
          '」不是管理员，无法进入后台。请用管理员账号登录。</div>';
        return showLogin();
      }
      this.enter();
    } catch (e) {
      showLogin();
    }
  },

  enter() {
    $('#loginWrap').classList.add('hidden');
    $('#adminWrap').classList.remove('hidden');
    $('#sideUser').textContent = `${this.me.name}（${ROLE_TAG[this.me.role][1]}）`;
    this.bindNav();
    this.loadOverview();
  },

  bindNav() {
    $$('#adminNav .nav-item').forEach((el) => {
      el.onclick = () => this.go(el.dataset.view);
    });
    on('#btnRefreshTop', () => this.reload());
    on('#linkLogout', async () => {
      await api('POST', '/api/auth/logout').catch(() => ({}));
      showLogin();
    });
    on('#linkPwd', () => this.changeMyPassword());
    on('#btnNewUser', () => this.newUser());
    on('#btnApproveAll', () => this.approveAll());
    on('#btnSaveAuth', () => this.saveSettings());
    onEvt('#uSearch', 'oninput', debounce(() => this.loadUsers(), 280));
    onEvt('#uStatus', 'onchange', () => this.loadUsers());
    onEvt('#uRole', 'onchange', () => this.loadUsers());
    onEvt('#auditLimit', 'onchange', () => this.loadAudit());
  },

  go(view) {
    this.view = view;
    $$('#adminNav .nav-item').forEach((el) => el.classList.toggle('active', el.dataset.view === view));
    $$('.view').forEach((el) => el.classList.toggle('hidden', el.id !== 'view-' + view));
    $('#pgTitle').textContent = {
      overview: '概览', pending: '注册审批', users: '用户管理', settings: '认证与邮箱', audit: '操作日志',
    }[view] || '概览';
    this.reload();
  },

  reload() {
    if (this.view === 'overview') return this.loadOverview();
    if (this.view === 'pending') return this.loadPending();
    if (this.view === 'users') return this.loadUsers();
    if (this.view === 'settings') return this.loadSettings();
    if (this.view === 'audit') return this.loadAudit();
  },

  /* ---------- 概览 ---------- */
  async loadOverview() {
    const d = await api('GET', '/api/admin/stats');
    const u = d.users;
    $('#statCards').innerHTML = [
      ['用户总数', u.total, '', ''],
      ['待审批', u.pending, u.pending ? 'warn' : '', '等待你处理'],
      ['正常', u.active, 'ok', '可登录'],
      ['已停用', u.disabled, '', ''],
      ['管理员', u.admin, '', '含超级管理员'],
    ].map(([k, v, cls, dsub]) =>
      `<div class="stat ${cls}"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${dsub || '&nbsp;'}</div></div>`
    ).join('');

    $('#navPendingCnt').textContent = u.pending;
    $('#navPendingCnt').classList.toggle('zero', !u.pending);

    // 待审批摘要
    const list = (await api('GET', '/api/admin/users?status=pending')).list.slice(0, 5);
    $('#pendingBrief').innerHTML = list.length
      ? list.map((x) => `
        <div class="log-line">
          <span class="a">${esc(x.name)}</span>
          <span class="muted">${esc(x.email || x.phone || '')}</span>
          <span class="spacer"></span>
          <span class="muted">${esc(x.created_at || '')}</span>
        </div>`).join('') +
      (u.pending > 5 ? `<div class="hint" style="padding:8px 0">另有 ${u.pending - 5} 条待审批</div>` : '')
      : '<div class="empty"><div class="ico">✓</div><p>没有待处理的注册申请</p></div>';

    $('#sysBrief').innerHTML = `
      <div class="log-line"><span class="a">注册开关</span><span>${d.register_open ? '<span class="tag green">开放</span>' : '<span class="tag grey">关闭</span>'}</span></div>
      <div class="log-line"><span class="a">验证码邮箱</span><span>${d.email_ready ? '<span class="tag green">已配置</span>' : '<span class="tag red">未配置</span>'}</span></div>
      <div class="log-line"><span class="a">在线会话</span><span>${u.sessions} 个</span></div>
      <div class="log-line"><span class="a">待审票据</span><span>${d.pending_receipts} 张</span></div>
      <div style="margin-top:10px"><button class="btn btn-sm" onclick="Admin.go('settings')">配置邮箱与审批规则</button></div>`;
  },

  /* ---------- 注册审批 ---------- */
  async loadPending() {
    const list = (await api('GET', '/api/admin/users?status=pending')).list;
    const t = $('#pendingTable');
    // 空状态只能写进 tbody —— 直接替换父容器会把 <table> 本身干掉，下次渲染取不到元素
    if (!list.length) {
      t.innerHTML = '<tbody><tr><td><div class="empty"><div class="ico">✓</div><p>没有待处理的注册申请</p></div></td></tr></tbody>';
      return;
    }
    t.innerHTML =
      `<thead><tr><th>姓名</th><th>登录名</th><th>联系方式</th><th>工号</th>
       <th>注册渠道</th><th>申请说明</th><th>提交时间</th><th style="width:180px">操作</th></tr></thead>` +
      `<tbody>${list.map((u) => `<tr>
        <td><b>${esc(u.name)}</b></td>
        <td class="mono">${esc(u.username)}</td>
        <td>${esc(u.email || '')}${u.email && u.phone ? '<br>' : ''}${esc(u.phone || '')}</td>
        <td>${esc(u.job_no || '—')}</td>
        <td><span class="tag">${u.register_channel === 'phone' ? '手机' : '邮箱'}</span></td>
        <td class="muted">${esc(u.register_reason || '—')}</td>
        <td class="muted">${esc(u.created_at)}</td>
        <td><div class="acts">
          <button class="btn btn-ok btn-sm" onclick="Admin.act(${u.id},'approve')">通过</button>
          <button class="btn btn-sm" onclick="Admin.reject(${u.id})">驳回</button>
        </div></td>
      </tr>`).join('')}</tbody>`;
  },

  async approveAll() {
    const list = (await api('GET', '/api/admin/users?status=pending')).list;
    if (!list.length) return toast('没有待审批账号', 'warn');
    modal('批量通过', `<p style="line-height:1.7">确定通过全部 <b>${list.length}</b> 个注册申请吗？</p>`, [
      { label: '取消', cls: 'btn' },
      {
        label: '全部通过', cls: 'btn btn-ok', onClick: async () => {
          let n = 0;
          for (const u of list) {
            try { await api('POST', `/api/admin/users/${u.id}/approve`, {}); n++; } catch (e) { /* 单个失败跳过 */ }
          }
          toast(`已通过 ${n} 个账号`, 'ok');
          this.reload();
        },
      },
    ]);
  },

  reject(id) {
    modal('驳回注册申请', `
      <div class="field"><label>驳回原因（可选，会展示给用户）</label>
      <input class="input" id="rjReason" placeholder="如：非本院人员，请联系管理员线下开通"></div>`, [
      { label: '取消', cls: 'btn' },
      {
        label: '确认驳回', cls: 'btn btn-danger', onClick: async () => {
          const reason = $('#rjReason').value.trim();
          await api('POST', `/api/admin/users/${id}/reject`, { reason });
          toast('已驳回', 'ok'); this.reload();
        },
      },
    ]);
  },

  /* ---------- 用户管理 ---------- */
  async loadUsers() {
    const q = new URLSearchParams();
    const kw = $('#uSearch').value.trim();
    if (kw) q.set('keyword', kw);
    if ($('#uStatus').value) q.set('status', $('#uStatus').value);
    if ($('#uRole').value) q.set('role', $('#uRole').value);
    const list = (await api('GET', '/api/admin/users?' + q.toString())).list;
    const t = $('#userTable');
    if (!list.length) { t.innerHTML = '<tbody><tr><td><div class="empty">没有匹配的用户</div></td></tr></tbody>'; return; }
    t.innerHTML =
      `<thead><tr><th>姓名</th><th>登录名</th><th>联系方式</th><th>工号</th><th>角色</th>
       <th>状态</th><th>最近登录</th><th style="width:250px">操作</th></tr></thead>` +
      `<tbody>${list.map((u) => {
        const st = STATUS_TAG[u.status] || ['grey', u.status];
        const rt = ROLE_TAG[u.role] || ['grey', u.role];
        const acts = [`<button class="btn btn-sm" onclick="Admin.editUser(${u.id})">编辑</button>`];
        if (u.status === 'pending') acts.push(`<button class="btn btn-ok btn-sm" onclick="Admin.act(${u.id},'approve')">通过</button>`);
        if (u.status === 'active') acts.push(`<button class="btn btn-sm" onclick="Admin.act(${u.id},'disable')">停用</button>`);
        if (u.status === 'disabled' || u.status === 'rejected') acts.push(`<button class="btn btn-sm" onclick="Admin.act(${u.id},'enable')">启用</button>`);
        if (u.role === 'super_admin') {
          acts.push(`<span class="muted">超管</span>`);
        } else {
          acts.push(`<button class="btn btn-sm" onclick="Admin.setRole(${u.id},'${u.role}')">角色</button>`);
          acts.push(`<button class="btn btn-sm" onclick="Admin.resetPwd(${u.id})">改密</button>`);
          acts.push(`<button class="btn btn-sm" onclick="Admin.act(${u.id},'unlock')">解锁</button>`);
          acts.push(`<button class="btn btn-danger btn-sm" onclick="Admin.del(${u.id},'${esc(u.name)}')">删除</button>`);
        }
        return `<tr>
          <td><b>${esc(u.name)}</b></td>
          <td class="mono">${esc(u.username)}</td>
          <td>${esc(u.email || '—')}${u.phone ? '<br>' + esc(u.phone) : ''}</td>
          <td>${esc(u.job_no || '—')}</td>
          <td><span class="tag ${rt[0]}">${rt[1]}</span></td>
          <td><span class="tag ${st[0]}">${st[1]}</span></td>
          <td class="muted">${esc(u.last_login_at || '从未登录')}</td>
          <td><div class="acts">${acts.join('')}</div></td>
        </tr>`;
      }).join('')}</tbody>`;
  },

  async act(id, action) {
    const label = { approve: '通过', disable: '停用', enable: '启用', unlock: '解锁' }[action];
    if (action === 'disable') {
      return modal('停用账号', `<div class="field"><label>停用原因（可选）</label>
        <input class="input" id="dsReason" placeholder="如：已离职"></div>`, [
        { label: '取消', cls: 'btn' },
        { label: '确认停用', cls: 'btn btn-danger', onClick: async () => {
          await api('POST', `/api/admin/users/${id}/disable`, { reason: $('#dsReason').value.trim() });
          toast('已停用', 'ok'); this.reload();
        } },
      ]);
    }
    await api('POST', `/api/admin/users/${id}/${action}`, {});
    toast(`已${label}`, 'ok');
    this.reload();
  },

  /* 编辑资料：登录名不可改（审计日志按登录名留痕，改了历史对不上）。
     补邮箱是最常见的用途 —— 没邮箱就走不通自助找回密码。 */
  async editUser(id) {
    let u;
    try { u = (await api('GET', `/api/admin/users/${id}`)).user; }
    catch (e) { return toast(e.message, 'err'); }
    const noMail = !u.email;
    modal('编辑用户资料', `
      <div class="field"><label>登录名</label>
        <input class="input" value="${esc(u.username)}" disabled>
        <div class="hint">登录名不可修改</div></div>
      <div class="field"><label>姓名<span class="req">*</span></label>
        <input class="input" id="pfName" value="${esc(u.name || '')}"></div>
      <div class="field"><label>邮箱${noMail ? '<span class="req">*</span>' : ''}</label>
        <input class="input" id="pfEmail" type="email" placeholder="name@example.com" value="${esc(u.email || '')}">
        ${noMail ? '<div class="hint warn">该账号未绑定邮箱，无法自助找回密码 —— 建议现在补上。</div>'
                 : '<div class="hint">邮箱是找回密码的唯一渠道</div>'}</div>
      <div class="field"><label>手机号</label>
        <input class="input" id="pfPhone" placeholder="11 位手机号" value="${esc(u.phone || '')}"></div>
      <div class="field"><label>工号</label>
        <input class="input" id="pfJob" value="${esc(u.job_no || '')}"></div>`, [
      { label: '取消', cls: 'btn' },
      { label: '保存', cls: 'btn btn-primary', onClick: async () => {
        const email = $('#pfEmail').value.trim();
        if (noMail && !email) throw new Error('该账号没有邮箱，请补填后再保存');
        await api('POST', `/api/admin/users/${id}/profile`, {
          name: $('#pfName').value.trim(),
          email,
          phone: $('#pfPhone').value.trim(),
          job_no: $('#pfJob').value.trim(),
        });
        toast('资料已更新', 'ok'); this.reload();
      } },
    ]);
  },

  setRole(id, cur) {
    modal('修改角色', `
      <div class="field"><label>选择角色</label>
      <select class="select" id="rlSel">
        <option value="user"${cur === 'user' ? ' selected' : ''}>普通用户</option>
        <option value="admin"${cur === 'admin' ? ' selected' : ''}>管理员</option>
      </select></div>
      <div class="hint">管理员可进入后台、审批账号、修改系统设置。超级管理员角色不可在此变更。</div>`, [
      { label: '取消', cls: 'btn' },
      { label: '保存', cls: 'btn btn-primary', onClick: async () => {
        await api('POST', `/api/admin/users/${id}/role`, { role: $('#rlSel').value });
        toast('角色已更新', 'ok'); this.reload();
      } },
    ]);
  },

  resetPwd(id) {
    modal('重置密码', `
      <div class="field"><label>新密码<span class="req">*</span></label>
      <input class="input" type="password" id="np1" autocomplete="new-password"></div>
      <div class="field"><label>确认新密码<span class="req">*</span></label>
      <input class="input" type="password" id="np2" autocomplete="new-password"></div>
      <div class="hint">至少 8 位，不能是纯数字或纯字母。重置后该用户的所有登录会话会被踢出。</div>`, [
      { label: '取消', cls: 'btn' },
      { label: '确认重置', cls: 'btn btn-primary', onClick: async () => {
        const a = $('#np1').value, b = $('#np2').value;
        if (a.length < 8) throw new Error('密码至少 8 位');
        if (a !== b) throw new Error('两次输入不一致');
        await api('POST', `/api/admin/users/${id}/reset_password`, { password: a });
        toast('密码已重置', 'ok');
      } },
    ]);
  },

  del(id, name) {
    modal('删除用户', `<p style="line-height:1.7">确定删除用户 <b>${esc(name)}</b> 吗？<br>
      <span class="muted">该操作不可撤销，其登录会话会立即失效。报销业务数据（项目、票据）不受影响。</span></p>`, [
      { label: '取消', cls: 'btn' },
      { label: '确认删除', cls: 'btn btn-danger', onClick: async () => {
        await api('DELETE', `/api/admin/users/${id}`);
        toast('已删除', 'ok'); this.reload();
      } },
    ]);
  },

  /** 改自己的密码。首次登录的超管必须走这里——初始随机密码不能一直用 */
  changeMyPassword() {
    modal('修改我的密码', `
      <div class="field"><label>当前密码<span class="req">*</span></label>
        <input class="input" type="password" id="cp_old" autocomplete="current-password"></div>
      <div class="field"><label>新密码<span class="req">*</span></label>
        <input class="input" type="password" id="cp_new" autocomplete="new-password"></div>
      <div class="field"><label>确认新密码<span class="req">*</span></label>
        <input class="input" type="password" id="cp_new2" autocomplete="new-password"></div>
      <div class="hint">至少 8 位，不能是纯数字或纯字母。改密成功后会<strong>踢掉你的其他在线会话</strong>。</div>`, [
      { label: '取消', cls: 'btn' },
      { label: '确认修改', cls: 'btn btn-primary', onClick: async () => {
        const oldPw = $('#cp_old').value;
        const newPw = $('#cp_new').value;
        const newPw2 = $('#cp_new2').value;
        if (!oldPw) throw new Error('请输入当前密码');
        if (newPw.length < 8) throw new Error('新密码至少 8 位');
        if (newPw !== newPw2) throw new Error('两次输入的新密码不一致');
        await api('POST', '/api/auth/password/change', {
          old_password: oldPw, new_password: newPw,
        });
        toast('密码已修改，下次登录请用新密码', 'ok');
      } },
    ]);
  },

  newUser() {
    modal('新建账号', `
      <div class="grid grid-2">
        <div class="field"><label>登录名<span class="req">*</span></label>
          <input class="input" id="nu_user" placeholder="3-32 位字母数字下划线"></div>
        <div class="field"><label>姓名<span class="req">*</span></label>
          <input class="input" id="nu_name"></div>
        <div class="field"><label>邮箱</label><input class="input" id="nu_email"></div>
        <div class="field"><label>手机号</label><input class="input" id="nu_phone"></div>
        <div class="field"><label>工号</label><input class="input" id="nu_job"></div>
        <div class="field"><label>角色</label>
          <select class="select" id="nu_role"><option value="user">普通用户</option><option value="admin">管理员</option></select></div>
      </div>
      <div class="field"><label>初始密码<span class="req">*</span></label>
        <input class="input" type="password" id="nu_pwd" autocomplete="new-password"></div>
      <div class="hint">至少 8 位，不能是纯数字或纯字母。管理员直接创建的账号<strong>立即生效</strong>，无需审批。</div>`, [
      { label: '取消', cls: 'btn' },
      { label: '创建', cls: 'btn btn-primary', onClick: async () => {
        const body = {
          username: $('#nu_user').value.trim(), name: $('#nu_name').value.trim(),
          email: $('#nu_email').value.trim(), phone: $('#nu_phone').value.trim(),
          job_no: $('#nu_job').value.trim(), role: $('#nu_role').value,
          password: $('#nu_pwd').value,
        };
        if (!body.username || !body.name) throw new Error('登录名与姓名必填');
        if (body.password.length < 8) throw new Error('密码至少 8 位');
        await api('POST', '/api/admin/users', body);
        toast('账号已创建', 'ok'); this.reload();
      } },
    ]);
  },

  /* ---------- 设置 ---------- */
  async loadSettings() {
    const s = (await api('GET', '/api/settings')).settings;
    const set = (id, v) => { const el = $(id); if (el) el.value = v == null ? '' : v; };
    set('#s_register_open', s.auth_register_open);
    set('#s_require_login', s.auth_require_login);
    set('#s_whitelist', s.auth_domain_whitelist);
    set('#s_code_ttl', s.auth_code_ttl);
    set('#s_code_resend', s.auth_code_resend);
    set('#s_fail_max', s.auth_login_fail_max);
    set('#s_session_hours', s.auth_session_hours);

    // 邮箱是唯一的验证码渠道：配不上，注册和找回密码就全断了，必须显眼地提示
    const mailReady = !!(s.mail_smtp_host && s.mail_smtp_user && s.mail_smtp_pass_set && s.mail_from);
    $('#mailState').innerHTML = mailReady
      ? '<span class="tag green">已配置</span>'
      : '<span class="tag red">未配置</span>';
    $('#mailAlert').innerHTML = mailReady ? '' :
      '<div class="alert warn"><b>验证码邮箱尚未配好。</b>在「系统设置 → 邮件」里填好 SMTP 与发件人之前，' +
      '用户无法自助注册，也无法自助找回密码——只能由管理员在后台建号。</div>';
  },

  async saveSettings() {
    const body = {
      auth_register_open: $('#s_register_open').value,
      auth_require_login: $('#s_require_login').value,
      auth_domain_whitelist: $('#s_whitelist').value.trim(),
      auth_code_ttl: Number($('#s_code_ttl').value) || 300,
      auth_code_resend: Number($('#s_code_resend').value) || 60,
      auth_login_fail_max: Number($('#s_fail_max').value) || 5,
      auth_session_hours: Number($('#s_session_hours').value) || 8,
    };
    await api('PUT', '/api/settings', body);
    toast('设置已保存', 'ok');
    this.loadSettings();
  },

  /* ---------- 日志 ---------- */
  async loadAudit() {
    const list = (await api('GET', '/api/admin/audit?limit=' + $('#auditLimit').value)).list;
    $('#auditList').innerHTML = list.length
      ? list.map((l) => `<div class="log-line">
          <span class="t">${esc(l.created_at)}</span>
          <span class="a">${esc(actionLabel(l.action))}</span>
          <span>${esc(l.actor_name || '')} → <b>${esc(l.target)}</b></span>
          <span class="muted">${esc(l.detail || '')}</span>
        </div>`).join('')
      : '<div class="empty">暂无日志</div>';
  },
};

const ACTION_LABEL = {
  register: '用户注册', approve: '通过注册', reject: '驳回注册', disable: '停用账号',
  enable: '启用账号', role_change: '角色变更', admin_reset_password: '管理员改密',
  reset_password: '重置密码', change_password: '修改密码', delete: '删除用户',
  create_user: '管理员建号', login: '登录', login_locked: '登录锁定', unlock: '解除锁定',
  init_super_admin: '初始化超管',
};
function actionLabel(a) { return ACTION_LABEL[a] || a; }

function debounce(fn, ms) {
  let t = null;
  return function () { clearTimeout(t); t = setTimeout(() => fn.apply(this, arguments), ms); };
}

function showLogin() {
  $('#adminWrap').classList.add('hidden');
  $('#loginWrap').classList.remove('hidden');
  $('#lgPass').value = '';
  $('#lgAccount').focus();
}

/* ---------- 登录 ---------- */
async function doLogin() {
  const account = $('#lgAccount').value.trim();
  const password = $('#lgPass').value;
  if (!account || !password) { toast('请输入账号和密码', 'warn'); return; }
  const btn = $('#btnLogin');
  btn.disabled = true; btn.textContent = '登录中…';
  try {
    await api('POST', '/api/auth/login', { account, password });
    const d = await api('GET', '/api/auth/me');
    Admin.me = d.user;
    if (Admin.me.role !== 'admin' && Admin.me.role !== 'super_admin') {
      $('#loginTip').innerHTML =
        '<div class="alert err">账号「' + esc(Admin.me.name) + '」不是管理员，无法进入后台。</div>';
      await api('POST', '/api/auth/logout').catch(() => ({}));
      return;
    }
    $('#loginTip').innerHTML = '';
    Admin.enter();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.disabled = false; btn.textContent = '登 录';
  }
}

on('#btnLogin', doLogin);
onEvt('#lgPass', 'onkeydown', (e) => { if (e.key === 'Enter') doLogin(); });
onEvt('#lgAccount', 'onkeydown', (e) => { if (e.key === 'Enter') $('#lgPass').focus(); });

Admin.boot();
