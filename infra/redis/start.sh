#!/bin/sh
# Redis ACL theo user (CP03 lát 10 — đóng giới hạn ADR-019, ADR-029).
#   default : TẮT (không còn requirepass chung)
#   ops     : toàn quyền — chỉ cho người vận hành (redis-cli trong container, backup, sự cố); app KHÔNG dùng
#   api     : chỉ khóa rl:* (giới hạn tần suất, Lua EVAL) + PING/INFO; không lệnh nguy hiểm
#   worker  : chỉ khóa bull:* (BullMQ outbox) + PING/INFO; không lệnh nguy hiểm
# Lệnh nguy hiểm (@dangerous: FLUSHALL/FLUSHDB/CONFIG/DEBUG/KEYS/SHUTDOWN/MONITOR/CLIENT KILL…) và @admin bị chặn cho
# api/worker; INFO mở lại vì ioredis (ready check) và BullMQ (kiểm phiên bản) cần. SCRIPT/FUNCTION FLUSH|KILL bị chặn.
# Mật khẩu lấy từ biến môi trường, ghi vào ACL file trong container (chỉ user redis đọc được), không vào log.
set -eu

check() {
  # $1 = tên biến, $2 = giá trị: bắt buộc, không khoảng trắng (ACL tách token theo khoảng trắng), tối thiểu 16 ký tự
  case "$2" in
    '' ) echo "redis: thiếu $1" >&2; exit 1 ;;
    *[[:space:]]* ) echo "redis: $1 không được chứa khoảng trắng" >&2; exit 1 ;;
  esac
  if [ "${#2}" -lt 16 ]; then echo "redis: $1 phải dài ít nhất 16 ký tự" >&2; exit 1; fi
}
check REDIS_PASSWORD "${REDIS_PASSWORD:-}"
check REDIS_API_PASSWORD "${REDIS_API_PASSWORD:-}"
check REDIS_WORKER_PASSWORD "${REDIS_WORKER_PASSWORD:-}"
if [ "$REDIS_API_PASSWORD" = "$REDIS_PASSWORD" ] || [ "$REDIS_WORKER_PASSWORD" = "$REDIS_PASSWORD" ] \
  || [ "$REDIS_API_PASSWORD" = "$REDIS_WORKER_PASSWORD" ]; then
  echo "redis: ba mật khẩu ops/api/worker phải khác nhau" >&2
  exit 1
fi

APP='resetchannels -@all +@read +@write +@scripting +@connection -@dangerous -@admin +ping +info +client|setname +client|getname +client|id -script|flush -script|kill -function|flush -function|delete -function|restore -function|kill'
ACL=/tmp/redis-users.acl
umask 077
{
  printf 'user default off resetkeys -@all\n'
  printf 'user ops on >%s ~* &* +@all\n' "$REDIS_PASSWORD"
  printf 'user api on >%s resetkeys ~rl:* %s\n' "$REDIS_API_PASSWORD" "$APP"
  printf 'user worker on >%s resetkeys ~bull:* %s\n' "$REDIS_WORKER_PASSWORD" "$APP"
} > "$ACL"
# entrypoint của image hạ quyền xuống user redis ⇒ file phải thuộc redis
chown redis:redis "$ACL" 2>/dev/null || true

exec docker-entrypoint.sh redis-server --aclfile "$ACL" "$@"
