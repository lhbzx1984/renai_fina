# 服务器资源清单 · 天津仁爱学院报销系统

面向**新开一台干净 ECS/CVM** 的场景（独立端口 + IP 直访，或后续转域名 HTTPS）。

---

## 一、推荐规格

| 资源 | 最低可用 | **推荐配置** | 为什么 |
|---|---|---|---|
| CPU | 2 核 | **2 核** | 应用是 Node 单进程、单线程，SQLite 写入本身也是串行的。多核跑不满，2 核已留足余量（一个核忙导出时，另一个跑 Nginx 与系统） |
| 内存 | 2 GB | **4 GB** | 进程本身只占 100–300 MB；但生成差旅表/资金申请单的 docx、xlsx 是内存操作，几十张票据一次性导出时会明显涨。2 GB 能跑，4 GB 不心疼 |
| 系统盘 | 40 GB | **40 GB**（ESSD Entry 或高效云盘） | 只装系统与 Nginx，不存业务数据 |
| 数据盘 | 40 GB | **100 GB** | 关键项，容量推导见第二节。**必须单独挂载** |
| 带宽 | 3 Mbps | **5–10 Mbps** | 票据 PDF 多为 1–3 MB；5 Mbps 下单张约 3–5 秒。若期末集中报销、多人同时传，选 10 Mbps 或按量付费（峰值 100 Mbps） |
| 操作系统 | — | **Ubuntu 22.04 LTS 64 位** | 部署脚本的 apt 分支最成熟；CentOS/TencentOS 会额外触发 SELinux 放行逻辑 |

> 规格换算成钱：2 核 4 G + 5 Mbps 带宽，包年包月大致在**每月百元量级**（不同厂商与活动差异很大，务必以控制台实时报价为准）。
> 若只是先跑起来验证，按量付费开一台 2 核 4 G，用完即释放，成本最低。

---

## 二、数据盘为什么要 100 GB（推导过程）

这一步别跳过——备份占用才是大头，很多人只算了数据本身，三个月后磁盘就满了。

**数据增长估算**（按一个学院的使用规模）

| 项目 | 假设 | 年增量 |
|---|---|---|
| 票据原件 | 300–600 张/年 × 平均 1.5 MB（PDF/扫描件） | ≈ 0.9 GB |
| 数据库 | 记录本身是 KB 级，不含附件 | < 0.1 GB |
| 导出件 | 差旅表 docx、资金申请单 xlsx | < 0.2 GB |
| **合计** | | **≈ 1.2 GB / 年** |

**备份占用才是大头**

`backup.sh` 备份的是**数据库 + 全部票据原件**，默认保留 **14 份**。也就是说：

```
备份占用 ≈ 14 × (累计数据体积)
```

> 导出件（`exports/` 里的 docx、xlsx）**默认不进备份**——它们都能从数据库随时重新生成，
> 属于可再生数据，没必要按份数乘以 14。需要留档时加 `--with-exports`。

按「票据原件 + 数据库」≈ 1.0 GB/年 计算：

| 时间点 | 累计数据 | 14 份备份占用 | 数据盘建议 |
|---|---|---|---|
| 第 1 年 | 1.0 GB | 14 GB | 40 GB 勉强 |
| 第 3 年 | 3.0 GB | 42 GB | 60–80 GB |
| 第 5 年 | 5.0 GB | 70 GB | **100 GB** |

**结论**：数据盘 100 GB，可覆盖 5 年以上且不必中途扩容。

**想省磁盘的两个办法**（二选一即可）
1. 收紧保留份数：`--keep 7`（备份占用直接减半）
2. 备份转对象存储：本地留 2–3 份，历史备份传 OSS/COS（更便宜也更抗机房故障）

> ⚠️ **备份目录绝不能放在数据目录里**。备份会把上一份备份一起打包进去，体积逐日翻倍，
> 而且是静默发生的。`backup.sh` 已内置这条校验，误配会直接报错退出。

---

## 三、安全组规则（云平台控制台配置）

脚本只能管服务器内的 ufw/firewalld，**云安全组必须手动配**，这是最容易漏的一步。

| 端口 | 协议 | 来源 | 用途 | 说明 |
|---|---|---|---|---|
| 22 | TCP | **你的办公 IP/32** | SSH 运维 | ⚠️ 不要开 0.0.0.0/0，会被全网暴力破解 |
| 18080 | TCP | 学院出口 IP 段（或 0.0.0.0/0） | 站点访问 | 独立端口模式；能用 IP 段就别开全网 |
| 80 / 443 | TCP | 0.0.0.0/0 | 站点访问 | 改用域名 HTTPS 时才需要 |
| **5180** | — | **不要放行** | 应用监听 | 应用只监听 `127.0.0.1`，公网本就不可达；放行反而暴露风险 |

---

## 四、快照与备份策略

| 层级 | 方式 | 频率 | 保留 | 防什么 |
|---|---|---|---|---|
| 云盘快照 | 云平台自动快照策略 | 每日 | 7 天 | 误删、系统崩溃、勒索 |
| 应用备份 | `backup.sh` 定时 | 每日 03:17 | 14 份 | 数据库损坏、误操作（可单张表恢复） |

配应用级定时备份：

```bash
sudo crontab -e
# 每天 3:17（刻意避开整点，避免与其他任务撞车）
17 3 * * * BACKUP_ROOT=/data/backups/reimburse bash /opt/reimburse/deploy/backup.sh --keep 14 >> /var/log/reimburse/backup.log 2>&1
```

> 若数据盘挂在 `/data`，把 `BACKUP_ROOT` 指到 `/data/backups/reimburse`（与 `/data/reimburse` 平级但**不嵌套**），
> 这样备份不占系统盘，也不会自我包含。

---

## 五、部署前检查清单

开好机器后，按顺序确认：

- [ ] 已挂载数据盘并格式化（如挂载到 `/data`），确认 `df -h` 能看到
- [ ] 安全组已放行 `18080`，且 **22 端口来源限定为你的 IP**
- [ ] 操作系统为 Ubuntu 22.04 LTS（或其他受支持的发行版）
- [ ] 本机可用 `ssh` / `scp`（Windows 用 Git Bash）
- [ ] 已确认对外端口未被占用（脚本会预检，冲突会直接报错）
- [ ] （若用域名）域名已完成 ICP 备案并解析到本机

---

## 六、落地命令

**方式 A：本机一条命令（推荐）**

```bash
# 在 Windows Git Bash / macOS 终端，项目根目录下执行
bash deploy/onekey.sh --host 你的公网IP --port 18080
```

**方式 B：先传代码，再登服务器执行**

```bash
# 本机：上传（白名单打包，不会覆盖服务器上的数据）
tar -czf reimburse.tar.gz server package.json deploy
scp reimburse.tar.gz root@你的公网IP:/tmp/

# 服务器：解压并部署
ssh root@你的公网IP
mkdir -p /tmp/src && tar -xzf /tmp/reimburse.tar.gz -C /tmp/src
cd /tmp/src && sudo bash deploy/deploy.sh --port 18080
```

**若挂了数据盘**，加一个参数即可：

```bash
bash deploy/onekey.sh --host 你的公网IP --port 18080 --data-dir /data/reimburse
```

部署完成后终端会打印**前后台地址**与**访问账号密码**，务必立即保存。

---

## 七、后续升级到 HTTPS（正式使用必做）

当前 IP 直访是明文 HTTP，报销数据含金额与身份信息，不建议长期使用。

1. 准备一个**已备案**的二级域名，如 `reimburse.renai.edu.cn`，A 记录解析到本机
2. 安全组放行 80 / 443
3. 重跑部署（给 `--domain` 后会自动切到 80/443 模式）：
   ```bash
   sudo bash /opt/reimburse/deploy/deploy.sh --domain reimburse.renai.edu.cn
   ```
4. 签发证书：
   ```bash
   sudo apt install -y certbot python3-certbot-nginx
   sudo certbot --nginx -d reimburse.renai.edu.cn
   sudo certbot renew --dry-run   # 验证自动续期
   ```

> 证书机构（Let's Encrypt）**不给裸 IP 签发证书**，所以 HTTPS 必须先有域名。

---

## 八、常见问题

**Q：浏览器打不开，一直转圈**
按三层顺序排查，不要跳步：
```bash
curl http://127.0.0.1:5180/api/health    # 1 应用层活不活
curl -I http://127.0.0.1:18080/          # 2 Nginx 到没到
curl -I http://公网IP:18080/             # 3 防火墙/安全组通不通
```
第 1 步就失败看 `journalctl -u reimburse -n 50`；第 3 步失败说明是安全组没放行 18080。

**Q：访问一律 502**
Nginx 起来了但连不上后端。CentOS 系多是 SELinux 拦了回环连接：
```bash
setsebool -P httpd_can_network_connect 1
semanage port -a -t http_port_t -p tcp 18080
```

**Q：上传票据报 413**
Nginx 请求体上限。模板已设 20 M；若票据更大：
```bash
sudo sed -i 's/client_max_body_size 20m;/client_max_body_size 50m;/' /etc/nginx/conf.d/reimburse.conf
sudo nginx -t && sudo systemctl reload nginx
```
（应用侧 `server/index.js` 也有硬编码上限，两边都要改）

**Q：磁盘几个月就满了**
多半是备份。看占用：
```bash
du -sh /var/backups/reimburse; du -sh /var/lib/reimburse/uploads
```
收紧份数：`sudo bash /opt/reimburse/deploy/backup.sh --keep 7`

**Q：部署脚本报 node:sqlite 无法加载**
Node 版本过低（需 ≥ 22.5）。脚本会自动装 22.22.2，若仍失败是旧版本残留：
```bash
node -v && which -a node
```
把非 `/usr/local/bin/node` 的旧版本移除后重跑脚本。
