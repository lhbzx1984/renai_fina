#!/usr/bin/env bash
# =============================================================
# 天津仁爱学院报销系统 · 本机一键部署
#
# 在 Windows Git Bash / macOS / Linux 本机执行，一条命令完成：
#   打包源码 → 上传服务器 → 远程执行 deploy.sh → 回显访问地址
#
# 用法：
#   bash deploy/onekey.sh --host 1.2.3.4
#   bash deploy/onekey.sh --host 1.2.3.4 --port 18080
#   bash deploy/onekey.sh --host 1.2.3.4 --domain reimburse.example.com
#   bash deploy/onekey.sh --host 1.2.3.4 --user ubuntu --key ~/.ssh/id_ed25519
#
# 前提：本机可用 ssh / scp（Git Bash 自带），且能免密或密码登录服务器。
# =============================================================
set -Eeuo pipefail

# MSYS 会把 /tmp、/opt 这类路径转成 Windows 路径，导致远端收到乱码路径
export MSYS_NO_PATHCONV=1

HOST=""
USER_NAME="root"
SSH_PORT=22
SSH_KEY=""
PORT="18080"
DOMAIN=""
DATA_DIR=""
AUTH_USER_ARG="admin"
AUTH_PASS_ARG=""
REMOTE_DIR="/tmp/reimburse-src"

c_ok()   { printf '\033[32m  [OK]\033[0m   %s\n' "$*"; }
c_warn() { printf '\033[33m  [WARN]\033[0m %s\n' "$*"; }
c_err()  { printf '\033[31m  [ERR]\033[0m  %s\n' "$*" >&2; }
c_step() { printf '\n\033[1;36m▌%s\033[0m\n' "$*"; }
die()    { c_err "$*"; exit 1; }

usage() {
  cat <<'EOF'
本机一键部署（打包 → 上传 → 远程部署）

用法：
  bash deploy/onekey.sh --host <服务器IP或域名> [选项]

选项：
  --host <地址>        服务器公网 IP 或域名，必填
  --user <用户名>      SSH 登录用户，默认 root
  --ssh-port <端口>    SSH 端口，默认 22
  --key <密钥路径>     指定私钥，默认用 SSH agent 里的
  --port <端口>        站点对外端口，默认 18080
  --domain <域名>      已备案域名；给了则走 80/443 + HTTPS
  --data-dir <路径>    服务器上的数据目录，默认 /var/lib/reimburse
  --auth-user <用户名> Basic Auth 用户名，默认 admin
  --auth-pass <密码>   Basic Auth 密码，不给则由服务器自动生成
  -h, --help           显示本帮助
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)      HOST="$2"; shift 2 ;;
    --user)      USER_NAME="$2"; shift 2 ;;
    --ssh-port)  SSH_PORT="$2"; shift 2 ;;
    --key)       SSH_KEY="$2"; shift 2 ;;
    --port)      PORT="$2"; shift 2 ;;
    --domain)    DOMAIN="$2"; shift 2 ;;
    --data-dir)  DATA_DIR="$2"; shift 2 ;;
    --auth-user) AUTH_USER_ARG="$2"; shift 2 ;;
    --auth-pass) AUTH_PASS_ARG="$2"; shift 2 ;;
    -h|--help)   usage; exit 0 ;;
    *)           c_err "未知参数: $1"; usage; exit 1 ;;
  esac
done

[[ -n "$HOST" ]] || { usage; die "缺少 --host"; }

command -v ssh >/dev/null 2>&1 || die "本机没有 ssh，请在 Git Bash 中运行"
command -v scp >/dev/null 2>&1 || die "本机没有 scp，请在 Git Bash 中运行"

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ ! -f "$SRC_DIR/server/index.js" ]]; then
  c_err "没找到源码入口: $SRC_DIR/server/index.js"
  c_err ""
  c_err "如果这台机器就是目标服务器，不要用本脚本——它负责从本机上传到服务器。"
  c_err "请直接在项目根目录执行就地部署："
  c_err "    cd $SRC_DIR && sudo bash deploy/deploy.sh --port 18080"
  die "源码目录不完整，先确认 $SRC_DIR 下是否有 server/ 目录"
fi

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -p "$SSH_PORT")
[[ -n "$SSH_KEY" ]] && SSH_OPTS+=(-i "$SSH_KEY")
SCP_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -P "$SSH_PORT")
[[ -n "$SSH_KEY" ]] && SCP_OPTS+=(-i "$SSH_KEY")

TARGET="${USER_NAME}@${HOST}"

c_step "本机一键部署 → ${TARGET}"
echo "  源码目录 : $SRC_DIR"
echo "  对外端口 : $PORT"
[[ -n "$DOMAIN" ]] && echo "  域名     : $DOMAIN"

# ---------- 1. 打包（白名单：只传运行必需的东西） ----------
c_step "1/4 打包源码"
TARBALL="$(mktemp -d)/reimburse.tar.gz"
# 白名单比黑名单可靠：data/ 里的数据库与票据原件绝不能上传覆盖生产数据
tar -czf "$TARBALL" -C "$SRC_DIR" server package.json deploy
SIZE="$(du -h "$TARBALL" | awk '{print $1}')"
c_ok "已打包 server/ + package.json + deploy/ （$SIZE）"

# ---------- 2. 上传 ----------
c_step "2/4 上传到服务器"
scp "${SCP_OPTS[@]}" "$TARBALL" "${TARGET}:/tmp/reimburse.tar.gz"
c_ok "已上传 /tmp/reimburse.tar.gz"

# ---------- 3. 远端解压 ----------
c_step "3/4 远端解压"
ssh "${SSH_OPTS[@]}" "$TARGET" \
  "rm -rf ${REMOTE_DIR} && mkdir -p ${REMOTE_DIR} && tar -xzf /tmp/reimburse.tar.gz -C ${REMOTE_DIR} && ls ${REMOTE_DIR}"
c_ok "远端源码就绪: ${REMOTE_DIR}"

# ---------- 4. 远程部署 ----------
c_step "4/4 远程执行部署脚本"
SUDO=""
[[ "$USER_NAME" != "root" ]] && SUDO="sudo"

DEPLOY_ARGS=(--port "$PORT" --auth-user "$AUTH_USER_ARG")
[[ -n "$DOMAIN" ]]   && DEPLOY_ARGS+=(--domain "$DOMAIN")
[[ -n "$DATA_DIR" ]] && DEPLOY_ARGS+=(--data-dir "$DATA_DIR")
[[ -n "$AUTH_PASS_ARG" ]] && DEPLOY_ARGS+=(--auth-pass "$AUTH_PASS_ARG")

# 远端命令：非 root 用户加 sudo；-t 让 sudo 能读到密码输入
if [[ -n "$SUDO" ]]; then
  ssh -t "${SSH_OPTS[@]}" "$TARGET" \
    "cd ${REMOTE_DIR} && sudo bash deploy/deploy.sh $(printf '%q ' "${DEPLOY_ARGS[@]}")"
else
  ssh "${SSH_OPTS[@]}" "$TARGET" \
    "cd ${REMOTE_DIR} && bash deploy/deploy.sh $(printf '%q ' "${DEPLOY_ARGS[@]}")"
fi

rm -f "$TARBALL"
printf '\n\033[1;32m  一键部署流程结束。请把上面打印的访问账号密码保存好。\033[0m\n\n'
