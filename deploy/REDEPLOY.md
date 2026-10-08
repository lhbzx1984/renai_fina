# 重新部署 + 迁移刘海斌数据（服务器已在跑旧版时的标准流程）

适用：服务器上现在跑的是**旧版**（没有用户隔离），要换成新版代码，
再把本机的刘海斌（`lhbzx1984`）数据合并进去，服务器上其他老师的数据不受影响。

全流程三步：**① 卸载旧安装（自动备份） → ② 部署新版 → ③ 合并迁移刘海斌数据**。

---

## 零、动手前先确认两件事

| 要确认的 | 怎么确认 | 说明 |
|---|---|---|
| 服务器上有没有**别人的真实数据** | `ssh root@121.43.27.73 'ls -l /var/lib/reimburse'` | 卸载脚本默认把整个数据目录**挪到备份区**而不是删除，别人数据不会凭空消失；但如果之前是手工装的、数据在别处，先自己另存一份 |
| 新系统用什么端口 | 默认 **18080**（对外）+ 5180（应用只听回环） | 和旧版保持一致就不用改防火墙/Nginx |

> ⚠️ 卸载会重新生成 **Basic Auth 口令**和**后台超管密码**，旧密码失效。部署完务必保存新打印的账号密码。

---

## 一、三种跑法（选一种）

### 方式 A · 本机一条命令全自动（推荐）

在本机项目根目录（Git Bash）跑：

```bash
bash deploy/onekey.sh --host 121.43.27.73 --port 18080 --reinstall --migrate-user lhbzx1984
```

它会依次做完：打包上传 → **卸载旧安装（数据自动备份）** → 部署新版 →
本机导出刘海斌数据 → 上传 → 停服务 → `--dry` 演练 → 正式导入 → 启服务 → 自检。

只想重装、这次先不迁数据，去掉 `--migrate-user` 即可，后面随时可以单独补迁（见第三节）。

### 方式 B · 服务器上一键（源码已在服务器上）

```bash
cd /tmp/reimburse-src            # 或你的源码目录
sudo bash deploy/uninstall.sh -y  # 卸载旧版，数据整体挪到 /var/backups/reimburse/pre-uninstall-<时间>/data
sudo bash deploy/deploy.sh --port 18080
```

### 方式 C · 全手动（想看清每一步）

<details>
<summary>展开命令块</summary>

```bash
# —— 服务器上：停服务、清程序、备份数据 ——
ssh root@121.43.27.73
systemctl stop reimburse
systemctl disable reimburse
rm -f /etc/systemd/system/reimburse.service && systemctl daemon-reload
rm -f /etc/nginx/conf.d/reimburse.conf && nginx -t && systemctl reload nginx
TS=$(date +%Y%m%d-%H%M%S)
mkdir -p /var/backups/reimburse/pre-uninstall-$TS
mv /var/lib/reimburse /var/backups/reimburse/pre-uninstall-$TS/data   # 只挪不删
cp -a /etc/reimburse/env /var/backups/reimburse/pre-uninstall-$TS/env 2>/dev/null || true
rm -rf /opt/reimburse /etc/reimburse /var/log/reimburse
```
</details>

---

## 二、部署后的自检（三选一跑完都要做）

```bash
# 应用活着
curl -s -o /dev/null -w "health=%{http_code}\n" http://127.0.0.1:5180/api/health   # 期望 200

# 对外可访问（把 18080 换成你的端口）
curl -s -o /dev/null -w "public=%{http_code}\n" -u 'admin:<BasicAuth密码>' http://127.0.0.1:18080/

# 服务状态
systemctl is-active reimburse
```

**让系统自己建表并 seed 字典一次**（首次访问或启动即可），导入脚本依赖学院/专业字典按名称对齐。

---

## 三、迁移刘海斌的数据（方式 A 已自动做过，这里是可单独重跑的版本）

### 3.1 本机导出

```bash
# 项目根目录
node deploy/migrate/export-user.js --user lhbzx1984
```

产物 `deploy/migrate/_user_lhbzx1984/`（已被 `.gitignore` 忽略）：
`data.json` + `manifest.json` + `uploads/`（16 份票据原件）+ `exports/`（7 份表单）+ `import-user.js`。

本机最新一次导出的实测结果：**用户 #19 刘海斌 / 项目 4 / 行程 4 / 成员 6 / 票据 16 / 金额 ￥9916.78 / 个人设置 9 条 / 邮箱配置已包含**。

### 3.2 打包上传

```bash
cd deploy/migrate
MSYS_NO_PATHCONV=1 tar -czf reimburse-user.tar.gz -C _user_lhbzx1984 .
MSYS_NO_PATHCONV=1 scp reimburse-user.tar.gz root@121.43.27.73:/opt/
```

### 3.3 服务器上导入

```bash
ssh root@121.43.27.73
source /etc/reimburse/env                     # 拿到 DATA_DIR / EXPORT_DIR
mkdir -p /opt/reimburse-user && tar -xzf /opt/reimburse-user.tar.gz -C /opt/reimburse-user

systemctl stop reimburse                      # 写库前必须停服务
node /opt/reimburse-user/import-user.js --bundle /opt/reimburse-user --target "$DATA_DIR" --dry   # 演练
node /opt/reimburse-user/import-user.js --bundle /opt/reimburse-user --target "$DATA_DIR"         # 正式
systemctl start reimburse
```

导入是**合并**不是替换：id 全部重映射、项目按编号查重（默认跳过已有）、
字典按**名称**对齐（缺的补建）、别人的行一律不碰。细节与参数见 `deploy/MIGRATE-USER.md`。

---

## 四、验收清单（逐项打勾）

| # | 检查项 | 期望 |
|---|---|---|
| 1 | `curl http://127.0.0.1:5180/api/health` | `200` |
| 2 | 用刘海斌**原密码**登录 | 成功（密码哈希随迁，不用重置） |
| 3 | 登录后项目列表 | 4 个项目：SP-2026-003 / SP-2026-004 / JS-2026-001 / JX-2026-001 |
| 4 | 票据合计 | ￥9916.78 |
| 5 | 另开一个账号登录 | **看不到**刘海斌的项目 ← 隔离生效的关键证据 |
| 6 | 设置 → 发票邮件发送 → 发送测试邮件 | 收到邮件（验证 163 授权码在新机可用） |
| 7 | 别人的账号还能正常登录、数据还在 | 未受影响 |

前端改过代码，浏览器记得 **Ctrl+F5 硬刷新**。

---

## 五、回滚

| 场景 | 怎么回 |
|---|---|
| 导入前 | 脚本已自动备份目标库 `<db>.bak-<时间戳>`，换回去即可 |
| 整个重装搞砸了 | 旧数据整目录在 `/var/backups/reimburse/pre-uninstall-<时间>/data`，拷回 `/var/lib/reimburse` 并 `chown -R reimburse:reimburse`，再跑一次 `deploy.sh` |

```bash
# 回退导入
systemctl stop reimburse
BAK=$(ls -t /var/lib/reimburse/reimburse.db.bak-* | head -1)
mv "$BAK" /var/lib/reimburse/reimburse.db
chown reimburse:reimburse /var/lib/reimburse/reimburse.db
systemctl start reimburse
```

---

## 六、收尾（别漏）

```bash
# 1. 删服务器上的迁移包 —— 里面有真实数据库和 163 邮箱授权码
rm -rf /opt/reimburse-user /opt/reimburse-user.tar.gz

# 2. 本机迁移包（已被 gitignore）确认无误后删掉
rm -rf deploy/migrate/_user_lhbzx1984

# 3. 旧数据备份确认新系统跑稳一周后再清
#    /var/backups/reimburse/pre-uninstall-*/

# 4. 保存好新生成的 Basic Auth 口令与后台超管密码
cat /etc/reimburse/env
cat /var/lib/reimburse/_admin_init.txt
```

---

## 七、常见问题

**Q：为什么不能直接升级（`onekey.sh` 不加 `--reinstall`）？**
可以升级，代码是幂等的。但旧库是旧 schema（`projects` 没有 `owner_user_id`），
升级后虽会自动补列，历史项目的归属人是空的——隔离形同虚设。
要干净的隔离效果，就得清库重装再合并导入。

**Q：`--keep-data` 什么时候用？**
只在你想保留服务器现有数据库时。注意旧库的归属列是空的，
需要跑 `node server/migrate_ownership.js` 补归属（见 `server/migrate_ownership.js`）。
一般情况**不建议**——重装 + 单用户导入更干净。

**Q：卸载时提示备份空间不足？**
数据目录有多大就要多大备份空间。先清 `/var/backups/reimburse` 里的旧备份，
或确认旧数据不要了用 `uninstall.sh --no-backup -y`（不可恢复，慎用）。
磁盘规划上，按 `backup.sh` 保留 14 份算，数据盘建议 100GB。
