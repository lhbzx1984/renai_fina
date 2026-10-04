'use strict';
/** 演示数据：造 4 个覆盖各分类的项目，含差旅/非差旅、已审核/待审核票据 */
const BASE = 'http://127.0.0.1:5180';

async function req(method, url, body, isForm) {
  const opt = { method, headers: {} };
  if (isForm) opt.body = body;
  else if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(BASE + url, opt);
  const d = await r.json();
  if (!r.ok || d.ok === false) throw new Error(d.error);
  return d.data;
}

(async () => {
  console.log('清理旧演示数据…');
  const olds = await req('GET', '/api/projects');
  for (const p of olds.projects) {
    if (p.name.includes('[演示]')) await req('DELETE', '/api/projects/' + p.id);
  }

  const { colleges } = await req('GET', '/api/colleges');
  const C = {};
  for (const c of colleges) C[c.name] = c.id;

  // 期间 id 动态取，不写死：期间可在设置页增删，写死会在期间被删后 FK 失败
  const { periods } = await req('GET', '/api/periods');
  const term2 = periods.find((p) => p.kind === 'term' && /第\s*2\s*学期/.test(p.name))
    || periods.find((p) => p.kind === 'term') || periods[0];
  const yearP = periods.find((p) => p.kind === 'year') || periods[0];
  if (!term2 || !yearP) throw new Error('未找到可用期间，请先在「基础设置」创建学期/自然年');
  const TERM_ID = term2.id;
  const YEAR_ID = yearP.id;
  console.log(`  期间：第2学期=${term2.name}(${TERM_ID})  自然年=${yearP.name}(${YEAR_ID})`);

  // 上传票据（构造最小 PNG/JPEG）
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(512, 3)]);
  const boundary = '----demo' + Date.now();
  const part = (fn, ct, data) => Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${fn}"\r\nContent-Type: ${ct}\r\n\r\n`),
    data, Buffer.from('\r\n'),
  ]);

  /* 1. 教改项目 · 非差旅 */
  console.log('[演示] 教改项目（非差旅）…');
  const p2 = await req('POST', '/api/projects', {
    name: '[演示] 《智能硬件基础》课程实践教学改革项目',
    category: 'reform', period_id: TERM_ID, college_id: C['信息与智能工程学院'],
    leader: '王建国', has_travel: 0, budget: 6600,
    reason: '2025-2026学年第2学期《智能硬件基础》课程实践耗材费用',
  });
  await req('POST', `/api/projects/${p2.id}/members`, {
    role: 'teacher', name: '王建国', job_no: '088001', phone: '13700000003', rank_level: '一类',
  });
  const r2 = await req('POST', `/api/projects/${p2.id}/receipts`, {
    category: 'other', amount: 6600, vendor: '天津智造科技有限公司',
    invoice_no: '04412026003188', invoice_date: '2026-03-02', ocr_status: 'approved',
  });
  await req('POST', `/api/receipts/${r2.id}/review`, {
    status: 'approved', reviewer: '财务处-张会计', amount: 6600, category: 'other',
    items: [{ member_id: (await req('GET', `/api/projects/${p2.id}/members`)).members[0].id, bucket: 'other', amount: 6600, note: '开发板及传感器耗材' }],
  });

  /* 2. 科研项目 · 含差旅 · 留待审核票据 */
  console.log('[演示] 科研项目（含待审核票据）…');
  const p3 = await req('POST', '/api/projects', {
    name: '[演示] 智能感知实验室设备采购与调研',
    category: 'research', period_id: TERM_ID, college_id: C['机械与动力工程学院'],
    leader: '陈志强', has_travel: 1, budget: 85000,
    reason: '赴上海参加智能感知学术会议并调研设备供应商',
  });
  await req('POST', `/api/projects/${p3.id}/trips`, {
    reason: '赴上海参加智能感知学术会议',
    start_date: '2026-09-10', end_date: '2026-09-13', from_place: '天津', to_place: '上海',
  });
  await req('POST', `/api/projects/${p3.id}/members`, {
    role: 'teacher', name: '陈志强', job_no: '077015', phone: '13600000004', rank_level: '一类',
  });
  const form3 = Buffer.concat([
    part('上海酒店_980.00元.jpg', 'image/jpeg', png),
    part('高铁票_553.00元.png', 'image/png', png),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
  await fetch(`${BASE}/api/projects/${p3.id}/receipts/upload`, {
    method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body: form3,
  }).then((r) => r.json());
  console.log('  留 2 张待审核');

  /* 3. 竞赛项目 · 非差旅 · 待审核 */
  console.log('[演示] 竞赛项目…');
  const p4 = await req('POST', '/api/projects', {
    name: '[演示] 2026年全国大学生智能汽车竞赛参赛费用',
    category: 'competition', period_id: TERM_ID, college_id: C['数智传媒与设计艺术学院'],
    leader: '赵敏', has_travel: 0, budget: 25000, reason: '智能汽车竞赛赛件制作与参赛费用',
  });
  await req('POST', `/api/projects/${p4.id}/members`, {
    role: 'teacher', name: '赵敏', job_no: '091002', phone: '13500000005', rank_level: '二类',
  });
  await req('POST', `/api/projects/${p4.id}/members`, {
    role: 'student', name: '孙浩然', job_no: '20230201', phone: '13400000006', major: '数字媒体艺术',
  });
  const form4 = Buffer.concat([
    part('赛件加工费_4200.00元.jpg', 'image/jpeg', png),
    part('参赛注册费_800.00元.png', 'image/png', png),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
  await fetch(`${BASE}/api/projects/${p4.id}/receipts/upload`, {
    method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body: form4,
  }).then((r) => r.json());

  /* 4. 科研 · 草稿态 */
  console.log('[演示] 科研草稿…');
  await req('POST', '/api/projects', {
    name: '[演示] 数字孪生技术预研（草稿）',
    category: 'research', period_id: YEAR_ID, college_id: C['经济与管理学院'],
    leader: '周立', has_travel: 0, budget: 50000, reason: '数字孪生技术前期研究', status: 'draft',
  });

  const all = await req('GET', '/api/projects');
  console.log('\n演示数据就绪，共', all.projects.length, '个项目：');
  for (const p of all.projects) {
    console.log(`  ${p.code}  ${p.name}`);
    console.log(`      分类=${p.category} 成员=${p.member_count} 票据=${p.receipt_count} 待审=${p.pending_count} 已审=¥${p.approved_amount}`);
  }
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });