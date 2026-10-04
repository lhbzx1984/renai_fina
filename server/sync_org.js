'use strict';
/**
 * 把数据库中的学院/专业同步为官网真实数据（server/lib/org.js）。
 *
 *   node server/sync_org.js            同步（默认：只增不改结构，清理非法专业）
 *   node server/sync_org.js --dry-run  只打印差异，不写库
 *   node server/sync_org.js --prune    额外删除不在官网列表中的学院（先确认无项目引用）
 *
 * 设计要点：
 *   1. 学院按【名称】匹配，已存在的保留原 id —— 不打断 projects.college_id 外键。
 *   2. 专业按【学院 + 名称】精确对齐：缺的补、多的删。
 *      删除 majors 会把 projects.major_id 置 NULL（ON DELETE SET NULL），
 *      故删除前先统计引用数并打印，做到可追溯。
 *   3. 全程在一个事务里，失败整体回滚。
 */
const { db } = require('./lib/db');
const { ORG } = require('./lib/org');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const PRUNE = argv.includes('--prune');

function sync() {
  const added = { colleges: [], majors: [] };
  const removed = { colleges: [], majors: [] };
  let collegeOrderFixed = 0;

  db.exec('BEGIN');
  try {
    const allColleges = db.prepare('SELECT id,name,sort_order FROM colleges').all();
    const byName = new Map(allColleges.map((c) => [c.name, c]));

    // 1) 学院 upsert
    ORG.forEach(([name], i) => {
      const cur = byName.get(name);
      if (!cur) {
        if (!DRY) db.prepare('INSERT INTO colleges(name,sort_order) VALUES(?,?)').run(name, i);
        added.colleges.push(name);
      } else if (cur.sort_order !== i) {
        if (!DRY) db.prepare('UPDATE colleges SET sort_order=? WHERE id=?').run(i, cur.id);
        collegeOrderFixed++;
      }
    });

    // 2) 专业精确对齐（遍历 ORG 中每个学院）
    const majorRefCount = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE major_id=?');
    ORG.forEach(([cname, majors]) => {
      const c = db.prepare('SELECT id FROM colleges WHERE name=?').get(cname);
      if (!c) return; // dry-run 且为新增学院时跳过
      const want = new Set(majors);
      const have = db.prepare('SELECT id,name FROM majors WHERE college_id=?').all(c.id);

      for (const m of have) {
        if (!want.has(m.name)) {
          const n = majorRefCount.get(m.id).n;
          if (!DRY) db.prepare('DELETE FROM majors WHERE id=?').run(m.id);
          removed.majors.push(`${cname} / ${m.name}${n ? `（有 ${n} 个项目引用，已置空）` : ''}`);
        }
      }
      const haveNames = new Set(have.map((m) => m.name));
      majors.forEach((mname, j) => {
        if (!haveNames.has(mname)) {
          if (!DRY) db.prepare('INSERT INTO majors(college_id,name,sort_order) VALUES(?,?,?)').run(c.id, mname, j);
          added.majors.push(`${cname} / ${mname}`);
        }
      });
    });

    // 3) 可选：删除官网没有的学院
    const official = new Set(ORG.map(([n]) => n));
    for (const c of allColleges) {
      if (official.has(c.name)) continue;
      const n = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE college_id=?').get(c.id).n;
      if (PRUNE) {
        if (!DRY) db.prepare('DELETE FROM colleges WHERE id=?').run(c.id);
        removed.colleges.push(`${c.name}${n ? `（有 ${n} 个项目引用，已置空）` : ''}`);
      } else {
        removed.colleges.push(`${c.name} —— 官网无此学院${n ? `，且有 ${n} 个项目引用` : ''}（未删除，需 --prune）`);
      }
    }

    if (DRY) db.exec('ROLLBACK'); else db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return { added, removed, collegeOrderFixed };
}

const before = db.prepare('SELECT (SELECT COUNT(*) FROM colleges) AS c,(SELECT COUNT(*) FROM majors) AS m').get();
const r = sync();
const after = db.prepare('SELECT (SELECT COUNT(*) FROM colleges) AS c,(SELECT COUNT(*) FROM majors) AS m').get();

const line = (t, arr) => { console.log(`\n${t}（${arr.length}）`); arr.forEach((x) => console.log('   ' + x)); };

console.log(`\n[学院专业同步]${DRY ? ' (dry-run)' : ''}${PRUNE ? ' (prune)' : ''}`);
console.log(`  学院 ${before.c} -> ${after.c}   专业 ${before.m} -> ${after.m}`);
if (r.collegeOrderFixed) console.log(`  修正排序 ${r.collegeOrderFixed} 个学院`);
line('新增学院', r.added.colleges);
line('新增专业', r.added.majors);
line('删除/待清理专业', r.removed.majors);
line('删除/待清理学院', r.removed.colleges);
console.log('');
