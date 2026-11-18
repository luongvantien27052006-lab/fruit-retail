#!/bin/bash
# Khôi phục PostgreSQL từ WAL-G về một thời điểm (PITR) rồi khởi động server.
# Dùng cho diễn tập khôi phục (infra/backup/drill-pitr.sh) và cho khôi phục thật.
# Biến: WALG_FILE_PREFIX hoặc WALG_S3_PREFIX (+ khóa S3), RECOVERY_TARGET_TIME (ISO, UTC), BACKUP_NAME (mặc định LATEST).
set -euo pipefail

: "${RECOVERY_TARGET_TIME:?RECOVERY_TARGET_TIME bắt buộc (ví dụ 2026-11-18 03:00:00+00)}"
BACKUP_NAME="${BACKUP_NAME:-LATEST}"
PGDATA="${PGDATA:-/var/lib/postgresql/data}"

if [ -s "$PGDATA/PG_VERSION" ]; then
  echo "[restore] $PGDATA đã có dữ liệu — từ chối ghi đè. Dùng volume trống." >&2
  exit 1
fi
mkdir -p "$PGDATA"
chown -R postgres:postgres "$PGDATA"
chmod 700 "$PGDATA"

echo "[restore] wal-g backup-fetch $BACKUP_NAME"
gosu postgres wal-g backup-fetch "$PGDATA" "$BACKUP_NAME"

# Cấu hình phục hồi: lấy WAL từ kho backup, dừng ở thời điểm đích rồi promote.
gosu postgres touch "$PGDATA/recovery.signal"
cat >> "$PGDATA/postgresql.auto.conf" <<EOF
restore_command = 'wal-g wal-fetch %f %p'
recovery_target_time = '${RECOVERY_TARGET_TIME}'
recovery_target_action = 'promote'
archive_mode = 'off'
EOF
chown postgres:postgres "$PGDATA/postgresql.auto.conf"

echo "[restore] khởi động postgres để phục hồi tới $RECOVERY_TARGET_TIME"
exec gosu postgres postgres -D "$PGDATA"
