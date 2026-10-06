'use strict';
/**
 * 费用计算：根据设置 + 成员 + 已审核票据归集，算出每个人的五栏费用与小计/合计。
 * 规则：
 *  - 伙食补助费 = 每日餐费 × 天数（教师默认 100，学生按系数减半）
 *  - 市内交通费 = 每日市内交通补助 × 天数（教师默认 80，学生减半）
 *  - 城市间交通费 / 住宿费 / 其他费用 = 已审核票据归集（receipt_items）
 *  - 成员可单独覆盖餐费/交通标准（member.meal_rate / city_rate）
 */
const { round2 } = require('./money');

function rateOf(cfg, role, override, teacherKey) {
  if (override != null && override !== '' && !Number.isNaN(Number(override))) return Number(override);
  const base = Number(cfg[teacherKey]) || 0;
  if (role === 'student') return round2(base * (Number(cfg.student_ratio) || 0));
  return base;
}

/** 票价数字格式：整数不带小数，其余保留两位内 */
function priceText(v) {
  const r = round2(Number(v) || 0);
  return Number.isInteger(r) ? String(r) : r.toFixed(2).replace(/0$/, '');
}

/** 城市间交通费表达式：按单程票价分组计数，如 "54.5*2"，多种票价用 + 连接（统计累加） */
function transportExprOf(tickets) {
  if (!tickets || !tickets.length) return '0';
  const groups = new Map();
  for (const a of tickets) groups.set(a, (groups.get(a) || 0) + 1);
  return [...groups.entries()]
    .sort((x, y) => y[0] - x[0])
    .map(([price, n]) => `${priceText(price)}*${n}`)
    .join('+');
}

/**
 * 计算项目费用
 * @param {object} cfg getAllSettings() 结果
 * @param {Array} members 项目成员（含 days / meal_rate / city_rate）
 * @param {Array} items 已审核票据归集明细 [{member_id, bucket, amount}]
 * @param {object} [opts] { route: '天津⇄合肥', trips: [{id, from_place, to_place, days, member_ids_parsed}],
 *   bucketLabels: { bucketKey: 科目中文名 } }
 *   缺省起讫地点 opts.route；成员若绑定某段行程（trips[].member_ids 含该成员 id），
 *   则用该段行程的出发地/目的地与天数，实现「同一项目、不同人不同行程」。
 *   bucketLabels 用于把非差旅科目（耗材费/打印费等）映射成中文名，落到「其他费用」明细。
 * @returns {{rows:Array, total:number, bucketTotal:object}}
 */
function computeProject(cfg, members, items, opts = {}) {
  const defaultRoute = opts.route || '';
  const trips = Array.isArray(opts.trips) ? opts.trips : [];
  const routeOf = (t) => (t && t.from_place && t.to_place ? `${t.from_place}⇄${t.to_place}` : '');
  /** 成员绑定的行程：优先按 member_ids 命中的第一段；无绑定则返回 null（套用默认） */
  const tripOfMember = (m) => {
    for (const t of trips) {
      const ids = t.member_ids_parsed || (Array.isArray(t.member_ids) ? t.member_ids : []);
      if (ids.some((id) => Number(id) === Number(m.id))) return t;
    }
    return null;
  };
  const defaultTrip = trips[0] || null;
  // 差旅表固定五栏之外的科目（耗材费/打印费/版面费等）统一归集到「其他费用」，
  // 明细里保留真实科目名，便于财务核对
  const labels = opts.bucketLabels || {};
  const TRAVEL = ['transport', 'hotel', 'city_trans', 'other'];
  const byMember = new Map();
  for (const it of items || []) {
    if (!it.member_id) continue;
    const cur = byMember.get(it.member_id) || { transport: 0, hotel: 0, city_trans: 0, other: 0, others: [], transportTickets: [] };
    const b = TRAVEL.includes(it.bucket) ? it.bucket : 'other';
    cur[b] = round2(cur[b] + Number(it.amount || 0));
    if (b === 'transport') cur.transportTickets.push(round2(Number(it.amount) || 0));
    if (b === 'other') {
      cur.others.push({ item: it.note || labels[it.bucket] || '其他', amount: round2(it.amount || 0) });
    }
    byMember.set(it.member_id, cur);
  }

  const rows = [];
  const bucketTotal = { transport: 0, hotel: 0, meal: 0, city_trans: 0, other: 0 };

  for (const m of members) {
    const mTrip = tripOfMember(m) || defaultTrip;
    // 成员未单独填天数时，跟随其绑定行程的天数（主行程为兜底）
    const days = Math.max(0, Number(m.days) || (mTrip ? Number(mTrip.days) || 0 : 0));
    const mealRate = rateOf(cfg, m.role, m.meal_rate, 'meal_teacher');
    const cityRate = rateOf(cfg, m.role, m.city_rate, 'city_teacher');
    const meal = round2(mealRate * days);
    const cityTrans = round2(cityRate * days);
    const agg = byMember.get(m.id) || { transport: 0, hotel: 0, city_trans: 0, other: 0, others: [], transportTickets: [] };

    // 票据归集的市内交通费覆盖定额（若已录入票据，以票据实际金额为准）
    const cityFinal = agg.city_trans > 0 ? agg.city_trans : cityTrans;

    const subtotal = round2(agg.transport + agg.hotel + meal + cityFinal + agg.other);
    rows.push({
      id: m.id,
      dept: m.dept || m.college || '',
      name: m.name,
      jobNo: m.job_no || '',
      rankLevel: m.rank_level || (m.role === 'student' ? '学生' : ''),
      route: m.route || routeOf(mTrip) || defaultRoute,
      role: m.role,
      days,
      mealRate,
      cityRate,
      // 展示表达式：定额部分保留 "单价*天数"、车票保留 "单程票价*张数" 的算法痕迹，便于财务核对
      transport: round2(agg.transport),
      transportExpr: agg.transportTickets.length ? transportExprOf(agg.transportTickets) : '0',
      hotel: round2(agg.hotel),
      hotelExpr: agg.hotel ? String(agg.hotel) : '0',
      meal,
      mealExpr: days > 0 ? `${mealRate}*${days}` : '0',
      cityTrans: cityFinal,
      cityExpr: agg.city_trans > 0 ? String(agg.city_trans) : (days > 0 ? `${cityRate}*${days}` : '0'),
      otherItems: agg.others,
      otherTotal: round2(agg.other),
      subtotal,
    });

    bucketTotal.transport = round2(bucketTotal.transport + round2(agg.transport));
    bucketTotal.hotel = round2(bucketTotal.hotel + round2(agg.hotel));
    bucketTotal.meal = round2(bucketTotal.meal + meal);
    bucketTotal.city_trans = round2(bucketTotal.city_trans + cityFinal);
    bucketTotal.other = round2(bucketTotal.other + round2(agg.other));
  }

  const total = round2(
    bucketTotal.transport + bucketTotal.hotel + bucketTotal.meal + bucketTotal.city_trans + bucketTotal.other
  );
  return { rows, bucketTotal, total };
}

/** 计算两个日期之间的天数（含首尾），无效返回 0 */
function calcDays(start, end) {
  if (!start || !end) return 0;
  const s = new Date(String(start).replace(/\//g, '-'));
  const e = new Date(String(end).replace(/\//g, '-'));
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return 0;
  const ms = e.getTime() - s.getTime();
  const d = Math.floor(ms / 86400000) + 1;
  return d > 0 ? d : 0;
}

/** 2025-08-13 -> 2025年8月13日 */
function cnDate(iso) {
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(iso);
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;
}

module.exports = { computeProject, calcDays, cnDate };