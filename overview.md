# 天津仁爱学院报销系统 · 交付说明

## 一、需求对照

| # | 原始需求 | 实现情况 | 位置 |
|---|---|---|---|
| 1 | 学期和自然年 | ✅ `periods` 表，seed 2 学期 + 1 自然年，支持增删改 | 「基础设置」 |
| 2 | 学院、专业、建设 | ✅ `colleges` / `majors` 表，seed 4 学院 11 专业 | 「字典维护」 |
| 3 | 报销项目：科研、教学（教改、师资培训）、竞赛 | ✅ 5 类（`research`/`reform`/`training`/`competition`/`other`），各有编号前缀 SP/JG/PX/JS/QT | 「报销项目」 |
| 4 | 是否有差旅标识 | ✅ `projects.has_travel`，决定走双表还是单表流程 | 新建项目表单 |
| 5 | 教师：姓名/专业/工号/电话 | ✅ `members` 表，`type='teacher'` | 步骤 2「成员管理」 |
| 6 | 学生：姓名/专业/学号/电话 | ✅ `members` 表，`type='student'` | 步骤 2「成员管理」 |
| 7 | 差旅按工作区两个模板生成最终表 | ✅ 逆向模板 XML，复刻 11 列网格 + 合并结构 + 纵向表头 | `lib/docx.js`、`lib/xlsx.js` |
| 8 | 无差旅生成单个表 | ✅ 仅导出资金申请单 | 步骤 4「报表」 |
| 9 | 教师餐 100/天、市交 80/天 | ✅ `meal_teacher=100`、`city_teacher=80`，设置页可改 | 「基础设置」 |
| 10 | 学生减半 | ✅ `student_ratio=0.5`，按比例计算 | `lib/calc.js` |
| 11 | 上传票据 + OCR 识别重要信息入库 | ✅ 可插拔 OCR 适配层，抽取 6 个字段 + 建议科目 | 步骤 3「票据」 |
| 12 | **填入前人工审核** | ✅ 三态 `pending`/`approved`/`rejected`，只有 approved 归集计入金额 | 步骤 3 审核卡 + 「票据中心」 |
| 13 | 批量导入票据 | ✅ CSV 导入，支持中英文表头别名，附模板下载 | 步骤 3「批量导入」 |

---

## 二、界面

| 截图 | 说明 |
|---|---|
| `docs/ui-dashboard.png` | 工作台：统计卡片 + 待审票据 + 最近项目 |
| `docs/ui-projects.png` | 报销项目列表，按分类分组 |
| `docs/ui-detail.png` | 项目详情 · 成员管理步骤 |
| `docs/ui-receiptsStep.png` | 项目详情 · 票据步骤（含待审卡片） |
| `docs/ui-report.png` | 项目详情 · 报表步骤（差旅明细表预览） |
| `docs/ui-receipts.png` | 票据中心：全局待审队列 |
| `docs/ui-settings.png` | 基础设置：补助标准与收款单位 |
| `docs/ui-dictionary.png` | 字典维护：学院 / 专业 / 期间 |

**设计基调**：学院蓝 `#1a5f7a` + 财务金 `#b8860b`，左侧渐变导航，卡片化布局，
带完整打印样式（`@page size: A4 landscape`，报表所见即所得）。

---

## 三、流程

```
新建项目（选分类 / 定是否有差旅）
   ├─ 无差旅 ────────────────┐
   └─ 有差旅                 │
       ↓                     │
   步骤1 填行程              │
       ↓                     │
   步骤2 填成员 ─────────────┤
       ↓                     │
   步骤3 上传票据 → OCR → 人工审核 ← 批量导入
       ↓                     ↓
   步骤4 预览报表 → 导出 docx + xlsx
```

---

## 四、关键设计决策

### 1. 零第三方依赖

学校内网机器通常装不了编译工具链，零依赖意味着「拷贝目录 + 装 Node.js 就能跑」。
手写的轮子与替代对象：

| 手写模块 | 替代 | 规模 |
|---|---|---|
| `lib/zip.js`（deflateRaw + 自实现 CRC32） | archiver / jszip | 约 90 行 |
| `lib/docx.js`（WordprocessingML） | docx | 约 300 行 |
| `lib/xlsx.js`（SpreadsheetML + inlineStr） | exceljs / xlsx | 约 260 行 |
| `index.js` 的 `parseMultipart` | multer / busboy | 约 80 行 |
| Node 22 内置 `node:sqlite` | better-sqlite3 | — |

`node:sqlite` 这个选择尤其关键：避免了 `better-sqlite3` 在 Windows 上需要 MSVC/Python 的原生编译失败。

### 2. OCR 是插件，不是实现

```js
runOcr(buffer, mime, fileName, hint) -> { fields, category, engine, raw }
```

默认 `offline-draft` 引擎（文件名抽金额日期 + 正则抽字段 + 关键词猜科目），
作用是**先把「上传 → 识别 → 审核 → 归集 → 计算 → 导出」整条链路跑通**。
接真实 OCR（百度/腾讯/TextIn）只需替换 `runOcr` 实现，其余逻辑零改动。

> 底线设计：**任何引擎的输出一律先落 `pending`**，机器只负责"读"，"信"必须由人。
> 这是财务系统与普通 OCR 应用的本质区别。

### 3. 费用计算保留可核对性

金额列写 `100*4` 而不是 `400`，让财务能一眼看出这个数怎么来的。
涉及成员级定额覆盖（`meal_rate` / `city_rate`）时尤其重要。

### 4. 导出件必须独立验证

docx/xlsx 是给财务用的，格式错一位就废一张单子。
`verify_exports.py` **不复用本项目任何代码**，用 `python-docx` / `openpyxl` 从零解析，
并**反解人民币大写中文**再与数字金额对撞，验证完整等式链：

```
明细行各列和 → 行小计 → 汇总小计 → 合计 → 人民币大写 → ¥ 金额
```

---

## 五、开发过程中修掉的真实缺陷

这些都是测试逼出来的，不是假想的：

| 缺陷 | 现象 | 根因 |
|---|---|---|
| 人民币大写漏「零」 | `10001 → 壹万壹元整` | 用 `seg.length < 4` 判断，但 `padStart(4,'0')` 让长度失真；改按数值 `val < 1000` 判定 |
| SQLite 字符串双引号 | `no such column: "pending"` | SQLite 里 `"x"` 是标识符不是字符串；改 `CASE ocr_status WHEN 'pending' THEN 0` |
| 设置返回字符串 | 前端计算隐患 | `getAllSettings()` 加 `NUMERIC_SETTINGS` 集合转 Number |
| 合计行金额缺小数 | 导出 `¥3805 元` | `f2()` 对整数故意不带小数（表格用），合计行须用 `toFixed(2)` |
| 其他费用金额列脆弱 | 正则误抓 | 直接用 `otherTotal`，不再从文本反解 |
| xlsx 合并区重复 | `merge count:29 unique:19` | Excel 不允许重复/交叠 mergeCell；`[...new Set(merges)]` |
| 起讫地点丢失 | 预览与 docx 漏列「天津⇄合肥」 | `computeProject` 不接收行程上下文；加 `opts.route` 并由 `getProject` 传入主行程 |
| 保存后被甩到别的步骤 | 填完行程跳走，UX 断裂 | `loadDetail` 加 `keepStep` 参数 |
| 成员天数默认 0 | 每人要手填天数 | 新增成员时自动带入行程天数 |
| smoke 测试 8 项连锁失败 | 后续用例金额全错 | 测试改了 `city_teacher` 却只复原 `meal_teacher`；补复原 + 加断言 |
| 端口占用与 db 锁 | 改代码不生效 | 新建 `restart.js`：`netstat` 找 PID → `taskkill /F /PID` → detached 拉起 → 健康轮询 |

---

## 六、测试结果

```
npm test              → PASS 56 / FAIL 0   （12 组 API 端到端）
npm run test:ui       → ALL PASS           （11 组无头 Chrome 真实点击，JS 错误：无）
npm run verify:export → PASS 40 / FAIL 0   （python-docx / openpyxl 独立解析交叉校验）
```

导出校验关键输出：

```
小计行: ['382', '2343', '600', '480', '0', '3805']
合计行: 人民币：叁仟捌佰零伍元整    ¥3805.00 元
ok   大写「叁仟捌佰零伍元整」== 3805.0
ok   各明细行小计之和 == 汇总小计
--- 明细行「刘海斌」--- 交通=109.0 住宿=1743.0 伙食=400.0(100*4) 市交=320.0(80*4) 其他=0.0 合计=2572.0
--- 明细行「张小明」--- 交通=273.0 住宿=600.0 伙食=200.0(50*4) 市交=160.0(40*4) 其他=0.0 合计=1233.0
```

XSS 防护已验证：注入 `<img src=x onerror=alert(1)>` 未被执行。

---

## 七、启动

```
双击  启动报销系统.bat
或    npm start
```
访问 <http://127.0.0.1:5180>　　（需 Node.js ≥ 22）

演示数据：`node --experimental-sqlite server/demo_data.js`（5 个项目覆盖全部分类）

---

## 八、后续建议

1. **接真实 OCR 服务**——改 `lib/ocr.js` 的 `runOcr` 即可，其余不用动
2. **加登录鉴权**——当前单机无鉴权，内网可接受，公网需自行补一层
3. **审批流**——目前到「导出」为止，若需要「提交 → 院系审批 → 财务审核」可加 `status` 状态机
4. **票据查重**——同一发票号重复上传可加唯一约束
5. **Excel 直读**——批量导入目前走 CSV，可加 xlsx 解析直接吃 Excel