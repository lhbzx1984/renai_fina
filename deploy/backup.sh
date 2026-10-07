#!/usr/bin/env bash
# =============================================================
# 天津仁爱学院报销系统 · 数据备份 / 恢复
#
# 用法：
#   sudo bash deploy/backup.sh              # 备份到默认目录
#   sudo bash deploy/backup.sh --keep 30    # 只保留最近 30 份
#   sudo bash deploy/backup.sh --with-exports   # 连导出件一起备份（默认不备）
#   sudo bash deploy/backup.sh --restore /var/backups/reimburse/reimburse-20260101-030000.tar.gz
#
# 备份内容：数据库 + 上传的票据原件（导出件默认不备，见下）
#
# 为什么默认不备份导出件：
#   exports/ 里的 docx/xlsx 都能从数据库随时重新生成，属于可再生数据。
#   但它和票据原件一样按份计体积，默认保留 14 份时会被乘以 14。
#   真正不可再生的只有两样：数据库、票据原件。把可再生数据排除在备份外，
#   磁盘占用能显著下降，且不影响恢复能力。需要留档时再加 --with-exports。
#
# 为什么不能直接 cp 数据库文件：
#   SQLite 在 WAL 模式下，写入中的数据可能只存在于 -wal 文件里，
#   直接复制 .db 会拿到一个「少了最近若干笔单据」的假备份。
#   这里优先用 sqlite3 的 .backup（或 VACUUM INTO），它走 SQLite 自己的
#   备份 API，能拿到事务一致快照。
# =============================================================
set -Eeuo pipefail

DATA_DIR="${DATA_DIR:-/var/lib/reimburse}"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/reimburse}"
KEEP=14
RESTORE_FROM=""
# 导出件可再生，默认不进备份（见文件头说明）
WITH_EXPORTS=0

c_ok()   { printf '\033[32m  [OK]\033[0m   %s\n' "$*"; }
c_warn() { printf '\033[33m  [WARN]\033[0m %s\n' "$*"; }
c_err()  { printf '\033[31m  [ERR]\033[0m  %s\n' "$*" >&2; }
die()    { c_err "$*"; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep)          KEEP="$2"; shift 2 ;;
    --restore)       RESTORE_FROM="$2"; shift 2 ;;
    --with-exports)  WITH_EXPORTS=1; shift ;;
    -h|--help)
      cat <<'EOF'
用法：
  sudo bash deploy/backup.sh [--keep N] [--with-exports]
  sudo bash deploy/backup.sh --restore <备份包路径>
EOF
      exit 0 ;;
    *) die "未知参数: $1" ;;
  esac
done

# ---------- 恢复 ----------
if [[ -n "$RESTORE_FROM" ]]; then
  [[ -f "$RESTORE_FROM" ]] || die "备份包不存在: $RESTORE_FROM"
  c_warn "恢复会覆盖当前数据！"
  read -r -p "  确认恢复？输入 yes 继续: " ans
  [[ "$ans" == "yes" ]] || die "已取消"

  # 先把现状也备份一份，恢复出问题时还能退回去
  if [[ -f "$DATA_DIR/reimburse.db" ]]; then
    SAFE="${RESTORE_FROM}.before-restore-$(date +%Y%m%d-%H%M%S).db"
    cp -a "$DATA_DIR/reimburse.db" "$SAFE" 2>/dev/null \
      && c_ok "恢复前的数据已另存: $SAFE"
  fi

  c_warn "停止服务…"
  systemctl stop reimburse 2>/dev/null || true
  sleep 2

  tar -xzf "$RESTORE_FROM" -C /
  chown -R reimburse:reimburse "$DATA_DIR" 2>/dev/null || true
  chmod 700 "$DATA_DIR" 2>/dev/null || true

  systemctl start reimburse
  sleep 2
  c_ok "恢复完成，服务已重启"
  exit 0
fi

# ---------- 备份 ----------
[[ $EUID -eq 0 ]] || die "请用 root 运行：sudo bash deploy/backup.sh"

# 备份目录必须在数据目录之外。若放进去，每次备份都会把上一份备份打进去，
# 体积逐日翻倍，几天就能撑爆磁盘——而且这种膨胀是静默发生的，很难事先发现。
case "$BACKUP_ROOT" in
  "$DATA_DIR"/*|"$DATA_DIR")
    die "备份目录不能位于数据目录内（$BACKUP_ROOT ⊂ $DATA_DIR），会导致备份自我包含、体积指数膨胀" ;;
esac

DB_FILE="$DATA_DIR/reimburse.db"
[[ -f "$DB_FILE" ]] || die "数据库不存在: $DB_FILE（服务是否已初始化？）"

install -d -m 700 "$BACKUP_ROOT"
TS="$(date +%Y%m%d-%H%M%S)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# ---- 1. 数据库一致性快照 ----
DB_OUT="$STAGE/reimburse.db"

# --experimental-sqlite 在 Node 22.5~22.x 必需，23.4 转正，24.x 的后期小版本
# 又把它移除了（本机 v24.14 仍接受，服务器 v24.21 已报 bad option）。
# 同一个大版本里前后不一致，所以绝不能按版本号猜，只能实测。
SQLITE_FLAG=""
# 判据必须是「不带标志跑不了、带了才行才加」，反过来（带标志能跑就加）会误判：
# Node 22.22 裸跑就能加载 sqlite，按错误判据会多带上这个标志。
if ! node -e "require('node:sqlite')" >/dev/null 2>&1 </dev/null; then
  if node --experimental-sqlite -e "require('node:sqlite')" >/dev/null 2>&1 </dev/null; then
    SQLITE_FLAG="--experimental-sqlite"
  else
    die "当前 Node.js ($(node -v)) 无法加载 node:sqlite（需 ≥ 22.5）"
  fi
fi

if command -v sqlite3 >/dev/null 2>&1; then
  # .backup 走 SQLite 备份 API，保证事务一致
  sqlite3 "$DB_FILE" ".backup '${DB_OUT}'" \
    && c_ok "数据库快照完成（sqlite3 .backup，事务一致）"
else
  c_warn "未安装 sqlite3，退回 VACUUM INTO（需 node 支持）"
  # 用 node 的 sqlite 做同样的一致性备份，避免直接 cp 拿到不一致状态
  # 注意：这里必须不加引号地展开 ${SQLITE_FLAG}，且重定向 stdin。
  # 若写成 "${SQLITE_FLAG}"，变量为空时 node 会收到一个空字符串参数，
  # 从而忽略 -e 转而去读 stdin —— 在终端里表现为脚本永久卡住且无任何输出。
  node ${SQLITE_FLAG} -e "
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.exec(\"VACUUM INTO '\${process.argv[2]}'\");
    db.close();
  " "$DB_FILE" "$DB_OUT" 2>/dev/null </dev/null \
    && c_ok "数据库快照完成（VACUUM INTO，事务一致）" \
    || die "数据库备份失败"
fi

[[ -s "$DB_OUT" ]] || die "备份出的数据库为空，请检查磁盘空间"

# 校验备份出来的库确实可读且表结构完整
if command -v sqlite3 >/dev/null 2>&1; then
  TBL_COUNT="$(sqlite3 "$DB_OUT" "SELECT COUNT(*) FROM sqlite_master WHERE type='table';" 2>/dev/null || echo 0)"
  ROW_COUNT="$(sqlite3 "$DB_OUT" "SELECT COUNT(*) FROM projects;" 2>/dev/null || echo 0)"
  if [[ "$TBL_COUNT" -lt 10 ]]; then
    die "备份校验失败：只��到 $TBL_COUNT 张表（预期 ≥10），疑似损坏"
  fi
  c_ok "备份校验通过：$TBL_COUNT 张表，$ROW_COUNT 个项目"
fi

# ---- 2. 上传票据（不可再生，必须备）与导出件（可再生，默认不备）----
[[ -d "$DATA_DIR/uploads" ]] && cp -a "$DATA_DIR/uploads" "$STAGE/uploads" 2>/dev/null || true
if [[ "$WITH_EXPORTS" == "1" ]]; then
  [[ -d "$DATA_DIR/exports" ]] && cp -a "$DATA_DIR/exports" "$STAGE/exports" 2>/dev/null || true
else
  c_warn "已跳过导出件 exports/（可再生）。如需留档请加 --with-exports"
fi
[[ -d "$STAGE/uploads" ]] || c_warn "数据目录中没有 uploads/，本次备份不含票据原件"

# ---- 3. 打包 ----
ARCHIVE="$BACKUP_ROOT/reimburse-${TS}.tar.gz"
tar -czf "$ARCHIVE" -C "$STAGE" . \
  && c_ok "备份包已生成: $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))" \
  || die "打包失败"

chmod 600 "$ARCHIVE"

# ---- 4. 清理旧备份 ----
if [[ "$KEEP" =~ ^[0-9]+$ && "$KEEP" -gt 0 ]]; then
  # 按文件名排序（时间戳格式，字典序即时间序），删掉超出保留数的
  mapfile -t OLD < <(ls -1t "$BACKUP_ROOT"/reimburse-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)))
  if [[ ${#OLD[@]} -gt 0 ]]; then
    for f in "${OLD[@]}"; do rm -f "$f"; done
    c_ok "已清理 ${#OLD[@]} 份旧备份（保留最近 $KEEP 份）"
  fi
fi

echo
echo "  备份目录 : $BACKUP_ROOT"
echo "  恢复方式 : sudo bash $0 --restore $ARCHIVE"
echo "  定时备份 : sudo crontab -e  →  17 3 * * * bash $0 --keep 14"
