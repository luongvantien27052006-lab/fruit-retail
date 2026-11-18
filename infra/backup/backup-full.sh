#!/usr/bin/env bash
# Backup full PostgreSQL bằng WAL-G rồi kiểm sức khỏe backup; dọn bản cũ CHỈ khi BACKUP_RETAIN_FULL > 0.
# - Local: BACKUP_RETAIN_FULL mặc định 14 (dọn tại chỗ).
# - VPS: đặt BACKUP_RETAIN_FULL=0 — khóa S3 trên VPS không có quyền xóa + bucket object lock (runbook-backup.md);
#   dọn bản cũ bằng lifecycle rule của bucket hoặc infra/backup/retention.sh chạy NGOÀI VPS với khóa có quyền xóa.
# Cron trên VPS hằng ngày; WAL đẩy liên tục qua archive_command. Exit ≠ 0 khi lỗi (cron → cảnh báo).
# Dùng: infra/backup/backup-full.sh [compose-project]   (gọi được từ bất kỳ cwd nào)
set -euo pipefail
export MSYS_NO_PATHCONV=1   # Git Bash: không đổi /var/... thành đường dẫn Windows
cd "$(dirname "$0")/../.."
PROJECT="${1:-fruit-retail}"
RETAIN="${BACKUP_RETAIN_FULL:-14}"
[[ "$RETAIN" =~ ^[0-9]+$ ]] || { echo "BACKUP_RETAIN_FULL phải là số nguyên ≥ 0"; exit 1; }
COMPOSE=(docker compose -p "$PROJECT" -f infra/docker-compose.yml -f infra/docker-compose.backup.yml --env-file infra/.env)

"${COMPOSE[@]}" exec -T -u postgres postgres wal-g backup-push /var/lib/postgresql/data
"${COMPOSE[@]}" exec -T -u postgres postgres check-archive.sh
if [ "$RETAIN" -gt 0 ]; then
  "${COMPOSE[@]}" exec -T -u postgres postgres wal-g delete retain FULL "$RETAIN" --confirm
fi
