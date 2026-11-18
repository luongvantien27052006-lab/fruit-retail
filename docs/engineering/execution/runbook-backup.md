# Runbook — Backup & khôi phục PostgreSQL (WAL-G)

Căn cứ: SPEC §3.6 (backup full hằng ngày + WAL liên tục ra nhà cung cấp KHÁC, diễn tập mỗi quý), §15 (mất dữ liệu
tối đa 5 phút, khôi phục ≤ 4 giờ). Thành phần: `infra/postgres/` (image + WAL-G v3.0.9), `infra/docker-compose.backup.yml`,
`infra/backup/`. cwd mọi lệnh = gốc repo (Git Bash cần `MSYS_NO_PATHCONV=1`, script đã tự đặt).

## 1. Cấu hình

| Biến | Local | VPS (staging/production) |
|---|---|---|
| Kho | `WALG_FILE_PREFIX=/backups/wal-g` (volume `pgbackups`) | `WALG_S3_PREFIX=s3://<bucket>/<env>` + `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT`, `AWS_REGION` — object storage **ở nhà cung cấp khác** VPS |
| Mã hóa | `WALG_LIBSODIUM_KEY` (32 byte base64) | như local; **khóa lưu thêm 1 bản ngoài VPS** (két mật khẩu của Tiến). Mất khóa = mất toàn bộ backup |
| Archive | `archive_mode=on`, `archive_command=wal-g wal-push %p`, `archive_timeout=60` | như local (RPO ≈ 60 s + thời gian đẩy, đạt ≤ 5 phút khi archive không lỗi) |
| Giữ lại | `BACKUP_RETAIN_FULL=14` (dọn tại chỗ trong `backup-full.sh`) | `BACKUP_RETAIN_FULL=0` trên VPS (khóa không có quyền xóa); dọn bằng lifecycle rule của bucket hoặc `infra/backup/retention.sh <env-file> 14` chạy NGOÀI VPS |

VPS — bucket: bật **versioning + object lock (≥ 30 ngày)**; khóa S3 cấp cho VPS **chỉ được ghi/đọc, không được xóa**
(retention chạy bằng khóa riêng có quyền xóa, giữ ngoài VPS) — để ai chiếm được DB/VPS cũng không xóa được backup.

## 2. Lịch chạy (cron trên VPS)

| Việc | Lịch | Lệnh | Khi lỗi |
|---|---|---|---|
| Backup full + kiểm (không dọn trên VPS) | 02:30 hằng ngày | `BACKUP_RETAIN_FULL=0 infra/backup/backup-full.sh fruit-retail` | exit ≠ 0 → cảnh báo Telegram |
| Dọn bản cũ | hằng tuần, máy quản trị | `infra/backup/retention.sh <env-file-quyền-600> 14` (hoặc lifecycle rule) | exit ≠ 0 → kiểm tay |
| Kiểm sức khỏe archive | mỗi 5 phút | `docker compose … exec -T -u postgres postgres check-archive.sh` | `ARCHIVE_FAILING` / `ARCHIVE_LAG` / `FULL_BACKUP_STALE` → cảnh báo Telegram |
| Diễn tập khôi phục | mỗi quý (và sau mỗi thay đổi backup) | `bash infra/backup/drill-pitr.sh` | KHÔNG ĐẠT → sự cố mức cao |

## 3. Khôi phục thật về một thời điểm

1. **Chốt mốc T** (UTC, có múi giờ), ví dụ ngay trước lệnh xóa nhầm: `2026-11-18 01:29:00+00`. Ghi vào LOG.
2. Dừng ghi: `docker compose … stop api worker` (giữ DB nguồn để điều tra, KHÔNG xóa volume).
3. Khôi phục vào **volume mới**, mặc định `pause` để kiểm trước khi mở. Khóa và thông tin S3 để trong file env tạm
   quyền 600 (KHÔNG gõ `-e KEY=giá-trị` trên dòng lệnh — lộ qua `ps`/shell history); xóa file sau khi xong:
   ```bash
   install -m 600 /dev/null /root/restore.env   # điền WALG_S3_PREFIX, AWS_*, WALG_LIBSODIUM_KEY, WALG_LIBSODIUM_KEY_TRANSFORM=base64
   docker run -d --name pg-restore --network fruit-retail_default \
     -v fruit-retail_pgrestore:/var/lib/postgresql/data --env-file /root/restore.env \
     -e RECOVERY_TARGET_TIME='2026-11-18 01:29:00+00' \
     --entrypoint restore-entrypoint.sh fruit-retail/postgres-walg:<tag>
   ```
   Script kiểm mốc trước khi tải, tự chọn backup mới nhất **kết thúc trước T**; không có → dừng với lỗi.
   Container đang phục hồi/đang pause khởi động lại được (`docker restart pg-restore`) mà không tải lại backup.
4. Chờ log `recovery stopping before …` và `pausing at the end of recovery`. Kiểm dữ liệu bằng `psql` (chỉ đọc).
5. Đúng → `SELECT pg_wal_replay_resume();` (promote, sang timeline mới). Sai → xóa container + volume, chọn T khác.
6. **Sau khôi phục (bắt buộc):**
   - Khởi động lại DB đã khôi phục bằng compose có `docker-compose.backup.yml` (bật lại `archive_mode=on`; cấu hình
     phục hồi chỉ truyền qua `-c` nên không còn sót trong `postgresql.auto.conf`).
   - Đẩy file lịch sử timeline mới lên kho (lúc promote archive đang tắt nên nó KHÔNG tự lên):
     `docker compose … exec -T -u postgres postgres sh -c 'for f in "$PGDATA"/pg_wal/*.history; do wal-g wal-push "$f"; done'`
   - Chạy ngay `infra/backup/backup-full.sh` để có backup full trên timeline mới.
   - Đổi volume dữ liệu của service `postgres` sang volume đã khôi phục; bật lại `api`, `worker`; kiểm `/v1/health`.
   - Ghi biên bản (mốc T, backup dùng, thời gian, số liệu kiểm) vào `docs/engineering/execution/LOG.md`.

## 4. Giới hạn hiện tại

- WAL-G chỉ build cho **amd64**; VPS ARM cần đổi asset `wal-g-pg-20.04-aarch64` + sha256 tương ứng.
- Local dùng volume trên cùng máy — **không** đạt yêu cầu "nhà cung cấp khác"; cổng diễn tập CP02 chỉ tick khi chạy
  `drill-pitr.sh` với `WALG_S3_PREFIX` trên VPS.
