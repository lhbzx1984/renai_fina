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
# 重新部署（换新版、先清掉服务器上的旧安装）：
#   bash deploy/onekey.sh --host 1.2.3.4 --reinstall
#   bash deploy/onekey.sh --host 1.2.3.4 --reinstall --migrate-user lhbzx1984
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
REINSTALL=0
KEEP_DATA=0
MIGRATE_USER=""
MIGRATE_BUNDLE="/opt/reimburse-user"

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
  --reinstall          先卸载服务器上的旧安装（数据自动备份到
                      /var/backups/reimburse/pre-uninstall-<时间>/），再部署新版
  --keep-data          配合 --reinstall：只卸程序，保留数据库与票据原件
  --migrate-user <名>  部署完成后，把本机该用户的数据迁到新系统（如 lhbzx1984），
                      只合并这一个用户，服务器上别人的数据不受影响
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
    --reinstall) REINSTALL=1; shift ;;
    --keep-data) KEEP_DATA=1; shift ;;
    --migrate-user) MIGRATE_USER="$2"; shift 2 ;;
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
c_step "1/5 打包源码"
TARBALL="$(mktemp -d)/reimburse.tar.gz"
# 白名单比黑名单可靠：data/ 里的数据库与票据原件绝不能上传覆盖生产数据
tar -czf "$TARBALL" -C "$SRC_DIR" server package.json deploy
SIZE="$(du -h "$TARBALL" | awk '{print $1}')"
c_ok "已打包 server/ + package.json + deploy/ （$SIZE）"

# ---------- 2. 上传 ----------
c_step "2/5 上传到服务器"
scp "${SCP_OPTS[@]}" "$TARBALL" "${TARGET}:/tmp/reimburse.tar.gz"
c_ok "已上传 /tmp/reimburse.tar.gz"

# ---------- 3. 远端解压 ----------
c_step "3/5 远端解压"
ssh "${SSH_OPTS[@]}" "$TARGET" \
  "rm -rf ${REMOTE_DIR} && mkdir -p ${REMOTE_DIR} && tar -xzf /tmp/reimburse.tar.gz -C ${REMOTE_DIR} && ls ${REMOTE_DIR}"
c_ok "远端源码就绪: ${REMOTE_DIR}"

SUDO=""
[[ "$USER_NAME" != "root" ]] && SUDO="sudo"

# ---------- 3.5 卸载旧安装（--reinstall 时才走） ----------
if [[ "$REINSTALL" == "1" ]]; then
  c_step "4/5 卸载服务器上的旧安装"
  c_warn "旧数据会自动备份到 /var/backups/reimburse/pre-uninstall-<时间>/，不是直接删除"
  UNINSTALL_ARGS=(-y)
  [[ "$KEEP_DATA" == "1" ]] && UNINSTALL_ARGS+=(--keep-data)
  [[ -n "$DATA_DIR" ]] && UNINSTALL_ARGS+=(--data-dir "$DATA_DIR")
  ssh "${SSH_OPTS[@]}" "$TARGET" \
    "cd ${REMOTE_DIR} && ${SUDO} bash deploy/uninstall.sh $(printf '%q ' "${UNINSTALL_ARGS[@]}")"
  c_ok "旧安装已清理"
else
  c_warn "未加 --reinstall：本次为增量升级，服务器上的数据库会保留"
fi

# ---------- 4. 远程部署 ----------
c_step "5/5 远程执行部署脚本"

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

# ---------- 5. 可选：把本机指定用户的数据迁到新系统 ----------
if [[ -n "$MIGRATE_USER" ]]; then
  c_step "附加步骤 · 迁移本机用户 ${MIGRATE_USER} 的数据"
  NODE_BIN_LOCAL="${NODE_BIN:-node}"
  command -v "$NODE_BIN_LOCAL" >/dev/null 2>&1 || \
    die "本机没找到 node，无法导出数据。请安装 Node 22+ 后重跑，或手动执行：node deploy/migrate/export-user.js --user ${MIGRATE_USER}"

  ( cd "$SRC_DIR" && "$NODE_BIN_LOCAL" deploy/migrate/export-user.js --user "$MIGRATE_USER" ) || \
    die "导出失败，迁移中止（服务器已部署完成，可稍后单独重跑迁移）"

  BUNDLE_DIR="$SRC_DIR/deploy/migrate/_user_${MIGRATE_USER}"
  [[ -d "$BUNDLE_DIR" ]] || die "没找到导出目录 $BUNDLE_DIR"

  MTARBALL="$(mktemp -d)/reimburse-user.tar.gz"
  tar -czf "$MTARBALL" -C "$BUNDLE_DIR" .
  c_ok "迁移包已打包（$(du -h "$MTARBALL" | awk '{print $1}')）"

  scp "${SCP_OPTS[@]}" "$MTARBALL" "${TARGET}:/opt/reimburse-user.tar.gz"
  ssh "${SSH_OPTS[@]}" "$TARGET" \
    "rm -rf ${MIGRATE_BUNDLE} && mkdir -p ${MIGRATE_BUNDLE} && tar -xzf /opt/reimburse-user.tar.gz -C ${MIGRATE_BUNDLE}"
  c_ok "迁移包已上传到服务器 ${MIGRATE_BUNDLE}"

  # 写库必须停服务；先 --dry 演练，确认无误再真跑
  FALLBACK_DATA="$DATA_DIR"
  ssh "${SSH_OPTS[@]}" "$TARGET" "bash -s" <<REMOTE
set -Eeuo pipefail
source /etc/reimburse/env 2>/dev/null || true
if [ -n "$FALLBACK_DATA" ]; then
  TARGET_DATA="$FALLBACK_DATA"
else
  TARGET_DATA="\${DATA_DIR:-/var/lib/reimburse}"
fi
echo "  目标库目录: \$TARGET_DATA"
${SUDO} systemctl stop reimburse || true
echo "—— 演练（不写库） ——"
node ${MIGRATE_BUNDLE}/import-user.js --bundle ${MIGRATE_BUNDLE} --target "\$TARGET_DATA" --dry || {
  echo "[ERR] 演练未通过，已停服务但未改数据。请修复后重跑导入。"; exit 1; }
echo "—— 正式导入 ——"
node ${MIGRATE_BUNDLE}/import-user.js --bundle ${MIGRATE_BUNDLE} --target "\$TARGET_DATA" || {
  echo "[ERR] 导入失败。回滚：systemctl stop reimburse && 换回 <db>.bak-<时间戳> && systemctl start reimburse"; exit 1; }
${SUDO} systemctl start reimburse
sleep 2
${SUDO} systemctl is-active --quiet reimburse && echo "  服务已启动" || { journalctl -u reimburse -n 20 --no-pager; exit 1; }
REMOTE

  rm -f "$MTARBALL"
  c_ok "用户 ${MIGRATE_USER} 的数据已合并进新系统"
  c_warn "收尾：核对无误后删掉服务器上的迁移包（里面有真实数据与邮箱授权码）："
  c_warn "      ssh ${TARGET} 'rm -rf ${MIGRATE_BUNDLE} /opt/reimburse-user.tar.gz'"
fi

rm -f "$TARBALL"
printf '\n\033[1;32m  一键部署流程结束。请把上面打印的访问账号密码保存好。\033[0m\n\n'
