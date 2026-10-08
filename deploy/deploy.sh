#!/usr/bin/env bash
# =============================================================
# 天津仁爱学院报销系统 · 一键部署（Linux / 阿里云 ECS / 腾讯云 CVM）
#
# 常用：
#   # 新开干净机器，独立端口 + IP 直访（最快可用）
#   sudo bash deploy/deploy.sh --port 18080
#
#   # 有已备案域名，走标准 80/443 + HTTPS
#   sudo bash deploy/deploy.sh --domain reimburse.example.com
#
# 幂等：可重复执行以升级（保留数据库与密码，升级前自动备份）
#
# 前台与后台由同一个 Node 进程提供：
#   /        → 报销前台
#   /admin   → 后台管理系统（用户管理 / 注册审批）
# =============================================================
set -Eeuo pipefail

# ---------- 常量 ----------
APP_NAME="reimburse"
APP_DIR="/opt/reimburse"
RUN_USER="reimburse"
ENV_FILE="/etc/reimburse/env"
SERVICE_FILE="/etc/systemd/system/reimburse.service"
NGINX_CONF="/etc/nginx/conf.d/reimburse.conf"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="/var/backups/reimburse"
NODE_MAJOR_REQUIRED=22
NODE_VERSION="v22.22.2"

# ---------- 参数 ----------
DOMAIN=""
AUTH_USER="admin"
PUBLIC_PORT="18080"      # Nginx 对外监听端口
APP_PORT="5180"          # Node 应用监听端口（只听回环）
DATA_DIR="/var/lib/reimburse"
NO_HTTPS=0
SKIP_FIREWALL=0
SKIP_NGINX=0
PORT_EXPLICIT=0
# 先给默认值：自检那步没装 curl 时不会走到赋值，末尾输出仍要用到它
SCHEME="http"
PUBLIC_IP=""

# ---------- 输出 ----------
c_ok()   { printf '\033[32m  [OK]\033[0m   %s\n' "$*"; }
c_warn() { printf '\033[33m  [WARN]\033[0m %s\n' "$*"; }
c_err()  { printf '\033[31m  [ERR]\033[0m  %s\n' "$*" >&2; }
c_step() { printf '\n\033[1;36m▌%s\033[0m\n' "$*"; }

die() { c_err "$*"; exit 1; }

trap 'c_err "部署失败，行号 $LINENO。已完成的步骤不会回滚，请按输出排查后重跑（脚本是幂等的）。"' ERR

usage() {
  cat <<'EOF'
天津仁爱学院报销系统 · 一键部署

用法：
  sudo bash deploy/deploy.sh [选项]

选项：
  --domain <域名>      已备案域名；给域名则默认走 80/443 + HTTPS
                       不给则用 IP 直访（server_name _），只配 HTTP
  --port <端口>        Nginx 对外监听端口，默认 18080
                       给 --domain 时默认改为 80（除非显式传本参数）
  --app-port <端口>    Node 应用监听端口，默认 5180（只监听 127.0.0.1）
  --data-dir <路径>    数据目录，默认 /var/lib/reimburse
                       建议指向挂载的数据盘，如 /data/reimburse
  --auth-user <用户名>  访问认证用户名，默认 admin
  --auth-pass <密码>    访问认证密码，不传则自动生成 20 位强随机
  --no-https           无域名形态：用自签证书终结 TLS（IP 直访时自动启用）
  --skip-nginx         不配置 Nginx（前面已有网关，如 SLB / ingress）
  --skip-firewall      不改动防火墙规则
  -h, --help           显示本帮助

示例：
  sudo bash deploy/deploy.sh --port 18080
  sudo bash deploy/deploy.sh --domain reimburse.renai.edu.cn
  sudo bash deploy/deploy.sh --port 18080 --data-dir /data/reimburse
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)        DOMAIN="$2"; shift 2 ;;
    --port)          PUBLIC_PORT="$2"; PORT_EXPLICIT=1; shift 2 ;;
    --app-port)      APP_PORT="$2"; shift 2 ;;
    --data-dir)      DATA_DIR="$2"; shift 2 ;;
    --auth-user)     AUTH_USER="$2"; shift 2 ;;
    --auth-pass)     AUTH_PASS="$2"; shift 2 ;;
    --no-https)      NO_HTTPS=1; shift ;;
    --skip-nginx)    SKIP_NGINX=1; shift ;;
    --skip-firewall) SKIP_FIREWALL=1; shift ;;
    -h|--help)       usage; exit 0 ;;
    *)               c_err "未知参数: $1"; usage; exit 1 ;;
  esac
done

[[ $EUID -eq 0 ]] || die "请用 root 运行：sudo bash deploy/deploy.sh"

# 给域名时默认走标准 80（HTTPS 需要 80 做跳转与 certbot 验证）
if [[ -n "$DOMAIN" && "$PORT_EXPLICIT" == "0" ]]; then PUBLIC_PORT=80; fi
# 没域名 = IP 直访，签不出证书（Let's Encrypt 不给裸 IP 签发），强制 HTTP
if [[ -z "$DOMAIN" && "$NO_HTTPS" == "0" ]]; then
  NO_HTTPS=1
  c_warn "未指定 --domain，使用 IP 直访；证书机构不给裸 IP 签发证书，已按 HTTP 部署"
fi
NGX_SERVER_NAME="${DOMAIN:-_}"
EXPORT_DIR="${DATA_DIR}/exports"
LOG_DIR="/var/log/reimburse"

c_step "天津仁爱学院报销系统 · 部署"
echo "  源码目录   : $SRC_DIR"
echo "  安装目录   : $APP_DIR"
echo "  数据目录   : $DATA_DIR"
echo "  对外端口   : $PUBLIC_PORT"
echo "  应用端口   : $APP_PORT (仅 127.0.0.1)"
echo "  访问标识   : $NGX_SERVER_NAME"
echo "  HTTPS      : $([[ "$NO_HTTPS" == "1" ]] && echo 否 || echo 是)"

# 端口占用预检：Nginx 还没装时也要先确认端口是空的，否则后面排查成本高
if command -v ss >/dev/null 2>&1; then
  if ss -tlnH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${PUBLIC_PORT}$"; then
    die "端口 ${PUBLIC_PORT} 已被占用，换一个：--port 18081"
  fi
fi

# =============================================================
# 1. 系统检查
# =============================================================
c_step "1/9 系统与环境检查"
[[ -f /etc/os-release ]] && c_ok "系统: $(. /etc/os-release && echo "$PRETTY_NAME")"

if command -v apt-get >/dev/null 2>&1; then
  PKG="apt-get"; PKG_UPDATE="apt-get update -qq"; NGINX_PKG="nginx"
elif command -v dnf >/dev/null 2>&1; then
  PKG="dnf"; PKG_UPDATE="dnf install -y -q epel-release || true"; NGINX_PKG="nginx"
elif command -v yum >/dev/null 2>&1; then
  PKG="yum"; PKG_UPDATE="yum install -y -q epel-release || true"; NGINX_PKG="nginx"
else
  c_warn "未识别的包管理器，依赖安装可能不完整"
  PKG=""; NGINX_PKG="nginx"
fi

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  NODE_ARCH="x64" ;;
  aarch64) NODE_ARCH="arm64" ;;
  *) die "不支持的 CPU 架构: $ARCH" ;;
esac
c_ok "架构: $ARCH"

# 数据盘检查：系统盘在重装/故障时会清空，报销数据丢不起
# 只在默认路径且未挂载独立盘时提醒，不阻断部署
if [[ "$DATA_DIR" == "/var/lib/reimburse" ]]; then
  ROOT_DEV="$(df --output=source "$DATA_DIR" 2>/dev/null | tail -1 || true)"
  c_warn "数据目录落在系统盘（${ROOT_DEV:-未知}）。正式使用建议挂数据盘后加 --data-dir /data/reimburse"
fi

# =============================================================
# 2. Node.js 运行时
# =============================================================
c_step "2/9 Node.js 运行时"

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local maj
  maj="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
  [[ -n "$maj" && "$maj" -ge "$NODE_MAJOR_REQUIRED" ]]
}

install_node() {
  # 国内 ECS 直连 nodejs.org 经常超时，官方失败后回落到 npmmirror 镜像
  local bases=(
    "https://nodejs.org/dist/${NODE_VERSION}"
    "https://npmmirror.com/mirrors/node/${NODE_VERSION}"
  )
  local tmp url
  tmp="$(mktemp -d)"
  c_warn "Node.js 版本不足或未安装，正在安装 ${NODE_VERSION} …"
  if [[ -n "$PKG" ]]; then $PKG_UPDATE >/dev/null 2>&1 || true; $PKG install -y -q curl xz tar >/dev/null 2>&1 || true; fi
  command -v curl >/dev/null 2>&1 || die "需要 curl，请手动安装后重试"

  for base in "${bases[@]}"; do
    url="${base}/node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
    if curl -fsSL --max-time 180 "$url" -o "${tmp}/node.tar.xz"; then
      tar -xJf "${tmp}/node.tar.xz" -C /usr/local --strip-components=1 \
          --exclude='CHANGELOG.md' --exclude='LICENSE' --exclude='README.md'
      rm -rf "$tmp"
      hash -r 2>/dev/null || true
      return 0
    fi
    c_warn "下载失败，换镜像重试：$base"
  done
  rm -rf "$tmp"
  return 1
}

if node_ok; then
  c_ok "Node.js: $(node -v) （满足 ≥ ${NODE_MAJOR_REQUIRED}）"
else
  install_node || die "Node.js 下载失败（官方源与 npmmirror 均不可达），请手动安装后重跑"
  node_ok || die "Node.js 安装后仍不可用，请手动检查"
  c_ok "Node.js: $(node -v) （已安装）"
fi

# NODE_BIN 必须与最终写进 unit 的 ExecStart 是同一个二进制，
# 否则会出现「用 A 判定、用 B 启动」的错位（曾导致线上崩溃循环）。
NODE_BIN="$(command -v node)"

# node:sqlite 在 22.5~22.x 是实验特性，23.4 转正，24 的后期小版本干脆移除了标志。
# 同一个大版本不同小版本行为都不一样（v24.14 接受、v24.21 报 bad option），
# 所以绝不按版本号判断，一律实测。
if "$NODE_BIN" -e "require('node:sqlite')" >/dev/null 2>&1; then
  c_ok "node:sqlite 可用（Node $("$NODE_BIN" -v)）"
else
  c_err "当前 Node.js 无法加载 node:sqlite（需 Node ≥ 22.5）。"
  die "运行时能力检查未通过"
fi

# 判据：**只有「不带标志跑不了、带了才行」才加标志**。
# 反过来判（带标志能跑就加）是错的——实测 v22.22 与 v24.14 带标志都能跑，
# 但不带标志它们同样能跑，加了只是白冒风险；而 v24.21 带标志会直接 bad option 崩溃。
if "$NODE_BIN" -e "require('node:sqlite')" >/dev/null 2>&1; then
  SQLITE_FLAG=""
  c_ok "启动参数: 不加实验标志（Node $("$NODE_BIN" -v) 裸跑即可）"
elif "$NODE_BIN" --experimental-sqlite -e "require('node:sqlite')" >/dev/null 2>&1; then
  SQLITE_FLAG="--experimental-sqlite"
  c_ok "启动参数: 需要 --experimental-sqlite（Node $("$NODE_BIN" -v) 较旧）"
else
  c_err "当前 Node.js 无法加载 node:sqlite（需 Node ≥ 22.5）。"
  die "运行时能力检查未通过"
fi

# =============================================================
# 3. 系统用户与目录
# =============================================================
c_step "3/9 创建系统用户与目录"

if ! id -u "$RUN_USER" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "$RUN_USER" \
    && c_ok "已创建系统用户: $RUN_USER"
else
  c_ok "系统用户已存在: $RUN_USER"
fi

install -d -m 755 -o root -g root "$APP_DIR"
# 数据目录属服务用户，权限收敛到 700 —— 里面有报销金额与票据原件
install -d -m 700 -o "$RUN_USER" -g "$RUN_USER" "$DATA_DIR" "$EXPORT_DIR"
install -d -m 750 -o "$RUN_USER" -g "$RUN_USER" "$LOG_DIR"
c_ok "目录就绪（数据目录权限 700，仅服务用户可读）"

# =============================================================
# 4. 同步代码
# =============================================================
c_step "4/9 同步应用代码"

if [[ -d "$APP_DIR/server" ]]; then
  c_warn "检测到已有安装，执行升级（数据库与上传票据将保留）"
  mkdir -p "$BACKUP_DIR"
  if [[ -f "$DATA_DIR/reimburse.db" ]]; then
    if command -v sqlite3 >/dev/null 2>&1; then
      sqlite3 "$DATA_DIR/reimburse.db" ".backup '${BACKUP_DIR}/reimburse-$(date +%Y%m%d-%H%M%S).db'" \
        && c_ok "升级前数据库已备份到 $BACKUP_DIR"
    else
      cp -a "$DATA_DIR/reimburse.db" "$BACKUP_DIR/reimburse-$(date +%Y%m%d-%H%M%S).db" \
        && c_ok "升级前数据库已复制备份（建议装 sqlite3 以获得事务一致备份）"
    fi
  fi
fi

for item in server package.json; do
  if [[ -e "$SRC_DIR/$item" ]]; then
    rm -rf "${APP_DIR:?}/$item"
    cp -a "$SRC_DIR/$item" "$APP_DIR/"
  fi
done
# 部署脚本自身也带上，方便在服务器上直接看文档与做备份
mkdir -p "$APP_DIR/deploy"
cp -a "$SRC_DIR/deploy/." "$APP_DIR/deploy/" 2>/dev/null || true

chown -R root:root "$APP_DIR"
chmod -R go-w "$APP_DIR"
c_ok "代码已同步到 $APP_DIR"

# =============================================================
# 5. 环境变量与访问鉴权
# =============================================================
c_step "5/9 配置访问鉴权"

install -d -m 700 /etc/reimburse

if [[ -f "$ENV_FILE" ]]; then
  c_ok "已存在 $ENV_FILE，保留原有密码（不覆盖）"
  # 老版本 env 里可能没写 PORT，补上，避免应用落到别的端口
  grep -q '^PORT=' "$ENV_FILE" || echo "PORT=${APP_PORT}" >> "$ENV_FILE"
else
  if [[ -z "${AUTH_PASS:-}" ]]; then
    AUTH_PASS="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)"
    GEN_PASS=1
  fi

  umask 077
  cat > "$ENV_FILE" <<EOF
# 天津仁爱学院报销系统 · 运行环境配置
# 由 deploy.sh 生成于 $(date '+%Y-%m-%d %H:%M:%S')
# 权限必须 600，切勿提交到 git 或放到公网可访问的位置

# 监听配置：保持 127.0.0.1，公网流量必须经 Nginx 转发
HOST=127.0.0.1
PORT=${APP_PORT}
NODE_ENV=production

# 数据目录（外置便于备份与迁移）
DATA_DIR=${DATA_DIR}
EXPORT_DIR=${EXPORT_DIR}

# 访问鉴权（Basic Auth，外层网关）
AUTH_USER=${AUTH_USER}
AUTH_PASS=${AUTH_PASS}
EOF
  chmod 600 "$ENV_FILE"
  c_ok "已生成 $ENV_FILE（权限 600）"
  if [[ "${GEN_PASS:-0}" == "1" ]]; then
    echo
    echo "  ┌────────────────────────────────────────────┐"
    echo "  │  访问账号  : ${AUTH_USER}"
    echo "  │  访问密码  : ${AUTH_PASS}   ← 请立即保存"
    echo "  │  （已自动生成，可在 $ENV_FILE 中修改）"
    echo "  └────────────────────────────────────────────┘"
    echo
  fi
fi

# =============================================================
# 6. systemd 服务
# =============================================================
c_step "6/9 注册 systemd 服务"

# 总是从模板重写：service 是本项目管理的文件，重写保证 --data-dir 等参数生效
install -m 644 "$SRC_DIR/deploy/reimburse.service" "$SERVICE_FILE"
# unit 里的加固路径要跟着实际数据目录走，否则 ProtectSystem=strict 下无法写入
sed -i "s#/var/lib/reimburse#${DATA_DIR}#g" "$SERVICE_FILE"

# ExecStart 必须按实测结果写死：Node 24 再传 --experimental-sqlite 会直接
# "bad option" 退出，服务反复崩溃。NODE_BIN 已在第 2 步按同一个二进制实测过。
EXEC_START="${NODE_BIN} server/index.js"
[[ -n "$SQLITE_FLAG" ]] && EXEC_START="${NODE_BIN} ${SQLITE_FLAG} server/index.js"
sed -i "s#^ExecStart=.*#ExecStart=${EXEC_START}#" "$SERVICE_FILE"

# 写完必须回读校验：sed 没匹配上（比如模板改了缩进）会静默留下带标志的旧值，
# 结果就是服务崩溃循环而脚本显示一切正常。
ACTUAL_EXEC="$(grep -m1 '^ExecStart=' "$SERVICE_FILE" || true)"
if [[ "$ACTUAL_EXEC" != "ExecStart=${EXEC_START}" ]]; then
  c_err "ExecStart 写入校验失败：期望 'ExecStart=${EXEC_START}'，实际 '${ACTUAL_EXEC}'"
  die "systemd unit 未正确生成"
fi
if [[ "$ACTUAL_EXEC" == *"experimental-sqlite"* ]]; then
  c_warn "注意：本次判定需要 --experimental-sqlite，请确认该 Node 版本确实接受此标志"
fi
c_ok "已安装 systemd unit（数据目录: $DATA_DIR）"
c_ok "启动命令: ${EXEC_START}（已回读校验）"

systemctl daemon-reload
systemctl enable "$APP_NAME" >/dev/null 2>&1
# 上一轮崩溃可能已触发启动限流进入 failed 状态，不清掉的话 restart 会被直接拒绝
systemctl reset-failed "$APP_NAME" 2>/dev/null || true
c_ok "已设置开机自启"

if ! systemctl restart "$APP_NAME"; then
  c_err "服务启动失败，最近日志："
  journalctl -u "$APP_NAME" -n 30 --no-pager || true
  die "服务未能启动"
fi
sleep 2
systemctl is-active --quiet "$APP_NAME" || {
  journalctl -u "$APP_NAME" -n 30 --no-pager || true
  die "服务未能启动"
}
c_ok "服务已启动"

# =============================================================
# 7. Nginx 反向代理
# =============================================================
c_step "7/9 配置 Nginx 反向代理"

if [[ "$SKIP_NGINX" == "1" ]]; then
  c_warn "已跳过 Nginx 配置（--skip-nginx）"
  c_warn "请自行确保网关把 ${PUBLIC_PORT} 转发到 127.0.0.1:${APP_PORT}"
elif ! command -v nginx >/dev/null 2>&1; then
  if [[ -n "$PKG" ]]; then
    c_warn "安装 Nginx …"
    $PKG install -y -q epel-release >/dev/null 2>&1 || true
    $PKG install -y -q "$NGINX_PKG" >/dev/null 2>&1 || c_warn "Nginx 安装失败，可稍后手动安装"
  fi
fi

# SELinux（CentOS/TencentOS）默认不允许 Nginx 监听非标准端口，也不允许
# 它向回环发起连接。不处理的话现象是「Nginx 起来了但一律 502」，极难排查。
if command -v getenforce >/dev/null 2>&1 && [[ "$(getenforce 2>/dev/null)" == "Enforcing" ]]; then
  c_warn "检测到 SELinux Enforcing，正在放行非标准端口与回环连接"
  $PKG install -y -q policycoreutils-python-utils >/dev/null 2>&1 || \
    $PKG install -y -q policycoreutils-python >/dev/null 2>&1 || true
  if command -v semanage >/dev/null 2>&1; then
    semanage port -a -t http_port_t -p tcp "$PUBLIC_PORT" 2>/dev/null || \
      semanage port -m -t http_port_t -p tcp "$PUBLIC_PORT" 2>/dev/null || \
      c_warn "semanage 放行端口失败，请手动执行：semanage port -a -t http_port_t -p tcp ${PUBLIC_PORT}"
  else
    c_warn "无 semanage，请手动放行：semanage port -a -t http_port_t -p tcp ${PUBLIC_PORT}"
  fi
  setsebool -P httpd_can_network_connect 1 2>/dev/null || \
    c_warn "setsebool 失败，请手动执行：setsebool -P httpd_can_network_connect 1"
fi

if command -v nginx >/dev/null 2>&1; then
  PY_BIN=""
  for cand in python3 python; do
    if command -v "$cand" >/dev/null 2>&1; then PY_BIN="$cand"; break; fi
  done
  [[ -n "$PY_BIN" ]] || die "未找到 python3，无法渲染 Nginx 配置。请先安装：apt install -y python3"

  RENDER_ARGS=(--port "$PUBLIC_PORT")
  [[ "$NO_HTTPS" == "1" ]] && RENDER_ARGS+=(--no-https)

  # 无域名形态：渲染结果引用自签证书，先确保证书存在（幂等，已存在则复用）
  if [[ "$NO_HTTPS" == "1" && ! -f /etc/nginx/ssl/reimburse.crt ]]; then
    mkdir -p /etc/nginx/ssl
    openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
      -keyout /etc/nginx/ssl/reimburse.key -out /etc/nginx/ssl/reimburse.crt \
      -subj "/CN=reimburse" >/dev/null 2>&1 \
      && c_ok "已生成自签证书 /etc/nginx/ssl/reimburse.crt（浏览器提示不安全属预期）" \
      || c_warn "自签证书生成失败，https 将不可用；可手动执行 openssl req -x509 ..."
  fi

  "$PY_BIN" "$SRC_DIR/deploy/render_nginx.py" \
    "$SRC_DIR/deploy/nginx.conf.template" "$NGX_SERVER_NAME" "$NGINX_CONF" "${RENDER_ARGS[@]}" \
    && c_ok "Nginx 配置已渲染（端口 $PUBLIC_PORT）"

  chmod 644 "$NGINX_CONF"
  # 默认站点可能与本配置抢端口（Debian 系默认有个 default 站点监听 80）
  if [[ "$PUBLIC_PORT" == "80" && -f /etc/nginx/sites-enabled/default ]]; then
    c_warn "发现 Nginx 默认站点也在监听 80，已禁用以免抢占"
    rm -f /etc/nginx/sites-enabled/default
  fi

  if nginx -t >/dev/null 2>&1; then
    systemctl reload nginx || systemctl restart nginx
    c_ok "Nginx 已重载"
  else
    c_err "Nginx 配置校验失败，输出如下："
    nginx -t || true
    die "请修正 $NGINX_CONF"
  fi
else
  c_warn "未检测到 Nginx，跳过反代配置"
fi

# =============================================================
# 8. 防火墙
# =============================================================
c_step "8/9 防火墙配置"

if [[ "$SKIP_FIREWALL" == "1" ]]; then
  c_warn "已跳过防火墙配置"
elif command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH >/dev/null 2>&1 || true
  ufw allow "${PUBLIC_PORT}/tcp" >/dev/null 2>&1
  [[ "$NO_HTTPS" == "0" ]] && { ufw allow 80/tcp >/dev/null 2>&1; ufw allow 443/tcp >/dev/null 2>&1; }
  ufw --force enable >/dev/null 2>&1
  c_ok "ufw 已放行 ${PUBLIC_PORT}（应用端口 ${APP_PORT} 未放行，只经 Nginx 访问）"
elif command -v firewall-cmd >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port="${PUBLIC_PORT}/tcp" >/dev/null 2>&1
  [[ "$NO_HTTPS" == "0" ]] && {
    firewall-cmd --permanent --add-service=http >/dev/null 2>&1
    firewall-cmd --permanent --add-service=https >/dev/null 2>&1
  }
  firewall-cmd --reload >/dev/null 2>&1
  c_ok "firewalld 已放行 ${PUBLIC_PORT}"
else
  c_warn "未识别防火墙工具，请手动确认安全组放行 ${PUBLIC_PORT}"
fi

# =============================================================
# 9. 部署后自检
# =============================================================
c_step "9/9 部署后自检"

# 先测应用层（绕开 Nginx 与鉴权），确认进程真的活着
if command -v curl >/dev/null 2>&1; then
  HEALTH=""
  for _ in $(seq 1 15); do
    HEALTH="$(curl -fsS --max-time 3 "http://127.0.0.1:${APP_PORT}/api/health" 2>/dev/null || true)"
    [[ -n "$HEALTH" ]] && break
    sleep 1
  done
  [[ -n "$HEALTH" ]] && c_ok "应用层健康检查通过: $HEALTH" || {
    journalctl -u "$APP_NAME" -n 30 --no-pager || true
    die "应用层无响应"
  }

  # 再测经 Nginx 的链路：前台与后台都要能拿到 200/401
  # 401 是正常的 —— 说明 Basic Auth 生效了，而不是页面没部署上去
  PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
  SCHEME="http"
  [[ "$NO_HTTPS" == "0" ]] && SCHEME="https"
  BASE="${SCHEME}://${DOMAIN:-127.0.0.1}"
  [[ -z "$DOMAIN" ]] && BASE="${SCHEME}://127.0.0.1:${PUBLIC_PORT}"
  [[ -n "$DOMAIN" && "$PUBLIC_PORT" != "80" && "$NO_HTTPS" == "1" ]] && BASE="${SCHEME}://${DOMAIN}:${PUBLIC_PORT}"

  for path in "/" "/admin"; do
    CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${BASE}${path}" 2>/dev/null || echo 000)"
    case "$CODE" in
      200|401) c_ok "经 Nginx 访问 ${path} → HTTP ${CODE}（401 表示 Basic Auth 已生效）" ;;
      000)     c_warn "${path} 无响应，检查 Nginx 与防火墙" ;;
      *)       c_warn "${path} 返回 HTTP ${CODE}" ;;
    esac
  done
else
  c_warn "未安装 curl，跳过自检"
fi

# =============================================================
# 完成
# =============================================================
printf '\n\033[1;32m'
cat <<EOF
════════════════════════════════════════════════════════════
  部署完成
════════════════════════════════════════════════════════════
EOF
if [[ -z "$DOMAIN" ]]; then
  echo "  前台地址 : http://${PUBLIC_IP:-服务器公网IP}:${PUBLIC_PORT}/"
  echo "  后台地址 : http://${PUBLIC_IP:-服务器公网IP}:${PUBLIC_PORT}/admin"
  echo ""
  echo "  ⚠️ 当前是 HTTP 明文传输 + IP 直访。"
  echo "     报销数据含金额与身份信息，正式使用前请："
  echo "       1) 准备一个已备案域名，解析到本机"
  echo "       2) sudo bash deploy/deploy.sh --domain 你的域名  (自动走 80/443)"
  echo "       3) certbot --nginx -d 你的域名"
else
  echo "  前台地址 : ${SCHEME}://${DOMAIN}/"
  echo "  后台地址 : ${SCHEME}://${DOMAIN}/admin"
  if [[ "$NO_HTTPS" == "0" ]]; then
    echo ""
    echo "  ⚠️ 证书尚未签发，443 还未生效。请执行："
    echo "       certbot --nginx -d ${DOMAIN}"
    echo "     临时可先用 HTTP 访问；或改用 --no-https 部署后再补证书。"
  fi
fi
echo ""
echo "  常用命令 :"
echo "    查看日志     sudo journalctl -u reimburse -f"
echo "    重启服务     sudo systemctl restart reimburse"
echo "    查看状态     sudo systemctl status reimburse"
echo "    手动备份     sudo bash $APP_DIR/deploy/backup.sh"
if [[ -n "${AUTH_PASS:-}" ]]; then
  echo ""
  echo "  访问账号   : ${AUTH_USER}"
  echo "  访问密码   : ${AUTH_PASS}"
fi
echo ""
echo "  云平台侧必做（脚本管不到，需手动）："
echo "    · 安全组放行 ${PUBLIC_PORT}（不要放行 ${APP_PORT}）"
echo "    · 22 端口来源限制为你的 IP，别开 0.0.0.0/0"
echo "    · 用域名访问需完成 ICP 备案（大陆服务器强制要求）"
echo ""
printf '\033[0m'
