# KẾ HOẠCH TRIỂN KHAI THEO CHECKPOINT — HỆ THỐNG CHUỖI BÁN LẺ HOA QUẢ

> **Căn cứ:** `DAC_TA_HE_THONG_HOA_QUA_v3.md` (v3.2) — gọi tắt là **SPEC**. Mọi mục `§x` trong tài liệu này là mục của SPEC.
> **Quy trình làm việc:** theo bộ `.claude/` trong thư mục dự án (rules, skills, agents) — xem `PROMPT_KHOI_DONG.md`.
> **Nguyên tắc:** chia theo **checkpoint (CP)**, không theo tuần. Một CP chỉ được đánh dấu **ĐẠT** khi toàn bộ tiêu chí cổng (gate) có bằng chứng chạy thật (lệnh, thư mục chạy, exit code). Không có ngày bắt đầu/kết thúc cố định; CP sau chỉ mở khi CP tiên quyết đã ĐẠT.

---

## 0. Cách đọc kế hoạch

### 0.1. Cấu trúc mỗi checkpoint

| Mục | Ý nghĩa |
|---|---|
| **Mục tiêu** | Kết quả kinh doanh/kỹ thuật cần có sau CP |
| **Tiên quyết** | CP phải ĐẠT trước + việc bên ngoài cần xong (tài khoản, thiết bị) |
| **Phạm vi SPEC** | Các mục SPEC được hiện thực trong CP |
| **Công việc** | Danh sách việc theo thứ tự làm |
| **Đầu ra** | File, module, màn hình, tài liệu phải tồn tại |
| **Cổng ĐẠT** | Điều kiện bắt buộc để đóng CP — kèm TEST-ID (§17, §21.7) |
| **Review** | Agent review (read-only) phải chạy trên thay đổi của CP |
| **Việc của chủ dự án** | Việc chỉ Tiến làm được (quyết định, dữ liệu thật, tài khoản, thiết bị) |
| **Rủi ro / dừng lại khi** | Điều kiện phải dừng và hỏi |

### 0.2. Trạng thái checkpoint

`CHƯA MỞ` → `ĐANG LÀM` → `CHỜ REVIEW` → `ĐẠT` (hoặc `CHẶN` kèm lý do + người gỡ). Trạng thái chỉ ghi ở tracker `docs/engineering/execution/STATUS.md` (một người ghi duy nhất: phiên điều phối).

### 0.3. Cổng chung áp dụng cho MỌI checkpoint có code

1. **Build + typecheck + lint** sạch cho các app/package bị chạm (lệnh lấy từ `docs/engineering/execution/command-catalog.md`).
2. **Test viết trước** (TDD) cho logic tiền, cân, tồn kho, trạng thái, quyền; test DB chạy trên **PostgreSQL thật** (Docker), không SQLite/in-memory.
3. **TESTS.md** cập nhật: TEST-ID của CP có trạng thái `covered` kèm lệnh + exit code; không được `covered` nếu chỉ có file test mà chưa chạy.
4. **REGRESSION.md**: chạy lệnh nghiệm thu của module bị đổi + mọi module hạ nguồn; tất cả exit code = 0.
5. **Review**: `code-reviewer` + reviewer theo ngôn ngữ (`typescript-reviewer` / `flutter-reviewer` / `react-reviewer`) + reviewer chuyên đề của CP. Reviewer chỉ trả findings; tác giả sửa; mức CRITICAL/HIGH phải đóng.
6. **Verification report** theo skill `verification-loop` lưu vào `docs/engineering/execution/checkpoints/CPxx.md`.
7. **Đối chiếu tác động** (skill `change-impact`): phạm vi diff thực tế ≤ phạm vi khai báo; phần vượt phải được ghi và duyệt.
8. Không còn `TODO`, stub, mock hay "success giả" trong đường chạy production của phạm vi CP.

---

## 1. Sơ đồ phụ thuộc

```
CP00 Chuẩn hóa quy trình
  └─ CP01 Quyết định kiến trúc & hợp đồng
       └─ CP02 Khung dự án & hạ tầng
            └─ CP03 Nền tảng: auth, quyền, audit, outbox, file
                 ├─ CP04 Danh mục & đơn vị tính
                 │    └─ CP05 Mua hàng & lô
                 │         └─ CP06 Sổ kho: điều chuyển, kiểm kê, hủy, dùng nội bộ
                 │              └─ CP07 POS lõi: bán, cân, tem cân, in
                 │                   └─ CP08 POS thanh toán SePay, ca, đóng ngày
                 │                        └─ CP09 POS offline, đổi–trả, nhiều nhân viên, sổ quỹ
                 │                             └─ CP10 Báo cáo realtime & trang Master  ◄─ (cần CP06)
                 │                                  └─ CP11 ★ PILOT cửa hàng 1 (go-live)
                 │                                       ├─ CP12 Admin Chỉ Xem & phát hành báo cáo
                 │                                       ├─ CP13 Vùng giao, mặt hàng đẩy, thông báo
                 │                                       │    └─ CP14 App người dùng & đơn app
                 │                                       │         └─ CP15 Giao hàng: shipper, Ahamove, COD
                 │                                       ├─ CP16 Đơn bán sỉ & công nợ
                 │                                       └─ CP17 Độ chín, giảm giá lô, sơ chế, giỏ quà
                 │                                            └─ CP18 Đặt hàng nhập & bổ sung hàng
                 └──────────────────────────────────────────────── CP19 Gia cố & mở rộng toàn chuỗi
```

**Có thể làm song song** (khi đủ tiên quyết): CP12 ‖ CP13 ‖ CP16 ‖ CP17 sau CP11. Thứ tự ưu tiên mặc định: CP12 → CP13 → CP14 → CP15 → CP16 → CP17 → CP18 (đổi được theo ưu tiên kinh doanh, ghi vào tracker).

### Việc bên ngoài làm song song từ CP00 (§19.10)

| Việc | Cần trước |
|---|---|
| Tài khoản BIDV doanh nghiệp + đăng ký SePay (API token, webhook) | CP08 |
| Mua mẫu thiết bị: cân quầy, cân in tem, máy in 80 mm, máy in tem, máy quét 2D, tablet | CP07 |
| Đăng ký Ahamove (form tích hợp → API key STG) | CP15 |
| Google Play Console + bundle ID mới, Firebase (FCM) | CP13 |
| Nhà cung cấp OTP (SMS brandname / Zalo ZNS) | CP03 (OTP khách) — có thể dùng TEST_DOUBLE đến CP14 |
| API key bản đồ (Goong/Google) | CP13 |
| VPS + object storage ở nhà cung cấp khác (backup) | CP02 |
| Dữ liệu thật: bảng SKU + giá, NCC, cửa hàng, nhân viên, khách sỉ | CP04 / CP11 |

---

## 2. Chi tiết từng checkpoint

### CP00 — Chuẩn hóa quy trình `.claude` cho dự án hoa quả

**Mục tiêu:** bộ `.claude` (mang từ dự án F2C) được chuyển thành quy tắc của dự án hoa quả; tracker và các tài liệu sống được khởi tạo.

**Tiên quyết:** không.

**Phạm vi SPEC:** toàn bộ (đọc), §1, §19.5, §19.9.

**Công việc:**
1. Kiểm kê `.claude/`: rule nào là của F2C (`f2c-engineering.md`, `f2c-marketplace-invariants.md`, `f2c-ui-ux.md`, các `references/f2c-integration.md`, override F2C trong `agents/e2e-runner.md`), rule nào dùng chung (`ecc-guardrails.md`, `node.md` cho tooling).
2. Đề xuất bản thay thế (trình Tiến duyệt trước khi ghi):
   - `.claude/rules/fruit-engineering.md` (paths `apps/**`, `packages/**`, `docs/engineering/**`) — stack, quy ước tên, bắt buộc khi viết mã, điều phối.
   - `.claude/rules/fruit-retail-invariants.md` — bất biến nghiệp vụ hoa quả (FR-INV, xem PROMPT §4).
   - `.claude/rules/fruit-ui-ux.md` — định tuyến skill thiết kế cho `apps/customer_app`, `apps/staff_app`, `apps/admin-web`.
   - `references/fruit-integration.md` cho 5 skill UI (`ui-ux-pro-max`, `design-system`, `ui-styling`, `brand`, `banner-design`).
   - Sửa đoạn override trong `agents/e2e-runner.md` cho đúng tên app hoa quả.
3. Vô hiệu hóa rule F2C: chuyển 3 file `f2c-*.md` vào `.claude/_archive_f2c/` (không xóa).
4. Tạo cấu trúc tài liệu:
   ```
   docs/specs/DAC_TA_HE_THONG_HOA_QUA_v3.md      (bản sao SPEC + ghi sha256 vào SPEC-LOCK.md)
   docs/specs/SPEC-LOCK.md                      (sha256, phiên bản, ngày, ai chốt)
   docs/engineering/execution/STATUS.md         (tracker CP — 1 người ghi)
   docs/engineering/execution/LOG.md            (nhật ký sự kiện, chỉ thêm)
   docs/engineering/execution/checkpoints/      (CPxx.md: bằng chứng từng CP)
   docs/engineering/decisions/                  (ADR)
   CONTEXT.md                                   (thuật ngữ từ §1.5 — skill context-and-decisions)
   TESTS.md                                     (sổ TEST-ID — skill test-collaboration; nạp T01–T41)
   REGRESSION.md                                (sổ hồi quy — skill module-regression; tạo khung, điền dần)
   CLAUDE.md                                    (bản đồ dự án: trỏ tới các file trên)
   ```
5. Nạp **T01–T25 (§17)** và **T26–T41 (§21.7)** vào `TESTS.md` với trạng thái `missing`, gắn nguồn §.
6. Khởi tạo `git` repo, nhánh `main`/`develop`, commit đầu tiên kiểu Conventional Commits.

**Đầu ra:** các file trên; `.claude/rules/` không còn rule F2C hoạt động.

**Cổng ĐẠT:**
- [ ] Tiến đã duyệt nội dung 3 rule mới.
- [ ] Không còn rule nào trong `.claude/rules/` nhắc tới F2C/marketplace/buyer/factory/hub (kiểm bằng `grep -ri "f2c\|marketplace" .claude/rules`).
- [ ] `SPEC-LOCK.md` có sha256 khớp file SPEC.
- [ ] `TESTS.md` có đủ 41 TEST-ID; `CONTEXT.md` có đủ thuật ngữ §1.5.

**Review:** `doc-updater` (rà nhất quán tài liệu), `architect` (rà rule mới).

**Việc của chủ dự án:** duyệt 3 rule mới; xác nhận §7.6 (định nghĩa "đăng ký điểm bán") hoặc ghi "hoãn".

**Dừng lại khi:** rule F2C xung đột với SPEC mà không rõ bên nào đúng → hỏi Tiến (SPEC thắng mặc định).

---

### CP01 — Quyết định kiến trúc & hợp đồng

**Mục tiêu:** mọi quyết định khó đảo ngược được ghi ADR; hợp đồng API/sự kiện và sơ đồ dữ liệu là nguồn duy nhất trước khi code.

**Tiên quyết:** CP00 ĐẠT.

**Phạm vi SPEC:** §3, §12, §13, §19.1–19.6, §21.8.

**Công việc:**
1. ADR (skill `context-and-decisions` → ADR), tối thiểu:
   - ADR-001 Monorepo & package manager (đề xuất **pnpm workspace** cho JS/TS; Flutter dùng pub) — lưu ý `.claude/package-manager.json` là của ECC.
   - ADR-002 Modular monolith NestJS; worker là entry riêng (`apps/api` 2 entry theo §19.1, hoặc `apps/worker` — chọn 1).
   - ADR-003 ORM: Prisma + migration SQL thủ công cho PostGIS/trigger/RLS/role (§19.2) — hoặc phương án khác có lý do.
   - ADR-004 Tiền `BIGINT`/`bigint`, khối lượng gram `INTEGER`, API truyền tiền dạng chuỗi số nguyên; công thức `round_half_up(price_per_kg × g / 1000)` (§4.4, Phụ lục A).
   - ADR-005 Sổ kho chỉ-thêm + giá vốn theo lô (§5.1, §5.12, §21.4).
   - ADR-006 Tách schema `core/reporting/audit/integration` + 4 role DB + RLS cho viewer (§2.5, §3.3, §12.4).
   - ADR-007 Outbox + consumer idempotent (§3.2).
   - ADR-008 POS Flutter Windows + SQLite (drift) offline, `client_txn_id` UUID v7 (§6.12).
   - ADR-009 SePay VA theo đơn (BIDV DN) (§13.4, §18.3).
   - ADR-010 Phiên bản công cụ: Node LTS, NestJS, Next.js, Flutter, PostgreSQL+PostGIS, Redis — ghi vào `docs/engineering/architecture/versions.json`.
2. Hợp đồng: `packages/contracts/openapi.yaml` (khung toàn bộ route §13.2 + §21) và `packages/contracts/events/*.json` (§13.3) — **nguồn duy nhất**, client TS/Dart sinh từ đây.
3. Sơ đồ dữ liệu: ERD từ §12.2–12.3 + §21.8; danh sách migration theo thứ tự (chưa chạy).
4. Danh sách mã lỗi (§13.1) + mã quyền (§19.6 + §21.8) dưới dạng enum trong hợp đồng.
5. Máy trạng thái: đơn app (§8.3), đơn sỉ (§9.2), điều chuyển (§5.10), chứng từ chung (§21.3.2), mặt hàng đẩy (§7.3) — bảng chuyển hợp lệ dạng dữ liệu.
6. UX: danh sách màn hình (U01–U14 §7.2, POS §6, tablet, Admin §10.1–10.2) + hành động từng màn và nhánh lỗi (mất mạng, hết hàng, thanh toán chờ, mất quyền).

**Đầu ra:** `docs/engineering/decisions/ADR-0xx-*.md`, `versions.json`, `packages/contracts/**`, `docs/engineering/data/ERD.md`, `docs/engineering/ux/screens.md`.

**Cổng ĐẠT:**
- [ ] 10 ADR trạng thái `accepted` (Tiến duyệt các ADR 001, 002, 003, 008).
- [ ] `openapi.yaml` hợp lệ (lint bằng công cụ chọn trong ADR, exit 0).
- [ ] Mọi route §13.2 có `x-permission` và mã lỗi; mọi bảng §12 có trong ERD.
- [ ] Máy trạng thái có bảng chuyển + test vector (chưa cần code).

**Review:** `architect`, `database-reviewer` (ERD, index, RLS), `security-reviewer` (auth, viewer isolation), `planner` (độ đủ của kế hoạch CP02+).

**Việc của chủ dự án:** duyệt ADR then chốt.

**Dừng lại khi:** phát hiện mâu thuẫn trong SPEC (ví dụ giữa §19.1 và rule) → ghi `needs confirmation` trong CONTEXT.md và hỏi.

---

### CP02 — Khung dự án & hạ tầng

**Mục tiêu:** monorepo chạy được ở local và staging; CI xanh; backup PostgreSQL hoạt động và khôi phục được.

**Tiên quyết:** CP01 ĐẠT; có VPS + object storage khác nhà cung cấp.

**Phạm vi SPEC:** §3.6, §15, §19.1–19.4.

**Công việc:**
1. Tạo cấu trúc §19.1: `apps/api`, `apps/admin-web`, `apps/customer_app`, `apps/staff_app`, `packages/contracts`, `packages/shared_models` (Dart, sinh), `packages/api_client_ts` (sinh), `packages/money_weight` (Dart + TS + bộ test vector chung), `infra/`.
2. Lockfile thật (`pnpm-lock.yaml`, `pubspec.lock`), phiên bản theo `versions.json`.
3. `infra/docker-compose.yml` (postgis, redis, api, worker, admin-web, caddy) + `.env.example` đủ biến §19.4 (không chứa secret thật).
4. Migration nền: tạo 4 schema, 4 role DB, extension PostGIS/pgcrypto/unaccent/pg_trgm, hàm `raise_immutable()`.
5. CI: lint + typecheck + test + build cho TS và Flutter (analyze + test).
6. `docs/engineering/execution/command-catalog.md`: lệnh thật cho từng app (cwd, shell, lệnh, ý nghĩa).
7. Staging trên VPS; backup WAL liên tục + full hằng ngày ra object storage khác; **diễn tập khôi phục** về một thời điểm.
8. Giám sát: Sentry (backend, Flutter, Next.js), uptime ngoài, cảnh báo Telegram.
9. `packages/money_weight`: hàm `lineAmount`, `formatVnd`, `formatKg` + test vector Phụ lục A chạy ở **cả Dart và TS**.

**Đầu ra:** repo khởi động được bằng 1 lệnh; staging có HTTPS; `command-catalog.md`.

**Cổng ĐẠT:**
- [ ] `docker compose up` local → health check API 200.
- [ ] CI xanh trên `develop`.
- [ ] Test vector tiền/cân (114.950đ, 270.400đ, 55.665đ…) xanh ở Dart và TS.
- [ ] Biên bản diễn tập khôi phục backup (thời điểm, lệnh, kết quả) trong `checkpoints/CP02.md`.
- [ ] Không có secret trong repo (quét theo `verification-loop` Phase 5).

**Review:** `security-reviewer` (secret, cấu hình Caddy/CORS), `database-reviewer` (role, extension), `code-reviewer`.

**Việc của chủ dự án:** cấp VPS, domain, object storage.

---

### CP03 — Nền tảng: xác thực, phân quyền, nhật ký, outbox, file

**Mục tiêu:** đăng nhập cho 3 loại người dùng, phân quyền deny-by-default, viewer bị cô lập ở DB, mọi thao tác ghi có audit + outbox.

**Tiên quyết:** CP02 ĐẠT.

**Phạm vi SPEC:** §2 (toàn bộ), §3.2–3.5, §14 (nhật ký), §19.6, §21.3.9 (thẻ nhân viên — phần dữ liệu).

**Công việc:**
1. Auth Master/Viewer: mật khẩu Argon2id + **2FA TOTP bắt buộc** + mã khôi phục; step-up 5 phút (SEC1–SEC2).
2. Auth nhân viên POS: mã NV + PIN 6 số; **kích hoạt thiết bị POS** (SEC3); thẻ nhân viên (`staff_badges`, lưu hash).
3. Auth khách: OTP qua `OtpProvider` (TEST_DOUBLE có nhãn ở dev/staging) + rate limit (SEC6).
4. Token: access 15 phút, refresh xoay vòng, thu hồi theo thiết bị (SEC4); khóa tạm sau 5 lần sai (SEC5).
5. RBAC: `@RequirePermission`, phạm vi cửa hàng, hạn mức duyệt (§2.3) dạng dữ liệu seed.
6. Viewer: module `/v1/viewer/*` dùng pool `viewer_ro`; mọi route khác 403 (§2.5 lớp 2–3); khung RLS (§2.5 lớp 4).
7. Audit interceptor ghi `audit.logs` (trước/sau); outbox + worker relay + `processed_events`.
8. File: presigned upload, `files` có sha256, kiểm tra ảnh trùng hash.
9. Admin web: đăng nhập + 2FA, quản lý nhân viên/vai trò/phạm vi, kích hoạt thiết bị, danh sách phiên.
10. Staff app: chọn chế độ (quầy/tablet/shipper), đăng nhập PIN, khóa màn hình.

**Cổng ĐẠT:**
- [ ] **T16** (viewer gọi `/admin/*` → 403), **T17** (`viewer_ro` đọc `core` → permission denied) `covered`.
- [ ] Test: thiếu 2FA không vào được Master; step-up hết hạn → `STEP_UP_REQUIRED`; refresh token cũ bị dùng lại → thu hồi chuỗi.
- [ ] Test: route không khai báo permission → bị chặn (deny-by-default).
- [ ] Mọi mutation trong CP có dòng audit + outbox cùng transaction (test).

**Review:** `security-reviewer` (bắt buộc), `silent-failure-hunter`, `typescript-reviewer`, `flutter-reviewer`, `react-reviewer`.

**Việc của chủ dự án:** cung cấp danh sách nhân viên & vai trò ban đầu.

---

### CP04 — Danh mục, đơn vị tính, giá

**Mục tiêu:** Master quản lý được toàn bộ danh mục hàng; một SKU bán được nhiều đơn vị dùng chung tồn; xuất được file PLU.

**Tiên quyết:** CP03 ĐẠT.

**Phạm vi SPEC:** §4 (toàn bộ), §21.3.1 (đơn vị tính), §21.3.17 (nhập Excel danh mục), §21.3.19 (vị trí mặc định), §18.5 (thương hiệu).

**Công việc:**
1. Category / Product / SKU / `sku_units` / `units`; kiểu bán (§4.2); thuộc tính SKU (§4.3).
2. Giá lẻ theo SKU & theo cửa hàng (`store_prices`), lịch sử giá (`price_change_logs`).
3. NCC (§4.5), cửa hàng/kho/vị trí/quầy/thiết bị (§4.6), `sku_default_locations`.
4. Nhập Excel danh mục có **dry-run** + chọn xử lý trùng (bỏ qua/cập nhật/dừng); xuất Excel.
5. Xuất **file PLU** cho cân in tem (quyền `plu:export`, ghi log).
6. `brand_settings`; in tem giá kệ hàng loạt.
7. Seed: loại thùng/sọt + bì chuẩn; mã lý do (Phụ lục D).

**Cổng ĐẠT:**
- [ ] **T40** (nhập 200 SKU, 3 trùng, bỏ qua) `covered`.
- [ ] Test: đổi giá chỉ áp cho giao dịch mới; lịch sử giá đủ người/thời điểm.
- [ ] Test quy đổi đơn vị: hộp 500 g → 500 g tồn; thùng danh nghĩa không quy đổi cứng.
- [ ] Nạp được danh mục thật của Tiến (≥ 20 SKU) trên staging.

**Review:** `database-reviewer`, `typescript-reviewer`, `react-reviewer`.

**Việc của chủ dự án:** bảng SKU + giá lẻ + PLU hiện tại; logo, tên thương hiệu, hotline.

---

### CP05 — Mua hàng (nhận hàng NCC) & lô

**Mục tiêu:** kho tổng nhận hàng có cân/bì/QC/ảnh, tạo lô có giá nhập + chi phí nhập phân bổ; trả hàng NCC.

**Tiên quyết:** CP04 ĐẠT; có 1 cân bàn nhập kho (hoặc nhập số từ cân) + tablet.

**Phạm vi SPEC:** §5.3, §5.4, §5.5 (lô, FEFO dữ liệu), §21.3.5 (chi phí nhập mở rộng), §21.3.7 (mốc ngày lô), §21.3.2 (vòng đời chứng từ cho phiếu nhận/trả).

**Công việc:**
1. Phiếu nhận hàng trên tablet: số thùng, cả bì, bì/thùng, tịnh, đếm quả, cân mẫu, QC (độ chín, Brix, dập), ảnh, kết quả QC.
2. Tạo lô `B{yyMMdd}-{số}`, in **tem lô QR**; 3 mốc ngày (`alert_date`, `stop_sell_app_date`, `expiry_date`).
3. Giá nhập: người có quyền nhập trên tablet, hoặc lô `PENDING_COST` → Master nhập trên web.
4. Chi phí nhập: `landed_cost_types`, 5 cách phân bổ, phân loại trả NCC/trả bên khác; phân bổ chi phí đến muộn.
5. Trả hàng NCC + **chi phí nhập hoàn lại** gợi ý theo tỷ lệ.
6. (Tùy chọn) công nợ NCC.
7. Vòng đời Phiếu tạm → Hoàn thành → Hủy (đảo).

**Cổng ĐẠT:**
- [ ] **T27** (3 thùng "5 kg" cân 14,62 kg → +14.620 g), **T29** (không hủy phiếu nhận khi lô đã bán), **T31** (chi phí hoàn lại 100.000đ) `covered`.
- [ ] Test phân bổ: tổng phân bổ = đúng tổng chi phí (phần dư xử lý nhất quán).
- [ ] Test sửa giá nhập lô đã bán → cần Master + step-up + log.

**Review:** `database-reviewer`, `silent-failure-hunter`, `flutter-reviewer`, `typescript-reviewer`.

---

### CP06 — Sổ kho: điều chuyển, kiểm kê, hủy hàng, dùng nội bộ

**Mục tiêu:** sổ kho bất biến chạy đúng; hàng đi từ kho tổng xuống cửa hàng; kiểm kê/hủy/dùng nội bộ có kiểm soát.

**Tiên quyết:** CP05 ĐẠT.

**Phạm vi SPEC:** §5.1, §5.2, §5.5 (FEFO service), §5.7, §5.9, §5.10, §21.3.2–21.3.4, §5.12 (giá vốn).

**Công việc:**
1. `stock_movements` chỉ-thêm (trigger), `stock_balances` cùng transaction, `reversal_of_id`.
2. FEFO service (theo hạn dùng; loại lô quá `stop_sell_app_date` cho đơn app/sỉ).
3. Điều chuyển `DRAFT → PICKING → IN_TRANSIT → RECEIVED → CLOSED`, cân 2 đầu, chênh lệch + ảnh, cảnh báo quá hạn nhận.
4. Kiểm kê: đếm mù, 4 tab Tất cả/Khớp/Lệch/Chưa kiểm, giá trị lệch, **hủy ngay khi kiểm**, phân loại hao hụt trong/ngoài định mức, duyệt theo hạn mức.
5. Hủy hàng: ảnh chụp trực tiếp + watermark + hash; người duyệt ≠ người tạo.
6. Xuất dùng nội bộ.
7. Màn tồn kho trên web (số lượng + giá trị theo lô/vị trí).

**Cổng ĐẠT:**
- [ ] **T20, T21, T22, T28, T30** `covered`.
- [ ] Test đồng thời: 2 giao dịch trừ cùng lô cùng lúc không làm sai tồn (PostgreSQL thật, khóa hàng/optimistic lock).
- [ ] Test: UPDATE/DELETE trên `stock_movements` bị chặn.
- [ ] Tổng phát sinh = tồn (lệnh đối soát chạy được) → đưa vào REGRESSION.md làm lệnh nghiệm thu module kho.

**Review:** `database-reviewer` (khóa, index), `silent-failure-hunter`, `performance-optimizer` (truy vấn tồn).

---

### CP07 — POS lõi: bán hàng, cân, tem cân, in

**Mục tiêu:** thu ngân bán hàng tiền mặt trên Flutter Windows với cân thật, tem cân thật, máy in thật.

**Tiên quyết:** CP06 ĐẠT; **thiết bị mẫu đã có** (cân quầy, cân in tem, máy in 80 mm, két, máy quét 2D, màn hình phụ).

**Phạm vi SPEC:** §6.1, §6.3, §6.4, §6.5, §6.8, §6.9, §6.13, §18.1, §21.3.8 (bảng quy tắc mã vạch), §21.3.14 (mã giao dịch).

**Công việc:**
1. Màn hình bán hàng (nút lớn, phím tắt), thêm hàng cân / tem cân / mã thường / theo quả / giỏ đóng sẵn.
2. `ScaleAdapter` cho model cân thực tế + màn "Kiểm tra cân" (dữ liệu thô); chỉ nhận số ổn định; cảnh báo ngoài khoảng trọng lượng.
3. Nhập cân tay khi cân lỗi: PIN quản lý + lý do, đánh dấu `MANUAL`.
4. `barcode_rules` (W1 mặc định, W2 nhúng giá có cảnh báo tem cũ, tem lô, thẻ NV) + checksum EAN-13.
5. In ESC/POS (font tiếng Việt hoặc in ảnh), QR, cắt giấy, mở két; hàng đợi in, báo lỗi giấy.
6. Màn hình phụ hướng khách (dòng hàng + cân + giá/kg).
7. Mã hóa đơn `CH01-yyMMdd-xxxx`; trừ kho FEFO khi chốt; giảm giá tay theo hạn mức; tem giảm giá lô.
8. Chạy **checklist test thiết bị §18.1** cho từng model.

**Cổng ĐẠT:**
- [ ] **T01, T02, T03, T26, T33** `covered` (T01 phần doanh thu realtime để CP10).
- [ ] Biên bản checklist §18.1 cho từng model thiết bị (ảnh/ghi chú) trong `checkpoints/CP07.md`.
- [ ] Đo: đặt hàng lên cân → dòng xuất hiện ≤ 1,5 giây; quét tem ≤ 0,5 giây (§6.1).

**Review:** `flutter-reviewer`, `performance-optimizer`, `silent-failure-hunter` (lỗi thiết bị không bị nuốt).

**Việc của chủ dự án:** mua thiết bị; cài cân in tem theo mẫu W1; xác nhận mẫu phiếu in.

**Dừng lại khi:** model cân không có tài liệu giao thức → báo, đề xuất đổi model.

---

### CP08 — POS thanh toán SePay, ca, đóng ngày

**Mục tiêu:** thanh toán VietQR tự xác nhận; ca/đóng ca đếm mù, đối chiếu từng phương thức; chốt ngày tạo Z-report.

**Tiên quyết:** CP07 ĐẠT; **SePay + BIDV doanh nghiệp** đã có API token & webhook (staging).

**Phạm vi SPEC:** §6.2, §6.6, §6.7 (hủy hóa đơn), §13.4, §18.3, §21.3.10 (đóng ca theo phương thức), §21.3.13 (khóa sổ, chặn lùi ngày).

**Công việc:**
1. `payments` + tạo VA SePay theo hóa đơn; QR trên màn hình phụ + phiếu.
2. Webhook `/webhooks/sepay`: `webhook_inbox` unique, xác thực, chống replay, xử lý qua queue; giao dịch lạ → `unmatched_bank_txns` + màn khớp tay.
3. Job đối soát mỗi giờ + cuối ngày qua API lịch sử SePay; cảnh báo webhook ngừng.
4. Ca: mở theo mệnh giá, đóng **đếm mù**, đối chiếu tiền mặt / QR (tự lấy từ SePay) / chuyển khoản tay / COD; `max_cash_difference` → khóa đóng ca chờ duyệt.
5. Hủy hóa đơn đã thanh toán theo hạn mức; mở két không bán.
6. Đóng ngày → Z-report bất biến; in báo cáo K80.
7. Ngày giao dịch do máy chủ ghi; không có ô sửa ngày; khóa sổ theo cửa hàng.

**Cổng ĐẠT:**
- [ ] **T05, T06, T35, T36, T39** `covered`.
- [ ] Test webhook đến muộn sau khi đã thu tiền mặt → ghi "thu thừa".
- [ ] Giao dịch thật số tiền nhỏ trên staging với SePay (biên bản).

**Review:** `security-reviewer` (webhook), `silent-failure-hunter`, `database-reviewer`.

---

### CP09 — POS offline, đổi–trả, nhiều nhân viên, sổ quỹ

**Mục tiêu:** quầy bán được khi mất mạng; đổi–trả 1 màn hình; nhiều nhân viên dùng 1 quầy; sổ quỹ tiền mặt + ngân hàng.

**Tiên quyết:** CP08 ĐẠT.

**Phạm vi SPEC:** §6.10, §6.12, §21.3.9, §21.3.11, §21.3.15.

**Công việc:**
1. SQLite (drift): danh mục, giá, quy tắc mã vạch, thẻ NV; hóa đơn offline `CH01-Q1-OFF-…`; `client_txn_id`; đồng bộ theo thứ tự; giới hạn 24 giờ.
2. Cửa hàng tự `PAUSED` cho đơn app khi POS mất kết nối > 2 phút (cờ sẵn cho CP14).
3. Nhiều nhân viên: đổi người bằng thẻ/PIN, khóa màn hình, duyệt tại chỗ bằng thẻ + PIN quản lý.
4. Đổi–trả: hóa đơn gốc, thời hạn trả, phí trả, xử lý hàng trả (lên kệ/hủy/sơ chế), chênh lệch.
5. Sổ quỹ: `cash_accounts`, phiếu thu/chi, nộp tiền, quỹ ngân hàng tự động từ SePay.

**Cổng ĐẠT:**
- [ ] **T04, T34, T37** `covered`.
- [ ] Kịch bản rút mạng giữa giao dịch có VietQR → POS chuyển phương án đúng (§6.6).
- [ ] Hóa đơn offline đồng bộ sau khi đã chốt ngày → báo cáo ngày có phiên bản bổ sung.

**Review:** `flutter-reviewer`, `silent-failure-hunter`, `security-reviewer` (thẻ NV, PIN).

---

### CP10 — Báo cáo realtime & trang quản lý Master

**Mục tiêu:** POS nối vào trang quản lý: doanh thu realtime, báo cáo ngày tự động, giá nhập–giá xuất, kiểm soát POS, tồn kho.

**Tiên quyết:** CP09 ĐẠT.

**Phạm vi SPEC:** §6.11, §10.1 (mục 1–3, 7–10, 12–14, 16–17), §11 (R01–R09, R14, R16–R24 phần không cần app), §21.3.16.

**Công việc:**
1. Projection: `reporting.live_sales_hourly`, `live_store_status`, `live_orders`, `live_stock`, `daily_revenue`.
2. Socket.IO rooms; p95 ≤ 3 giây.
3. Tổng quan hôm nay + cảnh báo; báo cáo doanh thu đa chiều; **giá nhập – giá xuất – biên lãi**; kiểm soát POS; XNT; hao hụt & hủy; nhân viên theo hàng bán; NCC theo hàng nhập; giá trị kho; sổ quỹ.
4. Báo cáo doanh thu ngày toàn chuỗi khi mọi cửa hàng chốt ngày (hoặc giờ cấu hình) + thông báo Master.
5. Xuất Excel/PDF mọi báo cáo.

**Cổng ĐẠT:**
- [ ] **T01** (phần ≤ 3 giây), **T07** (phần Master), **T23** `covered`.
- [ ] Đối soát: tổng doanh thu báo cáo ngày = tổng Z-report các cửa hàng = tổng hóa đơn (lệnh đối soát vào REGRESSION.md).
- [ ] Đo độ trễ realtime p95 (biên bản).

**Review:** `react-reviewer`, `performance-optimizer`, `database-reviewer`.

---

### CP11 ★ PILOT — Đưa cửa hàng đầu tiên vào vận hành

**Mục tiêu:** 1 cửa hàng + kho tổng chạy thật bằng hệ thống mới theo quy trình go-live §21.5.

**Tiên quyết:** CP10 ĐẠT; đủ thiết bị cửa hàng pilot; dữ liệu thật; nhân viên đã đào tạo.

**Phạm vi SPEC:** §21.5, §21.3.17 (tồn đầu kỳ `OPENING_BALANCE`), §15.

**Công việc (theo §21.5):**
1. Nhập danh mục, NCC, nhân viên, cửa hàng, thiết bị thật; nạp PLU vào cân in tem; in tem giá kệ, thẻ nhân viên.
2. Đào tạo trên staging: bán thử, đóng ca thử, nhận hàng, điều chuyển, kiểm kê.
3. Chạy song song với hệ cũ (nếu có) và so doanh thu cuối ngày.
4. Chốt hệ cũ → **kiểm kê toàn bộ** → nhập tồn đầu kỳ theo lô → Master đối chiếu tổng giá trị.
5. Ngày đầu: hỗ trợ tại chỗ; theo dõi Sentry, hàng đợi, webhook SePay.
6. 7 ngày đầu: kiểm kê xoay vòng hằng ngày; chỉnh định mức, PLU, giá.

**Cổng ĐẠT:**
- [ ] 7 ngày vận hành liên tục; mỗi ngày có Z-report, đóng ca đủ, không lỗi CRITICAL mở.
- [ ] Chênh lệch tiền két trong ngưỡng hoặc có giải trình 100%.
- [ ] Chênh lệch kiểm kê xoay vòng ngày 7 nằm trong định mức.
- [ ] Biên bản pilot + danh sách vấn đề → đưa vào backlog CP tiếp theo.

**Review:** `security-reviewer` (cấu hình production), `database-reviewer` (backup production chạy), `performance-optimizer`.

**Việc của chủ dự án:** chọn cửa hàng pilot, ngày go-live (**không trong 3 tuần trước Tết/lễ lớn**), tổ chức kiểm kê.

**Dừng lại khi:** sai lệch tiền/tồn không giải thích được trong 2 ngày liên tiếp → dừng mở rộng, điều tra.

---

### CP12 — Admin Chỉ Xem & phát hành báo cáo

**Mục tiêu:** cổ đông và ban giám đốc xem đúng phạm vi; Master phát hành snapshot có phiên bản; rule tự động.

**Tiên quyết:** CP11 ĐẠT.

**Phạm vi SPEC:** §2.5 (lớp 4 RLS đầy đủ), §10.2–10.5, §11 (cột Viewer), §12.3 (`reporting.snap_*`).

**Công việc:**
1. Hồ sơ hiển thị `SHAREHOLDER`, `EXECUTIVE` (§10.3) + tạo hồ sơ mới; "Xem như viewer".
2. Live mirror cho viewer (không giá vốn, khách bị che).
3. Publish Gate: chuẩn bị → kiểm tra điều kiện → chọn cơ sở giá vốn → xem trước 3 cột → step-up → phát hành → thu hồi/phiên bản mới.
4. Snapshot bất biến (`snap_*` + trigger), checksum; PDF/Excel.
5. Rule tự động: doanh thu ngày (tự phát hành), tuần/tháng (chuẩn bị nháp, Master duyệt 1 chạm).
6. Khóa số liệu kỳ.
7. Giao diện viewer (web responsive).

**Cổng ĐẠT:**
- [ ] **T07** (phần viewer), **T18, T19** `covered`; TEST-ID mới `TEST-VIEWER-COST-001`: hồ sơ `cost_visibility = NONE` không lộ cột giá vốn ở cả API lẫn file tải.
- [ ] Test RLS: viewer phạm vi 1 cửa hàng không đọc được dòng cửa hàng khác bằng truy vấn trực tiếp role `viewer_ro`.
- [ ] Không có snapshot nào dùng giá vốn định mức cho hồ sơ `SHAREHOLDER` (test).

**Review:** `security-reviewer` (bắt buộc), `database-reviewer` (RLS), `react-reviewer`.

**Việc của chủ dự án:** danh sách người xem + hồ sơ của từng người.

---

### CP13 — Vùng giao, mặt hàng đẩy, thông báo

**Mục tiêu:** Master vẽ vùng giao, tạo mặt hàng đẩy có hạn mức, gửi thông báo đúng đối tượng.

**Tiên quyết:** CP11 ĐẠT; Firebase/FCM, API bản đồ.

**Phạm vi SPEC:** §7.3, §7.4, §8.2, §13.5, §18.4, §21.3.18 (ATP giỏ).

**Công việc:**
1. Vùng giao: vẽ đa giác (PostGIS), cửa hàng phục vụ, phí bậc theo khoảng cách đường đi, giờ, năng lực, khung giờ; ô "Thử địa chỉ".
2. Mặt hàng đẩy: đủ trường §7.3, kiểm tra tồn khả dụng theo vùng, hạn mức (cập nhật nguyên tử), trạng thái.
3. Chiến dịch thông báo: theo vùng / cửa hàng hay mua / danh sách SĐT; hẹn giờ; giới hạn tần suất; chỉ gửi khuyến mãi cho khách đã đồng ý; thống kê gửi/mở.
4. ATP giỏ quà = min thành phần.

**Cổng ĐẠT:**
- [ ] **T08, T09, T41** `covered`.
- [ ] Test đồng thời: 50 đơn cùng lúc trên hạn mức 10 kg không vượt hạn mức.
- [ ] Test point-in-polygon + vùng chồng nhau chọn đúng ưu tiên.

**Review:** `database-reviewer` (PostGIS, index GIST), `security-reviewer` (gửi thông báo hàng loạt), `react-reviewer`.

**Việc của chủ dự án:** vẽ vùng giao thật, phí ship.

---

### CP14 — App người dùng & đơn app

**Mục tiêu:** khách nhận thông báo, đặt mặt hàng đẩy trong vùng; cửa hàng soạn – cân – chụp; khách trả sau khi cân hoặc COD.

**Tiên quyết:** CP13 ĐẠT; Apple/Google Play, OTP thật.

**Phạm vi SPEC:** §7.1–7.2, §7.5, §7.7, §8.1, §8.3–8.6, §8.8, §21.3.12 (đơn điện thoại dùng chung luồng).

**Công việc:**
1. App U01–U14 (Flutter iOS/Android), deep link từ thông báo, xóa tài khoản, quyền riêng tư.
2. Đơn app: máy trạng thái §8.3, giữ tồn, chuông cửa hàng (leo thang 3/5 phút), mã đơn ngẫu nhiên.
3. Tablet soạn đơn: hàng đợi, quét tem lô, cân, ảnh, cảnh báo lệch > 15% cho picker, đóng gói, in tem túi.
4. Thanh toán: **trả sau khi cân** (VA đúng số tiền, nhắc 10 phút, hủy 30 phút) hoặc **COD** (giới hạn giá trị).
5. Thiếu hàng → hỏi khách; khiếu nại 24 giờ (tự duyệt ≤ 100.000đ, 2 lần/30 ngày).
6. Đơn đặt qua điện thoại/Zalo (`channel = PHONE`) + link theo dõi.
7. Build iOS qua Codemagic, TestFlight; Android nội bộ.

**Cổng ĐẠT:**
- [ ] **T10, T12, T13, T24, T32, T38** `covered`.
- [ ] E2E staging: thông báo → đặt → soạn → cân → thanh toán QR → đóng gói (biên bản + ảnh).
- [ ] App qua kiểm tra nội bộ TestFlight + Google Play internal testing.

**Review:** `flutter-reviewer`, `a11y-architect`, `security-reviewer`, `e2e-runner`.

---

### CP15 — Giao hàng: shipper nội bộ, Ahamove, COD

**Mục tiêu:** đơn app/đơn sỉ được giao bằng shipper nội bộ hoặc Ahamove; COD đối soát được.

**Tiên quyết:** CP14 ĐẠT; Ahamove API key STG (→ PROD).

**Phạm vi SPEC:** §8.7, §13.6, §18.2, §14 (F7).

**Công việc:**
1. Chế độ shipper trong staff_app: nhận chuyến, gộp tuyến, trạng thái, ảnh giao, vị trí 15–30 giây, thất bại có lý do.
2. Sổ COD theo shipper, nộp tiền, chặn nhận chuyến khi vượt hạn mức.
3. `CourierAdapter` Ahamove: báo giá, tạo đơn (`tracking_number` chống trùng), webhook, hủy, ánh xạ trạng thái (kiểm lại tên trạng thái theo tài liệu Ahamove khi code).
4. Lãi/lỗ giao hàng (R13).

**Cổng ĐẠT:**
- [ ] **T11** (COD 387.200đ), **T25** (shipper vượt hạn mức COD) `covered`.
- [ ] Đơn thật trên Ahamove STG từ tạo → hoàn tất (biên bản).

**Review:** `security-reviewer` (webhook 3PL), `silent-failure-hunter`, `flutter-reviewer`.

---

### CP16 — Đơn bán sỉ & công nợ khách sỉ

**Mục tiêu:** Master lên đơn sỉ, soạn theo cân thực, giao, thu tiền/ghi công nợ.

**Tiên quyết:** CP11 ĐẠT (giao hàng dùng CP15 nếu cần, nếu chưa có thì khách tự lấy/shipper ghi tay).

**Phạm vi SPEC:** §9 (toàn bộ), R12, R21.

**Công việc:** khách sỉ, bảng giá sỉ, đơn sỉ (trạng thái §9.2), soạn theo cân thực, phiếu giao in số đặt/số thực, đặt cọc, công nợ + VA SePay cho khách sỉ, cảnh báo hạn mức, bảng đối chiếu công nợ.

**Cổng ĐẠT:**
- [ ] **T14, T15** `covered`.
- [ ] Đối soát công nợ: Σ phát sinh − Σ đã thu = số dư (lệnh vào REGRESSION.md).

**Review:** `database-reviewer`, `react-reviewer`, `typescript-reviewer`.

**Việc của chủ dự án:** danh sách khách sỉ + bảng giá sỉ + công nợ đầu kỳ.

---

### CP17 — Độ chín, giảm giá lô, sơ chế, giỏ quà

**Mục tiêu:** giảm hủy hàng: kiểm tra độ chín hằng ngày, đề xuất giảm giá có giá sàn, sơ chế có yield, lắp giỏ quà.

**Tiên quyết:** CP11 ĐẠT.

**Phạm vi SPEC:** §5.6, §5.8, §5.11, §18.6, R10 (phần giảm giá lô), §21.3.7 (dùng mốc ngày).

**Công việc:** danh sách kiểm tra độ chín mỗi sáng, tách lô, cảnh báo 48 giờ; đề xuất giảm giá + giá sàn + duyệt + tem; đẩy nhanh lên app; công thức sơ chế + phiếu sơ chế + yield + giá vốn khay; định mức giỏ + phiếu lắp ráp + thay thế trong nhóm + ngân sách giá vốn; nhập Excel giỏ/công thức.

**Cổng ĐẠT:**
- [ ] TEST-ID mới tạo trong CP: `TEST-MARKDOWN-001` (đề xuất vượt giá sàn → cần Master), `TEST-PROCESS-001` (yield thực thấp hơn chuẩn → cảnh báo, giá vốn khay đúng), `TEST-BUNDLE-001` (thay thành phần vượt ngân sách giá vốn → cần xác nhận) `covered`.
- [ ] Test: nhân viên không mua được hàng giảm giá trong ca.

**Review:** `typescript-reviewer`, `flutter-reviewer`, `database-reviewer`.

**Việc của chủ dự án:** danh sách giỏ quà & công thức sơ chế thật (theo mẫu §18.6).

---

### CP18 — Đặt hàng nhập & bổ sung hàng

**Mục tiêu:** PO cho NCC, bảng giá NCC, min/max theo hạn dùng, dự kiến hết hàng, màn bổ sung hàng tạo phiếu nháp.

**Tiên quyết:** CP17 ĐẠT (cần dữ liệu bán ≥ 14 ngày).

**Phạm vi SPEC:** §21.3.6, R23.

**Cổng ĐẠT:**
- [ ] Test: max bị giới hạn bởi hạn dùng; dự kiến hết hàng đúng công thức; phiếu nháp không tự gửi.
- [ ] PO nhận thiếu → PO còn mở phần thiếu.

**Review:** `typescript-reviewer`, `react-reviewer`.

---

### CP19 — Gia cố & mở rộng toàn chuỗi

**Mục tiêu:** hệ thống đủ an toàn và ổn định để mở cho mọi cửa hàng.

**Tiên quyết:** CP11–CP18 đã ĐẠT phần cần thiết cho các cửa hàng còn lại.

**Công việc:**
1. Rà soát bảo mật toàn hệ thống (skill `ecc-security-review` + agent `security-reviewer`), kiểm thử phân quyền theo ma trận §2.2.
2. Hiệu năng theo §15 (quy mô 5 cửa hàng, 3.000 hóa đơn/ngày, 50.000 push/lần).
3. Diễn tập khôi phục backup trên production clone; ghi RPO/RTO thực tế.
4. Rà `TESTS.md`: mọi TEST-ID `covered` hoặc có lối thoát thủ công hợp lệ.
5. Go-live từng cửa hàng còn lại theo §21.5 (bỏ bước chạy song song nếu đã ổn định).
6. Tài liệu vận hành: hướng dẫn thu ngân, cửa hàng trưởng, kho, Master (ngắn, có ảnh).

**Cổng ĐẠT:**
- [ ] 0 finding CRITICAL/HIGH mở.
- [ ] Biên bản diễn tập khôi phục đạt RPO ≤ 5 phút, RTO ≤ 4 giờ.
- [ ] Mọi cửa hàng đã go-live, 7 ngày ổn định mỗi cửa hàng.

---

## 3. Bảng tổng hợp cổng & TEST-ID

| CP | TEST-ID bắt buộc `covered` (số hiệu theo SPEC §17 = T01–T25, §21.7 = T26–T41) |
|---|---|
| CP03 | T16, T17 |
| CP04 | T40 |
| CP05 | T27, T29, T31 |
| CP06 | T20, T21, T22, T28, T30 |
| CP07 | T01 (phần POS), T02, T03, T26, T33 |
| CP08 | T05, T06, T35, T36, T39 |
| CP09 | T04, T34, T37 |
| CP10 | T01 (realtime ≤ 3 giây), T07 (phần Master), T23 |
| CP12 | T07 (phần viewer), T18, T19, TEST-VIEWER-COST-001 |
| CP13 | T08, T09, T41 |
| CP14 | T10, T12, T13, T24, T32, T38 |
| CP15 | T11, T25 |
| CP16 | T14, T15 |
| CP17 | TEST-MARKDOWN-001, TEST-PROCESS-001, TEST-BUNDLE-001 |
| CP18 | TEST-ID mới tạo trong CP (min/max theo hạn dùng, dự kiến hết hàng, PO nhận thiếu) |

> Khi nạp vào `TESTS.md` ở CP00, mỗi T-số được gán mã ổn định theo module (ví dụ T01 → `TEST-POS-001`, T16 → `TEST-VIEWER-001`) và giữ cột "Nguồn: SPEC §17-T01" để truy ngược.

## 4. Báo cáo kết thúc mỗi checkpoint (mẫu)

```
CHECKPOINT CPxx — <tên>            Trạng thái: ĐẠT / CHƯA ĐẠT
Phạm vi SPEC: §…                   Commit: <hash>   Ngày: <yyyy-mm-dd>

1. Đã làm: …
2. Cổng ĐẠT:
   - [x] <tiêu chí> — bằng chứng: <lệnh> (cwd …) → exit 0, <file/ảnh>
   - [ ] <tiêu chí chưa đạt> — lý do, người gỡ
3. TEST-ID: covered …; unverified …; missing …
4. REGRESSION: module đổi …; hạ nguồn chạy …; tất cả exit 0 / lỗi …
5. Review: agent → số finding (C/H/M/L) → đã sửa / còn mở
6. Đối chiếu tác động: diff vượt phạm vi? …
7. Quyết định mới (ADR) / thuật ngữ mới (CONTEXT): …
8. Việc Tiến cần làm trước CP tiếp theo: …
```
