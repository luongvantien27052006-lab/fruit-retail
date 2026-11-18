#!/usr/bin/env bash
# Backup full PostgreSQL bằng WAL-G + dọn backup cũ (giữ BACKUP_RETAIN_FULL bản, mặc định 14).
# Cron trên VPS hằng ngày; WAL đẩy liên tục qua archive_command. Exit ≠ 0 khi lỗi (cron → cảnh báo).
# Dùng: infra/backup/backup-full.sh [compose-project]   (gọi được từ bất kỳ cwd nào)
set -euo pipefail
export MSYS_NO_PATHCONV=1   # Git Bash: không đổi /var/... thành đường dẫn Windows
cd "$(dirname "$0")/../.."
PROJECT="${1:-fruit-retail}"
RETAIN="${BACKUP_RETAIN_FULL:-14}"
COMPOSE=(docker compose -p "$PROJECT" -f infra/docker-compose.yml -f infra/docker-compose.backup.yml --env-file infra/.env)

"${COMPOSE[@]}" exec -T -u postgres postgres wal-g backup-push /var/lib/postgresql/data
"${COMPOSE[@]}" exec -T -u postgres postgres wal-g delete retain FULL "$RETAIN" --confirm
"${COMPOSE[@]}" exec -T -u postgres postgres check-archive.sh
