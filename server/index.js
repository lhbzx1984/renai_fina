'use strict';
/** 零依赖 HTTP 服务器：静态资源 + JSON API + 文件上传 + 文件下载 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const api = require('./lib/api');
const { ROOT, UPLOAD_DIR } = require('./lib/db');

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

/* ---------------- 路由 ---------------- */
const routes = [];
function route(method, pattern, handler) {
  // /api/projects/:id/members -> regex
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([A-Za-z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler });
}

route('GET', '/api/health', () => ({ ok: true, data: { time: new Date().toISOString(), node: process.version } }));

route('GET', '/api/settings', () => api.getSettings());
route('PUT', '/api/settings', async (ctx) => api.updateSettings(await ctx.json()));

route('GET', '/api/periods', () => api.listPeriods());
route('POST', '/api/periods', async (ctx) => api.createPeriod(await ctx.json()));
route('PUT', '/api/periods/:id', async (ctx) => api.updatePeriod(ctx.params.id, await ctx.json()));
route('DELETE', '/api/periods/:id', (ctx) => api.deletePeriod(ctx.params.id));

route('GET', '/api/colleges', () => api.listColleges());
route('POST', '/api/colleges', async (ctx) => api.createCollege(await ctx.json()));
route('PUT', '/api/colleges/:id', async (ctx) => api.updateCollege(ctx.params.id, await ctx.json()));
route('DELETE', '/api/colleges/:id', (ctx) => api.deleteCollege(ctx.params.id));
route('POST', '/api/majors', async (ctx) => api.createMajor(await ctx.json()));
route('PUT', '/api/majors/:id', async (ctx) => api.updateMajor(ctx.params.id, await ctx.json()));
route('DELETE', '/api/majors/:id', (ctx) => api.deleteMajor(ctx.params.id));

route('GET', '/api/dashboard', () => api.dashboard());

route('GET', '/api/projects', (ctx) => api.listProjects(ctx.query));
route('POST', '/api/projects', async (ctx) => api.createProject(await ctx.json()));
route('GET', '/api/projects/:id', (ctx) => api.getProject(ctx.params.id));
route('PUT', '/api/projects/:id', async (ctx) => api.updateProject(ctx.params.id, await ctx.json()));
route('DELETE', '/api/projects/:id', (ctx) => api.deleteProject(ctx.params.id));

route('POST', '/api/projects/:id/trips', async (ctx) => api.createTrip(ctx.params.id, await ctx.json()));
route('PUT', '/api/trips/:id', async (ctx) => api.updateTrip(ctx.params.id, await ctx.json()));
route('DELETE', '/api/trips/:id', (ctx) => api.deleteTrip(ctx.params.id));

route('GET', '/api/projects/:id/members', (ctx) => api.listMembers(ctx.params.id));
route('POST', '/api/projects/:id/members', async (ctx) => api.createMember(ctx.params.id, await ctx.json()));
route('PUT', '/api/members/:id', async (ctx) => api.updateMember(ctx.params.id, await ctx.json()));
route('DELETE', '/api/members/:id', (ctx) => api.deleteMember(ctx.params.id));
route('GET', '/api/people', (ctx) => api.searchPeople(ctx.query.name || '', ctx.query.job_no || ''));

route('GET', '/api/projects/:id/receipts', (ctx) => api.listReceipts(ctx.params.id, ctx.query.status));
// 该项目全部 PDF 票据合并成一个 PDF（预览 / 打印），inline 直出供 iframe 加载
route('GET', '/api/projects/:id/receipts/merged.pdf', (ctx) => api.mergeReceiptsPdf(ctx.params.id));
route('POST', '/api/projects/:id/receipts', async (ctx) => api.createReceipt(ctx.params.id, await ctx.json()));
route('POST', '/api/projects/:id/receipts/upload', (ctx) => ctx.files ? api.uploadReceipts(ctx.params.id, ctx.files, ctx.fields.hints ? String(ctx.fields.hints).split('||') : []) : Promise.resolve({ ok: false, error: '未收到文件' }));
route('POST', '/api/projects/:id/receipts/import', async (ctx) => {
  const body = await ctx.json();
  return api.importReceipts(ctx.params.id, body.content || '', body.format || 'csv');
});
route('GET', '/api/receipts/template', () => {
  const t = api.receiptTemplate();
  return { ok: true, data: { ...t, download: '/api/receipts/template.csv' } };
});
route('GET', '/api/receipts/template.csv', () => null); // 特殊：直出文本
route('PUT', '/api/receipts/:id', async (ctx) => api.updateReceipt(ctx.params.id, await ctx.json()));
route('POST', '/api/receipts/:id/review', async (ctx) => api.reviewReceipt(ctx.params.id, await ctx.json()));
route('POST', '/api/receipts/:id/reocr', (ctx) => api.reocrReceipt(ctx.params.id));
route('DELETE', '/api/receipts/:id', (ctx) => api.deleteReceipt(ctx.params.id));

route('GET', '/api/projects/:id/preview/travel', (ctx) => api.buildTravelPayload(ctx.params.id));
route('GET', '/api/projects/:id/export/travel_docx', (ctx) => ({ __file: api.exportTravelDocx(ctx.params.id) }));
route('POST', '/api/projects/:id/export/fund_xlsx', async (ctx) => ({ __file: api.exportFundXlsx(ctx.params.id, await ctx.json().catch(() => ({}))) }));
route('GET', '/api/projects/:id/export/fund_xlsx', (ctx) => ({ __file: api.lastExport(ctx.params.id, 'fund_xlsx') }));

/* ---------------- 静态文件 ---------------- */
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
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

  // 健康检查放行鉴权，便于 uptime 监控与 Nginx 探活（只返回版本与时间，不含业务数据）
  if (pathname !== '/api/health' && AUTH_ENABLED && !authOk(req)) return requireAuth(req, res);

  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

  try {
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

    /* 上传票据文件预览 */
    if (pathname.startsWith('/api/files/')) {
      const name = path.basename(decodeURIComponent(pathname.slice('/api/files/'.length)));
      const fp = path.join(UPLOAD_DIR, name);
      if (!fp.startsWith(UPLOAD_DIR) || !fs.existsSync(fp)) return sendText(res, 404, '文件不存在');
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
    const ctx = { params, query, req, res, files, fields, json: async () => fields };

    const out = await matched.handler(ctx);

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
  console.log(`   ▸ 停止服务：    Ctrl + C`);
  console.log('');
});