#!/usr/bin/env bash
# =============================================================
# 天津仁爱学院报销系统 · 一键部署（Linux / 阿里云 / 腾讯云 ECS）
#
# 用法：
#   sudo bash deploy/deploy.sh --domain reimburse.example.com
#   sudo bash deploy/deploy.sh --domain 1.2.3.4 --no-https --auth-user admin
#
# 幂等：可重复执行以升级（会保留数据库）
# =============================================================
set -Eeuo pipefail

# ---------- 常量 ----------
APP_NAME="reimburse"
APP_DIR="/opt/reimburse"
DATA_DIR="/var/lib/reimburse"
EXPORT_DIR="/var/lib/reimburse/exports"
LOG_DIR="/var/log/reimburse"
RUN_USER="reimburse"
ENV_FILE="/etc/reimburse/env"
SERVICE_FILE="/etc/systemd/system/reimburse.service"
NGINX_CONF="/etc/nginx/conf.d/reimburse.conf"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="/var/backups/reimburse"
NODE_MAJOR_REQUIRED=22

# ---------- 参数 ----------
DOMAIN=""
AUTH_USER="admin"
NO_HTTPS=0
SKIP_FIREWALL=0
SKIP_NGINX=0

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
  --domain <域名或IP>   访问用的域名或公网 IP（用于 Nginx 配置），必填
  --auth-user <用户名>   访问认证用户名，默认 admin
  --auth-pass <密码>     访问认证密码，不传则自动生成强随机密码
  --no-https             不配置 HTTPS（仅内网/测试用；公网强烈建议配）
  --skip-nginx           不配置 Nginx（若已有网关，如 SLB/ingress）
  --skip-firewall        不改动防火墙规则
  -h, --help             显示本帮助

示例：
  sudo bash deploy/deploy.sh --domain reimburse.renai.edu.cn
  sudo bash deploy/deploy.sh --domain 1.2.3.4 --no-https
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)       DOMAIN="$2"; shift 2 ;;
    --auth-user)    AUTH_USER="$2"; shift 2 ;;
    --auth-pass)    AUTH_PASS="$2"; shift 2 ;;
    --no-https)     NO_HTTPS=1; shift ;;
    --skip-nginx)   SKIP_NGINX=1; shift ;;
    --skip-firewall) SKIP_FIREWALL=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    *)              c_err "未知参数: $1"; usage; exit 1 ;;
  esac
done

[[ $EUID -eq 0 ]] || die "请用 root 运行：sudo bash deploy/deploy.sh"

c_step "天津仁爱学院报销系统 · 部署"
echo "  源码目录 : $SRC_DIR"
echo "  安装目录 : $APP_DIR"
echo "  数据目录 : $DATA_DIR"
echo "  访问地址 : ${DOMAIN:-<未指定>}"

if [[ -z "$DOMAIN" ]]; then
  echo
  usage
  die "缺少 --domain 参数"
fi

# =============================================================
# 1. 系统检查
# =============================================================
c_step "1/8 系统与环境检查"
[[ -f /etc/os-release ]] && c_ok "系统: $(. /etc/os-release && echo "$PRETTY_NAME")"

# 包管理器：apt / yum / dnf
if command -v apt-get >/dev/null 2>&1; then
  PKG="apt-get"; PKG_UPDATE="apt-get update -qq"
  NGINX_PKG="nginx"
elif command -v dnf >/dev/null 2>&1; then
  PKG="dnf"; PKG_UPDATE="dnf install -y -q epel-release || true"
  NGINX_PKG="nginx"
elif command -v yum >/dev/null 2>&1; then
  PKG="yum"; PKG_UPDATE="yum install -y -q epel-release || true"
  NGINX_PKG="nginx"
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

# =============================================================
# 2. 安装 Node.js（若版本不足）
# =============================================================
c_step "2/8 Node.js 运行时"

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local maj
  maj="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
  [[ -n "$maj" && "$maj" -ge "$NODE_MAJOR_REQUIRED" ]]
}

install_node() {
  local ver="v22.22.2"
  local url="https://nodejs.org/dist/${ver}/node-${ver}-linux-${NODE_ARCH}.tar.xz"
  local tmp
  tmp="$(mktemp -d)"
  c_warn "Node.js 版本不足或未安装，正在安装 ${ver} …"
  if [[ -n "$PKG" ]]; then $PKG_UPDATE >/dev/null 2>&1 || true; $PKG install -y -q curl xz tar >/dev/null 2>&1 || true; fi
  command -v curl >/dev/null 2>&1 || die "需要 curl 请手动安装后重试"
  curl -fsSL "$url" -o "${tmp}/node.tar.xz" || die "下载 Node.js 失败（$url）"
  tar -xJf "${tmp}/node.tar.xz" -C /usr/local --strip-components=1 --exclude='CHANGELOG.md' --exclude='LICENSE' --exclude='README.md'
  rm -rf "$tmp"
  hash -r 2>/dev/null || true
}

if node_ok; then
  c_ok "Node.js: $(node -v) （满足 ≥ ${NODE_MAJOR_REQUIRED}）"
else
  install_node
  node_ok || die "Node.js 安装后仍不可用，请手动检查"
  c_ok "Node.js: $(node -v) （已安装）"
fi

# node:sqlite 是 Node 22 内置的实验特性，必须验证可用
if node -e "require('node:sqlite')" >/dev/null 2>&1; then
  c_ok "node:sqlite 可用"
else
  c_err "当前 Node.js 无法加载 node:sqlite。"
  c_err "本项目依赖 Node 22+ 内置数据库，请升级到 Node 22.5 以上。"
  die "运行时能力检查未通过"
fi

# =============================================================
# 3. 系统用户与目录
# =============================================================
c_step "3/8 创建系统用户与目录"

if ! id -u "$RUN_USER" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "$RUN_USER" \
    && c_ok "已创建系统用户: $RUN_USER"
else
  c_ok "系统用户已存在: $RUN_USER"
fi

install -d -m 755 -o root -g root "$APP_DIR"
# 数据目录属服务用户，且权限收敛到 700 —— 里面有报销金额与票据原件
install -d -m 700 -o "$RUN_USER" -g "$RUN_USER" "$DATA_DIR" "$EXPORT_DIR"
install -d -m 750 -o "$RUN_USER" -g "$RUN_USER" "$LOG_DIR"
c_ok "目录就绪（数据目录权限 700，仅服务用户可读）"

# =============================================================
# 4. 同步代码
# =============================================================
c_step "4/8 同步应用代码"

# 首次部署：整目录拷过去；升级：同步代码但保留 data/ 与 exports/
if [[ -d "$APP_DIR/server" ]]; then
  c_warn "检测到已有安装，执行升级（数据库与上传票据将保留）"
  # 升级前先备份，避免新版有 bug 时无法回退
  mkdir -p "$BACKUP_DIR"
  if [[ -f "$DATA_DIR/reimburse.db" ]]; then
    if command -v sqlite3 >/dev/null 2>&1; then
      sqlite3 "$DATA_DIR/reimburse.db" ".backup '${BACKUP_DIR}/reimburse-$(date +%Y%m%d-%H%M%S).db'" \
        && c_ok "升级前数据库已备份到 $BACKUP_DIR"
    else
      cp -a "$DATA_DIR/reimburse.db" "$BACKUP_DIR/reimburse-$(date +%Y%m%d-%H%M%S).db" \
        && c_ok "升级前数据库已复制备份（建议安装 sqlite3 以获得一致性备份）"
    fi
  fi
fi

# 只同步运行所需文件；node_modules 天然不存在（零依赖项目）
for item in server package.json; do
  if [[ -e "$SRC_DIR/$item" ]]; then
    rm -rf "${APP_DIR:?}/$item"
    cp -a "$SRC_DIR/$item" "$APP_DIR/"
  fi
done
# 部署脚本自身也带上，方便在服务器上直接看文档
mkdir -p "$APP_DIR/deploy"
cp -a "$SRC_DIR/deploy/." "$APP_DIR/deploy/" 2>/dev/null || true

chown -R root:root "$APP_DIR"
# 服务用户只需读代码，数据写入 DATA_DIR（已放开权限）
chmod -R go-w "$APP_DIR"
c_ok "代码已同步到 $APP_DIR"

# =============================================================
# 5. 环境变量与访问鉴权
# =============================================================
c_step "5/8 配置访问鉴权"

install -d -m 700 /etc/reimburse

if [[ -f "$ENV_FILE" ]]; then
  c_ok "已存在 $ENV_FILE，保留原有密码（不覆盖）"
else
  if [[ -z "${AUTH_PASS:-}" ]]; then
    # 16 字节随机，转 base64 取字母数字部分；避开易混淆字符
    AUTH_PASS="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)"
    GEN_PASS=1
  fi

  umask 077
  cat > "$ENV_FILE" <<EOF
# 天津仁爱学院报销系统 · 运行环境配置
# 由 deploy.sh 生成于 $(date '+%Y-%m-%d %H:%M:%S')
# 权限必须 600，切勿提交到 git 或公网可访问的位置

# 监听配置：保持 127.0.0.1，公网流量经 Nginx 转发
HOST=127.0.0.1
PORT=5180
NODE_ENV=production

# 数据目录（外置便于备份与迁移）
DATA_DIR=${DATA_DIR}
EXPORT_DIR=${EXPORT_DIR}

# 访问鉴权（Basic Auth）
AUTH_USER=${AUTH_USER}
AUTH_PASS=${AUTH_PASS}
EOF
  chmod 600 "$ENV_FILE"
  c_ok "已生成 $ENV_FILE（权限 600）"
  if [[ "${GEN_PASS:-0}" == "1" ]]; then
    echo
    echo "  ┌────────────────────────────────────────────┐"
    echo "  │  访问账号  : ${AUTH_USER}                       │"
    echo "  │  访问密码  : ${AUTH_PASS}   ← 请立即保存       │"
    echo "  │  （已自动生成，可在 $ENV_FILE 中修改）        │"
    echo "  └────────────────────────────────────────────┘"
    echo
  fi
fi

# =============================================================
# 6. systemd 服务
# =============================================================
c_step "6/8 注册 systemd 服务"

if [[ ! -f "$SERVICE_FILE" ]]; then
  install -m 644 "$SRC_DIR/deploy/reimburse.service" "$SERVICE_FILE"
  c_ok "已安装 systemd unit"
else
  c_ok "systemd unit 已存在，保留现有配置"
fi

systemctl daemon-reload
systemctl enable "$APP_NAME" >/dev/null 2>&1
c_ok "已设置开机自启"

if systemctl restart "$APP_NAME"; then
  sleep 2
  if systemctl is-active --quiet "$APP_NAME"; then
    c_ok "服务已启动"
  else
    c_err "服务启动失败，最近日志："
    journalctl -u "$APP_NAME" -n 30 --no-pager || true
    die "服务未能启动"
  fi
else
  c_err "服务启动失败，最近日志："
  journalctl -u "$APP_NAME" -n 30 --no-pager || true
  die "服务未能启动"
fi

# 健康检查：走本机回环，绕开 Nginx 与鉴权
if command -v curl >/dev/null 2>&1; then
  HEALTH=""
  for _ in $(seq 1 10); do
    HEALTH="$(curl -fsS --max-time 3 http://127.0.0.1:5180/api/health 2>/dev/null || true)"
    [[ -n "$HEALTH" ]] && break
    sleep 1
  done
  if [[ -n "$HEALTH" ]]; then
    c_ok "健康检查通过: $HEALTH"
  else
    c_err "健康检查未通过"
    journalctl -u "$APP_NAME" -n 30 --no-pager || true
    die "服务无响应"
  fi
fi

# =============================================================
# 7. Nginx 反向代理
# =============================================================
c_step "7/8 配置 Nginx 反向代理"

if [[ "$SKIP_NGINX" == "1" ]]; then
  c_warn "已跳过 Nginx 配置（--skip-nginx）"
  c_warn "请自行确保网关把 80/443 转发到 127.0.0.1:5180"
elif ! command -v nginx >/dev/null 2>&1; then
  if [[ -n "$PKG" ]]; then
    c_warn "安装 Nginx …"
    $PKG install -y -q "$NGINX_PKG" >/dev/null 2>&1 || \
      $PKG install -y -q epel-release >/dev/null 2>&1 && $PKG install -y -q "$NGINX_PKG" >/dev/null 2>&1 \
      || c_warn "Nginx 安装失败，可稍后手动安装"
  fi
fi

if command -v nginx >/dev/null 2>&1; then
  if [[ "$NO_HTTPS" == "1" ]]; then
    # 只生成 80 端口配置。443 块引用了尚未签发的证书，保留会让 nginx -t 直接失败。
    EXTRA_ARGS=(--no-https)
    HTTPS_NOTE=1
  else
    EXTRA_ARGS=()
    HTTPS_NOTE=0
  fi

  # 挑一个可用的 Python 来做模板渲染（CentOS/腾讯云多为 python3，Ubuntu 亦可）
  PY_BIN=""
  for cand in python3 python; do
    if command -v "$cand" >/dev/null 2>&1; then PY_BIN="$cand"; break; fi
  done
  if [[ -n "$PY_BIN" ]]; then
    "$PY_BIN" "$SRC_DIR/deploy/render_nginx.py" \
      "$SRC_DIR/deploy/nginx.conf.template" "$DOMAIN" "$NGINX_CONF" "${EXTRA_ARGS[@]}" \
      && c_ok "Nginx 配置已渲染"
  else
    # 无 Python 时退回 sed（此时只能走 HTTPS 分支）
    if [[ "$HTTPS_NOTE" == "1" ]]; then
      c_warn "未检测到 Python，无法剔除 HTTPS 块；请先安装 python3 或手动编辑 $NGINX_CONF"
    else
      sed "s/__DOMAIN__/${DOMAIN}/g" "$SRC_DIR/deploy/nginx.conf.template" > "$NGINX_CONF"
      c_ok "Nginx 配置已生成（sed 方式）"
    fi
  fi

  chmod 644 "$NGINX_CONF"
  nginx -t >/dev/null 2>&1 && { systemctl reload nginx || systemctl restart nginx; c_ok "Nginx 已重载"; } \
    || { c_err "Nginx 配置校验失败："; nginx -t; die "请修正配置"; }
else
  c_warn "未检测到 Nginx，跳过反代配置"
fi

# =============================================================
# 8. 防火墙
# =============================================================
c_step "8/8 防火墙配置"

if [[ "$SKIP_FIREWALL" == "1" ]]; then
  c_warn "已跳过防火墙配置"
elif command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH >/dev/null 2>&1 || true
  ufw allow 80/tcp >/dev/null 2>&1
  ufw allow 443/tcp >/dev/null 2>&1
  ufw --force enable >/dev/null 2>&1
  c_ok "ufw 已放行 80/443（5180 未放行，只经 Nginx 访问）"
elif command -v firewall-cmd >/dev/null 2>&1; then
  firewall-cmd --permanent --add-service=http >/dev/null 2>&1
  firewall-cmd --permanent --add-service=https >/dev/null 2>&1
  firewall-cmd --reload >/dev/null 2>&1
  c_ok "firewalld 已放行 80/443"
else
  c_warn "未识别防火墙工具（ufw/firewalld），请手动确认安全组只放行 80/443"
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
if [[ "$NO_HTTPS" == "1" ]]; then
  echo "  访问地址 : http://${DOMAIN}"
  echo "            ⚠️ 当前是 HTTP 明文传输。财务数据正式上线请务必配 HTTPS，"
  echo "              见 deploy/DEPLOY.md 的「补配 HTTPS」一节。"
else
  echo "  访问地址 : https://${DOMAIN}"
  echo ""
  echo "  ⚠️ 证书尚未签发，当前 443 还未生效。请执行："
  echo "       certbot --nginx -d ${DOMAIN}"
  echo "     临时可用 HTTP 访问；或先用 --no-https 部署再补证书。"
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
echo "  云平台侧必做："
echo "    · 安全组放行 80/443（不要放行 5180）"
echo "    · 域名需完成 ICP 备案（大陆服务器强制要求）"
echo ""
printf '\033[0m'
