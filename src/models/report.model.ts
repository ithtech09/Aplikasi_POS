/**
 * =============================================================================
 * src/models/report.model.ts
 * Query SQL agregasi laporan penjualan harian.
 * =============================================================================
 *
 * TANGGUNG JAWAB: hanya SQL agregasi + pemetaan tipe. Tidak ada `req`/`res`,
 * tidak ada pemformatan tampilan (itu tugas View).
 *
 * KEPUTUSAN PENTING — BATAS HARI:
 *   Kolom `transactions.created_at` bertipe TIMESTAMP (tanpa zona waktu),
 *   sehingga nilainya adalah jam-dinding pada zona waktu sesi database.
 *   Agar laporan tetap benar meskipun zona waktu server database berbeda dari
 *   APP_TIMEZONE, perbandingan dilakukan sebagai berikut:
 *
 *     created_at AT TIME ZONE current_setting('TimeZone')  -> timestamptz
 *
 *   Hasilnya instant absolut, lalu dibandingkan dengan batas hari yang sudah
 *   dihitung sebagai instant UTC oleh `getZonedDayRange()`. Tidak ada
 *   ketergantungan pada asumsi "server DB memakai WIB".
 *
 *   Konsekuensi: predikat ini tidak dapat memakai index B-Tree biasa pada
 *   `created_at`. Untuk volume kantin (ratusan nota/hari) hal ini tidak
 *   terasa. Bila volume tumbuh, tambahkan index fungsional:
 *     CREATE INDEX ... ON transactions ((created_at AT TIME ZONE 'Asia/Jakarta'));
 */

import { query, toAppError, type PgErrorTranslation } from '../config/database';
import {
  AppError,
  getZonedDayRange,
  resolveTimeZone,
  type DailyReport,
  type DailyReportItem,
  type DailyReportItemRow,
  type DailyReportSummary,
  type DailyReportSummaryRow,
  type DbNumeric,
  type Nullable,
} from '../types';

/* =============================================================================
 * 1. KONSTANTA
 * ========================================================================== */

const REPORT_ERROR_TRANSLATION: PgErrorTranslation = {
  logPrefix: '[report.model]',
  uniqueViolation: 'Terjadi konflik data saat menyusun laporan.',
  foreignKeyViolation: 'Laporan merujuk data yang sudah tidak tersedia.',
};

/**
 * Predikat rentang waktu untuk satu alias tabel `transactions`.
 * Nomor parameter diberikan pemanggil agar dapat digabung dengan parameter lain.
 */
function buildRangePredicate(alias: string, startParam: number, endParam: number): string {
  const instant = `${alias}.created_at AT TIME ZONE current_setting('TimeZone')`;
  return `${instant} >= $${startParam}::timestamptz AND ${instant} < $${endParam}::timestamptz`;
}

/* =============================================================================
 * 2. PEMETAAN NILAI AGREGAT
 * ========================================================================== */

/**
 * Mengubah agregat uang menjadi number.
 * `null` berarti tidak ada baris (omzet nol) dan dipetakan ke 0.
 * Nilai non-null yang tidak dapat dibaca dianggap kerusakan data dan ditolak,
 * bukan diam-diam menjadi 0 — omzet yang salah lebih berbahaya daripada error.
 */
function toMoney(value: Nullable<DbNumeric>): number {
  if (value === null) {
    return 0;
  }
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new AppError(
      500,
      'DATABASE_ERROR',
      'Nilai uang pada laporan tidak dapat dibaca sebagai angka.',
    );
  }
  return parsed;
}

/** Mengubah agregat cacah (BIGINT -> string) menjadi number. */
function toCount(value: Nullable<DbNumeric>): number {
  if (value === null) {
    return 0;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new AppError(
      500,
      'DATABASE_ERROR',
      'Nilai cacah pada laporan tidak dapat dibaca sebagai angka.',
    );
  }
  return parsed;
}

/* =============================================================================
 * 3. QUERY AGREGASI
 * ========================================================================== */

/**
 * Ringkasan tiga kartu metrik untuk satu rentang waktu.
 *
 * Omzet diambil dari `transactions.total_amount` (uang yang benar-benar
 * diterima), BUKAN dari penjumlahan subtotal item — keduanya bisa berbeda
 * bila ada penyesuaian di masa depan, dan omzet adalah angka yang dilaporkan.
 *
 * Seluruh agregat dibungkus COALESCE agar tanggal tanpa transaksi
 * menghasilkan 0, bukan NULL yang tampil sebagai "NaN" di kartu metrik.
 */
export async function findDailySummary(
  start: Date,
  end: Date,
): Promise<DailyReportSummary> {
  const sql = `
    WITH filtered AS (
      SELECT t.id, t.total_amount
      FROM transactions t
      WHERE ${buildRangePredicate('t', 1, 2)}
    )
    SELECT
      COALESCE((SELECT SUM(f.total_amount) FROM filtered f), 0)::text AS total_revenue,
      (SELECT COUNT(*) FROM filtered)::text                            AS total_transactions,
      COALESCE(
        (SELECT SUM(ti.quantity)
         FROM transaction_items ti
         JOIN filtered f ON f.id = ti.transaction_id),
        0
      )::text                                                          AS total_items_sold
  `;

  try {
    const result = await query<DailyReportSummaryRow>(sql, [
      start.toISOString(),
      end.toISOString(),
    ]);

    const row = result.rows[0];
    if (row === undefined) {
      // Agregat tanpa GROUP BY selalu mengembalikan tepat satu baris.
      throw new AppError(
        500,
        'DATABASE_ERROR',
        'Laporan harian tidak mengembalikan baris ringkasan.',
      );
    }

    return {
      totalRevenue: toMoney(row.total_revenue),
      totalTransactions: toCount(row.total_transactions),
      totalItemsSold: toCount(row.total_items_sold),
    };
  } catch (error: unknown) {
    throw toAppError(error, REPORT_ERROR_TRANSLATION);
  }
}

/**
 * Rincian penjualan per menu untuk satu rentang waktu.
 *
 * PENGELOMPOKAN: per `product_id` (satu baris per menu), bukan per
 * `price_at_sale`. Bila harga menu berubah di tengah hari, "Harga Satuan"
 * ditampilkan sebagai harga rata-rata tertimbang (total pendapatan dibagi
 * total porsi). Pada hari tanpa perubahan harga — kasus normal — nilainya
 * sama persis dengan harga menu.
 */
export async function findDailyItems(
  start: Date,
  end: Date,
): Promise<DailyReportItem[]> {
  const sql = `
    SELECT
      ti.product_id,
      p.sku,
      p.name,
      ROUND(SUM(ti.subtotal) / NULLIF(SUM(ti.quantity), 0), 2)::text AS price_at_sale,
      SUM(ti.quantity)::text                                        AS total_quantity,
      SUM(ti.subtotal)::text                                        AS total_revenue
    FROM transaction_items ti
    JOIN transactions t ON t.id = ti.transaction_id
    JOIN products p     ON p.id = ti.product_id
    WHERE ${buildRangePredicate('t', 1, 2)}
    GROUP BY ti.product_id, p.sku, p.name
    ORDER BY SUM(ti.subtotal) DESC, p.name ASC
  `;

  try {
    const result = await query<DailyReportItemRow>(sql, [
      start.toISOString(),
      end.toISOString(),
    ]);

    return result.rows.map((row: DailyReportItemRow): DailyReportItem => ({
      productId: row.product_id,
      sku: row.sku,
      name: row.name,
      priceAtSale: toMoney(row.price_at_sale),
      totalQuantity: toCount(row.total_quantity),
      totalRevenue: toMoney(row.total_revenue),
    }));
  } catch (error: unknown) {
    throw toAppError(error, REPORT_ERROR_TRANSLATION);
  }
}

/* =============================================================================
 * 4. LAPORAN LENGKAP
 * ========================================================================== */

/**
 * Menyusun laporan harian lengkap untuk satu tanggal `YYYY-MM-DD`.
 *
 * Bila `dateKey` tidak diberikan, dipakai tanggal hari ini menurut
 * APP_TIMEZONE — bukan tanggal server, agar kasir yang membuka laporan pukul
 * 00:10 WIB tidak melihat laporan hari kemarin.
 *
 * Kedua query dijalankan paralel: keduanya membaca data yang sama dan tidak
 * saling bergantung, sehingga latensi total mengikuti query terlama.
 */
export async function findDailyReport(dateKey?: string): Promise<DailyReport> {
  const timeZone = resolveTimeZone();

  const resolvedKey =
    dateKey === undefined || dateKey.trim().length === 0
      ? formatTodayKey(timeZone)
      : dateKey.trim();

  const range = getZonedDayRange(resolvedKey, timeZone);

  const [summary, items] = await Promise.all([
    findDailySummary(range.start, range.end),
    findDailyItems(range.start, range.end),
  ]);

  return {
    date: resolvedKey,
    summary,
    items,
  };
}

/** Tanggal hari ini sebagai `YYYY-MM-DD` pada zona waktu aplikasi. */
export function formatTodayKey(timeZone: string = resolveTimeZone()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());

  const read = (type: 'year' | 'month' | 'day'): string => {
    const found = parts.find((part) => part.type === type);
    if (found === undefined || found.value.length === 0) {
      throw new AppError(500, 'INTERNAL_ERROR', `Gagal membaca komponen "${type}".`);
    }
    return found.value;
  };

  return `${read('year')}-${read('month')}-${read('day')}`;
}

/* =============================================================================
 * 5. EKSPOR NAMA DEFAULT
 * ========================================================================== */

const reportModel = {
  findDailySummary,
  findDailyItems,
  findDailyReport,
  formatTodayKey,
} as const;

export default reportModel;
