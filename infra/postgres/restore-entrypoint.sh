#!/bin/bash
# Khôi phục PostgreSQL từ WAL-G về một thời điểm (PITR) rồi khởi động server.
# Dùng cho diễn tập (infra/backup/drill-pitr.sh) và khôi phục thật (docs/engineering/execution/runbook-backup.md).
#
# Biến:
#   RECOVERY_TARGET_TIME    bắt buộc, có múi giờ: "2026-11-18 03:00:00+00" hoặc "2026-11-18T03:00:00Z"
#   RECOVERY_TARGET_ACTION  pause (mặc định — người vận hành kiểm rồi `SELECT pg_wal_replay_resume()`) | promote
#   BACKUP_NAME             AUTO (mặc định: backup mới nhất KẾT THÚC TRƯỚC mốc) | tên backup cụ thể
#   WALG_FILE_PREFIX hoặc WALG_S3_PREFIX (+ khóa), WALG_LIBSODIUM_KEY (+ _TRANSFORM) như lúc backup.
set -euo pipefail

: "${RECOVERY_TARGET_TIME:?RECOVERY_TARGET_TIME bắt buộc}"
ACTION="${RECOVERY_TARGET_ACTION:-pause}"
BACKUP_NAME="${BACKUP_NAME:-AUTO}"
PGDATA="${PGDATA:-/var/lib/postgresql/data}"

die() { echo "[restore] LỖI: $*" >&2; exit 1; }

# 1) Kiểm mốc thời gian TRƯỚC khi tải backup (không tốn thời gian fetch rồi mới phát hiện sai). Bắt buộc có múi giờ.
[[ "$RECOVERY_TARGET_TIME" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}[\ T][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$ ]] \
  || die "RECOVERY_TARGET_TIME sai định dạng hoặc thiếu múi giờ: '$RECOVERY_TARGET_TIME'"
T_EPOCH=$(date -u -d "$RECOVERY_TARGET_TIME" +%s.%N 2>/dev/null) || die "RECOVERY_TARGET_TIME không đọc được"
[[ "$ACTION" == "pause" || "$ACTION" == "promote" ]] || die "RECOVERY_TARGET_ACTION chỉ nhận pause|promote"

if [ -s "$PGDATA/PG_VERSION" ]; then
  die "$PGDATA đã có dữ liệu — từ chối ghi đè. Dùng volume trống."
fi
mkdir -p "$PGDATA"
chown -R postgres:postgres "$PGDATA"
chmod 700 "$PGDATA"

# 2) Chọn backup: mới nhất có finish_time < mốc. Mốc trước mọi backup → dừng (không âm thầm khôi phục sai).
if [ "$BACKUP_NAME" = "AUTO" ]; then
  LIST=$(gosu postgres wal-g backup-list --detail --json) || die "không đọc được danh sách backup"
  BEST=""; BEST_EPOCH=0
  while IFS=$'\t' read -r name finish; do
    [ -n "$name" ] || continue
    fe=$(date -u -d "$finish" +%s.%N) || continue
    if awk -v f="$fe" -v t="$T_EPOCH" -v b="$BEST_EPOCH" 'BEGIN{exit !(f < t && f > b)}'; then
      BEST="$name"; BEST_EPOCH="$fe"
    fi
  done < <(printf '%s\n' "$LIST" | tr '{' '\n' \
    | sed -n 's/.*"backup_name":"\([^"]*\)".*"finish_time":"\([^"]*\)".*/\1\t\2/p')
  [ -n "$BEST" ] || die "không có backup nào kết thúc trước mốc $RECOVERY_TARGET_TIME — không thể khôi phục về thời điểm này"
  BACKUP_NAME="$BEST"
fi
echo "[restore] dùng backup $BACKUP_NAME để khôi phục tới $RECOVERY_TARGET_TIME (action=$ACTION)"

START=$(date +%s)
gosu postgres wal-g backup-fetch "$PGDATA" "$BACKUP_NAME"
echo "[restore] backup-fetch xong sau $(( $(date +%s) - START )) s"

# 3) Cấu hình phục hồi truyền qua -c (KHÔNG ghi vào postgresql.auto.conf → không đi theo các backup sau).
#    archive_mode=off để server khôi phục không ghi đè kho backup đang dùng; bật lại theo runbook sau khi kiểm.
gosu postgres touch "$PGDATA/recovery.signal"
echo "[restore] khởi động postgres để phục hồi"
exec gosu postgres postgres -D "$PGDATA" \
  -c "restore_command=wal-g wal-fetch %f %p" \
  -c "recovery_target_time=$RECOVERY_TARGET_TIME" \
  -c "recovery_target_action=$ACTION" \
  -c "archive_mode=off"
