'use strict';
/** 业务 API 处理：全部返回 {ok, data} 或 {ok:false, error} */
const fs = require('node:fs');
const path = require('node:path');
const { db, getSetting, getAllSettings, setSetting, DEFAULT_SETTINGS, UPLOAD_DIR, EXPORT_DIR } = require('./db');
const { round2, rmbUpper } = require('./money');
const { computeProject, calcDays, cnDate } = require('./calc');
const { buildTravelDocx } = require('./docx');
const { buildFundXlsx } = require('./xlsx');
const { mergePdfs } = require('./pdfmerge');
const ocr = require('./ocr');

/** 项目分类：内置项 + 用户在「设置」里自定义项 */
const CATEGORIES = [
  { key: 'research', label: '科研', group: '科研' },
  { key: 'teaching', label: '教学', group: '教学' },
  { key: 'reform', label: '教改', group: '教学' },
  { key: 'training', label: '师资培训', group: '教学' },
  { key: 'competition', label: '竞赛', group: '竞赛' },
  { key: 'office', label: '办公用品', group: '行政' },
  { key: 'consumable', label: '耗材采购', group: '行政' },
  { key: 'equipment', label: '设备采购', group: '资产' },
  { key: 'maintenance', label: '维修维保', group: '资产' },
];

/** 费用科目：前 4 项参与差旅表分栏计算，其余归集进「其他费用」按科目名展示 */
const BUCKETS = [
  { key: 'transport', label: '城市间交通费' },
  { key: 'hotel', label: '住宿费' },
  { key: 'city_trans', label: '市内交通费' },
  { key: 'other', label: '其他费用' },
  { key: 'consumable_fee', label: '耗材费' },
  { key: 'office_fee', label: '办公用品费用' },
  { key: 'print_fee', label: '打印费' },
  { key: 'maintain_fee', label: '维修维保费用' },
  { key: 'paper_fee', label: '论文版面费' },
  { key: 'patent_fee', label: '专利服务费' },
  { key: 'tech_fee', label: '技术服务费' },
  { key: 'outsource_fee', label: '项目外协费' },
];

/** 差旅表固定五栏（伙食补助为定额，不来自票据） */
const TRAVEL_BUCKETS = ['transport', 'hotel', 'city_trans', 'other'];

const CATEGORY_CODE_PREFIX = {
  research: 'KY', teaching: 'JX', reform: 'JG', training: 'SP', competition: 'JS',
  office: 'BG', consumable: 'HC', equipment: 'SB', maintenance: 'WB',
};

const bad = (msg) => ({ ok: false, error: String(msg) });
const good = (data) => ({ ok: true, data });

/* ============ 字典：内置 + 自定义 ============
 * 自定义项以 JSON 数组存在 settings 表（custom_categories / custom_buckets），
 * 与内置项合并后对外统一返回；内置项不可删除，避免历史数据失去归属。 */
const DICT_SETTING_KEY = { categories: 'custom_categories', buckets: 'custom_buckets' };

function readDictCustom(kind) {
  const raw = getSetting(DICT_SETTING_KEY[kind]);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => x && x.key && x.label) : [];
  } catch (_) { return []; }
}
function writeDictCustom(kind, list) {
  setSetting(DICT_SETTING_KEY[kind], JSON.stringify(list));
}
function allCategories() { return [...CATEGORIES, ...readDictCustom('categories')]; }
function allBuckets() { return [...BUCKETS, ...readDictCustom('buckets')]; }
/** 票据归集时的合法科目集合（内置 + 自定义） */
function bucketKeySet() { return new Set(allBuckets().map((b) => b.key)); }
function bucketLabelMap() { return Object.fromEntries(allBuckets().map((b) => [b.key, b.label])); }

function addDictItem(kind, body) {
  const builtins = kind === 'categories' ? CATEGORIES : BUCKETS;
  const custom = readDictCustom(kind);
  const label = String((body && body.label) || '').trim().slice(0, 20);
  if (!label) return bad('名称不能为空');
  if ([...builtins, ...custom].some((x) => x.label === label)) return bad(`「${label}」已存在`);
  let key = String((body && body.key) || '').trim();
  if (key) {
    if (!/^[a-z][a-z0-9_]{1,23}$/.test(key)) return bad('标识只能用小写字母/数字/下划线，且以字母开头');
    if (builtins.some((x) => x.key === key) || custom.some((x) => x.key === key)) return bad(`标识「${key}」已存在`);
  } else {
    key = `c_${Date.now().toString(36)}`;
  }
  const item = { key, label, custom: true };
  if (kind === 'categories') item.group = String((body && body.group) || '').trim().slice(0, 10) || '自定义';
  custom.push(item);
  writeDictCustom(kind, custom);
  return good({ item, list: kind === 'categories' ? allCategories() : allBuckets() });
}

function deleteDictItem(kind, key) {
  const builtins = kind === 'categories' ? CATEGORIES : BUCKETS;
  if (builtins.some((x) => x.key === key)) return bad('内置项不可删除');
  const custom = readDictCustom(kind);
  const next = custom.filter((x) => x.key !== key);
  if (next.length === custom.length) return bad('条目不存在');
  writeDictCustom(kind, next);
  return good({ key, list: kind === 'categories' ? allCategories() : allBuckets() });
}

/* ============ 设置 ============ */
function getSettings() {
  return good({
    settings: getAllSettings(), defaults: DEFAULT_SETTINGS,
    categories: allCategories(), buckets: allBuckets(),
  });
}
function updateSettings(body) {
  const allowed = new Set([...Object.keys(DEFAULT_SETTINGS), 'payee_bank', 'payee_account', 'payee_name']);
  let n = 0;
  for (const [k, v] of Object.entries(body || {})) {
    if (!allowed.has(k)) continue;
    if (k.startsWith('meal_') || k.startsWith('city_') || k === 'student_ratio' || k === 'travel_day_free_meal') {
      const num = Number(v);
      if (Number.isNaN(num) || num < 0) continue;
      setSetting(k, num);
    } else {
      setSetting(k, String(v).slice(0, 200));
    }
    n++;
  }
  if (n === 0) return bad('没有可更新的设置项');
  return good({ settings: getAllSettings() });
}

/* ============ 字典 ============ */
function listPeriods() { return good({ periods: db.prepare('SELECT * FROM periods ORDER BY kind DESC, start_date DESC').all() }); }
function createPeriod(body) {
  const { kind, name, start_date, end_date } = body || {};
  if (!['term', 'year'].includes(kind)) return bad('kind 必须是 term 或 year');
  if (!name || !String(name).trim()) return bad('名称不能为空');
  const r = db.prepare('INSERT INTO periods(kind,name,start_date,end_date) VALUES(?,?,?,?)')
    .run(kind, String(name).trim(), start_date || null, end_date || null);
  return good({ id: r.lastInsertRowid });
}
function updatePeriod(id, body) {
  const p = db.prepare('SELECT * FROM periods WHERE id=?').get(id);
  if (!p) return bad('期间不存在');
  db.prepare('UPDATE periods SET kind=?,name=?,start_date=?,end_date=? WHERE id=?')
    .run(body.kind || p.kind, body.name || p.name, body.start_date ?? p.start_date, body.end_date ?? p.end_date, id);
  return good({ id });
}
function deletePeriod(id) { db.prepare('DELETE FROM periods WHERE id=?').run(id); return good({ id }); }

function listColleges() {
  const colleges = db.prepare('SELECT * FROM colleges ORDER BY sort_order, id').all();
  const majors = db.prepare('SELECT * FROM majors ORDER BY sort_order, id').all();
  return good({ colleges, majors });
}
function createCollege(body) {
  if (!body.name || !String(body.name).trim()) return bad('学院名称不能为空');
  const r = db.prepare('INSERT INTO colleges(name,sort_order) VALUES(?,?)')
    .run(String(body.name).trim(), Number(body.sort_order) || 0);
  return good({ id: r.lastInsertRowid });
}
function createMajor(body) {
  if (!body.college_id) return bad('请选择所属学院');
  if (!body.name || !String(body.name).trim()) return bad('专业名称不能为空');
  try {
    const r = db.prepare('INSERT INTO majors(college_id,name,sort_order) VALUES(?,?,?)')
      .run(Number(body.college_id), String(body.name).trim(), Number(body.sort_order) || 0);
    return good({ id: r.lastInsertRowid });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return bad('该学院下已存在同名专业');
    throw e;
  }
}
function updateCollege(id, body) {
  db.prepare('UPDATE colleges SET name=? WHERE id=?').run(String(body.name).trim(), id);
  return good({ id });
}
function deleteCollege(id) { db.prepare('DELETE FROM colleges WHERE id=?').run(id); return good({ id }); }
function updateMajor(id, body) {
  db.prepare('UPDATE majors SET name=? WHERE id=?').run(String(body.name).trim(), id);
  return good({ id });
}
function deleteMajor(id) { db.prepare('DELETE FROM majors WHERE id=?').run(id); return good({ id }); }

/* ============ 项目 ============ */
function decorateProject(p) {
  if (!p) return null;
  const college = p.college_id ? db.prepare('SELECT name FROM colleges WHERE id=?').get(p.college_id) : null;
  const major = p.major_id ? db.prepare('SELECT name FROM majors WHERE id=?').get(p.major_id) : null;
  const period = p.period_id ? db.prepare('SELECT * FROM periods WHERE id=?').get(p.period_id) : null;
  const trip = db.prepare('SELECT * FROM trips WHERE project_id=? ORDER BY start_date LIMIT 1').get(p.id);
  const memberCount = db.prepare('SELECT COUNT(*) n FROM members WHERE project_id=?').get(p.id).n;
  const receiptCount = db.prepare('SELECT COUNT(*) n FROM receipts WHERE project_id=?').get(p.id).n;
  const pendingCount = db.prepare("SELECT COUNT(*) n FROM receipts WHERE project_id=? AND ocr_status='pending'").get(p.id).n;
  const stat = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM receipts WHERE project_id=? AND ocr_status=?')
    .get(p.id, 'approved').s;
  return {
    ...p,
    has_travel: !!p.has_travel,
    college_name: college ? college.name : '',
    major_name: major ? major.name : '',
    period_name: period ? period.name : '',
    trip: trip || null,
    member_count: memberCount,
    receipt_count: receiptCount,
    pending_count: pendingCount,
    approved_amount: round2(stat),
  };
}

function listProjects(query = {}) {
  const rows = db.prepare('SELECT * FROM projects ORDER BY updated_at DESC, id DESC').all();
  let list = rows.map(decorateProject);
  if (query.category) list = list.filter((p) => p.category === query.category);
  if (query.q) {
    const q = String(query.q).toLowerCase();
    list = list.filter((p) =>
      [p.name, p.code, p.reason, p.leader].some((v) => String(v || '').toLowerCase().includes(q))
    );
  }
  return good({ projects: list });
}

function getProject(id) {
  const p = decorateProject(db.prepare('SELECT * FROM projects WHERE id=?').get(id));
  if (!p) return bad('项目不存在');
  const cfg = getAllSettings();
  const trips = db.prepare('SELECT * FROM trips WHERE project_id=? ORDER BY start_date, id').all(id)
    .map((t) => ({ ...t, member_ids_parsed: parseMemberIds(t.member_ids) }));
  const members = db.prepare('SELECT * FROM members WHERE project_id=? ORDER BY role DESC, id').all(id)
    .map((m) => ({ ...m, college: p.college_name }));
  const items = db.prepare(
    `SELECT ri.* FROM receipt_items ri
     JOIN receipts r ON r.id = ri.receipt_id
     WHERE r.project_id = ? AND r.ocr_status = 'approved'`
  ).all(id);
  // 兜底：历史数据里「未指定成员」的票据会被金额计算丢弃；单人项目自动归属唯一成员
  if (members.length === 1) {
    for (const it of items) if (!it.member_id) it.member_id = members[0].id;
  }
  const mainTrip = trips[0] || null;
  const route = mainTrip && mainTrip.from_place && mainTrip.to_place
    ? `${mainTrip.from_place}⇄${mainTrip.to_place}`
    : '';
  // 每人起讫地点 = 其绑定行程的出发地/目的地（默认套用主行程）
  // bucketLabels：新增费用科目（耗材费/打印费等）归集进「其他费用」时，明细要显示真实科目名
  const calc = computeProject(cfg, members, items, { route, trips, bucketLabels: bucketLabelMap() });
  const receipts = db.prepare('SELECT * FROM receipts WHERE project_id=? ORDER BY ocr_status, id DESC').all(id);
  const pending = receipts.filter((r) => r.ocr_status === 'pending').length;
  return good({
    project: p,
    trips,
    members,
    receipts,
    pending_receipts: pending,
    calc,
    currency_prefix: cfg.currency_prefix || '人民币',
    upper_total: rmbUpper(calc.total),
  });
}

function createProject(body) {
  const b = body || {};
  if (!b.name || !String(b.name).trim()) return bad('项目名称不能为空');
  const code = String(b.code || '').trim() || autoCode(b.category);
  if (db.prepare('SELECT id FROM projects WHERE code=?').get(code)) return bad(`项目编号「${code}」已存在`);
  const r = db.prepare(`INSERT INTO projects
    (code,name,category,period_id,college_id,major_id,leader,has_travel,reason,budget,status,remark)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      code, String(b.name).trim(), b.category || 'research',
      b.period_id || null, b.college_id || null, b.major_id || null,
      b.leader || null, b.has_travel ? 1 : 0, b.reason || null,
      Number(b.budget) || 0, b.status || 'draft', b.remark || null
    );
  return good({ id: r.lastInsertRowid, code });
}

function autoCode(category) {
  const prefix = CATEGORY_CODE_PREFIX[category] || 'BX';
  const year = new Date().getFullYear();
  // 用「当前最大序号 + 1」而非「条数 + 1」：删除项目后条数会回落，COUNT+1 会撞上已有编号。
  const rows = db.prepare('SELECT code FROM projects WHERE code LIKE ?').all(`${prefix}-${year}-%`);
  let n = rows.reduce((m, r) => {
    const v = Number(String(r.code).split('-')[2]);
    return Number.isFinite(v) && v > m ? v : m;
  }, 0) + 1;
  // 兜底防碰撞：万一仍有占用则顺延
  const exists = db.prepare('SELECT id FROM projects WHERE code=?');
  while (exists.get(`${prefix}-${year}-${String(n).padStart(3, '0')}`)) n++;
  return `${prefix}-${year}-${String(n).padStart(3, '0')}`;
}

function updateProject(id, body) {
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(id);
  if (!p) return bad('项目不存在');
  const b = body || {};
  db.prepare(`UPDATE projects SET name=?,category=?,period_id=?,college_id=?,major_id=?,
    leader=?,has_travel=?,reason=?,budget=?,status=?,remark=?,updated_at=datetime('now','localtime') WHERE id=?`)
    .run(
      b.name || p.name, b.category || p.category, b.period_id ?? p.period_id,
      b.college_id ?? p.college_id, b.major_id ?? p.major_id, b.leader ?? p.leader,
      b.has_travel != null ? (b.has_travel ? 1 : 0) : p.has_travel,
      b.reason ?? p.reason, b.budget != null ? Number(b.budget) || 0 : p.budget,
      b.status || p.status, b.remark ?? p.remark, id
    );
  return good({ id });
}

function deleteProject(id) {
  // 级联只删数据库记录，磁盘上的票据文件需在此清理，避免孤儿文件堆积
  for (const r of db.prepare('SELECT file_path FROM receipts WHERE project_id=?').all(id)) {
    if (!r.file_path) continue;
    const fp = path.join(UPLOAD_DIR, path.basename(r.file_path));
    if (fs.existsSync(fp)) { try { fs.unlinkSync(fp); } catch (_) { /* 忽略 */ } }
  }
  db.prepare('DELETE FROM projects WHERE id=?').run(id);
  return good({ id });
}

/* ============ 差旅行程 ============ */
/** 人员 id 数组 -> JSON 文本；同一人被多段行程选中时只保留首次出现 */
function serializeMemberIds(raw, projectId) {
  let ids = Array.isArray(raw) ? raw.map(Number).filter((n) => n > 0) : [];
  if (!ids.length) return '[]';
  const valid = new Set(
    db.prepare('SELECT id FROM members WHERE project_id=?').all(projectId).map((m) => m.id)
  );
  ids = ids.filter((id) => valid.has(id));
  return JSON.stringify([...new Set(ids)]);
}
function parseMemberIds(v) {
  if (!v) return [];
  try { const a = JSON.parse(v); return Array.isArray(a) ? a.map(Number) : []; } catch (e) { return []; }
}

function createTrip(projectId, body) {
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
  if (!p) return bad('项目不存在');
  const days = calcDays(body.start_date, body.end_date);
  const r = db.prepare('INSERT INTO trips(project_id,reason,start_date,end_date,from_place,to_place,days,member_ids) VALUES(?,?,?,?,?,?,?,?)')
    .run(projectId, body.reason || null, body.start_date || null, body.end_date || null,
      body.from_place || null, body.to_place || null, days,
      serializeMemberIds(body.member_ids, projectId));
  // 同步项目事由
  if (body.reason && !p.reason) {
    db.prepare('UPDATE projects SET reason=?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?').run(body.reason, projectId);
  }
  return good({ id: r.lastInsertRowid, days });
}
function updateTrip(id, body) {
  const t = db.prepare('SELECT * FROM trips WHERE id=?').get(id);
  if (!t) return bad('行程不存在');
  const days = calcDays(body.start_date ?? t.start_date, body.end_date ?? t.end_date);
  const memberIds = body.member_ids !== undefined
    ? serializeMemberIds(body.member_ids, t.project_id)
    : (t.member_ids || '[]');
  db.prepare('UPDATE trips SET reason=?,start_date=?,end_date=?,from_place=?,to_place=?,days=?,member_ids=? WHERE id=?')
    .run(body.reason ?? t.reason, body.start_date ?? t.start_date, body.end_date ?? t.end_date,
      body.from_place ?? t.from_place, body.to_place ?? t.to_place, days, memberIds, id);
  return good({ id, days });
}
function deleteTrip(id) { db.prepare('DELETE FROM trips WHERE id=?').run(id); return good({ id }); }

/* ============ 成员 ============ */
function listMembers(projectId) {
  const rows = db.prepare('SELECT * FROM members WHERE project_id=? ORDER BY role DESC, id').all(projectId);
  return good({ members: rows });
}
function createMember(projectId, body) {
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
  if (!p) return bad('项目不存在');
  if (!body.name || !String(body.name).trim()) return bad('姓名不能为空');
  const role = body.role === 'student' ? 'student' : 'teacher';
  let days = Number(body.days) || 0;
  if (!days && p.has_travel) {
    const t = db.prepare('SELECT days FROM trips WHERE project_id=? ORDER BY start_date LIMIT 1').get(projectId);
    days = t ? t.days : 0;
  }
  const college = body.college || (p.college_id
    ? (db.prepare('SELECT name FROM colleges WHERE id=?').get(p.college_id) || {}).name : '');
  const r = db.prepare(`INSERT INTO members
    (project_id,trip_id,role,name,major,job_no,phone,rank_level,meal_rate,city_rate,days,remark)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(projectId, body.trip_id || null, role, String(body.name).trim(),
      body.major || college || null, body.job_no || null, body.phone || null,
      body.rank_level || (role === 'student' ? '学生' : null),
      body.meal_rate != null && body.meal_rate !== '' ? Number(body.meal_rate) : null,
      body.city_rate != null && body.city_rate !== '' ? Number(body.city_rate) : null,
      days, body.remark || null);
  return good({ id: r.lastInsertRowid });
}
function updateMember(id, body) {
  const m = db.prepare('SELECT * FROM members WHERE id=?').get(id);
  if (!m) return bad('成员不存在');
  db.prepare(`UPDATE members SET name=?,major=?,job_no=?,phone=?,rank_level=?,
    meal_rate=?,city_rate=?,days=?,remark=?,role=? WHERE id=?`)
    .run(body.name ?? m.name, body.major ?? m.major, body.job_no ?? m.job_no,
      body.phone ?? m.phone, body.rank_level ?? m.rank_level,
      body.meal_rate !== undefined ? (body.meal_rate === '' || body.meal_rate === null ? null : Number(body.meal_rate)) : m.meal_rate,
      body.city_rate !== undefined ? (body.city_rate === '' || body.city_rate === null ? null : Number(body.city_rate)) : m.city_rate,
      body.days != null ? Number(body.days) || 0 : m.days,
      body.remark ?? m.remark, body.role ?? m.role, id);
  return good({ id });
}
function deleteMember(id) { db.prepare('DELETE FROM members WHERE id=?').run(id); return good({ id }); }

/** 从全校字典快速匹配教师/学生（按姓名 + 工号/学号） */
function searchPeople(name, jobNo) {
  const rows = db.prepare('SELECT * FROM members WHERE name LIKE ? ORDER BY id DESC LIMIT 50').all(`%${name}%`);
  const filtered = jobNo ? rows.filter((r) => String(r.job_no || '').includes(jobNo)) : rows;
  return good({ people: filtered });
}

/* ============ 票据 ============ */
function listReceipts(projectId, status) {
  let sql = 'SELECT * FROM receipts WHERE project_id=?';
  const args = [projectId];
  if (status && status !== 'all') { sql += ' AND ocr_status=?'; args.push(status); }
  sql += " ORDER BY CASE ocr_status WHEN 'pending' THEN 0 ELSE 1 END, id DESC";
  const rows = db.prepare(sql).all(...args);
  for (const r of rows) r.items = db.prepare('SELECT * FROM receipt_items WHERE receipt_id=?').all(r.id);
  return good({ receipts: rows });
}

function createReceipt(projectId, body) {
  const p = db.prepare('SELECT id FROM projects WHERE id=?').get(projectId);
  if (!p) return bad('项目不存在');
  const r = db.prepare(`INSERT INTO receipts
    (project_id,member_id,category,file_name,mime,size,invoice_no,invoice_date,vendor,amount,tax_no,itinerary,ocr_status)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(projectId, body.member_id || null, body.category || 'other',
      body.file_name || null, body.mime || null, body.size || null,
      body.invoice_no || null, body.invoice_date || null, body.vendor || null,
      body.amount != null && body.amount !== '' ? Number(body.amount) : null,
      body.tax_no || null, body.itinerary || null, body.ocr_status || 'approved');
  return good({ id: r.lastInsertRowid });
}

async function uploadReceipts(projectId, files, hints) {
  const p = db.prepare('SELECT id FROM projects WHERE id=?').get(projectId);
  if (!p) return bad('项目不存在');
  const created = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const buf = Buffer.isBuffer(f.buffer) ? f.buffer : Buffer.from(f.buffer);
    const safe = `${Date.now()}_${i}_${path.basename(String(f.filename || 'receipt')).replace(/[^\w.\-一-龥]/g, '_')}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, safe), buf);
    let ocrResult = { engine: 'none', fields: {}, category: 'other', raw: {} };
    try {
      ocrResult = await ocr.runOcr(buf, f.mimetype, f.filename, (hints && hints[i]) || '');
    } catch (e) {
      ocrResult = { engine: 'error', fields: {}, category: 'other', raw: { error: String(e.message) } };
    }
    const fl = ocrResult.fields || {};
    const r = db.prepare(`INSERT INTO receipts
      (project_id,category,file_name,file_path,mime,size,invoice_no,invoice_date,vendor,amount,tax_no,itinerary,ocr_raw,ocr_engine,ocr_status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')`)
      .run(projectId, ocrResult.category || 'other', f.filename || 'receipt', safe,
        f.mimetype || ocr.mimeOf(f.filename || ''), buf.length,
        fl.invoice_no || null, fl.invoice_date || null, fl.vendor || null,
        fl.amount != null ? fl.amount : null, fl.tax_no || null, fl.itinerary || null,
        JSON.stringify(ocrResult.raw || {}), ocrResult.engine || 'offline-draft');
    created.push({ id: r.lastInsertRowid, file_name: f.filename, fields: fl, engine: ocrResult.engine });
  }
  return good({ created, message: `已上传 ${created.length} 张票据，等待人工审核` });
}

function updateReceipt(id, body) {
  const r = db.prepare('SELECT * FROM receipts WHERE id=?').get(id);
  if (!r) return bad('票据不存在');
  db.prepare(`UPDATE receipts SET member_id=?,category=?,invoice_no=?,invoice_date=?,
    vendor=?,amount=?,tax_no=?,itinerary=?,updated_at=datetime('now','localtime') WHERE id=?`)
    .run(body.member_id ?? r.member_id, body.category ?? r.category,
      body.invoice_no ?? r.invoice_no, body.invoice_date ?? r.invoice_date,
      body.vendor ?? r.vendor,
      body.amount !== undefined ? (body.amount === '' || body.amount === null ? null : Number(body.amount)) : r.amount,
      body.tax_no ?? r.tax_no, body.itinerary ?? r.itinerary, id);
  return good({ id });
}

/** 重新识别：对待审核票据用最新 OCR 逻辑重跑原始文件并回填字段 */
async function reocrReceipt(id) {
  const r = db.prepare('SELECT * FROM receipts WHERE id=?').get(id);
  if (!r) return bad('票据不存在');
  if (r.ocr_status !== 'pending') return bad('仅待审核票据可重新识别（已审核的请先撤销通过）');
  const fp = r.file_path ? path.join(UPLOAD_DIR, path.basename(r.file_path)) : '';
  if (!fp || !fs.existsSync(fp)) return bad('原始文件已丢失，无法重新识别');
  const buf = fs.readFileSync(fp);
  let ocrResult;
  try {
    ocrResult = await ocr.runOcr(buf, r.mime, r.file_name || '', '');
  } catch (e) {
    return bad('识别失败：' + e.message);
  }
  const fl = ocrResult.fields || {};
  db.prepare(`UPDATE receipts SET category=COALESCE(?,category),invoice_no=?,invoice_date=?,vendor=?,
    amount=?,tax_no=?,itinerary=?,ocr_raw=?,ocr_engine=?,updated_at=datetime('now','localtime') WHERE id=?`)
    .run(ocrResult.category || null,
      fl.invoice_no || null, fl.invoice_date || null, fl.vendor || null,
      fl.amount != null ? fl.amount : null, fl.tax_no || null, fl.itinerary || null,
      JSON.stringify(ocrResult.raw || {}), ocrResult.engine || 'offline-draft', id);
  return good({ id, fields: fl, engine: ocrResult.engine });
}

function reviewReceipt(id, body) {
  const r = db.prepare('SELECT * FROM receipts WHERE id=?').get(id);
  if (!r) return bad('票据不存在');
  const status = body.status;
  if (!['approved', 'rejected', 'pending'].includes(status)) return bad('审核状态非法');
  const reviewer = body.reviewer || '财务审核';
  // 未指定成员且项目只有一名成员时自动归属，避免票据被金额计算丢弃
  let memberId = body.member_id ?? null;
  if (!memberId) {
    const mems = db.prepare('SELECT id FROM members WHERE project_id=?').all(r.project_id);
    if (mems.length === 1) memberId = mems[0].id;
  }
  db.prepare(`UPDATE receipts SET ocr_status=?,reviewed_by=?,reviewed_at=datetime('now','localtime'),
    updated_at=datetime('now','localtime'),member_id=COALESCE(?,member_id),
    amount=COALESCE(?,amount),category=COALESCE(?,category) WHERE id=?`)
    .run(status, status === 'pending' ? null : reviewer, memberId,
      body.amount != null && body.amount !== '' ? Number(body.amount) : null,
      body.category ?? null, id);

  // 重建归集明细
  db.prepare('DELETE FROM receipt_items WHERE receipt_id=?').run(id);
  if (status === 'approved') {
    const items = Array.isArray(body.items) ? body.items.filter((x) => x && Number(x.amount) > 0) : [];
    for (const it of items) {
      db.prepare('INSERT INTO receipt_items(receipt_id,member_id,bucket,amount,note) VALUES(?,?,?,?,?)')
        .run(id, it.member_id || memberId,
          bucketKeySet().has(it.bucket) ? it.bucket : 'other',
          round2(it.amount), it.note || null);
    }
  }
  const items = db.prepare('SELECT * FROM receipt_items WHERE receipt_id=?').all(id);
  return good({ id, status, items });
}

function deleteReceipt(id) {
  const r = db.prepare('SELECT * FROM receipts WHERE id=?').get(id);
  if (r && r.file_path) {
    const fp = path.join(UPLOAD_DIR, path.basename(r.file_path));
    if (fs.existsSync(fp)) { try { fs.unlinkSync(fp); } catch (_) { /* 忽略 */ } }
  }
  db.prepare('DELETE FROM receipts WHERE id=?').run(id);
  return good({ id });
}

/** 批量导入票据（CSV 文本 / JSON 数组） */
function importReceipts(projectId, payload, format) {
  let list = [];
  if (format === 'json') {
    try { list = Array.isArray(payload) ? payload : JSON.parse(payload); }
    catch (e) { return bad('JSON 解析失败：' + e.message); }
  } else {
    list = ocr.parseCsv(payload);
    if (!list.length) return bad('CSV 无有效数据行');
    // 兼容中文表头
    const alias = {
      票据类型: 'category', 科目: 'category', 姓名: 'member_name', 成员: 'member_name',
      发票号: 'invoice_no', 发票号码: 'invoice_no', 日期: 'invoice_date', 开票日期: 'invoice_date',
      金额: 'amount', 销方: 'vendor', 销售方: 'vendor', 销方名称: 'vendor', 商户: 'vendor',
      纳税人识别号: 'tax_no', 税号: 'tax_no', 行程: 'itinerary', 费用: 'item', 备注: 'note',
    };
    list = list.map((row) => {
      const o = {};
      for (const [k, v] of Object.entries(row)) o[alias[k] || k] = v;
      return o;
    });
  }

  const members = db.prepare('SELECT id,name,job_no FROM members WHERE project_id=?').all(projectId);
  const findMember = (row) => {
    const nm = row.member_name || row.name || row.姓名 || row.成员;
    if (!nm) return null;
    if (row.job_no) {
      const hit = members.find((m) => m.name === nm && String(m.job_no || '') === String(row.job_no));
      if (hit) return hit.id;
    }
    const hit = members.find((m) => m.name === nm);
    return hit ? hit.id : null;
  };

  let okCount = 0;
  const errors = [];
  list.forEach((row, i) => {
    try {
      const amount = Number(String(row.amount ?? row.金额 ?? '').replace(/[,¥￥\s]/g, ''));
      if (Number.isNaN(amount)) throw new Error('金额不是数字');
      const cat = ocr.guessCategory(row, row.category || row.科目 || '');
      const r = db.prepare(`INSERT INTO receipts
        (project_id,member_id,category,invoice_no,invoice_date,vendor,amount,tax_no,itinerary,ocr_status,ocr_engine)
        VALUES(?,?,?,?,?,?,?,?,?,'pending','batch-import')`)
        .run(projectId, findMember(row), cat,
          row.invoice_no || row.发票号 || null, row.invoice_date || row.日期 || null,
          row.vendor || row.销方 || row.商户 || null, round2(amount),
          row.tax_no || row.税号 || null, row.itinerary || row.行程 || null);
      const rid = r.lastInsertRowid;
      if (row.item) {
        db.prepare('INSERT INTO receipt_items(receipt_id,member_id,bucket,amount,note) VALUES(?,?,?,?,?)')
          .run(rid, findMember(row), cat, round2(amount), String(row.item).slice(0, 60));
      }
      okCount++;
    } catch (e) {
      errors.push({ row: i + 2, message: e.message });
    }
  });
  return good({ imported: okCount, failed: errors.length, errors: errors.slice(0, 20) });
}

/** CSV 模板 */
function receiptTemplate() {
  const lines = [
    '票据类型,姓名,工号/学号,发票号,日期,金额,销方名称,纳税人识别号,行程,费用,备注',
    '住宿费,刘海斌,093024,12345678,2026-03-02,1743,北京如家酒店,91110000123456789A,,住宿3晚,',
    '城市间交通费,刘海斌,093024,22345678,2026-03-02,109,中国铁路,91110000123456789A,天津-北京,往返高铁票,',
  ];
  return { content: lines.join('\n') };
}

/* ============ 报表导出 ============ */
function buildTravelPayload(projectId) {
  const detail = getProject(projectId);
  if (!detail.ok) return detail;
  const { project, trips, calc, members } = detail.data;
  const t = trips[0] || null;
  // 多段行程：出差时间取最早出发 ~ 最晚返回（天数按首尾计）
  const starts = trips.map((x) => x.start_date).filter(Boolean).sort();
  const ends = trips.map((x) => x.end_date).filter(Boolean).sort();
  const rangeStart = starts[0] || (t && t.start_date);
  const rangeEnd = ends[ends.length - 1] || (t && t.end_date);
  const rangeDays = calcDays(rangeStart, rangeEnd);
  const rangeText = rangeStart
    ? `${cnDate(rangeStart)}   至   ${cnDate(rangeEnd)}  共${rangeDays || (t && t.days) || ''}天`
    : (calc.rows[0] && calc.rows[0].days ? `共${calc.rows[0].days}天` : '');
  // calc.rows 已按每人绑定行程带好起讫地点，此处直接使用
  const rows = calc.rows;
  return good({
    reason: (t && t.reason) || project.reason || `${project.name}差旅费`,
    rangeText,
    rows,
    total: calc.total,
    currency_prefix: detail.data.currency_prefix,
    project,
    calc,
  });
}

function exportTravelDocx(projectId) {
  const payload = buildTravelPayload(projectId);
  if (!payload.ok) return payload;
  const buf = buildTravelDocx(payload.data);
  const name = `${payload.data.project.code}_差旅费报销明细表.docx`;
  const fp = path.join(EXPORT_DIR, name);
  fs.writeFileSync(fp, buf);
  db.prepare('INSERT INTO exports(project_id,kind,file_path,total) VALUES(?,?,?,?)')
    .run(projectId, 'travel_docx', fp, payload.data.total);
  return good({
    file: path.basename(fp), size: buf.length, total: payload.data.total,
    download: `/api/projects/${projectId}/export/travel_docx`,
  });
}

function exportFundXlsx(projectId, body) {
  const detail = getProject(projectId);
  if (!detail.ok) return detail;
  const { project, calc } = detail.data;
  const cfg = getAllSettings();
  const today = new Date();
  const dateText = `${today.getFullYear()} 年 ${today.getMonth() + 1} 月 ${today.getDate()} 日`;
  const buf = buildFundXlsx({
    orgName: cfg.org_name || '天津仁爱学院',
    dateText,
    dept: project.college_name || '',
    category: '报销',
    reason: project.reason || project.name,
    payMethod: body.pay_method || '   □  现金        □  支票        □  电汇       □  其他',
    // 合同(项目)编号及名称：仅科研类项目填写，其余类别（教学/教改/师资培训/竞赛）留空
    contractName: project.category === 'research' ? `${project.code} ${project.name}` : '',
    payeeName: body.payee_name || cfg.payee_name || cfg.org_name || '天津仁爱学院',
    payeeBank: body.payee_bank || cfg.payee_bank || '',
    payeeAccount: body.payee_account || cfg.payee_account || '',
    amount: body.amount != null && body.amount !== '' ? Number(body.amount) : calc.total,
  });
  const name = `${project.code}_资金申请单.xlsx`;
  const fp = path.join(EXPORT_DIR, name);
  fs.writeFileSync(fp, buf);
  db.prepare('INSERT INTO exports(project_id,kind,file_path,total) VALUES(?,?,?,?)')
    .run(projectId, 'fund_xlsx', fp, calc.total);
  return good({
    file: path.basename(fp), size: buf.length, total: calc.total,
    download: `/api/projects/${projectId}/export/fund_xlsx`,
  });
}

/* 取项目最近一次导出的文件信息（供 GET 下载路由使用）；无记录时回退到现场生成 */
function lastExport(projectId, kind) {
  const row = db.prepare(
    'SELECT * FROM exports WHERE project_id=? AND kind=? ORDER BY id DESC LIMIT 1'
  ).get(projectId, kind);
  if (row && fs.existsSync(row.file_path)) {
    return good({
      file: path.basename(row.file_path),
      size: fs.statSync(row.file_path).size,
      total: row.total,
      download: `/api/projects/${projectId}/export/${kind}`,
    });
  }
  return kind === 'fund_xlsx' ? exportFundXlsx(projectId, {}) : exportTravelDocx(projectId);
}

/* ============ 仪表盘 ============ */
function dashboard() {
  const cfg = getAllSettings();
  const stat = db.prepare(`SELECT
      (SELECT COUNT(*) FROM projects) projects,
      (SELECT COUNT(*) FROM projects WHERE status='draft') draft,
      (SELECT COUNT(*) FROM members) members,
      (SELECT COUNT(*) FROM receipts WHERE ocr_status='pending') pending,
      (SELECT COUNT(*) FROM receipts) receipts,
      (SELECT COALESCE(SUM(amount),0) FROM receipts WHERE ocr_status='approved') amount`).get();
  const byCat = db.prepare('SELECT category, COUNT(*) n, COALESCE(SUM(budget),0) b FROM projects GROUP BY category').all();
  const recent = db.prepare('SELECT * FROM projects ORDER BY updated_at DESC LIMIT 6').all().map(decorateProject);
  const labels = Object.fromEntries(allCategories().map((c) => [c.key, c.label]));
  return good({
    settings: cfg,
    stat: { ...stat, amount: round2(stat.amount) },
    by_category: byCat.map((r) => ({ ...r, label: labels[r.category] || r.category })),
    recent,
  });
}

/** 把某项目的全部 PDF 票据合并成一个 PDF（用于整项目一次性预览/打印） */
function mergeReceiptsPdf(projectId) {
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
  if (!p) return bad('项目不存在');
  const rows = db.prepare('SELECT * FROM receipts WHERE project_id=? ORDER BY id').all(projectId);
  const bufs = [];
  let skipped = 0;
  for (const r of rows) {
    const isPdf = /pdf/i.test(r.mime || '') || /\.pdf$/i.test(r.file_name || '') || /\.pdf$/i.test(r.file_path || '');
    if (!isPdf || !r.file_path) { skipped++; continue; }
    const fp = path.join(UPLOAD_DIR, path.basename(r.file_path));
    if (!fs.existsSync(fp)) { skipped++; continue; }
    bufs.push(fs.readFileSync(fp));
  }
  if (!bufs.length) return bad(skipped ? '该项目的票据都不是 PDF 文件' : '该项目还没有票据');
  let out;
  try {
    out = mergePdfs(bufs);
  } catch (e) {
    return bad('票据合并失败：' + String(e && e.message ? e.message : e));
  }
  return {
    ok: true,
    __raw: {
      buf: out.buf,
      type: 'application/pdf',
      filename: `${p.code || p.id}_票据合并.pdf`,
      inline: true,
    },
    data: { pages: out.pages, merged: bufs.length, skipped },
  };
}

module.exports = {
  getSettings, updateSettings,
  listPeriods, createPeriod, updatePeriod, deletePeriod,
  listColleges, createCollege, createMajor, updateCollege, deleteCollege, updateMajor, deleteMajor,
  listProjects, getProject, createProject, updateProject, deleteProject,
  createTrip, updateTrip, deleteTrip,
  listMembers, createMember, updateMember, deleteMember, searchPeople,
  listReceipts, createReceipt, uploadReceipts, updateReceipt, reviewReceipt, deleteReceipt, reocrReceipt,
  importReceipts, receiptTemplate,
  exportTravelDocx, exportFundXlsx, buildTravelPayload, lastExport, mergeReceiptsPdf,
  addDictItem, deleteDictItem, allCategories, allBuckets,
  dashboard, CATEGORIES, BUCKETS,
};