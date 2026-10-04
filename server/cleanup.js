'use strict';
/**
 * 清理测试数据与孤儿文件，保持系统里只有真实业务数据。
 * 用法： node cleanup.js            （清理并打印报告）
 *        node cleanup.js --dry       （只看会清什么，不动手）
 *
 * 规则：
 * 1. 删除名称以「冒烟测试 / UI烟测 / 测试」开头的项目（连同票据文件，走 API 保证级联）
 * 2. 把 uploads 中没有对应票据记录的孤儿文件移到 data/_trash/（不直接删，可回溯）
 * 3. 输出清理前后的统计
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const DB = path.join(ROOT, 'data', 'reimburse.db');
const UPLOADS = path.join(ROOT, 'data', 'uploads');
const BASE = process.env.BASE || 'http://127.0.0.1:5180';
const DRY = process.argv.includes('--dry');
const TEST_PREFIX = /^(冒烟测试|UI烟测|测试)/;

const db = new DatabaseSync(DB);

async function main() {
  console.log('\n=== 测试数据清理 ===\n');

  /* 1. 测试项目 */
  const projects = db.prepare('SELECT id,code,name FROM projects ORDER BY id').all();
  const stale = projects.filter((p) => TEST_PREFIX.test(p.name || ''));
  console.log(`[项目] 共 ${projects.length} 个，测试项目 ${stale.length} 个`);
  for (const p of stale) {
    console.log(`   - ${p.code} ${p.name}`);
    if (!DRY) {
      try { await fetch(`${BASE}/api/projects/${p.id}`, { method: 'DELETE' }); }
      catch (e) { console.log('     删除失败（服务未启动？）：' + e.message); }
    }
  }

  /* 2. 测试期间 */
  const periods = db.prepare('SELECT id,name FROM periods').all();
  const staleP = periods.filter((p) => /测试/.test(p.name || ''));
  console.log(`[期间] 共 ${periods.length} 个，测试期间 ${staleP.length} 个`);
  for (const p of staleP) {
    console.log(`   - ${p.name}`);
    if (!DRY) {
      try { await fetch(`${BASE}/api/periods/${p.id}`, { method: 'DELETE' }); }
      catch (e) { console.log('     删除失败：' + e.message); }
    }
  }

  /* 3. 孤儿上传文件 */
  const keep = new Set(db.prepare('SELECT file_path FROM receipts').all().map((r) => r.file_path).filter(Boolean));
  const files = fs.existsSync(UPLOADS) ? fs.readdirSync(UPLOADS).filter((f) => fs.statSync(path.join(UPLOADS, f)).isFile()) : [];
  const orphans = files.filter((f) => !keep.has(f));
  console.log(`[文件] uploads 共 ${files.length} 个，孤儿 ${orphans.length} 个`);
  if (orphans.length && !DRY) {
    const bak = path.join(ROOT, 'data', '_trash', 'uploads-orphan-' + Date.now());
    fs.mkdirSync(bak, { recursive: true });
    let moved = 0;
    for (const f of orphans) {
      try { fs.renameSync(path.join(UPLOADS, f), path.join(bak, f)); moved++; }
      catch (e) { console.log('     移动失败 ' + f + '：' + e.message); }
    }
    console.log(`   已移出 ${moved} 个 → ${path.relative(ROOT, bak)}`);
  }

  /* 4. 报告 */
  const after = db.prepare('SELECT COUNT(*) c FROM projects').get().c;
  const afterR = db.prepare('SELECT COUNT(*) c FROM receipts').get().c;
  const afterF = fs.existsSync(UPLOADS) ? fs.readdirSync(UPLOADS).length : 0;
  console.log(`\n清理后：项目 ${after} 个、票据 ${afterR} 张、上传文件 ${afterF} 个`);
  for (const p of db.prepare('SELECT id,code,name FROM projects ORDER BY id').all()) console.log('   · ' + p.code + ' ' + p.name);
  console.log(DRY ? '\n（演练模式，未做任何改动）\n' : '\n完成\n');
}

main().catch((e) => { console.error('清理异常：', e); process.exit(1); });
