#!/usr/bin/env bash
# Backup full PostgreSQL bằng WAL-G rồi kiểm sức khỏe backup; dọn bản cũ CHỈ khi BACKUP_RETAIN_FULL > 0.
# - Local: BACKUP_RETAIN_FULL mặc định 14 (dọn tại chỗ).
# - VPS: đặt BACKUP_RETAIN_FULL=0 — khóa S3 trên VPS không có quyền xóa + bucket object lock (runbook-backup.md);
#   dọn bản cũ bằng lifecycle rule của bucket hoặc infra/backup/retention.sh chạy NGOÀI VPS với khóa có quyền xóa.
# Cron trên VPS hằng ngày; WAL đẩy liên tục qua archive_command. Exit ≠ 0 khi lỗi (cron → cảnh báo).
# Dùng: infra/backup/backup-full.sh [compose-project]   (gọi được từ bất kỳ cwd nào)
# Nếu infra/.env có APP_ENV=staging|production → đi qua infra/stg.sh (cùng bộ compose + preflight như khi deploy).
# Timeout đặt BÊN TRONG container (timeout ở host chỉ giết client docker exec, tiến trình trong container vẫn treo).
set -euo pipefail
export MSYS_NO_PATHCONV=1   # Git Bash: không đổi /var/... thành đường dẫn Windows
cd "$(dirname "$0")/../.."
PROJECT="${1:-fruit-retail}"
RETAIN="${BACKUP_RETAIN_FULL:-14}"
PUSH_TIMEOUT="${BACKUP_PUSH_TIMEOUT:-3300}"
[[ "$RETAIN" =~ ^[0-9]+$ ]] || { echo "BACKUP_RETAIN_FULL phải là số nguyên ≥ 0"; exit 1; }
[[ "$PUSH_TIMEOUT" =~ ^[0-9]+$ ]] || { echo "BACKUP_PUSH_TIMEOUT phải là số giây"; exit 1; }
APP_ENV_VAL=$(sed -n 's/^APP_ENV=//p' infra/.env 2>/dev/null | tail -1)
if [[ "$APP_ENV_VAL" == staging || "$APP_ENV_VAL" == production ]]; then
  [[ "$PROJECT" == fruit-retail ]] || { echo "staging/production chỉ dùng project fruit-retail (infra/stg.sh)"; exit 1; }
  COMPOSE=(infra/stg.sh)
else
  COMPOSE=(docker compose -p "$PROJECT" -f infra/docker-compose.yml -f infra/docker-compose.backup.yml --env-file infra/.env)
fi
PGX=("${COMPOSE[@]}" exec -T -u postgres postgres)

"${PGX[@]}" timeout --kill-after=30 "$PUSH_TIMEOUT" wal-g backup-push /var/lib/postgresql/data
"${PGX[@]}" timeout --kill-after=10 100 check-archive.sh
if [ "$RETAIN" -gt 0 ]; then
  "${PGX[@]}" timeout --kill-after=10 600 wal-g delete retain FULL "$RETAIN" --confirm
fi
