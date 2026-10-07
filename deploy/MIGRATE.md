# 数据迁移手册（旧机器 → 服务器）

把本机 `data/` 里的业务数据迁到服务器：**数据库 + 邮箱配置 + 票据原件 + 导出表单**。

---

## 一、迁移什么 / 不迁什么

| 内容 | 是否迁移 | 说明 |
|---|---|---|
| 项目、票据、成员、行程 | ✅ | 业务主体数据 |
| 用户账号（含密码哈希） | ✅ | **原密码继续有效**，不用重置 |
| 邮箱 SMTP 配置 | ✅ | 在 `settings` 表里，随库走 |
| 票据原件 PDF | ✅ | 只搬被 `receipts` 引用到的 |
| 导出表单 docx/xlsx | ✅ | **路径会被改写**，见下 |
| 会话 sessions | ❌ 清空 | 机器相关，迁过去等于把旧登录态搬上新机 |
| 验证码 verify_codes | ❌ 清空 | 临时数据 |
| 孤儿票据文件 | ❌ 不搬 | 重复上传/已删项目的残留 |
| `exports/` 目录本体 | ⚠️ 按需 | 表单会重新落盘，原目录不必手动拷 |

### 三个必须处理的坑（脚本已内置）

**① 不能直接拷 `.db` 文件**
数据库是 WAL 模式，最近写入可能还在 `-wal` 日志里没合并。脚本用 `VACUUM INTO` 生成一致性快照。

**② `exports` 表里存的是旧机器的绝对路径**
例如 `C:\Users\Dell\Desktop\...\SP-2026-003_资金申请单.xlsx`。直接迁过去，服务器上"上次导出"的文件全部 404。
脚本改写成占位符 `__EXPORT_DIR__/<文件名>`，导入时替换成服务器的 `EXPORT_DIR`。

**③ 服务器上已有的超管会被覆盖**
导入会整体替换数据库。原来那份（用户名重名时）变成历史，务必先备份——脚本默认自动备份。

---

## 二、本机导出

```bash
# 在项目根目录（Windows 用 Git Bash）
node deploy/migrate/export-bundle.js

# 可选参数
#   --src-dir data                  源数据目录（默认 data）
#   --out deploy/migrate/_bundle    输出目录
#   --with-orphans                  連孤儿票据一起搬
#   --no-exports                    不搬导出件（同时清空导出记录）

# 打包
rm -f reimburse-data.tar.gz
MSYS_NO_PATHCONV=1 tar -czf reimburse-data.tar.gz -C deploy/migrate/_bundle .

# 上传前自检（可选但推荐）
node deploy/migrate/verify-bundle.js deploy/migrate/_bundle
```

输出示例：

```
  项目 4 / 票据 16 (￥9916.78) / 用户 2 / 设置项 25
  票据原件 16 份 / 导出件 7 份
  邮箱配置     已包含
```

---

## 三、服务器导入

```bash
# 1. 上传
scp reimburse-data.tar.gz root@121.43.27.73:/opt/

# 2. 解压
ssh root@121.43.27.73
mkdir -p /opt/reimburse-data && tar -xzf /opt/reimburse-data.tar.gz -C /opt/reimburse-data

# 3. 先演练（强烈建议，能看到它打算动哪些东西）
sudo bash /opt/reimburse-data/import-bundle.sh --dry-run

# 4. 正式导入
sudo bash /opt/reimburse-data/import-bundle.sh
```

脚本依次做 7 件事：

| 步 | 动作 | 失败会怎样 |
|---|---|---|
| 1 | 读 `/etc/reimburse/env` 拿 `DATA_DIR`/`EXPORT_DIR`，实测 Node 的 sqlite 标志 | 找不到 node 或版本太低 → 中止 |
| 2 | **迁移前整包备份**到 `/var/backups/reimburse/pre-migrate-*.tar.gz` | 备份失败 → **拒绝继续** |
| 3 | 停服务 | — |
| 4 | 写数据库 + `PRAGMA integrity_check` | 自检不过 → 中止，可回滚 |
| 5 | 复原 `__EXPORT_DIR__` 占位符、落票据与导出件 | — |
| 6 | 修权限（属主 + 目录 700 + 库 600） | — |
| 7 | 起服务、带重试判活、**按 manifest 逐项核对行数** | 打印差异，便于人工确认 |

### 导入后立即核对

脚本会自动打印对照表，出现 `[差异]` 就停下来查：

```
   [OK ] projects           4  (期望 4)
   [OK ] receipts          16  (期望 16)
   [OK ] 票据总额       ￥9916.78  (期望 ￥9916.78)
   [OK ] 票据原件齐全
   [OK ] 邮箱配置   smtp.163.com:465  账号 tjracx2018@163.com  (授权码已迁移 16 位)
```

---

## 四、邮箱配置专项

邮箱配置**就在数据库里**，所以迁移过去即生效，不用重填。当前配置：

| 项 | 值 |
|---|---|
| SMTP | `smtp.163.com:465`（SSL） |
| 账号 / 发件人 | `tjracx2018@163.com` |
| 发件人名称 | 艺术学院刘海斌 |
| 管理员收件箱 | `13752070316@fapiao56.com` |
| 授权码 | 已迁移（16 位） |

### 验证服务器能不能真的发信

阿里云 ECS **默认封锁 25 端口出网**，但我们用的是 465，一般没问题。导入脚本末尾会做一次纯 TCP 连通性探测。

真要端到端验证，走 API：

```bash
source /etc/reimburse/env     # 拿到 AUTH_USER / AUTH_PASS
BASIC="admin:IcyNCMegRHXUDM40fGRh"

# ① 登录拿会话 Cookie（注意字段是 account，不是 username）
COOKIE=$(curl -si -u "$BASIC" -X POST http://127.0.0.1:5180/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"account":"admin","password":"这里填导过来的密码"}' \
  | grep -i '^set-cookie' | sed 's/^[Ss]et-[Cc]ookie: //' | cut -d';' -f1)

# ② 发一封测试信
curl -s -u "$BASIC" -X POST http://127.0.0.1:5180/api/mail/test \
  -H 'Content-Type: application/json' -H "Cookie: $COOKIE" -d '{}'
```

返回 `{"ok":true,"data":{"to":"13752070316@fapiao56.com"}}` 就成了。

### 改邮箱配置

后台 `/admin` → **认证与邮箱** → 保存设置改的是同一张 `settings` 表，改完立即生效、无需重启。
`mail_smtp_pass` 在接口里是**脱敏下发**的（前端只看到"是否已设置"），所以后台留空 = 保持原值不变。

### 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `getaddrinfo ENOTFOUND smtp.163.com` | DNS 未配好 | `cat /etc/resolv.conf`，加 `nameserver 223.5.5.5` |
| 连不上 465 | 安全组**出方向**被拦 | 云控制台放行出方向 465（很多人只配了入方向） |
| `535 Error: authentication failed` | 163 授权码不对（不是登录密码） | 163 邮箱 → 设置 → POP3/SMTP → 重新生成授权码 |
| 超时无响应 | 用了 25 端口 | 换成 465（SSL）或 994 |

---

## 五、回滚

```bash
systemctl stop reimburse
BACKUP=$(ls -t /var/backups/reimburse/pre-migrate-*.tar.gz | head -1)
rm -rf /var/lib/reimburse
tar -xzf "$BACKUP" -C /var/lib
chown -R reimburse:reimburse /var/lib/reimburse
systemctl start reimburse
```

---

## 六、迁移后的收尾

1. **超管密码变了**：导入后库里是旧机器的超管账号 `admin`，密码沿用旧机器那份，**不是**服务器自己生成的那个。
   导入脚本检测到新库自带超管后，会把服务器那份已失效的 `_admin_init.txt` 自动改名归档为
   `_admin_init.txt.migrated-<时间戳>`，**别再照着它里面的密码登录**。登录后立即改密码。
2. **所有会话已失效**：清空过 sessions，所有人都需要重新登录。
3. **两个账号都没绑邮箱**：`admin` 和 `lhbzx1984`（刘海斌）的 email 均为空 —— 找回密码只能由管理员在后台重置。
   建议至少给超管补一个邮箱，否则一旦忘密码就只能上服务器改库。
4. **导出表单**：7 份历史表单已落地到 `EXPORT_DIR`，项目详情页可以直接下载，不必重新生成。
5. **别把 bundle 留在服务器上**：包里有真实数据库（含密码哈希和邮箱授权码）。确认无误后 `rm -rf /opt/reimburse-data`。

---

## 附：脚本清单

| 文件 | 运行位置 | 作用 |
|---|---|---|
| `deploy/migrate/export-bundle.js` | 旧机器 | 生成快照 + 清洗 + 打包，产出 bundle |
| `deploy/migrate/verify-bundle.js` | 任意 | 校验 bundle 完整性与路径清洗结果 |
| `deploy/migrate/import-bundle.sh` | 服务器 | 备份 → 替换 → 启服务 → 核对 |
