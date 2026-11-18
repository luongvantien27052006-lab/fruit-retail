#!/usr/bin/env bash
# Backup full PostgreSQL bằng WAL-G (chạy hằng ngày bằng cron trên VPS; WAL đẩy liên tục qua archive_command).
# Dùng: infra/backup/backup-full.sh [compose-project]   (cwd = gốc repo, Git Bash/Linux)
set -euo pipefail
PROJECT="${1:-fruit-retail}"
COMPOSE=(docker compose -p "$PROJECT" -f infra/docker-compose.yml -f infra/docker-compose.backup.yml --env-file infra/.env)

"${COMPOSE[@]}" exec -T -u postgres postgres wal-g backup-push /var/lib/postgresql/data
"${COMPOSE[@]}" exec -T -u postgres postgres wal-g backup-list
