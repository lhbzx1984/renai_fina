'use strict';
/** 零依赖 HTTP 服务器：静态资源 + JSON API + 文件上传 + 文件下载 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const api = require('./lib/api');
const { ROOT, UPLOAD_DIR } = require('./lib/db');
const auth = require('./lib/auth');

const PORT = Number(process.env.PORT) || 5180;
// 默认只监听回环地址（本机开发）。云上由 Nginx 反代进来时同样应保持 127.0.0.1，
// 这样 5180 端口不会直接暴露在公网，必须经 Nginx 才可达。
// 仅当显式设置 HOST=0.0.0.0 时才对外监听（容器场景需要）。
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** 直出字节流：inline=true 用于页面内预览（iframe 加载 PDF），否则作附件下载 */
function sendBuffer(res, buf, type, filename, inline) {
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, code, text, type = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': body.length });
  res.end(body);
}

function readBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大（上限 25MB）')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch (e) { throw new Error('JSON 解析失败：' + e.message); }
}

/* ---------------- 极简 multipart/form-data 解析 ---------------- */
function parseMultipart(buf, boundary) {
  const parts = [];
  const delim = Buffer.from(`--${boundary}`);
  let pos = buf.indexOf(delim);
  if (pos < 0) return parts;
  pos += delim.length;
  while (pos < buf.length) {
    if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d) break; // 结束标记 --
    pos += 2; // CRLF
    const headEnd = buf.indexOf('\r\n\r\n', pos, 'utf8');
    if (headEnd < 0) break;
    const head = buf.toString('utf8', pos, headEnd);
    const bodyStart = headEnd + 4;
    let next = buf.indexOf(delim, bodyStart);
    if (next < 0) next = buf.length;
    let bodyEnd = next;
    if (bodyEnd >= 2 && buf[bodyEnd - 2] === 0x0d && buf[bodyEnd - 1] === 0x0a) bodyEnd -= 2;
    const contentType = (head.match(/Content-Type:\s*([^\r\n]+)/i) || [])[1] || '';
    const nameM = head.match(/name="([^"]*)"/);
    const fileM = head.match(/filename="([^"]*)"/);
    parts.push({
      name: nameM ? nameM[1] : '',
      filename: fileM ? fileM[1] : null,
      contentType,
      buffer: buf.slice(bodyStart, bodyEnd),
    });
    pos = next + delim.length;
  }
  return parts;
}

/* ---------------- 会话级权限守卫 ----------------
   注意这里的分工：Basic Auth 是「部署层」的外壳，拦的是数据面；
   guardLogin / guardAdmin 是「业务层」的权限，决定谁能看到什么。
   两者独立，任一层缺失都不至于让系统裸奔。 */
function guardLogin(ctx) {
  if (!ctx.user) return { __status: 401, error: '请先登录' };
  return null;
}
function guardAdmin(ctx) {
  if (!ctx.user) return { __status: 401, error: '请先登录' };
  if (ctx.user.role !== 'admin' && ctx.user.role !== 'super_admin') {
    return { __status: 403, error: '需要管理员权限' };
  }
  return null;
}

/* ---------------- 路由 ---------------- */
const routes = [];
function route(method, pattern, handler) {
  // /api/projects/:id/members -> regex
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([A-Za-z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler });
}

route('GET', '/api/health', () => ({ ok: true, data: { time: new Date().toISOString(), node: process.version } }));

/* ================= 账号：注册 / 验证码 / 登录 / 会话 =================
   这一组是「进入系统的门」，必须匿名可访问 —— 否则新用户连注册页都调不通。
   门里面才是双层防护：Basic Auth 守数据面，会话 + 角色守权限面。 */
route('GET', '/api/auth/config', () => api.authConfig());
route('POST', '/api/auth/code/send', async (ctx) => {
  // 与其余接口保持一致，统一包一层 data，前端 Api 层无需为它特例分支
  const r = await auth.sendCode({ ...(await ctx.json()), ip: ctx.ip });
  return r.ok ? { ok: true, data: r } : { ok: false, error: r.error };
});
route('POST', '/api/auth/register', async (ctx) => {
  const r = auth.register(await ctx.json(), ctx.req);
  return r.ok ? { ok: true, data: r } : { ok: false, error: r.error };
});
route('POST', '/api/auth/login', async (ctx) => {
  const r = auth.login(await ctx.json(), ctx.req);
  if (!r.ok) return { __status: 401, error: r.error };
  ctx.setCookie(auth.sessionCookie(r.token, r.maxAge));
  return { ok: true, data: { user: r.user } };
});
route('POST', '/api/auth/logout', (ctx) => {
  auth.logout(ctx.req);
  ctx.setCookie(auth.CLEAR_COOKIE);
  return { ok: true, data: { ok: true } };
});
route('POST', '/api/auth/password/reset', async (ctx) => {
  const r = auth.resetPassword(await ctx.json(), ctx.req);
  return r.ok ? { ok: true, data: { ok: true } } : { ok: false, error: r.error };
});

/* 需要登录 */
route('GET', '/api/auth/me', (ctx) => {
  const g = guardLogin(ctx); if (g) return g;
  return { ok: true, data: { user: auth.publicUser(ctx.user), require_login: api.requireLogin() } };
});
route('POST', '/api/auth/password/change', async (ctx) => {
  const g = guardLogin(ctx); if (g) return g;
  const r = auth.changePassword(ctx.user, await ctx.json(), auth.tokenFromRequest(ctx.req));
  return r.ok ? { ok: true, data: { ok: true, kicked: r.kicked || 0 } } : { ok: false, error: r.error };
});
route('POST', '/api/auth/logout-all', (ctx) => {
  const g = guardLogin(ctx); if (g) return g;
  require('./lib/db').db.prepare('DELETE FROM sessions WHERE user_id = ?').run(ctx.user.id);
  ctx.setCookie(auth.CLEAR_COOKIE);
  return { ok: true, data: { ok: true } };
});

/* ================= 后台管理（仅管理员） ================= */
route('GET', '/api/admin/stats', (ctx) => {
  const g = guardAdmin(ctx); if (g) return g;
  return {
    ok: true, data: {
      users: auth.stats(),
      register_open: require('./lib/db').getSetting('auth_register_open') === '1',
      email_ready: !!(require('./lib/db').getSetting('mail_smtp_host') &&
        require('./lib/db').getSetting('mail_smtp_user') &&
        require('./lib/db').getSetting('mail_smtp_pass') &&
        require('./lib/db').getSetting('mail_from')),
      pending_receipts: require('./lib/db').db
        .prepare("SELECT COUNT(*) AS n FROM receipts WHERE ocr_status='pending'").get().n,
    },
  };
});
route('GET', '/api/admin/users', (ctx) => {
  const g = guardAdmin(ctx); if (g) return g;
  return { ok: true, data: { list: auth.listUsers(ctx.query) } };
});
route('GET', '/api/admin/users/:id', (ctx) => {
  const g = guardAdmin(ctx); if (g) return g;
  return { ok: true, data: { user: auth.getUser(ctx.params.id) } };
});
route('POST', '/api/admin/users', async (ctx) => {
  const g = guardAdmin(ctx); if (g) return g;
  const r = auth.createUserByAdmin(ctx.user, await ctx.json(), ctx.req);
  return r.ok ? { ok: true, data: { user: r.user } } : { ok: false, error: r.error };
});
route('POST', '/api/admin/users/:id/:action', async (ctx) => {
  const g = guardAdmin(ctx); if (g) return g;
  const r = auth.adminAction(ctx.user, ctx.params.id, ctx.params.action, await ctx.json().catch(() => ({})), ctx.req);
  return r.ok ? { ok: true, data: r } : { ok: false, error: r.error };
});
route('DELETE', '/api/admin/users/:id', (ctx) => {
  const g = guardAdmin(ctx); if (g) return g;
  const r = auth.adminAction(ctx.user, ctx.params.id, 'delete', {}, ctx.req);
  return r.ok ? { ok: true, data: r } : { ok: false, error: r.error };
});
route('GET', '/api/admin/audit', (ctx) => {
  const g = guardAdmin(ctx); if (g) return g;
  return { ok: true, data: { list: auth.listAudit(Number(ctx.query.limit) || 100) } };
});
route('DELETE', '/api/admin/audit', (ctx) => {
  const g = guardAdmin(ctx); if (g) return g;
  const r = auth.clearAudit(ctx.user, ctx.query, ctx.req);
  return r.ok ? { ok: true, data: r } : { ok: false, error: r.error };
});
route('GET', '/api/settings', (ctx) => api.getSettings(ctx.user));
route('PUT', '/api/settings', async (ctx) => api.updateSettings(await ctx.json(), ctx.user));

route('GET', '/api/periods', () => api.listPeriods());
route('POST', '/api/periods', async (ctx) => api.createPeriod(await ctx.json()));
route('PUT', '/api/periods/:id', async (ctx) => api.updatePeriod(ctx.params.id, await ctx.json()));
route('DELETE', '/api/periods/:id', (ctx) => api.deletePeriod(ctx.params.id));

// 项目分类 / 费用科目：内置项 + 用户自定义项（自定义项在「设置」页增删）
route('POST', '/api/dict/categories', async (ctx) => api.addDictItem('categories', await ctx.json()));
route('DELETE', '/api/dict/categories/:key', (ctx) => api.deleteDictItem('categories', ctx.params.key));
route('POST', '/api/dict/buckets', async (ctx) => api.addDictItem('buckets', await ctx.json()));
route('DELETE', '/api/dict/buckets/:key', (ctx) => api.deleteDictItem('buckets', ctx.params.key));

route('GET', '/api/colleges', () => api.listColleges());
route('POST', '/api/colleges', async (ctx) => api.createCollege(await ctx.json()));
route('PUT', '/api/colleges/:id', async (ctx) => api.updateCollege(ctx.params.id, await ctx.json()));
route('DELETE', '/api/colleges/:id', (ctx) => api.deleteCollege(ctx.params.id));
route('POST', '/api/majors', async (ctx) => api.createMajor(await ctx.json()));
route('PUT', '/api/majors/:id', async (ctx) => api.updateMajor(ctx.params.id, await ctx.json()));
route('DELETE', '/api/majors/:id', (ctx) => api.deleteMajor(ctx.params.id));

route('GET', '/api/dashboard', (ctx) => api.dashboard(ctx.user));

/* 以下业务路由全部带 ctx.user：api 层据此做归属过滤与越权拦截 */
route('GET', '/api/projects', (ctx) => api.listProjects(ctx.query, ctx.user));
route('POST', '/api/projects', async (ctx) => api.createProject(await ctx.json(), ctx.user));
route('GET', '/api/projects/:id', (ctx) => api.getProject(ctx.params.id, ctx.user));
route('PUT', '/api/projects/:id', async (ctx) => api.updateProject(ctx.params.id, await ctx.json(), ctx.user));
route('DELETE', '/api/projects/:id', (ctx) => api.deleteProject(ctx.params.id, ctx.user));

route('POST', '/api/projects/:id/trips', async (ctx) => api.createTrip(ctx.params.id, await ctx.json(), ctx.user));
route('PUT', '/api/trips/:id', async (ctx) => api.updateTrip(ctx.params.id, await ctx.json(), ctx.user));
route('DELETE', '/api/trips/:id', (ctx) => api.deleteTrip(ctx.params.id, ctx.user));

route('GET', '/api/projects/:id/members', (ctx) => api.listMembers(ctx.params.id, ctx.user));
route('POST', '/api/projects/:id/members', async (ctx) => api.createMember(ctx.params.id, await ctx.json(), ctx.user));
route('PUT', '/api/members/:id', async (ctx) => api.updateMember(ctx.params.id, await ctx.json(), ctx.user));
route('DELETE', '/api/members/:id', (ctx) => api.deleteMember(ctx.params.id, ctx.user));
route('GET', '/api/people', (ctx) => api.searchPeople(ctx.query.name || '', ctx.query.job_no || '', ctx.user));

route('GET', '/api/projects/:id/receipts', (ctx) => api.listReceipts(ctx.params.id, ctx.query.status, ctx.user));
// 该项目全部 PDF 票据合并成一个 PDF（预览 / 打印），inline 直出供 iframe 加载
route('GET', '/api/projects/:id/receipts/merged.pdf', (ctx) => api.mergeReceiptsPdf(ctx.params.id, ctx.user));
route('POST', '/api/projects/:id/receipts', async (ctx) => api.createReceipt(ctx.params.id, await ctx.json(), ctx.user));
route('POST', '/api/projects/:id/receipts/upload', (ctx) => ctx.files ? api.uploadReceipts(ctx.params.id, ctx.files, ctx.fields.hints ? String(ctx.fields.hints).split('||') : [], ctx.user) : Promise.resolve({ ok: false, error: '未收到文件' }));
route('POST', '/api/projects/:id/receipts/import', async (ctx) => {
  const body = await ctx.json();
  return api.importReceipts(ctx.params.id, body.content || '', body.format || 'csv', ctx.user);
});
route('GET', '/api/receipts/template', () => {
  const t = api.receiptTemplate();
  return { ok: true, data: { ...t, download: '/api/receipts/template.csv' } };
});
route('GET', '/api/receipts/template.csv', () => null); // 特殊：直出文本
route('PUT', '/api/receipts/:id', async (ctx) => api.updateReceipt(ctx.params.id, await ctx.json(), ctx.user));
route('POST', '/api/receipts/:id/review', async (ctx) => api.reviewReceipt(ctx.params.id, await ctx.json(), ctx.user));
route('POST', '/api/receipts/:id/reocr', (ctx) => api.reocrReceipt(ctx.params.id, ctx.user));
route('DELETE', '/api/receipts/:id', (ctx) => api.deleteReceipt(ctx.params.id, ctx.user));

/* 发票邮件发送：把项目里的 PDF 发票逐张作为附件发到指定邮箱（邮件配置按用户隔离） */
route('GET', '/api/mail/status', (ctx) => api.mailStatus(ctx.user));
// 系统发件邮箱（注册/找回密码的验证码专用）：读全局配置，写需要管理员
route('GET', '/api/mail/global-status', () => api.globalMailStatus());
route('POST', '/api/mail/global', async (ctx) =>
  api.saveGlobalMail(await ctx.json().catch(() => ({})), ctx.user));
route('POST', '/api/mail/global-test', async (ctx) =>
  api.sendGlobalTestMail(await ctx.json().catch(() => ({})), ctx.user));
route('POST', '/api/mail/test', async (ctx) => api.sendTestMail(await ctx.json().catch(() => ({})), ctx.user));
route('POST', '/api/projects/:id/send-invoices', async (ctx) =>
  api.sendProjectInvoices(ctx.params.id, await ctx.json().catch(() => ({})), ctx.user));

/* AI 视觉提取队列：规则引擎解不出的票据入队，等 AI 助手看图补录 */
route('GET', '/api/ai/queue', (ctx) => api.listAiQueue(ctx.user));
route('POST', '/api/ai/receipts/:id/fields', async (ctx) => api.applyAiFields(ctx.params.id, await ctx.json(), ctx.user));
route('POST', '/api/ai/receipts/:id/skip', async (ctx) => {
  let body = {};
  try { body = await ctx.json(); } catch (e) { /* 无请求体 */ }
  return api.skipAiReceipt(ctx.params.id, body, ctx.user);
});

route('GET', '/api/projects/:id/preview/travel', (ctx) => api.buildTravelPayload(ctx.params.id, ctx.user));
route('GET', '/api/projects/:id/export/travel_docx', (ctx) => ({ __file: api.exportTravelDocx(ctx.params.id, ctx.user) }));
route('POST', '/api/projects/:id/export/fund_xlsx', async (ctx) => ({ __file: api.exportFundXlsx(ctx.params.id, await ctx.json().catch(() => ({})), ctx.user) }));
route('GET', '/api/projects/:id/export/fund_xlsx', (ctx) => ({ __file: api.lastExport(ctx.params.id, 'fund_xlsx', ctx.user) }));

/* ---------------- 静态文件 ---------------- */
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  // 后台管理入口：/admin 与 /admin/ 都落到 admin.html
  if (rel === '/admin' || rel === '/admin/') rel = '/admin.html';
  const fp = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!fp.startsWith(PUBLIC_DIR)) return sendText(res, 403, 'Forbidden');
  if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
    // SPA 回退。仅对「看起来是前端路由」的路径生效；
    // 带扩展名的请求（如 /foo.css、/__shot.html）说明是资源缺失，
    // 必须回 404。否则删掉一个静态文件也会拿到 200 + 首页 HTML，
    // 让 Chrome 截图脚本拍到错误页面却不报错（实测踩过）。
    const extGuess = path.extname(rel).toLowerCase();
    if (extGuess) return sendText(res, 404, 'Not Found: ' + rel);
    const idx = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(idx)) {
      const b = fs.readFileSync(idx);
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': b.length });
      return res.end(b);
    }
    return sendText(res, 404, 'Not Found');
  }
  const ext = path.extname(fp).toLowerCase();
  const b = fs.readFileSync(fp);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': b.length,
    'Cache-Control': 'no-cache',
  });
  res.end(b);
}

/** 下载文件到浏览器 */
function sendDownload(res, filePath) {
  const name = path.basename(filePath);
  const buf = fs.readFileSync(filePath);
  const type = name.endsWith('.xlsx')
    ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

/* ---------------- Basic Auth（可选，启用后全站生效） ----------------
   财务系统绝不能匿名暴露公网。设置 AUTH_USER / AUTH_PASS 即启用。
   用 crypto.timingSafeEqual 做常量时间比较，避免按响应时间侧信道爆破用户名。 */
const crypto = require('node:crypto');
const AUTH_USER = process.env.AUTH_USER || '';
const AUTH_PASS = process.env.AUTH_PASS || '';
const AUTH_ENABLED = !!(AUTH_USER && AUTH_PASS);

// HTTP Basic 凭据格式是 user:pass，冒号是分隔符，用户名里不能再带冒号。
// 与其静默比较失败，不如启动时直接拒绝并给出可操作的提示。
if (AUTH_ENABLED && AUTH_USER.includes(':')) {
  console.error('[FATAL] AUTH_USER 不能包含冒号 ":" —— 它是 Basic Auth 的用户名/密码分隔符。');
  console.error('        请改用不含冒号的用户名，例如 admin。');
  process.exit(1);
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  // 长度不同必然不等；仍走一次比较以保持耗时稳定，避免泄露长度信息
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function authOk(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  let decoded = '';
  try {
    decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
  } catch (e) {
    return false;
  }
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  const u = decoded.slice(0, i);
  const p = decoded.slice(i + 1);
  // 两者都要比较，不能短路（否则 p 判断的耗时会泄露 u 是否正确）
  const okU = safeEqual(u, AUTH_USER);
  const okP = safeEqual(p, AUTH_PASS);
  return okU & okP;
}

function requireAuth(req, res) {
  const body = Buffer.from('401 Unauthorized', 'utf8');
  res.writeHead(401, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'WWW-Authenticate': 'Basic realm="Reimbursement", charset="UTF-8"',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/* ---------------- 主处理 ---------------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = u.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  /* Basic Auth 放行策略。想清楚一件事：认证端点必须放行，否则新用户打不开注册页；
     静态页面也放行，因为它们只是空壳，数据全在 API 里。
     真正被这层护住的是 /api/projects、/api/receipts 这类业务数据接口。
     若你希望「连登录页也要先过 Basic 口令」，启动时加 AUTH_STRICT=1 环境变量。 */
  const AUTH_STRICT = process.env.AUTH_STRICT === '1';
  const basicBypass = pathname === '/api/health' ||
    (!AUTH_STRICT && (pathname.startsWith('/api/auth/') || !pathname.startsWith('/api/')));
  if (!basicBypass && AUTH_ENABLED && !authOk(req)) return requireAuth(req, res);

  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

  try {
    /* 业务数据接口的登录门禁。
       /api/auth/* 已在路由内自行判断，这里放行；其余一律要求会话。
       ai_queue.js 这类本机命令行工具走 Bearer 机器令牌，由 userFromRequest 识别。 */
    // /api/health 必须始终放行：Nginx 探活与 uptime 监控不会有会话，
    // 一旦被门禁拦掉，健康检查全红却查不出原因。
    const LOGIN_OPEN = pathname === '/api/health' || pathname.startsWith('/api/auth/');
    if (pathname.startsWith('/api/') && !LOGIN_OPEN && api.requireLogin()) {
      if (!auth.userFromRequest(req)) {
        return sendJson(res, 401, { ok: false, error: '请先登录', need_login: true });
      }
    }

    /* CSV 模板直出 */
    if (pathname === '/api/receipts/template.csv') {
      const t = api.receiptTemplate();
      const b = Buffer.from('﻿' + t.content, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Length': b.length,
        'Content-Disposition': 'attachment; filename="receipt_import_template.csv"',
      });
      return res.end(b);
    }

    /* 上传票据文件预览。
       这里必须查归属：文件名是有规律的（时间戳_序号_原名），
       不校验的话任何登录用户猜到名字就能下载别人的发票原件。 */
    if (pathname.startsWith('/api/files/')) {
      const name = path.basename(decodeURIComponent(pathname.slice('/api/files/'.length)));
      const fp = path.join(UPLOAD_DIR, name);
      if (!fp.startsWith(UPLOAD_DIR) || !fs.existsSync(fp)) return sendText(res, 404, '文件不存在');
      const user = auth.userFromRequest(req);
      if (!api.canAccessFile(name, user)) return sendText(res, 403, '无权访问该文件');
      const b = fs.readFileSync(fp);
      const ext = path.extname(name).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': b.length,
      });
      return res.end(b);
    }

    /* 查找路由 */
    let matched = null, params = {};
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = pathname.match(r.re);
      if (m) {
        matched = r;
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        break;
      }
    }
    if (!matched) return sendJson(res, 404, { ok: false, error: `接口不存在: ${req.method} ${pathname}` });

    /* 解析请求体 */
    let files = null, fields = {};
    const ct = req.headers['content-type'] || '';
    if (ct.includes('multipart/form-data')) {
      const bmatch = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/);
      if (!bmatch) return sendJson(res, 400, { ok: false, error: 'multipart 缺少 boundary' });
      const buf = await readBody(req);
      const parts = parseMultipart(buf, (bmatch[1] || bmatch[2]).trim());
      files = parts.filter((p) => p.filename != null && p.filename !== '').map((p) => ({
        filename: p.filename, mimetype: p.contentType, buffer: p.buffer,
      }));
      for (const p of parts) if (p.filename == null || p.filename === '') fields[p.name] = p.buffer.toString('utf8');
    } else if (req.method === 'POST' || req.method === 'PUT') {
      const raw = await readBody(req);
      if (raw.length) {
        try { Object.assign(fields, JSON.parse(raw.toString('utf8'))); }
        catch (e) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败：' + e.message }); }
      }
    }

    const query = Object.fromEntries(u.searchParams.entries());
    const ctx = {
      params, query, req, res, files, fields,
      json: async () => fields,
      user: auth.userFromRequest(req),   // 未登录为 null
      ip: auth.clientIp(req),
      setCookie: (v) => res.setHeader('Set-Cookie', v),
    };

    const out = await matched.handler(ctx);

    if (out && out.__status) return sendJson(res, out.__status, { ok: false, error: out.error });
    if (!out) return sendJson(res, 204, { ok: true });

    /* 导出文件：直接下载 */
    if (out.__file) {
      const r = out.__file;
      if (!r.ok) return sendJson(res, 400, r);
      const fp = path.join(ROOT, 'exports', r.data.file);
      if (!fs.existsSync(fp)) return sendJson(res, 500, { ok: false, error: '导出文件丢失' });
      if (u.searchParams.get('json') === '1') return sendJson(res, 200, r);
      return sendDownload(res, fp);
    }

    /* 直接输出字节流（合并票据 PDF 等）：inline 供预览，或 attachment 下载 */
    if (out.__raw) {
      const r = out.__raw;
      if (!r.buf) return sendJson(res, 400, { ok: false, error: '内容为空' });
      return sendBuffer(res, r.buf, r.type || 'application/octet-stream', r.filename || 'file', !!r.inline);
    }

    return sendJson(res, out.ok ? 200 : 400, out);
  } catch (err) {
    console.error('[ERROR]', req.method, pathname, err);
    return sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
  }
});

/* 启动前置：清掉过期会话/验证码，并保证存在超级管理员 */
auth.purgeExpired();
const bootAdmin = auth.ensureSuperAdmin();

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ╭──────────────────────────────────────────────╮');
  console.log('  │   天津仁爱学院 · 报销管理系统                 │');
  console.log('  ╰──────────────────────────────────────────────╯');
  console.log(`   ▸ 服务已启动：  http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`);
  console.log(`   ▸ 监听地址：    ${HOST}:${PORT}${HOST === '0.0.0.0' ? '（已对外，请确认防火墙）' : '（仅本机，公网需经 Nginx 反代）'}`);
  console.log(`   ▸ 数据库：      ${path.join(process.env.DATA_DIR || 'data', 'reimburse.db')}`);
  console.log(`   ▸ 导出目录：    ${process.env.EXPORT_DIR || 'exports'}`);
  console.log(`   ▸ 访问鉴权：    ${AUTH_ENABLED ? '已启用（Basic Auth）' : '未启用 —— 仅限内网，切勿直接暴露公网'}`);
  console.log(`   ▸ 账号登录：    ${api.requireLogin() ? '已启用（注册需审批）' : '未启用 —— 任何人可操作业务数据，强烈建议开启'}`);
  console.log(`   ▸ 后台管理：    http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}/admin`);
  if (bootAdmin) {
    console.log('');
    console.log('   ┌── 超级管理员初始账号（首次启动自动生成）────────────┐');
    console.log(`   │  登录名：${bootAdmin.username}`);
    console.log(`   │  密　码：${bootAdmin.password}`);
    console.log('   │  已写入 data/_admin_init.txt，登录后请立即修改密码   │');
    console.log('   └──────────────────────────────────────────────────────┘');
  }
  console.log(`   ▸ 停止服务：    Ctrl + C`);
  console.log('');
});