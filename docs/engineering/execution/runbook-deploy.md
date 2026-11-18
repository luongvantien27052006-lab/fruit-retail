# Runbook — Triển khai staging/production trên VPS

Căn cứ: SPEC §3.6, §15, §19.3–19.4; ADR-010/011/017/018/019; `runbook-backup.md`. Thành phần: `infra/stg.sh` (wrapper
compose + preflight), `infra/docker-compose{,.backup,.staging}.yml`, `infra/caddy/Caddyfile.staging`,
`infra/.env.staging.example`, `infra/ops/{cron-run,alert}.sh`. Trạng thái: **chưa chạy trên VPS thật** (chờ Tiến cấp VPS,
domain, object storage). Đã kiểm ở máy dev: stack staging dựng thật với `APP_DOMAIN=localhost` (HTTPS CA nội bộ), diễn
tập PITR qua S3 (SeaweedFS local).

## 0. Việc của Tiến trước khi triển khai

| Cần | Ghi chú |
|---|---|
| VPS Linux **amd64**, Ubuntu 24.04 LTS, ≥ 2 vCPU / 4 GB RAM / 60 GB SSD | WAL-G trong image là bản amd64 |
| Domain + bản ghi DNS **A** của `APP_DOMAIN` → IP VPS | **Không tạo AAAA** cho tới khi bật IPv6 cho network docker (nếu không, IP client qua IPv6 hiện thành IP nội bộ) |
| Object storage S3-compatible ở **nhà cung cấp khác** VPS | bucket riêng; versioning + object lock; lifecycle rule xóa prefix `drill/` sau 7 ngày |
| 2 cặp khóa S3: (a) VPS — chỉ đọc/ghi; (b) quản trị — có quyền xóa, giữ ngoài VPS | (b) chỉ cho `retention.sh` |
| Két mật khẩu ngoài VPS | lưu bản sao `infra/.env` (đặc biệt `WALG_LIBSODIUM_KEY`) |
| Sentry, bot Telegram, dịch vụ uptime ngoài | CP02 mục 8 — **CHẶN**; khi chưa có, `alert.sh` chỉ ghi `~/fruit-logs/alerts.log` + syslog |

## 1. Chuẩn bị VPS (một lần, chạy bằng root hoặc sudo)

```bash
timedatectl set-timezone Asia/Ho_Chi_Minh && systemctl restart cron   # cron đọc múi giờ lúc khởi động
sed "s|@HOME@|/home/deploy|" /home/deploy/fruit-retail/infra/ops/logrotate.conf > /etc/logrotate.d/fruit-retail  # sau bước clone §2
adduser --disabled-password --gecos "" deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
install -m 600 -o deploy -g deploy ~/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys   # khóa SSH của Tiến
# Docker Engine + compose plugin theo hướng dẫn chính thức docs.docker.com (repo apt của Docker), rồi:
usermod -aG docker deploy      # LƯU Ý: group docker tương đương quyền root trên máy — chỉ cấp cho deploy
apt-get update && apt-get install -y unattended-upgrades && dpkg-reconfigure -plow unattended-upgrades
ufw default deny incoming && ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp && ufw enable
```

**SSH** — Ubuntu cloud image có `/etc/ssh/sshd_config.d/50-cloud-init.conf` (`PasswordAuthentication yes`) được đọc TRƯỚC
`sshd_config`, nên sửa trực tiếp `sshd_config` không có tác dụng. Làm theo thứ tự, **giữ phiên SSH hiện tại mở**:
```bash
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\n' > /etc/ssh/sshd_config.d/00-hardening.conf
sshd -t && systemctl reload ssh
sshd -T | grep -Ei '^(passwordauthentication|permitrootlogin)'   # phải ra "no"
# Mở phiên MỚI: ssh deploy@<vps> — thành công rồi mới đóng phiên cũ.
```
Docker tự mở cổng qua iptables (bỏ qua ufw) — compose staging chỉ publish 80/443 của Caddy; postgres/redis/api chỉ trong
network nội bộ.

## 2. Triển khai lần đầu (user deploy)

```bash
git clone https://github.com/luongvantien27052006-lab/fruit-retail.git ~/fruit-retail && cd ~/fruit-retail
git checkout develop
install -m 600 infra/.env.staging.example infra/.env     # điền giá trị thật (preflight sẽ chặn nếu thiếu/yếu)
install -d -m 750 ~/fruit-logs
infra/stg.sh preflight                                   # kiểm env: quyền 600, ≥ 24 ký tự, không trùng, khóa 32 byte…
infra/stg.sh config -q
infra/stg.sh build
infra/stg.sh run --rm db-bootstrap                       # migration nền chạy riêng, lỗi thì dừng ở đây
infra/stg.sh up -d --wait
APP_DOMAIN=$(sed -n 's/^APP_DOMAIN=//p' infra/.env)
curl -fsS "https://$APP_DOMAIN/v1/health"                # {"status":"ok",...}
curl -sI "https://$APP_DOMAIN/" | grep -Ei 'strict-transport|content-security'
BACKUP_RETAIN_FULL=0 infra/backup/backup-full.sh fruit-retail   # backup full đầu tiên
```

## 3. Cron (user deploy: `crontab -e`)

Cron của Ubuntu 24.04 **không hỗ trợ `CRON_TZ`** → giờ trong crontab là giờ hệ thống (đã đặt Asia/Ho_Chi_Minh ở §1 và
restart cron). Kiểm: `timedatectl | grep 'Time zone'`.
```cron
30 2 * * *  cd $HOME/fruit-retail && BACKUP_RETAIN_FULL=0 infra/ops/cron-run.sh backup 3600 infra/backup/backup-full.sh fruit-retail
*/5 * * * * cd $HOME/fruit-retail && infra/ops/cron-run.sh check-archive 120 infra/stg.sh exec -T -u postgres postgres timeout --kill-after=10 100 check-archive.sh
```
`cron-run.sh`: khóa chống chạy chồng, timeout, log vào `~/fruit-logs/<việc>.log`, gọi `alert.sh` khi lỗi, quá giờ hoặc lần
trước chưa xong. Timeout ở host chỉ giết client `docker exec` — vì vậy lệnh trong container cũng có `timeout` riêng (nhỏ
hơn): `check-archive` 100 s < 120 s; `backup-full.sh` tự bọc `backup-push` bằng `BACKUP_PUSH_TIMEOUT` (mặc định 3300 s <
3600 s). Logrotate: `infra/ops/logrotate.conf` (§1). Cảnh báo ổ đĩa gần đầy (§15) làm cùng Telegram (CP02 mục 8).

## 4. Cập nhật phiên bản (forward-only — ADR-017)

```bash
cd ~/fruit-retail && APP_DOMAIN=$(sed -n 's/^APP_DOMAIN=//p' infra/.env)
git rev-parse HEAD >> ~/fruit-logs/deployed.log           # ghi commit đang chạy (để rollback)
git fetch && git checkout <commit đã CI xanh trên develop/main>
infra/stg.sh build      # app: tag = git sha (IMAGE_TAG); postgres: tag = hash nội dung infra/postgres (PG_IMAGE_TAG)
                        # → đổi code app KHÔNG recreate/restart DB; chỉ đổi infra/postgres mới restart postgres
git diff --name-only <commit đang chạy> HEAD -- infra/sql apps/api/prisma   # có migration?
BACKUP_RETAIN_FULL=0 infra/backup/backup-full.sh fruit-retail                 # BẮT BUỘC nếu có migration
infra/stg.sh run --rm db-bootstrap                       # lỗi → dừng, api/worker cũ vẫn chạy
infra/stg.sh up -d --wait
curl -fsS "https://$APP_DOMAIN/v1/health"
```
**Rollback:**
- Bản mới KHÔNG có file SQL/migration mới → quay **cả code** về commit cũ (lấy ở `~/fruit-logs/deployed.log`), để mọi lệnh
  `stg.sh` sau đó cũng dùng đúng tag cũ: `git checkout <sha cũ> && infra/stg.sh up -d --wait` (image cũ còn trong máy;
  thiếu thì `infra/stg.sh build` trước). Không dùng riêng `IMAGE_TAG=<sha cũ>` — lần `stg.sh` kế tiếp sẽ quay về HEAD.
- Bản mới CÓ migration → **không** quay code về (db-bootstrap code cũ sẽ từ chối vì DB có file nó không biết). Sửa bằng
  commit mới (forward fix). Trường hợp migration làm hỏng dữ liệu: khôi phục PITR về trước lúc cập nhật (runbook-backup §3).
Migration phá hủy dữ liệu cần Tiến duyệt trước.

## 5. Diễn tập khôi phục trên VPS (cổng CP02)

```bash
DRILL_STORAGE=s3 DRILL_ENV_FILE=infra/.env bash infra/backup/drill-pitr.sh
```
Dùng project riêng `fruit-drill` + prefix `WALG_S3_PREFIX_DRILL/run-<thời điểm>` (không đụng DB và backup staging). Ghi
biên bản in ra vào `checkpoints/CP02.md`. Đây là điều kiện tick cổng "biên bản diễn tập khôi phục".

## 6. Ghi chú

- Caddy chạy `admin off` → đổi `Caddyfile.staging` phải `infra/stg.sh restart caddy` (không có `caddy reload`).
- Redis dùng `requirepass` chung; **ACL theo user (tắt FLUSHALL/CONFIG/DEBUG) hoãn** tới khi có job BullMQ thật (CP03) —
  ghi trong ADR-019.
