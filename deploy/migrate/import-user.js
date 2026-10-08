#!/usr/bin/env node
'use strict';

/**
 * 单用户数据迁移 · 合并导入（在目标机器 / 新部署的服务器上运行）
 *
 * 与 import-bundle.sh（整库替换）的本质区别：
 *   【合并】不是【替换】。目标库里已有的其他用户、其他项目一行都不会被删改。
 *   做法是把源库的 id 逐个重映射到目标库的新 id，再按新 id 插入。
 *
 * 处理要点（都是必须做的，别简化）：
 *   1. id 重映射：项目/行程/成员/票据在目标库里重新拿 id，子表外键跟着改。
 *      直接照搬源 id 会撞上目标库已有行，或者覆盖别人的数据。
 *   2. 项目按 code 查重：已存在默认跳过（保护目标库），--replace 才覆盖。
 *   3. 用户按 username 查重：已存在默认【不覆盖密码】（避免把别人正在用的账号密码改掉），
 *      --reset-pass 才用源库密码覆盖。
 *   4. 字典（periods/colleges/majors）按名称重新对齐 id，对不上则置空并告警，不擅自插字典。
 *   5. exports.file_path 里的占位符 __EXPORT_DIR__ 替换成目标机真实导出目录。
 *   6. 全局设置默认【不导入】——它影响所有人；只有确认目标机是空库才加 --with-global。
 *
 * 用法：
 *   node import-user.js --bundle ./_user_lhbzx1984 --target /var/lib/reimburse --dry
 *   node import-user.js --bundle ./_user_lhbzx1984 --target /var/lib/reimburse
 *   node import-user.js --bundle ./_user_lhbzx1984 --target /var/lib/reimburse --replace
 *   node import-user.js --bundle ./_user_lhbzx1984 --target /var/lib/reimburse --with-global
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// ---------- 参数 ----------
function takeArg(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : dflt;
}
const hasFlag = (f) => process.argv.includes(f);

const BUNDLE = path.resolve(takeArg('--bundle', '.'));
const TARGET = path.resolve(takeArg('--target', '/var/lib/reimburse'));
const EXPORT_DIR = process.env.EXPORT_DIR
  ? path.resolve(process.env.EXPORT_DIR)
  : path.resolve(takeArg('--export-dir', path.join(TARGET, 'exports')));
const CODE_DIR = takeArg('--code-dir', '/opt/reimburse');
const DRY = hasFlag('--dry') || hasFlag('--dry-run');
const REPLACE = hasFlag('--replace');
const RESET_PASS = hasFlag('--reset-pass');
const WITH_GLOBAL = hasFlag('--with-global');
const INIT = hasFlag('--init');
// 目标库缺同名字典时自动补建（周期/学院/专业）。只是多一个选项，不动任何人的既有数据。
const DICT_INSERT = !hasFlag('--no-dict-insert');

const log = (s = '') => console.log(s);
const head = (s) => log('\n▌' + s);
const ok = (s) => log('  [OK]   ' + s);
const warn = (s) => log('  [WARN] ' + s);
const info = (s) => log('         ' + s);
const err = (s) => log('  [ERR]  ' + s);
function die(msg) { console.error('\n  [ERR]  ' + msg); process.exit(1); }

const warnings = [];

// 目标库路径：--target 既可以是数据目录，也可以直接指到 .db 文件
const DB_PATH = TARGET.endsWith('.db') ? TARGET : path.join(TARGET, 'reimburse.db');
const UPLOAD_DIR = path.join(path.dirname(DB_PATH), 'uploads');

// ---------- 0. 读包 ----------
head('0/6 读取迁移包');
const DATA_FILE = path.join(BUNDLE, 'data.json');
if (!fs.existsSync(DATA_FILE)) die(`迁移包里没有 data.json：${BUNDLE}`);
const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
if (data.kind !== 'user') die('这不是单用户迁移包（kind=' + data.kind + '），整库迁移请用 import-bundle.sh');

const u = data.user;
ok(`包内用户：#${u.id} ${u.username}（${u.name || '-'}）`);
ok(`项目 ${data.projects.length} / 行程 ${data.trips.length} / 成员 ${data.members.length} / 票据 ${data.receipts.length} / 明细 ${data.receipt_items.length}`);
info(`个人设置 ${data.settings_personal.length} 条 / 导出记录 ${data.exports.length} 条`);
const total = data.receipts.reduce((s, r) => s + (Number(r.amount) || 0), 0);
info(`票据金额合计 ￥${total.toFixed(2)}`);

// ---------- 1. 目标库 ----------
head('1/6 打开目标库');
if (!fs.existsSync(DB_PATH) && INIT) {
  info(`目标库不存在，尝试用 ${CODE_DIR} 初始化…`);
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath,
    ['-e', `process.env.DATA_DIR=${JSON.stringify(path.dirname(DB_PATH))};process.env.EXPORT_DIR=${JSON.stringify(EXPORT_DIR)};require(${JSON.stringify(path.join(CODE_DIR, 'server', 'lib', 'db.js'))});`],
    { encoding: 'utf8' });
  if (r.status !== 0) die('初始化失败：' + (r.stderr || r.stdout || '').slice(0, 400));
}
if (!fs.existsSync(DB_PATH)) {
  die(`目标库不存在：${DB_PATH}\n` +
      `         先启动一次服务让它建库（会连带 seed 字典），或者加 --init --code-dir <项目目录>`);
}
ok(`目标库: ${DB_PATH}  (${(fs.statSync(DB_PATH).size / 1024).toFixed(0)} KB)`);

let db;
try { db = new DatabaseSync(DB_PATH); }
catch (e) { die(`目标库打不开（先停掉服务：systemctl stop reimburse）：${e.message}`); }

const hasTable = (t) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
if (!hasTable('projects') || !hasTable('users')) die('目标库还没建表，请先启动一次服务完成初始化。');

const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
const before = {
  users: db.prepare('SELECT COUNT(*) n FROM users').get().n,
  projects: db.prepare('SELECT COUNT(*) n FROM projects').get().n,
  receipts: db.prepare('SELECT COUNT(*) n FROM receipts').get().n,
  members: db.prepare('SELECT COUNT(*) n FROM members').get().n,
  trips: db.prepare('SELECT COUNT(*) n FROM trips').get().n,
};
ok(`导入前：用户 ${before.users} / 项目 ${before.projects} / 票据 ${before.receipts} / 成员 ${before.members} / 行程 ${before.trips}`);

// 记录「其他人」的数据，导入后要逐项核对没被动过。
// 注意要用【目标库里这个人的 id】，不是源库 id —— 用错会把本次新导进来的项目也算成"别人的"。
const meInTarget = db.prepare('SELECT id FROM users WHERE username = ?').get(u.username);
const mineOrNull = (uid) => `(IFNULL(owner_user_id,-1) <> ${Number.isInteger(uid) ? uid : -1})`;
const othersBefore = db.prepare(`SELECT id FROM projects WHERE ${mineOrNull(meInTarget ? meInTarget.id : -1)}`)
  .all().map((r) => r.id);

// 备份
if (!DRY) {
  const bak = DB_PATH + '.bak-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  try {
    db.exec(`VACUUM INTO '${bak.replace(/\\/g, '/').replace(/'/g, "''")}'`);
    ok(`已备份目标库 → ${bak}`);
  } catch (e) { die('备份失败，拒绝继续：' + e.message); }
}

// ---------- 工具 ----------
/** 按可用列插入一行，返回新 id */
function insertRow(table, row, overrides = {}) {
  const allow = new Set(cols(table));
  const keys = Object.keys(row).filter((k) => k !== 'id' && allow.has(k));
  const vals = keys.map((k) => (k in overrides ? overrides[k] : row[k]));
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  return db.prepare(sql).run(...vals).lastInsertRowid;
}
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

const userMap = {};      // 源 user.id → 目标 id
const projMap = {};      // 源 project.id → 目标 id
const tripMap = {};
const memberMap = {};
const receiptMap = {};

// ---------- 2. 用户 ----------
head('2/6 用户账号');
const existUser = db.prepare('SELECT * FROM users WHERE username = ?').get(u.username);
let targetUserId;
if (existUser) {
  targetUserId = existUser.id;
  if (RESET_PASS && !DRY) {
    db.prepare('UPDATE users SET password_hash=?, password_salt=? WHERE id=?')
      .run(u.password_hash, u.password_salt, targetUserId);
    ok(`用户 ${u.username} 已存在（#${targetUserId}），已用迁移包的密码覆盖（--reset-pass）`);
  } else {
    ok(`用户 ${u.username} 已存在（#${targetUserId}）：保留目标库现有密码，不被覆盖`);
    if (!RESET_PASS) info('需要同步源库密码请加 --reset-pass（会把目标库该账号的密码改掉）');
  }
  // 只补空字段，不覆盖已有资料
  if (!DRY) {
    const patch = {};
    if (!existUser.name && u.name) patch.name = u.name;
    if (!existUser.email && u.email) patch.email = u.email;
    if (!existUser.phone && u.phone) patch.phone = u.phone;
    if (!existUser.job_no && u.job_no) patch.job_no = u.job_no;
    for (const [k, v] of Object.entries(patch)) {
      db.prepare(`UPDATE users SET ${k}=? WHERE id=?`).run(v, targetUserId);
    }
    if (Object.keys(patch).length) info('已补全空资料字段：' + Object.keys(patch).join(', '));
  }
} else {
  const row = { ...u };
  delete row.id;
  // 邮箱/手机在目标库可能已被别人占用，冲突则丢弃，避免整个导入失败
  for (const k of ['email', 'phone']) {
    if (!row[k]) continue;
    const clash = db.prepare(`SELECT id FROM users WHERE ${k} = ?`).get(row[k]);
    if (clash) { warn(`${k}「${row[k]}」在目标库已被 #${clash.id} 占用，本次不写入该字段`); delete row[k]; }
  }
  // 学院/专业不映射：源库 id 在目标库指向的可能完全是另一个学院，宁可留空让用户自己选
  if (DRY) { targetUserId = '(新)'; }
  else targetUserId = insertRow('users', row, { college_id: null, major_id: null });
  ok(`新建用户 ${u.username} → #${targetUserId}（密码沿用源库，原密码可直接登录）`);
}
userMap[u.id] = targetUserId;

// ---------- 3. 字典对齐 ----------
head('3/6 字典对齐（按名称，绝不照搬源 id）');
/**
 * 为什么必须按名称重建：
 *   源库 college_id=1 可能是「数智传媒与设计艺术学院」，目标库 college_id=1 却可能是
 *   「机械与动力工程学院」——两库的 id 互不通用，照搬会把项目挂到完全不相干的学院。
 *   同理 periods / majors。所以一律按名称匹配，缺的再按级联关系补建。
 *   补建字典只是多一个可选项，不会动到任何人的既有数据。
 */
const dictStats = { hit: 0, created: 0 };
function findOrCreate(table, selSql, selArgs, insSql, insArgs) {
  const r = db.prepare(selSql).get(...selArgs);
  if (r) { dictStats.hit++; return r.id; }
  if (DICT_INSERT && !DRY) {
    const id = db.prepare(insSql).run(...insArgs).lastInsertRowid;
    dictStats.created++;
    return id;
  }
  dictStats.created += 0;
  return null;
}

const periodMap = {}, collegeMap = {}, majorMap = {};
for (const p of data.dict.periods || []) {
  periodMap[p.id] = findOrCreate('periods',
    'SELECT id FROM periods WHERE kind=? AND name=?', [p.kind, p.name],
    'INSERT INTO periods(kind,name,start_date,end_date,is_default) VALUES(?,?,?,?,?)',
    [p.kind, p.name, p.start_date || null, p.end_date || null,
      p.is_default && !db.prepare('SELECT id FROM periods WHERE is_default=1').get() ? 1 : 0]);
  if (periodMap[p.id] == null) warnings.push(`周期「${p.name}」未对齐（--no-dict-insert），相关项目 period_id 置空`);
}
for (const c of data.dict.colleges || []) {
  collegeMap[c.id] = findOrCreate('colleges',
    'SELECT id FROM colleges WHERE name=?', [c.name],
    'INSERT INTO colleges(name,sort_order) VALUES(?,?)', [c.name, c.sort_order || 0]);
  if (collegeMap[c.id] == null) warnings.push(`学院「${c.name}」未对齐（--no-dict-insert），相关项目 college_id 置空`);
}
for (const m of data.dict.majors || []) {
  // 专业挂在学院下，必须先把父学院落到目标库，再按 (学院, 名称) 匹配
  const cid = collegeMap[m.college_id] != null ? collegeMap[m.college_id] : m.college_id;
  majorMap[m.id] = findOrCreate('majors',
    'SELECT id FROM majors WHERE college_id=? AND name=?', [cid, m.name],
    'INSERT INTO majors(college_id,name,sort_order) VALUES(?,?,?)', [cid, m.name, m.sort_order || 0]);
  if (majorMap[m.id] == null) warnings.push(`专业「${m.name}」未对齐（--no-dict-insert），相关项目 major_id 置空`);
}
const needDict = (data.dict.periods || []).length + (data.dict.colleges || []).length + (data.dict.majors || []).length;
ok(`字典 ${needDict} 项：按名称命中 ${dictStats.hit}，补建 ${dictStats.created}` +
   (DICT_INSERT ? '' : '（--no-dict-insert：缺的置空，不补建）'));

// ---------- 4. 业务数据 ----------
head('4/6 写入业务数据');
const stats = { project_new: 0, project_skip: 0, project_replace: 0, trips: 0, members: 0, receipts: 0, items: 0, exports: 0 };

if (!DRY) db.exec('BEGIN');
try {
  for (const p of data.projects) {
    const exist = db.prepare('SELECT id FROM projects WHERE code = ?').get(p.code);
    let newId;
    if (exist) {
      if (!REPLACE) { stats.project_skip++; projMap[p.id] = null; warn(`项目 ${p.code} 在目标库已存在（#${exist.id}），已跳过（--replace 可覆盖）`); continue; }
      // 覆盖：只删这一个项目及其级联数据，别人的项目不受影响
      const rIds = db.prepare('SELECT id FROM receipts WHERE project_id=?').all(exist.id).map((r) => r.id);
      if (rIds.length) db.prepare(`DELETE FROM receipt_items WHERE receipt_id IN (${rIds.map(() => '?').join(',')})`).run(...rIds);
      db.prepare('DELETE FROM receipts WHERE project_id=?').run(exist.id);
      db.prepare('DELETE FROM members WHERE project_id=?').run(exist.id);
      db.prepare('DELETE FROM trips WHERE project_id=?').run(exist.id);
      db.prepare('DELETE FROM exports WHERE project_id=?').run(exist.id);
      db.prepare('DELETE FROM projects WHERE id=?').run(exist.id);
      stats.project_replace++;
    }
    newId = DRY ? '(新)' : insertRow('projects', p, {
      owner_user_id: num(targetUserId),
      period_id: periodMap[p.period_id] != null ? periodMap[p.period_id] : null,
      college_id: collegeMap[p.college_id] != null ? collegeMap[p.college_id] : null,
      major_id: majorMap[p.major_id] != null ? majorMap[p.major_id] : null,
    });
    if (!exist) stats.project_new++;
    projMap[p.id] = newId;
  }
  ok(`项目：新建 ${stats.project_new}，覆盖 ${stats.project_replace}，跳过 ${stats.project_skip}`);

  for (const t of data.trips) {
    const pid = projMap[t.project_id];
    if (pid == null) continue;
    const id = DRY ? '(新)' : insertRow('trips', t, { project_id: pid });
    tripMap[t.id] = id; stats.trips++;
  }
  ok(`行程 ${stats.trips} 条`);

  // 成员可能引用行程，先建成员再回填行程关联
  for (const m of data.members) {
    const pid = projMap[m.project_id];
    if (pid == null) continue;
    const id = DRY ? '(新)' : insertRow('members', m, {
      project_id: pid,
      trip_id: m.trip_id != null ? (tripMap[m.trip_id] ?? null) : null,
    });
    memberMap[m.id] = id; stats.members++;
  }
  ok(`成员 ${stats.members} 人`);

  for (const r of data.receipts) {
    const pid = projMap[r.project_id];
    if (pid == null) continue;
    const id = DRY ? '(新)' : insertRow('receipts', r, {
      project_id: pid,
      member_id: r.member_id != null ? (memberMap[r.member_id] ?? null) : null,
    });
    receiptMap[r.id] = id; stats.receipts++;
  }
  ok(`票据 ${stats.receipts} 张（￥${total.toFixed(2)}）`);

  for (const it of data.receipt_items) {
    const rid = receiptMap[it.receipt_id];
    if (rid == null) continue;
    if (!DRY) insertRow('receipt_items', it, {
      receipt_id: rid,
      member_id: it.member_id != null ? (memberMap[it.member_id] ?? null) : null,
    });
    stats.items++;
  }
  ok(`票据分摊明细 ${stats.items} 条`);

  for (const e of data.exports || []) {
    const pid = projMap[e.project_id];
    if (pid == null) continue;
    const fp = String(e.file_path || '').replace(data.files.token, EXPORT_DIR);
    if (!DRY) insertRow('exports', e, { project_id: pid, file_path: fp });
    stats.exports++;
  }
  ok(`导出记录 ${stats.exports} 条（路径已指向 ${EXPORT_DIR}）`);

  // ---------- 5. 设置 ----------
  head('5/6 设置项');
  const upsertSetting = (key, value, uid) => {
    db.prepare('INSERT INTO settings(key,user_id,value) VALUES(?,?,?) ON CONFLICT(key,user_id) DO UPDATE SET value=excluded.value')
      .run(key, uid, String(value));
  };
  if (typeof targetUserId === 'number') {
    for (const s of data.settings_personal || []) {
      if (!DRY) upsertSetting(s.key, s.value, targetUserId);
    }
    ok(`个人设置 ${data.settings_personal.length} 条 → 挂在用户 #${targetUserId} 名下`);
    info('含 SMTP 授权码等私密项，只对该用户可见，其他用户看不到');
  }
  if (WITH_GLOBAL) {
    for (const s of data.settings_global || []) {
      if (!DRY) upsertSetting(s.key, s.value, 0);
    }
    warn(`已写入 ${data.settings_global.length} 条【全局】设置 —— 会影响目标机上所有人`);
  } else if ((data.settings_global || []).length) {
    info(`包里带 ${data.settings_global.length} 条全局设置，默认未导入（--with-global 才会写，它会改所有人的报销标准）`);
  }

  if (!DRY) db.exec('COMMIT');
} catch (e) {
  if (!DRY) { try { db.exec('ROLLBACK'); } catch (_) { /* 已回滚 */ } }
  die('写入失败，已回滚：' + e.message);
}

// ---------- 6. 文件 ----------
head('6/6 票据原件与导出表单');
function copyDir(srcDir, dstDir, list, label) {
  if (!list || !list.length) return 0;
  let n = 0, bytes = 0, skip = 0, miss = 0;
  if (!DRY) fs.mkdirSync(dstDir, { recursive: true });
  for (const f of list) {
    const s = path.join(srcDir, f);
    const d = path.join(dstDir, f);
    if (!fs.existsSync(s)) { miss++; continue; }
    if (fs.existsSync(d)) { skip++; continue; }   // 不覆盖目标机已有文件
    if (!DRY) fs.copyFileSync(s, d);
    n++; bytes += fs.statSync(s).size;
  }
  ok(`${label} 复制 ${n} 份 (${(bytes / 1024 / 1024).toFixed(2)} MB) → ${dstDir}` +
     (skip ? `，已存在跳过 ${skip} 份` : '') + (miss ? `，包内缺失 ${miss} 份` : ''));
  if (miss) warnings.push(`${label}有 ${miss} 份在包里找不到`);
  return n;
}
copyDir(path.join(BUNDLE, 'uploads'), UPLOAD_DIR, data.files.uploads, '票据原件');
copyDir(path.join(BUNDLE, 'exports'), EXPORT_DIR, data.files.exports, '导出表单');

// ---------- 核对 ----------
head('核对');
if (!DRY) {
  const after = {
    users: db.prepare('SELECT COUNT(*) n FROM users').get().n,
    projects: db.prepare('SELECT COUNT(*) n FROM projects').get().n,
    receipts: db.prepare('SELECT COUNT(*) n FROM receipts').get().n,
    members: db.prepare('SELECT COUNT(*) n FROM members').get().n,
    trips: db.prepare('SELECT COUNT(*) n FROM trips').get().n,
  };
  const row = (k) => {
    const d = after[k] - before[k];
    const expect = k === 'users' ? (existUser ? 0 : 1)
      : k === 'projects' ? stats.project_new + (stats.project_replace ? 0 : 0)
        : k === 'receipts' ? stats.receipts : k === 'members' ? stats.members : stats.trips;
    const good = k === 'users' ? (existUser ? d === 0 : d === 1) : d === expect;
    log(`  ${good ? '[OK ]' : '[差异]'} ${k.padEnd(9)} ${before[k]} → ${after[k]}  (新增 ${d})`);
    return good;
  };
  let allGood = true;
  for (const k of ['users', 'projects', 'receipts', 'members', 'trips']) allGood = row(k) && allGood;

  // 其他人的项目必须原封不动
  const othersAfter = db.prepare(`SELECT id FROM projects WHERE ${mineOrNull(targetUserId)}`)
    .all().map((r) => r.id);
  const lost = othersBefore.filter((x) => !othersAfter.includes(x));
  if (lost.length) { err(`其他用户的项目被改动了：#${lost.join(', #')}`); allGood = false; }
  else ok(`其他用户的项目 ${othersBefore.length} → ${othersAfter.length} 个，导入前后一致，未被影响`);

  // 目标库里该用户的项目数量
  const mine = db.prepare('SELECT COUNT(*) n FROM projects WHERE owner_user_id = ?').get(targetUserId).n;
  ok(`用户 #${targetUserId} 名下现有项目 ${mine} 个`);
  const money = db.prepare(`SELECT ROUND(COALESCE(SUM(r.amount),0),2) t FROM receipts r
     JOIN projects p ON p.id = r.project_id WHERE p.owner_user_id = ?`).get(targetUserId).t;
  log(`  票据金额 ￥${money}`);

  // 票据原件是否齐全
  const miss = db.prepare(`SELECT r.id, r.file_path FROM receipts r JOIN projects p ON p.id=r.project_id
     WHERE p.owner_user_id = ? AND r.file_path IS NOT NULL AND r.file_path <> ''`).all(targetUserId)
    .filter((r) => !fs.existsSync(path.join(UPLOAD_DIR, path.basename(String(r.file_path).replace(/\\/g, '/')))));
  if (miss.length) { warn(`有 ${miss.length} 张票据原件在磁盘上找不到：`); miss.slice(0, 5).forEach((m) => info('   #' + m.id + ' ' + m.file_path)); }
  else ok('该用户所有票据原件在磁盘上齐全');

  log('\n' + (allGood ? '  核对通过：数据已合并，其他用户未受影响' : '  存在差异，请人工确认后再放行'));
} else {
  info('--dry 演练模式：未写入任何数据、未复制任何文件');
  info(`将要：${existUser ? `复用用户 #${existUser.id}` : '新建用户'} ${u.username}；` +
       `新建项目 ${stats.project_new}，跳过 ${stats.project_skip}`);
  info(`票据 ${stats.receipts} 张 / 成员 ${stats.members} / 行程 ${stats.trips} / 明细 ${stats.items}`);
}

if (warnings.length) {
  log('\n  注意事项:');
  [...new Set(warnings)].forEach((w) => log('   · ' + w));
}
db.close();
log('');
