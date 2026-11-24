# TESTS.md — Sổ TEST-ID

> Skill `test-collaboration`. Sổ này chỉ lưu chỉ mục, đánh giá và bằng chứng; test code là sự thật thực thi.
> Trạng thái: `missing` (chưa có test) · `unverified` (có test, chưa chạy/chưa có exit code) · `covered` (đã chạy,
> có lệnh + cwd + exit code 0). Không được `covered` nếu chỉ có file test.
> Mã TEST-ID ổn định theo module, không tái sử dụng; cột "Nguồn" truy ngược SPEC.

## 1. Điểm chạy test

Lệnh thật ở `docs/engineering/execution/command-catalog.md` (CP02).

## 2. Kịch bản nghiệm thu (SPEC §17 T01–T25, §21.7 T26–T41)

| TEST-ID | Nguồn | Kịch bản | Kết quả mong đợi | Mức | CP | Trạng thái | Bằng chứng |
|---|---|---|---|---|---|---|---|
| TEST-POS-001 | SPEC §17-T01 | Bán 0,845 kg nho 320.000đ/kg tại quầy | 270.400đ; trừ 845 g lô FEFO; phiếu in đúng; doanh thu hiện trên trang quản lý ≤ 3 giây | unit, integration, E2E | CP07 (POS), CP10 (realtime) | missing | — |
| TEST-POS-002 | SPEC §17-T02 | Quét tem `2000123008455` | PLU 00123, 845 g; sửa số cuối → báo sai checksum | unit | CP07 | missing | — |
| TEST-POS-003 | SPEC §17-T03 | Rút cáp cân | POS báo lỗi; nhập tay cần PIN quản lý; dòng `MANUAL` | integration, thiết bị | CP07 | missing | — |
| TEST-POS-004 | SPEC §17-T04 | Mất mạng, bán 10 hóa đơn tiền mặt, có mạng lại, gửi lại 2 lần | Đúng 10 hóa đơn; báo cáo ngày cập nhật | integration | CP09 | missing | — |
| TEST-PAY-001 | SPEC §17-T05 | Hóa đơn 114.950đ (1,21 kg × 95.000đ) trả VietQR | VA đúng 114.950đ; webhook về → POS báo đã nhận; chuyển 115.000đ → ngân hàng từ chối | integration, sandbox | CP08 | missing | — |
| TEST-PAY-002 | SPEC §17-T06 | Webhook SePay gửi trùng 3 lần | Ghi nhận 1 lần | integration | CP08 | missing | — |
| TEST-RPT-001 | SPEC §17-T07 | Đóng ngày tất cả cửa hàng | Z-report từng cửa hàng; báo cáo doanh thu ngày toàn chuỗi; viewer nhận bản không giá vốn | integration | CP10 (Master), CP12 (viewer) | missing | — |
| TEST-DEAL-001 | SPEC §17-T08 | Đẩy "Sầu riêng Ri6" hạn mức 50 kg, vùng Q7 | Push gửi khách vùng Q7; khách Q1 thấy nhưng không đặt được (hoặc không thấy — theo cấu hình) | integration | CP13 | missing | — |
| TEST-DEAL-002 | SPEC §17-T09 | Khách đặt 3 kg khi chỉ còn 2 kg hạn mức | `DEAL_SOLD_OUT` / chỉ cho đặt ≤ 2 kg | integration (đồng thời) | CP13 | missing | — |
| TEST-APPORD-001 | SPEC §17-T10 | Đơn app 2 quả dưa lưới (95.000đ/kg, tham khảo 342.000đ), cân thực 3,84 kg | Tiền thực 364.800đ; khách nhận ảnh cân + QR đúng 364.800đ; không hỏi chênh lệch | unit, integration | CP14 | missing | — |
| TEST-DLV-001 | SPEC §17-T11 | Đơn app 1 kg nho, cân thực 1,21 kg, 320.000đ/kg, COD | 387.200đ in trên tem túi; shipper thu đúng 387.200đ | integration | CP15 | missing | — |
| TEST-APPORD-002 | SPEC §17-T12 | Picker cân 1,45 kg cho đơn đặt 1 kg (lệch 45%) | Tablet cảnh báo picker đổi quả; khách không bị hỏi | widget, integration | CP14 | missing | — |
| TEST-APPORD-003 | SPEC §17-T13 | Đơn "trả sau khi cân" — khách không trả sau 30 phút | Đơn hủy, hàng trả lên kệ, hạn mức hoàn lại | integration | CP14 | missing | — |
| TEST-WS-001 | SPEC §17-T14 | Đơn sỉ 20 kg cam giá sỉ 32.000đ/kg, cân thực 20,3 kg | 649.600đ theo 20,3 kg; phiếu giao in số đặt & số thực; ghi công nợ | unit, integration | CP16 | missing | — |
| TEST-WS-002 | SPEC §17-T15 | Đơn sỉ mới khi khách đã vượt hạn mức nợ | Cảnh báo, Master quyết định | integration | CP16 | missing | — |
| TEST-VIEWER-001 | SPEC §17-T16 | Viewer gọi `GET /v1/admin/reports/sales` | 403 | integration | CP03 | missing | — |
| TEST-VIEWER-002 | SPEC §17-T17 | Role `viewer_ro` chạy `SELECT * FROM core.pos_sales` | Permission denied | integration (DB) | CP03 | covered (lớp DB) | `apps/api/test/foundation-schema.test.ts` "T17": quét `pg_catalog` — viewer_ro không có quyền S/I/U/D trên MỌI bảng `core`/`audit`/`integration`/`reporting_private`/`public` (gồm bảng tạo ở migration sau, như `core.pos_sales` CP07); `SELECT core.users` → permission denied. `pnpm --filter @fruit/api run test` exit 0 (2026-11-24, CP03 lát 1). Lớp API (`/viewer/*` pool riêng) ở lát 6 |
| TEST-VIEWER-003 | SPEC §17-T18 | Viewer `SHAREHOLDER` mở báo cáo tháng | Chỉ giá vốn thực tế; không tên NCC; khách chỉ số tổng hợp | integration | CP12 | missing | — |
| TEST-PUB-001 | SPEC §17-T19 | Master phát hành lại báo cáo tháng | v2 thay v1; viewer thấy lịch sử phiên bản | integration | CP12 | missing | — |
| TEST-INV-001 | SPEC §17-T20 | Kiểm kê: nho hao 2,1% với định mức 3% | Tự duyệt "hao hụt tự nhiên" | unit, integration | CP06 | missing | — |
| TEST-INV-002 | SPEC §17-T21 | Kiểm kê: cherry hao 9% | Cần giải trình + duyệt | integration | CP06 | missing | — |
| TEST-INV-003 | SPEC §17-T22 | Phiếu hủy 2.000.000đ, cửa hàng trưởng hạn mức 1.000.000đ | Chờ Master duyệt | integration | CP06 | missing | — |
| TEST-RPT-002 | SPEC §17-T23 | Lô bán khi chưa có giá nhập | Báo cáo lãi gộp cảnh báo "thiếu giá nhập"; Master nhập giá → cập nhật | integration | CP10 | missing | — |
| TEST-CUST-001 | SPEC §17-T24 | Khách xóa tài khoản | Ẩn danh SĐT/địa chỉ; đơn vẫn trong báo cáo | integration | CP14 | missing | — |
| TEST-DLV-002 | SPEC §17-T25 | Shipper nợ COD vượt hạn mức | Không nhận được chuyến mới | integration | CP15 | missing | — |
| TEST-CAT-001 | SPEC §21.7-T26 | Bán 2 hộp nho 500 g và 0,73 kg nho rời cùng SKU | Tồn SKU giảm 1.730 g; báo cáo bán theo đơn vị đúng | unit, integration | CP07 | missing | — |
| TEST-PUR-001 | SPEC §21.7-T27 | Nhận 3 thùng nho "danh nghĩa 5 kg", cân tịnh 14,62 kg | Tồn +14.620 g, không cộng 15 kg | integration | CP05 | missing | — |
| TEST-INV-004 | SPEC §21.7-T28 | Hủy phiếu kiểm kho đã hoàn thành | Sinh bút toán đảo; tồn về như trước khi kiểm; phiếu "Đã hủy" | integration | CP06 | missing | — |
| TEST-PUR-002 | SPEC §21.7-T29 | Hủy phiếu nhận hàng mà lô đã bán một phần | Bị chặn; gợi ý điều chỉnh | integration | CP05 | missing | — |
| TEST-INV-005 | SPEC §21.7-T30 | Đang kiểm kho bấm "Hủy ngay" 0,4 kg dập | Sinh phiếu hủy nháp liên kết; 0,4 kg không tính vào hao hụt | integration | CP06 | missing | — |
| TEST-PUR-003 | SPEC §21.7-T31 | Trả NCC 20% lô có chi phí xe 500.000đ | Gợi ý chi phí nhập hoàn lại 100.000đ; sửa được | unit, integration | CP05 | missing | — |
| TEST-INV-006 | SPEC §21.7-T32 | Lô qua `stop_sell_app_date` | Không phân bổ cho đơn app/sỉ; vẫn bán tại quầy | integration | CP14 | missing | — |
| TEST-POS-005 | SPEC §21.7-T33 | Quét tem nhúng giá `21…` khi giá/kg đã đổi | Tiền dòng = giá tem; POS cảnh báo "tem giá cũ" | unit | CP07 | missing | — |
| TEST-POS-006 | SPEC §21.7-T34 | Nhân viên B quét thẻ đổi người bán giữa ca của A | Hóa đơn sau ghi B; ca vẫn của A | integration | CP09 | missing | — |
| TEST-POS-007 | SPEC §21.7-T35 | Đóng ca chênh 50.000đ (ngưỡng 20.000đ) | Khóa đóng ca đến khi cửa hàng trưởng duyệt + lý do | integration | CP08 | missing | — |
| TEST-PAY-003 | SPEC §21.7-T36 | Đối chiếu QR khi đóng ca | Số thực tế QR tự lấy từ SePay, khớp hệ thống | integration | CP08 | missing | — |
| TEST-POS-008 | SPEC §21.7-T37 | Khách đổi 0,5 kg cam lấy 0,6 kg quýt trong 1 màn hình | Tính đúng chênh lệch; cam trả mặc định ghi hủy | unit, integration | CP09 | missing | — |
| TEST-APPORD-004 | SPEC §21.7-T38 | Tạo đơn đặt qua điện thoại, giữ 2 kg xoài | Tồn khả dụng giảm 2 kg; đơn vào hàng đợi soạn (NC-12: đơn PHONE giữ đúng số nhân viên nhập; hệ số giữ tồn là cấu hình) | integration | CP14 | missing | — |
| TEST-CORE-001 | SPEC §21.7-T39 | Cố sửa ngày hóa đơn về hôm qua | Không có chức năng; API từ chối | integration | CP08 | missing | — |
| TEST-CAT-002 | SPEC §21.7-T40 | Nhập Excel 200 SKU, 3 dòng trùng mã vạch, chọn "bỏ qua" | 197 dòng nhập, báo cáo 3 dòng bị bỏ | integration | CP04 | missing | — |
| TEST-CAT-003 | SPEC §21.7-T41 | Giỏ quà cần 3 táo/giỏ, còn 10 táo; thành phần khác dư | ATP giỏ = 3, báo "nút cổ chai: táo" | unit | CP13 | missing | — |

Tổng: 41 TEST-ID (25 từ §17, 16 từ §21.7).

## 2b. TEST-ID kỹ thuật (CP02, CP03)

| TEST-ID | Nguồn | Kiểm | Lệnh | Trạng thái | Bằng chứng |
|---|---|---|---|---|---|
| TEST-MW-001 | Phụ lục A, FR-INV-03 | Vector tiền/cân chung (114.950đ, 270.400đ, 55.665đ, T10/T11/T14, biên HALF_UP, từ chối âm/số thực, codec wire) — bản TS | `pnpm --filter @fruit/money_weight run test` | covered | 50 test, exit 0 (2026-11-18, checkout sạch) |
| TEST-MW-002 | Phụ lục A, FR-INV-03 | Cùng file vector — bản Dart | cwd `packages/money_weight/dart`: `dart test` | covered | 49 test, exit 0 (2026-11-18, checkout sạch) |
| TEST-INFRA-001 | §3.6, FR-INV-17 | /v1/health 200 khi DB+Redis sống; 503 DEPENDENCY_UNAVAILABLE khi Redis chết; thiếu env → dừng | `pnpm --filter @fruit/api run test` (Testcontainers) | covered | 7 test (gồm đồng thời, X-Request-Id, DB chết), exit 0; kiểm thêm qua docker compose |
| TEST-INFRA-002 | ADR-011, FR-INV-05/11 | Bootstrap DB: extension, schema, 5 role không BYPASSRLS, viewer_ro không vào core, không role nào CREATE, bảng reporting mới không tự mở cho viewer, raise_immutable chặn UPDATE/DELETE, idempotent, chặn file đã áp bị sửa, thiếu mật khẩu → dừng | `pnpm --filter @fruit/api run test` | covered | 18 test trên PostGIS thật (thêm: extension/USAGE public, CONNECT/TEMP, không default cho projector, function mới không EXECUTE, SCRAM, idempotent thật, checkAppendOnlyPrivileges, mật khẩu mẫu), exit 0 |
| TEST-CODEGEN-001 | ADR-017 | Client TS: VndAmount là string, /health có kiểu chi tiết, gọi được | `pnpm --filter @fruit/api_client_ts run test` + typecheck | covered | 4 test, exit 0 |
| TEST-CODEGEN-002 | ADR-017 | Client Dart: VndAmount là String, HealthStatus.fromJson, ErrorCode đủ | cwd `packages/shared_models`: `dart test` | covered | 3 test, exit 0 |
| TEST-DEV-001 | ADR-008 | libserialport nạp được trên Windows thật, liệt kê cổng COM | cwd `apps/staff_app`: `flutter test integration_test -d windows` | covered (spike) | exit 0; máy dev 0 cổng COM — đọc cân thật ở CP07 |
| TEST-DB-001 | ADR-011/020, §2.2–2.3, §2.5, §10.3, FR-INV-05/10/18 | Migration nền CP03 (0001_foundation + 001_extension_privileges): thứ tự áp + idempotent; **Prisma schema khớp DB** (`migrate diff --exit-code`); quyền app_rw theo bảng (không DELETE trừ bảng tạm, không sửa mã quyền); audit.* chỉ-thêm (cả owner, cả TRUNCATE); outbox UPDATE theo cột; processed_events idempotent; viewer_ro chỉ EXECUTE 2 hàm; RLS khung lọc đúng cửa hàng / hồ sơ toàn chuỗi / hồ sơ lưu trữ / thiếu hồ sơ; `checkViewerRls` bắt bảng quên FORCE; seed mã quyền phủ mọi `x-permission` của OpenAPI; ma trận vai trò; hạn mức §2.3; ràng buộc vai trò–loại người dùng–phạm vi; người dùng/SĐT mã hóa; vòng đời thiết bị POS; hạn thử thách | `pnpm --filter @fruit/api run test` | covered | 31 test trên PostGIS thật, exit 0 (2026-11-24, sau sửa kiểm thử agent lần 1–3 — lần 3 thêm: tranh chấp tạo phiên ↔ thu hồi thiết bị (FOR SHARE), SET không rò giữa migration; lần 2 thêm: thu hồi thiết bị đóng phiên, token cùng phiên, mốc thu hồi do server đặt, lọc transaction không bị lách bằng comment/chuỗi + chốt lúc chạy; users.type bất biến, thu hồi là kết thúc, UPDATE theo cột + `checkNoKeyUpdate`, phiên/thiết bị/refresh token, loại người dùng ở quyền riêng/hồ sơ viewer/staff, bộ chạy chặn sai thứ tự/mục lạ/trùng số/COMMIT, database khác, large object, thời điểm do server đặt); test phát hiện và đã đóng: viewer_ro SELECT được bảng `topology`/`tiger`/PostGIS ở `public` (image tạo sẵn) |
| TEST-API-001 | ADR-007/016, §13.1, FR-INV-10/18 | Khung request CP03 lát 2: mutation = 1 transaction (nghiệp vụ + audit + outbox cùng commit; lỗi sau khi ghi ⇒ rollback toàn phần); mutation thiếu audit ⇒ 500 + rollback; `@NoAudit` phải có lý do; recordAudit/emitEvent ngoài transaction ⇒ lỗi; deny-by-default (route thiếu khai báo ⇒ app không khởi động; 401/403); envelope lỗi chuẩn + 404 + 500 không lộ chi tiết; zod strict; bigint → chuỗi (codec); bí mật trong audit/outbox bị che; CLS tách ngữ cảnh khi chạy song song; quyền route khớp `x-permission`; bảng mã lỗi khớp OpenAPI | `pnpm --filter @fruit/api run test` | covered | 21 test (`request-framework.test.ts`, PostgreSQL + Redis thật) + 2 test (`route-access.test.ts`) + 2 test (`db-down.test.ts`: dừng container DB thật ⇒ 503), exit 0 (2026-11-25, sau sửa kiểm thử agent lần 1–3; lần 2: PII số nhiều/tiếng Việt/địa chỉ mặc định che, lỗi Node không bị coi là lỗi DB, SQL thô cần transaction, method không nới lỏng hơn class; lần 1: che bí mật theo token, sự kiện có khóa nhạy cảm ⇒ lỗi, route kế thừa/@Public trong controller cần quyền ⇒ không khởi động, lỗi parser/413/URI có request_id, lỗi DB → 404/409/400/503, chặn ghi DB ngoài transaction, lỗi lúc COMMIT/tuần tự hóa ⇒ rollback) |
| TEST-AUTH-001 | SPEC §2.4 SEC1/SEC2/SEC4/SEC5, ADR-012/015/021 | Auth Master/Viewer CP03 lát 3: chưa đăng ký 2FA chỉ gọi route đăng ký (403 `TWO_FACTOR_ENROLLMENT_REQUIRED`); mật khẩu đúng thôi không ra phiên khi đã bật 2FA; mfa_challenge 5 phút/1 lần/5 lần thử; mã TOTP không dùng lại được; 10 mã khôi phục Argon2id dùng 1 lần; secret TOTP mã hóa AES-GCM (AAD theo dòng); 5 lần sai (mật khẩu + mã) ⇒ khóa 15 phút tăng dần, đang khóa chặn cả mật khẩu đúng, song song không mất lần đếm; refresh xoay vòng, dùng lại ⇒ thu hồi cả họ (cả khi song song); trần phiên 7 ngày; step-up thiếu/hết hạn ⇒ `STEP_UP_REQUIRED`; logout/thu hồi phiên có hiệu lực ngay, không thu hồi phiên người khác; Master khóa tài khoản ⇒ phiên chết; JWT sai chữ ký/kid/alg none/hết hạn ⇒ 401, xoay khóa; khóa cấu hình thiếu/sai ⇒ không khởi động; login_logs HMAC không email rõ; sự kiện thiết bị mới; response khớp OpenAPI | `pnpm --filter @fruit/api run test` | covered | 25 test (`auth.test.ts`, PostgreSQL + Redis thật), toàn bộ API 104/104 (chạy 3 lần), exit 0 (2026-11-25, sau sửa kiểm thử agent lần 2: bão 429 không rò bộ đếm, bất biến lần sai = bộ đếm + 5×lần khóa; lần 1: đợt 40 sai song song ≤ 5 lần kiểm, tài khoản chưa 2FA không ra phiên khi đã khóa, step-up/verify song song ≤ 5, setup chạy đua confirm không ghi đè secret, login 401 chung khi khóa, no-store) |

## 3. TEST-ID đã đặt tên trong KẾ HOẠCH, định nghĩa chi tiết khi mở CP

| TEST-ID | CP | Ghi chú |
|---|---|---|
| TEST-VIEWER-COST-001 | CP12 | Viewer chỉ thấy giá vốn trong snapshot đã phát hành (D14) |
| TEST-MARKDOWN-001 | CP17 | Giảm giá cận hạn có kiểm soát (§5.8) |
| TEST-PROCESS-001 | CP17 | Sơ chế (§5.11) |
| TEST-BUNDLE-001 | CP17 | Giỏ quà (§5.11, §18.6) |

## 4. Bằng chứng hợp đồng (contracts)

Chưa áp dụng — `packages/contracts/openapi.yaml` tạo ở CP01.
