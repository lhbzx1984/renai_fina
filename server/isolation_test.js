'use strict';
/**
 * 多用户数据隔离回归测试
 *
 * 场景：A、B 两个普通账号（外加超管）各做各的，互相看不到对方的项目、票据、
 * 票据原件，也改不了；邮件/收款设置是每人一份；管理员例外（可看全部）。
 *
 * 跑法：先启动服务（node server/index.js），再 node server/isolation_test.js
 * 测试账号与项目全部自建自删，跑完库里不留痕迹。
 */
const fs = require('node:fs');
const path = require('node:path');
const { db } = require('./lib/db');

const BASE = process.env.BASE || 'http://127.0.0.1:5180';
const TAG = '隔离测试';
const PW = 'Iso@123456';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`); }
}

async function call(method, url, body, cookie, isForm, contentType) {
  const opt = { method, headers: {} };
  if (cookie) opt.headers.Cookie = 'sid=' + cookie;
  if (isForm) { opt.headers['Content-Type'] = contentType; opt.body = body; }
  else if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(BASE + url, opt);
  const ct = r.headers.get('content-type') || '';
  const json = ct.includes('json') ? await r.json() : null;
  return { status: r.status, json, text: json ? null : await r.text(), raw: r };
}
const login = async (account, password) => {
  const r = await call('POST', '/api/auth/login', { account, password });
  const sc = r.raw.headers.get('set-cookie') || '';
  return (sc.match(/sid=([^;]+)/) || [])[1] || null;
};

/** 造一个最小 PDF 用于上传（票据原件下载鉴权要用） */
function tinyPdf() {
  return Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');
}
function multipart(files) {
  const boundary = '----iso' + Date.now();
  const parts = [];
  for (const f of files) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\n` +
      `Content-Type: ${f.type}\r\n\r\n`), f.data, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), ct: `multipart/form-data; boundary=${boundary}` };
}

(async () => {
  console.log('=== 多用户数据隔离测试 ===\n');

  /* 超管登录：用来建测试账号（事后删掉） */
  let adminPw = process.env.SUPER_ADMIN_PASS || '';
  if (!adminPw) {
    try {
      adminPw = (fs.readFileSync(path.join(__dirname, '..', 'data', '_admin_init.txt'), 'utf8')
        .match(/密码：(\S+)/) || [])[1] || '';
    } catch (e) { /* ignore */ }
  }
  const adminCookie = adminPw ? await login(process.env.SUPER_ADMIN_USER || 'admin', adminPw) : null;
  if (!adminCookie) { console.error('无法以超管登录，测试中止'); process.exit(1); }

  /* 建两个普通账号（已存在则复用） */
  const mk = async (username, name) => {
    const exist = db.prepare('SELECT id FROM users WHERE username=?').get(username);
    if (exist) return exist.id;
    const r = await call('POST', '/api/admin/users', { username, name, password: PW }, adminCookie);
    if (!r.json || !r.json.ok) throw new Error('建号失败：' + JSON.stringify(r.json));
    return r.json.data.user.id;
  };
  const idA = await mk('iso_a', '隔离-甲');
  const idB = await mk('iso_b', '隔离-乙');
  const cookieA = await login('iso_a', PW);
  const cookieB = await login('iso_b', PW);
  check('两个测试账号可登录', !!(cookieA && cookieB));

  try {
    /* ---------- 1. 项目可见性 ---------- */
    console.log('\n[1] 项目列表与详情');
    const created = await call('POST', '/api/projects',
      { name: `${TAG}-甲的项目`, category: 'research', leader: '甲' }, cookieA);
    check('甲能建项目', created.json.ok, created.json);
    const pid = created.json.data.id;

    const listA = await call('GET', '/api/projects', undefined, cookieA);
    const listB = await call('GET', '/api/projects', undefined, cookieB);
    const idsA = listA.json.data.projects.map((p) => p.id);
    const idsB = listB.json.data.projects.map((p) => p.id);
    check('甲列表里有自己的项目', idsA.includes(pid), idsA);
    check('乙列表里没有甲的项目', !idsB.includes(pid), idsB);

    const detailB = await call('GET', `/api/projects/${pid}`, undefined, cookieB);
    check('乙直接按 id 查甲的项目被拒', detailB.json && detailB.json.ok === false, detailB.json);
    const detailA = await call('GET', `/api/projects/${pid}`, undefined, cookieA);
    check('甲自己查得到', detailA.json && detailA.json.ok === true);
    const detailAdmin = await call('GET', `/api/projects/${pid}`, undefined, adminCookie);
    check('管理员可查（后台运维需要）', detailAdmin.json && detailAdmin.json.ok === true);

    /* ---------- 2. 越权写操作 ---------- */
    console.log('\n[2] 越权修改 / 删除 / 上传');
    const putB = await call('PUT', `/api/projects/${pid}`, { name: '乙改的名字' }, cookieB);
    check('乙改不了甲的项目', putB.json && putB.json.ok === false, putB.json);
    const memB = await call('POST', `/api/projects/${pid}/members`, { name: '乙塞进来的人' }, cookieB);
    check('乙加不了成员', memB.json && memB.json.ok === false, memB.json);
    const tripB = await call('POST', `/api/projects/${pid}/trips`, { start_date: '2026-01-01', end_date: '2026-01-02' }, cookieB);
    check('乙加不了行程', tripB.json && tripB.json.ok === false, tripB.json);
    const upB = await call('POST', `/api/projects/${pid}/receipts`, { amount: 1, invoice_no: 'ISO-1' }, cookieB);
    check('乙加不了票据', upB.json && upB.json.ok === false, upB.json);
    const delB = await call('DELETE', `/api/projects/${pid}`, undefined, cookieB);
    check('乙删不掉甲的项目', delB.json && delB.json.ok === false, delB.json);
    const still = await call('GET', `/api/projects/${pid}`, undefined, cookieA);
    check('甲的项目安然无恙', still.json && still.json.ok && still.json.data.project.name === `${TAG}-甲的项目`);

    /* ---------- 3. 票据原件下载 ---------- */
    console.log('\n[3] 票据原件（/api/files）');
    const form = multipart([{ name: 'iso_invoice.pdf', type: 'application/pdf', data: tinyPdf() }]);
    const upA = await call('POST', `/api/projects/${pid}/receipts/upload`, form.body, cookieA, true, form.ct);
    check('甲上传票据成功', upA.json && upA.json.ok, upA.json);
    const rid = upA.json && upA.json.ok ? upA.json.data.created[0].id : null;
    const fpath = rid ? db.prepare('SELECT file_path FROM receipts WHERE id=?').get(rid).file_path : null;
    check('票据文件已落盘', !!fpath);
    if (fpath) {
      const dlA = await call('GET', `/api/files/${encodeURIComponent(fpath)}`, undefined, cookieA);
      check('甲能下载自己的票据', dlA.status === 200, dlA.status);
      const dlB = await call('GET', `/api/files/${encodeURIComponent(fpath)}`, undefined, cookieB);
      check('乙猜到文件名也下载不了', dlB.status === 403, dlB.status);
      const dlNone = await call('GET', '/api/files/不存在的文件.pdf', undefined, cookieB);
      check('无主文件一律拒绝', dlNone.status === 403 || dlNone.status === 404, dlNone.status);
    }

    /* ---------- 4. 设置隔离（邮箱 / 收款） ---------- */
    console.log('\n[4] 设置：全局共享 vs 个人私有');
    const setA = await call('PUT', '/api/settings',
      { mail_from: 'iso_a@163.com', mail_smtp_user: 'iso_a@163.com', mail_smtp_pass: 'ISO-A-PASS', payee_name: '甲' }, cookieA);
    check('甲保存个人邮件设置', setA.json && setA.json.ok, setA.json);
    const getA = await call('GET', '/api/settings', undefined, cookieA);
    const getB = await call('GET', '/api/settings', undefined, cookieB);
    check('甲看得到自己的发件人', getA.json.data.settings.mail_from === 'iso_a@163.com', getA.json.data.settings.mail_from);
    check('乙看不到甲的发件人', getB.json.data.settings.mail_from !== 'iso_a@163.com', getB.json.data.settings.mail_from);
    check('授权码不下发明文', !getA.json.data.settings.mail_smtp_pass && getA.json.data.settings.mail_smtp_pass_set === true);
    check('乙的授权码是未配置（不继承全局）', getB.json.data.settings.mail_smtp_pass_set === false,
      getB.json.data.settings.mail_smtp_pass_set);
    check('报销标准仍是全局共享', getA.json.data.settings.meal_teacher === getB.json.data.settings.meal_teacher);
    check('非管理员被标记不可改全局', getA.json.data.scope.global_locked === true, getA.json.data.scope);
    check('管理员可改全局', (await call('GET', '/api/settings', undefined, adminCookie)).json.data.scope.global_locked === false);

    const setBGlobal = await call('PUT', '/api/settings', { meal_teacher: 99999 }, cookieB);
    const globalAfter = db.prepare("SELECT value FROM settings WHERE key='meal_teacher' AND user_id=0").get().value;
    check('乙改不动全校餐费标准', Number(globalAfter) !== 99999, globalAfter);

    /* ---------- 5. 仪表盘统计 ---------- */
    console.log('\n[5] 仪表盘统计口径');
    const dashA = await call('GET', '/api/dashboard', undefined, cookieA);
    const dashB = await call('GET', '/api/dashboard', undefined, cookieB);
    check('甲的统计含自己的项目', dashA.json.data.stat.projects >= 1, dashA.json.data.stat);
    check('乙的统计不含甲的项目', dashB.json.data.stat.projects === 0, dashB.json.data.stat);

    /* ---------- 6. 人员搜索不跨用户 ---------- */
    console.log('\n[6] 人员搜索范围');
    await call('POST', `/api/projects/${pid}/members`, { name: '甲的独特同事', job_no: 'ISO-A-001' }, cookieA);
    const searchB = await call('GET', '/api/people?name=' + encodeURIComponent('甲的独特同事'), undefined, cookieB);
    check('乙搜不到甲的成员', searchB.json.ok && searchB.json.data.people.length === 0, searchB.json.data.people.length);
    const searchA = await call('GET', '/api/people?name=' + encodeURIComponent('甲的独特同事'), undefined, cookieA);
    check('甲能搜到自己的成员', searchA.json.ok && searchA.json.data.people.length === 1);

    /* ---------- 清理 ---------- */
    console.log('\n[清理]');
    if (rid) await call('DELETE', `/api/receipts/${rid}`, undefined, cookieA);
    await call('DELETE', `/api/projects/${pid}`, undefined, adminCookie);
    for (const k of ['mail_from', 'mail_smtp_user', 'mail_smtp_pass', 'payee_name']) {
      db.prepare('DELETE FROM settings WHERE key=? AND user_id=?').run(k, idA);
    }
    const leftover = db.prepare('SELECT COUNT(*) n FROM projects WHERE name LIKE ?').get(`${TAG}%`).n;
    check('测试项目已清空', leftover === 0, leftover);
  } finally {
    for (const id of [idA, idB]) {
      await call('DELETE', `/api/admin/users/${id}`, undefined, adminCookie);
    }
    const usersLeft = db.prepare('SELECT COUNT(*) n FROM users WHERE username IN (?,?)').get('iso_a', 'iso_b').n;
    check('测试账号已删除', usersLeft === 0, usersLeft);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
