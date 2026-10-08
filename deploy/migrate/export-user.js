#!/usr/bin/env node
'use strict';

/**
 * 单用户数据迁移 · 打包导出（在旧机器 / 本机上运行）
 *
 * 与 export-bundle.js（整库替换）的区别：
 *   这里只导出「某一个用户」的数据，导入时按合并方式追加到目标库，
 *   目标库里已有的其他用户、其他项目一行都不会被改动。
 *
 * 导出内容：
 *   - 用户账号（含 password_hash / password_salt → 迁移后原密码继续有效）
 *   - 该用户名下的项目（owner_user_id = 该用户）及其 行程 / 成员 / 票据 / 票据明细 / 导出记录
 *   - 该用户的个人设置（settings.user_id = 该用户），比如邮箱 SMTP、收款信息
 *   - 票据原件 PDF、导出表单文件
 *
 * 默认【不导出】全局设置（报销标准、单位名称、字典等）—— 那是全校共享的，
 * 带过去会覆盖目标机上其他人的标准。确认目标机是全新空库时再加 --with-global。
 *
 * 用法：
 *   node deploy/migrate/export-user.js --user lhbzx1984
 *   node deploy/migrate/export-user.js --user 19 --out deploy/migrate/_user_lhb
 *   node deploy/migrate/export-user.js --user lhbzx1984 --with-global   # 连全局设置一起带
 *   node deploy/migrate/export-user.js --user lhbzx1984 --no-exports    # 不搬已导出表单
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..', '..');

// ---------- 参数 ----------
function takeArg(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : dflt;
}
const hasFlag = (f) => process.argv.includes(f);

const USER = takeArg('--user', 'lhbzx1984');
const SRC_DIR = path.resolve(takeArg('--src-dir', path.join(ROOT, 'data')));
const OUT_DIR = path.resolve(takeArg('--out', path.join(ROOT, 'deploy', 'migrate', '_user_' + String(USER).replace(/[^\w.-]/g, '_'))));
const WITH_GLOBAL = hasFlag('--with-global');
const WITH_EXPORTS = !hasFlag('--no-exports');
const CLEAN = hasFlag('--clean');

const SRC_DB = path.join(SRC_DIR, 'reimburse.db');
const SRC_UPLOADS = path.join(SRC_DIR, 'uploads');
const SRC_EXPORTS = path.resolve(takeArg('--src-exports', path.join(ROOT, 'exports')));

const TOKEN = '__EXPORT_DIR__';
const SECRET_RE = /(pass|secret|token|authorization|ak\b|sk\b)/i;

const log = (s = '') => console.log(s);
const head = (s) => log('\n▌' + s);
const ok = (s) => log('  [OK]   ' + s);
const warn = (s) => log('  [WARN] ' + s);
const info = (s) => log('         ' + s);
function die(msg) { console.error('\n  [ERR]  ' + msg); process.exit(1); }

const warnings = [];
const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const baseName = (p) => {
  const s = String(p || '').replace(/\\/g, '/');
  return s.slice(s.lastIndexOf('/') + 1);
};
const hasTable = (db, t) =>
  !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);

// ---------- 0. 定位用户 ----------
head('0/4 定位用户');
if (!fs.existsSync(SRC_DB)) die(`找不到源数据库：${SRC_DB}`);

let src;
try { src = new DatabaseSync(SRC_DB); }
catch (e) { die(`数据库打不开（先停掉本机服务）：${e.message}`); }

if (!hasTable(src, 'users')) die('源库里没有 users 表');
const user = /^\d+$/.test(String(USER))
  ? src.prepare('SELECT * FROM users WHERE id = ?').get(Number(USER))
  : src.prepare('SELECT * FROM users WHERE username = ?').get(String(USER));
if (!user) {
  const all = src.prepare('SELECT id, username, name FROM users ORDER BY id').all();
  die(`源库里没有用户「${USER}」。现有：\n` + all.map((u) => `    #${u.id} ${u.username} (${u.name || '-'})`).join('\n'));
}
ok(`目标用户：#${user.id} ${user.username}（${user.name || '-'}）角色 ${user.role} / ${user.status}`);

// owner_user_id 列是后加的，老库可能没有
const hasOwner = src.prepare('PRAGMA table_info(projects)').all().some((c) => c.name === 'owner_user_id');
if (!hasOwner) {
  warnings.push('源库的 projects 表没有 owner_user_id 列（老版本），无法区分归属——请先在本机跑一次 server/migrate_ownership.js 补归属。');
  warn('源库缺少 owner_user_id 列，无法确定项目归属');
}

const projIds = hasOwner
  ? src.prepare('SELECT id FROM projects WHERE owner_user_id = ? ORDER BY id').all(user.id).map((r) => r.id)
  : [];
if (!projIds.length) die(`用户 ${user.username} 名下没有项目，没什么可迁的。`);
ok(`名下项目 ${projIds.length} 个：#${projIds.join(', #')}`);

// ---------- 1. 抽取数据 ----------
head('1/4 抽取数据');
const ph = projIds.map(() => '?').join(',');
const rows = (sql, args = []) => src.prepare(sql).all(...args);

const projects = rows(`SELECT * FROM projects WHERE id IN (${ph}) ORDER BY id`, projIds);
const trips = rows(`SELECT * FROM trips WHERE project_id IN (${ph}) ORDER BY id`, projIds);
const members = rows(`SELECT * FROM members WHERE project_id IN (${ph}) ORDER BY id`, projIds);
const receipts = rows(`SELECT * FROM receipts WHERE project_id IN (${ph}) ORDER BY id`, projIds);
const rIds = receipts.map((r) => r.id);
const items = rIds.length
  ? rows(`SELECT * FROM receipt_items WHERE receipt_id IN (${rIds.map(() => '?').join(',')}) ORDER BY id`, rIds)
  : [];
const exportsRows = WITH_EXPORTS && hasTable(src, 'exports')
  ? rows(`SELECT * FROM exports WHERE project_id IN (${ph}) ORDER BY id`, projIds)
  : [];

const personalSettings = rows('SELECT key, value FROM settings WHERE user_id = ? ORDER BY key', [user.id]);
const globalSettings = WITH_GLOBAL
  ? rows('SELECT key, value FROM settings WHERE user_id = 0 ORDER BY key')
  : [];

ok(`项目 ${projects.length} / 行程 ${trips.length} / 成员 ${members.length} / 票据 ${receipts.length} / 明细 ${items.length}`);
ok(`个人设置 ${personalSettings.length} 条${WITH_GLOBAL ? ` / 全局设置 ${globalSettings.length} 条` : '（全局设置默认不导，见 --with-global）'}`);

const total = receipts.reduce((s, r) => s + (Number(r.amount) || 0), 0);
info(`票据金额合计 ￥${total.toFixed(2)}`);

// 项目引用到的字典（导入时按名称重新对齐 id）
const dictIds = (col) => [...new Set(projects.map((p) => p[col]).filter((v) => v))];
const periods = dictIds('period_id').length
  ? rows(`SELECT * FROM periods WHERE id IN (${dictIds('period_id').map(() => '?').join(',')})`, dictIds('period_id'))
  : [];
const colleges = dictIds('college_id').length
  ? rows(`SELECT * FROM colleges WHERE id IN (${dictIds('college_id').map(() => '?').join(',')})`, dictIds('college_id'))
  : [];
const majors = dictIds('major_id').length
  ? rows(`SELECT * FROM majors WHERE id IN (${dictIds('major_id').map(() => '?').join(',')})`, dictIds('major_id'))
  : [];

// ---------- 2. 文件 ----------
head('2/4 收集文件');
const uploadList = [];
const missing = [];
for (const r of receipts) {
  if (!r.file_path) continue;
  const b = baseName(r.file_path);
  if (!b) continue;
  if (fs.existsSync(path.join(SRC_UPLOADS, b))) uploadList.push(b);
  else missing.push(`#${r.id} ${b}`);
}
ok(`票据原件 ${uploadList.length} 份${missing.length ? `，缺失 ${missing.length} 份` : ''}`);
if (missing.length) {
  missing.slice(0, 5).forEach((m) => info('  缺失 ' + m));
  warnings.push(`${missing.length} 张票据在库里有记录但磁盘文件缺失，迁移后这些票打不开原件。`);
}

// 同一个表单会被反复导出，历史记录里一堆指向同一文件的行 —— 按文件名去重，只留最新一条
const byName = new Map();
for (const e of exportsRows) {
  const b = baseName(e.file_path);
  if (!b) continue;
  if (!fs.existsSync(path.join(SRC_EXPORTS, b))) continue;
  const prev = byName.get(b);
  if (!prev || Number(e.id || 0) > Number(prev.id || 0)) byName.set(b, e);
}
const exportFiles = [...byName.keys()];
const exportRowsOut = [...byName.values()].map((e) => ({ ...e, file_path: `${TOKEN}/${baseName(e.file_path)}` }));
if (exportsRows.length) {
  ok(`导出记录 ${exportsRows.length} 条 → 去重后 ${exportRowsOut.length} 条（同一表单的重复导出只留最新）`);
  if (exportsRows.length !== exportRowsOut.length) {
    info(`磁盘缺失 ${exportsRows.length - exportRowsOut.length} 条已剔除`);
  }
  info(`路径改写为 ${TOKEN}/<文件名>，导入时替换为目标机 EXPORT_DIR`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
if (CLEAN) {
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (f === 'uploads' || f === 'exports') continue;
    fs.rmSync(path.join(OUT_DIR, f), { recursive: true, force: true });
  }
}

const data = {
  bundle_version: 2,
  kind: 'user',
  generated_at: new Date().toISOString(),
  generator: { node: process.version, script: 'deploy/migrate/export-user.js' },
  user,
  dict: { periods, colleges, majors },
  projects, trips, members, receipts, receipt_items: items,
  exports: exportRowsOut,
  settings_personal: personalSettings,
  settings_global: globalSettings,
  files: { uploads: uploadList, exports: exportFiles, token: TOKEN },
};

const dump = (name, obj) => {
  const f = path.join(OUT_DIR, name);
  fs.writeFileSync(f, JSON.stringify(obj, null, 2), 'utf8');
  return { file: name, size: fs.statSync(f).size, sha256: sha256(f) };
};

const parts = [dump('data.json', data)];

const OUT_UPLOADS = path.join(OUT_DIR, 'uploads');
const OUT_EXPORTS = path.join(OUT_DIR, 'exports');
let upBytes = 0;
if (uploadList.length) {
  fs.mkdirSync(OUT_UPLOADS, { recursive: true });
  for (const f of uploadList) {
    const s = path.join(SRC_UPLOADS, f);
    fs.copyFileSync(s, path.join(OUT_UPLOADS, f));
    upBytes += fs.statSync(s).size;
  }
  ok(`已复制票据原件 ${uploadList.length} 份 (${(upBytes / 1024 / 1024).toFixed(2)} MB)`);
}
let exBytes = 0;
if (exportFiles.length) {
  fs.mkdirSync(OUT_EXPORTS, { recursive: true });
  for (const f of exportFiles) {
    const s = path.join(SRC_EXPORTS, f);
    fs.copyFileSync(s, path.join(OUT_EXPORTS, f));
    exBytes += fs.statSync(s).size;
  }
  ok(`已复制导出表单 ${exportFiles.length} 份 (${(exBytes / 1024 / 1024).toFixed(2)} MB)`);
}

// ---------- 3. 清单 ----------
head('3/4 生成清单');
const settingsMasked = {};
for (const r of personalSettings) {
  settingsMasked[r.key] = SECRET_RE.test(r.key)
    ? `<已设置 ${String(r.value).length} 位，随包迁移>` : String(r.value).slice(0, 120);
}
const mailKeys = ['mail_to', 'mail_from', 'mail_from_name', 'mail_smtp_host', 'mail_smtp_port', 'mail_smtp_secure', 'mail_smtp_user'];
const pMap = Object.fromEntries(personalSettings.map((r) => [r.key, r.value]));
const mail = { pass_set: !!pMap.mail_smtp_pass };
for (const k of mailKeys) mail[k] = pMap[k] || '';

const manifest = {
  ...data,
  user: { id: user.id, username: user.username, name: user.name, email: user.email || null, phone: user.phone || null, role: user.role, status: user.status },
  receipts_total: Number(total.toFixed(2)),
  settings_masked: settingsMasked,
  mail_config: mail,
  files: { uploads: uploadList.sort(), uploads_bytes: upBytes, exports: exportFiles.sort(), exports_bytes: exBytes, missing_referenced: missing, token: TOKEN },
  parts,
  warnings,
};
fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

const IMPORT_SRC = path.join(__dirname, 'import-user.js');
if (fs.existsSync(IMPORT_SRC)) {
  fs.copyFileSync(IMPORT_SRC, path.join(OUT_DIR, 'import-user.js'));
  ok('已附带 import-user.js（导入端自包含）');
}

src.close();

head('4/4 完成');
log('─'.repeat(60));
log(`  单用户迁移包: ${OUT_DIR}`);
log(`  用户         #${user.id} ${user.username} (${user.name || '-'})`);
log(`  项目 ${projects.length} / 票据 ${receipts.length} (￥${total.toFixed(2)}) / 成员 ${members.length} / 行程 ${trips.length}`);
log(`  个人设置 ${personalSettings.length} 条${WITH_GLOBAL ? ` / 全局 ${globalSettings.length} 条` : ''}`);
log(`  票据原件 ${uploadList.length} 份 / 导出表单 ${exportFiles.length} 份`);
log(`  邮箱配置     ${mail.mail_smtp_host && mail.pass_set ? '已包含' : '不完整（迁移后需在该用户设置页补填）'}`);
log(`  data.json    sha256 ${parts[0].sha256.slice(0, 16)}…`);
if (warnings.length) { log('\n  注意事项:'); warnings.forEach((w) => log('   · ' + w)); }
log('─'.repeat(60));
log('\n  下一步：把整个目录打包上传到服务器，跑');
log(`    node import-user.js --bundle ${path.basename(OUT_DIR)} --target /var/lib/reimburse --dry`);
