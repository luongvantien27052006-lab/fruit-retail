import Link from 'next/link';

/** 404 riêng: trang mặc định của Next dùng style inline ⇒ vi phạm CSP style-src (review react 8b lần 1). */
export default function NotFound() {
  return (
    <main className="center">
      <div className="card narrow">
        <h1>Không tìm thấy trang</h1>
        <p className="muted">Đường dẫn không tồn tại hoặc đã bị đổi.</p>
        <Link href="/">Về trang quản lý</Link>
      </div>
    </main>
  );
}
