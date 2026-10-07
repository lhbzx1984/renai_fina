'use strict';
/**
 * 账号体系：注册（邮箱/手机验证码） → 管理员审批 → 登录 → 会话 → 权限
 *
 * 设计要点：
 * 1. 密码用 scrypt（Node 内置），每账号独立盐，校验走 timingSafeEqual 常量时间比较。
 * 2. 验证码只存哈希，且绑定 purpose（register/login/reset）—— 否则「注册收到的码」
 *    能被拿去重置他人密码。
 * 3. 会话 token 是 32 字节随机数，存库而非签名 Cookie，服务端可即时吊销（禁用账号即刻生效）。
 * 4. 管理员的每一次写操作都留审计日志。
 */
const crypto = require('node:crypto');
const { db, getSetting, setSetting } = require('./db');
const mailer = require('./mailer');

const SESSION_COOKIE = 'sid';
const CODE_ATTEMPT_MAX = 5;
/** 同一 IP 每小时最多发多少条验证码（防短信轰炸——短信是按条计费的） */
const IP_HOURLY_MAX = 20;
const ORG_NAME = () => getSetting('org_name') || '天津仁爱学院';

/* ---------------- 工具 ---------------- */
function nowSql(offsetSec = 0) {
  const d = new Date(Date.now() + offsetSec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) { crypto.timingSafeEqual(ba, ba); return false; }
  return crypto.timingSafeEqual(ba, bb);
}

/** 6 位数字验证码。用 crypto.randomInt 而非 Math.random——后者可预测 */
function genCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function hashSecret(plain, salt, len = 64) {
  return crypto.scryptSync(String(plain), salt, len).toString('hex');
}

/* ---------------- 密码 ---------------- */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { hash: hashSecret(password, salt), salt };
}
function verifyPassword(password, hash, salt) {
  if (!hash || !salt) return false;
  return safeEqual(hashSecret(password, salt), hash);
}

/** 密码强度：至少 8 位，且不能是纯数字/纯字母 */
function checkPassword(pw) {
  const s = String(pw || '');
  if (s.length < 8) return '密码至少 8 位';
  if (s.length > 64) return '密码最长 64 位';
  if (/^\d+$/.test(s)) return '密码不能全是数字';
  if (/^[a-zA-Z]+$/.test(s)) return '密码应包含数字或字母以外的组合';
  return null;
}

/* ---------------- 输入校验 ---------------- */
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^1[3-9]\d{9}$/;

function normEmail(v) { return String(v || '').trim().toLowerCase(); }
function normPhone(v) { return String(v || '').trim().replace(/[\s-]/g, ''); }

/* ---------------- Cookie 与会话 ---------------- */
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function clientIp(req) {
  // 经 Nginx 反代时取真实来源；否则用直连地址
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || '';
}

function createSession(userId, req) {
  const hours = Number(getSetting('auth_session_hours')) || 8;
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(
    'INSERT INTO sessions(token,user_id,expires_at,ip,user_agent) VALUES(?,?,?,?,?)'
  ).run(token, userId, nowSql(hours * 3600), clientIp(req), String(req.headers['user-agent'] || '').slice(0, 200));
  return { token, maxAge: hours * 3600 };
}

function sessionCookie(token, maxAge) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  return parts.join('; ');
}
const CLEAR_COOKIE = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

/** 取当前登录用户（含过期清理）；未登录返回 null */
function userFromRequest(req) {
  /* 机器令牌通道：AI 助手的命令行工具没有浏览器 Cookie，
     用 Authorization: Bearer <AI_API_TOKEN> 以超管身份访问票据队列。
     未设置该环境变量时这条通道关闭，不会留下后门。 */
  const machineToken = process.env.AI_API_TOKEN || '';
  if (machineToken) {
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (bearer && safeEqual(bearer, machineToken)) {
      return db.prepare("SELECT * FROM users WHERE role='super_admin' ORDER BY id LIMIT 1").get() || null;
    }
  }

  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const row = db.prepare(
    `SELECT s.token, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ?`
  ).get(token);
  if (!row) return null;
  if (row.expires_at && row.expires_at < nowSql()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  // 会话还活着，但账号中途被停用/驳回 —— 立即失效，避免「禁用后仍能操作」
  if (row.status !== 'active') {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return row;
}

function destroySession(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/**
 * 业务接口是否要求登录。AI 机器接口走 Bearer 令牌豁免——它们由本机可信调用方发起，
 * 没有浏览器 Cookie 可用。
 */
function isMachineRequest(req) {
  const p = String((req.url || '').split('?')[0]);
  if (!p.startsWith('/api/ai/')) return false;
  const bearer = String(req.headers.authorization || '');
  return /^Bearer\s+\S+/i.test(bearer);
}

/** 清理过期会话与验证码，服务启动时跑一次 */
function purgeExpired() {
  const t = nowSql();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(t);
  db.prepare("DELETE FROM verify_codes WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < datetime('now','localtime','-1 day'))").run(t);
}

/* ---------------- 审计 ---------------- */
function audit(actor, action, target, detail, ip) {
  try {
    db.prepare(
      'INSERT INTO audit_logs(actor_id,actor_name,action,target,detail,ip) VALUES(?,?,?,?,?,?)'
    ).run(actor ? actor.id : null, actor ? actor.name : '系统', action, String(target == null ? '' : target),
      String(detail == null ? '' : detail).slice(0, 500), ip || '');
  } catch (e) { /* 审计失败不能影响主流程 */ }
}

/* ---------------- 验证码 ---------------- */
/**
 * 发送验证码（邮箱渠道）。
 *
 * 短信验证码已整体移除：国内短信要求企业资质 + 签名备案 + 模板审核，
 * 学校场景走不通，与其留一套永远配不上的死代码，不如彻底清掉。
 * 邮箱走已配好的 SMTP，配不上就如实报错，不做「回显验证码」的降级——
 * 那等于把验证码公开在页面上。
 */
async function sendCode({ channel, target, purpose, ip }) {
  if (channel && channel !== 'email') return { ok: false, error: '仅支持邮箱验证码' };
  const ttl = Number(getSetting('auth_code_ttl')) || 300;
  const resend = Number(getSetting('auth_code_resend')) || 60;

  const email = normEmail(target);
  const to = email;
  if (!EMAIL_RE.test(email)) return { ok: false, error: '邮箱格式不正确' };

  // 冷却：同一目标+用途在 resend 秒内只能发一次
  const last = db.prepare(
    'SELECT created_at FROM verify_codes WHERE target=? AND purpose=? ORDER BY id DESC LIMIT 1'
  ).get(to, purpose);
  if (last && last.created_at > nowSql(-resend)) {
    return { ok: false, error: `请 ${resend} 秒后再试` };
  }
  // 防轰炸：同一 IP 一小时内上限
  const cnt = db.prepare(
    "SELECT COUNT(*) AS n FROM verify_codes WHERE ip=? AND created_at > datetime('now','localtime','-1 hour')"
  ).get(ip || '').n;
  if (cnt >= IP_HOURLY_MAX) return { ok: false, error: '发送过于频繁，请稍后再试' };

  const code = genCode();
  const salt = crypto.randomBytes(12).toString('hex');
  db.prepare(
    'INSERT INTO verify_codes(target,channel,purpose,code_hash,salt,expires_at,ip) VALUES(?,?,?,?,?,?,?)'
  ).run(to, 'email', purpose, hashSecret(code, salt, 32), salt, nowSql(ttl), ip || '');

  const out = { ok: true, channel: 'email', target: to, ttl, wait: resend };

  try {
    await sendCodeMail(email, code, purpose);
    out.sent = true;
  } catch (e) {
    // 邮件发不出去不能让验证码白占额度，直接作废并如实报错
    db.prepare('DELETE FROM verify_codes WHERE target=? AND purpose=? AND code_hash=?')
      .run(to, purpose, hashSecret(code, salt, 32));
    return { ok: false, error: '验证码邮件发送失败：' + e.message };
  }
  return out;
}

const PURPOSE_TEXT = {
  register: '注册账号', login: '登录', reset: '重置密码', bind: '绑定联系方式',
};

async function sendCodeMail(email, code, purpose) {
  const s = {
    host: getSetting('mail_smtp_host'), port: Number(getSetting('mail_smtp_port')) || 465,
    secure: getSetting('mail_smtp_secure') !== '0',
    user: getSetting('mail_smtp_user'), pass: getSetting('mail_smtp_pass'),
  };
  return mailer.sendMail(s, {
    from: getSetting('mail_from') || s.user,
    fromName: getSetting('mail_from_name') || ORG_NAME(),
    to: email,
    subject: `【${ORG_NAME()}】${PURPOSE_TEXT[purpose] || '操作'}验证码`,
    text:
      `您好：\n\n` +
      `您正在进行「${PURPOSE_TEXT[purpose] || '操作'}」，验证码为：\n\n` +
      `    ${code}\n\n` +
      `验证码 ${Math.round((Number(getSetting('auth_code_ttl')) || 300) / 60)} 分钟内有效。` +
      `如非本人操作，请忽略此邮件。\n\n${ORG_NAME()} 报销管理系统`,
  });
}

/** 校验验证码。成功即作废（一次性） */
function checkCode({ channel, target, purpose, code }) {
  const to = normEmail(target);
  const row = db.prepare(
    `SELECT * FROM verify_codes WHERE target=? AND purpose=? AND used_at IS NULL
     ORDER BY id DESC LIMIT 1`
  ).get(to, purpose);
  if (!row) return { ok: false, error: '请先获取验证码' };
  if (row.channel !== channel) return { ok: false, error: '验证渠道不匹配' };
  if (row.expires_at < nowSql()) return { ok: false, error: '验证码已过期，请重新获取' };
  if (row.attempts >= CODE_ATTEMPT_MAX) return { ok: false, error: '验证码错误次数过多，请重新获取' };

  if (!safeEqual(hashSecret(code, row.salt, 32), row.code_hash)) {
    db.prepare('UPDATE verify_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    return { ok: false, error: '验证码不正确' };
  }
  db.prepare("UPDATE verify_codes SET used_at = datetime('now','localtime') WHERE id = ?").run(row.id);
  return { ok: true };
}

/* ---------------- 注册 ---------------- */
function isWhitelisted(email) {
  const list = String(getSetting('auth_domain_whitelist') || '')
    .split(/[,，;\s]+/).map((s) => s.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
  if (!list.length) return false;
  const domain = String(email || '').split('@')[1] || '';
  return list.includes(domain.toLowerCase());
}

function publicUser(u) {
  if (!u) return null;
  const { password_hash, password_salt, ...rest } = u;
  return rest;
}

/**
 * 注册。邮箱命中域名白名单 → 直接 active；否则进 pending 待管理员审批。
 */
function register(body, req) {
  if (getSetting('auth_register_open') !== '1') {
    return { ok: false, error: '当前未开放注册，请联系管理员开通账号' };
  }
  const username = String(body.username || '').trim();
  const name = String(body.name || '').trim();
  const password = String(body.password || '');
  const email = normEmail(body.email);
  // 手机号只是可选的联系资料，不再作为验证渠道（短信通道已移除）
  const phone = normPhone(body.phone);
  const code = String(body.code || '').trim();

  if (!USERNAME_RE.test(username)) return { ok: false, error: '登录名需为 3-32 位字母、数字、下划线、点或连字符' };
  if (!name || name.length > 32) return { ok: false, error: '请填写真实姓名（32 字以内）' };
  const pwErr = checkPassword(password);
  if (pwErr) return { ok: false, error: pwErr };

  if (!EMAIL_RE.test(email)) return { ok: false, error: '邮箱格式不正确' };
  if (phone && !PHONE_RE.test(phone)) return { ok: false, error: '手机号格式不正确' };
  if (!code) return { ok: false, error: '请填写验证码' };

  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    return { ok: false, error: '该登录名已被使用' };
  }
  if (email && db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    return { ok: false, error: '该邮箱已被注册' };
  }
  if (phone && db.prepare('SELECT id FROM users WHERE phone = ?').get(phone)) {
    return { ok: false, error: '该手机号已被注册' };
  }

  const v = checkCode({ channel: 'email', target: email, purpose: 'register', code });
  if (!v.ok) return v;

  const auto = isWhitelisted(email);
  const { hash, salt } = hashPassword(password);
  const info = db.prepare(
    `INSERT INTO users(username,name,email,phone,job_no,password_hash,password_salt,role,status,
      email_verified,phone_verified,register_channel,register_reason)
     VALUES(?,?,?,?,?,?,?,'user',?,?,?,?,?)`
  ).run(
    username, name, email || null, phone || null, String(body.job_no || '').trim() || null,
    hash, salt,
    auto ? 'active' : 'pending',
    1,   // 邮箱已完成验证码校验
    0,   // 无短信通道，手机号永远是「未验证」，仅作联系资料
    'email',
    String(body.reason || '').trim().slice(0, 200) || null,
  );
  const id = info.lastInsertRowid;
  audit(null, 'register', username, `渠道=邮箱 目标=${email} ${auto ? '白名单自动通过' : '待审批'}`, clientIp(req));

  return {
    ok: true,
    auto_approved: auto,
    user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)),
  };
}

/* ---------------- 登录 / 登出 ---------------- */
function findByAccount(account) {
  const a = String(account || '').trim();
  if (!a) return null;
  const low = a.toLowerCase();
  return db.prepare(
    'SELECT * FROM users WHERE username = ? OR email = ? OR phone = ?'
  ).get(a, low, normPhone(a)) || null;
}

function login(body, req) {
  const account = String(body.account || '').trim();
  const password = String(body.password || '');
  const ip = clientIp(req);
  if (!account || !password) return { ok: false, error: '请输入账号和密码' };

  const u = findByAccount(account);
  // 账号不存在时也走一次哈希校验，避免「响应快慢」泄露账号是否存在
  if (!u) {
    hashPassword(password);
    return { ok: false, error: '账号或密码不正确' };
  }

  if (u.locked_until && u.locked_until > nowSql()) {
    return { ok: false, error: `账号已被锁定，请 ${Math.ceil((new Date(u.locked_until.replace(' ', 'T')) - Date.now()) / 60000)} 分钟后再试` };
  }
  if (u.status === 'pending') return { ok: false, error: '账号已提交，请等待管理员审批' };
  if (u.status === 'rejected') return { ok: false, error: `注册申请未通过${u.reject_reason ? '：' + u.reject_reason : ''}` };
  if (u.status === 'disabled') return { ok: false, error: '账号已被停用，请联系管理员' };

  if (!verifyPassword(password, u.password_hash, u.password_salt)) {
    const maxFail = Number(getSetting('auth_login_fail_max')) || 5;
    const lockMin = Number(getSetting('auth_lock_minutes')) || 15;
    const n = (u.login_fail_count || 0) + 1;
    if (n >= maxFail) {
      db.prepare("UPDATE users SET login_fail_count=0, locked_until=? WHERE id=?")
        .run(nowSql(lockMin * 60), u.id);
      audit(u, 'login_locked', u.username, `连续失败 ${n} 次`, ip);
      return { ok: false, error: `密码错误次数过多，账号已锁定 ${lockMin} 分钟` };
    }
    db.prepare('UPDATE users SET login_fail_count=? WHERE id=?').run(n, u.id);
    return { ok: false, error: `账号或密码不正确（还可尝试 ${maxFail - n} 次）` };
  }

  db.prepare("UPDATE users SET login_fail_count=0, locked_until=NULL, last_login_at=datetime('now','localtime'), last_login_ip=? WHERE id=?")
    .run(ip, u.id);
  const s = createSession(u.id, req);
  audit(u, 'login', u.username, '', ip);
  return {
    ok: true, token: s.token, maxAge: s.maxAge,
    user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)),
  };
}

function logout(req) { destroySession(req); return { ok: true }; }

/* ---------------- 密码重置 ---------------- */
function resetPassword(body, req) {
  const target = normEmail(body.target);
  const code = String(body.code || '').trim();
  const password = String(body.password || '');
  const pwErr = checkPassword(password);
  if (pwErr) return { ok: false, error: pwErr };

  // 只认邮箱：没有短信通道，手机号无法接收验证码，不能作为找回凭据
  if (!EMAIL_RE.test(target)) return { ok: false, error: '邮箱格式不正确' };
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(target);
  if (!u) return { ok: false, error: '该邮箱未注册' };

  const v = checkCode({ channel: 'email', target, purpose: 'reset', code });
  if (!v.ok) return v;

  const { hash, salt } = hashPassword(password);
  db.prepare("UPDATE users SET password_hash=?, password_salt=?, login_fail_count=0, locked_until=NULL, updated_at=datetime('now','localtime') WHERE id=?")
    .run(hash, salt, u.id);
  // 重置后踢掉所有会话：疑似账号泄露后的标准动作
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  audit(u, 'reset_password', u.username, '渠道=邮箱', clientIp(req));
  return { ok: true };
}

/**
 * @param {string} [currentToken] 当前会话 token——改密后要保留它，其余会话全部吊销。
 *   为什么：改密最常见的动机就是「怀疑密码泄露了」，只改密码不踢人等于没关门。
 */
function changePassword(user, body, currentToken) {
  const oldPw = String(body.old_password || '');
  const newPw = String(body.new_password || '');
  if (!verifyPassword(oldPw, user.password_hash, user.password_salt)) {
    return { ok: false, error: '当前密码不正确' };
  }
  const pwErr = checkPassword(newPw);
  if (pwErr) return { ok: false, error: pwErr };
  const { hash, salt } = hashPassword(newPw);
  db.prepare("UPDATE users SET password_hash=?, password_salt=?, updated_at=datetime('now','localtime') WHERE id=?")
    .run(hash, salt, user.id);

  let kicked = 0;
  if (currentToken) {
    const r = db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(user.id, currentToken);
    kicked = r.changes;
  }
  audit(user, 'change_password', user.username, '', kicked ? `吊销其他会话 ${kicked} 个` : '');
  // 改密后初始密码文件即失效：留着它等于把旧凭证明文摊在磁盘上，顺手删掉
  dropAdminInitFile(user.username);
  return { ok: true, kicked };
}

/** 取请求里的会话 token（供改密时保留当前会话） */
function tokenFromRequest(req) {
  return parseCookies(req)[SESSION_COOKIE] || '';
}

/**
 * 删除 data/_admin_init.txt —— 但只在这个文件记的就是本人才删。
 *
 * 为什么不无条件删：文件里写的是超管的初始随机密码。若某个普通教师改了自己的密码
 * 就把文件删掉，而超管此时还没登录过，那串唯一的初始密码就再也找不回来了，只能重置库。
 * 所以按「文件里的登录名 == 改密者」匹配，才既清掉了过期明文凭证，又不误伤。
 */
function dropAdminInitFile(username) {
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const { DATA_DIR } = require('./db');
    const file = path.join(DATA_DIR, '_admin_init.txt');
    if (!fs.existsSync(file)) return;
    const m = fs.readFileSync(file, 'utf8').match(/登录名：(\S+)/);
    if (m && m[1] === username) fs.unlinkSync(file);
  } catch (e) { /* 删不掉不影响主流程 */ }
}

/* ---------------- 管理员：用户管理 ---------------- */
function listUsers(q = {}) {
  const where = [];
  const args = [];
  if (q.status) { where.push('u.status = ?'); args.push(q.status); }
  if (q.role) { where.push('u.role = ?'); args.push(q.role); }
  if (q.keyword) {
    where.push('(u.username LIKE ? OR u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ? OR u.job_no LIKE ?)');
    const k = `%${q.keyword}%`;
    args.push(k, k, k, k, k);
  }
  const sql =
    `SELECT u.id,u.username,u.name,u.email,u.phone,u.job_no,u.role,u.status,
            u.email_verified,u.phone_verified,u.register_channel,u.register_reason,
            u.reject_reason,u.created_at,u.approved_at,u.last_login_at,
            c.name AS college_name, m.name AS major_name, ap.name AS approved_by_name
     FROM users u
     LEFT JOIN colleges c ON c.id = u.college_id
     LEFT JOIN majors m ON m.id = u.major_id
     LEFT JOIN users ap ON ap.id = u.approved_by
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY CASE u.status WHEN 'pending' THEN 0 ELSE 1 END, u.id DESC`;
  const rows = db.prepare(sql).all(...args);
  return rows.map(publicUser);
}

function getUser(id) {
  return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id)));
}

function stats() {
  const one = (sql, ...a) => db.prepare(sql).get(...a).n;
  return {
    total: one('SELECT COUNT(*) AS n FROM users'),
    pending: one("SELECT COUNT(*) AS n FROM users WHERE status='pending'"),
    active: one("SELECT COUNT(*) AS n FROM users WHERE status='active'"),
    disabled: one("SELECT COUNT(*) AS n FROM users WHERE status='disabled'"),
    rejected: one("SELECT COUNT(*) AS n FROM users WHERE status='rejected'"),
    admin: one("SELECT COUNT(*) AS n FROM users WHERE role IN ('admin','super_admin')"),
    sessions: one("SELECT COUNT(*) AS n FROM sessions WHERE expires_at > datetime('now','localtime')"),
  };
}

function adminAction(actor, id, action, body, req) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
  if (!u) return { ok: false, error: '用户不存在' };
  const ip = clientIp(req);
  const t = () => "datetime('now','localtime')";

  // 超管不能被别人改动；超管自己也不能把自己降级（防止系统变成无管理员状态）
  const isSuper = u.role === 'super_admin';
  if (isSuper && actor.id !== u.id) return { ok: false, error: '不能操作超级管理员账号' };

  switch (action) {
    case 'approve':
      if (u.status === 'active') return { ok: false, error: '该账号已是正常状态' };
      db.prepare(`UPDATE users SET status='active', approved_by=?, approved_at=${t()}, reject_reason=NULL, updated_at=${t()} WHERE id=?`)
        .run(actor.id, u.id);
      audit(actor, 'approve', u.username, '', ip);
      return { ok: true, message: '已通过', user: getUser(u.id) };

    case 'reject':
      if (u.status === 'rejected') return { ok: false, error: '该账号已被驳回' };
      const reason = String((body && body.reason) || '').trim().slice(0, 200);
      db.prepare(`UPDATE users SET status='rejected', reject_reason=?, approved_by=?, approved_at=${t()}, updated_at=${t()} WHERE id=?`)
        .run(reason || null, actor.id, u.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
      audit(actor, 'reject', u.username, reason, ip);
      return { ok: true, message: '已驳回', user: getUser(u.id) };

    case 'disable':
      if (u.status === 'disabled') return { ok: false, error: '该账号已停用' };
      db.prepare(`UPDATE users SET status='disabled', updated_at=${t()} WHERE id=?`).run(u.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
      audit(actor, 'disable', u.username, String((body && body.reason) || '').slice(0, 200), ip);
      return { ok: true, message: '已停用', user: getUser(u.id) };

    case 'enable':
      if (u.status === 'active') return { ok: false, error: '该账号已是正常状态' };
      db.prepare(`UPDATE users SET status='active', reject_reason=NULL, updated_at=${t()} WHERE id=?`).run(u.id);
      audit(actor, 'enable', u.username, '', ip);
      return { ok: true, message: '已启用', user: getUser(u.id) };

    case 'role': {
      const role = String((body && body.role) || '');
      if (!['user', 'admin'].includes(role)) return { ok: false, error: '角色只能是 user 或 admin' };
      if (u.role === role) return { ok: false, error: '角色未变化' };
      if (u.role === 'super_admin') return { ok: false, error: '不能修改超级管理员角色' };
      db.prepare(`UPDATE users SET role=?, updated_at=${t()} WHERE id=?`).run(role, u.id);
      audit(actor, 'role_change', u.username, `${u.role} → ${role}`, ip);
      return { ok: true, message: '角色已更新', user: getUser(u.id) };
    }

    case 'reset_password': {
      const pw = String((body && body.password) || '');
      const pwErr = checkPassword(pw);
      if (pwErr) return { ok: false, error: pwErr };
      const { hash, salt } = hashPassword(pw);
      db.prepare(`UPDATE users SET password_hash=?, password_salt=?, login_fail_count=0, locked_until=NULL, updated_at=${t()} WHERE id=?`)
        .run(hash, salt, u.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
      audit(actor, 'admin_reset_password', u.username, '', ip);
      return { ok: true, message: '密码已重置' };
    }

    case 'unlock':
      db.prepare(`UPDATE users SET login_fail_count=0, locked_until=NULL, updated_at=${t()} WHERE id=?`).run(u.id);
      audit(actor, 'unlock', u.username, '', ip);
      return { ok: true, message: '已解除锁定', user: getUser(u.id) };

    /* 编辑资料：姓名 / 邮箱 / 手机 / 工号。
       补邮箱是刚需 —— 短信通道已下线，邮箱为空的用户无法自助找回密码。
       登录名不改：审计日志按登录名留痕，改了历史就对不上了。
       管理员录入视为已核实（与 createUserByAdmin 的口径一致）。 */
    case 'profile': {
      const name = String((body && body.name) || '').trim();
      if (!name) return { ok: false, error: '请填写姓名' };
      const email = normEmail(body.email);
      const phone = normPhone(body.phone);
      if (email && !EMAIL_RE.test(email)) return { ok: false, error: '邮箱格式不正确' };
      if (phone && !PHONE_RE.test(phone)) return { ok: false, error: '手机号格式不正确' };
      const dup = (col, val) => db.prepare(`SELECT id FROM users WHERE ${col} = ? AND id <> ?`).get(val, u.id);
      if (email && dup('email', email)) return { ok: false, error: '该邮箱已被其他账号使用' };
      if (phone && dup('phone', phone)) return { ok: false, error: '该手机号已被其他账号使用' };
      const jobNo = String((body && body.job_no) || '').trim() || null;
      db.prepare(`UPDATE users SET name=?, email=?, phone=?, job_no=?,
                    email_verified=?, phone_verified=?, updated_at=${t()} WHERE id=?`)
        .run(name, email || null, phone || null, jobNo, email ? 1 : 0, phone ? 1 : 0, u.id);
      const added = email && !u.email;
      audit(actor, 'edit_profile', u.username,
        `邮箱:${email || '空'}${added ? '(补录)' : ''} 手机:${phone || '空'} 工号:${jobNo || '空'}`, ip);
      return { ok: true, message: added ? '资料已更新，邮箱补录成功' : '资料已更新', user: getUser(u.id) };
    }

    case 'delete':
      if (actor.id === u.id) return { ok: false, error: '不能删除自己' };
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
      audit(actor, 'delete', u.username, `原状态=${u.status}`, ip);
      return { ok: true, message: '已删除' };

    default:
      return { ok: false, error: '未知操作：' + action };
  }
}

/** 管理员直接建号（注册关闭时使用，或为不会自助注册的同事开户） */
function createUserByAdmin(actor, body, req) {
  const username = String(body.username || '').trim();
  const name = String(body.name || '').trim();
  const password = String(body.password || '');
  if (!USERNAME_RE.test(username)) return { ok: false, error: '登录名需为 3-32 位字母、数字、下划线、点或连字符' };
  if (!name) return { ok: false, error: '请填写姓名' };
  const pwErr = checkPassword(password);
  if (pwErr) return { ok: false, error: pwErr };
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    return { ok: false, error: '该登录名已被使用' };
  }
  const email = normEmail(body.email);
  const phone = normPhone(body.phone);
  if (email && db.prepare('SELECT id FROM users WHERE email = ?').get(email)) return { ok: false, error: '该邮箱已被注册' };
  if (phone && db.prepare('SELECT id FROM users WHERE phone = ?').get(phone)) return { ok: false, error: '该手机号已被注册' };
  const role = body.role === 'admin' ? 'admin' : 'user';
  const { hash, salt } = hashPassword(password);
  const info = db.prepare(
    `INSERT INTO users(username,name,email,phone,job_no,college_id,major_id,password_hash,password_salt,role,status,
      email_verified,phone_verified,approved_by,approved_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,'active',?,?,?,datetime('now','localtime'))`
  ).run(
    username, name, email || null, phone || null, String(body.job_no || '').trim() || null,
    body.college_id ? Number(body.college_id) : null, body.major_id ? Number(body.major_id) : null,
    hash, salt, role,
    email ? 1 : 0, phone ? 1 : 0, actor.id,
  );
  audit(actor, 'create_user', username, `角色=${role}`, clientIp(req));
  return { ok: true, user: getUser(info.lastInsertRowid) };
}

function listAudit(limit = 100) {
  return db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?').all(Number(limit) || 100);
}

/**
 * 清理审计日志。必须带 keyword（只删匹配 target/actor_name 的行）或 all=1（清空），
 * 避免一次误触把全部留痕抹掉。
 */
function clearAudit(actor, q, req) {
  const kw = String((q && q.keyword) || '').trim();
  const all = String((q && q.all) || '') === '1';
  if (!kw && !all) return { ok: false, error: '请指定 keyword 或 all=1' };
  let n;
  if (all) {
    n = db.prepare('DELETE FROM audit_logs').run().changes;
  } else {
    const like = `%${kw}%`;
    n = db.prepare('DELETE FROM audit_logs WHERE target LIKE ? OR actor_name LIKE ? OR detail LIKE ?')
      .run(like, like, like).changes;
  }
  // 清理动作本身也要留痕，且必须在删除之后写，否则会被上面那条 DELETE 一并带走
  audit(actor, 'clear_audit', all ? '全部' : kw, `删除 ${n} 条`, clientIp(req));
  return { ok: true, deleted: n };
}

/* ---------------- 超级管理员初始化 ---------------- */
/**
 * 保证系统至少有一个超管：环境变量 SUPER_ADMIN_USER / SUPER_ADMIN_PASS 优先，
 * 否则自动建 admin + 随机密码，打印到控制台并写入 data/_admin_init.txt。
 * 这是「零配置可跑」与「不硬编码口令」之间的折中：密码随机生成，不进代码库。
 */
function ensureSuperAdmin() {
  const exist = db.prepare("SELECT id FROM users WHERE role='super_admin'").get();
  if (exist) return null;

  const username = (process.env.SUPER_ADMIN_USER || 'admin').trim();
  let password = (process.env.SUPER_ADMIN_PASS || '').trim();
  if (!password) password = crypto.randomBytes(6).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10);

  const { hash, salt } = hashPassword(password);
  const info = db.prepare(
    `INSERT INTO users(username,name,email,phone,password_hash,password_salt,role,status,
      email_verified,phone_verified,approved_at)
     VALUES(?,?,?,?,?,?,'super_admin','active',0,0,datetime('now','localtime'))`
  ).run(username, '系统超级管理员', null, null, hash, salt);
  audit(null, 'init_super_admin', username, '首次启动自动创建', '');

  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const { DATA_DIR } = require('./db');
    const file = path.join(DATA_DIR, '_admin_init.txt');
    fs.writeFileSync(file,
      `超级管理员初始账号（首次启动生成，登录后请立即修改密码）\n` +
      `登录名：${username}\n密码：${password}\n生成时间：${new Date().toLocaleString('zh-CN')}\n`,
      'utf8');
  } catch (e) { /* 写不下就只靠控制台输出 */ }

  return { username, password, id: info.lastInsertRowid };
}

module.exports = {
  SESSION_COOKIE, CLEAR_COOKIE,
  hashPassword, verifyPassword, checkPassword,
  parseCookies, clientIp, userFromRequest, destroySession, createSession, sessionCookie,
  purgeExpired, audit, isMachineRequest,
  sendCode, checkCode, isWhitelisted,
  register, login, logout, resetPassword, changePassword, tokenFromRequest,
  listUsers, getUser, stats, adminAction, createUserByAdmin, listAudit, clearAudit,
  ensureSuperAdmin, publicUser,
  USERNAME_RE, EMAIL_RE, PHONE_RE, normEmail, normPhone,
};
