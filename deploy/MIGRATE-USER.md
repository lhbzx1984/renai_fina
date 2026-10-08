# 重新部署 + 只迁移「刘海斌」的数据（其他用户不受影响）

这份手册解决的是：**服务器重新部署一套新系统，只把刘海斌（`lhbzx1984`）的项目、票据、
邮箱配置搬过去，服务器上已有的其他老师一个字节都不动。**

> 另一个工具 `import-bundle.sh` 是**整库替换**——它会把目标库整个换掉，别人的账号和数据
> 全没了。只要目标机上还有别人在用，就**不要**用它，用本手册这套。

---

## 一、两套工具怎么选

| 场景 | 用什么 | 后果 |
|---|---|---|
| 目标机是**全新空库**、且以后也只有这一个人用 | 两套都行 | — |
| 目标机上**已有其他用户/项目** | **必须**用 `export-user.js` + `import-user.js` | 只追加，不覆盖 |
| 想把整台机器原样复制过去 | `export-bundle.js` + `import-bundle.sh` | 目标库被整体替换 |

**核心区别**：单用户迁移是**合并**不是替换。源库的 id 会在目标库里重新分配，
子表外键跟着改，别人的行一个都不碰。

---

## 二、迁移什么 / 不迁什么

| 内容 | 是否迁移 | 说明 |
|---|---|---|
| 用户账号 + 密码哈希 | ✅ | **原密码继续有效**，不用重置 |
| 该用户名下的项目 / 行程 / 成员 / 票据 / 分摊明细 | ✅ | 按 `owner_user_id` 筛 |
| 票据原件 PDF | ✅ | 目标机已有同名文件则跳过，不覆盖 |
| 已导出的表单（docx/xlsx） | ✅ | 路径改写为目标机 `EXPORT_DIR` |
| 该用户的**个人设置**（SMTP、收款人…） | ✅ | 只挂在他名下，别人看不到 |
| 周期 / 学院 / 专业字典 | ✅ 按**名称**对齐 | 缺的自动补建（见下方"坑"） |
| **全局设置**（报销标准、单位名称） | ❌ 默认不导 | 写了会影响所有人，确认空库才加 `--with-global` |
| 其他用户的数据 | ❌ 完全不碰 | 导入前后会逐项核对 |

---

## 三、完整步骤

### 步骤 1 · 全新部署一套系统（目标机）

```bash
# 方式 A：从本机一键推（推荐，Git Bash 里跑）
bash deploy/onekey.sh --host 121.43.27.73 --port 18080

# 方式 B：已经在服务器上，直接跑
sudo bash deploy/deploy.sh --port 18080
```

部署完先访问一次页面（或 `systemctl start reimburse` 后等 3 秒），**让系统自己把表建好、
把学院/专业/学期字典 seed 进去**——导入脚本依赖这些字典按名称对齐。

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5180/api/health   # 期望 200
```

### 步骤 2 · 本机导出刘海斌的数据

```bash
# Windows Git Bash / macOS / Linux 都在项目根目录跑
npm run migrate:export-user -- --user lhbzx1984

# 等价于
node deploy/migrate/export-user.js --user lhbzx1984
```

输出目录 `deploy/migrate/_user_lhbzx1984/`：

```
data.json           ← 用户 + 项目 + 行程 + 成员 + 票据 + 明细 + 导出记录 + 个人设置
manifest.json       ← 清单（含 sha256，便于核对）
uploads/            ← 16 份票据原件
exports/            ← 已导出的表单
import-user.js      ← 导入脚本（自包含，一起传上去）
```

> 想连**全局报销标准**一起带（仅在目标机是空库时才该这么干）：
> `node deploy/migrate/export-user.js --user lhbzx1984 --with-global`

打包上传：

```bash
cd deploy/migrate
MSYS_NO_PATHCONV=1 tar -czf reimburse-user.tar.gz -C _user_lhbzx1984 .
scp reimburse-user.tar.gz root@121.43.27.73:/opt/
```

### 步骤 3 · 服务器上导入

```bash
ssh root@121.43.27.73
source /etc/reimburse/env          # 拿到 DATA_DIR / EXPORT_DIR

mkdir -p /opt/reimburse-user && tar -xzf /opt/reimburse-user.tar.gz -C /opt/reimburse-user
systemctl stop reimburse           # 写库前必须停服务

# ① 先演练，看它打算动什么（不写库、不拷文件）
node /opt/reimburse-user/import-user.js \
  --bundle /opt/reimburse-user --target "$DATA_DIR" --dry

# ② 确认无误再真跑
node /opt/reimburse-user/import-user.js \
  --bundle /opt/reimburse-user --target "$DATA_DIR"

systemctl start reimburse
```

脚本会自己做的事：备份目标库（`<db>.bak-<时间戳>`）→ 建用户 → 对齐字典 →
写项目/行程/成员/票据 → 挂个人设置 → 拷票据原件与表单 → 逐项核对。

### 步骤 4 · 核对

脚本最后会打印对照表，全 `[OK ]` 就是没问题：

```
  [OK ] users     2 → 3  (新增 1)
  [OK ] projects  1 → 5  (新增 4)
  [OK ] receipts  1 → 17  (新增 16)
  [OK ] members   0 → 6  (新增 6)
  [OK ] trips     0 → 4  (新增 4)
  [OK]   其他用户的项目 1 → 1 个，导入前后一致，未被影响
  [OK]   用户 #3 名下现有项目 4 个
  票据金额 ￥9916.78
  [OK]   该用户所有票据原件在磁盘上齐全

  核对通过：数据已合并，其他用户未受影响
```

人工再确认两件事：

```bash
# ① 用刘海斌原来的密码能不能登录（密码哈希跟着迁，不用重置）
curl -si -u "$AUTH_USER:$AUTH_PASS" -X POST http://127.0.0.1:5180/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"account":"lhbzx1984","password":"他的原密码"}' | grep -i '^set-cookie'

# ② 别人的账号还能不能正常登录（说明没被波及）
```

---

## 四、三个必须注意的坑

**① 字典 id 不能照搬**
源库 `college_id=1` 可能是「数智传媒与设计艺术学院」，目标库 `college_id=1` 却可能是
「机械与动力工程学院」。照搬 id 会把项目挂到完全不相干的学院。
脚本一律**按名称**匹配：学院 → 专业（专业挂在学院下，先落父级再匹配），
缺的同名项自动补建（只是多一个可选项，不动任何人的既有数据）。
不想补建就加 `--no-dict-insert`（缺失项会置空并告警）。

**② 项目按编号（code）查重，默认跳过**
目标库里已有 `SP-2026-003` 时，默认**跳过**不覆盖——这是保护线上数据的默认行为。
确实要用包里的版本覆盖，加 `--replace`（只删这一个项目及其级联数据，别人的不受影响）。
重复执行是安全的：第二次跑只会全部跳过，不会产生重复数据。

**③ 用户已存在时默认不改密码**
如果目标机上 `lhbzx1984` 已经存在，脚本**保留目标库现有密码**，只补空资料字段。
要强制同步源库密码才加 `--reset-pass`。

---

## 五、参数速查

### 导出（`export-user.js`，旧机器）

| 参数 | 默认 | 作用 |
|---|---|---|
| `--user <用户名或id>` | `lhbzx1984` | 迁谁 |
| `--out <目录>` | `deploy/migrate/_user_<user>` | 输出到哪 |
| `--with-global` | 关 | 连全局设置一起导（会改所有人标准，慎用） |
| `--no-exports` | 关 | 不搬已导出表单 |
| `--src-dir <目录>` | `data` | 源数据目录 |

### 导入（`import-user.js`，服务器）

| 参数 | 默认 | 作用 |
|---|---|---|
| `--bundle <目录>` | `.` | 迁移包目录 |
| `--target <目录或.db>` | `/var/lib/reimburse` | 目标库 |
| `--export-dir <目录>` | `$EXPORT_DIR` 或 `<target>/exports` | 表单落地目录 |
| `--dry` | 关 | 只演练，不写库不拷文件 |
| `--replace` | 关 | 编号冲突时用包里的覆盖 |
| `--reset-pass` | 关 | 覆盖已存在用户的密码 |
| `--with-global` | 关 | 写入全局设置 |
| `--no-dict-insert` | 关 | 缺字典时不补建，置空 |
| `--init --code-dir <目录>` | — | 目标库不存在时先初始化建表 |

---

## 六、回滚

导入前会自动备份目标库，回滚就是把它换回去：

```bash
systemctl stop reimburse
BAK=$(ls -t /var/lib/reimburse/reimburse.db.bak-* | head -1)
mv "$BAK" /var/lib/reimburse/reimburse.db
chown reimburse:reimburse /var/lib/reimburse/reimburse.db
systemctl start reimburse
```

---

## 七、收尾别忘了

1. **删掉服务器上的迁移包**：里面有真实数据库和邮箱授权码。
   `rm -rf /opt/reimburse-user /opt/reimburse-user.tar.gz`
2. 本机 `deploy/migrate/_user_*/` 已被 `.gitignore` 忽略，不会进 Git；确认迁移成功后可以删掉。
3. 刘海斌登录后到**设置 → 发票邮件发送**点一次「发送测试邮件」，验证 163 授权码在新机器上能用。
   （阿里云 ECS 默认封 25 端口出网，我们走 465，一般没问题。）
