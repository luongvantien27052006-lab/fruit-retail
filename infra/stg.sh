#!/usr/bin/env bash
# Wrapper docker compose cho STAGING/PRODUCTION trên VPS — luôn chạy preflight env trước (ADR-019, runbook-deploy.md).
#   infra/stg.sh config -q | up -d --wait | ps | logs -f api | exec -T -u postgres postgres check-archive.sh …
#   infra/stg.sh preflight            # chỉ kiểm env
# IMAGE_TAG mặc định = git sha ngắn của commit đang checkout (image gắn với commit → rollback bằng tag cũ).
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE="${STG_ENV_FILE:-infra/.env}"
[[ -f "$ENV_FILE" ]] || { echo "Không thấy $ENV_FILE"; exit 1; }
export IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short=12 HEAD)}"
# Image postgres gắn theo NỘI DUNG infra/postgres (hash tree git), không theo commit — đổi code app không làm
# recreate/restart DB; chỉ khi Dockerfile/script postgres đổi thì tag mới đổi.
export PG_IMAGE_TAG="${PG_IMAGE_TAG:-pg-$(git rev-parse --short=12 HEAD:infra/postgres)}"

val() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -1; }
preflight() {
  local bad=() k v
  # Quyền file chỉ kiểm được trên Linux (VPS); Git Bash/NTFS ở máy dev luôn báo 644 nên bỏ qua ở đó.
  case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*) ;;
    *) local perm; perm=$(stat -c %a "$ENV_FILE") || perm="?"
       [[ "$perm" =~ ^[46]00$ ]] || bad+=("$ENV_FILE quyền $perm (phải 600)") ;;
  esac
  local env; env=$(val APP_ENV)
  [[ "$env" == staging || "$env" == production ]] || bad+=("APP_ENV phải là staging|production")
  for k in APP_DOMAIN ACME_EMAIL WALG_S3_PREFIX WALG_AWS_ACCESS_KEY_ID WALG_AWS_SECRET_ACCESS_KEY WALG_AWS_ENDPOINT WALG_AWS_REGION; do
    v=$(val "$k"); [[ -n "$v" && "$v" != *change-me* && "$v" != *example.invalid* ]] || bad+=("$k chưa điền giá trị thật")
  done
  # Không CRLF, không bọc nháy (compose bỏ nháy → độ dài/so sánh sai)
  [[ "$(tr -dc '\r' < "$ENV_FILE" | wc -c)" -eq 0 ]] || bad+=("$ENV_FILE có ký tự CR (CRLF) — đổi sang LF")
  grep -Eq "^[A-Z_]+=[\"']" "$ENV_FILE" && bad+=("$ENV_FILE có giá trị bọc nháy — bỏ nháy")
  # Mật khẩu: ≥ 24 ký tự, chỉ [A-Za-z0-9_-] (đi thẳng vào DATABASE_URL/REDIS_URL không encode), không trùng nhau
  local seen=" "
  for k in PG_OWNER_PASSWORD PG_APP_RW_PASSWORD PG_PROJECTOR_RW_PASSWORD PG_VIEWER_RO_PASSWORD PG_VIEWER_ACT_PASSWORD PG_AUDIT_WRITER_PASSWORD REDIS_PASSWORD REDIS_API_PASSWORD REDIS_WORKER_PASSWORD; do
    v=$(val "$k")
    if (( ${#v} < 24 )) || [[ "$v" == *change-me* ]]; then bad+=("$k < 24 ký tự hoặc còn giá trị mẫu");
    elif [[ ! "$v" =~ ^[A-Za-z0-9_-]+$ ]]; then bad+=("$k chỉ được dùng [A-Za-z0-9_-]");
    elif [[ "$seen" == *" $v "* ]]; then bad+=("$k trùng mật khẩu khác"); fi
    seen+="$v "
  done
  v=$(val WALG_LIBSODIUM_KEY)
  [[ "$(printf '%s' "$v" | base64 -d 2>/dev/null | wc -c)" == "32" ]] || bad+=("WALG_LIBSODIUM_KEY phải là 32 byte dạng base64")
  local pd pm; pd=$(val WALG_S3_PREFIX_DRILL); pm=$(val WALG_S3_PREFIX)
  [[ "$pd" == s3://* ]] || bad+=("WALG_S3_PREFIX_DRILL phải dạng s3://…")
  [[ "${pd%/}" != "${pm%/}" ]] || bad+=("WALG_S3_PREFIX_DRILL phải khác WALG_S3_PREFIX")
  for k in ALERT_TELEGRAM_BOT_TOKEN ALERT_TELEGRAM_CHAT_ID; do
    [[ -n "$(val "$k")" || "${1:-}" == exec ]] || echo "preflight: CẢNH BÁO $k trống — cảnh báo chỉ ghi ~/fruit-logs/alerts.log (CP02 mục 8)" >&2
  done
  [[ "$(val BACKUP_RETAIN_FULL)" == "0" ]] || bad+=("BACKUP_RETAIN_FULL phải = 0 trên VPS (khóa không có quyền xóa)")
  if ((${#bad[@]})); then printf 'PREFLIGHT LỖI: %s\n' "${bad[@]}" >&2; return 1; fi
  [[ "${1:-}" == exec ]] || echo "preflight: OK (APP_ENV=$env, IMAGE_TAG=$IMAGE_TAG, PG_IMAGE_TAG=$PG_IMAGE_TAG)" >&2
}

preflight "$@"
[[ "${1:-}" == "preflight" ]] && exit 0
exec docker compose -p fruit-retail -f infra/docker-compose.yml -f infra/docker-compose.backup.yml \
  -f infra/docker-compose.staging.yml --env-file "$ENV_FILE" "$@"
