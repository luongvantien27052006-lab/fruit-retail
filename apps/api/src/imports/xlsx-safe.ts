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
  /** exceljs nạp cả file vào bộ nhớ (~35× kích thước XML) — 5.000 dòng × 60 cột thật ≈ 7 MB XML (review lát 5 N1) */
  maxTotalUncompressed: 20 * 1024 * 1024,
  maxEntryUncompressed: 10 * 1024 * 1024,
  maxSheets: 20,
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
  /^xl\/(macrosheets|dialogsheets)\//i,
];
const MAIN_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';

/**
 * DANH SÁCH CHO PHÉP (review bảo mật lát 5 vòng 2): kiểu quan hệ (đoạn cuối URI) và ContentType của workbook thường. Kiểu lạ
 * / bị mã hóa / viết khác ⇒ không khớp ⇒ từ chối. Form control, ActiveX, OLE, macro (VBA + XLM), liên kết ngoài, kết nối dữ
 * liệu, template KHÔNG có trong danh sách.
 */
const ALLOWED_REL = new Set([
  'officeDocument',
  'core-properties',
  'extended-properties',
  'custom-properties',
  'thumbnail',
  'worksheet',
  'chartsheet',
  'styles',
  'sharedStrings',
  'theme',
  'themeOverride',
  'calcChain',
  'drawing',
  'image',
  'chart',
  'chartUserShapes',
  'chartStyle',
  'chartColorStyle',
  'comments',
  'vmlDrawing',
  'printerSettings',
  'table',
  'pivotTable',
  'pivotCacheDefinition',
  'pivotCacheRecords',
  'hyperlink',
  'customXml',
  'customXmlProps',
  'sheetMetadata',
  'metadata',
  'person',
  'threadedComment',
  'namedSheetView',
  'slicer',
  'slicerCache',
  'timeline',
  'timelineCache',
  'volatileDependencies',
  'richValue',
  'richValueRel',
  'richValueStructure',
  'richValueTypes',
  'rdRichValue',
  'rdRichValueStructure',
  'rdRichValueTypes',
  'rdArray',
  'rdSupportingPropertyBag',
  'rdSupportingPropertyBagStructure',
  'webImage',
  'usernames',
  'revisionHeaders',
  'revisionLog',
  'feature',
  'FeaturePropertyBag',
  'classificationlabels',
]);
const ALLOWED_CT = [
  /^application\/xml$/,
  /^text\/xml$/,
  /^image\/[a-z0-9.+-]+$/,
  /^application\/vnd\.openxmlformats-package\.(relationships|core-properties)\+xml$/,
  /^application\/vnd\.openxmlformats-officedocument\.(spreadsheetml|drawingml|drawing|theme|themeOverride|extended-properties|custom-properties|customXmlProperties|vmlDrawing)[a-zA-Z0-9.+-]*$/,
  /^application\/vnd\.ms-excel\.(person|threadedcomments|sheetMetadata|rdrichvalue[a-z]*|rdarray|rdsupportingpropertybag[a-z]*|namedsheetview|slicer|slicerCache|timeline|timelineCache|webimage|feature|featurepropertybag|richvaluerel)\+xml$/i,
  /^application\/vnd\.ms-office\.(chartstyle|chartcolorstyle|classificationlabels)\+xml$/,
];
/** loại spreadsheetml chủ động (khớp được mẫu officedocument ở trên) ⇒ chặn */
const DENY_CT = /externalLink|connections|queryTable|ctrlProp|activeX|oleObject|macro|vba|template|binary/i;
const relKind = (type: string) => type.slice(type.lastIndexOf('/') + 1);

/** thuộc tính trong NHÁY KÉP (nháy đơn / thực thể đã bị chặn trước); thẻ có '>' trong giá trị vẫn đọc đúng */
/** 5 thực thể có sẵn của XML (Excel ghi `&amp;` trong URL hyperlink) — thực thể khác đã bị assertPlain chặn */
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (v: string) => v.replace(/&(amp|lt|gt|quot|apos);/g, (_, k: string) => ENT[k] ?? '');
const attrs = (tag: string) =>
  new Map([...tag.matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1], decode(m[2] ?? '')]));
const tagRe = (name: string) => new RegExp(String.raw`<${name}\b(?:[^>"]|"[^"]*")*>`, 'g');
const tags = (xml: string, name: string) => [...xml.matchAll(tagRe(name))].map((m) => attrs(m[0]));

/**
 * Chỉ đọc phần quan hệ / loại nội dung khi viết ở dạng "chuẩn" Excel tạo: không thực thể (&…;), không nháy đơn, không
 * tiền tố namespace, số thẻ thô = số thẻ đọc được. Khác ⇒ từ chối (không đoán).
 */
/**
 * Phần quan hệ / loại nội dung phải là UTF-8 hợp lệ (review bảo mật lát 5 vòng 4 N6): BOM UTF-16, byte NUL, khai encoding
 * khác UTF-8, hoặc UTF-8 sai ⇒ từ chối (UTF-16 giải như UTF-8 sẽ không khớp thẻ nào ⇒ trước đây lọt bộ lọc).
 */
function utf8Part(buf: Buffer): string {
  const bad = () => new XlsxRejected('ACTIVE_CONTENT', 'Cấu trúc file Excel bất thường');
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) throw bad();
  if (buf.includes(0)) throw bad();
  let s: string;
  try {
    s = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw bad();
  }
  const enc = /^\s*<\?xml[^>]*\bencoding\s*=\s*["']([^"']+)["']/i.exec(s)?.[1];
  if (enc && !/^utf-?8$/i.test(enc)) throw bad();
  return s;
}

function assertPlain(xml: string, names: string[]): void {
  // chỉ 5 thực thể có sẵn (không &#…; / thực thể tự đặt); không thuộc tính nháy đơn (nháy đơn TRONG giá trị nháy kép được)
  if (
    /&(?!(amp|lt|gt|quot|apos);)/.test(xml) ||
    /\s[\w:]+\s*=\s*'/.test(xml) ||
    /<\/?[A-Za-z_][\w.-]*:/.test(xml) ||
    /<!/.test(xml)
  )
    throw new XlsxRejected('ACTIVE_CONTENT', 'Cấu trúc file Excel bất thường');
  for (const n of names) {
    const raw = xml.match(new RegExp(String.raw`<${n}\b`, 'g'))?.length ?? 0;
    if (raw !== tags(xml, n).length) throw new XlsxRejected('ACTIVE_CONTENT', 'Cấu trúc file Excel bất thường');
  }
}

/**
 * Kiểm theo NGHĨA (không theo tên phần): mọi ContentType và mọi kiểu quan hệ trong *.rels thuộc danh sách cho phép; phần
 * officeDocument (_rels/.rels) có đúng loại workbook .xlsx thường (khai đúng MỘT lần); đích ngoài (External) chỉ cho
 * hyperlink.
 */
function validateParts(contentTypes: string, rels: Map<string, string>): void {
  assertPlain(contentTypes, ['Default', 'Override']);
  const defaults = tags(contentTypes, 'Default');
  const overrides = tags(contentTypes, 'Override');
  for (const t of [...defaults, ...overrides]) {
    const ct = t.get('ContentType') ?? '';
    if (DENY_CT.test(ct) || !ALLOWED_CT.some((re) => re.test(ct)))
      throw new XlsxRejected('ACTIVE_CONTENT', 'File chứa macro / liên kết ngoài / đối tượng nhúng');
  }
  const root = rels.get('_rels/.rels') ?? '';
  assertPlain(root, ['Relationship']);
  const office = tags(root, 'Relationship').filter((r) => relKind(r.get('Type') ?? '') === 'officeDocument');
  const target = (office[0]?.get('Target') ?? '').replace(/^\//, '');
  const hits = overrides.filter((o) => (o.get('PartName') ?? '').replace(/^\//, '') === target);
  if (office.length !== 1 || !target || hits.length !== 1 || hits[0]?.get('ContentType') !== MAIN_XLSX)
    // .xlsm (macroEnabled), .xlsb, .ods… đổi đuôi thành .xlsx
    throw new XlsxRejected('NOT_XLSX', 'File không phải .xlsx (có thể là .xlsm / .xls đổi đuôi)');
  for (const xml of rels.values()) {
    assertPlain(xml, ['Relationship']);
    for (const r of tags(xml, 'Relationship')) {
      const type = r.get('Type') ?? '';
      if (!ALLOWED_REL.has(relKind(type)))
        throw new XlsxRejected('ACTIVE_CONTENT', 'File chứa macro / liên kết ngoài / đối tượng nhúng');
      if ((r.get('TargetMode') ?? '').toLowerCase() === 'external' && relKind(type) !== 'hyperlink')
        throw new XlsxRejected('ACTIVE_CONTENT', 'File chứa liên kết ra ngoài');
    }
  }
}

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
  /** tên mục đã gặp (không phân biệt hoa thường — tên phần OPC không phân biệt) */
  const names = new Set<string>();
  let total = 0;
  let contentTypes = '';
  let sheets = 0;
  const rels = new Map<string, string>();
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on('error', reject);
      zip.on('end', () => resolve());
      zip.on('entry', (entry: yauzl.Entry) => {
        void (async () => {
          entries++;
          const name = entry.fileName;
          const lower = name.toLowerCase();
          // hai mục trùng tên (kể cả khác hoa thường) ⇒ bộ đọc khác nhau thấy phần khác nhau (review bảo mật vòng 3 N4)
          if (names.has(lower)) throw new XlsxRejected('ACTIVE_CONTENT', 'File có hai thành phần trùng tên');
          names.add(lower);
          if (/(^|\/)_rels\//.test(lower) && !lower.endsWith('/') && !lower.endsWith('.rels'))
            throw new XlsxRejected('ACTIVE_CONTENT', 'Cấu trúc file Excel bất thường');
          if (
            (lower.endsWith('.rels') && !name.endsWith('.rels')) ||
            (lower === '[content_types].xml' && name !== '[Content_Types].xml')
          )
            throw new XlsxRejected('ACTIVE_CONTENT', 'Cấu trúc file Excel bất thường');
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
          if (/^xl\/(worksheets|chartsheets)\/[^/]+\.xml$/i.test(name) && ++sheets > XLSX_LIMITS.maxSheets)
            throw new XlsxRejected('TOO_MANY_SHEETS', 'File có quá nhiều sheet');
          total += entry.uncompressedSize;
          if (total > XLSX_LIMITS.maxTotalUncompressed) throw new XlsxRejected('TOO_LARGE', 'File giải nén quá lớn');
          // giải nén thử, đếm byte thật — yauzl validateEntrySizes báo lỗi nếu khác kích thước khai
          const chunks: Buffer[] = [];
          const keep = name === '[Content_Types].xml' || name.endsWith('.rels');
          // phần quan hệ / loại nội dung lớn bất thường ⇒ từ chối (không bỏ qua — review bảo mật vòng 2)
          if (keep && entry.uncompressedSize > 1024 * 1024)
            throw new XlsxRejected('ACTIVE_CONTENT', 'Cấu trúc file Excel bất thường');
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
          if (keep && name === '[Content_Types].xml') contentTypes = utf8Part(Buffer.concat(chunks));
          else if (keep) rels.set(name, utf8Part(Buffer.concat(chunks)));
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
  validateParts(contentTypes, rels);
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
  // sheet dữ liệu bị ẩn ⇒ người nhập không thấy dòng nào sẽ vào (review bảo mật lát 5)
  if (ws.state !== 'visible')
    throw new XlsxRejected('HIDDEN_SHEET', 'Sheet đầu tiên đang bị ẩn — hiện sheet rồi tải lại');
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
    // mọi khóa đều có mặt (cột vắng ⇒ null) — review TS lát 5 C1
    const values: Record<string, Cell> = Object.fromEntries(keys.map((k) => [k, null]));
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
