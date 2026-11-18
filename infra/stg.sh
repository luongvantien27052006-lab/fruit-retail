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
  # Mật khẩu: ≥ 24 ký tự, không mẫu, không trùng nhau
  local seen=" "
  for k in PG_OWNER_PASSWORD PG_APP_RW_PASSWORD PG_PROJECTOR_RW_PASSWORD PG_VIEWER_RO_PASSWORD PG_VIEWER_ACT_PASSWORD PG_AUDIT_WRITER_PASSWORD REDIS_PASSWORD; do
    v=$(val "$k")
    if (( ${#v} < 24 )) || [[ "$v" == *change-me* ]]; then bad+=("$k < 24 ký tự hoặc còn giá trị mẫu");
    elif [[ "$seen" == *" $v "* ]]; then bad+=("$k trùng mật khẩu khác"); fi
    seen+="$v "
  done
  v=$(val WALG_LIBSODIUM_KEY)
  [[ "$(printf '%s' "$v" | base64 -d 2>/dev/null | wc -c)" == "32" ]] || bad+=("WALG_LIBSODIUM_KEY phải là 32 byte dạng base64")
  [[ "$(val WALG_S3_PREFIX_DRILL)" != "$(val WALG_S3_PREFIX)" ]] || bad+=("WALG_S3_PREFIX_DRILL phải khác WALG_S3_PREFIX")
  [[ "$(val BACKUP_RETAIN_FULL)" == "0" ]] || bad+=("BACKUP_RETAIN_FULL phải = 0 trên VPS (khóa không có quyền xóa)")
  if ((${#bad[@]})); then printf 'PREFLIGHT LỖI: %s\n' "${bad[@]}" >&2; return 1; fi
  echo "preflight: OK (APP_ENV=$env, IMAGE_TAG=$IMAGE_TAG)" >&2
}

preflight
[[ "${1:-}" == "preflight" ]] && exit 0
exec docker compose -p fruit-retail -f infra/docker-compose.yml -f infra/docker-compose.backup.yml \
  -f infra/docker-compose.staging.yml --env-file "$ENV_FILE" "$@"
