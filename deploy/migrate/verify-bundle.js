'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const BUNDLE = process.argv[2] || path.join(__dirname, '_bundle');
const db = new DatabaseSync(path.join(BUNDLE, 'reimburse.db'));

let bad = 0;
const chk = (name, cur, exp) => {
  const good = exp === undefined || String(exp) === String(cur);
  if (!good) bad++;
  console.log(`   [${good ? 'OK ' : '差异'}] ${name.padEnd(14)}${String(cur).padStart(8)}${exp !== undefined ? '  (期望 ' + exp + ')' : ''}`);
};

console.log('=== 快照自检 ===');
console.log('  integrity    :', db.prepare('PRAGMA integrity_check').get().integrity_check);
chk('sessions', db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 0);
chk('verify_codes', db.prepare('SELECT COUNT(*) n FROM verify_codes').get().n, 0);

const m = JSON.parse(fs.readFileSync(path.join(BUNDLE, 'manifest.json'), 'utf8'));
console.log('');
console.log('=== 与 manifest 核对 ===');
for (const t of ['projects', 'receipts', 'users', 'settings', 'periods', 'members', 'trips']) {
  chk(t, db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n, m.counts[t]);
}
const total = db.prepare('SELECT ROUND(COALESCE(SUM(amount),0),2) t FROM receipts').get().t;
chk('票据总额', 'Y' + total, 'Y' + m.receipts_total);

console.log('');
console.log('=== exports 路径改写 ===');
const rows = db.prepare('SELECT file_path, COUNT(*) c FROM exports GROUP BY file_path').all();
for (const r of rows) console.log('   ', r.c + 'x', r.file_path);

console.log('');
console.log('=== 邮箱配置（脱敏显示）===');
const g = (k) => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? String(r.value) : ''; };
for (const k of ['mail_smtp_host', 'mail_smtp_port', 'mail_smtp_secure', 'mail_smtp_user', 'mail_from', 'mail_from_name', 'mail_to']) {
  console.log('   ', k.padEnd(18), g(k) || '(空)');
}
console.log('    mail_smtp_pass     ', g('mail_smtp_pass') ? `已迁移 ${g('mail_smtp_pass').length} 位` : '缺失！迁移后将无法发验证码邮件');

console.log('');
console.log('=== 残留本机绝对路径扫描 ===');
let dirty = 0;
for (const t of ['exports', 'receipts', 'projects', 'settings']) {
  for (const r of db.prepare(`SELECT * FROM ${t}`).all()) {
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === 'string' && /^[A-Za-z]:[\\/]/.test(v)) { console.log('   残留!', t, k, v); dirty++; }
    }
  }
}
console.log('   结果:', dirty === 0 ? '干净，无 Windows 路径残留' : `仍有 ${dirty} 处！`);
if (dirty) bad++;

console.log('');
console.log('=== 文件完整性 ===');
const upMissing = db.prepare('SELECT id, file_path FROM receipts').all()
  .filter((r) => r.file_path)
  .filter((r) => !fs.existsSync(path.join(BUNDLE, 'uploads', String(r.file_path).replace(/\\/g, '/').split('/').pop())));
console.log('   票据原件缺失:', upMissing.length, upMissing.length ? upMissing.slice(0, 3).map((r) => '#' + r.id).join(' ') : '');
if (upMissing.length) bad++;
const exMissing = [...new Set(rows.map((r) => String(r.file_path).replace('__EXPORT_DIR__/', '')))]
  .filter((f) => !fs.existsSync(path.join(BUNDLE, 'exports', path.basename(f))));
console.log('   导出件缺失  :', exMissing.length, exMissing.join(' '));
if (exMissing.length) bad++;
console.log('   manifest.json 存在:', fs.existsSync(path.join(BUNDLE, 'manifest.json')));
console.log('   import 脚本存在  :', fs.existsSync(path.join(BUNDLE, 'import-bundle.sh')));

console.log('');
console.log(bad === 0 ? '>>> 全部通过，可以打包上传' : `>>> ${bad} 项异常，先修再传`);
db.close();
process.exit(bad === 0 ? 0 : 1);
