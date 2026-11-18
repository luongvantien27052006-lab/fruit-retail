# Runbook — Triển khai staging/production trên VPS

Căn cứ: SPEC §3.6, §15, §19.3–19.4; ADR-010/011/017/018/019; `runbook-backup.md`. Thành phần: `infra/docker-compose.yml`
+ `infra/docker-compose.backup.yml` + `infra/docker-compose.staging.yml`, `infra/caddy/Caddyfile.staging`,
`infra/.env.staging.example`. Trạng thái: **chưa chạy trên VPS thật** (chờ Tiến cấp VPS, domain, object storage).

## 0. Việc của Tiến trước khi triển khai

| Cần | Ghi chú |
|---|---|
| VPS Linux amd64 (Ubuntu 24.04 LTS), ≥ 2 vCPU / 4 GB RAM / 60 GB SSD | WAL-G trong image là bản amd64 |
| Domain + bản ghi DNS `A`/`AAAA` của `APP_DOMAIN` trỏ về VPS | Caddy cần cổng 80/443 mở để xin chứng chỉ |
| Object storage S3-compatible ở **nhà cung cấp khác** VPS | bucket riêng cho backup; bật versioning + object lock (runbook-backup §1) |
| 2 cặp khóa S3: (a) VPS — chỉ đọc/ghi; (b) quản trị — có quyền xóa, giữ ngoài VPS | (b) chỉ dùng cho `retention.sh` |
| Két mật khẩu ngoài VPS | lưu `WALG_LIBSODIUM_KEY` và toàn bộ `infra/.env` |
| (CP02 mục 8) Sentry, bot Telegram, dịch vụ uptime ngoài | chưa tích hợp — làm khi có tài khoản |

## 1. Chuẩn bị VPS (một lần)

```bash
# user không phải root, đăng nhập SSH bằng khóa; tắt đăng nhập mật khẩu và root
adduser deploy && usermod -aG sudo deploy
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/; s/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo systemctl reload ssh
# tường lửa: chỉ 22, 80, 443
sudo ufw default deny incoming && sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow 443/udp && sudo ufw enable
# cập nhật bảo mật tự động
sudo apt-get update && sudo apt-get install -y unattended-upgrades && sudo dpkg-reconfigure -plow unattended-upgrades
# Docker Engine + compose plugin theo hướng dẫn chính thức docs.docker.com (repo apt của Docker)
```
Lưu ý: Docker tự mở cổng qua iptables, bỏ qua ufw — vì vậy compose staging **không** publish cổng nào ngoài 80/443
của Caddy (postgres/redis/api chỉ trong network nội bộ).

## 2. Triển khai lần đầu

```bash
git clone https://github.com/luongvantien27052006-lab/fruit-retail.git && cd fruit-retail && git checkout develop
install -m 600 infra/.env.staging.example infra/.env   # điền giá trị thật, ≥ 24 ký tự, khác nhau
C="docker compose -p fruit-retail -f infra/docker-compose.yml -f infra/docker-compose.backup.yml -f infra/docker-compose.staging.yml --env-file infra/.env"
$C config -q                     # kiểm cấu hình (thiếu biến bắt buộc → dừng)
$C up -d --build --wait          # db-bootstrap tự chạy trước api/worker
curl -fsS https://$APP_DOMAIN/v1/health   # {"status":"ok",...}
BACKUP_RETAIN_FULL=0 infra/backup/backup-full.sh fruit-retail   # backup full đầu tiên
```
Kiểm: `curl -sI https://$APP_DOMAIN/` có `strict-transport-security`, `content-security-policy`; `http://` chuyển sang `https://`.

## 3. Cron (user deploy, `crontab -e`)

```cron
30 2 * * *  cd /home/deploy/fruit-retail && BACKUP_RETAIN_FULL=0 infra/backup/backup-full.sh fruit-retail >> /var/log/fruit/backup.log 2>&1 || /home/deploy/alert.sh "backup-full lỗi"
*/5 * * * * cd /home/deploy/fruit-retail && docker compose -p fruit-retail -f infra/docker-compose.yml -f infra/docker-compose.backup.yml -f infra/docker-compose.staging.yml --env-file infra/.env exec -T -u postgres postgres check-archive.sh >> /var/log/fruit/archive.log 2>&1 || /home/deploy/alert.sh "check-archive lỗi"
```
`alert.sh` gửi Telegram — tạo khi có bot (CP02 mục 8, đang CHẶN). Trước đó kiểm log thủ công hằng ngày.

## 4. Cập nhật phiên bản

1. `git pull` (chỉ từ `develop`/`main` đã CI xanh).
2. `$C up -d --build --wait` — `db-bootstrap` chạy lại (idempotent, file SQL đã áp có kiểm sha256).
3. `curl -fsS https://$APP_DOMAIN/v1/health`; lỗi → `git checkout <commit trước>` rồi `$C up -d --build --wait`.
Migration phá hủy dữ liệu cần Tiến duyệt và backup full ngay trước khi chạy.

## 5. Diễn tập khôi phục trên VPS (cổng CP02)

Chạy `drill-pitr.sh` với kho S3 thật (project riêng `fruit-drill`, không đụng DB staging) theo runbook-backup §3; ghi biên
bản vào `checkpoints/CP02.md`. Đây là điều kiện để tick cổng "biên bản diễn tập khôi phục".
