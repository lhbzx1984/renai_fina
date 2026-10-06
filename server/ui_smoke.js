'use strict';
/**
 * 无头 Chrome 端到端 UI 烟测：
 * 在真实浏览器里跑完整业务流，收集 JS 报错、验证关键 DOM 与计算结果。
 * 用法： node ui_smoke.js
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const PORT = 5180;
const URL_ = `http://127.0.0.1:${PORT}/`;
const PUBLIC = path.join(__dirname, 'public');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

/** 构造注入脚本：记录报错 + 分步模拟点击 */
const DIAG_SCRIPT = `
window.__errs = [];
window.addEventListener('error', (e) => window.__errs.push('ERR: ' + (e.message || '') + ' @' + (e.filename||'') + ':' + (e.lineno||'')));
window.addEventListener('unhandledrejection', (e) => window.__errs.push('REJECT: ' + (e.reason && e.reason.message || e.reason)));
const _ce = console.error;
console.error = function(){ window.__errs.push('CONSOLE: ' + Array.from(arguments).map(String).join(' ')); _ce.apply(console, arguments); };

window.__log = [];
const L = (m) => window.__log.push(m);

async function wait(ms){ return new Promise(r => setTimeout(r, ms)); }
function need(cond, msg){ if(!cond){ window.__errs.push('ASSERT: ' + msg); } L((cond?'PASS ':'FAIL ') + msg); return cond; }
/** 归一化空白，避免 DOM 换行破坏正则 */
function flat(s){ return String(s||'').replace(/[\\u00a0\\s]+/g, ' ').trim(); }
/** 判断文本是否含 "共4天" 或 "天数4天" 之类的组合，忽略空白 */
function hasDays(s, n){ const t = flat(s).replace(/\\s+/g,''); return t.includes('共'+n+'天') || t.includes('天数'+n+'天'); }
/** 等待分步向导走到第 k 步（异步切视图+高亮，轮询比固定 sleep 稳） */
async function waitStep(k, tries){ for(let i=0;i<(tries||40);i++){ const el=document.querySelector('.tc-step'); if(el && flat(el.textContent).indexOf('第 '+k+' / 6 步')>=0) return true; await wait(200);} return false; }

async function run(){
  try{
    // 等 App 初始化
    for(let i=0;i<40 && !window.App;i++) await wait(150);
    await wait(700);
    // 先清掉上次运行可能残留的测试项目（本次中途失败也不留痕）
    const stale = App.state.projects.filter(p=>/^(UI烟测|冒烟测试|测试)/.test(p.name||''));
    for(const p of stale){ await fetch('/api/projects/'+p.id, {method:'DELETE'}); }
    if(stale.length){ await App.loadProjects(); L('[清理] 残留测试项目 '+stale.length+' 个已删除'); }
    L('== 0. 分步向导（首次自动启动，逐步点击）==');
    await waitStep(1, 40);
    need(!!document.querySelector('#tourMask.show'), '首次访问自动启动分步向导');
    need(!!document.querySelector('#tourSpot'), '向导高亮框已渲染');
    const stepTxt = () => flat(document.querySelector('.tc-step') && document.querySelector('.tc-step').textContent);
    need(stepTxt().indexOf('第 1 / 6 步') >= 0, '向导停在第 1 步：' + stepTxt());
    const spotVisible = document.querySelector('#tourSpot').getBoundingClientRect().width > 0;
    need(spotVisible, '第 1 步高亮框有实际尺寸');
    for(let k=2;k<=6;k++){
      document.querySelector('#tourCard .tc-next').click();
      const ok = await waitStep(k);
      need(ok, '点「下一步」进入第 ' + k + ' 步，实际=' + stepTxt());
    }
    const lastLabel = flat(document.querySelector('#tourCard .tc-next').textContent);
    need(lastLabel.indexOf('完成') >= 0, '第 6 步主按钮为「完成」：' + lastLabel);
    document.querySelector('#tourCard .tc-next').click();
    await wait(700);
    need(!document.querySelector('#tourMask').classList.contains('show'), '走完 6 步后向导自动结束');

    L('== 1. 工作台 ==');
    need(!!window.App, 'App 对象已创建');
    need(document.querySelectorAll('#statCards .stat').length === 5, '统计卡片 5 张，实际 ' + document.querySelectorAll('#statCards .stat').length);
    const catChartTxt = document.querySelector('#catChart')?.textContent || '';
    L('catChart 长度=' + catChartTxt.length);

    L('== 2. 项目列表 ==');
    App.switchView('projects');
    await wait(500);
    const cards0 = document.querySelectorAll('#projectCards .pcard').length;
    need(cards0 >= 0, '项目卡片渲染（' + cards0 + ' 张）');
    L('项目卡片数=' + cards0);

    L('== 3. 新建项目（含差旅）==');
    document.getElementById('btnNewProject').click();
    await wait(400);
    need(document.querySelector('#modalMask').classList.contains('show'), '新建项目弹窗已打开');
    document.getElementById('pf_name').value = 'UI烟测-合肥培训';
    document.getElementById('pf_leader').value = '烟测负责人';
    document.getElementById('pf_reason').value = '赴合肥参加师资培训差旅费';
    document.getElementById('pf_budget').value = '30000';
    document.getElementById('pf_category').value = 'training';
    document.getElementById('pf_college').value = String(document.getElementById('pf_college').options[1].value);
    document.getElementById('pf_travel').checked = true;
    document.getElementById('pf_travel').dispatchEvent(new Event('change'));
    await wait(200);
    const catSelVal = document.getElementById('pf_category').value;
    need(catSelVal === 'training', '分类选择生效=' + catSelVal);
    const collegeVal = document.getElementById('pf_college').value;
    const majorOpts = document.getElementById('pf_major').options.length;
    need(majorOpts > 1, '学院联动专业（' + majorOpts + ' 项）');
    // 点保存
    const btns = Array.from(document.querySelectorAll('#modalBox .modal-foot .btn'));
    btns[btns.length-1].click();
    await wait(900);
    const cards1 = document.querySelectorAll('#projectCards .pcard').length;
    need(cards1 === cards0 + 1, '项目已创建，卡片 ' + cards0 + ' -> ' + cards1);

    // 找到刚建的项目
    const projIds = await App.state.projects.map(p=>p.id);
    const newProj = App.state.projects.find(p=>p.name==='UI烟测-合肥培训');
    need(!!newProj, '新项目在列表中');
    const pid = newProj.id;
    need(newProj.has_travel === true, '差旅标记已保存');
    need(newProj.category === 'training', '分类=师资培训，实际 ' + newProj.category);
    L('newProj=' + JSON.stringify({id:pid, code:newProj.code, has_travel:newProj.has_travel, cat:newProj.category}));

    L('== 4. 添加差旅行程 ==');
    await App.openProject(pid);
    await wait(900);
    need(!!document.querySelector('#detailBox .steps'), '项目详情页已渲染（步骤条）');
    const stepCount = document.querySelectorAll('.step').length;
    need(stepCount === 4, '步骤条 4 步，实际 ' + stepCount);
    const stepKeys = [...document.querySelectorAll('#detailBox .step')].map((e) => e.dataset.step);
    need(stepKeys.join(',') === 'members,trip,receipts,report',
      '步骤顺序：教师与学生(1)→差旅行程(2)→票据(3)→报表(4)，实际 ' + stepKeys.join(','));

    document.querySelector('[data-step="trip"]').click();
    await wait(400);
    document.querySelector('#stepBox .btn-primary').click();
    await wait(400);
    document.getElementById('tf_reason').value='赴合肥参加UI烟测培训';
    document.getElementById('tf_start').value='2026-08-13';
    document.getElementById('tf_end').value='2026-08-16';
    document.getElementById('tf_from').value='天津';
    document.getElementById('tf_to').value='合肥';
    document.getElementById('tf_end').dispatchEvent(new Event('input'));
    await wait(250);
    const daysHint = document.getElementById('tf_days').textContent;
    need(hasDays(daysHint, 4), '天数试算提示含4天：' + flat(daysHint));
    need(/教师定额/.test(daysHint), '提示含教师定额');
    need(/学生定额/.test(daysHint), '提示含学生定额');
    const m2 = document.querySelectorAll('#modalBox .modal-foot .btn');
    m2[m2.length-1].click();
    await wait(1100);
    // 保存后应停留在行程步骤（keepStep='trip'）
    const activeStep = document.querySelector('.step.active');
    need(activeStep && activeStep.dataset.step === 'trip', '保存后停留在行程步骤，实际=' + (activeStep?activeStep.dataset.step:'none'));
    const tripTxt = document.querySelector('#stepBox').textContent;
    need(hasDays(tripTxt, 4), '行程已保存且显示4天：' + flat(tripTxt).slice(0,120));
    need(/天津/.test(tripTxt) && /合肥/.test(tripTxt), '起讫地点显示天津⇄合肥：' + flat(tripTxt).slice(0,160));
    // 多段行程 + 人员绑定
    need(/绑定人员/.test(tripTxt), '行程表含「绑定人员」列（每人可绑不同行程）');
    const addBtn = [...document.querySelectorAll('#stepBox button')].find((b) => /增加一行行程/.test(b.textContent));
    need(!!addBtn, '行程步骤有「+ 增加一行行程」按钮');

    L('== 5. 添加教师与学生 ==');
    document.querySelector('[data-step="members"]').click();
    await wait(400);
    document.querySelector('#stepBox .btn-primary').click();
    await wait(400);
    document.getElementById('mf_name').value='刘海斌';
    document.getElementById('mf_jobno').value='093024';
    document.getElementById('mf_phone').value='13800000001';
    document.getElementById('mf_rank').value='二类';
    await wait(300);
    const mdays = document.getElementById('mf_days').value;
    need(mdays === '4', '成员表单自动带入行程天数 4，实际=' + mdays);
    const mh = document.getElementById('mf_dayhint').textContent;
    need(/定额合计/.test(mh), '成员表单实时试算：' + flat(mh));
    let mb = Array.from(document.querySelectorAll('#modalBox .modal-foot .btn'));
    mb[mb.length-1].click();
    await wait(1100);
    need(document.querySelector('.step.active')?.dataset.step === 'members', '保存成员后停留在成员步骤');

    // 学生
    document.querySelector('#stepBox .btn-primary').click();
    await wait(400);
    document.querySelector('input[name=mfr][value="student"]').click();
    document.getElementById('mf_name').value='张小明';
    document.getElementById('mf_jobno').value='20240101';
    document.getElementById('mf_phone').value='13900000002';
    await wait(300);
    const sh = flat(document.getElementById('mf_dayhint').textContent);
    need(/餐费 ¥200/.test(sh), '学生试算餐费减半 50*4=200：' + sh);
    need(/市交 ¥160/.test(sh), '学生试算市交减半 40*4=160：' + sh);
    mb = Array.from(document.querySelectorAll('#modalBox .modal-foot .btn'));
    mb[mb.length-1].click();
    await wait(1100);
    const mRows = document.querySelectorAll('#stepBox table.tb tbody tr').length;
    need(mRows === 2, '成员表 2 行，实际 ' + mRows);

    L('== 6. 票据审核 ==');
    document.querySelector('[data-step="receipts"]').click();
    await wait(600);
    need(!!document.querySelector('#dropZone'), '拖拽上传区已渲染');
    const rc0 = document.querySelectorAll('.receipt-card').length;
    L('已有票据=' + rc0);

    // 票据合并打印：按钮存在，且预览弹窗指向合并接口
    const prBtn = Array.from(document.querySelectorAll('#stepBox button')).find(b => b.textContent.includes('打印全部票据'));
    need(!!prBtn, '票据步骤含「打印全部票据」按钮');
    if (prBtn) {
      prBtn.click();
      await wait(800);
      const fr = document.getElementById('rcFrame');
      const src = fr ? (fr.getAttribute('src') || '') : '';
      need(src.includes('/receipts/merged.pdf'), '合并打印预览 iframe 指向票据合并接口，实际 ' + (src || 'NONE'));
      const closeBtn = Array.from(document.querySelectorAll('.modal button, .modal-foot button')).find(b => b.textContent.trim() === '关闭');
      if (closeBtn) closeBtn.click();
      await wait(400);
    }

    L('== 7. 报表预览 ==');
    document.querySelector('[data-step="report"]').click();
    await wait(700);
    const rp = document.querySelector('.report-paper');
    need(!!rp, '差旅费明细表预览已渲染');
    if(rp){
      const t = flat(rp.textContent);
      need(/天 津 仁 爱 学 院 差 旅 费 报 销 明 细 表/.test(t), '预览标题正确');
      need(/天津\s*⇄\s*合肥/.test(t), '预览含起讫地点 天津⇄合肥');
      need(/共\\s*4\\s*天/.test(t), '预览含出差4天');
      need(/100\\*4/.test(t), '预览含教师餐费算法 100*4');
      need(/50\\*4/.test(t), '预览含学生餐费算法 50*4（减半）');
      need(/80\\*4/.test(t), '预览含教师市交算法 80*4');
      need(/40\\*4/.test(t), '预览含学生市交算法 40*4（减半）');
      // 抓合计行金额
      const foot = document.querySelectorAll('.report-paper tfoot tr');
      L('tfoot 行数=' + foot.length);
      if(foot.length>=1){
        // 小计行为「列合计」：交通0 / 住宿0 / 伙食(400+200)=600 / 市交(320+160)=480 / 其他0 / 合计1080
        const sub1 = flat(document.querySelectorAll('.report-paper tfoot tr')[0].textContent);
        L('小计行: ' + sub1);
        need(/600\\.00/.test(sub1), '小计-伙食补助列合计 600.00（教师400+学生200）');
        need(/480\\.00/.test(sub1), '小计-市内交通列合计 480.00（教师320+学生160）');
        need(/1,080\\.00/.test(sub1), '小计行合计 1080.00');
      }
      if(foot.length>=2){
        const totalRow = flat(document.querySelectorAll('.report-paper tfoot tr')[1].textContent);
        L('合计行: ' + totalRow);
        need(/人民币：/.test(totalRow), '合计行含人民币大写前缀');
        need(/元整|元/.test(totalRow), '合计行含大写金额');
      }
      // 精确校验合计：教师(400+320=720) + 学生(200+160=360) = 1080
      need(/1,?080\\.00/.test(t), '合计金额 1080.00 正确');
      need(/壹仟零捌拾元整/.test(t), '大写 壹仟零捌拾元整 正确');
    }
    const fp = document.querySelector('.fund-preview');
    need(!!fp, '资金申请单预览已渲染');
    if(fp){
      const t = flat(fp.textContent);
      need(/资 金 申 请 单/.test(t), '资金申请单标题');
      need(/1,?080\\.00/.test(t), '资金申请单金额 1080.00');
      need(/壹仟零捌拾元整/.test(t), '资金申请单大写');
      need(/赴合肥参加师资培训差旅费/.test(t), '支付事由含项目事由');
      need(/数智传媒与设计艺术学院|学院/.test(t), '含部门信息');
      // 合同(项目)编号及名称：仅科研类填写，师资培训类必须留空
      const ctr = Array.from(fp.querySelectorAll('tr')).find(r => r.textContent.includes('合同(项目)编号及名称'));
      const ccell = ctr ? ctr.querySelectorAll('td')[1].textContent.trim() : 'NO_ROW';
      need(ctr && ccell === '', '非科研项目「合同(项目)编号及名称」留空，实际 ' + JSON.stringify(ccell));
    }
    const expBtns = Array.from(document.querySelectorAll('#stepBox .btn')).map(b=>b.textContent.trim()).filter(t=>t.includes('导出'));
    L('导出按钮: ' + JSON.stringify(expBtns));
    need(expBtns.length >= 2, '导出按钮 ≥2 个（docx + xlsx）');

    L('== 8. 设置页 ==');
    App.switchView('settings');
    await wait(500);
    need(document.getElementById('set_meal_teacher').value === '100', '设置页餐费默认 100');
    need(document.getElementById('set_city_teacher').value === '80', '设置页市交默认 80');
    need(document.getElementById('set_student_ratio').value === '0.5', '设置页学生系数 0.5');
    need(/试算预览/.test(document.getElementById('stdPreview').textContent), '设置页试算预览存在');
    document.getElementById('set_meal_teacher').value = '150';
    document.getElementById('set_meal_teacher').dispatchEvent(new Event('input'));
    await wait(250);
    const sp = flat(document.getElementById('stdPreview').textContent);
    need(/教师：餐费 ¥600/.test(sp), '改餐费150后4天=600试算正确：' + sp);
    document.getElementById('btnSaveSettings').click();
    await wait(700);
    const s2 = await (await fetch('/api/settings')).json();
    need(s2.data.settings.meal_teacher === 150, '餐费已保存为 150');
    // 复原
    await Api.put('/api/settings', {meal_teacher:100});

    L('== 8.5 项目分类 / 费用科目（设置页维护）==');
    const catBoxTxt = flat(document.getElementById('catList').textContent);
    need(['办公用品','耗材采购','设备采购','维修维保'].every(x => catBoxTxt.indexOf(x) >= 0),
      '设置页列出新增项目分类：' + catBoxTxt.slice(0,140));
    const bkBoxTxt = flat(document.getElementById('bucketList').textContent);
    need(['耗材费','办公用品费用','打印费','维修维保费用','论文版面费','专利服务费','技术服务费','项目外协费'].every(x => bkBoxTxt.indexOf(x) >= 0),
      '设置页列出新增费用科目：' + bkBoxTxt.slice(0,240));
    // 新增自定义科目 -> 列表立即出现 -> 再删除（不留测试痕）
    document.getElementById('nb_label').value = 'UI烟测临时科目';
    document.getElementById('btnAddBucket').click();
    await wait(900);
    const bk2 = flat(document.getElementById('bucketList').textContent);
    need(bk2.indexOf('UI烟测临时科目') >= 0, '新增自定义科目后列表立即出现：' + bk2.slice(-60));
    const tmpB = App.state.buckets.find(b => b.label === 'UI烟测临时科目');
    need(!!(tmpB && tmpB.custom), '自定义项带 custom 标记（内置项不可删）');
    if (tmpB) { await Api.del('/api/dict/buckets/' + tmpB.key); await App.reloadDict(); await wait(500); }
    const bk3 = flat(document.getElementById('bucketList').textContent);
    need(bk3.indexOf('UI烟测临时科目') < 0, '删除自定义科目后列表已移除');
    // 新建项目弹窗的分类下拉应含新分类
    document.getElementById('btnNewProject').click();
    await wait(500);
    const catOpts = Array.from(document.getElementById('pf_category').options).map(o => o.textContent);
    need(['办公用品','耗材采购','设备采购','维修维保'].every(x => catOpts.indexOf(x) >= 0),
      '新建项目分类下拉含新分类：' + catOpts.join('/'));
    const closeX = document.querySelector('#modalBox [data-close]');
    if (closeX) closeX.click();
    await wait(300);

    L('== 9. 字典页 ==');
    App.switchView('dictionary');
    await wait(500);
    need(document.querySelectorAll('#periodTable tbody tr').length >= 3, '期间列表渲染');
    need(document.querySelectorAll('#collegeTable tbody tr').length >= 4, '学院列表渲染');

    L('== 9.5 使用引导页 ==');
    App.switchView('guide');
    await wait(600);
    need(document.querySelector('#view-guide').classList.contains('active'), '引导视图已激活');
    need(document.querySelectorAll('.guide-chip').length === 6, '流程图 6 步，实际 ' + document.querySelectorAll('.guide-chip').length);
    need(document.querySelectorAll('.guide-step').length === 6, '步骤卡片 6 张，实际 ' + document.querySelectorAll('.guide-step').length);
    need(document.querySelectorAll('details.g-faq').length === 5, '常见问题 5 条，实际 ' + document.querySelectorAll('details.g-faq').length);
    const gTxt = flat(document.querySelector('#guideBox').textContent);
    need(/六步走完一笔报销/.test(gTxt), '引导页标题正确');
    need(/每日餐费 . 出差天数/.test(gTxt), '含伙食补助计算式');
    need(/只有点「通过」的票据才计入金额/.test(gTxt), '含票据审核提示');
    need(document.querySelectorAll('.guide-step .gs-btns').length === 6, '每步都有操作按钮组');
    // 「演示此步」应只演示该步：点第 3 步 -> 向导显示第 3 步
    document.querySelectorAll('.guide-step')[2].querySelector('.gs-btns .btn:not(.btn-primary)').click();
    await waitStep(3);
    need(!!document.querySelector('#tourMask.show'), '「演示此步」启动了分步向导');
    need(flat(document.querySelector('.tc-step').textContent).indexOf('第 3 / 6 步') >= 0, '演示的是第 3 步，实际=' + flat(document.querySelector('.tc-step').textContent));
    document.querySelector('#tourCard .tc-close').click();
    await wait(400);
    need(!document.querySelector('#tourMask').classList.contains('show'), '向导可手动关闭');
    App.switchView('guide');
    await wait(400);
    // 流程图第 1 步应跳到基础设置
    document.querySelectorAll('.guide-chip')[0].click();
    await wait(600);
    need(document.querySelector('#view-settings').classList.contains('active'), '点流程图第1步跳到基础设置');
    // 顶栏引导按钮
    App.switchView('dashboard');
    await wait(300);
    document.getElementById('btnGuide').click();
    await wait(500);
    need(document.querySelector('#view-guide').classList.contains('active'), '顶栏「使用引导」按钮可打开引导页');

    L('== 10. XSS 转义检查 ==');
    App.switchView('projects');
    await wait(400);
    document.getElementById('projSearch').value = '<img src=x onerror=alert(1)>';
    document.getElementById('projSearch').dispatchEvent(new Event('input'));
    await wait(500);
    const rawImgs = document.querySelectorAll('#projectCards img').length;
    need(rawImgs === 0, '搜索 XSS 载荷未被注入为 img（实际 img 数=' + rawImgs + '）');
    document.getElementById('projSearch').value = '';
    document.getElementById('projSearch').dispatchEvent(new Event('input'));
    await wait(300);

    L('== 11. 清理 ==');
    await App.deleteProject(pid);
    await wait(600);
    document.querySelector('#modalBox .modal-foot .btn:last-child').click();
    await wait(900);
    const projAfter = App.state.projects.find(p=>p.id===pid);
    need(!projAfter, '烟测项目已清理');
    const left = App.state.projects.filter(p=>/^(UI烟测|冒烟测试|测试)/.test(p.name||''));
    need(left.length === 0, '系统内无测试项目残留，实际 ' + left.map(p=>p.name).join(','));
  }catch(e){
    window.__errs.push('THROW: ' + (e && e.stack || e));
  }

  const out = document.createElement('pre');
  out.id = '__diag';
  out.textContent = JSON.stringify({ log: window.__log, errs: window.__errs }, null, 1);
  document.body.appendChild(out);
}
setTimeout(run, 900);
`;

function main() {
  const chrome = findChrome();
  if (!chrome) { console.error('未找到 Chrome/Edge，无法执行 UI 烟测'); process.exit(2); }
  console.log('浏览器:', chrome);

  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const diagHtml = html.replace('</body>', '<script src="/__diag.js"></script></body>');
  fs.writeFileSync(path.join(PUBLIC, '__diag.html'), diagHtml);
  fs.writeFileSync(path.join(PUBLIC, '__diag.js'), DIAG_SCRIPT);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-chrome-'));
  const outFile = path.join(os.tmpdir(), 'wb-diag-dom.html');
  const args = [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    `--user-data-dir=${profile}`,
    '--virtual-time-budget=30000',
    `--dump-dom`,
    URL_ + '__diag.html',
  ];
  console.log('执行中（约 30s 虚拟时间预算）…');
  let stdout = '';
  try {
    stdout = execFileSync(chrome, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    stdout = (e.stdout || '') + '';
    console.error('Chrome 返回异常:', e.message);
  }

  fs.unlinkSync(path.join(PUBLIC, '__diag.html'));
  fs.unlinkSync(path.join(PUBLIC, '__diag.js'));

  const m = stdout.match(/<pre id="__diag">([\s\S]*?)<\/pre>/);
  if (!m) {
    console.error('未能读取诊断结果，DOM 输出前 800 字符：\n', stdout.slice(0, 800));
    process.exit(2);
  }
  const diag = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));

  console.log('\n================ UI 烟测明细 ================');
  for (const line of diag.log) console.log('  ' + line);
  console.log('\n================ JS 错误 ================');
  if (diag.errs.length) { for (const e of diag.errs) console.log('  ✗ ' + e); }
  else console.log('  （无）');

  const fails = diag.log.filter((l) => l.startsWith('FAIL')).length + diag.errs.length;
  console.log(`\n=== UI 烟测：${fails === 0 ? 'ALL PASS' : 'FAIL ' + fails} ===\n`);
  process.exit(fails === 0 ? 0 : 1);
}

main();