# 天津仁爱学院报销系统

一套零第三方依赖的报销管理系统：**原生 Node.js 后端 + SQLite 数据库 + 原生 JS 前端 SPA**。
差旅类项目按学校模板导出《差旅费报销明细表》（docx）与《资金申请单》（xlsx），
非差旅类项目导出单个资金申请单。票据支持上传 OCR 识别，**识别结果须人工审核后才计入报销**。

![工作台](docs/ui-dashboard.png)

---

> 📖 **给使用者的操作手册**：[docs/使用说明.md](docs/使用说明.md)
> 要打印或发给同事：打开 [docs/使用说明.html](docs/使用说明.html)（单文件、含截图、可一键打印为 PDF）

---

## 快速开始

> 📦 **要部署到云服务器？** 看 **[deploy/DEPLOY.md](deploy/DEPLOY.md)**
> 一键部署：`sudo bash deploy/deploy.sh --domain your.domain.com`
> （Linux/阿里云/腾讯云；Windows Server 用 `deploy\deploy.ps1`）

### 方式一：双击启动（推荐给非技术同学）

```
启动报销系统.bat
```

脚本会检查 Node.js 是否安装且版本 ≥ 22，3 秒后自动打开浏览器，访问 <http://127.0.0.1:5180>。

> ⚠️ **请勿直接双击 `server/public/index.html`**
> 双击 HTML 走的是 `file://` 协议，连不上后台数据库，只会看到一片空白。
> 系统检测到这种打开方式会弹窗提示正确入口。

### 方式二：命令行

```bash
npm start        # 启动服务（等价于 node --experimental-sqlite server/index.js）
npm restart      # 强制重启（先杀占用 5180 端口的旧进程，解决 db 文件锁）
npm stop         # 停止服务
```

> **必须使用 Node.js ≥ 22**：数据库层用的是 Node 22 内置的 `node:sqlite`（实验特性），
> 通过 `--experimental-sqlite` 标志启用。这样做是为了避免 `better-sqlite3` 在 Windows 上的原生编译失败。
> 启动脚本与 `package.json` 里都已带上该标志，**不需要**自己拼命令。

### 灌入演示数据（可选）

```bash
node --experimental-sqlite server/demo_data.js
```

生成 5 个覆盖全部分类的演示项目：合肥培训差旅、智能硬件教改、智能感知科研、智能汽车竞赛、数字孪生草稿。

---

## 功能清单

### 1. 基础设置
- **期间**：支持「学期」与「自然年」两种口径，seed 了 2 个学期 + 1 个自然年
- **学院 / 专业**：4 个学院、11 个专业，已做种子数据，可维护
- **统一收款单位信息**：单位名称、部门、账户等，作为资金申请单默认值

### 2. 报销项目
九类项目，每类有独立的项目编号前缀（分类可在「设置」页自行增删）：

| 类别 | key | 编号前缀 | 说明 |
|---|---|---|---|
| 科研 | `research` | `KY` | 科学研究项目 |
| 教学 | `teaching` | `JX` | 教学运行项目 |
| 教改 | `reform` | `JG` | 教学改革项目 |
| 师资培训 | `training` | `SP` | 教师培训项目 |
| 竞赛 | `competition` | `JS` | 学生竞赛项目 |
| 办公用品 | `office` | `BG` | 办公用品采购 |
| 耗材采购 | `consumable` | `HC` | 实验/办公耗材采购 |
| 设备采购 | `equipment` | `SB` | 仪器设备采购 |
| 维修维保 | `maintenance` | `WB` | 设备维修与维保 |

创建项目时指定：**名称 / 类别 / 负责人 / 起止日期 / 是否有差旅**。

**费用科目**（票据归集口径）同样可在「设置」页增删，内置 12 项：
城市间交通费 / 住宿费 / 市内交通费 / 其他费用 / 耗材费 / 办公用品费用 / 打印费 /
维修维保费用 / 论文版面费 / 专利服务费 / 技术服务费 / 项目外协费。
差旅表前四栏之外的科目统一归入「其他费用」，明细按真实科目名列示。

### 3. 差旅管理
- 一个项目可含**多条行程**（出发地 ⇄ 目的地、起止日期），天数自动计算（**含首尾**）
- 主行程的「起讫地点」会自动带入报销明细表每一行

### 4. 成员管理
- 教师：姓名、专业、工号、电话
- 学生：姓名、专业、学号、电话
- 成员可**单独覆盖**个人的餐费定额与市内交通定额（默认继承全局设置）
- 无差旅项目，成员只需填姓名与专业即可

### 5. 差旅补助标准（可配置）

| 项目 | 教师 | 学生 |
|---|---|---|
| 伙食补助费 | 100 元/天 | 50 元/天（减半） |
| 市内交通费 | 80 元/天 | 40 元/天（减半） |

- 标准在「基础设置」页统一调整，保存后立即对所有项目生效
- `student_ratio` 默认 `0.5`，可改
- 报表中金额列保留 `100*4` 这样的**计算表达式**，方便财务逐行核对

### 6. 票据与 OCR
- **单张上传**：支持图片与 PDF。识别引擎输出 `invoice_no / amount / invoice_date / tax_no / vendor / itinerary` 与建议科目
- **人工审核是硬门槛**：任何引擎的识别结果一律落库为 `pending`，**审核通过（approved）后才归集进 `receipt_items` 计入报销金额**；`rejected` 的票据完全不影响计算
- **批量导入**：CSV 导入（可从「下载模板」拿表头），支持中英文表头别名
- **票据中心**：全局待审队列，支持快速通过/驳回

### 7. 报表导出

| 项目类型 | 导出物 |
|---|---|
| 有差旅 | 《差旅费报销明细表》.docx（横向 A4，11 列）+ 《资金申请单》.xlsx |
| 无差旅 | 《资金申请单》.xlsx |

- 差旅明细表完全复刻学校模板：合并单元格、纵向表头、列合计行、合计行（人民币大写 + ¥ 金额）
- 导出记录写入 `exports` 表，可在报表步骤追溯

---

## 目录结构

```
天津仁爱学院报销/
├── 启动报销系统.bat          # Windows 一键启动
├── package.json              # 零依赖，仅 scripts
├── data/reimbursement.db     # SQLite 数据库（首次启动自动建表 + 种子）
├── exports/                  # 导出的 docx / xlsx 落盘目录
├── docs/                     # 界面截图
│
├── server/
│   ├── index.js              # 零依赖 HTTP 服务器 + 手写 multipart 解析
│   ├── restart.js            # Windows 启停助手（netstat + taskkill）
│   ├── demo_data.js          # 演示数据生成
│   ├── smoke.js              # API 端到端测试（59 项，自清理不留测试数据）
│   ├── ui_smoke.js           # 无头 Chrome 真实点击烟测（11 组，自清理）
│   ├── cleanup.js            # 清理测试数据与孤儿上传文件（--dry 演练）
│   ├── shot.js               # 界面截图工具
│   ├── verify_exports.py     # 用 python-docx / openpyxl 独立校验导出件
│   │
│   ├── lib/
│   │   ├── db.js             # 数据层：13 张表 + 种子数据
│   │   ├── api.js            # 全部业务 API
│   │   ├── calc.js           # 费用计算（伙食/市交/天数）
│   │   ├── money.js          # 金额格式化 + 人民币大写
│   │   ├── ocr.js            # 可插拔 OCR 适配层 + CSV 解析
│   │   ├── zip.js            # 手写 ZIP 写入器（deflateRaw + CRC32）
│   │   ├── docx.js           # WordprocessingML 生成
│   │   └── xlsx.js           # SpreadsheetML 生成
│   │
│   └── public/               # 前端 SPA（无框架、无 CDN）
│       ├── index.html
│       ├── __shot.html       # 截图专用入口
│       ├── css/app.css       # 设计系统 + 打印样式
│       └── js/
│           ├── api.js        # fetch 封装、$ / esc / money / toast / modal
│           └── app.js        # 主应用对象 App，6 个视图
│
└── 合肥培训差旅费明细表.docx            # 需求方提供的模板（只读参考）
    天津仁爱学院资金申请单-合肥培训.xlsx  # 需求方提供的模板（只读参考）
```

---

## 测试

```bash
npm test              # API 端到端：56 项
npm run test:ui       # 无头 Chrome UI 烟测：11 组，含 XSS 转义与 JS 错误捕获
npm run verify:export # 独立解析导出的 docx/xlsx：40 项财务等式交叉校验
```

### 为什么有三套测试

导出件是给财务用的，格式错一位就废一张单子。所以 `verify_exports.py` **不复用**本项目的代码，
而是用 `python-docx` / `openpyxl` 从零解析 docx/xlsx，并**反解人民币大写中文**再与数字金额对撞：

```
小计行: ['382', '2343', '600', '480', '0', '3805']
合计行: 人民币：叁仟捌佰零伍元整    ¥3805.00 元
ok   大写「叁仟捌佰零伍元整」== 3805.0
ok   各明细行小计之和 == 汇总小计
--- 明细行「刘海斌」--- 交通=109.0 住宿=1743.0 伙食=400.0(100*4) 市交=320.0(80*4) 其他=0.0 合计=2572.0
--- 明细行「张小明」--- 交通=273.0 住宿=600.0 伙食=200.0(50*4) 市交=160.0(40*4) 其他=0.0 合计=1233.0
```

完整的等式链：**明细行各列和 → 行小计 → 汇总小计 → 合计 → 人民币大写 → ¥ 金额**，六者必须全等。

---

## 技术说明

### 为什么零依赖

报销系统要长期在学院内网机器上跑，那台机器往往装不了编译工具链。零依赖意味着：
拷贝目录 + 装个 Node.js 就能跑，不会因为 `node-gyp`、Python、MSVC 缺失而卡住。

代价是手写了一些轮子，都是为了这个目标：

| 手写模块 | 替代了什么 | 为什么 |
|---|---|---|
| `lib/zip.js` | `archiver` / `jszip` | docx 与 xlsx 本质都是 ZIP 容器，`zlib.deflateRawSync` + 自实现 CRC32 就够了（几十行） |
| `lib/docx.js` | `docx` npm 包 | OOXML 就是拼 XML 字符串，模板结构固定后反而更可控 |
| `lib/xlsx.js` | `exceljs` / `xlsx` | 用 `inlineStr` 内联字符串，省掉 sharedStrings 的一堆边界情况 |
| `index.js` 的 `parseMultipart` | `multer` / `busboy` | 只支持本系统用到的表单字段 + 多文件，够用 |
| `node:sqlite` | `better-sqlite3` | 避开 Windows 原生编译 |

### OCR 接入

`server/lib/ocr.js` 是**可插拔适配层**，统一签名：

```js
runOcr(buffer, mime, fileName, hint) -> { fields, category, engine, raw }
```

默认挂的是 `offline-draft` 引擎（纯离线：文件名抽金额日期 + 正则抽字段 + 关键词猜科目），
它的作用是**让整条审核链路先跑通**，不是替代真实 OCR。

接真实引擎只需替换 `runOcr` 的实现，把百度 / 腾讯 / TextIn 的调用包进去即可，
其余的落库、人工审核、费用归集逻辑完全不用动。

> 关键设计：**无论哪个引擎，输出一律先落 `pending` 状态**。
> 这是财务系统的底线——机器只负责"读"，"信"必须由人来。

### 费用计算规则

```
伙食补助费 = 每日餐费 × 出差天数      （教师取 meal_teacher，学生取 meal_teacher × student_ratio）
市内交通费 = 每日补助 × 出差天数      （教师取 city_teacher，学生取 city_teacher × student_ratio）
城市间交通费 = 已审核票据归集         （BUCKETS.transport）
住宿费       = 已审核票据归集         （BUCKETS.hotel）
其他费用     = 已审核票据归集         （BUCKETS.other）
```

天数**含首尾**（7 月 1 日至 7 月 4 日 = 4 天）。
成员表单新增时会**自动带入行程天数**，一般不需要手改。

### 安全

- 所有用户输入渲染前经 `esc()` HTML 转义；UI 烟测专门注入了 `<img src=x onerror=alert(1)>` 验证未执行
- SQL 全部使用参数绑定
- 不硬编码任何密钥

---

## 已知限制

1. **OCR 目前是离线 draft 引擎**，只能从文件名与文本里正则抽信息，识别不了真实票据图像。上生产需要接 OCR 服务。
2. **单机单用户**，内网部署可接受。放到公网时**必须设置 `AUTH_USER` / `AUTH_PASS` 开启访问鉴权**（见 `deploy/DEPLOY.md`）。
3. **不支持多人并发编辑**同一项目（`node:sqlite` 单写者模型），演示规模下无感。
4. **批量导入为 CSV**，Excel 文件需另存为 CSV（UTF-8）后再导入。
5. 金额一律以「元」为单位两位小数，不处理外汇与汇率。

---

## 云端部署

完整手册见 **[deploy/DEPLOY.md](deploy/DEPLOY.md)**。

```bash
# Linux / 阿里云 ECS / 腾讯云 CVM
scp -r 项目目录/ root@你的公网IP:/tmp/reimburse
ssh root@你的公网IP
cd /tmp/reimburse && sudo bash deploy/deploy.sh --domain reimburse.example.com
```

脚本自动完成：Node 检测安装 → 建系统用户与 700 权限数据目录 → 同步代码 → 生成强随机密码 →
注册 systemd（带安全加固）→ 配 Nginx 反代 → 放行 80/443 → 健康检查。**幂等，可重复执行以升级。**

```powershell
# Windows Server
powershell -ExecutionPolicy Bypass -File deploy\deploy.ps1 -AuthUser admin -AuthPass 'xxx'
```

| 文件 | 作用 |
|---|---|
| `deploy/deploy.sh` | Linux 一键部署（8 步，含升级前自动备份） |
| `deploy/deploy.ps1` | Windows 一键部署（NSSM 注册服务） |
| `deploy/backup.sh` | 数据备份/恢复（事务一致快照，含校验） |
| `deploy/render_nginx.py` | Nginx 模板渲染（支持剔除 HTTPS 块） |
| `deploy/nginx.conf.template` | Nginx 反代模板（含安全响应头） |
| `deploy/reimburse.service` | systemd unit（已做安全加固） |

**三条硬性要求**：
1. **必须挂数据盘** — 系统盘会因重装/故障被清空，`DATA_DIR` 指向云盘
2. **必须配 HTTPS** — 票据是财务凭证，Basic Auth 密码在 HTTP 下逐跳明文
3. **域名必须 ICP 备案** — 大陆服务器强制要求

**安全设计**：5180 只监听 `127.0.0.1`，公网必须经 Nginx。即便安全组配错、有人扫端口也访问不到应用。

---

## 常见问题

**Q：双击 bat 闪退？**
检查 Node.js 是否安装。`node -v` 必须 ≥ v22.0.0，低于 22 缺少 `node:sqlite`。

**Q：改了代码不生效 / 提示端口占用？**
`npm restart`。旧进程会占着 5180 端口并锁住 db 文件，`restart.js` 会先杀掉再拉起。

**Q：想清空演示数据重来？**
停服务后删除 `data/reimbursement.db`，下次启动会重新建表并灌种子数据。

**Q：导出打不开？**
用 Word / Excel 打开确认。若被安全软件拦截，把 `exports/` 目录加白名单。