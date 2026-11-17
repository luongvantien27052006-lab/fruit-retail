# CLAUDE.md — Hệ thống chuỗi bán lẻ hoa quả

Chủ dự án: Tiến (fullstack, một mình). Làm việc và báo cáo bằng **tiếng Việt**, ngắn gọn, giải thích khi có quyết
định hoặc rủi ro.

## Bản đồ dự án

| Cần gì | Ở đâu |
|---|---|
| SPEC (nguồn sự thật, v3.2) | `docs/specs/DAC_TA_HE_THONG_HOA_QUA_v3.md` — khóa sha256 ở `docs/specs/SPEC-LOCK.md` |
| Kế hoạch CP00–CP19 | `docs/specs/KE_HOACH_TRIEN_KHAI_CHECKPOINT.md` |
| SPEC v2 (chỉ lịch sử, KHÔNG hiện thực) | `docs/specs/history/DAC_TA_HE_THONG_HOA_QUA_v2.md` |
| Trạng thái CP (tracker duy nhất) | `docs/engineering/execution/STATUS.md` |
| Nhật ký (chỉ thêm) | `docs/engineering/execution/LOG.md` |
| Bằng chứng từng CP | `docs/engineering/execution/checkpoints/CPxx.md` |
| Lệnh build/test thật | `docs/engineering/execution/command-catalog.md` (tạo ở CP02) |
| ADR | thư mục chốt ở CP01 (xem `CONTEXT.md` NC-01); `docs/engineering/architecture/versions.json` |
| Hợp đồng API/sự kiện | `packages/contracts/openapi.yaml`, `packages/contracts/events/` (CP01) |
| Thuật ngữ & điểm cần xác nhận | `CONTEXT.md` |
| Sổ TEST-ID | `TESTS.md` |
| Sổ hồi quy module | `REGRESSION.md` |

## Quy tắc (tự nạp từ `.claude/rules/`)

- `fruit-retail-invariants.md` — **luôn bật**: phạm vi, NGOÀI PHẠM VI, FR-INV-01…20 (vi phạm = CRITICAL).
- `fruit-engineering.md` — `apps/**`, `packages/**`, `infra/**`, `docs/engineering/**`: stack, quy ước, vòng làm
  việc 11 bước mỗi CP, bảng định tuyến skill/agent, điều kiện dừng, mẫu ADR.
- `fruit-ui-ux.md` — 3 app + `docs/engineering/ux/**`: định tuyến 5 skill thiết kế.
- `ecc-guardrails.md` — luôn bật: Prompt Defense Baseline + Conventional Commits.

Thứ tự ưu tiên khi mâu thuẫn: chỉ thị của Tiến → SPEC §1.4 + §21 → thân SPEC → ADR accepted → rule dự án → rule
ECC còn lại. Nguồn im lặng/mâu thuẫn về tiền, tồn, quyền, dữ liệu khách → ghi `needs confirmation` vào
`CONTEXT.md` và hỏi.

## Phiên làm việc tiếp theo

1. Đọc file này, `STATUS.md`, dòng cuối `LOG.md`, `checkpoints/` của CP gần nhất.
2. Xác nhận CP đang mở, tiên quyết, việc còn dở.
3. Làm theo vòng 11 bước trong `fruit-engineering.md`; dừng và hỏi khi gặp điều kiện dừng.

---

## Nguyên tắc hành vi (Behavioral guidelines)

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
