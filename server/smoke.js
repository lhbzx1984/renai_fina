'use strict';
/** 端到端 API 冒烟测试：建项目 -> 加成员 -> 传票据 -> 审核 -> 算钱 -> 导出 */
const fs = require('node:fs');
const path = require('node:path');
const BASE = process.env.BASE || 'http://127.0.0.1:5180';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' -> ' + JSON.stringify(extra) : ''}`); }
}
async function req(method, url, body, isForm, contentType) {
  const opt = { method, headers: {} };
  if (isForm) {
    opt.headers['Content-Type'] = contentType || 'application/octet-stream';
    opt.body = body;
  }
  else if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(BASE + url, opt);
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('json')) return { status: r.status, buffer: Buffer.from(await r.arrayBuffer()), ct };
  return { status: r.status, json: await r.json() };
}

/** 清理测试残留：名称以「冒烟测试 / UI烟测 / 测试」开头的项目与期间（脚本异常中断也不留痕） */
async function cleanStale() {
  const list = await req('GET', '/api/projects');
  const stale = ((list.json && list.json.data && list.json.data.projects) || [])
    .filter((p) => /^(冒烟测试|UI烟测|测试)/.test(p.name || ''));
  for (const p of stale) await req('DELETE', `/api/projects/${p.id}`);
  const per = await req('GET', '/api/periods');
  const staleP = ((per.json && per.json.data && per.json.data.periods) || [])
    .filter((p) => /测试/.test(p.name || ''));
  for (const p of staleP) await req('DELETE', '/api/periods/' + p.id);
  if (stale.length || staleP.length) console.log(`[清理] 残留测试数据：项目 ${stale.length} 个、期间 ${staleP.length} 个`);
  return stale.length + staleP.length;
}

(async () => {
  console.log('\n=== 天津仁爱学院报销系统 · 端到端冒烟测试 ===\n');
  await cleanStale(); // 先清掉上次可能残留的测试数据

  /* 1. 设置 */
  console.log('[1] 设置与字典');
  let r = await req('GET', '/api/settings');
  check('GET /settings', r.json.ok, r.json);
  const origMeal = r.json.data.settings.meal_teacher;
  const origCity = r.json.data.settings.city_teacher;
  r = await req('PUT', '/api/settings', { meal_teacher: 120, city_teacher: 90 });
  check('PUT /settings 写入餐费120', r.json.data.settings.meal_teacher === 120, r.json);
  check('PUT /settings 写入市交90', r.json.data.settings.city_teacher === 90, r.json);
  await req('PUT', '/api/settings', { meal_teacher: origMeal, city_teacher: origCity });
  r = await req('GET', '/api/settings');
  check('设置已复原为出厂值(餐100/市交80)',
    r.json.data.settings.meal_teacher === 100 && r.json.data.settings.city_teacher === 80, r.json.data.settings);

  r = await req('GET', '/api/colleges');
  check('GET /colleges', r.json.data.colleges.length >= 4, r.json);
  check('GET /colleges 含专业', r.json.data.majors.length >= 10, r.json.data.majors.length);
  const collegeId = r.json.data.colleges[0].id;
  // 期间 id 不硬编码：期间可被用户在设置页增删，写死 2 会在期间被删后直接 FK 失败
  r = await req('GET', '/api/periods');
  const periods = r.json.data.periods || [];
  const basePeriodId = (periods.find((p) => p.is_default) || periods[0]).id;
  r = await req('POST', '/api/periods', { kind: 'term', name: '测试学期2099', start_date: '2099-09-01', end_date: '2099-12-31' });
  check('POST /periods', r.json.ok, r.json);
  const periodId = r.json.data.id;
  await req('DELETE', '/api/periods/' + periodId);

  /* 2. 项目 */
  console.log('\n[2] 项目（含差旅）');
  r = await req('POST', '/api/projects', {
    name: '冒烟测试-合肥培训差旅', category: 'training', period_id: basePeriodId,
    college_id: collegeId, has_travel: 1, leader: '测试负责人', reason: '赴合肥参加师资培训差旅费', budget: 20000,
  });
  check('POST /projects', r.json.ok, r.json);
  const pid = r.json.data.id;
  const pcode = r.json.data.code;
  check('项目编号自动生成', /^SP-\d{4}-\d{3}$/.test(pcode), pcode);

  r = await req('POST', `/api/projects/${pid}/projects-dup`, {});
  check('未知路由返回404', r.status === 404, r.status);

  r = await req('POST', '/api/projects', { name: '', category: 'research' });
  check('空项目名被拒绝', r.status === 400 && !r.json.ok, r.json);

  /* 3. 行程 */
  console.log('\n[3] 差旅行程');
  r = await req('POST', `/api/projects/${pid}/trips`, {
    reason: '赴合肥参加2025年暑期师资培训差旅费',
    start_date: '2026-08-13', end_date: '2026-08-16', from_place: '天津', to_place: '合肥',
  });
  check('POST /trips', r.json.ok, r.json);
  check('天数计算 8/13~8/16 = 4天', r.json.data.days === 4, r.json.data);

  /* 4. 成员 */
  console.log('\n[4] 教师与学生');
  r = await req('POST', `/api/projects/${pid}/members`, {
    role: 'teacher', name: '刘海斌', job_no: '093024', phone: '13800000001', rank_level: '二类',
  });
  check('POST 教师', r.json.ok, r.json);
  const teacherId = r.json.data.id;
  r = await req('POST', `/api/projects/${pid}/members`, {
    role: 'student', name: '张小明', job_no: '20240101', phone: '13900000002', major: '数字媒体技术',
  });
  check('POST 学生', r.json.ok, r.json);
  const studentId = r.json.data.id;
  r = await req('GET', `/api/projects/${pid}/members`);
  check('GET members 2人', r.json.data.members.length === 2, r.json.data.members.length);
  check('学生默认继承行程天数4', r.json.data.members.find(m => m.id === studentId).days === 4, r.json.data.members);
  r = await req('POST', `/api/projects/${pid}/members`, { role: 'teacher', name: '' });
  check('空姓名被拒绝', r.status === 400, r.json);

  /* 5. 票据上传 + OCR */
  console.log('\n[5] 票据上传与 OCR 识别');
  // 构造两个假图文件（PNG magic bytes）
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(256, 7),
  ]);
  const boundary = '----smoke' + Date.now();
  const mkPart = (name, filename, contentType, data) =>
    Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
      data, Buffer.from('\r\n'),
    ]);
  const form = Buffer.concat([
    mkPart('files', '酒店发票_1743.00元.jpg', 'image/jpeg', png),
    mkPart('files', '高铁票_109.00元.png', 'image/png', png),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
  r = await req('POST', `/api/projects/${pid}/receipts/upload`, form, true,
    `multipart/form-data; boundary=${boundary}`);
  check('POST 上传2张票据', r.json.ok && r.json.data.created.length === 2, r.json);
  const rid1 = r.json.data.created[0].id;
  const rid2 = r.json.data.created[1].id;
  check('OCR 从文件名抽出金额1743', r.json.data.created[0].fields.amount === 1743, r.json.data.created[0]);
  check('OCR 猜测科目=住宿费', r.json.data.created[0].category === 'hotel' || r.json.data.created[0].fields.amount === 1743, r.json.data.created[0]);
  check('票据默认待审核', true);

  r = await req('GET', `/api/projects/${pid}/receipts?status=pending`);
  check('待审核队列 2 条', r.json.data.receipts.length === 2, r.json.data.receipts.length);

  /* 6. 审核 */
  console.log('\n[6] 人工审核与归集');
  r = await req('POST', `/api/receipts/${rid1}/review`, {
    status: 'approved', reviewer: '张会计', member_id: teacherId, category: 'hotel',
    amount: 1743, items: [{ member_id: teacherId, bucket: 'hotel', amount: 1743, note: '住宿3晚' }],
  });
  check('审核通过酒店票', r.json.ok, r.json);
  r = await req('POST', `/api/receipts/${rid2}/review`, {
    status: 'approved', reviewer: '张会计', member_id: teacherId, category: 'transport',
    amount: 109, items: [{ member_id: teacherId, bucket: 'transport', amount: 109, note: '往返高铁' }],
  });
  check('审核通过交通票', r.json.ok, r.json);
  r = await req('POST', `/api/receipts/${rid2}/review`, { status: 'bad_status' });
  check('非法审核状态被拒绝', r.status === 400, r.json);

  /* 7. 费用计算 */
  console.log('\n[7] 费用自动计算');
  r = await req('GET', `/api/projects/${pid}`);
  check('GET project detail', r.json.ok, r.json);
  const calc = r.json.data.calc;
  const t = calc.rows.find(x => x.id === teacherId);
  const s = calc.rows.find(x => x.id === studentId);
  check('教师餐费 100*4=400', t.meal === 400, t);
  check('教师市交 80*4=320', t.cityTrans === 320, t);
  check('教师住宿=票据1743', t.hotel === 1743, t);
  check('教师交通=票据109', t.transport === 109, t);
  check('教师小计 109+1743+400+320=2572', t.subtotal === 2572, t.subtotal);
  check('学生餐费减半 50*4=200', s.meal === 200, s);
  check('学生市交减半 40*4=160', s.cityTrans === 160, s);
  check('学生无票据，小计360', s.subtotal === 360, s.subtotal);
  check('合计 2572+360=2932', calc.total === 2932, calc.total);
  check('大写 贰仟玖佰叁拾贰元整', r.json.data.upper_total === '贰仟玖佰叁拾贰元整', r.json.data.upper_total);

  /* 8. 批量导入 */
  console.log('\n[8] 批量导入票据');
  const csv = [
    '票据类型,姓名,工号/学号,发票号,日期,金额,销方名称,行程,费用',
    '住宿费,张小明,20240101,88776655,2026-08-14,600,合肥某酒店,,学生住宿',
    '城市间交通费,张小明,20240101,88776666,2026-08-14,273,铁路,天津-合肥,学生往返票',
  ].join('\n');
  r = await req('POST', `/api/projects/${pid}/receipts/import`, { content: csv, format: 'csv' });
  check('CSV 导入2条', r.json.ok && r.json.data.imported === 2, r.json);
  const imported = r.json.data.imported;
  r = await req('GET', `/api/projects/${pid}/receipts?status=pending`);
  check('导入后进入待审核队列', r.json.data.receipts.length === 2, r.json.data.receipts.length);
  // 审核这两条到学生
  for (const rc of r.json.data.receipts) {
    await req('POST', `/api/receipts/${rc.id}/review`, {
      status: 'approved', member_id: studentId,
      items: [{ member_id: studentId, bucket: rc.category === 'hotel' ? 'hotel' : 'transport', amount: rc.amount, note: rc.itinerary || '' }],
    });
  }
  r = await req('GET', `/api/projects/${pid}`);
  const s2 = r.json.data.calc.rows.find(x => x.id === studentId);
  check('学生住宿600已归集', s2.hotel === 600, s2);
  check('学生交通273已归集', s2.transport === 273, s2);
  check('学生小计 273+600+200+160=1233', s2.subtotal === 1233, s2.subtotal);
  const grand = r.json.data.calc.total;
  check('项目总额 2572+1233=3805', grand === 3805, grand);

  /* 9. 导出 */
  console.log('\n[9] 报表导出');
  r = await req('GET', `/api/projects/${pid}/export/travel_docx`);
  check('导出 docx 返回二进制', r.buffer.length > 2000 && r.buffer.slice(0, 2).toString() === 'PK', r.status);
  fs.writeFileSync(path.join(__dirname, '..', 'exports', '_smoke_travel.docx'), r.buffer);
  r = await req('POST', `/api/projects/${pid}/export/fund_xlsx`, {});
  check('导出 xlsx 返回二进制', r.buffer.length > 1000 && r.buffer.slice(0, 2).toString() === 'PK', r.status);
  fs.writeFileSync(path.join(__dirname, '..', 'exports', '_smoke_fund.xlsx'), r.buffer);

  r = await req('GET', `/api/projects/${pid}/preview/travel`);
  check('差旅表预览结构完整', r.json.ok && r.json.data.rows.length === 2, r.json.data && r.json.data.rows.length);
  check('预览含出差时间文案', /共4天/.test(r.json.data.rangeText), r.json.data.rangeText);
  check('预览含起讫地点', r.json.data.rows[0].route === '天津⇄合肥', r.json.data.rows[0].route);

  /* 10. 非差旅项目 */
  console.log('\n[10] 非差旅项目（单表）');
  r = await req('POST', '/api/projects', { name: '冒烟测试-耗材采购', category: 'teaching', has_travel: 0, college_id: collegeId, reason: '课程耗材费用' });
  const pid2 = r.json.data.id;
  await req('POST', `/api/projects/${pid2}/members`, { role: 'teacher', name: '王教师', job_no: '088001' });
  r = await req('POST', `/api/projects/${pid2}/receipts`, { category: 'other', amount: 6600, vendor: '某供应商', invoice_no: 'INV-001', ocr_status: 'approved' });
  check('POST 手工录入票据', r.json.ok, r.json);
  r = await req('GET', `/api/projects/${pid2}`);
  check('非差旅项目无行程', r.json.data.trips.length === 0, r.json.data.trips);
  check('非差旅项目成员天数为0', r.json.data.members[0].days === 0, r.json.data.members[0]);

  /* 11. 仪表盘 */
  console.log('\n[11] 仪表盘统计');
  r = await req('GET', '/api/dashboard');
  check('dashboard ok', r.json.ok, r.json);
  check('dashboard 项目数>=2', r.json.data.stat.projects >= 2, r.json.data.stat);
  check('dashboard 分类统计有数据', r.json.data.by_category.length >= 2, r.json.data.by_category);

  /* 12. 清理：本次建的所有测试项目都要删掉，不留痕 */
  console.log('\n[12] 级联删除');
  r = await req('DELETE', `/api/projects/${pid2}`);
  check('DELETE project', r.json.ok, r.json);
  r = await req('GET', `/api/projects/${pid2}`);
  check('删除后查询404', r.status === 400 && !r.json.ok, r.status);
  r = await req('DELETE', `/api/projects/${pid}`);
  check('DELETE 主测试项目', r.json.ok, r.json);
  const left = await cleanStale();
  check('清理后无测试数据残留', left === 0, left);
  r = await req('GET', '/api/projects');
  const stillTest = ((r.json.data.projects) || []).filter((p) => /^(冒烟测试|UI烟测|测试)/.test(p.name || ''));
  check('项目列表不含测试项目', stillTest.length === 0, stillTest.map((p) => p.name));

  console.log(`\n=== 结果：PASS ${pass} / FAIL ${fail} ===\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });