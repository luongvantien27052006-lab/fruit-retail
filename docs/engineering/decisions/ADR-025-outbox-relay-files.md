# ADR-025: Outbox relay + consumer idempotent, upload file qua S3 (CP03 lát 7)

- Trạng thái: accepted (kỹ thuật) · Ngày: 2026-11-26 · Người quyết: phiên điều phối (CP03 lát 7) — đã qua kiểm thử agent (SẠCH, xem cuối)
- Làm rõ: ADR-002 (worker, Redis không là nguồn quyết định), ADR-007 (outbox, processed_events), ADR-014 (file),
  ADR-017 (Redis AOF everysec, noeviction)

## Quyết định — outbox
1. **Relay** (`infra/outbox/outbox-relay.ts`, chạy trong tiến trình worker): mỗi lượt MỘT transaction — khóa ≤ 100 dòng
   `published_at IS NULL AND dead_at IS NULL AND next_attempt_at <= now()` theo `(next_attempt_at, id)` bằng
   `FOR UPDATE SKIP LOCKED` (nhiều worker không lấy trùng), đẩy từng dòng vào BullMQ (`outbox-events`) với **jobId = id
   sự kiện**, rồi đánh dấu `published_at`. Đẩy lại cùng jobId là không làm gì ⇒ worker chết sau khi đẩy mà trước khi
   commit: lần sau đẩy lại không tạo job trùng.
2. **Lỗi đẩy:** một lệnh Redis quá 2 giây = lỗi; lỗi một dòng ⇒ không thử phần còn lại của lượt (không giữ khóa chờ
   timeout từng dòng); các dòng đó `attempts + 1`, lùi `2^n` giây (trần 1 giờ), `last_error`; quá 10 lần ⇒ `dead_at`
   (relay không lấy nữa — giám sát/xử lý tay, CP19).
3. **Consumer** (`ConsumerRunner`): mỗi consumer một transaction — `INSERT processed_events(consumer, event_id) ON
   CONFLICT DO NOTHING`; chèn được mới chạy `handle` trong cùng transaction ⇒ giao nhiều lần, tác dụng một lần. Consumer A
   lỗi không rollback tác dụng của B; job ném lỗi ⇒ BullMQ thử lại (8 lần, lùi dần từ 2 giây), consumer đã xong tự bỏ
   qua; hết lượt ⇒ job nằm tập "failed" (giữ, không xóa) + log error.
4. **Bộ quét** (5 phút): Redis AOF `everysec` có thể mất ≤ 1 giây job khi sập ⇒ sự kiện đã đánh dấu gửi > 10 phút mà còn
   consumer quan tâm chưa có `processed_events`, và job KHÔNG còn trong Redis ⇒ đẩy lại cùng jobId. Job còn trong Redis
   (kể cả đang lỗi) để yên. ⇒ không mất sự kiện dù Redis mất dữ liệu gần nhất.
5. Job xong giữ 7 ngày (khóa trùng jobId trong cửa sổ đó); sau 7 ngày, đẩy lại một sự kiện cũ vẫn an toàn nhờ
   processed_events.
6. Hiện **chưa có consumer nghiệp vụ** (`EVENT_CONSUMERS = []` ở WorkerModule): projection (CP12), thông báo
   (`auth.new_device_login`…) đăng ký sau. Relay vẫn chạy (sự kiện được đẩy và giữ trong Redis 7 ngày).
7. Worker dùng role `app_rw` (UPDATE cột outbox, INSERT processed_events). Consumer projection sau này dùng
   `projector_rw` (CP12).

## Quyết định — file
1. **Lưu trữ** (`infra/object-storage.service.ts`): S3 tương thích, bucket riêng tư; env `S3_ENDPOINT`, `S3_BUCKET`,
   `S3_ACCESS_KEY`, `S3_SECRET_KEY` (§19.4) + `S3_REGION`, `S3_FORCE_PATH_STYLE`, `S3_PUBLIC_ENDPOINT` (địa chỉ ký URL cho
   client khi API gọi S3 qua mạng nội bộ). Thiếu ⇒ `/files/*` 503. Không bật checksum CRC tự động của SDK (kho tương
   thích có thể không hỗ trợ) — sha256 do server tự tính. Local/CI: SeaweedFS (cùng image diễn tập backup); thật: Tiến
   chọn nhà cung cấp (khác bucket backup — ADR-014).
2. **Loại file** client tải lên: `PHOTO_SPOILAGE`, `PHOTO_WEIGHT`, `PHOTO_COMPLAINT` (chỉ `capture_source = CAMERA` — app chụp trực tiếp; khách chỉ được ảnh khiếu nại),
   `PHOTO_COMPLAINT`, `PHOTO_RECEIPT`, `PHOTO_PRODUCT`; ảnh `image/jpeg|webp` ≤ 5 MB. File báo cáo do server tạo, không qua
   presign.
3. **presign** (`auth:*`): bản ghi `PENDING` + presigned PUT 5 phút ký cả `Content-Type` và `Content-Length` (gửi khác
   ⇒ S3 từ chối); tối đa 20 file/giờ và 100 file/ngày mỗi người, mọi trạng thái (khóa advisory theo người ⇒ không vượt khi gửi song song); audit
   `file.presign`.
4. **complete** (chỉ người tạo; người khác ⇒ 404): tải lại + tính sha256, đếm byte, nhận định dạng theo byte đầu NGOÀI
   transaction (`@OwnTransaction`), rồi transaction ngắn khóa dòng (`FOR UPDATE`, còn PENDING) ghi kết quả. Lệch kích
   thước / sha256 / định dạng thật, hoặc PENDING > 1 giờ ⇒ `REJECTED` (+ lý do, xóa object); chưa PUT ⇒ 409 (thử lại
   được). Trùng sha256 với file READY khác ⇒ READY + `duplicate_of_id` + cảnh báo `DUPLICATE_CONTENT` (FR-INV-16: phát
   hiện ảnh dùng lại, không chặn).
5. **download-url:** READY, người tạo hoặc Master ⇒ presigned GET 60 giây (`Content-Disposition: attachment`). Quyền theo
   chủ sở hữu (`owner_type` — phiếu hủy, khiếu nại…) thêm khi nghiệp vụ gắn file (CP06+). Viewer bị guard chặn (ADR-024);
   tải file báo cáo của viewer qua `/viewer/files/{id}/download` (CP12).

## Sửa theo kiểm thử agent lần 1 (4af7852)
**silent-failure-hunter + code-reviewer** (trùng nhau nhiều mục):
- **C1 Cao (outbox):** Redis sập ~17 phút từng làm mọi sự kiện đang chờ thành `dead_at`. Nay lỗi hạ tầng (đẩy lỗi VÀ PING
  lỗi) **không cộng attempts, không bao giờ dead_at**; vòng relay lùi dần 1 → 30 s. Chỉ lỗi riêng của dòng (Redis vẫn
  PING được) mới cộng attempts / lùi dần / dead_at; dòng chưa thử trong lượt không bị đụng; dòng chuyển dead ⇒ log error
  (không qua bộ hãm). Mục 2 phía trên thay bằng điều này.
- **C1 Cao (file):** URL PUT còn hạn ghi đè được nội dung sau READY. Nay complete CHÉP object sang khóa cuối `final/…`
  (không URL ký nào trỏ tới), tính sha256 + định dạng trên CHÍNH bản chép, luôn xóa khóa tải lên; tải về đọc khóa cuối.
  PUT lại sau đó chỉ tạo object mồ côi ở khóa tải lên (không bao giờ được phục vụ; dọn ở CP19).
- **TB (file):** khách chỉ được `PHOTO_COMPLAINT` (ảnh nghiệp vụ nội bộ chỉ nhân viên/Master, 403); trần đếm MỌI file tạo:
  20 / giờ, 100 / ngày mỗi người (trước chỉ đếm PENDING ⇒ presign→complete liên tục không giới hạn).
- **TB (outbox, bộ quét):** duyệt theo con trỏ id (job lỗi tồn đọng không chặn đầu hàng); cửa sổ 10 phút – 8 ngày; job đã
  XONG mà consumer quan tâm chưa xử lý (consumer mới — backfill) ⇒ xóa job cũ, đẩy lại; job lỗi hẳn ⇒ để yên, đếm, log.
  Consumer thêm sau 8 ngày không tự backfill sự kiện cũ hơn — làm tay khi đăng ký consumer (ghi ở CP12).
- **TB (outbox):** job lỗi HẲN vì stalled quá giới hạn / `UnrecoverableError` trước kia không log ⇒ nay mọi job không còn được
  thử lại đều log error; `maxStalledCount` 3.
- Thấp: bỏ `connect()` thừa (lỗi giả mỗi lần khởi động); log hãm THEO TỪNG KHÓA + báo số dòng đã bỏ; lượt quét không
  chồng, `stop()` chờ lượt quét; relay có trần 40 s mỗi lượt (Redis chậm đều không làm transaction quá hạn lặp mãi);
  lỗi S3 log tên + mã HTTP (không lộ khóa), lỗi stream giữa chừng ⇒ 503; complete kiểm cấu hình trước; `remove` không ném
  ra ngoài; khóa advisory theo sha256 khi tìm bản trùng (hai complete song song cùng ảnh không né FR-INV-16); S3 cấu hình
  thiếu một phần ⇒ không khởi động.
- Ghi nhận để sau: thứ tự sự kiện không được bảo đảm (consumer CP12 phải tự chịu); chỉ số tồn đọng / dead / failed trên
  heartbeat + màn xem (CP19); audit lượt tải file của Master (CP06+ khi có owner); Idempotency-Key chưa có middleware (chung).

## Sửa theo kiểm thử agent lần 2 (cd76b58)
- **Cao (outbox, cả hai agent):** Redis PING được nhưng từ chối ghi (OOM, MISCONF, READONLY, LOADING, TRYAGAIN…) hoặc quá hạn
  vẫn bị tính là lỗi của dòng ⇒ dead_at sau ~17–34 phút. Nay phân loại theo NỘI DUNG lỗi (`isInfraError`: không phải
  ReplyError, hoặc ReplyError có tiền tố hạ tầng) — chỉ ReplyError khác (Redis ghi được nhưng từ chối riêng dòng đó) mới
  cộng attempts. Lỗi dòng chưa tới dead ⇒ log có hãm theo loại sự kiện. `redisDown` đặt lại trước transaction; báo dead
  SAU commit.
- **Cao (file, cả hai agent):** hai complete song song chép đè cùng khóa cuối ⇒ nội dung phục vụ khác sha256 đã ghi. Nay mỗi
  lần complete chép sang khóa RIÊNG `final/…/<id>/<ngẫu nhiên>`, kiểm trên bản chép; chỉ lần thắng (giữ khóa dòng, còn
  PENDING) ghi cột mới `final_key` (migration 0006: CHECK READY ⇔ final_key, unique, quyền cột); lần thua / bị từ chối xóa bản
  chép của mình; tải về đọc `final_key`. Copy lỗi vì file vừa được complete khác xử lý ⇒ 409 (không 503). `finalKeyOf`
  kiểm tiền tố `files/`.
- **TB (code-reviewer):** SPEC §8.8 mục 1, U12 — ảnh khiếu nại chụp trực tiếp ⇒ `PHOTO_COMPLAINT` cameraOnly. Video khiếu nại:
  CP khiếu nại.
- Thấp: S3 đặt riêng `S3_PUBLIC_ENDPOINT` mà thiếu 4 biến chính ⇒ cũng không khởi động; đổi tên hằng `MAX_FILES_PER_HOUR`.
- Ghi nhận: test `auth.test.ts` R1 (hàng đợi Argon2 đầy ⇒ 429) nhạy tải khi hai bộ test chạy song song — chạy riêng đạt.

## Kiểm thử lần 3 (20322d8): SẠCH (silent-failure-hunter + code-reviewer)
Ghi nhận Thấp để sau: (1) lỗi hạ tầng bị xếp `down` chưa lưu nguyên nhân (OOM/READONLY…) vào log `relay-redis` — thêm
`lastInfraError`; lỗi không phải ReplyError lặp mãi ở cùng một dòng ⇒ log id dòng đầu hàng sau N lượt (CP19 giám sát);
(2) job dọn CP19 phải xử lý cả bản chép `final/…` không trùng `final_key`, khóa tải lên mồ côi, PENDING quá hạn — và
không xóa ngay khi commit không rõ kết quả; (3) 0006 không backfill `final_key`: DB đã có file READY trước 0006 phải
backfill `final/` + phần sau `files/` của storage_key trước khi áp (hiện chưa có môi trường dùng chung); (4) test song song
mang tính xác suất, chưa liệt kê object thừa; tên test C1 nói nhiều hơn điều nó kiểm; (5) câu báo của bên thua đua
("Chưa tải file lên") dễ hiểu nhầm; `WRONGTYPE` tính là lỗi dòng.

## Hệ quả
- Thư viện: `bullmq` 6.7.4, `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` 3.1166.0 (ghim chính xác);
  `msgpackr-extract` (native tùy chọn) không chạy script cài đặt.
- `loadEnv` coi biến rỗng là không đặt (compose `${X:-}`). Compose API truyền `OTP_PROVIDER`, `S3_*`.
- OpenAPI: `FilePresignRequest/Response`, `FileCompleteResponse`, `FileDownloadUrlResponse`. Migration `0006_files_final_key` (cột `final_key`).
- Để sau: job dọn object/bản ghi PENDING quá hạn và `processed_events` cũ (CP19); màn xem job "failed" + chạy lại (lát 8 /
  CP19); quyền tải theo owner (CP06+).
