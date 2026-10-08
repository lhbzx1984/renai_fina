'use strict';
/** 天津仁爱学院报销系统 - 主应用逻辑 */

const App = {
  state: {
    view: 'dashboard',
    settings: {},
    categories: [],
    buckets: [],
    periods: [],
    colleges: [],
    majors: [],
    projects: [],
    currentId: null,
    detail: null,
  },

  /* ==================== 启动 ==================== */
  async init() {
    this.bindNav();
    this.bindGlobal();
    try {
      const s = await Api.get('/api/settings');
      this.state.settings = s.settings;
      this.state.categories = s.categories;
      this.state.buckets = s.buckets;
      await this.loadDictionary();
      await this.loadDashboard();
      await this.loadProjects();
      this.renderCategoryFilter();
      this.renderSettings();
      this.maybeShowTour();
    } catch (e) {
      toast('初始化失败：' + e.message, 'err');
    }
    console.log('[报销系统] 初始化完成');
  },

  bindNav() {
    $$('.nav-item').forEach((el) => {
      el.onclick = () => this.switchView(el.dataset.view);
    });
  },

  bindGlobal() {
    $('#btnRefresh').onclick = () => this.refreshCurrent();
    $('#btnGuide').onclick = () => this.switchView('guide');
    $('#btnSaveSettings').onclick = () => this.saveSettings();
    $('#btnSaveSettings2').onclick = () => this.saveSettings();
    $('#btnTestMail').onclick = () => this.testMail();
    $('#btnNewProject').onclick = () => this.openProjectForm();
    $('#btnAddPeriod').onclick = () => this.addPeriod();
    $('#btnAddCollege').onclick = () => this.addCollege();
    $('#btnAddMajor').onclick = () => this.addMajor();
    $('#btnAddCategory').onclick = () => this.addDictItem('categories');
    $('#btnAddBucket').onclick = () => this.addDictItem('buckets');

    let t = null;
    $('#projSearch').oninput = () => { clearTimeout(t); t = setTimeout(() => this.renderProjectCards(), 220); };
    $('#projCatFilter').onchange = () => this.renderProjectCards();

    // 回车提交弹窗内第一个输入框
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        $('#modalMask').classList.remove('show');
        $('#modalMask').classList.remove('show');
        $('#lightbox').classList.remove('show');
      }
    });
  },

  async loadDictionary() {
    const d = await Api.get('/api/colleges');
    this.state.colleges = d.colleges;
    this.state.majors = d.majors;
    const p = await Api.get('/api/periods');
    this.state.periods = p.periods;
  },

  switchView(v) {
    this.state.view = v;
    $$('.nav-item').forEach((el) => el.classList.toggle('active', el.dataset.view === v));
    $$('.view').forEach((el) => el.classList.toggle('active', el.id === 'view-' + v));
    const titles = {
      dashboard: ['工作台', '报销全局概览'],
      projects: ['报销项目', '科研 / 教学 / 教改 / 师资培训 / 竞赛'],
      detail: ['项目详情', ''],
      receipts: ['票据中心', 'OCR 识别 · 人工审核 · 批量导入'],
      settings: ['基础设置', '差旅补助标准与单位信息'],
      dictionary: ['字典维护', '学期 · 学院 · 专业'],
      guide: ['使用引导', '六步走完一笔报销 · 首次使用必读'],
    };
    const t = titles[v] || ['', ''];
    $('#pageTitle').textContent = t[0];
    $('#pageSub').textContent = t[1];
    this.refreshCurrent();
  },

  async refreshCurrent() {
    const v = this.state.view;
    try {
      if (v === 'dashboard') await this.loadDashboard();
      else if (v === 'projects') await this.loadProjects();
      else if (v === 'detail' && this.state.currentId) await this.loadDetail(this.state.currentId);
      else if (v === 'receipts') await this.loadReceiptCenter();
      else if (v === 'dictionary') this.renderDictionary();
      else if (v === 'settings') { const s = await Api.get('/api/settings'); this.state.settings = s.settings; this.state.scope = s.scope || {}; this.renderSettings(); }
      else if (v === 'guide') this.renderGuide();
    } catch (e) { toast(e.message, 'err'); }
  },

  /* ==================== 使用引导 ==================== */
  /** 六步流程定义：key 同时用于「去操作」跳转定位 */
  guideSteps() {
    return [
      {
        n: '1', key: 'settings', title: '校准补助标准',
        desc: '先把餐费、市内交通的每日标准和学生系数确认好，后面所有金额都按它算。',
        tips: ['教师每日餐费 / 每日市内交通补助', '学生补助系数（0.5 表示减半）', '单位名称与收款账户（写入资金申请单）'],
        act: '去设置',
      },
      {
        n: '2', key: 'new', title: '新建报销项目',
        desc: '一个项目就是一次报销事件：一次出差、一场竞赛或一项课题，各走各的账。',
        tips: ['分类：科研 / 教学 / 教改 / 师资培训 / 竞赛', '填名称、负责人、所属学院、预算金额', '勾选「含差旅」才会出现行程与补助'],
        act: '新建项目',
      },
      {
        n: '3', key: 'members', title: '添加教师与学生',
        desc: '每个人单独计补助，学生自动按系数减半，无需手算。',
        tips: ['身份选教师或学生', '填姓名、职称/专业、出差天数', '出差天数留空默认跟随行程'],
        act: '去加成员',
      },
      {
        n: '4', key: 'trip', title: '录入差旅行程',
        desc: '填往返日期与出发/到达城市，出差天数自动算（含首尾两天）。',
        tips: ['天数 = 结束日期 − 开始日期 + 1', '票据上传后可用「按票据自动填充」', '每人行程不同可加多行并绑定人员'],
        act: '去录行程',
      },
      {
        n: '5', key: 'receipts', title: '上传票据并审核',
        desc: 'PDF / 图片上传后自动识别；只有点「通过」的票据才计入金额。',
        tips: ['支持拖拽上传，可一次多张', '识别有误直接改字段再保存', '也可用 CSV 模板批量导入'],
        act: '去审票据',
      },
      {
        n: '6', key: 'report', title: '核对并导出报表',
        desc: '核对费用明细无误后一键导出两份正式表格，直接打印签字。',
        tips: ['差旅费报销明细表（.docx）', '资金申请单（.xlsx，官方版式）', '文件同时存到项目 exports/ 目录'],
        act: '去导出',
      },
    ];
  },

  renderGuide() {
    const s = this.state.settings || {};
    const meal = Number(s.meal_teacher) || 0;
    const city = Number(s.city_teacher) || 0;
    const ratio = Number(s.student_ratio) || 0;
    const days = 4;
    const tMeal = meal * days, tCity = city * days;
    const sMeal = tMeal * ratio, sCity = tCity * ratio;
    const steps = this.guideSteps();
    const box = $('#guideBox');
    if (!box) return;

    box.innerHTML = `
      <div class="guide-hero">
        <div class="gh-left">
          <div class="gh-tag">首次使用必读</div>
          <h3>六步走完一笔报销</h3>
          <p>点「启动分步引导」，系统会一步步高亮界面上的对应位置，跟着点「下一步」走完即会。</p>
          <div class="gh-btns">
            <button class="btn btn-gold" id="btnStartTour" onclick="App.startTour(0)">▶ 启动分步引导（6 步）</button>
            <button class="btn" onclick="App.guideGo('new')">立即新建项目</button>
          </div>
        </div>
        <div class="gh-right">
          <div class="gh-num">${this.state.projects.length}<small>个在办项目</small></div>
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card-head"><h3>流程图</h3><span class="spacer"></span><span class="hint">点击任意一步可直接跳转</span></div>
        <div class="card-body">
          <div class="guide-flow">
            ${steps.map((st, i) => `
              <div class="guide-chip guide-fade" style="animation-delay:${i * 60}ms" onclick="App.guideGo('${st.key}')" title="${esc(st.desc)}">
                <span class="n">${st.n}</span>${esc(st.title)}
              </div>
              ${i < steps.length - 1 ? '<span class="guide-arrow">›</span>' : ''}`).join('')}
          </div>
        </div>
      </div>

      <div class="grid grid-2" style="margin-top:16px">
            ${steps.map((st, i) => `
          <div class="guide-step guide-fade" style="animation-delay:${i * 60}ms" data-guide-step="${i}">
            <div class="gs-head">
              <span class="n">${st.n}</span>
              <h4>${esc(st.title)}</h4>
            </div>
            <p class="desc">${esc(st.desc)}</p>
            <ul>${st.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
            <div class="gs-btns">
              <button class="btn btn-primary btn-sm" onclick="App.guideGo('${st.key}')">${esc(st.act)} →</button>
              <button class="btn btn-sm" onclick="App.startTour(${i})" title="在界面上高亮这一步的位置">▶ 演示此步</button>
            </div>
          </div>`).join('')}
      </div>

      <div class="grid grid-2" style="margin-top:16px">
        <div class="card">
          <div class="card-head"><h3>金额怎么算</h3></div>
          <div class="card-body">
            <div class="table-wrap"><table class="tb">
              <thead><tr><th style="width:32%">项目</th><th>计算方式</th></tr></thead>
              <tbody>
                <tr><td>出差天数</td><td>结束日期 − 开始日期 <b>+ 1</b>（含首尾）</td></tr>
                <tr><td>伙食补助费</td><td>每日餐费 × 出差天数</td></tr>
                <tr><td>市内交通费</td><td>有票据按票据实报，否则 每日补助 × 天数</td></tr>
                <tr><td>城市间交通费</td><td>各段票价 × 张数，逐段累加</td></tr>
                <tr><td>住宿费 / 其他</td><td>审核通过票据金额合计</td></tr>
                <tr><td>学生补助</td><td>教师标准 × 系数（当前 ${ratio}）</td></tr>
              </tbody>
            </table></div>
            <div class="guide-note">
              示例：按当前标准出差 <b>${days}</b> 天 ——
              教师 餐补 ¥${money0(tMeal)} + 市交 ¥${money0(tCity)} = <b>¥${money0(tMeal + tCity)}</b>；
              学生 餐补 ¥${money0(sMeal)} + 市交 ¥${money0(sCity)} = <b>¥${money0(sMeal + sCity)}</b>。
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>常见问题</h3></div>
          <div class="card-body">
            <details class="g-faq" open>
              <summary>为什么票据上传了，金额却是 0？</summary>
              <p>票据识别后状态是「待审核」，必须逐张点「通过」才会计入金额。这是刻意设计的：OCR 可能认错，留一道人工确认。</p>
            </details>
            <details class="g-faq">
              <summary>补助按几个人算？</summary>
              <p>按「教师与学生」列表逐人计算再汇总。同一人只加一次，学生按系数自动减半。</p>
            </details>
            <details class="g-faq">
              <summary>市内交通到底是按票据还是按标准？</summary>
              <p>有市内交通票据就按票据实报；没有票据时，才按「每日市内交通补助 × 天数」发放。</p>
            </details>
            <details class="g-faq">
              <summary>导出的两份表有什么区别？</summary>
              <p><b>.docx 差旅费报销明细表</b>逐项列明每人每类费用；<b>.xlsx 资金申请单</b>是财务请款用的官方版式，含金额大写与签字栏。</p>
            </details>
            <details class="g-faq">
              <summary>页面空白 / 数据加载不出来？</summary>
              <p>不要双击 <code>index.html</code> 打开。请运行项目根目录的 <code>启动报销系统.bat</code> 或 <code>npm start</code>，再访问 <code>http://127.0.0.1:5180</code>。</p>
            </details>
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card-head"><h3>还有一份完整文档</h3></div>
        <div class="card-body">
          <p style="font-size:12.8px;color:var(--ink-2);line-height:1.8">
            项目 <code>docs/使用说明.html</code> 是带截图的完整手册（12 章，可一键打印成 PDF），<code>docs/使用说明.md</code> 是同源 Markdown 版。
            需要发给同事或归档时直接用 HTML 版。
          </p>
        </div>
      </div>`;
  },

  /** 引导页「去操作」：无项目时先引导创建，有项目则直达对应步骤 */
  async guideGo(key) {
    if (key === 'settings') { this.switchView('settings'); return; }
    if (key === 'new') { this.switchView('projects'); this.openProjectForm(); return; }
    const id = this.state.currentId || (this.state.projects[0] && this.state.projects[0].id);
    if (!id) {
      toast('还没有报销项目，先建一个吧', 'warn');
      this.switchView('projects');
      this.openProjectForm();
      return;
    }
    try {
      await this.openProject(id, key);
    } catch (e) { toast(e.message, 'err'); }
  },

  /** 首次进入自动启动分步向导（本地记住，不再反复打扰） */
  maybeShowTour() {
    let seen = '';
    try { seen = localStorage.getItem('renai_guide_seen') || ''; } catch (e) { /* 隐私模式下忽略 */ }
    if (seen === '1') return;
    try { localStorage.setItem('renai_guide_seen', '1'); } catch (e) { /* 忽略 */ }
    this.startTour(0);
  },

  /* ==================== 分步向导（一次一步，逐高亮） ==================== */
  /** 每一步：进入哪个视图、高亮哪个元素、对应的「去操作」目标 */
  tourSteps() {
    return [
      {
        title: '校准补助标准', view: 'settings', target: '#set_meal_teacher', actKey: 'settings', actLabel: '去改标准',
        desc: '先把教师每日餐费、市内交通补助和学生系数确认好，后面所有金额都按它算。',
        tips: ['改完记得点「保存设置」', '单位名称与收款账户会写进资金申请单'],
      },
      {
        title: '新建报销项目', view: 'projects', target: '#btnNewProject', actKey: 'new', actLabel: '新建项目',
        desc: '一个项目就是一次报销事件：一次出差、一场竞赛或一项课题，各走各的账。',
        tips: ['选分类、填名称与负责人', '勾选「含差旅」才会出现行程与补助'],
      },
      {
        title: '添加教师与学生', view: 'detail', step: 'members', target: '[data-step="members"]', actKey: 'members', actLabel: '去加成员',
        desc: '每个人单独计补助，学生自动按系数减半，无需手算。',
        tips: ['身份选教师或学生', '天数留空默认跟随行程'],
      },
      {
        title: '录入差旅行程', view: 'detail', step: 'trip', target: '[data-step="trip"]', actKey: 'trip', actLabel: '去录行程',
        desc: '填往返日期与出发/到达城市，出差天数自动算（含首尾两天）。',
        tips: ['天数 = 结束日期 − 开始日期 + 1', '传完票据可用「按票据自动填充」', '每人行程不同可加多行并绑定人员'],
      },
      {
        title: '上传票据并审核', view: 'detail', step: 'receipts', target: '[data-step="receipts"]', actKey: 'receipts', actLabel: '去审票据',
        desc: 'PDF / 图片上传后自动识别；只有点「通过」的票据才计入金额。',
        tips: ['支持拖拽上传，可一次多张', '也可用 CSV 模板批量导入'],
      },
      {
        title: '核对并导出报表', view: 'detail', step: 'report', target: '[data-step="report"]', actKey: 'report', actLabel: '去导出',
        desc: '核对费用明细无误后一键导出两份正式表格，直接打印签字。',
        tips: ['差旅费报销明细表（.docx）', '资金申请单（.xlsx，官方版式）'],
      },
    ];
  },

  /** 启动向导。idx 指定从第几步开始（0 基） */
  async startTour(idx) {
    this.state.tourIndex = Math.max(0, Number(idx) || 0);
    this.state.tourOpen = true;
    if (!this._tourBound) {
      this._tourRepos = () => this.positionTour();
      window.addEventListener('resize', this._tourRepos);
      window.addEventListener('scroll', this._tourRepos, true);
      document.addEventListener('keydown', (e) => {
        if (!this.state.tourOpen) return;
        if (e.key === 'Escape') this.endTour();
        else if (e.key === 'ArrowRight') this.tourGo(1);
        else if (e.key === 'ArrowLeft') this.tourGo(-1);
      });
      this._tourBound = true;
    }
    await this.renderTourStep();
  },

  /** 渲染当前步：先切到对应界面，再高亮目标元素 */
  async renderTourStep() {
    const steps = this.tourSteps();
    let i = this.state.tourIndex;
    if (i < 0) i = this.state.tourIndex = 0;
    if (i >= steps.length) { this.endTour(true); return; }
    const st = Object.assign({}, steps[i]);
    await this.prepareTourStep(st);
    // 让切换后的界面完成一次布局再量尺寸（用 setTimeout 而非 rAF：
    // 无头浏览器/虚拟时间下 rAF 可能不触发，会让向导卡住不渲染）
    await new Promise((r) => setTimeout(r, 40));
    this.state.tourStep = st;
    this.state.tourIndex = i;
    this.buildTourCard(st, i, steps.length);
    this.positionTour(true);
  },

  /** 进入该步所需的界面；没有项目时降级到「新建项目」按钮 */
  async prepareTourStep(st) {
    st._target = st.target;
    st._noProject = false;
    if (st.view === 'detail') {
      const id = this.state.currentId || (this.state.projects[0] && this.state.projects[0].id);
      if (!id) {
        st._noProject = true;
        st._target = '#btnNewProject';
        this.switchView('projects');
        return;
      }
      try {
        await this.openProject(id, st.step);
      } catch (e) {
        st._noProject = true;
        st._target = '#btnNewProject';
        this.switchView('projects');
      }
      return;
    }
    this.switchView(st.view);
  },

  buildTourCard(st, i, total) {
    let mask = $('#tourMask');
    if (!mask) {
      document.body.insertAdjacentHTML('beforeend',
        '<div class="tour-mask" id="tourMask">' +
        '<div class="tour-spot" id="tourSpot"></div>' +
        '<div class="tour-card" id="tourCard"></div></div>');
      mask = $('#tourMask');
    }
    mask.classList.add('show');
    const card = $('#tourCard');
    card.innerHTML = `
      <div class="tc-head">
        <span class="tc-step">第 ${i + 1} / ${total} 步</span>
        <button class="tc-close" onclick="App.endTour()" title="结束引导（Esc）">×</button>
      </div>
      <div class="tc-dots">
        ${this.tourSteps().map((_, k) => `<span class="tc-dot ${k === i ? 'on' : (k < i ? 'done' : '')}" onclick="App.tourJump(${k})" title="跳到第 ${k + 1} 步"></span>`).join('')}
      </div>
      <h4>${esc(st.title)}</h4>
      <p class="tc-desc">${esc(st._noProject ? '还没有报销项目，先从这里建一个，建好后回来继续走后面的步骤。' : st.desc)}</p>
      <ul class="tc-tips">${(st._noProject ? ['点「+ 新建项目」，填名称与负责人', '勾选「含差旅」才有行程与补助'] : st.tips).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
      <button class="btn btn-gold btn-sm btn-block tc-act" onclick="App.tourAct()">${esc(st._noProject ? '去新建项目' : st.actLabel + ' →')}</button>
      <div class="tc-foot">
        <button class="btn btn-sm" onclick="App.tourGo(-1)" ${i === 0 ? 'disabled' : ''}>← 上一步</button>
        <span class="spacer"></span>
        <button class="btn btn-sm btn-primary tc-next" onclick="App.tourGo(1)">${i === total - 1 ? '完成 ✓' : '下一步 →'}</button>
      </div>`;
  },

  /** 高亮框 + 卡片定位；滚动/窗口变化时重算 */
  positionTour(center) {
    const st = this.state.tourStep;
    if (!st || !this.state.tourOpen) return;
    const spot = $('#tourSpot'), card = $('#tourCard');
    if (!spot || !card) return;
    const el = document.querySelector(st._target || st.target);
    if (!el) { spot.style.display = 'none'; card.style.top = '90px'; card.style.left = ''; card.style.right = '24px'; return; }

    // 只在切换步骤时滚动，避免 scroll 事件里再滚动造成抖动
    if (center) el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    const pad = 6;
    spot.style.display = '';
    spot.style.top = (r.top - pad) + 'px';
    spot.style.left = (r.left - pad) + 'px';
    spot.style.width = (r.width + pad * 2) + 'px';
    spot.style.height = (r.height + pad * 2) + 'px';

    const cw = card.offsetWidth || 372;
    const ch = card.offsetHeight || 250;
    let top = r.bottom + 14;
    if (top + ch > window.innerHeight - 12) top = Math.max(12, r.top - ch - 14);
    let left = r.left + r.width / 2 - cw / 2;
    left = Math.min(Math.max(12, left), Math.max(12, window.innerWidth - cw - 12));
    card.style.top = top + 'px';
    card.style.left = left + 'px';
    card.style.right = '';
  },

  /** 上一步 / 下一步；走到末尾自动结束 */
  async tourGo(delta) {
    if (!this.state.tourOpen) return;
    const next = this.state.tourIndex + delta;
    if (next < 0) return;
    this.state.tourIndex = next;
    await this.renderTourStep();
  },

  async tourJump(i) {
    if (!this.state.tourOpen) return;
    this.state.tourIndex = i;
    await this.renderTourStep();
  },

  /** 卡片上的「去操作」：结束向导并跳到对应功能 */
  tourAct() {
    const st = this.state.tourStep;
    this.endTour();
    if (!st) return;
    this.guideGo(st._noProject ? 'new' : st.actKey);
  },

  endTour(finished) {
    this.state.tourOpen = false;
    const mask = $('#tourMask');
    if (mask) mask.classList.remove('show');
    if (finished) toast('引导走完了，可以开始报销了', 'ok');
  },

  /* ==================== 工作台 ==================== */
  async loadDashboard() {
    const d = await Api.get('/api/dashboard');
    this.state.settings = d.settings;
    const s = d.stat;

    $('#statCards').innerHTML = `
      <div class="stat"><div class="label">报销项目</div><div class="value">${s.projects}<small>个</small></div><div class="foot">其中草稿 ${s.draft} 个</div></div>
      <div class="stat green"><div class="label">项目成员</div><div class="value">${s.members}<small>人</small></div><div class="foot">教师与学生合计</div></div>
      <div class="stat gold"><div class="label">票据总数</div><div class="value">${s.receipts}<small>张</small></div><div class="foot">已审核通过金额</div></div>
      <div class="stat red"><div class="label">待审核票据</div><div class="value">${s.pending}<small>张</small></div><div class="foot">${s.pending ? '需尽快处理' : '已全部处理'}</div></div>
      <div class="stat green"><div class="label">已审核金额</div><div class="value" style="font-size:21px">¥ ${money0(s.amount)}</div><div class="foot">累计报销金额</div></div>`;

    // 待审核徽标
    for (const id of ['#navPending', '#navPending2']) {
      const el = $(id);
      el.style.display = s.pending > 0 ? '' : 'none';
      el.textContent = s.pending;
    }

    const max = Math.max(1, ...d.by_category.map((c) => c.n));
    $('#catChart').innerHTML = d.by_category.length
      ? d.by_category.map((c) => `
        <div style="margin-bottom:13px">
          <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:5px">
            <span>${catTag(c.category)}</span>
            <span style="color:var(--ink-3)">${c.n} 个 · 预算 ¥${money0(c.b)}</span>
          </div>
          <div style="height:7px;background:#eef1f4;border-radius:4px;overflow:hidden">
            <div style="height:100%;width:${(c.n / max * 100).toFixed(1)}%;background:linear-gradient(90deg,var(--brand-2),var(--brand));border-radius:4px"></div>
          </div>
        </div>`).join('')
      : emptyState('◷', '暂无项目数据');

    $('#recentList').innerHTML = d.recent.length
      ? d.recent.map((p) => `
        <div style="padding:12px 18px;border-bottom:1px solid #f0f3f6;cursor:pointer" onclick="App.openProject(${p.id})">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            <span style="font-size:13.5px;font-weight:600;flex:1">${esc(p.name)}</span>
            ${catTag(p.category)}
          </div>
          <div style="font-size:11.5px;color:var(--ink-3)">${esc(p.code)} · ${esc(p.college_name || '未指定学院')} · ${p.member_count} 人${p.has_travel ? ' · 含差旅' : ''}</div>
        </div>`).join('')
      : emptyState('▤', '还没有报销项目', '点击「新建项目」开始');
  },

  /* ==================== 项目 ==================== */
  async loadProjects() {
    const d = await Api.get('/api/projects');
    this.state.projects = d.projects;
    this.renderProjectCards();
  },

  renderProjectCards() {
    const q = ($('#projSearch').value || '').toLowerCase();
    const cat = $('#projCatFilter').value;
    let list = this.state.projects;
    if (cat) list = list.filter((p) => p.category === cat);
    if (q) list = list.filter((p) => [p.name, p.code, p.reason, p.leader].some((v) => String(v || '').toLowerCase().includes(q)));

    $('#projectCards').innerHTML = list.length ? list.map((p) => `
      <div class="pcard" onclick="App.openProject(${p.id})">
        <div class="top">
          <div class="title">${esc(p.name)}</div>
          ${catTag(p.category)}
        </div>
        <div class="meta">
          <span>📄 ${esc(p.code)}</span>
          <span>🏛 ${esc(p.college_name || '—')}</span>
          ${p.major_name ? `<span>🎓 ${esc(p.major_name)}</span>` : ''}
        </div>
        <div class="meta">
          <span>👥 ${p.member_count} 人</span>
          <span>🧾 ${p.receipt_count} 张票据</span>
          ${p.period_name ? `<span>📅 ${esc(p.period_name)}</span>` : ''}
        </div>
        <div class="foot">
          ${p.has_travel ? '<span class="travel-flag">✈ 含差旅</span>' : '<span class="tag gray">非差旅</span>'}
          ${p.pending_count > 0 ? `<span class="tag red">${p.pending_count} 待审核</span>` : ''}
          <span class="spacer"></span>
          <span style="font-size:11px;color:var(--ink-3)">已审金额</span>
          <span class="amount">¥ ${money0(p.approved_amount)}</span>
        </div>
      </div>`).join('')
      : emptyState('▤', q || cat ? '没有匹配的项目' : '还没有报销项目', '点击右上角「+ 新建项目」创建');
  },

  openProjectForm(id) {
    const p = id ? this.state.projects.find((x) => x.id === Number(id)) : null;
    const catOpts = this.state.categories.map((c) =>
      `<option value="${c.key}" ${p && p.category === c.key ? 'selected' : ''}>${esc(c.label)}</option>`).join('');
    const periodOpts = '<option value="">未指定</option>' + this.state.periods.map((x) =>
      `<option value="${x.id}" ${p && p.period_id === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
    const collegeOpts = '<option value="">未指定</option>' + this.state.colleges.map((x) =>
      `<option value="${x.id}" ${p && p.college_id === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('');

    modal(p ? '编辑项目' : '新建报销项目', `
      <div class="grid grid-2">
        <div class="field" style="grid-column:1/-1">
          <label>项目名称<span class="req">*</span></label>
          <input class="input" id="pf_name" value="${esc(p ? p.name : '')}" placeholder="如：2026年暑期师资培训（合肥）">
        </div>
        <div class="field">
          <label>项目编号</label>
          <input class="input" id="pf_code" value="${esc(p ? p.code : '')}" placeholder="留空自动生成">
        </div>
        <div class="field">
          <label>项目分类<span class="req">*</span></label>
          <select class="select" id="pf_category">${catOpts}</select>
        </div>
        <div class="field"><label>所属期间</label><select class="select" id="pf_period">${periodOpts}</select></div>
        <div class="field"><label>学院</label><select class="select" id="pf_college">${collegeOpts}</select></div>
        <div class="field"><label>专业</label><select class="select" id="pf_major"><option value="">未指定</option></select></div>
        <div class="field"><label>项目负责人</label><input class="input" id="pf_leader" value="${esc(p ? p.leader || '' : '')}"></div>
        <div class="field"><label>预算金额（元）</label><input class="input" type="number" id="pf_budget" value="${p ? p.budget : 0}" min="0" step="0.01"></div>
        <div class="field" style="grid-column:1/-1">
          <label>支付事由</label>
          <textarea class="textarea" id="pf_reason" placeholder="将写入资金申请单的「支付事由」">${esc(p ? p.reason || '' : '')}</textarea>
        </div>
        <div class="field" style="grid-column:1/-1">
          <label class="check">
            <input type="checkbox" id="pf_travel" ${p && p.has_travel ? 'checked' : ''}>
            <span>本项目包含差旅（生成差旅费报销明细表）</span>
          </label>
          <div class="hint">含差旅需填写出差事由、时间与起讫地点；不勾选则只生成资金申请单</div>
        </div>
      </div>`, {
      size: 'wide',
      buttons: [
        { label: '取消', cls: 'btn' },
        {
          label: p ? '保存修改' : '创建项目', cls: 'btn btn-primary', onClick: async (close) => {
            const body = {
              name: $('#pf_name').value.trim(),
              code: $('#pf_code').value.trim(),
              category: $('#pf_category').value,
              period_id: $('#pf_period').value || null,
              college_id: $('#pf_college').value || null,
              major_id: $('#pf_major').value || null,
              leader: $('#pf_leader').value.trim(),
              budget: $('#pf_budget').value,
              reason: $('#pf_reason').value.trim(),
              has_travel: $('#pf_travel').checked ? 1 : 0,
            };
            if (!body.name) { toast('请填写项目名称', 'warn'); return false; }
            if (p) await Api.put('/api/projects/' + p.id, body);
            else await Api.post('/api/projects', body);
            toast(p ? '项目已更新' : '项目已创建', 'ok');
            close();
            await this.loadProjects();
            await this.loadDashboard();
          },
        },
      ],
    });

    // 学院联动专业
    const syncMajor = () => {
      const cid = $('#pf_college').value;
      const ms = this.state.majors.filter((m) => !cid || String(m.college_id) === String(cid));
      const cur = $('#pf_major').value;
      $('#pf_major').innerHTML = '<option value="">未指定</option>' +
        ms.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
      if (cur) $('#pf_major').value = cur;
    };
    $('#pf_college').onchange = syncMajor;
    syncMajor();
  },

  async openProject(id, keepStep) {
    this.state.currentId = Number(id);
    this.state.view = 'detail';
    $$('.nav-item').forEach((el) => el.classList.toggle('active', el.dataset.view === 'projects'));
    $$('.view').forEach((el) => el.classList.toggle('active', el.id === 'view-detail'));
    $('#pageTitle').textContent = '项目详情';
    $('#pageSub').textContent = '';
    $('#detailBox').innerHTML = '<div class="loading"><div class="spinner"></div>加载中…</div>';
    await this.loadDetail(id, keepStep);
  },

  async loadDetail(id, keepStep) {
    let d;
    try { d = await Api.get('/api/projects/' + id); }
    catch (e) { $('#detailBox').innerHTML = emptyState('⚠', e.message); return; }
    this.state.detail = d;
    const p = d.project, c = d.calc, cfg = this.state.settings;

    const step = (key, num, label, cnt) =>
      `<div class="step ${d.currentStep === key ? 'active' : ''}" data-step="${key}">
        <span class="num">${num}</span><span class="txt">${label}</span>${cnt != null ? `<span class="cnt">(${cnt})</span>` : ''}
      </div>`;

    $('#detailBox').innerHTML = `
      <div class="card">
        <div class="card-head">
          <h3>${esc(p.name)}</h3>
          ${catTag(p.category)}
          ${p.has_travel ? '<span class="travel-flag">✈ 含差旅</span>' : '<span class="tag gray">非差旅</span>'}
          ${p.pending_count > 0 ? `<span class="tag red">${p.pending_count} 张待审核</span>` : ''}
          <span class="spacer"></span>
          <button class="btn btn-sm" onclick="App.openProjectForm(${p.id})">编辑</button>
          <button class="btn btn-sm btn-danger" onclick="App.deleteProject(${p.id})">删除</button>
        </div>
        <div class="card-body">
          <div class="grid grid-5" style="margin-bottom:14px">
            <div><div style="font-size:11.5px;color:var(--ink-3)">项目编号</div><div style="font-weight:600">${esc(p.code)}</div></div>
            <div><div style="font-size:11.5px;color:var(--ink-3)">所属期间</div><div style="font-weight:600">${esc(p.period_name || '—')}</div></div>
            <div><div style="font-size:11.5px;color:var(--ink-3)">学院 / 专业</div><div style="font-weight:600">${esc(p.college_name || '—')}${p.major_name ? ' / ' + esc(p.major_name) : ''}</div></div>
            <div><div style="font-size:11.5px;color:var(--ink-3)">负责人</div><div style="font-weight:600">${esc(p.leader || '—')}</div></div>
            <div><div style="font-size:11.5px;color:var(--ink-3)">预算</div><div style="font-weight:600">¥ ${money0(p.budget)}</div></div>
          </div>
          ${p.reason ? `<div style="font-size:12.5px;color:var(--ink-2);padding:9px 12px;background:#f7f9fb;border-radius:8px"><b>支付事由：</b>${esc(p.reason)}</div>` : ''}
        </div>
      </div>

      <div class="steps">
        ${step('members', '1', '教师与学生', d.members.length)}
        ${step('trip', '2', '差旅行程', d.trips.length)}
        ${step('receipts', '3', '票据与审核', d.pending_receipts || undefined)}
        ${step('report', '4', '报表生成', null)}
      </div>

      <div id="stepBox"></div>`;

    $$('.step').forEach((el) => { el.onclick = () => { d.currentStep = el.dataset.step; this.renderStep(id, el.dataset.step); }; });
    // 默认停在第一个「还没填」的步骤：成员 → 行程 → 票据
    const initial = keepStep || (d.members.length
      ? (p.has_travel && !d.trips.length ? 'trip' : 'receipts')
      : 'members');
    d.currentStep = initial;
    this.renderStep(id, initial);
  },

  async renderStep(projectId, step) {
    const box = $('#stepBox');
    if (!box) return;
    box.innerHTML = '<div class="loading"><div class="spinner"></div>加载中…</div>';
    const d = this.state.detail;
    const p = d.project;
    $$('.step').forEach((el) => el.classList.toggle('active', el.dataset.step === step));

    try {
      if (step === 'trip') this.renderTripStep(p, d);
      else if (step === 'members') this.renderMemberStep(p, d);
      else if (step === 'receipts') this.renderReceiptStep(p, d);
      else if (step === 'report') this.renderReportStep(p, d);
    } catch (e) {
      box.innerHTML = emptyState('⚠', '加载失败：' + e.message);
    }
  },

  /* ---------- 步骤2：差旅行程（支持多段，每段可绑定人员） ---------- */
  renderTripStep(p, d) {
    const trips = d.trips || [];
    const mlist = d.members || [];
    const namesOf = (t) => {
      const ids = t.member_ids_parsed || [];
      if (!ids.length) return '<span style="color:var(--ink-3)">未绑定 · 全部人员默认</span>';
      const ns = ids.map((id) => {
        const m = mlist.find((x) => Number(x.id) === Number(id));
        return m ? m.name : null;
      }).filter(Boolean);
      return ns.length ? esc(ns.join('、')) : '<span style="color:var(--ink-3)">—</span>';
    };
    $('#stepBox').innerHTML = `
      <div class="card">
        <div class="card-head">
          <h3>差旅行程</h3><span class="spacer"></span>
          <button class="btn btn-primary btn-sm" onclick="App.openTripForm(${p.id})">+ 增加一行行程</button>
        </div>
        <div class="card-body">
          ${trips.length ? `
            <table class="tb">
              <thead><tr>
                <th style="width:36px">#</th><th>出差事由</th><th>出差时间</th>
                <th>起讫地点</th><th style="width:70px">天数</th><th>绑定人员</th><th style="width:148px">操作</th>
              </tr></thead>
              <tbody>${trips.map((t, i) => `
                <tr>
                  <td>${i + 1}</td>
                  <td>${esc(t.reason || p.reason || '—')}</td>
                  <td>${esc(t.start_date || '—')} 至 ${esc(t.end_date || '—')}</td>
                  <td><b>${esc(t.from_place || '—')} ⇄ ${esc(t.to_place || '—')}</b></td>
                  <td>共 ${t.days} 天</td>
                  <td>${namesOf(t)}</td>
                  <td>
                    <button class="btn btn-sm" onclick="App.openTripForm(${p.id},${JSON.stringify(t).replace(/</g, '\\u003c').replace(/"/g, '&quot;')})">编辑</button>
                    <button class="btn btn-sm btn-danger" onclick="App.deleteTrip(${t.id},${p.id})">删除</button>
                  </td>
                </tr>`).join('')}</tbody>
            </table>
            <div class="hint" style="margin-top:10px">
              每人一行明细：起讫地点与天数取该人<b>所绑定行程</b>的值；未绑定的人员默认套用第 1 段行程。
            </div>`
        : emptyState('✈', '尚未添加差旅行程', '点右上角「增加一行行程」：可添加多段行程，并分别绑定不同人员')}
        </div>
      </div>`;
  },

  /* 从已识别票据聚合出差建议：起止日期 = 最早/最晚票据日期；往返 = 行程解析 */
  suggestTripFromReceipts(receipts) {
    const usable = (receipts || []).filter((r) => r.invoice_date || r.itinerary);
    if (!usable.length) return null;
    const normCity = (s) => {
      let c = String(s || '').trim().replace(/站$/, '');
      if (c.length >= 3 && /[东南西北]$/.test(c)) c = c.slice(0, -1); // 北京南->北京
      if (c.length > 2 && c.endsWith('虹桥')) c = c.slice(0, -2);
      return c;
    };
    const parseItin = (txt) => {
      const parts = String(txt || '').split(/[→⇄\-—–~至到]/).map((x) => x.trim()).filter(Boolean);
      if (parts.length >= 2) return [normCity(parts[0]), normCity(parts[1])];
      const st = String(txt || '').match(/[\u4e00-\u9fa5A-Za-z]{2,12}?站/g); // 「xx站」成对兜底
      if (st && st.length >= 2) return [normCity(st[0]), normCity(st[1])];
      return null;
    };
    const dates = usable.map((r) => r.invoice_date).filter(Boolean).sort();
    let from = null, to = null, n = 0;
    const seq = usable.filter((r) => r.itinerary)
      .sort((a, b) => String(a.invoice_date || '9999').localeCompare(String(b.invoice_date || '9999')) || (a.id || 0) - (b.id || 0));
    for (const r of seq) {
      const p = parseItin(r.itinerary);
      if (p && p[0] && p[1] && p[0] !== p[1]) { from = p[0]; to = p[1]; break; }
    }
    const out = {};
    if (dates.length) { out.start_date = dates[0]; out.end_date = dates[dates.length - 1]; n++; }
    if (from && to) { out.from_place = from; out.to_place = to; n++; }
    return n ? { ...out, sourceCount: usable.length } : null;
  },

  openTripForm(projectId, trip) {
    const t = trip || {};
    const auto = t.id ? null : this.suggestTripFromReceipts(this.state.detail && this.state.detail.receipts);
    // 新增行程时默认沿用第 1 段的事由与日期，减少重复录入
    const base = t.id ? null : ((this.state.detail && this.state.detail.trips) || [])[0];
    const val = (k) => t[k] || (auto && auto[k]) || (base && base[k]) || '';
    const mlist = (this.state.detail && this.state.detail.members) || [];
    const bound = t.member_ids_parsed || [];
    const memberBox = mlist.length
      ? mlist.map((m) => `<label class="trip-mem"><input type="checkbox" class="tf_mem" value="${m.id}"
          ${bound.some((id) => Number(id) === Number(m.id)) ? 'checked' : ''}>${esc(m.name)}${m.job_no ? `（${esc(m.job_no)}）` : ''}</label>`).join('')
      : '<span style="color:var(--ink-3)">还没有成员，先到「添加成员」步骤录入后再回来绑定</span>';
    modal(t.id ? '编辑差旅行程' : '添加差旅行程', `
      ${auto ? `<div class="hint" style="margin-bottom:10px;color:var(--brand)">✦ 已根据 ${auto.sourceCount} 张票据的识别信息自动填充日期与往返地点，可修改</div>` : ''}
      <div class="field">
        <label>出差事由<span class="req">*</span></label>
        <textarea class="textarea" id="tf_reason" placeholder="将作为差旅费明细表的「出差事由」">${esc(t.reason || '')}</textarea>
      </div>
      <div class="grid grid-2">
        <div class="field"><label>出发日期<span class="req">*</span></label><input class="input" type="date" id="tf_start" value="${esc(val('start_date'))}"></div>
        <div class="field"><label>返回日期<span class="req">*</span></label><input class="input" type="date" id="tf_end" value="${esc(val('end_date'))}"></div>
        <div class="field"><label>出发地</label><input class="input" id="tf_from" value="${esc(val('from_place'))}" placeholder="如：天津"></div>
        <div class="field"><label>目的地</label><input class="input" id="tf_to" value="${esc(val('to_place'))}" placeholder="如：合肥"></div>
      </div>
      <div class="field">
        <label>绑定人员</label>
        <div class="trip-mem-box" id="tf_members">${memberBox}</div>
        <div class="hint">勾选只走这段行程的人；不勾选 = 该项目全部人员默认套用本段行程。生成明细表时，每人按自己绑定的行程显示起讫地点。</div>
      </div>
      <div class="hint" id="tf_days">填写起止日期后自动计算天数（学生补助将按此天数计算）${t.id ? ' · <a href="javascript:void(0)" onclick="App.fillTripFromReceipts()" style="color:var(--brand)">⟳ 从票据填充空项</a>' : ''}</div>`, {
      buttons: [
        { label: '取消', cls: 'btn' },
        {
          label: '保存', cls: 'btn btn-primary', onClick: async (close) => {
            const body = {
              reason: $('#tf_reason').value.trim(),
              start_date: $('#tf_start').value, end_date: $('#tf_end').value,
              from_place: $('#tf_from').value.trim(), to_place: $('#tf_to').value.trim(),
              member_ids: [...document.querySelectorAll('.tf_mem:checked')].map((el) => Number(el.value)),
            };
            if (!body.start_date || !body.end_date) { toast('请填写出差起止日期', 'warn'); return false; }
            if (body.end_date < body.start_date) { toast('返回日期不能早于出发日期', 'warn'); return false; }
            if (t.id) await Api.put('/api/trips/' + t.id, body);
            else await Api.post(`/api/projects/${projectId}/trips`, body);
            toast('行程已保存', 'ok');
            close();
            await this.loadDetail(projectId, 'trip');
          },
        },
      ],
    });
    const calcDaysView = () => {
      const s = $('#tf_start').value, e = $('#tf_end').value;
      if (!s || !e || e < s) { $('#tf_days').textContent = '填写起止日期后自动计算天数'; return; }
      const n = Math.floor((new Date(e) - new Date(s)) / 86400000) + 1;
      const mt = this.state.settings.meal_teacher, ct = this.state.settings.city_teacher, sr = this.state.settings.student_ratio;
      $('#tf_days').innerHTML = `共 <b style="color:var(--brand)">${n}</b> 天 ·
        教师定额：餐费 ¥${money0(mt * n)} + 市交 ¥${money0(ct * n)} ·
        学生定额：餐费 ¥${money0(mt * sr * n)} + 市交 ¥${money0(ct * sr * n)}`;
    };
    $('#tf_start').oninput = calcDaysView;
    $('#tf_end').oninput = calcDaysView;
    calcDaysView();
  },

  async deleteTrip(id, projectId) {
    confirmDialog('删除行程', '确定删除该差旅行程吗？', async () => {
      await Api.del('/api/trips/' + id);
      toast('行程已删除', 'ok');
      await this.loadDetail(projectId);
    });
  },

  fillTripFromReceipts() {
    const a = this.suggestTripFromReceipts(this.state.detail && this.state.detail.receipts);
    if (!a) { toast('没有可用的票据识别信息', 'warn'); return; }
    const setIfEmpty = (sel, v) => { const el = $(sel); if (!el.value && v) el.value = v; };
    setIfEmpty('#tf_start', a.start_date); setIfEmpty('#tf_end', a.end_date);
    setIfEmpty('#tf_from', a.from_place); setIfEmpty('#tf_to', a.to_place);
    $('#tf_start').dispatchEvent(new Event('input'));
    toast('已从票据填充空项', 'ok');
  },

  /* ---------- 步骤1：成员 ---------- */
  renderMemberStep(p, d) {
    const cfg = this.state.settings;
    const rows = d.members.map((m) => {
      const mealRate = m.meal_rate != null ? m.meal_rate : (m.role === 'student' ? cfg.meal_teacher * cfg.student_ratio : cfg.meal_teacher);
      const cityRate = m.city_rate != null ? m.city_rate : (m.role === 'student' ? cfg.city_teacher * cfg.student_ratio : cfg.city_teacher);
      return `<tr>
        <td>${m.role === 'student' ? '<span class="tag purple">学生</span>' : '<span class="tag green">教师</span>'}</td>
        <td><b>${esc(m.name)}</b></td>
        <td>${esc(m.major || '—')}</td>
        <td>${esc(m.job_no || '—')}</td>
        <td>${esc(m.phone || '—')}</td>
        <td>${esc(m.rank_level || '—')}</td>
        <td class="num">${m.days}</td>
        <td class="num">${money0(mealRate)}</td>
        <td class="num">${money0(cityRate)}</td>
        <td class="actions">
          <button class="btn btn-sm btn-ghost" onclick="App.openMemberForm(${p.id},${m.id})">编辑</button>
          <button class="btn btn-sm btn-ghost" style="color:var(--err)" onclick="App.deleteMember(${m.id},${p.id})">删除</button>
        </td></tr>`;
    }).join('');

    $('#stepBox').innerHTML = `
      <div class="card">
        <div class="card-head">
          <h3>教师与学生</h3>
          <span class="spacer"></span>
          <button class="btn btn-primary btn-sm" onclick="App.openMemberForm(${p.id})">+ 添加成员</button>
        </div>
        <div class="card-body tight">
          <div class="table-wrap">
            <table class="tb">
              <thead><tr>
                <th>身份</th><th>姓名</th><th>专业</th><th>工号/学号</th><th>电话</th><th>职级</th>
                <th class="num">天数</th><th class="num">日餐费</th><th class="num">日市交</th><th class="actions">操作</th>
              </tr></thead>
              <tbody>${rows || `<tr><td colspan="10">${emptyState('👥', '尚未添加成员', '教师与学生均可添加，学生补助自动减半')}</td></tr>`}</tbody>
            </table>
          </div>
        </div>
        <div class="card-body" style="border-top:1px solid var(--line);background:#fbfcfd;font-size:12px;color:var(--ink-2)">
          当前标准：教师餐费 <b>¥${money0(cfg.meal_teacher)}/天</b>、市内交通 <b>¥${money0(cfg.city_teacher)}/天</b>；
          学生按 ${(cfg.student_ratio * 100).toFixed(0)}% 计。可在成员行单独覆盖，或到「基础设置」统一调整。
        </div>
      </div>`;
  },

  openMemberForm(projectId, memberId) {
    const d = this.state.detail;
    const m = memberId ? d.members.find((x) => x.id === memberId) : null;
    // 含差旅项目：新增成员时默认带入行程天数，减少重复录入
    const tripDays = (d.trips[0] && d.trips[0].days) || 0;
    const defaultDays = m ? m.days : (d.project.has_travel ? tripDays : 0);
    // 专业候选项按「项目所属学院」过滤，保证学院→专业两级选择一致
    const pid = d.project.college_id;
    const pcol = this.state.colleges.find((c) => String(c.id) === String(pid));
    const majors = this.state.majors
      .filter((x) => !pid || String(x.college_id) === String(pid))
      .map((x) => x.name);
    const majorHint = pcol
      ? (majors.length
        ? `候选项为「${esc(pcol.name)}」的 ${majors.length} 个专业`
        : `「${esc(pcol.name)}」暂无本科专业，可直接填写`)
      : '项目未指定学院，此处列出全部专业';
    const mform = modal(m ? '编辑成员' : '添加教师 / 学生', `
      <div class="field">
        <label>身份<span class="req">*</span></label>
        <div class="segment" id="mf_role">
          <label><input type="radio" name="mfr" value="teacher" ${!m || m.role === 'teacher' ? 'checked' : ''}><span>教师</span></label>
          <label><input type="radio" name="mfr" value="student" ${m && m.role === 'student' ? 'checked' : ''}><span>学生</span></label>
        </div>
      </div>
      <div class="grid grid-2">
        <div class="field"><label>姓名<span class="req">*</span></label><input class="input" id="mf_name" value="${esc(m ? m.name : '')}"></div>
        <div class="field">
          <label>工号 / 学号</label>
          <input class="input" id="mf_jobno" value="${esc(m ? m.job_no || '' : '')}">
          <div class="hint">教师填工号，学生填学号</div>
        </div>
        <div class="field"><label>专业</label>
          <input class="input" id="mf_major" value="${esc(m ? m.major || '' : '')}" placeholder="点右侧箭头下拉选择，或直接输入">
          <div class="hint">${majorHint}</div>
        </div>
        <div class="field"><label>电话</label><input class="input" id="mf_phone" value="${esc(m ? m.phone || '' : '')}"></div>
        <div class="field"><label>职级</label><input class="input" id="mf_rank" value="${esc(m ? m.rank_level || '' : '')}" placeholder="如：二类（学生可留空）"></div>
        <div class="field"><label>出差天数</label>
          <input class="input" type="number" id="mf_days" value="${defaultDays}" min="0" step="1">
          <div class="hint" id="mf_dayhint"></div>
        </div>
      </div>
      <div class="grid grid-2">
        <div class="field"><label>日餐费（元，留空用默认）</label><input class="input" type="number" id="mf_meal" value="${m && m.meal_rate != null ? m.meal_rate : ''}" min="0" step="0.01"></div>
        <div class="field"><label>日市内交通（元，留空用默认）</label><input class="input" type="number" id="mf_city" value="${m && m.city_rate != null ? m.city_rate : ''}" min="0" step="0.01"></div>
      </div>`, {
      size: 'wide',
      buttons: [
        { label: '取消', cls: 'btn' },
        {
          label: '保存', cls: 'btn btn-primary', onClick: async (close) => {
            const role = $('input[name=mfr]:checked').value;
            const body = {
              role, name: $('#mf_name').value.trim(), major: $('#mf_major').value.trim(),
              job_no: $('#mf_jobno').value.trim(), phone: $('#mf_phone').value.trim(),
              rank_level: $('#mf_rank').value.trim(), days: $('#mf_days').value,
              meal_rate: $('#mf_meal').value, city_rate: $('#mf_city').value,
            };
            if (!body.name) { toast('请填写姓名', 'warn'); return false; }
            if (m) await Api.put('/api/members/' + m.id, body);
            else await Api.post(`/api/projects/${projectId}/members`, body);
            toast('成员已保存', 'ok');
            close();
            await this.loadDetail(projectId, 'members');
          },
        },
      ],
    });
    attachCombo(mform.box.querySelector('#mf_major'), majors);

    const cfg = this.state.settings;
    const updHint = () => {
      const role = $('input[name=mfr]:checked').value;
      const days = Number($('#mf_days').value) || 0;
      const r = role === 'student' ? cfg.student_ratio : 1;
      $('#mf_dayhint').textContent = days > 0
        ? `定额合计：餐费 ¥${money0(cfg.meal_teacher * r * days)} + 市交 ¥${money0(cfg.city_teacher * r * days)}`
        : '含差旅项目留空将自动取行程天数';
    };
    $$('input[name=mfr]').forEach((el) => { el.onchange = updHint; });
    $('#mf_days').oninput = updHint;
    updHint();
  },

  async deleteMember(id, projectId) {
    confirmDialog('删除成员', '确定删除该成员吗？其名下票据归集将一并移除。', async () => {
      await Api.del('/api/members/' + id);
      toast('成员已删除', 'ok');
      await this.loadDetail(projectId);
    });
  },

  /* ---------- 步骤3：票据 ---------- */
  renderReceiptStep(p, d) {
    const pending = d.receipts.filter((r) => r.ocr_status === 'pending');
    $('#stepBox').innerHTML = `
      <div class="card">
        <div class="card-head">
          <h3>票据中心</h3>
          <span class="tag ${pending.length ? 'red' : 'green'}">${pending.length ? `${pending.length} 张待审核` : '已全部审核'}</span>
          <span class="spacer"></span>
          <button class="btn btn-sm btn-ghost" onclick="App.printReceipts(${p.id},${d.receipts.length})">🖨 打印全部票据</button>
          <button class="btn btn-sm" onclick="App.sendProjectInvoices()">📧 发送发票到邮箱</button>
          <button class="btn btn-sm" onclick="App.openImportDialog(${p.id})">批量导入</button>
          <button class="btn btn-primary btn-sm" onclick="App.openUploadDialog(${p.id})">+ 上传票据</button>
        </div>
        <div class="card-body">
          <div class="drop" id="dropZone">
            <div class="ico">⬆</div>
            <b>点击选择</b> 或将票据图片 / PDF 拖到此处<br>
            <small style="font-size:11.5px">支持 JPG / PNG / PDF，可一次多选；上传后自动 OCR 识别并进入待审核队列</small>
            <input type="file" id="fileInput" multiple accept="image/*,.pdf" style="display:none">
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>票据清单</h3></div>
        <div class="card-body">
          ${d.receipts.length ? d.receipts.map((r) => App.receiptCardHtml(r, p, d)).join('') : emptyState('🧾', '还没有票据', '上传或批量导入票据后，可在此审核')}
        </div>
      </div>`;

    const dz = $('#dropZone'), fi = $('#fileInput');
    dz.onclick = () => fi.click();
    fi.onchange = () => { if (fi.files.length) App.doUpload(p.id, Array.from(fi.files)); fi.value = ''; };
    ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
    dz.addEventListener('drop', (e) => {
      const fs2 = Array.from(e.dataTransfer.files || []);
      if (fs2.length) App.doUpload(p.id, fs2);
    });

    $$('.receipt-card').forEach((el) => App.bindReceiptCard(el, p.id));
  },

  receiptCardHtml(r, p, d) {
    const st = r.ocr_status;
    const stTag = st === 'approved' ? '<span class="tag green">✓ 已通过</span>'
      : st === 'rejected' ? '<span class="tag red">✕ 已驳回</span>'
        : '<span class="tag gold">⏳ 待审核</span>';
    // 规则引擎没解出关键字段 -> 已入队，等 AI 助手看图补录
    const aiTag = r.ai_status === 'queued' ? '<span class="tag purple">👁 AI 待提取</span>' : '';
    const isImg = r.mime && r.mime.startsWith('image/');
    const thumb = isImg
      ? `<img class="thumb" src="/api/files/${encodeURIComponent(r.file_path)}" alt="" onclick="lightbox('/api/files/${encodeURIComponent(r.file_path)}')">`
      : `<div class="thumb" style="display:grid;place-items:center;font-size:19px;color:var(--ink-3)">📄</div>`;

    return `<div class="receipt-card ${st}" data-rid="${r.id}">
      <div class="rc-top">
        ${thumb}
        <div style="flex:1;min-width:0">
          <div class="rc-file">${esc(r.file_name || r.vendor || '手工录入票据')}</div>
          <div style="font-size:11.5px;color:var(--ink-3);margin-top:2px">
            ${r.invoice_no ? '票号 ' + esc(r.invoice_no) + ' · ' : ''}${r.invoice_date ? esc(r.invoice_date) : ''}
            ${r.vendor ? ' · ' + esc(r.vendor) : ''}
            ${r.ocr_engine ? ' · <span style="color:var(--ink-3)">' + esc(r.ocr_engine) + '</span>' : ''}
          </div>
        </div>
        <div style="text-align:right">
          <div style="font-size:17px;font-weight:700;color:${st === 'approved' ? 'var(--ok)' : 'var(--ink-3)'}">${r.amount != null ? '¥ ' + money(r.amount) : '未识别'}</div>
          <div style="margin-top:3px">${stTag} ${aiTag}</div>
        </div>
      </div>
      ${r.ai_status === 'queued'
    ? '<div class="ocr-hint" style="margin-bottom:9px"><span>ⓘ</span><span>这张票自动识别没取到关键字段，已加入<b>AI 待提取队列</b>。可在对话里说「处理发票队列」，让 AI 助手直接看图补录；也可以自己手工填下面的字段后审核通过。</span></div>'
    : st === 'pending' ? '<div class="ocr-hint" style="margin-bottom:9px"><span>ⓘ</span><span>OCR 自动识别结果已填入下方，请人工核对后点击「审核通过」或「驳回」。</span></div>' : ''}
      <div class="rc-fields">
        <div class="rc-field"><label>费用科目</label>
          <select class="select" data-f="category">${this.state.buckets.map((b) =>
      `<option value="${b.key}" ${r.category === b.key ? 'selected' : ''}>${esc(b.label)}</option>`).join('')}</select></div>
        <div class="rc-field"><label>金额（元）</label><input class="input" type="number" step="0.01" data-f="amount" value="${r.amount != null ? r.amount : ''}"></div>
        <div class="rc-field"><label>归属成员</label>
          <select class="select" data-f="member_id"><option value="">未指定</option>${d.members.map((m) =>
        `<option value="${m.id}" ${r.member_id === m.id ? 'selected' : ''}>${esc(m.name)}${m.job_no ? ' (' + esc(m.job_no) + ')' : ''}</option>`).join('')}</select></div>
        <div class="rc-field"><label>发票号码</label><input class="input" data-f="invoice_no" value="${esc(r.invoice_no || '')}"></div>
        <div class="rc-field"><label>开票日期</label><input class="input" type="date" data-f="invoice_date" value="${esc(r.invoice_date || '')}"></div>
        <div class="rc-field"><label>销方 / 商户</label><input class="input" data-f="vendor" value="${esc(r.vendor || '')}"></div>
        <div class="rc-field" style="grid-column:span 2"><label>行程摘要</label><input class="input" data-f="itinerary" value="${esc(r.itinerary || '')}" placeholder="如：天津-合肥"></div>
      </div>
      <div style="display:flex;gap:7px;justify-content:flex-end;flex-wrap:wrap">
        ${st === 'pending' ? '<button class="btn btn-sm" data-act="reocr">↻ 重新识别</button>' : ''}
        <button class="btn btn-sm btn-danger" data-act="reject">驳回</button>
        ${st === 'approved' ? `<button class="btn btn-sm" data-act="unapprove">撤销通过</button>` : ''}
        <button class="btn btn-sm btn-ghost" style="color:var(--err)" data-act="delete">删除</button>
        <button class="btn btn-sm btn-primary" data-act="approve">✓ 审核通过</button>
      </div>
    </div>`;
  },

  bindReceiptCard(el, projectId) {
    const rid = el.dataset.rid;
    const get = (f) => el.querySelector(`[data-f="${f}"]`).value;
    const collect = () => ({
      category: get('category'),
      amount: get('amount'),
      member_id: get('member_id') || null,
      invoice_no: get('invoice_no'),
      invoice_date: get('invoice_date'),
      vendor: get('vendor'),
      itinerary: get('itinerary'),
    });

    el.querySelector('[data-act="approve"]').onclick = async () => {
      const c = collect();
      if (!c.amount) { toast('请先填写金额', 'warn'); return; }
      const d = this.state.detail;
      if (!c.member_id) {
        if (d && d.members && d.members.length === 1) {
          c.member_id = d.members[0].id;
          el.querySelector('[data-f="member_id"]').value = c.member_id;
        } else {
          toast('请先选择归属成员，否则该票据不会计入报销金额', 'warn');
          return;
        }
      }
      await Api.put(`/api/receipts/${rid}`, c);
      await Api.post(`/api/receipts/${rid}/review`, {
        status: 'approved', reviewer: '当前用户', member_id: c.member_id,
        amount: c.amount, category: c.category,
        items: [{ member_id: c.member_id, bucket: c.category, amount: Number(c.amount), note: c.itinerary || c.vendor || '' }],
      });
      toast('票据已通过审核并计入报销', 'ok');
      await this.loadDetail(projectId);
    };
    const ro = el.querySelector('[data-act="reocr"]');
    if (ro) ro.onclick = async () => {
      ro.disabled = true; ro.textContent = '识别中…';
      try {
        const res = await Api.post(`/api/receipts/${rid}/reocr`, {});
        if (res && res.ok === false) throw new Error(res.error || '识别失败');
        toast('重新识别完成，请核对字段', 'ok');
        await this.loadDetail(projectId);
      } catch (e) {
        ro.disabled = false; ro.textContent = '↻ 重新识别';
        toast(e.message, 'err');
      }
    };
    el.querySelector('[data-act="reject"]').onclick = async () => {
      await Api.post(`/api/receipts/${rid}/review`, { status: 'rejected', reviewer: '当前用户' });
      toast('票据已驳回', 'ok');
      await this.loadDetail(projectId);
    };
    const un = el.querySelector('[data-act="unapprove"]');
    if (un) un.onclick = async () => {
      await Api.post(`/api/receipts/${rid}/review`, { status: 'pending' });
      toast('已撤销通过，票据回到待审核', 'ok');
      await this.loadDetail(projectId);
    };
    el.querySelector('[data-act="delete"]').onclick = () => {
      confirmDialog('删除票据', '确定删除该票据吗？此操作不可恢复。', async () => {
        await Api.del(`/api/receipts/${rid}`);
        toast('票据已删除', 'ok');
        await this.loadDetail(projectId);
      });
    };
  },

  async openUploadDialog(projectId) {
    modal('上传票据', `
      <div class="field">
        <label>选择票据文件<span class="req">*</span></label>
        <input class="input" type="file" id="ud_files" multiple accept="image/*,.pdf">
        <div class="hint">支持 JPG / PNG / PDF，可多选。上传后自动进行 OCR 识别，识别结果需人工审核确认。</div>
      </div>
      <div class="field">
        <label>补充提示（可选）</label>
        <input class="input" id="ud_hint" placeholder="如：住宿费 / 合肥">
        <div class="hint">用于辅助 OCR 判断费用科目，对同一批次所有票据生效</div>
      </div>`, {
      buttons: [
        { label: '取消', cls: 'btn' },
        {
          label: '上传并识别', cls: 'btn btn-primary', onClick: async (close) => {
            const fi = $('#ud_files');
            if (!fi.files.length) { toast('请选择文件', 'warn'); return false; }
            const hint = $('#ud_hint').value.trim();
            const files = Array.from(fi.files);
            const hints = files.map(() => hint);
            const r = await Api.upload(projectId, files, hints);
            toast(r.message || '上传完成', 'ok');
            close();
            await this.loadDetail(projectId);
          },
        },
      ],
    });
  },

  async doUpload(projectId, files) {
    const t = toast(`正在上传并识别 ${files.length} 张票据…`, 'info');
    try {
      const r = await Api.upload(projectId, files, files.map(() => ''));
      toast(r.message || '上传完成，请人工审核', 'ok');
      await this.loadDetail(projectId);
    } catch (e) { toast(e.message, 'err'); }
  },

  openImportDialog(projectId) {
    modal('批量导入票据', `
      <div class="field">
        <label>导入格式</label>
        <div class="segment" id="if_fmt">
          <label><input type="radio" name="fmt" value="csv" checked><span>CSV</span></label>
          <label><input type="radio" name="fmt" value="json"><span>JSON</span></label>
        </div>
      </div>
      <div class="field">
        <label>粘贴数据</label>
        <textarea class="textarea" id="if_data" style="min-height:170px;font-family:Consolas,monospace;font-size:12px" placeholder="票据类型,姓名,工号/学号,发票号,日期,金额,销方名称,行程,费用&#10;住宿费,刘海斌,093024,12345678,2026-08-14,600,合肥某酒店,,住宿"></textarea>
        <div class="hint">首行为表头。列名支持中文（票据类型/姓名/工号/日期/金额/销方/行程/费用）或英文（category/member_name/job_no/invoice_no/invoice_date/amount/vendor/itinerary/item）</div>
      </div>
      <div style="font-size:12px">
        <a href="/api/receipts/template.csv" style="color:var(--brand)">↓ 下载 CSV 模板</a>
        <span style="color:var(--ink-3)"> · 导入的票据统一进入「待审核」队列</span>
      </div>`, {
      size: 'wide',
      buttons: [
        { label: '取消', cls: 'btn' },
        {
          label: '开始导入', cls: 'btn btn-primary', onClick: async (close) => {
            const content = $('#if_data').value.trim();
            if (!content) { toast('请粘贴数据或选择文件', 'warn'); return false; }
            const format = $('input[name=fmt]:checked').value;
            const r = await Api.post(`/api/projects/${projectId}/receipts/import`, { content, format });
            toast(`成功导入 ${r.imported} 条${r.failed ? `，失败 ${r.failed} 条` : ''}`, r.failed ? 'warn' : 'ok');
            close();
            await this.loadDetail(projectId);
          },
        },
      ],
    });
  },

  /* ---------- 步骤4：报表 ---------- */
  renderReportStep(p, d) {
    const c = d.calc;
    const hasTravel = p.has_travel;
    /* 其他费用子列（项目 | 金额）：与官方模板一致，最多 3 行，多余合并 */
    const otherCells = (r) => {
      const items = Array.isArray(r.otherItems) ? r.otherItems : [];
      let names, amounts;
      if (!items.length) { names = '—'; amounts = money(0); }
      else if (items.length <= 3) {
        names = items.map((o) => esc(o.item || '其他')).join('<br>');
        amounts = items.map((o) => money(o.amount)).join('<br>');
      } else {
        const rest = items.slice(3).reduce((a, b) => a + Number(b.amount || 0), 0);
        names = items.slice(0, 3).map((o) => esc(o.item || '其他')).join('<br>') + `<br>其他${items.length - 3}项`;
        amounts = items.slice(0, 3).map((o) => money(o.amount)).join('<br>') + `<br>${money(rest)}`;
      }
      return `<td style="font-size:11px">${names}</td><td class="num">${amounts}</td>`;
    };
    const rowsHtml = c.rows.length ? c.rows.map((r) => `
      <tr>
        <td>${esc(r.dept || '')}</td>
        <td>${esc(r.name)}</td>
        <td>${esc(r.jobNo)}</td>
        <td>${esc(r.rankLevel || '')}</td>
        <td>${esc(r.route || '')}</td>
        <td class="num">${money(r.transport)}<div style="font-size:10.5px;color:var(--ink-3)">${esc(r.transportExpr)}</div></td>
        <td class="num">${money(r.hotel)}</td>
        <td class="num">${money(r.meal)}<div style="font-size:10.5px;color:var(--ink-3)">${esc(r.mealExpr)}</div></td>
        <td class="num">${money(r.cityTrans)}<div style="font-size:10.5px;color:var(--ink-3)">${esc(r.cityExpr)}</div></td>
        ${otherCells(r)}
      </tr>`).join('') : `<tr><td colspan="11">${emptyState('▦', '暂无费用明细', '请先添加成员并审核票据')}</td></tr>`;

    const t = (d.trips || [])[0] || null;
    // 多段行程：出差时间取最早出发 ~ 最晚返回；无行程（非差旅项目）时留空，不阻塞报表
    const ts = (d.trips || []).filter((x) => x.start_date);
    const rs = ts.length ? ts.map((x) => x.start_date).sort()[0] : ((t && t.start_date) || '');
    const re = ts.length ? ts.map((x) => x.end_date || x.start_date).sort().pop() : ((t && t.end_date) || '');
    const rDays = rs && re ? Math.max(1, Math.floor((new Date(re) - new Date(rs)) / 86400000) + 1) : ((t && t.days) || '');
    $('#stepBox').innerHTML = `
      ${hasTravel && t ? `
      <div class="card">
        <div class="card-head">
          <h3>差旅费报销明细表 · 预览</h3><span class="spacer"></span>
          <button class="btn btn-sm btn-ghost" onclick="App.printForm('travel')">🖨 打印此表</button>
        </div>
        <div class="card-body">
          <div class="report-paper">
            <table class="rp-main">
              <tr class="rp-title-row"><td colspan="11">天 津 仁 爱 学 院 差 旅 费 报 销 明 细 表</td></tr>
              <tr><td class="rp-lbl">出差事由</td><td colspan="10" class="rp-val">${esc(t.reason || p.reason || '')}</td></tr>
              <tr><td class="rp-lbl">出差时间</td><td colspan="10" class="rp-val">${esc(rs)} 至 ${esc(re)}　共 ${rDays} 天</td></tr>
              <tr class="rp-head">
                <th rowspan="2">部门</th><th rowspan="2">姓名</th><th rowspan="2">工号/学号</th><th rowspan="2">职级</th><th rowspan="2">起讫地点</th>
                <th rowspan="2">城市间<br>交通费</th><th rowspan="2">住宿费</th><th rowspan="2">伙食<br>补助费</th><th rowspan="2">市内<br>交通费</th>
                <th colspan="2">其他费用</th>
              </tr>
              <tr class="rp-head rp-head-sub"><th>项目</th><th>金额</th></tr>
              <tbody>${rowsHtml}</tbody>
              <tfoot><tr>
                <td colspan="5" style="text-align:center">小计</td>
                <td class="num">${money(c.bucketTotal.transport)}</td>
                <td class="num">${money(c.bucketTotal.hotel)}</td>
                <td class="num">${money(c.bucketTotal.meal)}</td>
                <td class="num">${money(c.bucketTotal.city_trans)}</td>
                <td class="num" colspan="2">${money(c.total)}</td>
              </tr>
              <tr><td colspan="5" style="text-align:center">合计</td>
                <td colspan="6" class="rp-amount">${esc(d.currency_prefix)}：${esc(d.upper_total)}　　¥${money(c.total)} 元</td></tr></tfoot>
            </table>
          </div>
        </div>
      </div>` : ''}

      <div class="card">
        <div class="card-head">
          <h3>资金申请单 · 预览</h3><span class="spacer"></span>
          <button class="btn btn-sm btn-ghost" onclick="App.printForm('fund')">🖨 打印此表</button>
          <button class="btn btn-sm" onclick="App.openFundForm(${p.id},${c.total})">填写收款信息</button>
        </div>
        <div class="card-body">
          <div class="fund-preview">
            <div class="fp-title">天 津 仁 爱 学 院 资 金 申 请 单</div>
            <div style="text-align:center;font-size:12.5px;color:#555">${new Date().getFullYear()} 年 ${new Date().getMonth() + 1} 月 ${new Date().getDate()} 日</div>
            <table class="fp-main">
              <colgroup><col style="width:17%"><col style="width:19%"><col style="width:17%"><col style="width:16%"><col style="width:16%"><col style="width:15%"></colgroup>
              <tr><td class="lbl">部门</td><td colspan="2">${esc(p.college_name || '')}</td><td class="lbl">类别</td><td colspan="2">□ 借款　■ 报销</td></tr>
              <tr><td class="lbl">支付事由</td><td colspan="5">${esc(p.reason || p.name)}</td></tr>
              <tr><td class="lbl">支付方式</td><td colspan="5">□ 现金　　□ 支票　　□ 电汇　　□ 其他</td></tr>
              <tr><td class="lbl">合同(项目)编号及名称</td><td colspan="2">${p.category === 'research' ? `${esc(p.code)} ${esc(p.name)}` : ''}</td><td class="lbl">收款单位名称</td><td colspan="2">${esc(this.state.settings.payee_name || this.state.settings.org_name || '')}</td></tr>
              <tr><td class="lbl">收款单位开户银行</td><td colspan="2">${esc(this.state.settings.payee_bank || '')}</td>
                  <td class="lbl">收款单位银行账号</td><td colspan="2">${esc(this.state.settings.payee_account || '')}</td></tr>
              <tr><td class="lbl">金额</td><td colspan="4" class="rp-upper" style="text-align:left;padding-left:12px">${esc(d.currency_prefix)}：${esc(d.upper_total)}</td><td class="fp-lower">¥ ${money(c.total)} 元</td></tr>
              <tr><td class="lbl">申请人</td><td></td><td class="lbl">部门(项目)负责人</td><td></td><td class="lbl">财务处长</td><td></td></tr>
              <tr><td class="lbl">主管校领导</td><td></td><td class="lbl">财务副校长</td><td></td><td class="lbl">校长/书记</td><td></td></tr>
            </table>
          </div>
          <div class="hint" style="margin-top:8px">
            「合同(项目)编号及名称」仅<b>科研类</b>项目填写${p.category === 'research' ? '' : `（本项目类别：${esc((this.state.categories.find((x) => x.key === p.category) || {}).label || p.category || '—')}，此处留空）`}。
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>导出文件</h3></div>
        <div class="card-body">
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            ${hasTravel && t ? `<button class="btn btn-primary" onclick="App.exportTravel(${p.id})">⬇ 导出差旅费报销明细表 (.docx)</button>` : ''}
            <button class="btn btn-gold" onclick="App.openFundForm(${p.id},${c.total},true)">⬇ 导出资金申请单 (.xlsx)</button>
          </div>
          <div class="hint" style="margin-top:10px">
            ${hasTravel && t
        ? '含差旅项目生成两份文件：差旅费报销明细表（Word）+ 资金申请单（Excel）。'
        : '非差旅项目仅生成资金申请单（Excel）。'}
            导出文件同时保存到项目 <code>exports/</code> 目录。
          </div>
        </div>
      </div>`;
  },

  /** 单表打印：隐藏 iframe 只装表单本体，差旅表横向 / 资金单纵向，各占一页 */
  printForm(kind) {
    const sel = kind === 'travel' ? '.report-paper' : '.fund-preview';
    const src = document.querySelector(sel);
    if (!src) { toast('没有可打印的表单', 'warn'); return; }
    const landscape = kind === 'travel';
    const title = kind === 'travel' ? '差旅费报销明细表' : '资金申请单';
    // 与 app.css 预览样式同源，去掉界面装饰（边框底色用固定值，不依赖 CSS 变量）
    const css = `
      @page { size: A4 ${landscape ? 'landscape' : 'portrait'}; margin: 12mm; }
      html, body { margin: 0; padding: 0; background: #fff; color: #000;
        font-family: "SimSun", "宋体", serif; }
      .report-paper, .fund-preview { border: none; padding: 0; background: #fff; }
      .fund-preview .fp-title {
        text-align: center; font-size: 20px; font-weight: 700; letter-spacing: 1px;
        font-family: "方正小标宋简体", "SimSun", serif; margin-bottom: 14px; }
      .fund-preview .fp-title { font-size: 19px; letter-spacing: 2px; margin-bottom: 6px; }
      .report-paper table, .fund-preview table { width: 100%; border-collapse: collapse; margin-top: 0; }
      .report-paper table td, .report-paper table th {
        border: 1px solid #000; padding: 7px 6px; text-align: center; font-size: 12px; }
      .report-paper .rp-title-row td {
        border: none !important; border-bottom: 1px solid #000 !important;
        text-align: center; font-size: 20px; font-weight: 700; letter-spacing: 1px;
        font-family: "方正小标宋简体", "SimSun", serif; padding: 8px 0 14px; }
      .report-paper .rp-lbl { width: 108px; }
      .report-paper .rp-val { text-align: left !important; padding-left: 10px !important; }
      .report-paper .rp-head th { font-weight: 600; }
      .report-paper .rp-amount { text-align: left; padding-left: 14px !important; }
      .rp-upper { font-weight: 600; }
      .fund-preview td { border: 1px solid #000; padding: 9px 10px; font-size: 13px; height: 34px; }
      .fund-preview td.lbl { background: #f7f9fb; font-weight: 600; text-align: center; }
      .fund-preview .fp-lower { font-weight: 600; white-space: nowrap; text-align: center; }
      table { page-break-inside: avoid; }`;
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument;
    doc.open();
    doc.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>`
      + `<style>${css}</style></head><body>${src.outerHTML}</body></html>`);
    doc.close();
    const fire = () => {
      if (!window.__SUPPRESS_PRINT) { // 测试缝：自动化验证时抑制打印对话框
        try { iframe.contentWindow.focus(); iframe.contentWindow.print(); } catch (e) { /* 忽略 */ }
      }
      setTimeout(() => iframe.remove(), 60000); // 留足打印对话框存活时间
    };
    if (doc.readyState === 'complete') setTimeout(fire, 120);
    else iframe.onload = () => setTimeout(fire, 120);
  },

  openFundForm(projectId, total, directExport) {
    const s = this.state.settings;
    modal(directExport ? '导出资金申请单' : '填写收款信息', `
      <div class="field">
        <label>报销金额（元）</label>
        <input class="input" type="number" id="ff_amount" value="${total}" step="0.01">
        <div class="hint">默认取项目已审核金额合计，可按实际支付调整</div>
      </div>
      <div class="grid grid-2">
        <div class="field"><label>收款单位名称</label><input class="input" id="ff_payee" value="${esc(s.payee_name || s.org_name || '')}"></div>
        <div class="field"><label>开户银行</label><input class="input" id="ff_bank" value="${esc(s.payee_bank || '')}"></div>
      </div>
      <div class="field"><label>银行账号</label><input class="input" id="ff_account" value="${esc(s.payee_account || '')}"></div>
      <div class="field"><label>支付方式</label>
        <select class="select" id="ff_method">
          <option value="   □  现金        □  支票        □  电汇       □  其他">默认（未勾选）</option>
          <option value="■  现金">现金</option>
          <option value="■  支票">支票</option>
          <option value="■  电汇">电汇</option>
          <option value="■  其他">其他</option>
        </select>
      </div>`, {
      buttons: [
        { label: '取消', cls: 'btn' },
        {
          label: directExport ? '导出 Excel' : '保存并导出', cls: 'btn btn-gold', onClick: async (close) => {
            const body = {
              amount: $('#ff_amount').value,
              payee_name: $('#ff_payee').value.trim(),
              payee_bank: $('#ff_bank').value.trim(),
              payee_account: $('#ff_account').value.trim(),
              pay_method: $('#ff_method').value,
            };
            if (!body.amount) { toast('请填写金额', 'warn'); return false; }
            const r = await Api.post(`/api/projects/${projectId}/export/fund_xlsx?json=1`, body);
            close();
            await this.savePayee(body);
            await this.triggerDownload(`/api/projects/${projectId}/export/fund_xlsx`, r);
            toast('资金申请单已导出', 'ok');
            await this.loadDetail(projectId);
          },
        },
      ],
    });
  },

  async savePayee(b) {
    try {
      await Api.put('/api/settings', {
        payee_name: b.payee_name, payee_bank: b.payee_bank, payee_account: b.payee_account,
      });
      const s = await Api.get('/api/settings');
      this.state.settings = s.settings;
    } catch (_) { /* 保存收款信息失败不阻断导出 */ }
  },

  async triggerDownload(url, r) {
    // 触发浏览器下载：生成临时 <a download>
    const a = document.createElement('a');
    a.href = url;
    a.download = r.file || 'export';
    document.body.appendChild(a);
    a.click();
    a.remove();
  },

  async exportTravel(projectId) {
    try {
      toast('正在生成差旅费报销明细表…', 'info');
      const r = await Api.get(`/api/projects/${projectId}/export/travel_docx?json=1`);
      await this.triggerDownload(`/api/projects/${projectId}/export/travel_docx`, r);
      toast('差旅费报销明细表已导出', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  },

  async deleteProject(id) {
    confirmDialog('删除项目', '确定删除该项目吗？项目下的成员、行程、票据记录将一并删除，且不可恢复。', async () => {
      await Api.del('/api/projects/' + id);
      toast('项目已删除', 'ok');
      this.state.currentId = null;
      this.switchView('projects');
      await this.loadProjects();
      await this.loadDashboard();
    });
  },

  /* ==================== 票据中心（全项目） ==================== */
  async loadReceiptCenter() {
    $('#receiptBox').innerHTML = '<div class="loading"><div class="spinner"></div>加载中…</div>';
    const projects = this.state.projects.length ? this.state.projects : (await Api.get('/api/projects')).projects;
    if (!projects.length) {
      $('#receiptBox').innerHTML = emptyState('🧾', '还没有项目', '请先创建报销项目');
      return;
    }
    let html = '';
    // AI 待提取队列：规则引擎没解出关键字段、等 AI 看图补录的票据
    let aiq = { count: 0, queue: [] };
    try { aiq = await Api.get('/api/ai/queue'); } catch (e) { /* 队列接口异常不影响主流程 */ }
    if (aiq.count) {
      html += `<div class="card">
        <div class="card-head">
          <h3>👁 AI 待提取 ${aiq.count} 张</h3>
          <span class="spacer"></span>
          <span class="tag purple">自动识别未取到关键字段</span>
        </div>
        <div class="card-body tight">
          <div class="table-wrap"><table class="tb">
            <thead><tr><th>项目</th><th>票据</th><th>已有字段</th></tr></thead>
            <tbody>${aiq.queue.map((x) => `<tr>
              <td>${esc(x.project_code || '')} ${esc(x.project_name || '')}</td>
              <td>${esc(x.file_name || '—')}</td>
              <td style="font-size:11.5px;color:var(--ink-3)">${esc(JSON.stringify(x.current))}</td>
            </tr>`).join('')}</tbody>
          </table></div>
          <div class="hint" style="margin-top:8px">
            想让我（AI 助手）处理：在对话里说 <b>「处理发票队列」</b>，我会逐张打开原图 / 原 PDF 读票、提取字段并回填。
            也可以自己在项目里手工填字段 —— 手工填的票一样能审核通过、生成表单。回填后仍需你逐张点「通过」。
          </div>
        </div></div>`;
    }
    for (const p of projects) {
      const r = await Api.get(`/api/projects/${p.id}/receipts`);
      if (!r.receipts.length) continue;
      const pending = r.receipts.filter((x) => x.ocr_status === 'pending').length;
      html += `<div class="card">
        <div class="card-head">
          <h3>${esc(p.name)}</h3>
          ${catTag(p.category)}
          ${pending ? `<span class="tag red">${pending} 待审核</span>` : '<span class="tag green">已审核完</span>'}
          <span class="spacer"></span>
          <button class="btn btn-sm btn-ghost" onclick="App.printReceipts(${p.id},${r.receipts.length})">🖨 打印全部票据</button>
          <button class="btn btn-sm" onclick="App.openProject(${p.id})">进入项目</button>
        </div>
        <div class="card-body tight">
          <div class="table-wrap"><table class="tb">
            <thead><tr><th>状态</th><th>票据</th><th>科目</th><th class="num">金额</th><th>归属</th><th>日期</th><th>销方</th><th class="actions">操作</th></tr></thead>
            <tbody>${r.receipts.map((x) => {
        const m = p.members ? null : null;
        const stTag = x.ocr_status === 'approved' ? '<span class="tag green">已通过</span>'
          : x.ocr_status === 'rejected' ? '<span class="tag red">已驳回</span>' : '<span class="tag gold">待审核</span>';
        const aiTag2 = x.ai_status === 'queued' ? ' <span class="tag purple">AI 待提取</span>' : '';
        return `<tr>
                <td>${stTag}${aiTag2}</td>
                <td>${esc(x.file_name || x.invoice_no || '手工录入')}</td>
                <td>${esc(bucketLabel(x.category))}</td>
                <td class="num">${x.amount != null ? '¥ ' + money(x.amount) : '—'}</td>
                <td>${x.member_id ? '成员#' + x.member_id : '—'}</td>
                <td>${esc(x.invoice_date || '—')}</td>
                <td>${esc(x.vendor || '—')}</td>
                <td class="actions">
                  ${x.ocr_status === 'pending' ? `<button class="btn btn-sm btn-primary" onclick="App.quickApprove(${x.id},${p.id})">通过</button>` : ''}
                  <button class="btn btn-sm btn-ghost" onclick="App.openProject(${p.id})">处理</button>
                </td></tr>`;
      }).join('')}</tbody>
          </table></div>
        </div></div>`;
    }
    $('#receiptBox').innerHTML = html || emptyState('✅', '所有项目都没有票据', '可在项目详情中上传或批量导入');
  },

  /** 把某项目的全部票据 PDF 合并成一个文件：先预览，再打印 */
  printReceipts(projectId, count) {
    const url = `/api/projects/${projectId}/receipts/merged.pdf`;
    modal('票据合并打印 · 预览', `
      <div class="hint" style="margin-bottom:10px">
        已按上传顺序把该项目 <b>${count}</b> 张票据合并为一个 PDF，每张票据单独一页。确认无误后点「打印」。
      </div>
      <iframe id="rcFrame" src="${url}" style="width:100%;height:62vh;border:1px solid var(--line);border-radius:8px;background:#fff"></iframe>
      <div class="hint" style="margin-top:8px">
        提示：打印时建议纸张 A4、缩放「适合页边距」。若预览空白，点「新窗口打开」用浏览器自带 PDF 打印。
      </div>`, {
      size: 'wide',
      buttons: [
        { label: '关闭', cls: 'btn' },
        {
          label: '新窗口打开', cls: 'btn btn-ghost', onClick: () => {
            window.open(url, '_blank');
            return false;
          },
        },
        {
          label: '🖨 打印', cls: 'btn btn-primary', onClick: () => {
            const f = document.getElementById('rcFrame');
            try {
              f.contentWindow.focus();
              f.contentWindow.print();
            } catch (e) {
              toast('当前预览不支持直接打印，已在新窗口打开', 'warn');
              window.open(url, '_blank');
            }
            return false;
          },
        },
      ],
    });
  },

  async quickApprove(rid, projectId) {
    try {
      const all = await Api.get(`/api/projects/${projectId}/receipts`);
      const r = all.receipts.find((x) => x.id === rid);
      if (!r) return;
      await Api.post(`/api/receipts/${rid}/review`, { status: 'approved', reviewer: '当前用户', amount: r.amount, category: r.category });
      toast('已通过', 'ok');
      await this.loadReceiptCenter();
      await this.loadDashboard();
    } catch (e) { toast(e.message, 'err'); }
  },

  /* ==================== 设置 ==================== */
  renderSettings() {
    const s = this.state.settings;
    $('#set_meal_teacher').value = s.meal_teacher;
    $('#set_city_teacher').value = s.city_teacher;
    $('#set_student_ratio').value = s.student_ratio;
    $('#set_org_name').value = s.org_name || '';
    $('#set_currency_prefix').value = s.currency_prefix || '';
    $('#set_payee_name').value = s.payee_name || '';
    $('#set_payee_bank').value = s.payee_bank || '';
    $('#set_payee_account').value = s.payee_account || '';
    $('#set_mail_to').value = s.mail_to || '';
    $('#set_mail_from').value = s.mail_from || '';
    $('#set_mail_from_name').value = s.mail_from_name || '';
    $('#set_mail_smtp_host').value = s.mail_smtp_host || '';
    $('#set_mail_smtp_port').value = s.mail_smtp_port || '';
    $('#set_mail_smtp_secure').checked = String(s.mail_smtp_secure) !== '0';
    $('#set_mail_smtp_user').value = s.mail_smtp_user || '';
    // 授权码不下发，已配置时给占位掩码；留空即表示不修改
    $('#set_mail_smtp_pass').value = '';
    $('#set_mail_smtp_pass').placeholder = s.mail_smtp_pass_set ? '已保存（留空则不修改）' : '邮箱网页端生成的授权码，非登录密码';
    this.applySettingsScope(this.state.scope);
    this.renderMailStatus();
    this.renderDictLists();
    this.renderStdPreview();
  },

  /* 设置项作用域：带「全校统一」的项只有管理员能改，普通用户直接禁用，免得填了保存不上 */
  applySettingsScope(scope) {
    const locked = !!(scope && scope.global_locked);
    for (const id of ['set_meal_teacher', 'set_city_teacher', 'set_student_ratio', 'set_org_name', 'set_currency_prefix']) {
      const el = document.getElementById(id);
      if (el) el.disabled = locked;
    }
    const hint = $('#globalLockHint');
    if (hint) {
      hint.textContent = locked
        ? '带「全校统一」标记的报销标准由管理员维护，如需调整请联系管理员；「我的收款与发票邮箱」是你个人的设置，别人看不到。'
        : '';
    }
  },

  /* ---------- 发票邮件发送 ---------- */
  renderMailStatus() {
    const s = this.state.settings;
    const missing = [
      !s.mail_to && '收件人邮箱', !s.mail_from && '发件人邮箱',
      !s.mail_smtp_host && 'SMTP 服务器', !s.mail_smtp_user && 'SMTP 账号',
      !s.mail_smtp_pass_set && 'SMTP 授权码',
    ].filter(Boolean);
    const hint = $('#mailStatusHint');
    if (hint) {
      hint.textContent = missing.length ? '待完善：' + missing.join('、') : '已配置完成';
      hint.style.color = missing.length ? 'var(--warn, #b26a00)' : 'var(--ink-3)';
    }
  },

  async clearMailPass() {
    try {
      const r = await Api.put('/api/settings', { mail_smtp_pass: '__CLEAR__' });
      this.state.settings = r.settings;
      $('#set_mail_smtp_pass').value = '';
      $('#set_mail_smtp_pass').placeholder = '邮箱网页端生成的授权码，非登录密码';
      this.renderMailStatus();
      toast('已清除保存的授权码', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  },

  async testMail() {
    try {
      $('#btnTestMail').disabled = true;
      const r = await Api.post('/api/mail/test', {});
      toast('测试邮件已发往 ' + r.to, 'ok');
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      $('#btnTestMail').disabled = false;
    }
  },

  /** 项目详情页：把该项目的 PDF 发票逐张发到指定邮箱 */
  async sendProjectInvoices() {
    const d = this.state.detail;
    if (!d) return;
    const pdfs = d.receipts.filter((r) => /pdf/i.test(r.mime || '') || /\.pdf$/i.test(r.file_name || ''));
    const approved = pdfs.filter((r) => r.ocr_status === 'approved');
    const n = approved.length;
    if (!n) { toast('这个项目还没有已审核通过的 PDF 发票', 'warn'); return; }
    const s = this.state.settings;
    const to = s.mail_to || '';
    confirmDialog('发送发票到邮箱', `将把本项目 ${n} 张已审核通过的 PDF 发票作为附件，发送到 ${to || '（未配置收件人）'}。${pdfs.length > n ? `另有 ${pdfs.length - n} 张未审核票据不会发送。` : ''}`, async () => {
      try {
        const r = await Api.post(`/api/projects/${d.project.id}/send-invoices`, { onlyApproved: true });
        toast(`已发送 ${r.count} 张发票到 ${r.to}`, 'ok');
      } catch (e) { toast(e.message, 'err'); }
    });
  },

  /* ---------- 项目分类 / 费用科目：内置 + 自定义 ---------- */
  renderCategoryFilter() {
    const sel = $('#projCatFilter');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">全部分类</option>' +
      this.state.categories.map((c) => `<option value="${c.key}">${esc(c.label)}</option>`).join('');
    sel.value = cur;
  },

  renderDictLists() {
    const chip = (list, kind, extra) => list.map((x) => `
      <span class="tag gray" style="margin:2px 3px;display:inline-flex;align-items:center;gap:4px">
        ${esc(x.label)}${extra ? `<span style="opacity:.6;font-size:10.5px">${esc(extra(x))}</span>` : ''}
        ${x.custom ? `<a href="javascript:void(0)" onclick="App.delDictItem('${kind}','${esc(x.key)}')" style="color:var(--err);font-weight:700">×</a>` : ''}
      </span>`).join('');
    const catBox = $('#catList'), bkBox = $('#bucketList');
    if (catBox) catBox.innerHTML = chip(this.state.categories, 'categories', (x) => x.group || '');
    if (bkBox) bkBox.innerHTML = chip(this.state.buckets, 'buckets');
  },

  async addDictItem(kind) {
    const isCat = kind === 'categories';
    const label = $(isCat ? '#nc_label' : '#nb_label').value.trim();
    if (!label) { toast('请输入名称', 'warn'); return; }
    try {
      const body = { label };
      if (isCat) body.group = $('#nc_group').value.trim();
      const r = await Api.post(`/api/dict/${kind}`, body);
      $(isCat ? '#nc_label' : '#nb_label').value = '';
      if (isCat) $('#nc_group').value = '';
      await this.reloadDict(r);
      toast(`已添加「${label}」`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  },

  async delDictItem(kind, key) {
    try {
      const r = await Api.del(`/api/dict/${kind}/${encodeURIComponent(key)}`);
      await this.reloadDict(r);
      toast('已删除', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  },

  /** 字典变更后：刷新全局字典 + 筛选器 + 列表，并重载已打开的项目详情 */
  async reloadDict() {
    const s = await Api.get('/api/settings');
    this.state.settings = s.settings;
    this.state.categories = s.categories;
    this.state.buckets = s.buckets;
    this.renderCategoryFilter();
    this.renderDictLists();
    await this.renderProjectCards();
    if (this.state.currentId) await this.loadDetail(this.state.currentId);
  },

  renderStdPreview() {
    const meal = Number($('#set_meal_teacher').value) || 0;
    const city = Number($('#set_city_teacher').value) || 0;
    const ratio = Number($('#set_student_ratio').value) || 0;
    const days = 4;
    $('#stdPreview').innerHTML = `
      <div style="padding:12px 14px;background:var(--brand-soft);border-radius:8px;font-size:12.5px">
        <b style="color:var(--brand)">试算预览（按出差 4 天）</b>
        <div style="margin-top:7px;display:grid;grid-template-columns:repeat(2,1fr);gap:9px">
          <div>教师：餐费 ¥${money0(meal * days)} + 市交 ¥${money0(city * days)} = <b>¥${money0((meal + city) * days)}</b></div>
          <div>学生：餐费 ¥${money0(meal * ratio * days)} + 市交 ¥${money0(city * ratio * days)} = <b>¥${money0((meal + city) * ratio * days)}</b></div>
        </div>
      </div>`;
  },

  async saveSettings() {
    try {
      const r = await Api.put('/api/settings', {
        meal_teacher: $('#set_meal_teacher').value,
        city_teacher: $('#set_city_teacher').value,
        student_ratio: $('#set_student_ratio').value,
        org_name: $('#set_org_name').value.trim(),
        currency_prefix: $('#set_currency_prefix').value.trim(),
        payee_name: $('#set_payee_name').value.trim(),
        payee_bank: $('#set_payee_bank').value.trim(),
        payee_account: $('#set_payee_account').value.trim(),
        mail_to: $('#set_mail_to').value.trim(),
        mail_from: $('#set_mail_from').value.trim(),
        mail_from_name: $('#set_mail_from_name').value.trim(),
        mail_smtp_host: $('#set_mail_smtp_host').value.trim(),
        mail_smtp_port: $('#set_mail_smtp_port').value.trim(),
        mail_smtp_secure: $('#set_mail_smtp_secure').checked ? '1' : '0',
        mail_smtp_user: $('#set_mail_smtp_user').value.trim(),
        mail_smtp_pass: $('#set_mail_smtp_pass').value, // 留空表示不修改
      });
      this.state.settings = r.settings;
      toast('设置已保存，新标准立即生效', 'ok');
      this.renderStdPreview();
      this.renderMailStatus();
      if (this.state.currentId) await this.loadDetail(this.state.currentId);
    } catch (e) { toast(e.message, 'err'); }
  },

  /* ==================== 字典 ==================== */
  renderDictionary() {
    $('#periodTable').innerHTML = `
      <thead><tr><th>类型</th><th>名称</th><th>起止</th><th class="actions">操作</th></tr></thead>
      <tbody>${this.state.periods.map((p) => `
        <tr>
          <td>${p.kind === 'term' ? '<span class="tag green">学期</span>' : '<span class="tag gold">自然年</span>'}</td>
          <td>${esc(p.name)}</td>
          <td class="muted">${esc(p.start_date || '')} ~ ${esc(p.end_date || '')}</td>
          <td class="actions"><button class="btn btn-sm btn-ghost" style="color:var(--err)" onclick="App.deletePeriod(${p.id})">删除</button></td>
        </tr>`).join('')}</tbody>`;

    $('#collegeTable').innerHTML = `
      <thead><tr><th>学院</th><th>专业</th><th class="actions">操作</th></tr></thead>
      <tbody>${this.state.colleges.map((c) => {
      const ms = this.state.majors.filter((m) => m.college_id === c.id);
      return `<tr>
          <td style="vertical-align:top"><b>${esc(c.name)}</b></td>
          <td>${ms.length ? ms.map((m) => `<span class="tag gray" style="margin:1px 2px">${esc(m.name)} <a href="javascript:void(0)" onclick="App.deleteMajor(${m.id})" style="color:var(--err);margin-left:3px">×</a></span>`).join('') : '<span class="muted">暂无</span>'}</td>
          <td class="actions"><button class="btn btn-sm btn-ghost" style="color:var(--err)" onclick="App.deleteCollege(${c.id})">删除</button></td>
        </tr>`;
    }).join('')}</tbody>`;

    $('#m_college').innerHTML = '<option value="">选择学院</option>' +
      this.state.colleges.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  },

  async addPeriod() {
    const name = $('#p_name').value.trim();
    if (!name) { toast('请填写名称', 'warn'); return; }
    try {
      await Api.post('/api/periods', { kind: $('#p_kind').value, name, start_date: $('#p_start').value, end_date: $('#p_end').value });
      $('#p_name').value = ''; $('#p_start').value = ''; $('#p_end').value = '';
      toast('已添加', 'ok');
      await this.loadDictionary();
      this.renderDictionary();
    } catch (e) { toast(e.message, 'err'); }
  },

  async deletePeriod(id) {
    confirmDialog('删除期间', '删除后已有项目将不再关联该期间。', async () => {
      await Api.del('/api/periods/' + id);
      await this.loadDictionary(); this.renderDictionary(); toast('已删除', 'ok');
    });
  },

  async addCollege() {
    const name = $('#c_name').value.trim();
    if (!name) { toast('请填写学院名称', 'warn'); return; }
    try {
      await Api.post('/api/colleges', { name });
      $('#c_name').value = '';
      await this.loadDictionary(); this.renderDictionary();
      toast('学院已添加', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  },

  async deleteCollege(id) {
    confirmDialog('删除学院', '该学院下的所有专业也会一并删除。', async () => {
      await Api.del('/api/colleges/' + id);
      await this.loadDictionary(); this.renderDictionary(); toast('已删除', 'ok');
    });
  },

  async addMajor() {
    const name = $('#m_name').value.trim();
    const cid = $('#m_college').value;
    if (!cid) { toast('请选择所属学院', 'warn'); return; }
    if (!name) { toast('请填写专业名称', 'warn'); return; }
    try {
      await Api.post('/api/majors', { college_id: cid, name });
      $('#m_name').value = '';
      await this.loadDictionary(); this.renderDictionary();
      toast('专业已添加', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  },

  async deleteMajor(id) {
    confirmDialog('删除专业', '确定删除该专业吗？', async () => {
      await Api.del('/api/majors/' + id);
      await this.loadDictionary(); this.renderDictionary(); toast('已删除', 'ok');
    });
  },
};

/* 设置页实时试算 */
document.addEventListener('DOMContentLoaded', () => {
  ['set_meal_teacher', 'set_city_teacher', 'set_student_ratio'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => App.renderStdPreview());
  });
  App.init();
  // 暴露到 window，便于调试与自动化测试
  window.App = App;
  window.Api = Api;
});