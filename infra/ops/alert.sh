#!/usr/bin/env bash
# Gửi cảnh báo vận hành. Luôn ghi syslog (logger) + file ~/fruit-logs/alerts.log; gửi Telegram NẾU đã cấu hình
# ALERT_TELEGRAM_BOT_TOKEN + ALERT_TELEGRAM_CHAT_ID trong infra/.env (CP02 mục 8 — chưa có bot thì chỉ ghi log).
#   infra/ops/alert.sh "nội dung"
set -uo pipefail
cd "$(dirname "$0")/../.."
MSG="[fruit-retail $(hostname)] $(date -u +%FT%TZ) ${1:-cảnh báo không có nội dung}"
LOG_DIR="${FRUIT_LOG_DIR:-$HOME/fruit-logs}"
mkdir -p "$LOG_DIR"
echo "$MSG" >> "$LOG_DIR/alerts.log"
logger -t fruit-alert -- "$MSG" 2>/dev/null || true
val() { sed -n "s/^$1=//p" infra/.env 2>/dev/null | tail -1; }
TOKEN=$(val ALERT_TELEGRAM_BOT_TOKEN); CHAT=$(val ALERT_TELEGRAM_CHAT_ID)
if [[ -n "$TOKEN" && -n "$CHAT" ]]; then
  # Token nằm trong URL theo API Telegram → truyền URL qua config từ stdin (-K -), KHÔNG để trên dòng lệnh (lộ qua ps).
  # Lỗi gửi được ghi vào alerts.log (không nuốt im lặng).
  if ! printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$TOKEN" \
       | curl -fsS --max-time 15 -o /dev/null -K - \
           --data-urlencode "chat_id=${CHAT}" --data-urlencode "text=${MSG}"; then
    echo "$(date -u +%FT%TZ) gửi Telegram THẤT BẠI" >> "$LOG_DIR/alerts.log"
    exit 1
  fi
fi
