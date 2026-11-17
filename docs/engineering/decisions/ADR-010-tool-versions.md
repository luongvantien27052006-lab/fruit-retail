# ADR-010: Phiên bản công cụ

- Trạng thái: accepted (dòng phiên bản); lý do Redis + cấu hình sửa bởi ADR-017; bản vá chính xác pin ở CP02
- Ngày: 2026-11-17 · Người quyết: Tiến (Node), phiên điều phối (còn lại) · Căn cứ SPEC: §19.2, §19.3

## Bối cảnh
Cần một nguồn duy nhất cho phiên bản để dev, CI, staging, production giống nhau. Nguồn máy-đọc-được:
`docs/engineering/architecture/versions.json`.

## Quyết định
| Thành phần | Dòng phiên bản | Ghi chú |
|---|---|---|
| Node.js | **24 LTS** | Tiến chốt; máy hiện có 22.22.3 → cần cài 24 trước CP02 |
| pnpm | 11.x | Máy có 11.2.2; pin bằng `packageManager` |
| TypeScript | bản stable mới nhất lúc CP02 | `strict: true` |
| NestJS | 11.x | |
| Prisma | bản major stable lúc CP02 | Kiểm hỗ trợ `multiSchema`, BigInt, driver adapter |
| Next.js | 16.x (App Router) + React 19 | |
| Flutter / Dart | Flutter 3.44 stable / Dart 3.12 | Đúng bản máy đang có |
| PostgreSQL + PostGIS | **17 + PostGIS 3.5** (`postgis/postgis:17-3.5`) | Thay ví dụ 16-3.4 ở §19.3; psql 18 trên máy dùng được làm client |
| Redis | 7.4 (`redis:7.4-alpine`, AOF bật) | BullMQ hỗ trợ ổn định |
| Caddy | 2.x | HTTPS tự động |
| Docker Engine / Compose | 29.x / v5 | Máy có |
| OpenAPI | 3.1; lint bằng Redocly CLI | Cổng CP01 |
| OpenAPI generator | TS: `openapi-typescript` (+ `openapi-fetch`); Dart: `openapi-generator` (dart-dio) | Chốt chi tiết ở CP02 |

## Phương án đã cân nhắc
PostgreSQL 18: mới, một số extension/image PostGIS chưa trưởng thành bằng 17 → chọn 17. Redis 8: đổi giấy phép và
tính năng; 7.4 đủ cho queue/cache.

## Hệ quả
- CP02 điền phiên bản chính xác + digest vào `versions.json`, CI kiểm phiên bản thực tế khớp file.
- Nâng phiên bản major = ADR mới.
