'use client';
import './globals.css';

/** Lỗi ngoài cùng: thay trang mặc định (style inline ⇒ vi phạm CSP). Không hiện chi tiết lỗi cho người dùng. */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="vi">
      <body>
        <main className="center">
          <div className="card narrow">
            <h1>Có lỗi xảy ra</h1>
            <p className="muted">Thử tải lại trang. Nếu lặp lại, báo cho quản trị hệ thống.</p>
            <button type="button" onClick={() => reset()}>
              Thử lại
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
