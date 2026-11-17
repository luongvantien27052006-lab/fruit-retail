# ADR-018: Chốt phiên bản thực tế ở CP02 (sửa dòng phiên bản của ADR-010)

- Trạng thái: accepted · Ngày: 2026-11-18 · Sửa: ADR-010 (TypeScript, NestJS, Prisma) · Căn cứ: tra registry npm 2026-11-18

## Bối cảnh
ADR-010 ghi dòng phiên bản theo hiểu biết lúc CP01. Tra registry ngày 2026-11-18:
- `typescript@latest` = 7.0.2 (bản biên dịch native), nhưng `typescript-eslint@8.73.0` chỉ hỗ trợ `typescript <6.1.0`.
- `@nestjs/core@latest` = 12.5.1 (dòng 12 phát hành 2026-08); ADR-010 ghi 11.x.
- `prisma` dist-tag `latest` đang trỏ 8.0.0-rc.34 (bản RC); bản ổn định mới nhất là 7.10.1.

## Quyết định
| Thành phần | Chốt | Lý do |
|---|---|---|
| TypeScript | **6.0.3** | Bản mới nhất mà typescript-eslint hỗ trợ; xem lại khi typescript-eslint hỗ trợ TS 7 |
| NestJS | **12.x** (pin chính xác trong lockfile) | Dòng hiện hành; 11.x không còn là bản mới |
| Prisma / @prisma/client | **7.10.1** | Không dùng bản RC trong production |
| ESLint | 10.15.0 + typescript-eslint 8.73.0 | |
| Vitest | 5.1.0 | ADR-017 |
| Prettier | 3.10.1 | |
| @types/node | 24.19.2 | khớp Node 24 |

Phiên bản chính xác của mọi gói nằm trong `pnpm-lock.yaml` và `pubspec.lock` (gốc repo); `versions.json` ghi các dòng
then chốt.

## Hệ quả
- Nâng TypeScript 7 / Prisma 8 = ADR mới sau khi kiểm tương thích.
