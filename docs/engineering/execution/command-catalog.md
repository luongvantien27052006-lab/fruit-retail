# Command catalog — lệnh thật (CP02)

Shell mặc định: **Git Bash** trên Windows (CI: bash trên Ubuntu; job Windows dùng PowerShell mặc định của runner).
cwd = gốc repo `D:\fruit-retail` trừ khi ghi khác. Ghi kết quả bằng exit code thật; không cắt log làm mất exit code.
Yêu cầu: Node 24.22.3, pnpm 11.2.2 (Corepack), Flutter 3.44.6 / Dart 3.12.2, Docker (engine Linux). Kiểm:
`node tools/check-versions.mjs`.

## Cài đặt

| Mục đích | cwd | Lệnh |
|---|---|---|
| Cài phụ thuộc JS/TS (lockfile cố định) | gốc | `pnpm install --frozen-lockfile` |
| Cài phụ thuộc Dart/Flutter (một lockfile) | gốc | `flutter pub get --enforce-lockfile` |
| Kiểm phiên bản công cụ | gốc | `node tools/check-versions.mjs` |

## TS (toàn workspace)

| Mục đích | cwd | Lệnh |
|---|---|---|
| Định dạng (kiểm) | gốc | `pnpm run format:check` |
| Lint | gốc | `pnpm run lint` |
| Typecheck | gốc | `pnpm run typecheck` |
| Test (API dùng Testcontainers → cần Docker) | gốc | `pnpm run test` |
| Build | gốc | `pnpm run build` |
| Kiểm hợp đồng (OpenAPI, sự kiện, máy trạng thái, đối chiếu SPEC) | gốc | `pnpm run check:contracts` |
| Sinh migration Prisma mới (ADR-020) | `apps/api` | DB dev đã áp mọi migration, rồi `DATABASE_URL_MIGRATE=<owner> pnpm exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` → thư mục `prisma/migrations/NNNN_<tên>/migration.sql` + SQL tay cuối file. Migration đầu: `--from-empty` (vẫn cần `DATABASE_URL_MIGRATE`, URL giả được) |
| Kiểm Prisma khớp DB | `apps/api` | tự chạy trong `test/foundation-schema.test.ts` (`migrate diff --exit-code`) |
| Một package | gốc | `pnpm --filter <tên> run <script>` — tên: `@fruit/api`, `@fruit/admin-web`, `@fruit/contracts`, `@fruit/money_weight`, `@fruit/api_client_ts` |

## Dart / Flutter

| Mục đích | cwd | Lệnh |
|---|---|---|
| Chuẩn hóa spec cho Dart | gốc | `pnpm --filter @fruit/contracts run export:dart` |
| Sinh `shared_models` | `packages/shared_models` | `dart run swagger_parser && dart run build_runner build` |
| Test money_weight (vector chung) | `packages/money_weight/dart` | `dart analyze --fatal-infos && dart test` |
| Test shared_models | `packages/shared_models` | `dart analyze --fatal-infos && dart test` |
| Analyze + test app | `apps/customer_app` hoặc `apps/staff_app` | `flutter analyze --fatal-infos && flutter test` |
| Build POS Windows | `apps/staff_app` | `flutter build windows --release` |
| Spike cổng COM trên Windows | `apps/staff_app` | `flutter test integration_test -d windows` |

## Chạy local bằng Docker

| Mục đích | cwd | Lệnh |
|---|---|---|
| Tạo file env local (một lần) | gốc | `cp infra/.env.example infra/.env` rồi thay mọi `change-me` bằng chuỗi ngẫu nhiên ≥ 12 ký tự (KHÔNG commit) |
| Dựng + chạy toàn bộ | gốc | `docker compose -f infra/docker-compose.yml --env-file infra/.env up -d --build --wait` |
| Health qua Caddy | — | `curl -s -w ' http=%{http_code}\n' http://127.0.0.1:8080/v1/health` → `{"status":"ok",…} http=200` |
| Trang quản lý qua Caddy | — | `http://127.0.0.1:8080/` |
| Log | gốc | `docker compose -f infra/docker-compose.yml --env-file infra/.env logs -f api worker` |
| Dừng (giữ dữ liệu) | gốc | `docker compose -f infra/docker-compose.yml --env-file infra/.env down` |
| PostgreSQL local từ máy | — | `127.0.0.1:25432` (đổi bằng `PG_HOST_PORT`), user `owner` |

## Quét secret

| Mục đích | cwd | Lệnh |
|---|---|---|
| Lịch sử git | gốc | `MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/repo" ghcr.io/gitleaks/gitleaks:v8.30.1 detect --source /repo --redact --no-banner --exit-code 1` |

## CI

`.github/workflows/ci.yml` — job `secrets`, `ts`, `dart` chạy mọi push `main`/`develop`/`feat/**` và PR; job
`windows` (build Windows + spike COM) chỉ khi push `develop`/`main`.
