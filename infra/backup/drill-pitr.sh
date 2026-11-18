#!/usr/bin/env bash
# Diễn tập khôi phục PostgreSQL về MỘT THỜI ĐIỂM (PITR) bằng WAL-G — CP02 mục 7, §3.6 "diễn tập khôi phục", §15.
# Chạy trên project compose riêng `fruit-drill` (không đụng DB dev/staging). Gọi được từ bất kỳ cwd nào.
#   bash infra/backup/drill-pitr.sh                                   # kho file (volume local)
#   DRILL_STORAGE=s3 DRILL_ENV_FILE=infra/.env bash infra/backup/drill-pitr.sh   # kho S3 (VPS: cổng CP02)
# Chế độ s3: dùng compose staging + WALG_S3_PREFIX_DRILL/run-<thời điểm> (prefix RIÊNG mỗi lần — không đụng backup thật,
# không lẫn backup của lần diễn tập trước). Khóa VPS không có quyền xóa → dữ liệu diễn tập dọn bằng lifecycle rule.
# Kịch bản: (A) khôi phục về mốc T sau backup → đúng 200/200 dòng, log "recovery stopping before commit";
#           (B) mốc trước mọi backup → PHẢI bị từ chối (không âm thầm khôi phục sai).
# Exit 0 chỉ khi cả A và B đúng; in biên bản (thời điểm, chế độ kho, mốc, số dòng, thời gian khôi phục).
set -euo pipefail
export MSYS_NO_PATHCONV=1   # Git Bash: không đổi đường dẫn /var/... thành C:\...
cd "$(dirname "$0")/../.."

P=fruit-drill
MODE="${DRILL_STORAGE:-file}"
ENV_FILE="${DRILL_ENV_FILE:-infra/.env}"
[[ -f "$ENV_FILE" ]] || { echo "Không thấy $ENV_FILE"; exit 1; }
# Git Bash: docker (chương trình Windows) cần đường dẫn dạng C:/… khi đã tắt MSYS path conversion.
winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf "%s" "$1"; fi; }
ENV_FILE=$(winpath "$ENV_FILE")
RESTORE=fruit-drill-restore
IMG="fruit-retail/postgres-walg:${PG_IMAGE_TAG:-local}"
export PG_HOST_PORT="${DRILL_PG_PORT:-25433}"
envval() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -1; }
# Khóa đặt vào biến môi trường của tiến trình; container nhận qua `-e TÊN` không kèm giá trị hoặc file env tạm 600.
WALG_LIBSODIUM_KEY=$(envval WALG_LIBSODIUM_KEY)
[[ -n "$WALG_LIBSODIUM_KEY" ]] || { echo "Thiếu WALG_LIBSODIUM_KEY trong $ENV_FILE"; exit 1; }
export WALG_LIBSODIUM_KEY

case "$MODE" in
  file)
    COMPOSE=(docker compose -p "$P" -f infra/docker-compose.yml -f infra/docker-compose.backup.yml --env-file "$ENV_FILE")
    ;;
  s3)
    DRILL_PREFIX="$(envval WALG_S3_PREFIX_DRILL)"
    [[ -n "$DRILL_PREFIX" ]] || { echo "Thiếu WALG_S3_PREFIX_DRILL trong $ENV_FILE"; exit 1; }
    [[ "$DRILL_PREFIX" != "$(envval WALG_S3_PREFIX)" ]] || { echo "WALG_S3_PREFIX_DRILL phải KHÁC WALG_S3_PREFIX"; exit 1; }
    export WALG_S3_PREFIX="${DRILL_PREFIX%/}/run-$(date -u +%Y%m%dT%H%M%SZ)"   # biến shell thắng --env-file
    COMPOSE=(docker compose -p "$P" -f infra/docker-compose.yml -f infra/docker-compose.backup.yml
             -f infra/docker-compose.staging.yml --env-file "$ENV_FILE")
    ;;
  *) echo "DRILL_STORAGE chỉ nhận file|s3"; exit 1 ;;
esac

RENV=""
psql_src() { "${COMPOSE[@]}" exec -T -u postgres postgres psql -v ON_ERROR_STOP=1 -qAt -c "$1"; }
psql_dst() { docker exec -u postgres "$RESTORE" psql -U owner -d fruit -v ON_ERROR_STOP=1 -qAt -c "$1"; }
restore_run() { # $1 = mốc, $2 = volume đích
  if [[ "$MODE" == "file" ]]; then
    docker run -d --name "$RESTORE" --network none \
      -v "${P}_pgbackups:/backups:ro" -v "$2:/var/lib/postgresql/data" \
      -e WALG_FILE_PREFIX=/backups/wal-g -e WALG_LIBSODIUM_KEY -e WALG_LIBSODIUM_KEY_TRANSFORM=base64 \
      -e RECOVERY_TARGET_TIME="$1" -e RECOVERY_TARGET_ACTION=promote \
      --entrypoint restore-entrypoint.sh "$IMG" >/dev/null
  else
    RENV=$(mktemp); chmod 600 "$RENV"
    { echo "WALG_S3_PREFIX=$WALG_S3_PREFIX"; echo "AWS_ACCESS_KEY_ID=$(envval WALG_AWS_ACCESS_KEY_ID)"
      echo "AWS_SECRET_ACCESS_KEY=$(envval WALG_AWS_SECRET_ACCESS_KEY)"; echo "AWS_ENDPOINT=$(envval WALG_AWS_ENDPOINT)"
      echo "AWS_REGION=$(envval WALG_AWS_REGION)"; echo "AWS_S3_FORCE_PATH_STYLE=$(envval WALG_AWS_S3_FORCE_PATH_STYLE)"
      echo "WALG_LIBSODIUM_KEY=$WALG_LIBSODIUM_KEY"; echo "WALG_LIBSODIUM_KEY_TRANSFORM=base64"; } > "$RENV"
    docker run -d --name "$RESTORE" --network "${P}_default" --add-host host.docker.internal:host-gateway \
      -v "$2:/var/lib/postgresql/data" --env-file "$(winpath "$RENV")" \
      -e RECOVERY_TARGET_TIME="$1" -e RECOVERY_TARGET_ACTION=promote \
      --entrypoint restore-entrypoint.sh "$IMG" >/dev/null
    rm -f "$RENV"; RENV=""
  fi
}
cleanup() {
  docker rm -f "$RESTORE" >/dev/null 2>&1 || true
  [[ -n "$RENV" ]] && rm -f "$RENV"
  "${COMPOSE[@]}" down -v >/dev/null 2>&1 || true
  docker volume rm -f "${P}_restoredata" "${P}_restoredata_b" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

echo "== 1. Dựng postgres có WAL-G (project $P)"
"${COMPOSE[@]}" up -d --build --wait postgres >/dev/null
T0=$(psql_src "SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'")
sleep 2

echo "== 2. Dữ liệu trước backup full: 100 dòng"
psql_src "CREATE SCHEMA drill; CREATE TABLE drill.t(id int PRIMARY KEY, at timestamptz NOT NULL DEFAULT now());
          INSERT INTO drill.t(id) SELECT g FROM generate_series(1,100) g;"

echo "== 3. Backup full (wal-g backup-push, có mã hóa libsodium)"
"${COMPOSE[@]}" exec -T -u postgres postgres wal-g backup-push /var/lib/postgresql/data 2>&1 | tail -1

echo "== 4. Thêm 100 dòng sau backup, ghi mốc T, thêm 100 dòng sau mốc"
psql_src "INSERT INTO drill.t(id) SELECT g FROM generate_series(101,200) g;"
sleep 2
T=$(psql_src "SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'")
sleep 2
psql_src "INSERT INTO drill.t(id) SELECT g FROM generate_series(201,300) g;"
SRC_TOTAL=$(psql_src "SELECT count(*) FROM drill.t")
LSN=$(psql_src "SELECT pg_walfile_name(pg_switch_wal())")
echo "   mốc T = $T; nguồn có $SRC_TOTAL dòng; đã chuyển WAL $LSN"

echo "== 5. Chờ WAL được archive (tối đa 60 s) và kiểm sức khỏe backup"
archived=0
for i in $(seq 1 60); do
  LAST=$(psql_src "SELECT coalesce(last_archived_wal,'') FROM pg_stat_archiver")
  FAIL=$(psql_src "SELECT failed_count FROM pg_stat_archiver")
  if [[ "$FAIL" != "0" ]]; then echo "   archive_command lỗi ($FAIL lần)"; exit 1; fi
  if [[ -n "$LAST" && ( "$LAST" > "$LSN" || "$LAST" == "$LSN" ) ]]; then archived=1; break; fi
  sleep 1
done
[[ "$archived" == "1" ]] || { echo "   QUÁ THỜI GIAN: WAL $LSN chưa được archive sau 60 s"; exit 1; }
echo "   last_archived_wal = $LAST"
"${COMPOSE[@]}" exec -T -u postgres postgres check-archive.sh | sed 's/^/   check-archive: /'

echo "== 6. Giả lập mất DB: dừng nguồn"
"${COMPOSE[@]}" stop postgres >/dev/null

echo "== 7A. Khôi phục vào volume TRỐNG tới mốc T"
R0=$(date +%s)
restore_run "$T" "${P}_restoredata"
ok=0
for i in $(seq 1 180); do
  if docker exec -u postgres "$RESTORE" pg_isready -q 2>/dev/null &&
     [[ "$(psql_dst "SELECT pg_is_in_recovery()" 2>/dev/null)" == "f" ]]; then ok=1; break; fi
  if ! docker ps -q -f "name=^${RESTORE}$" | grep -q .; then docker logs "$RESTORE" 2>&1 | tail -20; exit 1; fi
  sleep 1
done
[[ "$ok" == "1" ]] || { echo "   QUÁ THỜI GIAN: chưa phục hồi xong sau 180 s"; docker logs "$RESTORE" 2>&1 | tail -20; exit 1; }
RECOVERY_S=$(( $(date +%s) - R0 ))
GOT=$(psql_dst "SELECT count(*) || ' ' || max(id) || ' ' || count(*) FILTER (WHERE id > 200) FROM drill.t")
read -r CNT MAXID AFTER <<<"$GOT"
LOGS=$(docker logs "$RESTORE" 2>&1)
STOPPED=$(grep -c "recovery stopping before commit" <<<"$LOGS" || true)
USED=$(grep -o "dùng backup [^ ]*" <<<"$LOGS" | head -1)
echo "   $USED; sau khôi phục: $CNT dòng, max id $MAXID, $AFTER dòng sau mốc; ${RECOVERY_S}s"
grep -E "recovery stopping|selected new timeline|archive recovery complete" <<<"$LOGS" | sed 's/^/   log: /' | tail -3
docker rm -f "$RESTORE" >/dev/null

echo "== 7B. Mốc TRƯỚC mọi backup ($T0) → phải bị từ chối"
restore_run "$T0" "${P}_restoredata_b"
for i in $(seq 1 30); do docker ps -q -f "name=^${RESTORE}$" | grep -q . || break; sleep 1; done
B_EXIT=$(docker inspect -f '{{.State.ExitCode}}' "$RESTORE")
B_RUNNING=$(docker inspect -f '{{.State.Running}}' "$RESTORE")
B_MSG=$(docker logs "$RESTORE" 2>&1 | grep -o "không có backup nào kết thúc trước mốc" | head -1 || true)
echo "   container chạy=$B_RUNNING, exit=$B_EXIT, thông báo: ${B_MSG:-(không có)}"

PASS_A=0; PASS_B=0
[[ "$CNT" == "200" && "$MAXID" == "200" && "$AFTER" == "0" && "$STOPPED" -ge 1 ]] && PASS_A=1
[[ "$B_RUNNING" == "false" && "$B_EXIT" != "0" && -n "$B_MSG" ]] && PASS_B=1

echo
echo "BIÊN BẢN DIỄN TẬP PITR (backup mã hóa libsodium, kho = $([[ $MODE == s3 ]] && echo "S3 $WALG_S3_PREFIX" || echo "volume local"))"
echo "  thời điểm chạy (UTC):  $(date -u +%FT%TZ)"
echo "  A. mốc khôi phục T:    $T"
echo "     nguồn trước sự cố:  $SRC_TOTAL dòng (1–300)"
echo "     kỳ vọng:            200 dòng (1–200), 0 dòng sau mốc, log dừng trước commit"
echo "     thực tế:            $CNT dòng, max id $MAXID, $AFTER dòng sau mốc, log dừng=$STOPPED, ${RECOVERY_S}s"
echo "     → $([[ $PASS_A == 1 ]] && echo ĐẠT || echo KHÔNG ĐẠT)"
echo "  B. mốc trước mọi backup: $T0 → $([[ $PASS_B == 1 ]] && echo 'bị từ chối đúng: ĐẠT' || echo 'KHÔNG ĐẠT')"
if [[ $PASS_A == 1 && $PASS_B == 1 ]]; then echo "  KẾT QUẢ: ĐẠT"; else echo "  KẾT QUẢ: KHÔNG ĐẠT"; exit 1; fi
