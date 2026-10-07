#!/usr/bin/env bash
#
# 数据迁移 · 服务端导入（在目标服务器上运行，需要 root）
#
# 用法：
#   sudo bash import-bundle.sh                      # 按 bundle 内的 manifest 导入
#   sudo bash import-bundle.sh --dry-run            # 只演练，不改任何东西
#   sudo bash import-bundle.sh --bundle /opt/reimburse-data
#   sudo bash import-bundle.sh --data-dir /data/reimburse --service reimburse
#   sudo bash import-bundle.sh --no-backup          # 跳过迁移前备份（不推荐）
#
# 做了什么：
#   1. 读 /etc/reimburse/env 拿到 DATA_DIR / EXPORT_DIR（与线上服务保持一致）
#   2. 迁移前先把现有数据整包备份（默认备份到 /var/backups/reimburse）
#   3. 停服务 -> 替换数据库 -> 复原 __EXPORT_DIR__ 占位符 -> 落文件 -> 修权限
#   4. 起服务、带重试判活，最后用 manifest 逐项核对行数
#
# 注意： bundle 内含真实的数据库（含用户密码哈希与邮箱授权码），不要丢在公共位置。

set -Eeuo pipefail

APP_NAME_DEFAULT="reimburse"
SERVICE=""
BUNDLE=""
DATA_DIR=""
EXPORT_DIR=""
BACKUP_DIR="/var/backups/reimburse"
DRY_RUN=0
NO_BACKUP=0
NO_START=0
YES=0

HEALTH_TIMEOUT=40
TCP_TIMEOUT=6
TS="$(date +%Y%m%d-%H%M%S)"

# ---------- 输出 ----------
if [[ -t 1 ]]; then C_B=$'\e[1m'; C_G=$'\e[32m'; C_Y=$'\e[33m'; C_R=$'\e[31m'; C_0=$'\e[0m'; else C_B=""; C_G=""; C_Y=""; C_R=""; C_0=""; fi
head()  { printf '\n%s▌%s%s\n' "$C_B" "$1" "$C_0"; }
step()  { printf '\n%s▌%s %s\n' "$C_B" "$1" "$C_0"; }
ok()    { printf '  %s[OK]%s   %s\n'   "$C_G" "$C_0" "$1"; }
info()  { printf '         %s\n' "$1"; }
warn()  { printf '  %s[WARN]%s %s\n' "$C_Y" "$C_0" "$1"; }
err()   { printf '  %s[ERR]%s  %s\n'  "$C_R" "$C_0" "$1"; }
die()   { err "$1"; exit 1; }

# ---------- 参数 ----------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle)     BUNDLE="$2"; shift 2 ;;
    --data-dir)   DATA_DIR="$2"; shift 2 ;;
    --service)    SERVICE="$2"; shift 2 ;;
    --backup-dir) BACKUP_DIR="$2"; shift 2 ;;
    --no-backup)  NO_BACKUP=1; shift ;;
    --no-start)   NO_START=1; shift ;;
    --dry-run)    DRY_RUN=1; shift ;;
    -y|--yes)     YES=1; shift ;;
    -h|--help)    sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)            die "未知参数: $1（用 --help 看用法）" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "请用 root 运行：sudo bash import-bundle.sh"

# bundle 默认取本脚本所在目录（一般整包解压后就是这个结构）
BUNDLE="${BUNDLE:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
SERVICE="${SERVICE:-$APP_NAME_DEFAULT}"

[[ -f "$BUNDLE/manifest.json" ]] || die "没在 $BUNDLE 找到 manifest.json，确认解压位置对不对"
[[ -f "$BUNDLE/reimburse.db"  ]] || die "没在 $BUNDLE 找到 reimburse.db"

head "天津仁爱学院报销系统 · 数据迁移导入"

# ---------- 1. 环境 ----------
step "1/7 环境与目标确认"

# 优先沿用部署时写入的环境，避免和服务实际使用的目录不一致
if [[ -z "$DATA_DIR" && -f /etc/reimburse/env ]]; then
  DATA_DIR="$(grep -m1 '^DATA_DIR=' /etc/reimburse/env | cut -d= -f2- || true)"
fi
if [[ -z "$EXPORT_DIR" && -f /etc/reimburse/env ]]; then
  EXPORT_DIR="$(grep -m1 '^EXPORT_DIR=' /etc/reimburse/env | cut -d= -f2- || true)"
fi
DATA_DIR="${DATA_DIR:-/var/lib/reimburse}"
EXPORT_DIR="${EXPORT_DIR:-$DATA_DIR/exports}"

NODE_BIN="$(command -v node || true)"
[[ -n "$NODE_BIN" ]] || die "找不到 node"
# node:sqlite 的启动标志必须实测：Node 22 不需要、某些 Node 24 传了会 "bad option"
SQLITE_FLAG=""
if ! "$NODE_BIN" -e "require('node:sqlite')" >/dev/null 2>&1 </dev/null; then
  if "$NODE_BIN" --experimental-sqlite -e "require('node:sqlite')" >/dev/null 2>&1 </dev/null; then
    SQLITE_FLAG="--experimental-sqlite"
  else
    die "这台机器的 Node ($("$NODE_BIN" -v)) 无法加载 node:sqlite，需 Node ≥ 22.5"
  fi
fi

# 统一的 node 调用入口。
# 两个坑，别改回去：
#   1. 绝不能写 "$NODE_BIN" "$SQLITE_FLAG" -e ... —— SQLITE_FLAG 为空时它会变成一个
#      空字符串参数，node 收到空参后**忽略 -e 转而去读 stdin**，在交互终端里就是永久卡住
#      （表现为脚本停在某一步不动，没有任何输出）。这里按有无标志分开调用。
#   2. 一律 < /dev/null：万一将来又出现类似的空参问题，也只是立刻返回，不会挂住终端。
run_node() {
  if [[ -n "$SQLITE_FLAG" ]]; then
    "$NODE_BIN" "$SQLITE_FLAG" "$@" </dev/null
  else
    "$NODE_BIN" "$@" </dev/null
  fi
}

ok "Node $("$NODE_BIN" -v)${SQLITE_FLAG:+  启动标志: $SQLITE_FLAG}"
ok "Bundle   : $BUNDLE"
ok "数据目录 : $DATA_DIR"
ok "导出目录 : $EXPORT_DIR"
ok "服务名   : $SERVICE"
info "Bundle 大小: $(du -sh "$BUNDLE" 2>/dev/null | cut -f1)"

# 读 manifest
read_mf() {
  run_node -e "
    const fs=require('fs');
    const m=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
    console.log(eval('m.' + process.argv[2]) ?? '');
  " "$BUNDLE/manifest.json" "$1" 2>/dev/null || true
}
MF_DB_SIZE="$(read_mf 'db.size')"
MF_DB_SHA="$(read_mf 'db.sha256')"
CNT_PROJ="$(read_mf 'counts.projects')"
CNT_RECP="$(read_mf 'counts.receipts')"
CNT_USER="$(read_mf 'counts.users')"
CNT_SET="$(read_mf 'counts.settings')"
MF_TOTAL="$(read_mf 'receipts_total')"
MF_UPLOADS="$(read_mf 'files.uploads.length')"
MF_EXPORTS="$(read_mf 'files.exports.length')"

LR=""
printf '\n  待导入内容：\n'
printf '    项目 %s 个 / 票据 %s 张（合计 ￥%s）/ 用户 %s 个 / 设置项 %s 条\n' \
  "${CNT_PROJ:-?}" "${CNT_RECP:-?}" "${MF_TOTAL:-0}" "${CNT_USER:-?}" "${CNT_SET:-?}"
printf '    票据原件 %s 份 / 导出件 %s 份\n' "${MF_UPLOADS:-0}" "${MF_EXPORTS:-0}"

RULE="─"
if [[ -n "$MF_DB_SHA" ]]; then
  ACTUAL_SHA="$(sha256sum "$BUNDLE/reimburse.db" | awk '{print $1}')"
  if [[ "$ACTUAL_SHA" == "$MF_DB_SHA" ]]; then
    ok "数据库校验通过 (sha256 ${ACTUAL_SHA:0:16}…)"
  else
    warn "校验值与 manifest 不一致，文件可能在传输中损坏"
    warn "  期望 ${MF_DB_SHA:0:16}…  实际 ${ACTUAL_SHA:0:16}…"
    [[ $YES -eq 1 ]] || { printf '  仍要继续？[y/N] '; read -r ans; [[ "$ans" == "y" || "$ans" == "Y" ]] || die "用户取消"; }
  fi
fi

if [[ $DRY_RUN -eq 1 ]]; then
  head "演练结束（--dry-run），未做任何修改"
  info "将替换: $DATA_DIR/reimburse.db"
  info "将落盘: $DATA_DIR/uploads/ , $EXPORT_DIR/"
  exit 0
fi

# ---------- 2. 备份现有数据 ----------
step "2/7 备份现有数据"
if [[ $NO_BACKUP -eq 1 ]]; then
  warn "已用 --no-backup 跳过备份，出问题无法回滚"
else
  mkdir -p "$BACKUP_DIR"
  TARBALL="$BACKUP_DIR/pre-migrate-$TS.tar.gz"
  if [[ -d "$DATA_DIR" ]]; then
    tar -czf "$TARBALL" -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")" 2>/dev/null \
      && ok "已备份到 $TARBALL ($(du -h "$TARBALL" | cut -f1))" \
      || die "备份失败，禁止继续（不想备份请显式加 --no-backup）"
  else
    ok "目标数据目录不存在，无需备份"
  fi
fi

# ---------- 3. 停服务 ----------
step "3/7 停止服务"
if systemctl list-unit-files "${SERVICE}.service" >/dev/null 2>&1; then
  systemctl is-active --quiet "$SERVICE" && systemctl stop "$SERVICE" && ok "已停止 $SERVICE" \
    || info "服务本来就没在运行"
else
  warn "找不到 ${SERVICE}.service（还没部署过？文件仍会就位，但不会启动）"
  SERVICE=""
fi

# ---------- 4. 落盘数据库 ----------
step "4/7 写入数据库"
mkdir -p "$DATA_DIR/uploads" "$EXPORT_DIR"
DB_TARGET="$DATA_DIR/reimburse.db"
cp -f "$BUNDLE/reimburse.db" "$DB_TARGET.new"
# 残留的 WAL/SHM 必须清掉，否则新库会被旧日志污染
rm -f "$DB_TARGET-wal" "$DB_TARGET-shm"
mv -f "$DB_TARGET.new" "$DB_TARGET"
ok "数据库已就位 ($(du -h "$DB_TARGET" | cut -f1))"

CHK="$(run_node -e "
  const {DatabaseSync}=require('node:sqlite');
  const db=new DatabaseSync(process.argv[1],{readOnly:true});
  console.log(db.prepare('PRAGMA integrity_check').get().integrity_check);
  db.close();
" "$DB_TARGET")"
[[ "$CHK" == "ok" ]] || die "写入后的数据库自检失败：${CHK}（可用备份回滚）"
ok "完整性检查通过"

# ---------- 5. 复原导出路径 + 落文件 ----------
step "5/7 复原导出路径并落文件"
run_node -e "
  const {DatabaseSync}=require('node:sqlite');
  const db=new DatabaseSync(process.argv[1]);
  const n=db.prepare(\"UPDATE exports SET file_path = replace(file_path, '__EXPORT_DIR__', ?)\")
            .run(process.argv[2]).changes;
  console.log(n);
  db.close();
" "$DB_TARGET" "$EXPORT_DIR" | { read -r N; info "改写导出记录路径 ${N:-0} 条 -> $EXPORT_DIR"; }

rm -f "$DB_TARGET-wal" "$DB_TARGET-shm"

UP_N=0; UP_KEEP=0
if [[ -d "$BUNDLE/uploads" ]]; then
  while IFS= read -r -d '' f; do
    b="$(basename "$f")"
    if [[ -e "$DATA_DIR/uploads/$b" ]]; then UP_KEEP=$((UP_KEEP+1)); else cp -a "$f" "$DATA_DIR/uploads/$b"; UP_N=$((UP_N+1)); fi
  done < <(find "$BUNDLE/uploads" -maxdepth 1 -type f -print0)
fi
ok "票据原件：新增 $UP_N 份，已存在跳过 $UP_KEEP 份"

EX_N=0
if [[ -d "$BUNDLE/exports" ]]; then
  while IFS= read -r -d '' f; do
    b="$(basename "$f")"
    [[ -e "$EXPORT_DIR/$b" ]] || { cp -a "$f" "$EXPORT_DIR/$b"; EX_N=$((EX_N+1)); }
  done < <(find "$BUNDLE/exports" -maxdepth 1 -type f -print0)
fi
ok "导出件：新增 $EX_N 份"

# 导入库里自带超管 => 服务器首次启动时生成的那个初始口令已经作废。
# 那个明文文件不会自动消失，留着就是一份指向错误密码的假凭据 —— 改名归档而非删除。
INIT_TXT="$DATA_DIR/_admin_init.txt"
if [[ -f "$INIT_TXT" ]]; then
  ADMIN_NAMES="$(run_node -e "
    const {DatabaseSync}=require('node:sqlite');
    const db=new DatabaseSync(process.argv[1],{readOnly:true});
    console.log(db.prepare(\"SELECT username FROM users WHERE role='super_admin' ORDER BY id\").all().map(r=>r.username).join(', '));
    db.close();
  " "$DB_TARGET" 2>/dev/null || true)"
  mv -f "$INIT_TXT" "$INIT_TXT.migrated-$TS"
  warn "旧机器的初始口令文件已归档为 _admin_init.txt.migrated-$TS（里面的密码**已失效**）"
  info "请改用**旧机器**的超管密码登录；可用登录名：${ADMIN_NAMES:-admin}"
fi

# ---------- 6. 权限 ----------
step "6/7 修正权限"
RUN_USER="$(stat -c '%U' "$DATA_DIR" 2>/dev/null || echo reimburse)"
if id "$RUN_USER" >/dev/null 2>&1; then
  chown -R "$RUN_USER":"$RUN_USER" "$DATA_DIR" "$EXPORT_DIR" 2>/dev/null || true
fi
chmod 700 "$DATA_DIR"
chmod 600 "$DB_TARGET"
# 服务账户要能下载/重写票据与导出件
[[ -d "$DATA_DIR/uploads" ]] && chmod 700 "$DATA_DIR/uploads"
[[ -d "$EXPORT_DIR" ]] && chmod 700 "$EXPORT_DIR"
ok "属主 $RUN_USER，数据目录 700，数据库 600"

# ---------- 7. 启动与核对 ----------
step "7/7 启动并核对"
if [[ -z "$SERVICE" ]]; then
  warn "没有 systemd 服务，需手动启动后再核对"
else
  systemctl daemon-reload 2>/dev/null || true
  systemctl reset-failed "$SERVICE" 2>/dev/null || true
  systemctl start "$SERVICE"
  ok "已启动 $SERVICE"

  info "等待端口就绪（最多 ${HEALTH_TIMEOUT}s）…"
  R=""
  for ((i=1; i<=HEALTH_TIMEOUT; i++)); do
    R="$(curl -s -m 2 http://127.0.0.1:5180/api/health || true)"
    [[ -n "$R" ]] && { ok "第 ${i}s 就绪: $R"; break; }
    sleep 1
  done
  if [[ -z "$R" ]]; then
    err "健康检查超时，看日志：journalctl -u $SERVICE -n 40 --no-pager"
    die "服务未就绪，请按上面 journalctl 的提示排查"
  fi
fi

echo
info "=== 导入后核对（对照 manifest）==="
run_node -e "
  const {DatabaseSync}=require('node:sqlite');
  const db=new DatabaseSync(process.argv[1],{readOnly:true});
  const fs=require('fs');
  const m=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
  const c=t=>{try{return db.prepare('SELECT COUNT(*) n FROM '+t).get().n}catch(e){return -1}};
  const row=(name,cur,exp)=>{
    const flag = (exp===undefined||String(exp)===String(cur)) ? 'OK ' : '差异';
    console.log('   ['+flag+'] '+String(name).padEnd(10)+String(cur).padStart(8)+(exp!==undefined?'  (期望 '+exp+')':''));
  };
  row('项目', c('projects'), m.counts.projects);
  row('票据', c('receipts'), m.counts.receipts);
  row('用户', c('users'),    m.counts.users);
  row('设置项', c('settings'), m.counts.settings);
  row('期间', c('periods'),  m.counts.periods);
  const total=db.prepare('SELECT ROUND(COALESCE(SUM(amount),0),2) t FROM receipts').get().t;
  row('票据总额', '￥'+total, '￥'+m.receipts_total);

  // 票据原件是否齐全
  const miss=db.prepare('SELECT id,file_path FROM receipts').all()
    .filter(r=>r.file_path)
    .filter(r=>!fs.existsSync(require('path').join(process.argv[3],'uploads',String(r.file_path).replace(/\\\\/g,'/').split('/').pop())));
  if(miss.length) console.log('   [缺失] 票据原件 '+miss.length+' 份: '+miss.slice(0,3).map(r=>'#'+r.id).join(' '));
  else console.log('   [OK  ] 票据原件齐全');

  // 邮箱配置
  const g=k=>{const r=db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r?String(r.value):''};
  const ready = !!(g('mail_smtp_host')&&g('mail_smtp_user')&&g('mail_smtp_pass')&&g('mail_from'));
  console.log('   ['+(ready?'OK ':'缺失')+'] 邮箱配置   '+g('mail_smtp_host')+':'+g('mail_smtp_port')+'  账号 '+g('mail_smtp_user')+(g('mail_smtp_pass')?'  (授权码已迁移 ' + g('mail_smtp_pass').length + ' 位)':'  (无授权码!)'));

  const admins=db.prepare(\"SELECT username,name,email FROM users WHERE role='super_admin'\").all();
  console.log('   [信息] 超管账号   '+admins.map(a=>a.username+(a.email?' <'+a.email+'>':'')).join(', '));
  db.close();
" "$DB_TARGET" "$BUNDLE/manifest.json" "$DATA_DIR"

# 出网连通性（阿里云 ECS 常封 25，163 用 465/994）
echo
info "=== 服务器发信连通性 ==="
HOST="$(read_mf 'mail_config.mail_smtp_host')"
PORT="$(read_mf 'mail_config.mail_smtp_port')"
if [[ -n "$HOST" && -n "$PORT" ]]; then
  if (exec 3<>/dev/tcp/"$HOST"/"$PORT") 2>/dev/null; then exec 3<&- 3>&-; ok "可以连通 $HOST:$PORT"; else exec 3<&- 3>&- 2>/dev/null || true; warn "连不上 $HOST:$PORT —— 发不了验证码邮件。若用的是 25 端口，换成 465(SSL) 或 994"; fi
else
  warn "manifest 里没有 SMTP 配置，跳过连通性检查"
fi

echo
head "迁移完成"
printf '  前台  : http://%s:%s\n' "$(hostname -I 2>/dev/null | awk '{print $1}' || echo 本机IP)" "$(grep -m1 '^PORT=' /etc/reimburse/env 2>/dev/null | cut -d= -f2- || echo '?')"
printf '  后台  : /admin\n'
echo
info "接下来：① 用导过来的超管账号登录（密码沿用旧机器，不是本机生成的那个）"
info "        ② 后台 → 认证与邮箱 → 发一封测试邮件，确认 163 授权码能在服务器上用"
info "        ③ 登录后立即改超管密码；原有会话已全部失效，需要重新登录"
