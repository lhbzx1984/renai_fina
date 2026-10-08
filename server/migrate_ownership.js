'use strict';
/**
 * 存量数据归属迁移（可重复执行，已迁移的会跳过）
 *
 * 背景：早期版本的项目表没有归属字段，所有登录用户都能看到全部项目与设置。
 * 加了 projects.owner_user_id 之后，历史项目必须补上归属人，否则这批数据
 * 对所有人同时消失（普通用户查不到 owner 为 NULL 的行）。
 *
 * 用法：
 *   node server/migrate_ownership.js                 # 自动挑归属人（优先刘海斌这类真实业务账号）
 *   node server/migrate_ownership.js --owner=lhbzx1984
 *   node server/migrate_ownership.js --owner=19      # 直接给 user id
 *   node server/migrate_ownership.js --dry           # 只看会做什么，不写库
 */
const { db, getAllSettings, setSetting, USER_SETTINGS } = require('./lib/db');

const argv = process.argv.slice(2);
const arg = (k) => (argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1] || '';
const DRY = argv.includes('--dry');

function pickOwner() {
  const spec = arg('owner');
  if (spec) {
    const byId = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(spec) || 0);
    if (byId) return byId;
    const byName = db.prepare('SELECT * FROM users WHERE username = ?').get(spec);
    if (byName) return byName;
    console.error(`找不到用户「${spec}」，可用账号：`);
    for (const u of db.prepare('SELECT id,username,name,role FROM users').all()) {
      console.error(`  #${u.id} ${u.username}（${u.name || '—'}）${u.role}`);
    }
    process.exit(1);
  }
  // 自动：优先非管理员的真实业务账号（数据多半是它建的），否则落到超管
  const biz = db.prepare("SELECT * FROM users WHERE role NOT IN ('admin','super_admin') AND status='active' ORDER BY id LIMIT 1").get();
  return biz || db.prepare("SELECT * FROM users WHERE role IN ('admin','super_admin') ORDER BY id LIMIT 1").get();
}

const owner = pickOwner();
if (!owner) { console.error('库里没有任何用户，先建账号再迁移'); process.exit(1); }
console.log(`归属人：#${owner.id} ${owner.username}（${owner.name || '—'}）${owner.role}${DRY ? ' —— 演练模式，不写库' : ''}`);

/* 1. 项目归属 */
const orphan = db.prepare('SELECT id, code, name FROM projects WHERE owner_user_id IS NULL').all();
console.log(`\n[1] 无归属项目 ${orphan.length} 个`);
for (const p of orphan) console.log(`    #${p.id} ${p.code} ${p.name}`);
if (!DRY && orphan.length) {
  db.prepare('UPDATE projects SET owner_user_id = ? WHERE owner_user_id IS NULL').run(owner.id);
  console.log(`    → 已全部归给 #${owner.id}`);
}

/* 2. 个人设置：把全局的邮件/收款配置复制一份给归属人。
      全局那份保留不动 —— auth.js 发验证码邮件时没有用户上下文，仍读全局。 */
const global = getAllSettings(0);
const mine = db.prepare('SELECT key FROM settings WHERE user_id = ?').all(owner.id).map((r) => r.key);
const toCopy = [...USER_SETTINGS].filter((k) => global[k] !== '' && global[k] != null && !mine.includes(k));
console.log(`\n[2] 复制为个人设置（${toCopy.length} 项）`);
for (const k of toCopy) {
  const secret = k === 'mail_smtp_pass';
  console.log(`    ${k} = ${secret ? '••••（授权码）' : JSON.stringify(global[k])}`);
  if (!DRY) setSetting(k, global[k], owner.id);
}

/* 3. 结果校验 */
const rows = db.prepare('SELECT owner_user_id, COUNT(*) n FROM projects GROUP BY owner_user_id').all();
console.log('\n[3] 迁移后项目归属分布：');
for (const r of rows) console.log(`    owner_user_id=${r.owner_user_id} → ${r.n} 个项目`);
if (!DRY) {
  const after = getAllSettings(owner.id);
  console.log(`\n个人邮件配置：发件人=${after.mail_from || '（空）'}  授权码=${after.mail_smtp_pass ? '已设置' : '未设置'}`);
  console.log('完成。');
}
