#!/bin/bash
# Kiểm sức khỏe backup — chạy trong container postgres với user OS `postgres` (cron trên VPS mỗi 5 phút → cảnh báo
# Telegram khi exit ≠ 0). Không cần quyền superuser trong DB: số file WAL chờ archive đọc thẳng từ thư mục PGDATA;
# pg_stat_archiver đọc được bởi mọi role.
# Exit 1 nếu: KHÔNG KIỂM ĐƯỢC (psql/wal-g lỗi, dữ liệu lạ); archive_command đang lỗi; có WAL chờ archive mà lần archive
# gần nhất quá MAX_ARCHIVE_LAG_S (mặc định 300 s = RPO §15); backup full mới nhất cũ hơn MAX_FULL_AGE_H (26 giờ) / không có.
set -euo pipefail
MAX_ARCHIVE_LAG_S="${MAX_ARCHIVE_LAG_S:-300}"
MAX_FULL_AGE_H="${MAX_FULL_AGE_H:-26}"
PGDATA="${PGDATA:-/var/lib/postgresql/data}"
fail=0
check_error() { echo "CHECK_ERROR: $*"; exit 1; }

out=$(psql -qAt -F ' ' -v ON_ERROR_STOP=1 -c "
  SELECT (last_failed_time IS NOT NULL AND (last_archived_time IS NULL OR last_failed_time > last_archived_time))::int,
         coalesce(extract(epoch FROM now() - last_archived_time)::int, -1)
  FROM pg_stat_archiver" 2>&1) || check_error "psql không chạy được: $out"
read -r failing lag <<<"$out"
[[ "$failing" =~ ^[01]$ && "$lag" =~ ^-?[0-9]+$ ]] || check_error "kết quả pg_stat_archiver lạ: '$out'"

[[ -d "$PGDATA/pg_wal/archive_status" ]] || check_error "không đọc được $PGDATA/pg_wal/archive_status"
ready=$(find "$PGDATA/pg_wal/archive_status" -maxdepth 1 -name '*.ready' | wc -l)

if [ "$failing" = "1" ]; then echo "ARCHIVE_FAILING: archive_command đang lỗi"; fail=1; fi
if [ "$ready" -gt 0 ] && { [ "$lag" -lt 0 ] || [ "$lag" -gt "$MAX_ARCHIVE_LAG_S" ]; }; then
  echo "ARCHIVE_LAG: $ready file WAL chờ archive, lần archive gần nhất cách ${lag}s (> ${MAX_ARCHIVE_LAG_S}s)"; fail=1
fi

LIST=$(wal-g backup-list --detail --json 2>&1) || check_error "wal-g backup-list lỗi: $(tail -1 <<<"$LIST")"
last=$(printf '%s\n' "$LIST" | tr '{' '\n' | sed -n 's/.*"finish_time":"\([^"]*\)".*/\1/p' | sort | tail -1)
if [ -z "$last" ]; then
  echo "NO_FULL_BACKUP: chưa có backup full nào"; fail=1
else
  last_epoch=$(date -u -d "$last" +%s) || check_error "finish_time lạ: $last"
  age_h=$(( ( $(date -u +%s) - last_epoch ) / 3600 ))
  if [ "$age_h" -ge "$MAX_FULL_AGE_H" ]; then echo "FULL_BACKUP_STALE: backup full mới nhất cách ${age_h} giờ"; fail=1; fi
fi

[ "$fail" = "0" ] && echo "OK: archive bình thường ($ready WAL chờ), backup full mới nhất $last"
exit "$fail"
