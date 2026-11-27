import { z } from 'zod';

/** Trường zod dùng chung cho API tổ chức / NCC (CP04 lát 4). */
/** ký tự điều khiển (C0 trừ tab / xuống dòng, DEL, C1), đảo chiều chữ, ngắt dòng/đoạn Unicode — như lý do đổi giá (lát 3) */
export const isControl = (c: string) => {
  const n = c.charCodeAt(0);
  return (
    (n < 32 && n !== 9 && n !== 10 && n !== 13) ||
    (n >= 0x7f && n <= 0x9f) ||
    (n >= 0x202a && n <= 0x202e) ||
    (n >= 0x2066 && n <= 0x2069) ||
    n === 0x2028 ||
    n === 0x2029
  );
};
const clean = (v: string) => ![...v].some(isControl);
/** chuỗi có nội dung; bỏ khoảng trắng hai đầu; cấm ký tự điều khiển (NUL ⇒ PostgreSQL 500) */
export const text = (max: number) => z.string().trim().min(1).max(max).refine(clean, 'không chứa ký tự điều khiển');
/** chuỗi tùy chọn: '' ⇒ null */
export const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine(clean, 'không chứa ký tự điều khiển')
    .nullable()
    .optional()
    .transform((v) => (v === '' ? null : v));
export const flag = z.enum(['true', 'false']).transform((v) => v === 'true');
export const minOne = (b: object) => Object.keys(b).length > 0;
export const uuid = z
  .string()
  .uuid()
  .transform((v) => v.toLowerCase());
