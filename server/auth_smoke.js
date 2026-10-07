'use strict';
/**
 * 账号体系冒烟测试：注册 → 审批 → 登录 → 权限 → 改密 → 清理
 *
 * 项目铁律：测试产生的数据绝不能留在系统里。
 * 因此清理逻辑放在 finally 中——即便中途断言失败，测试账号也会被删除，
 * 并在最后断言「系统中不存在任何测试账号」。
 *
 * 短信通道已移除，邮箱是唯一验证码渠道。测试不能真的往外发邮件，
 * 所以验证码用「直接往库里预置」的方式拿到：用与服务端相同的 scrypt 算法
 * 算出 code_hash 插进 verify_codes，注册/重置接口照常走 HTTP 校验——
 * 校验逻辑仍是真实的端到端，只是验证码的投递环节被替换掉了。
 *
 * 用法：先启动服务（node --experimental-sqlite index.js），
 *       再 node --experimental-sqlite auth_smoke.js
 */
const BASE = process.env.BASE || 'http://127.0.0.1:5180';

/** 预置一条已知验证码，返回它本身；失败返回 null（此时相关用例会如实失败） */
function seedCode(target, purpose, code) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const crypto = require('node:crypto');
    const path = require('node:path');
    const db = new DatabaseSync(path.join(__dirname, '..', 'data', 'reimburse.db'));
    const salt = crypto.randomBytes(12).toString('hex');
    const hash = crypto.scryptSync(String(code), salt, 32).toString('hex');
    // expires_at 与服务端 nowSql() 同格式：本地时间 'YYYY-MM-DD HH:MM:SS'
    const d = new Date(Date.now() + 10 * 60 * 1000);
    const p = (n) => String(n).padStart(2, '0');
    const exp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
      `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    db.prepare('DELETE FROM verify_codes WHERE target=? AND purpose=?').run(target, purpose);
    db.prepare(
      'INSERT INTO verify_codes(target,channel,purpose,code_hash,salt,expires_at,ip) VALUES(?,?,?,?,?,?,?)'
    ).run(target, 'email', purpose, hash, salt, exp, '127.0.0.1');
    db.close();
    return code;
  } catch (e) {
    console.log('  ! 预置验证码失败：' + e.message);
    return null;
  }
}

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra) : '')); }
}

async function req(method, path, body, cookie) {
  const res = await fetch(BASE + path, {
    method,
    headers: Object.assign(
      { 'Content-Type': 'application/json' },
      cookie ? { Cookie: 'sid=' + cookie } : {},
    ),
    // null 也必须当作「无 body」：JSON.stringify(null) 是 "null"，
    // 会让 GET 请求带上请求体，fetch 直接抛 Request with GET/HEAD method cannot have body
    body: (body === undefined || body === null) ? undefined : JSON.stringify(body),
  });
  const sc = res.headers.get('set-cookie') || '';
  const token = (sc.match(/sid=([^;]+)/) || [])[1] || null;
  const ct = res.headers.get('content-type') || '';
  let data = {};
  try { data = ct.includes('json') ? await res.json() : {}; } catch (e) { /* ignore */ }
  return { status: res.status, data, token, cleared: /sid=;/.test(sc) };
}

/** 测试账号统一用可识别前缀，便于清理与残留检查 */
const P = 'smoke';
const stamp = Date.now().toString().slice(-6);
const U_USER = `${P}_user${stamp}`;
const U_USER2 = `${P}_u2${stamp}`;
const U_USER3 = `${P}_u3${stamp}`;
const MAIL1 = `${P}_1_${stamp}@example.com`;
const MAIL2 = `${P}_2_${stamp}@example.com`;
const MAIL3 = `${P}_3_${stamp}@example.com`;
const PW = 'Smoke#2026';

/** 取超管初始密码（首次启动时写入 data/_admin_init.txt） */
function adminPassword() {
  if (process.env.SUPER_ADMIN_PASS) return process.env.SUPER_ADMIN_PASS;
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const f = path.join(__dirname, '..', 'data', '_admin_init.txt');
    const m = fs.readFileSync(f, 'utf8').match(/密码：(\S+)/);
    if (m) return m[1];
  } catch (e) { /* ignore */ }
  return process.env.ADMIN_PASS || '';
}

async function cleanAll(adminCookie) {
  const r = await req('GET', '/api/admin/users?keyword=' + P, null, adminCookie);
  const list = (r.data && r.data.data && r.data.data.list) || [];
  for (const u of list) {
    if (u.role === 'super_admin') continue;
    await req('DELETE', '/api/admin/users/' + u.id, null, adminCookie);
  }
  // 审计日志里的测试痕迹同样要清掉（target 是测试账号名，actor_name 含「冒烟」）
  await req('DELETE', '/api/admin/audit?keyword=' + P, null, adminCookie);
  await req('DELETE', '/api/admin/audit?keyword=' + encodeURIComponent('冒烟'), null, adminCookie);
  return list.length;
}

(async function main() {
  console.log('\n═══ 账号体系冒烟测试 ═══');
  console.log('目标：' + BASE + '\n');

  /* 先在最前面清一次历史残留：上一轮跑到一半失败也会留下数据 */
  let adminCookie = null;
  try {
    const pw = adminPassword();
    if (pw) {
      const l = await req('POST', '/api/auth/login', { account: 'admin', password: pw });
      if (l.token) { adminCookie = l.token; await cleanAll(adminCookie); }
    }
  } catch (e) { /* 服务未启用登录也能继续 */ }

  try {
    /* ---------- 1. 公开配置 ---------- */
    console.log('【1】公开配置与门禁');
    const cfg = await req('GET', '/api/auth/config');
    ok('GET /api/auth/config 可匿名访问', cfg.status === 200 && cfg.data.ok, cfg.data);

    const anon = await req('GET', '/api/admin/users');
    ok('匿名访问后台接口返回 401', anon.status === 401, { status: anon.status });

    const projAnon = await req('GET', '/api/projects');
    ok('匿名访问业务接口被登录门禁拦截', projAnon.status === 401 || projAnon.data.ok !== true,
      { status: projAnon.status });

    /* ---------- 2. 管理员登录 ---------- */
    console.log('\n【2】管理员登录与权限');
    const pw = adminPassword();
    if (!pw) throw new Error('取不到超管密码，请先启动一次服务生成 data/_admin_init.txt，或设 SUPER_ADMIN_PASS');
    const al = await req('POST', '/api/auth/login', { account: 'admin', password: pw });
    ok('超管登录成功并拿到会话', al.status === 200 && !!al.token, al.data);
    adminCookie = al.token;

    const badLogin = await req('POST', '/api/auth/login', { account: 'admin', password: 'wrong-password' });
    ok('错误密码返回 401', badLogin.status === 401, { status: badLogin.status });

    const stats = await req('GET', '/api/admin/stats', null, adminCookie);
    ok('管理员可读统计', stats.status === 200 && stats.data.ok, stats.data);
    ok('统计含待审批数', stats.data && stats.data.data && typeof stats.data.data.users.pending === 'number');

    /* ---------- 3. 注册（邮箱 + 预置验证码） ---------- */
    console.log('\n【3】注册与验证码');
    // 短信通道必须已经彻底移除：任何 phone 渠道都应被拒绝
    const phoneCh = await req('POST', '/api/auth/code/send', { channel: 'phone', target: '13900000000', purpose: 'register' });
    ok('短信渠道已移除（phone 被拒）', phoneCh.status === 400 || phoneCh.data.ok === false, phoneCh.data);

    const badMail = await req('POST', '/api/auth/code/send', { channel: 'email', target: 'not-an-email', purpose: 'register' });
    ok('非法邮箱不发验证码', badMail.status === 400 || badMail.data.ok === false, badMail.data);

    const code1 = seedCode(MAIL1, 'register', '100001');
    const regBad = await req('POST', '/api/auth/register', {
      username: U_USER, name: '冒烟用户', email: MAIL1, channel: 'email',
      password: PW, code: '000000',
    });
    ok('错误验证码无法注册', regBad.status === 400 || regBad.data.ok === false, regBad.data);

    const reg = await req('POST', '/api/auth/register', {
      username: U_USER, name: '冒烟用户', email: MAIL1, channel: 'email',
      password: PW, code: code1, reason: '冒烟测试',
    });
    ok('正确验证码注册成功', reg.status === 200 && reg.data.ok, reg.data);
    ok('非白名单账号进入待审批',
      reg.data && reg.data.data && reg.data.data.user && reg.data.data.user.status === 'pending',
      reg.data && reg.data.data);
    ok('注册渠道记为邮箱且邮箱已验证',
      reg.data && reg.data.data && reg.data.data.user &&
      reg.data.data.user.register_channel === 'email' && reg.data.data.user.email_verified === 1,
      reg.data && reg.data.data);

    // 重复用户名（换一个邮箱，避免命中「邮箱已注册」而掩盖登录名冲突这条断言）
    const code2 = seedCode(MAIL2, 'register', '100002');
    const dup = await req('POST', '/api/auth/register', {
      username: U_USER, name: '冒烟用户2', email: MAIL2, channel: 'email',
      password: PW, code: code2,
    });
    ok('重复登录名被拒', dup.status === 400 || dup.data.ok === false, dup.data);

    /* ---------- 4. 待审批账号不能登录 ---------- */
    console.log('\n【4】审批状态机');
    const pendLogin = await req('POST', '/api/auth/login', { account: U_USER, password: PW });
    ok('待审批账号无法登录', pendLogin.status === 401, { status: pendLogin.status });

    // 注册第二个账号用于驳回分支
    const code3 = seedCode(MAIL3, 'register', '100003');
    const reg2 = await req('POST', '/api/auth/register', {
      username: U_USER2, name: '冒烟用户2', email: MAIL3, channel: 'email',
      password: PW, code: code3,
    });
    ok('第二个账号注册成功', reg2.status === 200, reg2.data);

    const list = await req('GET', '/api/admin/users?status=pending', null, adminCookie);
    const pendList = (list.data && list.data.data && list.data.data.list) || [];
    const target = pendList.find((u) => u.username === U_USER);
    ok('待审批列表含新注册账号', !!target);

    const app = await req('POST', `/api/admin/users/${target.id}/approve`, {}, adminCookie);
    ok('管理员通过注册', app.status === 200 && app.data.ok, app.data);

    const rej2 = pendList.find((u) => u.username === U_USER2);
    const rej = await req('POST', `/api/admin/users/${rej2.id}/reject`, { reason: '冒烟驳回' }, adminCookie);
    ok('管理员驳回注册', rej.status === 200, rej.data);

    const rejLogin = await req('POST', '/api/auth/login', { account: U_USER2, password: PW });
    ok('被驳回账号无法登录', rejLogin.status === 401, { status: rejLogin.status });

    /* ---------- 5. 登录后访问业务接口 ---------- */
    console.log('\n【5】会话与权限');
    const ul = await req('POST', '/api/auth/login', { account: U_USER, password: PW });
    ok('已通过审批的账号可登录', ul.status === 200 && !!ul.token, ul.data);
    const userCookie = ul.token;

    const up = await req('GET', '/api/projects', null, userCookie);
    ok('普通用户可读业务数据', up.status === 200 && up.data.ok, { status: up.status });

    const ua = await req('GET', '/api/admin/users', null, userCookie);
    ok('普通用户访问后台接口返回 403', ua.status === 403, { status: ua.status });

    const me = await req('GET', '/api/auth/me', null, userCookie);
    ok('GET /api/auth/me 返回当前用户', me.status === 200 && me.data.data.user.username === U_USER, me.data);

    /* ---------- 6. 登录失败锁定 ---------- */
    console.log('\n【6】登录失败锁定');
    // 用一个专门的账号试，避免把后面还要用的账号锁住
    const cu6 = await req('POST', '/api/admin/users', {
      username: U_USER3, name: '冒烟锁定测试', password: PW,
    }, adminCookie);
    ok('管理员建号成功', cu6.status === 200, cu6.data);
    const uid3 = cu6.data.data && cu6.data.data.user && cu6.data.data.user.id;

    let lockedMsg = '';
    for (let i = 0; i < 6; i++) {
      const r = await req('POST', '/api/auth/login', { account: U_USER3, password: 'definitely-wrong' });
      if (/锁定/.test((r.data && r.data.error) || '')) { lockedMsg = r.data.error; break; }
    }
    ok('连续错误密码触发锁定', !!lockedMsg, { lockedMsg });

    const lockedLogin = await req('POST', '/api/auth/login', { account: U_USER3, password: PW });
    ok('锁定期间正确密码也被拒', lockedLogin.status === 401, { status: lockedLogin.status });

    const unlock = await req('POST', `/api/admin/users/${uid3}/unlock`, {}, adminCookie);
    ok('管理员可解除锁定', unlock.status === 200, unlock.data);
    const afterUnlock = await req('POST', '/api/auth/login', { account: U_USER3, password: PW });
    ok('解锁后恢复正常登录', afterUnlock.status === 200 && !!afterUnlock.token, { status: afterUnlock.status });

    /* ---------- 7. 改密与重置 ---------- */
    console.log('\n【7】改密与重置');
    const NEW = 'Smoke#2027';
    const chg = await req('POST', '/api/auth/password/change',
      { old_password: PW, new_password: NEW }, userCookie);
    ok('已登录用户可改密', chg.status === 200 && chg.data.ok, chg.data);

    const chgBad = await req('POST', '/api/auth/password/change',
      { old_password: 'wrong12345', new_password: NEW }, userCookie);
    ok('错误的当前密码改密失败', chgBad.status === 400 || chgBad.data.ok === false, chgBad.data);

    // 改密后旧密码失效、新密码可用
    const oldLogin = await req('POST', '/api/auth/login', { account: U_USER, password: PW });
    ok('旧密码已失效', oldLogin.status === 401, { status: oldLogin.status });
    const newLogin = await req('POST', '/api/auth/login', { account: U_USER, password: NEW });
    ok('新密码可登录', newLogin.status === 200 && !!newLogin.token, newLogin.data);

    // 重置只能用邮箱：手机号不再受理（无短信通道，无法投递验证码）
    const resetByPhone = await req('POST', '/api/auth/password/reset',
      { channel: 'phone', target: '13900000000', code: '000000', password: PW });
    ok('手机号无法重置密码', resetByPhone.status === 400 || resetByPhone.data.ok === false, resetByPhone.data);

    const rcode = seedCode(MAIL1, 'reset', '200001');
    ok('预置重置密码验证码', !!rcode);
    const rp = await req('POST', '/api/auth/password/reset',
      { channel: 'email', target: MAIL1, code: rcode, password: PW });
    ok('凭验证码重置密码', rp.status === 200 && rp.data.ok, rp.data);

    /* ---------- 8. 停用 / 启用 / 角色 ---------- */
    console.log('\n【8】管理员状态变更与角色');
    const dis = await req('POST', `/api/admin/users/${uid3}/disable`, { reason: '冒烟' }, adminCookie);
    ok('停用账号', dis.status === 200, dis.data);
    const disLogin = await req('POST', '/api/auth/login', { account: U_USER3, password: PW });
    ok('停用后无法登录', disLogin.status === 401, { status: disLogin.status });
    const en = await req('POST', `/api/admin/users/${uid3}/enable`, {}, adminCookie);
    ok('重新启用账号', en.status === 200, en.data);

    const role = await req('POST', `/api/admin/users/${uid3}/role`, { role: 'admin' }, adminCookie);
    ok('提升为管理员', role.status === 200, role.data);
    const newAdminLogin = await req('POST', '/api/auth/login', { account: U_USER3, password: PW });
    ok('新管理员可登录', newAdminLogin.status === 200, { status: newAdminLogin.status });
    const newAdminStats = await req('GET', '/api/admin/stats', null, newAdminLogin.token);
    ok('新管理员可访问后台', newAdminStats.status === 200, { status: newAdminStats.status });

    // 上一节重置过密码，旧会话应已被踢掉（这正是「改密后强制下线」的预期行为）
    const stale = await req('GET', '/api/auth/me', null, userCookie);
    ok('重置密码后旧会话被踢下线', stale.status === 401, { status: stale.status });

    // 重新登录后验证越权：普通用户访问管理员接口应 403（已登录但权限不足）
    const reLogin = await req('POST', '/api/auth/login', { account: U_USER, password: PW });
    const freshCookie = reLogin.token;
    const selfRole = await req('POST', `/api/admin/users/${uid3}/role`, { role: 'user' }, freshCookie);
    ok('普通用户越权改角色被拦（403）', selfRole.status === 403, { status: selfRole.status });

    /* ---------- 8.5 编辑资料（补邮箱是刚需） ---------- */
    console.log('\n【8.5】管理员编辑用户资料');
    const pf = await req('POST', `/api/admin/users/${uid3}/profile`,
      { name: '冒烟用户丙', email: 'smoke.profile@example.com', phone: '13900000003', job_no: '099003' }, adminCookie);
    ok('编辑资料成功', pf.status === 200 && pf.data.ok, pf.data);

    // 注意：req() 返回的是整个响应体，取值要 data.data.user，不是 data.user
    const pfGet = await req('GET', `/api/admin/users/${uid3}`, null, adminCookie);
    const pfU = pfGet.data && pfGet.data.data && pfGet.data.data.user;
    ok('邮箱已写入并视为已核实', !!pfU && pfU.email === 'smoke.profile@example.com' && pfU.email_verified === 1, pfU);
    ok('手机与工号已写入', !!pfU && pfU.phone === '13900000003' && pfU.job_no === '099003', pfU);

    const pfBadMail = await req('POST', `/api/admin/users/${uid3}/profile`,
      { name: '丙', email: 'not-a-mail' }, adminCookie);
    ok('非法邮箱格式被拒', pfBadMail.status === 400 || pfBadMail.data.ok === false, pfBadMail.data);

    // 必须用真正属于别人的邮箱：MAIL2 从未落库（那次注册因登录名重复被拒），
    // 用它测不出冲突；MAIL1 才是 U_USER 的。
    const pfDup = await req('POST', `/api/admin/users/${uid3}/profile`,
      { name: '丙', email: MAIL1 }, adminCookie);
    ok('与他人重复的邮箱被拒', pfDup.status === 400 || pfDup.data.ok === false, pfDup.data);

    const pfNoName = await req('POST', `/api/admin/users/${uid3}/profile`,
      { name: '', email: 'x@y.com' }, adminCookie);
    ok('姓名为空被拒', pfNoName.status === 400 || pfNoName.data.ok === false, pfNoName.data);

    // 登录名不可改：即便误传也应当被忽略
    const pfKeepName = await req('POST', `/api/admin/users/${uid3}/profile`,
      { name: '冒烟用户丙', username: 'hacked', email: 'smoke.profile@example.com' }, adminCookie);
    const pfAfter = await req('GET', `/api/admin/users/${uid3}`, null, adminCookie);
    ok('登录名未被篡改', pfKeepName.status === 200 &&
      pfAfter.data.data.user.username === U_USER3, pfAfter.data && pfAfter.data.data);

    /* ---------- 9. 登出 ---------- */
    console.log('\n【9】登出');
    const lo = await req('POST', '/api/auth/logout', {}, userCookie);
    ok('登出成功', lo.status === 200, lo.data);
    const after = await req('GET', '/api/auth/me', null, userCookie);
    ok('登出后会话失效', after.status === 401, { status: after.status });

  } catch (e) {
    fail++;
    console.log('\n  ✗ 未捕获异常：' + (e && e.message ? e.message : e));
  } finally {
    /* ---------- 清理：无论成败都要删干净 ---------- */
    console.log('\n【清理】删除测试账号');
    try {
      const n = await cleanAll(adminCookie);
      console.log('  删除测试账号：' + n + ' 个');
      const left = await req('GET', '/api/admin/users?keyword=' + P, null, adminCookie);
      const remain = (left.data && left.data.data && left.data.data.list) || [];
      const nonAdmin = remain.filter((u) => u.role !== 'super_admin');
      ok('系统内无测试账号残留', nonAdmin.length === 0, remain.map((u) => u.username));

      // 审计日志同样不能有测试痕迹（清理动作自身的留痕除外）
      const logs = await req('GET', '/api/admin/audit?limit=1000', null, adminCookie);
      const all = (logs.data && logs.data.data && logs.data.data.list) || [];
      const dirty = all.filter((l) =>
        l.action !== 'clear_audit' && (new RegExp(P).test(l.target || '') || /冒烟/.test(l.actor_name || '')));
      ok('审计日志无测试痕迹残留', dirty.length === 0, dirty.slice(0, 3).map((l) => l.action + '/' + l.target));
    } catch (e) {
      fail++;
      console.log('  ✗ 清理失败：' + (e && e.message ? e.message : e));
    }
  }

  console.log('\n═══ 结果：通过 ' + pass + ' / 失败 ' + fail + ' ═══\n');
  process.exit(fail ? 1 : 0);
})();
