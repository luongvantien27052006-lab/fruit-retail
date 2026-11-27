import ExcelJS from 'exceljs';
import yauzl from 'yauzl';

/**
 * Đọc file .xlsx KHÔNG tin cậy (CP04 lát 5, ADR-031). Hai bước:
 * 1. `inspectXlsx` — duyệt thư mục zip bằng yauzl TRƯỚC khi giải nén: giới hạn số mục, tổng dung lượng giải nén, tỉ lệ
 *    nén (zip bomb), cấm mục mã hóa / tên đường dẫn lạ, cấm macro (vbaProject), liên kết ngoài, đối tượng nhúng, ActiveX;
 *    giải nén THỬ từng mục và đếm byte thật (yauzl so với kích thước khai ⇒ khai gian bị bắt) — có trần cứng.
 * 2. `readSheet` — exceljs đọc sheet đầu; ô có CÔNG THỨC ⇒ từ chối cả file (không tính, không tin giá trị cache).
 */
export const XLSX_LIMITS = {
  maxEntries: 200,
  maxTotalUncompressed: 50 * 1024 * 1024,
  maxEntryUncompressed: 30 * 1024 * 1024,
  /** tỉ lệ giải nén / nén tối đa cho mục > 1 MB (XML thường ~10–30×) */
  maxRatio: 150,
  maxRows: 5000,
  maxColumns: 60,
  maxCellChars: 2000,
} as const;

export class XlsxRejected extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'XlsxRejected';
  }
}

const FORBIDDEN = [
  /^xl\/vbaProject\.bin$/i,
  /^xl\/externalLinks\//i,
  /^xl\/embeddings\//i,
  /^xl\/activeX\//i,
  /^xl\/ctrlProps\//i,
  /^customUI\//i,
  /^xl\/connections\.xml$/i,
  /^xl\/queryTables\//i,
];
const MAIN_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';

const open = (buf: Buffer) =>
  new Promise<yauzl.ZipFile>((res, rej) =>
    yauzl.fromBuffer(
      buf,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true, decodeStrings: true },
      (e, z) => (e || !z ? rej(e ?? new Error('zip rỗng')) : res(z)),
    ),
  );

/** Kiểm cấu trúc zip/xlsx; lỗi ⇒ XlsxRejected (lý do ngắn, không chứa nội dung file). */
export async function inspectXlsx(buf: Buffer): Promise<void> {
  let zip: yauzl.ZipFile;
  try {
    zip = await open(buf);
  } catch {
    throw new XlsxRejected('NOT_XLSX', 'File không phải .xlsx hợp lệ');
  }
  let entries = 0;
  let total = 0;
  let contentTypes = '';
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on('error', reject);
      zip.on('end', () => resolve());
      zip.on('entry', (entry: yauzl.Entry) => {
        void (async () => {
          entries++;
          const name = entry.fileName;
          if (entries > XLSX_LIMITS.maxEntries)
            throw new XlsxRejected('TOO_MANY_ENTRIES', 'File có quá nhiều thành phần');
          if (entry.isEncrypted()) throw new XlsxRejected('ENCRYPTED', 'File được mã hóa / có mật khẩu');
          if (name.startsWith('/') || name.includes('..') || name.includes('\\'))
            throw new XlsxRejected('BAD_PATH', 'Tên thành phần trong file không hợp lệ');
          if (FORBIDDEN.some((re) => re.test(name)))
            throw new XlsxRejected('ACTIVE_CONTENT', 'File chứa macro / liên kết ngoài / đối tượng nhúng');
          if (name.endsWith('/')) return zip.readEntry();
          if (
            entry.uncompressedSize > 1024 * 1024 &&
            entry.uncompressedSize > XLSX_LIMITS.maxRatio * Math.max(1, entry.compressedSize)
          )
            throw new XlsxRejected('ZIP_BOMB', 'Tỉ lệ nén bất thường (nghi zip bomb)');
          if (entry.uncompressedSize > XLSX_LIMITS.maxEntryUncompressed)
            throw new XlsxRejected('TOO_LARGE', 'File giải nén quá lớn');
          total += entry.uncompressedSize;
          if (total > XLSX_LIMITS.maxTotalUncompressed) throw new XlsxRejected('TOO_LARGE', 'File giải nén quá lớn');
          // giải nén thử, đếm byte thật — yauzl validateEntrySizes báo lỗi nếu khác kích thước khai
          const chunks: Buffer[] = [];
          const keep = name === '[Content_Types].xml';
          await new Promise<void>((ok, bad) => {
            zip.openReadStream(entry, (err, s) => {
              if (err || !s) return bad(err ?? new Error('stream'));
              let n = 0;
              s.on('data', (c: Buffer) => {
                n += c.length;
                if (n > entry.uncompressedSize || n > XLSX_LIMITS.maxEntryUncompressed) {
                  s.destroy(new XlsxRejected('ZIP_BOMB', 'Kích thước giải nén không khớp khai báo'));
                  return;
                }
                if (keep) chunks.push(c);
              });
              s.on('error', bad);
              s.on('end', () => ok());
            });
          });
          if (keep) contentTypes = Buffer.concat(chunks).toString('utf8');
          zip.readEntry();
        })().catch(reject);
      });
      zip.readEntry();
    });
  } catch (e) {
    zip.close();
    if (e instanceof XlsxRejected) throw e;
    throw new XlsxRejected('NOT_XLSX', 'File không phải .xlsx hợp lệ');
  }
  zip.close();
  if (!contentTypes.includes(MAIN_XLSX))
    // .xlsm (macroEnabled), .xlsb, .ods… đổi đuôi thành .xlsx
    throw new XlsxRejected('NOT_XLSX', 'File không phải .xlsx (có thể là .xlsm / .xls đổi đuôi)');
}

export type Cell = string | number | boolean | null;
export interface SheetRow {
  /** số dòng trong Excel (1 = tiêu đề) */
  row: number;
  values: Record<string, Cell>;
}

/**
 * Đọc sheet đầu tiên: dòng 1 là tiêu đề — mỗi tiêu đề khớp một khóa cột (`Tên hiển thị (khoa)` hoặc đúng `khoa`); cột lạ
 * bỏ qua, cột trùng ⇒ từ chối. Dòng trống bỏ qua. Ô công thức ⇒ từ chối CẢ file.
 */
export async function readSheet(
  buf: Buffer,
  keys: readonly string[],
): Promise<{ rows: SheetRow[]; missing: string[] }> {
  await inspectXlsx(buf);
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    throw new XlsxRejected('NOT_XLSX', 'Không đọc được nội dung file Excel');
  }
  const ws = wb.worksheets[0];
  if (!ws) throw new XlsxRejected('EMPTY', 'File không có sheet nào');
  if (ws.actualRowCount > XLSX_LIMITS.maxRows + 1 || ws.rowCount > XLSX_LIMITS.maxRows + 50)
    throw new XlsxRejected('TOO_MANY_ROWS', `Tối đa ${XLSX_LIMITS.maxRows} dòng dữ liệu mỗi file`);
  if (ws.columnCount > XLSX_LIMITS.maxColumns) throw new XlsxRejected('TOO_MANY_COLUMNS', 'File có quá nhiều cột');

  // ô công thức ở BẤT KỲ sheet nào ⇒ từ chối
  for (const sheet of wb.worksheets)
    sheet.eachRow({ includeEmpty: false }, (r) =>
      r.eachCell({ includeEmpty: false }, (c) => {
        if (c.type === ExcelJS.ValueType.Formula || isFormula(c.value))
          throw new XlsxRejected('FORMULA', `File chứa công thức (ô ${c.address}) — dán giá trị rồi tải lại`);
      }),
    );

  const header = ws.getRow(1);
  const colKey = new Map<number, string>();
  const seen = new Set<string>();
  header.eachCell({ includeEmpty: false }, (c, col) => {
    const t = cellValue(c.value);
    if (typeof t !== 'string') return;
    const m = /\(([a-z_]+)\)\s*\*?\s*$/.exec(t) ?? /^\s*([a-z_]+)\s*\*?\s*$/.exec(t);
    const k = m?.[1];
    if (!k || !keys.includes(k)) return;
    if (seen.has(k)) throw new XlsxRejected('DUPLICATE_COLUMN', `Cột ${k} xuất hiện hai lần`);
    seen.add(k);
    colKey.set(col, k);
  });
  const missing = keys.filter((k) => !seen.has(k));
  const rows: SheetRow[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const values: Record<string, Cell> = {};
    let any = false;
    for (const [col, k] of colKey) {
      const v = cellValue(row.getCell(col).value);
      if (typeof v === 'string' && v.length > XLSX_LIMITS.maxCellChars)
        throw new XlsxRejected('CELL_TOO_LONG', `Ô ở dòng ${r} quá dài`);
      values[k] = v;
      if (v !== null && v !== '') any = true;
    }
    if (any) rows.push({ row: r, values });
  }
  if (rows.length > XLSX_LIMITS.maxRows)
    throw new XlsxRejected('TOO_MANY_ROWS', `Tối đa ${XLSX_LIMITS.maxRows} dòng dữ liệu mỗi file`);
  return { rows, missing };
}

function isFormula(v: unknown): boolean {
  return typeof v === 'object' && v !== null && ('formula' in v || 'sharedFormula' in v);
}

/** giá trị ô ⇒ kiểu đơn giản; rich text / hyperlink ⇒ chữ; ngày ⇒ ISO; lỗi (#N/A…) ⇒ null */
function cellValue(v: ExcelJS.CellValue): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if ('richText' in v && Array.isArray(v.richText))
      return v.richText
        .map((t) => t.text)
        .join('')
        .trim();
    if ('text' in v && typeof v.text === 'string') return v.text.trim();
    if ('error' in v) return null;
  }
  return null;
}
