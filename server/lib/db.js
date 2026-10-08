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
  key     TEXT NOT NULL,
  user_id INTEGER NOT NULL DEFAULT 0,   -- 0=全局共享；>0=该用户的个人设置（覆盖全局）
  value   TEXT NOT NULL,
  PRIMARY KEY (key, user_id)
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

-- ========== 账号（注册 + 审批 + 登录） ==========
-- 邮箱与手机号都允许为空（二选一注册），但同一账号至少有一个可登录凭据，
-- 由业务层保证；这里只做唯一性约束，避免两人绑定同一个手机号。
CREATE TABLE IF NOT EXISTS users (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  username         TEXT NOT NULL UNIQUE,    -- 登录名（用户自定义，不可重复）
  name             TEXT NOT NULL,           -- 真实姓名
  email            TEXT UNIQUE,
  phone            TEXT UNIQUE,
  job_no           TEXT,                    -- 工号 / 学号
  college_id       INTEGER REFERENCES colleges(id) ON DELETE SET NULL,
  major_id         INTEGER REFERENCES majors(id) ON DELETE SET NULL,
  password_hash    TEXT NOT NULL,
  password_salt    TEXT NOT NULL,
  role             TEXT NOT NULL DEFAULT 'user',      -- super_admin 超管 | admin 管理员 | user 普通用户
  status           TEXT NOT NULL DEFAULT 'pending',   -- pending 待审批 | active 正常 | disabled 停用 | rejected 已驳回
  email_verified   INTEGER NOT NULL DEFAULT 0,
  phone_verified   INTEGER NOT NULL DEFAULT 0,
  register_channel TEXT,                    -- email | phone
  register_reason  TEXT,                    -- 注册时填写的用途说明，供管理员审批参考
  approved_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at      TEXT,
  reject_reason    TEXT,
  last_login_at    TEXT,
  last_login_ip    TEXT,
  login_fail_count INTEGER NOT NULL DEFAULT 0,
  locked_until     TEXT,                    -- 登录失败过多时锁定到该时刻
  created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- ========== 验证码 ==========
-- 只存哈希：数据库泄露时不能反推出可用验证码。purpose 区分注册/登录/重置，
-- 防止「注册时拿到的验证码」被拿去重置别人的密码。
CREATE TABLE IF NOT EXISTS verify_codes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target      TEXT NOT NULL,                -- 邮箱地址 / 手机号
  channel     TEXT NOT NULL,                -- email | phone
  purpose     TEXT NOT NULL,                -- register | login | reset | bind
  code_hash   TEXT NOT NULL,
  salt        TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,   -- 校验失败次数，超阈值作废
  used_at     TEXT,
  ip          TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_codes_target ON verify_codes(target, purpose);
CREATE INDEX IF NOT EXISTS idx_codes_created ON verify_codes(created_at);

-- ========== 会话 ==========
CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,             -- 32 字节随机 hex
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  expires_at  TEXT NOT NULL,
  ip          TEXT,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);

-- ========== 审计日志（管理员操作留痕） ==========
CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id   INTEGER,
  actor_name TEXT,                          -- 冗余存姓名：用户被删后日志仍可读
  action     TEXT NOT NULL,                 -- approve / reject / disable / role_change ...
  target     TEXT,                          -- 被操作对象（用户 id 或标识）
  detail     TEXT,
  ip         TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

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
/* AI 视觉提取队列：'' 无需处理 | queued 等待 AI 看图 | done 已回填 | skipped 人工放弃 */
ensureColumn('receipts', 'ai_status', "ai_status TEXT NOT NULL DEFAULT ''");
ensureColumn('receipts', 'ai_at', 'ai_at TEXT');
/* 数据归属：项目属于创建它的用户。老库补列后由 migrate_ownership.js 回填归属人 */
ensureColumn('projects', 'owner_user_id', 'owner_user_id INTEGER');
db.exec('CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_user_id)');

/* settings 从「单主键 key」升级为「复合主键 (key,user_id)」。
   SQLite 改不了主键，老库只能重建表；不重建就存不进个人设置（邮件/收款项）。 */
(function migrateSettingsScope() {
  try {
    const cols = db.prepare('PRAGMA table_info(settings)').all();
    if (cols.some((c) => c.name === 'user_id')) return;
    db.exec(`
      CREATE TABLE settings_new (
        key     TEXT NOT NULL,
        user_id INTEGER NOT NULL DEFAULT 0,
        value   TEXT NOT NULL,
        PRIMARY KEY (key, user_id)
      );
      INSERT INTO settings_new(key, user_id, value) SELECT key, 0, value FROM settings;
      DROP TABLE settings;
      ALTER TABLE settings_new RENAME TO settings;
    `);
    console.log('[db] settings 表已升级为复合主键 (key,user_id)，支持个人级设置');
  } catch (e) {
    console.error('[db] settings 表升级失败：' + e.message);
  }
})();

/* ---------------- 工具 ---------------- */
const DEFAULT_SETTINGS = {
  meal_teacher: '100',      // 教师每日餐费
  city_teacher: '80',       // 教师每日市内交通补助
  student_ratio: '0.5',     // 学生系数（减半）
  org_name: '天津仁爱学院',
  travel_day_free_meal: '0',// 免伙食补助天数（首末日等政策，预留）
  currency_prefix: '人民币',
  // 发票邮件发送（收件人默认发票归集邮箱，可在设置页改）
  mail_to: '13752070316@fapiao56.com',
  mail_from: '',            // 发件人邮箱（网易 163 等）
  mail_from_name: '天津仁爱学院报销系统',
  mail_smtp_host: 'smtp.163.com',
  mail_smtp_port: '465',
  mail_smtp_secure: '1',    // 1=465 隐式 SSL；0=明文 25/587
  mail_smtp_user: '',       // SMTP 账号（一般与发件人相同）
  mail_smtp_pass: '',       // 授权码：仅存本地库，接口下发时自动脱敏

  // ---- 账号与注册审批 ----
  auth_register_open: '1',  // 1=开放注册（仍按白名单/审批分流）；0=关闭，仅管理员可建号
  auth_require_login: '1',  // 1=主应用强制登录；0=沿用旧行为（仅 Basic Auth 兜底）
  auth_domain_whitelist: '',// 邮箱域名白名单，逗号分隔，如 tjrac.edu.cn —— 命中即自动通过
  auth_register_auto_approve: '1', // 1=邮箱验证码校验通过即开通账号（可登录）；0=需管理员审批
  auth_code_ttl: '300',     // 验证码有效期（秒）
  auth_code_resend: '60',   // 同一目标重发冷却（秒）
  auth_login_fail_max: '5', // 连续失败次数上限，超过则锁定
  auth_lock_minutes: '15',  // 锁定时长（分钟）
  auth_session_hours: '8',  // 会话有效时长（小时）
};

/** 密钥类设置项：接口一律不回传明文，只给「是否已配置」布尔值 */
const SECRET_SETTINGS = ['mail_smtp_pass'];

/* 用户级设置项：每人一份，别人看不到也改不了（SMTP 授权码、发件邮箱、收款账号都在此列）。
   其余项（报销标准、字典、注册策略等）是全局共享，只有管理员能改。 */
const USER_SETTINGS = new Set([
  'mail_to', 'mail_from', 'mail_from_name',
  'mail_smtp_host', 'mail_smtp_port', 'mail_smtp_secure', 'mail_smtp_user', 'mail_smtp_pass',
  'payee_name', 'payee_bank', 'payee_account',
]);
const isUserSetting = (key) => USER_SETTINGS.has(key);

/* 用户级项里的「身份敏感」子集：全局值绝不下发给个人。
   系统发验证码用的 SMTP 配置必须留在全局（auth.js 没有用户上下文），
   但那套发件账号/授权码不能被其他用户在设置页看到，所以这里不回退全局。
   mail_to（发票归集邮箱）与 host/port/secure 是公共默认值，允许回退。 */
const NO_GLOBAL_FALLBACK = new Set([
  'mail_from', 'mail_from_name', 'mail_smtp_user', 'mail_smtp_pass',
  'payee_name', 'payee_bank', 'payee_account',
]);
/** 写入范围：只有用户级项 + 明确的用户才写个人行，其余一律全局（user_id=0） */
function settingScope(key, userId) {
  return (userId && isUserSetting(key)) ? Number(userId) : 0;
}

function getSetting(key, userId = 0) {
  const uid = settingScope(key, userId);
  if (uid) {
    const mine = db.prepare('SELECT value FROM settings WHERE key = ? AND user_id = ?').get(key, uid);
    if (mine) return mine.value;
    if (NO_GLOBAL_FALLBACK.has(key)) return DEFAULT_SETTINGS[key];
  }
  const row = db.prepare('SELECT value FROM settings WHERE key = ? AND user_id = 0').get(key);
  return row ? row.value : DEFAULT_SETTINGS[key];
}
function setSetting(key, value, userId = 0) {
  const uid = settingScope(key, userId);
  db.prepare(
    `INSERT INTO settings(key,user_id,value) VALUES(?,?,?)
     ON CONFLICT(key,user_id) DO UPDATE SET value = excluded.value`
  ).run(key, uid, String(value));
}
/** 数值型设置项（餐费/交通/系数等），读取时转为 Number */
const NUMERIC_SETTINGS = new Set([
  'meal_teacher', 'city_teacher', 'student_ratio', 'travel_day_free_meal',
]);

/** 全局设置 + 该用户的个人覆盖（userId=0 时只返回全局） */
function getAllSettings(userId = 0) {
  const out = { ...DEFAULT_SETTINGS };
  const conv = (r) => (NUMERIC_SETTINGS.has(r.key) ? (Number(r.value) || 0) : r.value);
  for (const r of db.prepare('SELECT key,value FROM settings WHERE user_id = 0').all()) out[r.key] = conv(r);
  if (userId) {
    // 先看有没有个人配置：有则覆盖，没有则身份敏感项回落到出厂默认值（不继承全局）
    const mine = db.prepare('SELECT key,value FROM settings WHERE user_id = ?').all(Number(userId));
    const owned = new Set(mine.map((r) => r.key));
    for (const k of NO_GLOBAL_FALLBACK) if (!owned.has(k)) out[k] = DEFAULT_SETTINGS[k] ?? '';
    for (const r of mine) out[r.key] = conv(r);
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
  SECRET_SETTINGS,
  USER_SETTINGS,
  NO_GLOBAL_FALLBACK,
  isUserSetting,
  getSetting,
  setSetting,
  getAllSettings,
};