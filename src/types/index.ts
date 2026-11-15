/**
 * =============================================================================
 * src/types/index.ts
 * Definisi interface & type TypeScript GLOBAL.
 * =============================================================================
 *
 * ATURAN MUTLAK (Bagian 5 blueprint):
 *   - Tipe `any` DILARANG KERAS. Tidak ada satu pun deklarasi `any` di file ini.
 *   - Setiap bentuk data yang melintasi batas layer
 *     (HTTP -> Controller -> Model -> PostgreSQL) memiliki tipe eksplisit.
 *
 * KONVENSI PENAMAAN:
 *   - `XxxRow`      : bentuk baris MENTAH hasil query `pg` (snake_case, NUMERIC = string).
 *   - `Xxx`         : bentuk DOMAIN yang dipakai Controller/View (camelCase, angka = number).
 *   - `XxxInput`    : payload yang sudah tervalidasi & terkonversi, siap masuk Model.
 *   - `XxxResult`   : agregat hasil operasi bisnis.
 *
 * CATATAN PENTING SOAL NUMERIC:
 *   Driver `pg` mengembalikan kolom NUMERIC/DECIMAL sebagai STRING (bukan number)
 *   agar presisi uang tidak hilang. Karena itu seluruh field uang di `*Row`
 *   bertipe `DbNumeric` (= string) dan dikonversi ke `number` HANYA di layer Model.
 */

/* =============================================================================
 * 1. TIPE PRIMITIF & UTILITAS
 * ========================================================================== */

/** Representasi NUMERIC dari PostgreSQL: selalu string agar presisi uang utuh. */
export type DbNumeric = string;

/** Alias eksplisit untuk nilai yang boleh kosong dari database. */
export type Nullable<T> = T | null;

/** Kode status HTTP yang benar-benar dipakai aplikasi ini. */
export type HttpStatusCode = 200 | 201 | 302 | 400 | 404 | 409 | 422 | 500;

/** Kunci navigasi aktif pada partial `header.ejs`. */
export type NavKey = 'pos' | 'admin' | 'reports';

/** Konteks yang selalu dikirim ke setiap view agar header konsisten. */
export interface ViewContext {
  readonly activeNav: NavKey;
  readonly pageTitle: string;
  readonly appName: string;
}

/* =============================================================================
 * 2. PRODUK / MENU KANTIN
 * ========================================================================== */

/** Baris mentah tabel `products` (snake_case, price = string). */
export type ProductRow = {
  readonly id: number;
  readonly sku: string;
  readonly name: string;
  readonly category: string;
  readonly price: DbNumeric;
  readonly stock: number;
  readonly is_active: boolean;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** Entitas domain Produk yang dipakai Controller, View, dan Service. */
export interface Product {
  readonly id: number;
  readonly sku: string;
  readonly name: string;
  readonly category: string;
  readonly price: number;
  readonly stock: number;
  readonly isActive: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Baris produk yang dikunci saat checkout (`SELECT ... FOR UPDATE`). */
export type ProductForCheckoutRow = {
  readonly id: number;
  readonly sku: string;
  readonly name: string;
  readonly price: DbNumeric;
  readonly stock: number;
  readonly is_active: boolean;
}

/** Payload tervalidasi untuk membuat menu baru. */
export interface CreateProductInput {
  readonly sku: string;
  readonly name: string;
  readonly category: string;
  readonly price: number;
  readonly stock: number;
}

/**
 * Payload tervalidasi untuk mengubah menu.
 * Semua field opsional: hanya field yang dikirim yang akan di-UPDATE
 * (partial update), sehingga form edit stok tidak menimpa harga.
 */
export interface UpdateProductInput {
  readonly sku?: string;
  readonly name?: string;
  readonly category?: string;
  readonly price?: number;
  readonly stock?: number;
  readonly isActive?: boolean;
}

/** Filter daftar menu pada panel admin & terminal kasir. */
export interface ProductFilters {
  readonly search?: string;
  readonly category?: string;
  readonly onlyActive?: boolean;
}

/** Saran kategori untuk elemen <select> pada form admin. */
export const PRODUCT_CATEGORIES: readonly string[] = [
  'Makanan',
  'Minuman',
  'Snack',
  'Lainnya',
];

/** Ambang batas stok menipis (indikator amber pada UI, sesuai Bagian 3). */
export const LOW_STOCK_THRESHOLD = 5;

/* =============================================================================
 * 3. TRANSAKSI & CHECKOUT (ACID)
 * ========================================================================== */

/** Baris mentah tabel `transactions`. */
export type TransactionRow = {
  readonly id: number;
  readonly invoice_number: string;
  readonly total_amount: DbNumeric;
  readonly cash_paid: DbNumeric;
  readonly change_amount: DbNumeric;
  readonly created_at: Date;
}

/** Entitas domain Transaksi (header nota). */
export interface Transaction {
  readonly id: number;
  readonly invoiceNumber: string;
  readonly totalAmount: number;
  readonly cashPaid: number;
  readonly changeAmount: number;
  readonly createdAt: Date;
}

/** Baris mentah tabel `transaction_items`. */
export type TransactionItemRow = {
  readonly id: number;
  readonly transaction_id: number;
  readonly product_id: number;
  readonly quantity: number;
  readonly price_at_sale: DbNumeric;
  readonly subtotal: DbNumeric;
}

/** Baris mentah item transaksi hasil JOIN dengan `products` (struk & detail). */
export type TransactionItemDetailRow = {
  readonly id: number;
  readonly transaction_id: number;
  readonly product_id: number;
  readonly quantity: number;
  readonly price_at_sale: DbNumeric;
  readonly subtotal: DbNumeric;
  readonly sku: string;
  readonly name: string;
  readonly category: string;
};

/** Payload persistensi header transaksi (sudah dihitung & dibulatkan). */
export interface CreateTransactionInput {
  readonly invoiceNumber: string;
  readonly totalAmount: number;
  readonly cashPaid: number;
  readonly changeAmount: number;
}

/** Entitas domain item transaksi. */
export interface TransactionItem {
  readonly id: number;
  readonly transactionId: number;
  readonly productId: number;
  readonly quantity: number;
  readonly priceAtSale: number;
  readonly subtotal: number;
}

/** Item transaksi + data produk hasil JOIN, dipakai struk & halaman detail. */
export interface TransactionItemDetail extends TransactionItem {
  readonly sku: string;
  readonly productName: string;
  readonly category: string;
}

/** Transaksi lengkap beserta seluruh itemnya. */
export interface TransactionDetail {
  readonly transaction: Transaction;
  readonly items: readonly TransactionItemDetail[];
}

/** Satu baris keranjang yang dikirim kasir dari browser. */
export interface CheckoutItemInput {
  readonly productId: number;
  readonly quantity: number;
}

/** Payload tervalidasi untuk checkout. */
export interface CheckoutInput {
  readonly items: readonly CheckoutItemInput[];
  readonly cashPaid: number;
}

/**
 * Satu baris pesanan yang sudah diperkaya data produk dari database.
 * `priceAtSale` diambil dari harga saat checkout, bukan dari input client.
 */
export interface CheckoutLine {
  readonly productId: number;
  readonly sku: string;
  readonly name: string;
  readonly quantity: number;
  readonly priceAtSale: number;
  readonly subtotal: number;
}

/** Rencana checkout yang sudah dihitung totalnya, sebelum menyentuh database. */
export interface CheckoutPlan {
  readonly lines: readonly CheckoutLine[];
  readonly totalAmount: number;
}

/** Hasil akhir checkout yang sukses (dipakai untuk render struk). */
export interface CheckoutResult {
  readonly transaction: Transaction;
  readonly items: readonly TransactionItemDetail[];
  readonly totalAmount: number;
  readonly cashPaid: number;
  readonly changeAmount: number;
}

/* =============================================================================
 * 4. LAPORAN HARIAN
 * ========================================================================== */

/**
 * Baris agregasi laporan harian.
 * `SUM(quantity)` dan `COUNT(*)` menghasilkan BIGINT, yang oleh `pg`
 * dikembalikan sebagai string -> karena itu bertipe `DbNumeric`.
 * `SUM(...)` atas nol baris menghasilkan NULL -> `Nullable`.
 */
export type DailyReportItemRow = {
  readonly product_id: number;
  readonly sku: string;
  readonly name: string;
  readonly price_at_sale: DbNumeric;
  readonly total_quantity: DbNumeric;
  readonly total_revenue: DbNumeric;
}

/** Baris ringkasan metrik (satu baris agregat). */
export type DailyReportSummaryRow = {
  readonly total_revenue: Nullable<DbNumeric>;
  readonly total_transactions: DbNumeric;
  readonly total_items_sold: Nullable<DbNumeric>;
}

/** Rincian penjualan per menu pada laporan harian. */
export interface DailyReportItem {
  readonly productId: number;
  readonly sku: string;
  readonly name: string;
  readonly priceAtSale: number;
  readonly totalQuantity: number;
  readonly totalRevenue: number;
}

/** Tiga kartu metrik ringkasan pada halaman laporan. */
export interface DailyReportSummary {
  readonly totalRevenue: number;
  readonly totalTransactions: number;
  readonly totalItemsSold: number;
}

/** Data lengkap halaman laporan harian. */
export interface DailyReport {
  readonly date: string;
  readonly summary: DailyReportSummary;
  readonly items: readonly DailyReportItem[];
}

/** Rentang waktu setengah-terbuka [start, end) untuk satu hari kalender. */
export interface DateRange {
  readonly start: Date;
  readonly end: Date;
  readonly dateLabel: string;
}

/* =============================================================================
 * 5. STRUK PDF
 * ========================================================================== */

/** Identitas toko pada header struk, dibaca dari environment. */
export interface StoreProfile {
  readonly name: string;
  readonly address: string;
  readonly phone: string;
  readonly footer: string;
}

/** Data yang dibutuhkan `pdf.service.ts` untuk menggambar struk. */
export interface ReceiptPayload {
  readonly store: StoreProfile;
  readonly transaction: Transaction;
  readonly items: readonly TransactionItemDetail[];
}

/* =============================================================================
 * 6. KONTRAK HTTP (JSON API)
 * ========================================================================== */

/** Daftar kode error yang dikenali aplikasi. */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INSUFFICIENT_STOCK'
  | 'INSUFFICIENT_CASH'
  | 'EMPTY_CART'
  | 'INACTIVE_PRODUCT'
  | 'DATABASE_ERROR'
  | 'INTERNAL_ERROR';

/** Amplop respons sukses. */
export interface ApiSuccess<TData> {
  readonly success: true;
  readonly data: TData;
  readonly message?: string;
}

/** Amplop respons gagal. */
export interface ApiFailure {
  readonly success: false;
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly details?: readonly string[];
  };
}

/** Union bertag: konsumen wajib mempersempit lewat `success` sebelum mengakses `data`. */
export type ApiResponse<TData> = ApiSuccess<TData> | ApiFailure;

/* =============================================================================
 * 7. HASIL VALIDASI (tanpa exception untuk kegagalan yang wajar)
 * ========================================================================== */

export interface ValidationSuccess<TValue> {
  readonly ok: true;
  readonly value: TValue;
}

export interface ValidationFailure {
  readonly ok: false;
  readonly errors: readonly string[];
}

/**
 * Validator mengembalikan union ini, bukan melempar exception.
 * Controller cukup memeriksa `result.ok`; tidak ada `try/catch` yang
 * dipakai untuk alur normal, dan tidak ada `any` yang perlu di-cast.
 */
export type ValidationResult<TValue> = ValidationSuccess<TValue> | ValidationFailure;

/* =============================================================================
 * 8. ERROR APLIKASI
 * ========================================================================== */

/**
 * Error domain yang membawa status HTTP + kode error.
 *
 * Ditempatkan di `types/` karena blueprint Bagian 4 tidak menyediakan folder
 * `utils/`, dan file ini adalah satu-satunya modul yang diimpor semua layer.
 * Kelas ini tetap murni deklaratif: tanpa dependensi ke Express atau `pg`.
 */
export class AppError extends Error {
  public readonly statusCode: HttpStatusCode;
  public readonly code: ErrorCode;
  public readonly details: readonly string[];

  public constructor(
    statusCode: HttpStatusCode,
    code: ErrorCode,
    message: string,
    details: readonly string[] = [],
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  /** Bentuk siap-kirim untuk `res.status(...).json(...)`. */
  public toPayload(): ApiFailure {
    return {
      success: false,
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
      },
    };
  }
}

/**
 * Type guard untuk `catch (err: unknown)`.
 * Dipakai di seluruh controller agar `unknown` dapat dipersempit tanpa `any`.
 */
export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Type guard untuk memastikan nilai adalah objek biasa (bukan null/array/primitif). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}


/* =============================================================================
 * 9. UTILITAS WAKTU & ZONA WAKTU (DIPAKAI MODEL TRANSAKSI & LAPORAN)
 * ========================================================================== */

/** Zona waktu default bila APP_TIMEZONE tidak diset atau tidak valid. */
export const DEFAULT_TIME_ZONE = 'Asia/Jakarta';

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Zona waktu aplikasi; jatuh ke default bila env kosong atau tidak dikenal.
 * `Intl.DateTimeFormat` melempar RangeError untuk zona tak dikenal, dan itu
 * satu-satunya cara andal memvalidasi nama zona tanpa tabel IANA sendiri.
 */
export function resolveTimeZone(): string {
  const raw = process.env.APP_TIMEZONE;
  const candidate =
    typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : DEFAULT_TIME_ZONE;

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return candidate;
  } catch {
    console.warn(
      `[time] APP_TIMEZONE "${candidate}" tidak dikenal; memakai ${DEFAULT_TIME_ZONE}.`,
    );
    return DEFAULT_TIME_ZONE;
  }
}

/**
 * Memvalidasi kunci tanggal `YYYY-MM-DD`.
 * Pemeriksaan kalender sungguhan (bukan hanya regex) menolak `2026-02-30`,
 * yang akan lolos regex namun menggeser rentang laporan ke bulan Maret.
 */
export function isValidDateKey(value: string): boolean {
  const match = DATE_KEY_PATTERN.exec(value);
  if (match === null) {
    return false;
  }

  const [, yearPart, monthPart, dayPart] = match;
  if (yearPart === undefined || monthPart === undefined || dayPart === undefined) {
    return false;
  }

  const year = Number.parseInt(yearPart, 10);
  const month = Number.parseInt(monthPart, 10);
  const day = Number.parseInt(dayPart, 10);

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }
  if (year < 1970 || year > 2999 || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }

  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/**
 * Kunci tanggal `YYYYMMDD` pada zona waktu tertentu.
 * Memakai `Intl`, BUKAN `toISOString()`: transaksi pukul 00:30 WIB akan
 * tercatat sebagai tanggal kemarin bila dikonversi ke UTC lebih dulu.
 */
export function formatDateKey(
  date: Date,
  timeZone: string = DEFAULT_TIME_ZONE,
): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const lookup = (type: 'year' | 'month' | 'day'): string => {
    const found = parts.find((part) => part.type === type);
    if (found === undefined || found.value.length === 0) {
      throw new AppError(
        500,
        'INTERNAL_ERROR',
        `Gagal membaca komponen tanggal "${type}".`,
      );
    }
    return found.value;
  };

  return `${lookup('year')}${lookup('month')}${lookup('day')}`;
}

/** Selisih zona waktu terhadap UTC (milidetik) pada satu titik waktu. */
function getTimeZoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const read = (type: string): number => {
    const found = parts.find((part) => part.type === type);
    if (found === undefined) {
      throw new AppError(
        500,
        'INTERNAL_ERROR',
        `Gagal membaca komponen waktu "${type}".`,
      );
    }
    const parsed = Number.parseInt(found.value, 10);
    if (!Number.isFinite(parsed)) {
      throw new AppError(500, 'INTERNAL_ERROR', `Komponen waktu "${type}" tidak valid.`);
    }
    return parsed;
  };

  // Sebagian versi ICU mengembalikan jam 24 untuk tengah malam.
  const hour = read('hour') % 24;

  const asUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    hour,
    read('minute'),
    read('second'),
  );

  return asUtc - instant.getTime();
}

/**
 * Mengubah jam-dinding lokal (tahun, bulan, hari, 00:00) menjadi instant UTC.
 * Offset dihitung dua kali: tebakan pertama bisa mendarat di sisi lain
 * pergantian DST, sehingga offset pada instant hasilnya dipakai untuk koreksi.
 */
function zonedMidnightToUtc(
  year: number,
  month: number,
  day: number,
  timeZone: string,
): Date {
  const wallClockAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0);

  const firstOffset = getTimeZoneOffsetMs(new Date(wallClockAsUtc), timeZone);
  let candidate = wallClockAsUtc - firstOffset;

  const secondOffset = getTimeZoneOffsetMs(new Date(candidate), timeZone);
  if (secondOffset !== firstOffset) {
    candidate = wallClockAsUtc - secondOffset;
  }

  return new Date(candidate);
}

/**
 * Rentang setengah-terbuka `[start, end)` untuk satu hari kalender pada zona
 * waktu aplikasi, dinyatakan sebagai instant UTC.
 *
 * `end` dihitung dari tanggal kalender berikutnya, BUKAN `start + 24 jam`,
 * sehingga hari yang panjangnya 23 atau 25 jam karena DST tetap benar.
 */
export function getZonedDayRange(
  dateKey: string,
  timeZone: string = DEFAULT_TIME_ZONE,
): DateRange {
  if (!isValidDateKey(dateKey)) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `Tanggal "${dateKey}" tidak valid. Gunakan format YYYY-MM-DD.`,
    );
  }

  const match = DATE_KEY_PATTERN.exec(dateKey);
  if (match === null) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Tanggal tidak dapat dibaca.');
  }

  const [, yearPart, monthPart, dayPart] = match;
  if (yearPart === undefined || monthPart === undefined || dayPart === undefined) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Tanggal tidak dapat dibaca.');
  }

  const year = Number.parseInt(yearPart, 10);
  const month = Number.parseInt(monthPart, 10);
  const day = Number.parseInt(dayPart, 10);

  const start = zonedMidnightToUtc(year, month, day, timeZone);

  // `Date.UTC` menormalkan overflow (31 Desember + 1 hari -> 1 Januari).
  const nextDay = new Date(Date.UTC(year, month - 1, day + 1));
  const end = zonedMidnightToUtc(
    nextDay.getUTCFullYear(),
    nextDay.getUTCMonth() + 1,
    nextDay.getUTCDate(),
    timeZone,
  );

  const dateLabel = new Intl.DateTimeFormat('id-ID', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone,
  }).format(start);

  return { start, end, dateLabel };
}


/* =============================================================================
 * 10. UTILITAS VALIDASI FORM & KONTEKS VIEW
 * ========================================================================== */

/**
 * Menormalkan nilai mentah dari `req.body` / `req.query` menjadi string bersih.
 *
 * `req.body` dapat berisi string (form HTML), number/boolean (klien JSON),
 * atau array (field ganda). Fungsi ini adalah SATU-SATUNYA pintu masuk nilai
 * form, sehingga tidak ada `as string` yang tersebar di controller.
 * String kosong / hanya spasi dianggap TIDAK DIKIRIM.
 */
export function readFormValue(raw: unknown): string | undefined {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? String(raw) : undefined;
  }
  if (typeof raw === 'boolean') {
    return raw ? 'true' : 'false';
  }
  if (Array.isArray(raw)) {
    const first: unknown = raw[0];
    return readFormValue(first);
  }
  return undefined;
}

/** Pola angka desimal; minus diizinkan agar pesan error bisa menyebut "negatif". */
const DECIMAL_PATTERN = /^-?\d+(\.\d{1,2})?$/;

/** Pola bilangan bulat; minus diizinkan dengan alasan yang sama. */
const INTEGER_PATTERN = /^-?\d+$/;

/** Teks wajib dengan batas panjang. */
export function parseTextField(
  raw: string | undefined,
  label: string,
  maxLength: number,
): ValidationResult<string> {
  if (raw === undefined) {
    return { ok: false, errors: [`${label} wajib diisi.`] };
  }
  const value = raw.trim();
  if (value.length === 0) {
    return { ok: false, errors: [`${label} wajib diisi.`] };
  }
  if (value.length > maxLength) {
    return { ok: false, errors: [`${label} maksimal ${maxLength} karakter.`] };
  }
  return { ok: true, value };
}

/**
 * Angka desimal untuk kolom uang.
 *
 * `Number.parseFloat('12abc')` menghasilkan 12, jadi pola regex dipakai lebih
 * dulu: hanya digit dengan maksimal 2 desimal yang diterima. Notasi ilmiah
 * (`1e5`) dan heksadesimal (`0x10`) ikut ditolak.
 *
 * Hasil dibulatkan ke 2 desimal agar cocok dengan NUMERIC(12,2); tanpa ini,
 * nilai seperti 1500.005 akan dibulatkan berbeda oleh PostgreSQL.
 */
export function parseDecimalField(
  raw: string | undefined,
  label: string,
  min: number,
  max: number,
): ValidationResult<number> {
  if (raw === undefined) {
    return { ok: false, errors: [`${label} wajib diisi.`] };
  }
  const value = raw.trim();
  if (!DECIMAL_PATTERN.test(value)) {
    return {
      ok: false,
      errors: [`${label} harus berupa angka dengan maksimal 2 angka desimal.`],
    };
  }
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    return { ok: false, errors: [`${label} bukan angka yang valid.`] };
  }
  const rounded = Math.round((parsed + Number.EPSILON) * 100) / 100;
  if (rounded < min) {
    return { ok: false, errors: [`${label} tidak boleh kurang dari ${min}.`] };
  }
  if (rounded > max) {
    return { ok: false, errors: [`${label} tidak boleh lebih dari ${max}.`] };
  }
  return { ok: true, value: rounded };
}

/** Bilangan bulat (stok, kuantitas) dengan batas bawah dan atas. */
export function parseIntegerField(
  raw: string | undefined,
  label: string,
  min: number,
  max: number,
): ValidationResult<number> {
  if (raw === undefined) {
    return { ok: false, errors: [`${label} wajib diisi.`] };
  }
  const value = raw.trim();
  if (!INTEGER_PATTERN.test(value)) {
    return { ok: false, errors: [`${label} harus berupa bilangan bulat.`] };
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    return { ok: false, errors: [`${label} di luar jangkauan angka yang aman.`] };
  }
  if (parsed < min) {
    return { ok: false, errors: [`${label} tidak boleh kurang dari ${min}.`] };
  }
  if (parsed > max) {
    return { ok: false, errors: [`${label} tidak boleh lebih dari ${max}.`] };
  }
  return { ok: true, value: parsed };
}

/**
 * Mengambil nilai hasil validasi sambil menumpuk pesan error.
 * Mengembalikan `null` bila gagal, sehingga pemanggil cukup memeriksa
 * `errors.length` sekali di akhir alih-alih bercabang di setiap field.
 */
export function unwrapOrCollect<T>(
  result: ValidationResult<T>,
  errors: string[],
): T | null {
  if (result.ok) {
    return result.value;
  }
  errors.push(...result.errors);
  return null;
}

/** Konteks view standar untuk partial `header.ejs`. */
export function createViewContext(activeNav: NavKey, pageTitle: string): ViewContext {
  const raw = process.env.APP_NAME;
  const appName =
    typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : 'Kantin POS';
  return { activeNav, pageTitle, appName };
}

/* =============================================================================
 * 11. KONTRAK RESPONS CHECKOUT
 * ========================================================================== */

/** Hasil checkout yang dikirim ke kasir, termasuk URL halaman struk. */
export interface CheckoutResponse extends CheckoutResult {
  readonly receiptUrl: string;
}
