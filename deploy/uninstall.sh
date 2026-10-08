#!/usr/bin/env bash
# =============================================================
# 天津仁爱学院报销系统 · 卸载旧安装（在【服务器】上执行）
#
# 作用：把之前那套（无用户隔离的旧版）服务与程序完全清掉，
#       为「重新部署新版 + 迁移指定用户数据」腾出干净环境。
#
# 常用：
#   sudo bash deploy/uninstall.sh                # 备份数据后彻底卸载（交互式确认）
#   sudo bash deploy/uninstall.sh -y             # 非交互（一键脚本远程调用时用）
#   sudo bash deploy/uninstall.sh --keep-data    # 只卸程序，保留数据库与票据
#   sudo bash deploy/uninstall.sh --no-backup -y # 空间不够时，不备份直接删（危险）
#
# 安全设计：
#   · 默认先把数据目录整目录挪到 /var/backups/reimburse/pre-uninstall-<时间戳>/
#     （不是删除），真出问题还能捞回来
#   · 没有 -y 且不是交互终端时直接退出，避免被误触发
#   · /var/backups 不在数据目录内，不会被自己清掉
# =============================================================
set -Eeuo pipefail

APP_NAME="reimburse"
APP_DIR="/opt/reimburse"
RUN_USER="reimburse"
ENV_FILE="/etc/reimburse/env"
SERVICE_FILE="/etc/systemd/system/reimburse.service"
NGINX_CONF="/etc/nginx/conf.d/reimburse.conf"
DATA_DIR="/var/lib/reimburse"
LOG_DIR="/var/log/reimburse"
BACKUP_ROOT="/var/backups/reimburse"

KEEP_DATA=0
NO_BACKUP=0
ASSUME_YES=0

c_ok()   { printf '\033[32m  [OK]\033[0m   %s\n' "$*"; }
c_warn() { printf '\033[33m  [WARN]\033[0m %s\n' "$*"; }
c_err()  { printf '\033[31m  [ERR]\033[0m  %s\n' "$*" >&2; }
c_step() { printf '\n\033[1;36m▌%s\033[0m\n' "$*"; }
die()    { c_err "$*"; exit 1; }

usage() {
  cat <<'EOF'
卸载报销系统（服务器本机执行）

用法：
  sudo bash deploy/uninstall.sh [选项]

选项：
  -y, --yes           跳过确认（脚本远程调用时必须给）
      --keep-data     保留数据目录（数据库/票据/导出件），只卸程序
      --no-backup     不做卸载前备份，直接删（仅在磁盘不够时用）
      --data-dir <路径>  数据目录，默认 /var/lib/reimburse
      --app-dir <路径>   程序目录，默认 /opt/reimburse
  -h, --help          显示本帮助
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -y|--yes)        ASSUME_YES=1; shift ;;
    --keep-data)     KEEP_DATA=1; shift ;;
    --no-backup)     NO_BACKUP=1; shift ;;
    --data-dir)      DATA_DIR="$2"; shift 2 ;;
    --app-dir)       APP_DIR="$2"; shift 2 ;;
    -h|--help)       usage; exit 0 ;;
    *)               c_err "未知参数: $1"; usage; exit 1 ;;
  esac
done

# 本机（Windows Git Bash）误跑会直接把脚本变量套到 MSYS 路径上，先拦一道
case "$(uname -s 2>/dev/null || echo unknown)" in
  MINGW*|MSYS*|CYGWIN*)
    die "这是服务器卸载脚本，别在本机跑。要清理服务器请用：bash deploy/onekey.sh --host <IP> --reinstall"
    ;;
esac
command -v systemctl >/dev/null 2>&1 || die "没找到 systemctl，本脚本只支持 systemd 的 Linux 服务器"

[[ "$(id -u)" -eq 0 ]] || die "请用 root 执行：sudo bash deploy/uninstall.sh"

trap 'c_err "卸载中断，行号 $LINENO。已备份的数据在 ${BACKUP_ROOT}/pre-uninstall-* 下。"' ERR

c_step "卸载检查"
echo "  程序目录 : $APP_DIR"
echo "  数据目录 : $DATA_DIR"
echo "  日志目录 : $LOG_DIR"
echo "  备份目录 : $BACKUP_ROOT"
[[ "$KEEP_DATA" == "1" ]] && echo "  模式     : 只卸程序，保留数据"
[[ "$NO_BACKUP" == "1" ]] && echo "  模式     : 不备份直接删"

if [[ "$ASSUME_YES" != "1" ]]; then
  if [[ ! -t 0 ]]; then
    die "非交互执行必须显式加 -y，防止误删。取消请直接 Ctrl+C。"
  fi
  printf '\n\033[1;33m  这会停掉服务并删除程序；数据默认只挪到备份目录。继续？[y/N]\033[0m '
  read -r ans
  [[ "$ans" == "y" || "$ans" == "Y" ]] || die "已取消，什么都没动。"
fi

# =============================================================
# 1. 停服务、摘掉开机自启
# =============================================================
c_step "1/5 停止并注销服务"
if systemctl list-unit-files 2>/dev/null | grep -q "^${APP_NAME}\.service"; then
  systemctl stop "$APP_NAME" 2>/dev/null || c_warn "服务已停止或停止失败，继续"
  systemctl disable "$APP_NAME" 2>/dev/null || true
  c_ok "已停止并取消开机自启"
else
  c_warn "未注册 ${APP_NAME}.service，跳过"
fi

# 老安装可能留下跑着的 node 进程（比如手工 nohup 起的），一并清掉
if pgrep -f "server/index.js" >/dev/null 2>&1; then
  c_warn "发现残留 node 进程，正在结束"
  pkill -f "server/index.js" 2>/dev/null || true
  sleep 1
  c_ok "残留进程已清理"
fi

rm -f "$SERVICE_FILE"
systemctl daemon-reload 2>/dev/null || true
systemctl reset-failed "$APP_NAME" 2>/dev/null || true
c_ok "systemd unit 已移除"

# =============================================================
# 2. 摘掉 Nginx 反代
# =============================================================
c_step "2/5 移除 Nginx 反向代理"
NGX_BIN=""
for cand in nginx /usr/sbin/nginx /www/server/nginx/sbin/nginx; do
  if command -v "$cand" >/dev/null 2>&1; then NGX_BIN="$cand"; break
  fi
done

# 宝塔面板会把站点配置放在自己的目录，conf.d 之外再找一遍
NGX_CONFS=("$NGINX_CONF" "/www/server/panel/vhost/nginx/reimburse.conf" "/www/server/nginx/conf/reimburse.conf")
for conf in "${NGX_CONFS[@]}"; do
  [[ -f "$conf" ]] || continue
  rm -f "$conf"
  c_ok "已删除 $conf"
done

# 只删了 conf.d 里那份而主配置还有 include 也不影响；有 nginx 就校验并重载
if [[ -n "$NGX_BIN" ]]; then
  if "$NGX_BIN" -t >/dev/null 2>&1; then
    systemctl reload nginx 2>/dev/null || systemctl restart nginx 2>/dev/null || \
      "$NGX_BIN" -s reload 2>/dev/null || true
    c_ok "Nginx 已重载"
  else
    c_warn "Nginx 配置校验未通过，请手动检查后重载：nginx -t"
  fi
else
  c_warn "未检测到 Nginx，跳过"
fi

# =============================================================
# 3. 备份（默认只挪不删）
# =============================================================
STAMP="$(date +%Y%m%d-%H%M%S)"
SNAP="${BACKUP_ROOT}/pre-uninstall-${STAMP}"

c_step "3/5 卸载前备份"
mkdir -p "$SNAP"

if [[ "$NO_BACKUP" == "1" ]]; then
  c_warn "--no-backup：跳过数据备份（数据将不可恢复）"
elif [[ -e "$DATA_DIR" ]]; then
  NEED="$(du -sk "$DATA_DIR" 2>/dev/null | awk '{print $1}')"
  NEED="${NEED:-0}"
  AVAIL="$(df -k "$BACKUP_ROOT" 2>/dev/null | awk 'NR==2{print $4}')"
  AVAIL="${AVAIL:-0}"
  if [[ "$AVAIL" -gt 0 && "$NEED" -gt "$AVAIL" ]]; then
    die "备份空间不足：需要 ${NEED}KB，${BACKUP_ROOT} 只剩 ${AVAIL}KB。先清理或改用 --no-backup。"
  fi

  # 同分区 mv 是瞬时的；跨分区 mv 会退化成拷贝，都能自动处理
  if mv "$DATA_DIR" "${SNAP}/data" 2>/dev/null; then
    c_ok "数据目录已整体移入 ${SNAP}/data（未删除）"
  else
    c_warn "mv 失败（可能跨分区），改用拷贝"
    mkdir -p "${SNAP}/data"
    cp -a "$DATA_DIR/." "${SNAP}/data/" && rm -rf "$DATA_DIR"
    c_ok "数据目录已复制到 ${SNAP}/data 并删除原目录"
  fi
else
  c_warn "数据目录不存在，无需备份"
fi

if [[ -f "$ENV_FILE" ]]; then
  cp -a "$ENV_FILE" "${SNAP}/env" && c_ok "访问口令已备份到 ${SNAP}/env"
fi

# =============================================================
# 4. 删除程序与配置
# =============================================================
c_step "4/5 删除程序与配置"
[[ -d "$APP_DIR" ]] && { rm -rf "$APP_DIR"; c_ok "已删除 $APP_DIR"; } || c_warn "$APP_DIR 不存在"
[[ -d /etc/reimburse ]] && { rm -rf /etc/reimburse; c_ok "已删除 /etc/reimburse（含 Basic Auth 口令）"; } || true
[[ -d "$LOG_DIR" ]] && { rm -rf "$LOG_DIR"; c_ok "已删除 $LOG_DIR"; } || true
if [[ "$KEEP_DATA" != "1" && -e "$DATA_DIR" ]]; then
  rm -rf "$DATA_DIR"
  c_ok "已删除 $DATA_DIR"
elif [[ "$KEEP_DATA" == "1" ]]; then
  c_warn "--keep-data：保留 $DATA_DIR 未动"
fi

# 系统用户保留：删了再装还得重建，且可能有文件属主残留。仅提示。
if id -u "$RUN_USER" >/dev/null 2>&1; then
  c_warn "系统用户 $RUN_USER 保留（重装会复用，无需处理）"
fi

# =============================================================
# 5. 校验与后续指引
# =============================================================
c_step "5/5 校验"
systemctl is-active --quiet "$APP_NAME" 2>/dev/null && die "服务仍在运行，卸载未完成" || c_ok "服务已停止"
[[ -e "$APP_DIR" ]] && die "程序目录仍存在" || c_ok "程序目录已清空"
if [[ -n "$NGX_BIN" ]]; then
  curl -s -o /dev/null -m 3 "http://127.0.0.1:5180/api/health" 2>/dev/null && \
    c_warn "5180 端口仍有响应，检查是否有别的进程在跑" || c_ok "5180 端口已释放"
fi

if [[ "$NO_BACKUP" != "1" && -d "${SNAP}/data" ]]; then
  printf '\n\033[1;33m  旧数据留了一份在：%s/data\033[0m\n' "$SNAP"
  printf '\033[1;33m  确认新系统跑稳之前请不要删它。\033[0m\n'
fi

printf '\n\033[1;32m  卸载完成。下一步：重新部署 + 迁移指定用户数据\033[0m\n'
cat <<'EOF'

  全新部署（服务器上已有源码时）：
      cd <源码目录> && sudo bash deploy/deploy.sh --port 18080

  本机一键推（推荐，Git Bash 里跑）：
      bash deploy/onekey.sh --host <服务器IP> --port 18080 --reinstall

  部署完再迁数据，详见：deploy/REDEPLOY.md
EOF
