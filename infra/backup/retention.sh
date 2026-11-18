#!/usr/bin/env bash
# Dọn backup cũ trên S3 — chạy NGOÀI VPS (máy quản trị) với khóa S3 CÓ quyền xóa (khóa trên VPS thì không có).
# Dùng image postgres-walg để có đúng phiên bản WAL-G. Khóa đọc từ file env riêng quyền 600 (không đưa qua dòng lệnh).
#   infra/backup/retention.sh <đường-dẫn-file-env-có-WALG_S3_PREFIX-và-AWS_*> [số-bản-full-giữ, mặc định 14]
set -euo pipefail
export MSYS_NO_PATHCONV=1
ENV_FILE="${1:?cần file env chứa WALG_S3_PREFIX, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT, AWS_REGION}"
RETAIN="${2:-14}"
[[ -f "$ENV_FILE" ]] || { echo "Không thấy $ENV_FILE"; exit 1; }
[[ "$RETAIN" =~ ^[0-9]+$ && "$RETAIN" -ge 7 ]] || { echo "Số bản giữ phải là số ≥ 7"; exit 1; }
docker run --rm --env-file "$ENV_FILE" --entrypoint wal-g fruit-retail/postgres-walg:local delete retain FULL "$RETAIN" --confirm
