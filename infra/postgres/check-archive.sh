#!/bin/bash
# Kiểm sức khỏe backup (chạy trong container postgres, bởi cron trên VPS mỗi 5 phút → cảnh báo Telegram khi exit ≠ 0).
# Exit 1 nếu: archive_command đang lỗi; WAL chưa archive > MAX_ARCHIVE_LAG_S (mặc định 300 s = RPO §15);
# có backup full mới nhất cũ hơn MAX_FULL_AGE_H (mặc định 26 giờ) hoặc không có backup nào.
set -euo pipefail
MAX_ARCHIVE_LAG_S="${MAX_ARCHIVE_LAG_S:-300}"
MAX_FULL_AGE_H="${MAX_FULL_AGE_H:-26}"
fail=0

read -r failing lag ready <<<"$(psql -qAt -F ' ' -c "
  SELECT (last_failed_time IS NOT NULL AND (last_archived_time IS NULL OR last_failed_time > last_archived_time))::int,
         coalesce(extract(epoch FROM now() - last_archived_time)::int, -1),
         (SELECT count(*) FROM pg_ls_dir('pg_wal/archive_status') f WHERE f LIKE '%.ready')
  FROM pg_stat_archiver")"

if [ "$failing" = "1" ]; then echo "ARCHIVE_FAILING: archive_command đang lỗi"; fail=1; fi
if [ "$ready" -gt 0 ] && { [ "$lag" -lt 0 ] || [ "$lag" -gt "$MAX_ARCHIVE_LAG_S" ]; }; then
  echo "ARCHIVE_LAG: $ready file WAL chờ archive, lần archive gần nhất cách ${lag}s (> ${MAX_ARCHIVE_LAG_S}s)"; fail=1
fi

LIST=$(wal-g backup-list --detail --json 2>/dev/null || true)
last=$(printf '%s' "$LIST" | tr '{' '\n' | sed -n 's/.*"finish_time":"\([^"]*\)".*/\1/p' | sort | tail -1)
if [ -z "$last" ]; then
  echo "NO_FULL_BACKUP: chưa có backup full nào"; fail=1
else
  age_h=$(( ( $(date -u +%s) - $(date -u -d "$last" +%s) ) / 3600 ))
  if [ "$age_h" -ge "$MAX_FULL_AGE_H" ]; then echo "FULL_BACKUP_STALE: backup full mới nhất cách ${age_h} giờ"; fail=1; fi
fi

[ "$fail" = "0" ] && echo "OK: archive bình thường, backup full mới nhất $last"
exit "$fail"
