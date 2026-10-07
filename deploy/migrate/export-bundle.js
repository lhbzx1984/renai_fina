#!/usr/bin/env node
'use strict';

/**
 * 数据迁移 · 打包导出（在本机/旧机器上运行）
 *
 * 作用：把 data/ 下的 SQLite 数据库 + 票据原件 + 导出件，做成一个可上传到服务器的 bundle。
 *
 * 关键处理（都是踩过的坑，勿简化）：
 *   1. 用 VACUUM INTO 生成快照。直接拷 .db 会丢掉 WAL 里未合并的写入。
 *   2. 清空 sessions / verify_codes。它们是机器相关的临时凭据，迁过去等于把旧登录态搬上新机。
 *   3. 重写 exports.file_path。本机存的是 Windows 绝对路径（C:\Users\...），
 *      到服务器上必然打不开；改成占位符 __EXPORT_DIR__/<文件名>，导入时再落地成服务器真实目录。
 *   4. 只搬被 receipts 引用到的票据文件，孤儿文件不进包。
 *   5. manifest.json 里的敏感设置一律脱敏（不写 SMTP 授权码）。
 *
 * 用法：
 *   node deploy/migrate/export-bundle.js
 *   node deploy/migrate/export-bundle.js --src-dir data --out deploy/migrate/_bundle
 *   node deploy/migrate/export-bundle.js --no-exports      # 不搬导出件（同时清空导出记录）
 *   node deploy/migrate/export-bundle.js --with-orphans    # 連孤儿票据文件一起搬
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..', '..');

// ---------- 参数 ----------
function takeArg(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const hasFlag = (f) => process.argv.includes(f);

const SRC_DIR = path.resolve(takeArg('--src-dir', path.join(ROOT, 'data')));
const OUT_DIR = path.resolve(takeArg('--out', path.join(ROOT, 'deploy', 'migrate', '_bundle')));
const WITH_EXPORTS = !hasFlag('--no-exports');
const WITH_ORPHANS = hasFlag('--with-orphans');
const CLEAN = hasFlag('--clean');

const SRC_DB = path.join(SRC_DIR, 'reimburse.db');
const SRC_UPLOADS = path.join(SRC_DIR, 'uploads');
const SRC_EXPORTS = takeArg('--src-exports', path.join(ROOT, 'exports'));

const OUT_DB = path.join(OUT_DIR, 'reimburse.db');
const OUT_UPLOADS = path.join(OUT_DIR, 'uploads');
const OUT_EXPORTS = path.join(OUT_DIR, 'exports');

const TAB_SQLITE_KEY = '__EXPORT_DIR__';
const SECRET_RE = /(pass|secret|token|authorization|ak\b|sk\b)/i;

const log = (s = '') => console.log(s);
const head = (s) => log('\n▌' + s);
const ok = (s) => log('  [OK]   ' + s);
const warn = (s) => log('  [WARN] ' + s);
const info = (s) => log('         ' + s);
function die(msg) { console.error('\n  [ERR]  ' + msg); process.exit(1); }

const warnings = [];
const sha256 = (f) =>
  crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// 文件名可能在 Windows 路径里，两种分隔符都要认
const baseName = (p) => {
  const s = String(p || '').replace(/\\/g, '/');
  return s.slice(s.lastIndexOf('/') + 1);
};

// ---------- 0. 前置检查 ----------
head('0/5 前置检查');
if (!fs.existsSync(SRC_DB)) die(`找不到源数据库：${SRC_DB}`);
ok(`源数据库: ${SRC_DB}  (${(fs.statSync(SRC_DB).size / 1024).toFixed(0)} KB)`);

let srcDb;
try {
  srcDb = new DatabaseSync(SRC_DB);
} catch (e) {
  die(`数据库打不开（可能有进程正在占用，先停掉本机服务）：${e.message}`);
}

const jm = srcDb.prepare('PRAGMA journal_mode').get().journal_mode;
info(`日志模式: ${jm}`);
for (const ext of ['-wal', '-shm']) {
  const f = SRC_DB + ext;
  if (fs.existsSync(f) && fs.statSync(f).size > 0) {
    const kb = (fs.statSync(f).size / 1024).toFixed(0);
    warnings.push(`存在未合并的 ${ext}（${kb} KB）：已通过 VACUUM INTO 取一致性快照，不影响迁移。`);
    warn(`检测到 ${ext}（${kb} KB）—— 会取一致性快照，勿跳过 VACUUM`);
  }
}

const integrity = srcDb.prepare('PRAGMA integrity_check').get().integrity_check;
if (integrity !== 'ok') die(`源库完整性检查失败：${integrity}`);
ok('源库完整性检查通过');

// ---------- 1. 生成一致性快照 ----------
head('1/5 生成数据库快照');
fs.mkdirSync(OUT_DIR, { recursive: true });
if (CLEAN) {
  for (const f of ['reimburse.db', 'manifest.json']) {
    if (fs.existsSync(path.join(OUT_DIR, f))) fs.unlinkSync(path.join(OUT_DIR, f));
  }
}
if (fs.existsSync(OUT_DB)) fs.unlinkSync(OUT_DB); // VACUUM INTO 要求目标不存在
const t0 = Date.now();
srcDb.exec(`VACUUM INTO '${OUT_DB.replace(/\\/g, '/').replace(/'/g, "''")}'`);
srcDb.close();
ok(`快照已生成 (${(fs.statSync(OUT_DB).size / 1024).toFixed(0)} KB, ${Date.now() - t0} ms)`);

// ---------- 2. 清洗临时数据 / 改写路径 ----------
head('2/5 清洗快照');
const out = new DatabaseSync(OUT_DB);
out.exec('PRAGMA foreign_keys = OFF');

let sessions = 0, codes = 0;
try { sessions = out.prepare('DELETE FROM sessions').run().changes; } catch { /* 老版本无此表 */ }
try { codes = out.prepare('DELETE FROM verify_codes').run().changes; } catch { /* 同上 */ }
ok(`清空会话 ${sessions} 条、验证码 ${codes} 条（机器相关，不迁移）`);

// 导出记录：Windows 绝对路径 -> 占位符
let exportRows = 0, exportKeep = 0, exportDrop = 0, exportMissing = 0;
const exportFiles = new Set();
if (out.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='exports'").get()) {
  const rows = out.prepare('SELECT id, file_path FROM exports').all();
  exportRows = rows.length;
  const upd = out.prepare('UPDATE exports SET file_path = ? WHERE id = ?');
  for (const r of rows) {
    const b = baseName(r.file_path);
    if (!b) { out.prepare('DELETE FROM exports WHERE id = ?').run(r.id); exportDrop++; continue; }
    const srcFile = path.join(SRC_EXPORTS, b);
    if (!WITH_EXPORTS || !fs.existsSync(srcFile)) {
      out.prepare('DELETE FROM exports WHERE id = ?').run(r.id);
      WITH_EXPORTS ? exportMissing++ : exportDrop++;
      continue;
    }
    exportFiles.add(b);
    upd.run(`${TAB_SQLITE_KEY}/${b}`, r.id);
    exportKeep++;
  }
  ok(`导出记录 ${exportRows} 条：保留 ${exportKeep}，删除 ${exportDrop + exportMissing}` +
     (WITH_EXPORTS ? '' : '（--no-exports）'));
  info(`路径已改写为 ${TAB_SQLITE_KEY}/<文件名>，导入时替换为服务器 EXPORT_DIR`);
}

out.exec('VACUUM');
out.exec('PRAGMA foreign_keys = ON');

// ---------- 3. 收集待迁移文件 ----------
head('3/5 收集文件');
const count = (t) => {
  try { return out.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n; } catch { return -1; }
};
const TABLES = ['projects', 'receipts', 'receipt_items', 'members', 'trips',
  'periods', 'colleges', 'majors', 'users', 'settings', 'audit_logs', 'exports'];
const counts = {};
for (const t of TABLES) counts[t] = count(t);
const money = out.prepare('SELECT ROUND(COALESCE(SUM(amount),0),2) t FROM receipts').get().t;

const refRows = out.prepare('SELECT id, file_path FROM receipts').all();
const refs = new Set();
const missingRefs = [];
for (const r of refRows) {
  if (!r.file_path) continue;
  const b = baseName(r.file_path);
  refs.add(b);
  if (!fs.existsSync(path.join(SRC_UPLOADS, b))) missingRefs.push(`#${r.id} ${b}`);
}

const diskFiles = fs.existsSync(SRC_UPLOADS) ? fs.readdirSync(SRC_UPLOADS) : [];
const orphans = diskFiles.filter((f) => !refs.has(f));
const uploadList = WITH_ORPHANS ? diskFiles : diskFiles.filter((f) => refs.has(f));

ok(`引用票据 ${refs.size} 份，磁盘 ${diskFiles.length} 份，本次打包 ${uploadList.length} 份`);
if (missingRefs.length) {
  warnings.push(`有 ${missingRefs.length} 张票据在库里有记录但磁盘文件缺失。`);
  warn(`磁盘缺失 ${missingRefs.length} 份：`);
  missingRefs.slice(0, 5).forEach((m) => info('  ' + m));
}
if (orphans.length && !WITH_ORPHANS) {
  info(`孤儿文件 ${orphans.length} 份（重复上传/已删项目残留）不进包，仍保留在本机`);
  warnings.push(`${orphans.length} 个孤儿票据文件未迁移，保留在本机 ${SRC_UPLOADS}`);
}

// ---------- 4. 复制文件 ----------
head('4/5 复制文件');
fs.mkdirSync(OUT_UPLOADS, { recursive: true });
let upBytes = 0;
for (const f of uploadList) {
  const s = path.join(SRC_UPLOADS, f);
  if (!fs.statSync(s).isFile()) continue;
  fs.copyFileSync(s, path.join(OUT_UPLOADS, f));
  upBytes += fs.statSync(s).size;
}
ok(`票据原件 ${uploadList.length} 份 (${(upBytes / 1024 / 1024).toFixed(2)} MB)`);

let exBytes = 0;
if (exportFiles.size) {
  fs.mkdirSync(OUT_EXPORTS, { recursive: true });
  for (const f of exportFiles) {
    const s = path.join(SRC_EXPORTS, f);
    fs.copyFileSync(s, path.join(OUT_EXPORTS, f));
    exBytes += fs.statSync(s).size;
  }
  ok(`导出件 ${exportFiles.size} 份 (${(exBytes / 1024 / 1024).toFixed(2)} MB)`);
}

// ---------- 5. 设置项与清单 ----------
head('5/5 生成清单');
const settings = {};
const settingsMasked = {};
for (const r of out.prepare('SELECT key, value FROM settings ORDER BY key').all()) {
  const v = r.value == null ? '' : String(r.value);
  settings[r.key] = v;
  settingsMasked[r.key] = SECRET_RE.test(r.key)
    ? (v ? `<已设置 ${v.length} 位，随库迁移>` : '<空>')
    : v.slice(0, 120);
}

const MAIL_KEYS = ['mail_smtp_host', 'mail_smtp_port', 'mail_smtp_secure',
  'mail_smtp_user', 'mail_from', 'mail_from_name', 'mail_to'];
const mailConfig = { pass_set: !!settings.mail_smtp_pass, pass_length: (settings.mail_smtp_pass || '').length };
for (const k of MAIL_KEYS) mailConfig[k] = settings[k] || '';
const mailReady = !!(mailConfig.mail_smtp_host && mailConfig.mail_smtp_user &&
  mailConfig.pass_set && mailConfig.mail_from);
ok(`邮箱配置：${mailReady ? '完整，将随库迁移' : '不完整（迁移后需在后台补填）'}`);
info(`SMTP ${mailConfig.mail_smtp_host || '-'}:${mailConfig.mail_smtp_port || '-'}  账号 ${mailConfig.mail_smtp_user || '-'}`);
info(`发件人 ${mailConfig.mail_from || '-'}  管理员收件箱 ${mailConfig.mail_to || '-'}`);

const users = out.prepare(
  'SELECT id, username, name, email, phone, role, status FROM users ORDER BY id'
).all().map((u) => ({
  id: u.id, username: u.username, name: u.name,
  email: u.email || null, phone: u.phone || null, role: u.role, status: u.status,
}));
const projects = out.prepare('SELECT id, code, name FROM projects ORDER BY id').all();

if (!users.some((u) => u.role === 'super_admin')) {
  warnings.push('库中没有超级管理员，导入后将无法登录后台。');
  warn('库中没有超级管理员！');
}
if (users.some((u) => u.role !== 'super_admin' && !u.email)) {
  info('提示：存在无邮箱的普通用户，找回密码只能靠管理员在后台重置。');
}

const manifest = {
  bundle_version: 1,
  generated_at: new Date().toISOString(),
  generator: { node: process.version, script: 'deploy/migrate/export-bundle.js' },
  source: { db: SRC_DB, uploads: SRC_UPLOADS, journal_mode: jm },
  counts,
  receipts_total: money,
  settings: settingsMasked,
  mail_config: mailConfig,
  users, projects,
  files: {
    uploads: uploadList.sort(),
    uploads_bytes: upBytes,
    exports: [...exportFiles].sort(),
    exports_bytes: exBytes,
    missing_referenced: missingRefs,
    orphans_excluded: WITH_ORPHANS ? [] : orphans,
  },
  db: { file: 'reimburse.db', size: fs.statSync(OUT_DB).size, sha256: sha256(OUT_DB) },
  warnings,
};
fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

// 把导入脚本也放进包，保证自包含
const IMPORT_SRC = path.join(__dirname, 'import-bundle.sh');
if (fs.existsSync(IMPORT_SRC)) {
  fs.copyFileSync(IMPORT_SRC, path.join(OUT_DIR, 'import-bundle.sh'));
  ok('已附带 import-bundle.sh');
} else {
  warn('未找到 import-bundle.sh，请手动复制到服务器');
}

out.close();

// ---------- 汇总 ----------
log('\n' + '─'.repeat(58));
log('  迁移包已生成: ' + OUT_DIR);
log(`  数据库        ${(manifest.db.size / 1024).toFixed(0)} KB  sha256 ${manifest.db.sha256.slice(0, 16)}…`);
log(`  项目 ${counts.projects} / 票据 ${counts.receipts} (￥${money}) / 用户 ${counts.users} / 设置项 ${counts.settings}`);
log(`  票据原件 ${uploadList.length} 份 / 导出件 ${exportFiles.size} 份`);
log(`  邮箱配置     ${mailReady ? '已包含' : '缺失'}`);
if (warnings.length) {
  log('\n  注意事项:');
  warnings.forEach((w) => log('   · ' + w));
}
log('─'.repeat(58));

module.exports = { baseName };
