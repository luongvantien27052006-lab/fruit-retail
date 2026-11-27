# ADR-029: Redis ACL theo user (CP03 lát 10, đóng giới hạn ADR-019)

- Trạng thái: accepted (kỹ thuật) — review cổng CP03 SẠCH · Ngày: 2026-11-27 · Người quyết: phiên điều phối (CP03 lát 10)
- Làm rõ: ADR-002 (Redis chỉ là queue/cache, không là nguồn quyết định), ADR-019 (giới hạn "Redis dùng `requirepass`
  chung"), ADR-023 (giới hạn tần suất), ADR-025 (outbox BullMQ)

## Bối cảnh
ADR-019 để lại một giới hạn: Redis dùng chung một mật khẩu `requirepass`. Bất kỳ tiến trình nào có mật khẩu đó đều chạy được
FLUSHALL, CONFIG SET, DEBUG… Đến CP03 đã có hai người dùng Redis thật:
- api: giới hạn tần suất, Lua EVAL trên `rl:*`;
- worker: outbox BullMQ trên `bull:*`.

## Quyết định
1. **`infra/redis/start.sh`** kiểm mật khẩu, sinh file ACL trong container (chỉ user redis đọc được, mật khẩu không vào
   log), rồi chạy `redis-server --aclfile`. File ACL có các user sau:
   - `default` **tắt**: không còn requirepass chung;
   - `ops` toàn quyền: dành cho người vận hành (`redis-cli --user ops` trong container), ứng dụng không dùng;
   - `api`: chỉ khóa `~rl:*`;
   - `worker`: chỉ khóa `~bull:*`.

   Lệnh của `api` và `worker`: `-@all +@read +@write +@scripting +@connection -@dangerous -@admin +ping +info +client|setname
   +client|getname +client|id`, chặn SCRIPT/FUNCTION FLUSH|KILL…, `resetchannels`. INFO được mở lại vì ioredis (ready check)
   và BullMQ (kiểm phiên bản) cần.
2. **Mật khẩu:** ba biến `REDIS_PASSWORD` (ops), `REDIS_API_PASSWORD` và `REDIS_WORKER_PASSWORD` đều bắt buộc. Mỗi mật khẩu
   từ 16 ký tự trở lên, không khoảng trắng, và ba giá trị phải khác nhau; sai thì Redis không khởi động. Staging thêm luật
   của `stg.sh`: từ 24 ký tự, chỉ `[A-Za-z0-9_-]`, không trùng mật khẩu khác.
3. **Compose:**
   - api dùng `redis://api:…`, worker dùng `redis://worker:…`;
   - healthcheck chạy `redis-cli --user api ping`;
   - script được bind-mount read-only và chạy qua `sh`, nên không phụ thuộc bit thực thi.

## Sửa theo review cổng CP03
- Chặn thêm cho api/worker: `SCRIPT DEBUG` (chế độ debug đồng bộ treo cả Redis), toàn bộ `FUNCTION`/`FCALL` (thư viện
  dùng chung, ghi đè được, lưu vào RDB/AOF), `SCAN`/`RANDOMKEY`/`DBSIZE` (lộ tên khóa tiền tố khác), `CLIENT
  TRACKING`/`CACHING` (nhận invalidate tên khóa người khác). MULTI/EXEC vốn không cấp (`@transaction`): outbox không dùng;
  FlowProducer/getJobLogs của BullMQ sẽ cần cấp khi dùng.
- File ACL chỉ chứa SHA-256 (`#hash`), không có mật khẩu rõ. Mật khẩu vẫn nằm trong env của container (thấy qua
  `docker inspect` — cần quyền docker ≈ root); chuyển docker secrets khi lên VPS.
- `--maxmemory 256mb` (noeviction) + `mem_limit: 384m`: lộ mật khẩu api/worker không lấp đầy được RAM máy.
- Chấp nhận: `INFO` (cần cho ready check của ioredis và kiểm phiên bản của BullMQ) vẫn trả `keyspace` = số khóa mỗi db — không
  lộ tên khóa.

## Hệ quả
- Test `apps/api/test/redis-acl.test.ts` chạy Redis thật bằng chính `start.sh`. Nội dung kiểm:
  - RateLimiter thật (Lua) chạy được dưới user api; OutboxWorker thật (BullMQ) chạy được dưới user worker;
  - FLUSHALL, FLUSHDB, CONFIG, DEBUG, KEYS, SHUTDOWN, CLIENT KILL, SCRIPT FLUSH, ACL, MONITOR đều bị từ chối, kể cả khi gọi
    qua Lua;
  - api không ghi được `bull:*`, worker không ghi được `rl:*`;
  - default tắt;
  - script từ chối cấu hình yếu.
- Smoke test compose (project tạm `frtest-redis`): service redis healthy, api gọi FLUSHALL nhận NOPERM.
- **Việc của Tiến:** thêm `REDIS_API_PASSWORD` và `REDIS_WORKER_PASSWORD` vào `infra/.env`, và cả `.env.staging` khi có VPS.
  Mỗi mật khẩu từ 16 ký tự trở lên (staging từ 24, chỉ `[A-Za-z0-9_-]`) và khác `REDIS_PASSWORD`. Chưa thêm thì stack local
  không khởi động.
- Redis có dữ liệu cũ (AOF) vẫn dùng được: ACL không đụng dữ liệu.
