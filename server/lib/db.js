'use strict';
/**
 * 数据层：node:sqlite（Node 22 内置，需 --experimental-sqlite）
 * 零第三方依赖。
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const { ORG } = require('./org');

const ROOT = path.resolve(__dirname, '..', '..');
// 云上部署时数据目录需要外置（如挂载云盘 /var/lib/reimburse），故支持环境变量覆盖。
// 默认仍用项目内 data/，保证本地零配置可跑。
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const EXPORT_DIR = process.env.EXPORT_DIR
  ? path.resolve(process.env.EXPORT_DIR)
  : path.join(ROOT, 'exports');

for (const d of [DATA_DIR, UPLOAD_DIR, EXPORT_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

const db = new DatabaseSync(path.join(DATA_DIR, 'reimburse.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

const SCHEMA = `
-- ========== 设置项（键值） ==========
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ========== 字典 ==========
-- 学期 / 自然年统一存 periods
CREATE TABLE IF NOT EXISTS periods (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  kind      TEXT NOT NULL,              -- term(学期) | year(自然年)
  name      TEXT NOT NULL,              -- 2025-2026学年第1学期 / 2026自然年
  start_date TEXT,
  end_date   TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS colleges (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS majors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  college_id  INTEGER NOT NULL REFERENCES colleges(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(college_id, name)
);

-- ========== 报销项目 ==========
CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,      -- 项目/合同编号
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,             -- research科研 | teaching教学 | reform教改 | training师资培训 | competition竞赛
  period_id   INTEGER REFERENCES periods(id) ON DELETE SET NULL,
  college_id  INTEGER REFERENCES colleges(id) ON DELETE SET NULL,
  major_id    INTEGER REFERENCES majors(id) ON DELETE SET NULL,
  leader      TEXT,                      -- 项目负责人
  has_travel  INTEGER NOT NULL DEFAULT 0,
  reason      TEXT,                      -- 支付事由
  budget      REAL NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'draft',  -- draft草稿 | submitted已提交 | archived已归档
  remark      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_projects_cat ON projects(category);

-- ========== 差旅行程（一个项目可多条行程） ==========
CREATE TABLE IF NOT EXISTS trips (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  reason     TEXT,                       -- 出差事由
  start_date TEXT NOT NULL,
  end_date   TEXT NOT NULL,
  from_place TEXT,
  to_place   TEXT,
  days       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_trips_project ON trips(project_id);

-- ========== 成员（教师/学生） ==========
CREATE TABLE IF NOT EXISTS members (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  trip_id     INTEGER REFERENCES trips(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,             -- teacher教师 | student学生
  name        TEXT NOT NULL,
  major       TEXT,                      -- 专业
  job_no      TEXT,                      -- 工号 / 学号
  phone       TEXT,
  rank_level  TEXT,                      -- 职级（如 二类）
  meal_rate   REAL,                      -- 覆盖默认：每日餐费
  city_rate   REAL,                      -- 覆盖默认：每日市内交通
  days        INTEGER NOT NULL DEFAULT 0,-- 参与天数
  remark      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_members_project ON members(project_id);

-- ========== 票据（含 OCR 与人工审核） ==========
CREATE TABLE IF NOT EXISTS receipts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  member_id    INTEGER REFERENCES members(id) ON DELETE SET NULL,
  category     TEXT NOT NULL DEFAULT 'other', -- transport城市间交通费 | hotel住宿费 | city_trans市内交通 | invoice发票 | other其他
  file_name    TEXT,
  file_path    TEXT,
  mime         TEXT,
  size         INTEGER,
  -- OCR / 人工录入字段
  invoice_no   TEXT,
  invoice_date TEXT,
  vendor       TEXT,                     -- 销方/商户
  amount       REAL,
  tax_amount   REAL,
  tax_no       TEXT,                     -- 纳税人识别号
  itinerary    TEXT,                     -- 行程单摘要
  ocr_raw      TEXT,                     -- OCR 原始 JSON
  ocr_engine   TEXT,
  ocr_status   TEXT NOT NULL DEFAULT 'pending', -- pending待审核 | approved已通过 | rejected已驳回
  reviewed_by  TEXT,
  reviewed_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_receipts_project ON receipts(project_id);
CREATE INDEX IF NOT EXISTS idx_receipts_status ON receipts(ocr_status);

-- ========== 票据费用归集（审核通过的票据落到哪个人/哪一栏） ==========
CREATE TABLE IF NOT EXISTS receipt_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id  INTEGER NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  member_id   INTEGER REFERENCES members(id) ON DELETE CASCADE,
  bucket      TEXT NOT NULL,            -- transport | hotel | city_trans | other
  amount      REAL NOT NULL DEFAULT 0,
  note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_ritems_receipt ON receipt_items(receipt_id);
CREATE INDEX IF NOT EXISTS idx_ritems_member ON receipt_items(member_id);

-- ========== 导出记录 ==========
CREATE TABLE IF NOT EXISTS exports (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,              -- travel_docx | fund_xlsx | all
  file_path  TEXT,
  total      REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`;

db.exec(SCHEMA);

/* 轻量迁移：老库补列（member_ids = 该段行程绑定的人员 id JSON 数组） */
function ensureColumn(table, column, ddl) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  } catch (e) { /* 已存在则忽略 */ }
}
ensureColumn('trips', 'member_ids', 'member_ids TEXT');

/* ---------------- 工具 ---------------- */
const DEFAULT_SETTINGS = {
  meal_teacher: '100',      // 教师每日餐费
  city_teacher: '80',       // 教师每日市内交通补助
  student_ratio: '0.5',     // 学生系数（减半）
  org_name: '天津仁爱学院',
  travel_day_free_meal: '0',// 免伙食补助天数（首末日等政策，预留）
  currency_prefix: '人民币',
};

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : DEFAULT_SETTINGS[key];
}
function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}
/** 数值型设置项（餐费/交通/系数等），读取时转为 Number */
const NUMERIC_SETTINGS = new Set([
  'meal_teacher', 'city_teacher', 'student_ratio', 'travel_day_free_meal',
]);

function getAllSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of db.prepare('SELECT key,value FROM settings').all()) {
    out[r.key] = NUMERIC_SETTINGS.has(r.key) ? (Number(r.value) || 0) : r.value;
  }
  return out;
}

function seed() {
  const c = db.prepare('SELECT COUNT(*) AS n FROM settings').get().n;
  if (c === 0) {
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) setSetting(k, v);
  }

  // 期间（学期 / 自然年）：只要库里没有「默认期间」就补种。
  // 只判断 is_default 而非表是否为空 —— 用户在设置页误删全部期间后，重启即自动恢复可用选项，
  // 下拉不会变空；已存在同名期间则跳过，保证幂等。
  if (db.prepare('SELECT COUNT(*) AS n FROM periods WHERE is_default=1').get().n === 0) {
    const ins = db.prepare(
      'INSERT INTO periods(kind,name,start_date,end_date,is_default) ' +
      'SELECT ?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM periods WHERE name=?)'
    );
    ins.run('term', '2025-2026学年第1学期', '2025-09-01', '2026-01-20', 1, '2025-2026学年第1学期');
    ins.run('term', '2025-2026学年第2学期', '2026-02-23', '2026-07-05', 0, '2025-2026学年第2学期');
    ins.run('year', '2026自然年', '2026-01-01', '2026-12-31', 0, '2026自然年');
  }

  if (db.prepare('SELECT COUNT(*) AS n FROM colleges').get().n === 0) {
    const insC = db.prepare('INSERT INTO colleges(name,sort_order) VALUES(?,?)');
    const insM = db.prepare('INSERT INTO majors(college_id,name,sort_order) VALUES(?,?,?)');
    // 学院/专业取自官网真实数据，见 server/lib/org.js
    const seedColleges = ORG;
    seedColleges.forEach(([name, majors], i) => {
      const r = insC.run(name, i);
      majors.forEach((m, j) => insM.run(r.lastInsertRowid, m, j));
    });
  }
}

seed();

module.exports = {
  db,
  ROOT,
  DATA_DIR,
  UPLOAD_DIR,
  EXPORT_DIR,
  DEFAULT_SETTINGS,
  getSetting,
  setSetting,
  getAllSettings,
};