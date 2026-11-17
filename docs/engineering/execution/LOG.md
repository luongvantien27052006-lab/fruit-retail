# LOG — Nhật ký sự kiện (chỉ thêm)

| Thời điểm (giờ VN) | CP | Sự kiện |
|---|---|---|
| 2026-11-17 | CP00 | Mở CP00. Kiểm kê `.claude/` mang từ dự án F2C: 3 rule F2C, 5 `f2c-integration.md`, khối adapter F2C ở 14 agent, mô tả F2C ở 5 SKILL.md UI. |
| 2026-11-17 | CP00 | Tiến quyết: repo code ở `D:\fruit-retail` (ASCII); `D:\app hoa quả` chỉ đọc; §7.6 HOÃN; thư mục ADR để CP01; mẫu ADR đặt trong `fruit-engineering.md`. |
| 2026-11-17 | CP00 | Sao chép SPEC v3.2, KẾ HOẠCH, PROMPT vào `docs/specs/`, v2 vào `docs/specs/history/`; SPEC sha256 khớp bản gốc. |
| 2026-11-17 | CP00 | `.claude` gốc tại `D:\app hoa quả` đã bị chuyển vào Thùng rác (21:02, không do phiên này); theo chỉ thị của Tiến, sao chép từ Thùng rác sang `D:\fruit-retail\.claude`. |
| 2026-11-17 | CP00 | Tiến duyệt nháp. Ghi 3 rule `fruit-*.md`, `fruit-integration.md` cho 5 skill UI, thay khối ngữ cảnh 14 agent, sửa `e2e-runner`, 5 SKILL.md, `ecc-guardrails.md`, 2 command. |
| 2026-11-17 | CP00 | Theo chỉ thị của Tiến, XÓA HẲN phần F2C (không lưu trữ): 3 rule `f2c-*.md`, 5 `f2c-integration.md`; xóa metadata ECC không dùng (`enterprise/`, `research/`, `team/`, `homunculus/`, `workflows/`, `ecc-tools.json`, `identity.json`, `package-manager.json`, `settings.local.json`, `commands/add-language-rules.md`, `rules/node.md`). |
| 2026-11-17 | CP00 | Tiến thêm `CLAUDE.md` (nguyên tắc hành vi) và `.claude-plugin/`; gộp nguyên tắc vào `CLAUDE.md` cùng bản đồ dự án. |
| 2026-11-17 | CP00 | Tạo SPEC-LOCK, CONTEXT, TESTS (41 TEST-ID), REGRESSION (khung), STATUS, `checkpoints/CP00.md`; `git init`, commit đầu. CP00 → CHỜ REVIEW. |
| 2026-11-17 | CP00 | Tiến xác nhận CP00 ĐẠT (yêu cầu "bắt đầu làm CP01"). Commit f9ea35f, aa318ab. |
| 2026-11-17 | — | Tiến cấp remote `origin` = github.com/luongvantien27052006-lab/fruit-retail (repo trống); từ nay code đẩy lên đây. |
| 2026-11-17 | CP01 | Mở CP01. |
| 2026-11-17 | CP01 | Tiến chốt: ADR ở `docs/engineering/decisions/`, Prisma theo SPEC, worker là entry 2 của `apps/api`, Node 24 LTS. Tiến cho phép tự cài thư viện chính chủ khi cần. |
| 2026-11-17 | CP01 | Ghi ADR-001…010, versions.json, openapi.yaml (189 thao tác), 24 schema sự kiện, 7 máy trạng thái + 50 vector, ERD, screens.md. Kiểm `pnpm --dir packages/contracts run check` exit 0. CP01 → CHỜ REVIEW. |
| 2026-11-17 | CP01 | Tiến "Duyệt tất cả": ADR-008 accepted; NC-08 (5 mã quyền), NC-09 (route ngoài §13.2), NC-10 (tách giá vốn khỏi `live_sales_hourly`) đã quyết. Kiểm hợp đồng exit 0. Theo yêu cầu của Tiến: chạy review bằng agent trước khi ĐẠT. |
