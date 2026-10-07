# 天津仁爱学院报销系统 · 云端部署手册

面向**阿里云 ECS** 与**腾讯云 CVM**。Linux 用 `deploy.sh`，Windows Server 用 `deploy.ps1`。

> **还没开机器？** 先看 [`SERVER.md`](SERVER.md) —— 服务器规格、磁盘容量推导、安全组规则、快照策略都在里面。
>
> **已经有数据想搬上来？** 看 [`MIGRATE.md`](MIGRATE.md) —— 数据库 + 邮箱配置 + 票据原件 + 导出表单的一次性迁移。

---

## 一、部署前必读（三条硬性要求）

### 1. 必须挂载数据盘，不要只依赖系统盘
报销数据（数据库、票据原件）丢了不可恢复。系统盘在实例重装、扩容、故障时会**被清空**。

- 购买云盘（如 40GB 高效云盘）挂载到 `/data`
- 数据目录指向 `/data/reimburse`（部署脚本用 `DATA_DIR` 环境变量控制）
- 快照策略建议：每日自动快照

### 2. 必须配 HTTPS
票据是财务凭证，含金额与身份信息，明文 HTTP 等于裸奔。Basic Auth 的密码在 HTTP 下会**逐跳明文传输**。

### 3. 中国大陆服务器必须 ICP 备案
用域名访问 80/443 是被强制的。未备案域名会被拦截。
- 阿里云：备案服务 → 首次备案
- 腾讯云：腾讯云备案
- 备案通常 7–20 个工作日，**建议先备案再部署**
- 只用 IP 访问可跳过备案，但正式使用强烈不建议

---

## 二、一键部署（Linux）

### 先选部署形态

> **前台与后台由同一个 Node 进程提供，部署一次两个都上线**：
> `/` 是报销前台，`/admin` 是后台管理系统（用户管理 / 注册审批）。不需要部署两趟。

| 形态 | 命令 | 适用场景 |
|---|---|---|
| **独立端口 + IP 直访** | `deploy.sh --port 18080` | 新开机器先用起来，无需域名与备案 |
| 域名 + HTTPS | `deploy.sh --domain 你的域名` | 正式使用（需已备案域名） |

### 步骤

**方式 A：本机一条命令**（推荐，自动完成打包/上传/远程部署）

```bash
# Windows 用 Git Bash，macOS/Linux 用自带终端；在项目根目录执行
bash deploy/onekey.sh --host 你的公网IP --port 18080
```

**方式 B：手动两步**

```bash
# 1. 本机打包上传（白名单，不会覆盖服务器上的数据）
tar -czf reimburse.tar.gz server package.json deploy
scp reimburse.tar.gz root@你的公网IP:/tmp/

# 2. 登录服务器执行部署
ssh root@你的公网IP
mkdir -p /tmp/src && tar -xzf /tmp/reimburse.tar.gz -C /tmp/src
cd /tmp/src && sudo bash deploy/deploy.sh --port 18080
```

### 参数

| 参数 | 说明 | 默认 |
|---|---|---|
| `--domain <域名>` | 已备案域名；给了就默认走 80/443 + HTTPS | 不给则用 `_` 走 IP 直访 |
| `--port <端口>` | Nginx 对外监听端口 | `18080`（给 `--domain` 时自动改 80） |
| `--app-port <端口>` | Node 应用监听端口（只听 127.0.0.1） | `5180` |
| `--data-dir <路径>` | 数据目录，建议指向数据盘 | `/var/lib/reimburse` |
| `--auth-user <用户名>` | 访问认证用户名 | `admin` |
| `--auth-pass <密码>` | 访问认证密码 | 自动生成 20 位强随机 |
| `--no-https` | 只配 HTTP（IP 直访时**自动**启用） | 关 |
| `--skip-nginx` | 不配 Nginx（已有网关时） | 关 |
| `--skip-firewall` | 不动防火墙 | 关 |

### 脚本做了什么

| 步骤 | 动作 |
|---|---|
| 1 | 系统识别、架构检测、**端口占用预检**、数据盘落位提醒 |
| 2 | 检查 Node ≥ 22，不足则自动装（官方源失败自动回落 npmmirror 镜像）；实测 `node:sqlite` 能否加载 |
| 3 | 建 `reimburse` 系统用户（nologin），数据目录权限 **700** |
| 4 | 同步代码；**升级时先自动备份数据库** |
| 5 | 生成 `/etc/reimburse/env`（权限 600），自动生成强随机密码 |
| 6 | 注册 systemd 服务 + **安全加固**（只读系统、禁提权、系统调用白名单） |
| 7 | Nginx 反代配置 + SELinux 放行非标准端口（CentOS 系）+ 配置校验 + 重载 |
| 8 | 防火墙放行对外端口（**故意不放行应用端口**） |
| 9 | **部署后自检**：应用层探活 + 经 Nginx 验证 `/` 与 `/admin` |

### 部署后

```
前台地址 : http://你的公网IP:18080/
后台地址 : http://你的公网IP:18080/admin
账号密码 : 部署时终端会打印，务必立即保存
```

### 常用命令

```bash
sudo systemctl status reimburse     # 状态
sudo systemctl restart reimburse    # 重启
sudo journalctl -u reimburse -f     # 实时日志
sudo bash /opt/reimburse/deploy/backup.sh   # 手动备份
```

---

## 三、补配 HTTPS（正式上线必做）

首次部署时证书还不存在，所以先按 HTTP 跑通。签发证书：

```bash
# 1. 安装 certbot
sudo apt install certbot python3-certbot-nginx    # Ubuntu/Debian
sudo yum install certbot python3-certbot-nginx    # CentOS/TencentOS

# 2. 签发并自动改写 Nginx 配置
sudo certbot --nginx -d reimburse.example.com

# 3. 验证自动续期
sudo certbot renew --dry-run
```

certbot 会自动：
- 申请并安装证书
- 在 Nginx 配置里写入 `ssl_certificate` 路径
- 配置 HTTP → HTTPS 跳转
- 加入续期定时任务

验证配置是否正确：
```bash
sudo nginx -t && sudo systemctl reload nginx
```

---

## 四、部署到 Windows Server

```powershell
# 以管理员身份运行 PowerShell
powershell -ExecutionPolicy Bypass -File deploy\deploy.ps1 `
  -AuthUser admin -AuthPass '你的强密码'
```

会用 [NSSM](https://nssm.cc/download) 注册成 Windows 服务并设开机自启。
NSSM 未安装时脚本会提示，并给出手动运行方式。

> 建议：Windows Server 上优先用 **Linux 主机 + deploy.sh**，功能更完整
> （systemd 加固、Nginx 一键配置、firewall/ufw 自动处理）。

---

## 五、安全清单（部署后逐项确认）

| 项 | 怎么确认 | 期望 |
|---|---|---|
| 应用端口未暴露公网 | `sudo ss -tlnp \| grep 5180` | 只监听 `127.0.0.1` |
| 对外端口已放行 | 云控制台安全组 + `sudo ufw status` | 有 18080（或 80/443） |
| 前后台都能打开 | `curl -I http://IP:18080/` 与 `/admin` | 200 或 401（401 说明 Basic Auth 生效） |
| 22 端口限制来源 | 安全组 | **不要** 0.0.0.0/0，改为你自己的 IP |
| 数据目录权限 | `ls -ld /var/lib/reimburse` | `drwx------` |
| env 文件权限 | `ls -l /etc/reimburse/env` | `-rw-------` |
| 服务以非 root 运行 | `ps -o user,cmd -C node` | `reimburse`，不是 root |
| 访问需密码 | 浏览器访问 | 弹出 Basic Auth 框 |

### 忘记密码怎么办

```bash
sudo vi /etc/reimburse/env     # 改 AUTH_PASS
sudo systemctl restart reimburse
```

改密码推荐用生成器：
```bash
openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 20
```

---

## 六、备份与恢复

### 配定时备份

```bash
sudo crontab -e
# 每天 3:17 备份，保留最近 14 份（刻意避开整点，避免与其他任务撞车）
17 3 * * * bash /opt/reimburse/deploy/backup.sh --keep 14 >> /var/log/reimburse/backup.log 2>&1
```

### 手动备份 / 恢复

```bash
sudo bash /opt/reimburse/deploy/backup.sh
sudo bash /opt/reimburse/deploy/backup.sh --restore /var/backups/reimburse/reimburse-20260101-031700.tar.gz
```

### 为什么不用 `cp` 直接复制数据库

SQLite 在 WAL 模式下，正在写入的数据可能只存在于 `reimburse.db-wal` 文件里。
直接复制 `.db` 会得到一个**「少了最近若干笔单据」的假备份**，而你以为备份成功了。

`backup.sh` 用 `sqlite3 .backup`（无 sqlite3 时用 `VACUUM INTO`），
走 SQLite 自己的备份 API，保证**事务一致的快照**，并在打包前校验表数量与项目数。

---

## 七、升级与回滚

### 升级

```bash
# 传新代码
scp -r server/ root@IP:/tmp/reimburse/

# 重跑部署脚本即可（幂等：保留数据、保留密码、升级前自动备份数据库）
cd /tmp/reimburse && sudo bash deploy/deploy.sh --domain 你的域名
```

### 回滚

```bash
# 1. 停止服务
sudo systemctl stop reimburse

# 2. 恢复数据（脚本会先自动备份当前状态，可再退回）
sudo bash /opt/reimburse/deploy/backup.sh --restore /var/backups/reimburse/xxx.tar.gz

# 3. 回滚代码到旧版本
cd /tmp && mv reimburse reimburse.new && ssh root@IP 'cp -r /tmp/reimburse.old /opt/' # 视情况
sudo systemctl start reimburse
```

---

## 八、常见问题

**Q：部署脚本报「node:sqlite 无法加载」**
Node 版本过低。本项目需要 **Node ≥ 22.5**（内置 sqlite 为实验特性）。
脚本会自动安装 22.22.2，若仍失败说明是旧版本残留：
```bash
node -v && which -a node
rm -rf /usr/local/bin/node && sudo bash deploy/deploy.sh ...
```

**Q：`nginx -t` 报证书路径不存在**
你在签发证书前就启用了 HTTPS 配置。两个解法：
```bash
sudo rm /etc/nginx/conf.d/reimburse.conf     # 删掉
sudo bash deploy/deploy.sh --domain xxx --no-https   # 重新用 HTTP 部署
sudo certbot --nginx -d xxx                  # 再签证书
```

**Q：能访问但一直 502**
应用没起来或监听不对：
```bash
sudo systemctl status reimburse
sudo journalctl -u reimburse -n 50
curl -v http://127.0.0.1:5180/api/health
```

**Q：上传票据报 413**
Nginx 请求体上限。模板已设 20M，若票据更大：
```bash
sudo vi /etc/nginx/conf.d/reimburse.conf   # 调大 client_max_body_size
sudo nginx -t && sudo systemctl reload nginx
```

**Q：忘记密码 / 401 一直进不去**
```bash
sudo cat /etc/reimburse/env        # 看 AUTH_USER / AUTH_PASS
sudo systemctl restart reimburse   # 改完必须重启
```

**Q：磁盘满了**
```bash
sudo du -sh /var/lib/reimburse/*   # 看谁占的
sudo bash /opt/reimburse/deploy/backup.sh --keep 7   # 收紧保留份数
```

**Q：想改上传大小限制**
`server/index.js` 里有硬编码上限，同时也要调 Nginx 的 `client_max_body_size`，两边都要改。

---

## 十、架构说明

```
用户浏览器
    │  HTTPS (443)
    ▼
Nginx  ──  反向代理 + TLS 终结
    │  HTTP (127.0.0.1:5180)   ← 只走回环，公网不可达
    ▼
Node 进程  ── Basic Auth 鉴权
    │  127.0.0.1:5180          ← systemd 守护 + 崩溃自动重启
    ├──> SQLite  /var/lib/reimburse/reimburse.db
    ├──> 票据原件 /var/lib/reimburse/uploads/
    └──> 导出件   /var/lib/reimburse/exports/
```

**为什么 5180 只监听回环**：这样即使安全组配错、有人扫端口，也**无法直接访问应用**，
必须经过 Nginx（带 HTTPS 与限流）。多一层就多一道保险——这是财务系统的基本要求。
