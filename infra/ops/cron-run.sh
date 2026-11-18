#!/usr/bin/env bash
# Chạy một việc định kỳ an toàn cho cron: khóa chống chạy chồng (flock), giới hạn thời gian (timeout), ghi log có
# thời điểm, và gọi alert.sh khi lỗi/hết giờ/đang có lần trước chạy (không im lặng).
#   infra/ops/cron-run.sh <tên> <timeout-giây> <lệnh…>
#   ví dụ: infra/ops/cron-run.sh backup 3600 infra/backup/backup-full.sh fruit-retail
set -uo pipefail
cd "$(dirname "$0")/../.."
NAME="${1:?tên việc}"; LIMIT="${2:?timeout giây}"; shift 2
LOG_DIR="${FRUIT_LOG_DIR:-$HOME/fruit-logs}"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$NAME.log"
LOCK="$LOG_DIR/.$NAME.lock"
{
  echo "=== $(date -u +%FT%TZ) bắt đầu: $*"
  flock -n 9 || { echo "lần chạy trước của '$NAME' chưa xong"; infra/ops/alert.sh "$NAME: lần chạy trước chưa xong (có thể treo)"; exit 1; }
  timeout --kill-after=30 "$LIMIT" "$@"
  rc=$?
  if [[ $rc -eq 124 || $rc -eq 137 ]]; then infra/ops/alert.sh "$NAME: quá thời gian ${LIMIT}s"
  elif [[ $rc -ne 0 ]]; then infra/ops/alert.sh "$NAME: lỗi exit $rc — xem $LOG"; fi
  echo "=== $(date -u +%FT%TZ) kết thúc exit=$rc"
  exit $rc
} 9>"$LOCK" >>"$LOG" 2>&1
