#!/usr/bin/env bash
# Diễn tập khôi phục PostgreSQL về MỘT THỜI ĐIỂM (PITR) bằng WAL-G — CP02 mục 7, §3.6 "diễn tập khôi phục".
# Chạy trên project compose riêng `fruit-drill` (không đụng DB dev). cwd = gốc repo. Cần infra/.env.
#   bash infra/backup/drill-pitr.sh
# Kết quả: in biên bản (thời điểm, lệnh, số dòng trước/sau mốc) và exit 0 nếu khôi phục đúng; exit ≠ 0 nếu sai.
set -euo pipefail
export MSYS_NO_PATHCONV=1   # Git Bash: không đổi đường dẫn /var/... thành C:\...

P=fruit-drill
COMPOSE=(docker compose -p "$P" -f infra/docker-compose.yml -f infra/docker-compose.backup.yml --env-file infra/.env)
RESTORE=fruit-drill-restore
export PG_HOST_PORT="${DRILL_PG_PORT:-25433}"

psql_src() { "${COMPOSE[@]}" exec -T -u postgres postgres psql -v ON_ERROR_STOP=1 -qAt -c "$1"; }
psql_dst() { docker exec -u postgres "$RESTORE" psql -U owner -d fruit -v ON_ERROR_STOP=1 -qAt -c "$1"; }
cleanup() {
  docker rm -f "$RESTORE" >/dev/null 2>&1 || true
  "${COMPOSE[@]}" down -v >/dev/null 2>&1 || true
  docker volume rm -f "${P}_restoredata" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

echo "== 1. Dựng postgres có WAL-G (project $P)"
"${COMPOSE[@]}" up -d --build --wait postgres >/dev/null

echo "== 2. Dữ liệu trước backup full: 100 dòng"
psql_src "CREATE SCHEMA drill; CREATE TABLE drill.t(id int PRIMARY KEY, at timestamptz NOT NULL DEFAULT now());
          INSERT INTO drill.t(id) SELECT g FROM generate_series(1,100) g;"

echo "== 3. Backup full (wal-g backup-push)"
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

echo "== 5. Chờ WAL được archive (pg_stat_archiver)"
for i in $(seq 1 60); do
  LAST=$(psql_src "SELECT coalesce(last_archived_wal,'') FROM pg_stat_archiver")
  FAIL=$(psql_src "SELECT failed_count FROM pg_stat_archiver")
  if [[ "$FAIL" != "0" ]]; then echo "   archive_command lỗi ($FAIL lần)"; exit 1; fi
  if [[ -n "$LAST" && "$LAST" > "$LSN" || "$LAST" == "$LSN" ]]; then break; fi
  sleep 1
done
echo "   last_archived_wal = $LAST"

echo "== 6. Giả lập mất DB: dừng nguồn; khôi phục vào volume TRỐNG tới mốc T"
"${COMPOSE[@]}" stop postgres >/dev/null
IMG=fruit-retail/postgres-walg:local
docker run -d --name "$RESTORE" --network none \
  -v "${P}_pgbackups:/backups:ro" -v "${P}_restoredata:/var/lib/postgresql/data" \
  -e WALG_FILE_PREFIX=/backups/wal-g -e RECOVERY_TARGET_TIME="$T" \
  --entrypoint restore-entrypoint.sh "$IMG" >/dev/null

echo "== 7. Chờ phục hồi xong (promote)"
for i in $(seq 1 120); do
  if docker exec -u postgres "$RESTORE" pg_isready -q 2>/dev/null &&
     [[ "$(psql_dst "SELECT pg_is_in_recovery()" 2>/dev/null)" == "f" ]]; then break; fi
  if ! docker ps -q -f "name=^${RESTORE}$" | grep -q .; then docker logs "$RESTORE" | tail -20; exit 1; fi
  sleep 1
done

echo "== 8. Kiểm kết quả"
GOT=$(psql_dst "SELECT count(*) || ' ' || max(id) || ' ' || count(*) FILTER (WHERE id > 200) FROM drill.t")
read -r CNT MAXID AFTER <<<"$GOT"
echo "   sau khôi phục: $CNT dòng, id lớn nhất $MAXID, số dòng sau mốc = $AFTER"
docker logs "$RESTORE" 2>&1 | grep -E "recovery stopping|archive recovery complete|selected new timeline" | sed 's/^/   log: /' | tail -3

echo
echo "BIÊN BẢN DIỄN TẬP PITR (local)"
echo "  thời điểm chạy (UTC): $(date -u +%FT%TZ)"
echo "  mốc khôi phục T:      $T"
echo "  nguồn trước sự cố:    $SRC_TOTAL dòng (1–300)"
echo "  kỳ vọng sau khôi phục: 200 dòng (1–200), 0 dòng sau mốc"
echo "  thực tế:              $CNT dòng, max id $MAXID, $AFTER dòng sau mốc"
if [[ "$CNT" == "200" && "$MAXID" == "200" && "$AFTER" == "0" ]]; then
  echo "  KẾT QUẢ: ĐẠT"
else
  echo "  KẾT QUẢ: KHÔNG ĐẠT"; exit 1
fi
