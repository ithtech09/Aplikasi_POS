/**
 * =============================================================================
 * src/models/transaction.model.ts
 * Query SQL & transaksi ACID untuk tabel `transactions` + `transaction_items`.
 * =============================================================================
 *
 * File ini adalah inti jaminan ACID aplikasi. Seluruh fungsi yang menulis
 * WAJIB menerima `PoolClient` dari `withTransaction()` sehingga BEGIN/COMMIT/
 * ROLLBACK dikendalikan satu tempat, dan tidak ada statement yang lolos ke
 * koneksi lain di luar transaksi.
 *
 * TANGGUNG JAWAB: hanya SQL + pemetaan tipe. Tidak ada `req`/`res`, tidak ada
 * perhitungan bisnis checkout (itu tugas Controller), tidak ada stream PDF.
 */

import type { PoolClient } from 'pg';
import { query, toAppError, type PgErrorTranslation } from '../config/database';
import {
  AppError,
  formatDateKey,
  resolveTimeZone,
  type CheckoutLine,
  type CreateTransactionInput,
  type DbNumeric,
  type Transaction,
  type TransactionDetail,
  type TransactionItem,
  type TransactionItemDetail,
  type TransactionItemDetailRow,
  type TransactionItemRow,
  type TransactionRow,
} from '../types';

export { formatDateKey };

/* =============================================================================
 * 1. KONSTANTA
 * ========================================================================== */

const INVOICE_PREFIX = 'INV';
const INVOICE_SUFFIX_WIDTH = 4;

/**
 * Namespace kunci advisory PostgreSQL untuk penomoran nota.
 * Nilai tetap (bukan hasil hash) agar penomoran tetap deterministik dan
 * tidak bergantung pada fungsi internal `hashtext()` yang tidak terdokumentasi.
 */
const INVOICE_LOCK_NAMESPACE = 20_260_101;

const TRANSACTION_COLUMNS =
  'id, invoice_number, total_amount, cash_paid, change_amount, created_at';

const ITEM_COLUMNS =
  'id, transaction_id, product_id, quantity, price_at_sale, subtotal';

/** SELECT item + produk; dipakai struk, halaman detail, dan hasil checkout. */
const ITEM_DETAIL_SELECT = `
  SELECT ti.id,
         ti.transaction_id,
         ti.product_id,
         ti.quantity,
         ti.price_at_sale,
         ti.subtotal,
         p.sku,
         p.name,
         p.category
  FROM transaction_items ti
  JOIN products p ON p.id = ti.product_id
  WHERE ti.transaction_id = $1
  ORDER BY ti.id ASC
`;

/** Pesan ramah untuk constraint pada tabel transaksi. */
const TRANSACTION_ERROR_TRANSLATION: PgErrorTranslation = {
  logPrefix: '[transaction.model]',
  uniqueViolation: 'Nomor nota sudah dipakai. Silakan ulangi transaksi.',
  foreignKeyViolation: 'Transaksi merujuk menu yang tidak tersedia.',
  constraints: {
    transactions_cash_covers_total:
      'Uang tunai yang dibayarkan kurang dari total belanja.',
    transactions_change_consistent:
      'Perhitungan kembalian tidak konsisten dengan total dan uang tunai.',
    transactions_total_non_negative: 'Total belanja tidak boleh bernilai negatif.',
    transactions_cash_non_negative: 'Uang tunai tidak boleh bernilai negatif.',
    transactions_change_non_negative: 'Kembalian tidak boleh bernilai negatif.',
    transactions_invoice_not_blank: 'Nomor nota tidak boleh kosong.',
    transaction_items_quantity_positive: 'Jumlah porsi harus lebih dari nol.',
    transaction_items_price_non_negative:
      'Harga saat transaksi tidak boleh bernilai negatif.',
    transaction_items_subtotal_non_negative: 'Subtotal tidak boleh bernilai negatif.',
    transaction_items_subtotal_consistent:
      'Subtotal tidak konsisten dengan harga satuan dikali jumlah porsi.',
  },
};

/* =============================================================================
 * 2. UTILITAS UANG & WAKTU
 * ========================================================================== */

/**
 * Membulatkan nilai uang ke 2 desimal.
 *
 * WAJIB dipakai Controller saat menghitung total & kembalian, agar nilai yang
 * dikirim ke NUMERIC(12,2) sudah eksak. Tanpa ini, `0.1 + 0.2` menghasilkan
 * 0.30000000000000004 dan CHECK `change_amount = cash_paid - total_amount`
 * bisa gagal karena pembulatan yang berbeda di dua sisi.
 */
export function roundMoney(value: number): number {
  if (!Number.isFinite(value)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Nilai uang tidak valid.');
  }
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** NUMERIC (string) -> number, dengan penjagaan terhadap nilai korup. */
function toMoney(value: DbNumeric): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new AppError(
      500,
      'DATABASE_ERROR',
      'Nilai uang pada database tidak dapat dibaca sebagai angka.',
    );
  }
  return parsed;
}

/* =============================================================================
 * 3. PEMETAAN BARIS -> ENTITAS DOMAIN
 * ========================================================================== */

function mapTransactionRow(row: TransactionRow): Transaction {
  return {
    id: row.id,
    invoiceNumber: row.invoice_number,
    totalAmount: toMoney(row.total_amount),
    cashPaid: toMoney(row.cash_paid),
    changeAmount: toMoney(row.change_amount),
    createdAt: row.created_at,
  };
}

function mapItemRow(row: TransactionItemRow): TransactionItem {
  return {
    id: row.id,
    transactionId: row.transaction_id,
    productId: row.product_id,
    quantity: row.quantity,
    priceAtSale: toMoney(row.price_at_sale),
    subtotal: toMoney(row.subtotal),
  };
}

function mapItemDetailRow(row: TransactionItemDetailRow): TransactionItemDetail {
  return {
    id: row.id,
    transactionId: row.transaction_id,
    productId: row.product_id,
    quantity: row.quantity,
    priceAtSale: toMoney(row.price_at_sale),
    subtotal: toMoney(row.subtotal),
    sku: row.sku,
    productName: row.name,
    category: row.category,
  };
}

/* =============================================================================
 * 4. PENOMORAN NOTA (RACE-SAFE)
 * ========================================================================== */

/**
 * Membuat nomor nota berikutnya: `INV-YYYYMMDD-NNNN`.
 *
 * MASALAH: `SELECT MAX(...) + 1` tanpa penguncian membuat dua kasir yang
 * checkout bersamaan memperoleh nomor yang sama, lalu salah satunya gagal
 * karena UNIQUE constraint — transaksi sah ikut batal.
 *
 * SOLUSI: `pg_advisory_xact_lock` per tanggal. Lock ini otomatis dilepas saat
 * COMMIT/ROLLBACK dan hanya menyerialkan pembuatan nomor nota pada hari yang
 * sama, bukan seluruh transaksi. Kunci memakai dua int4 (namespace + tanggal)
 * sehingga tidak bergantung pada `hashtext()`.
 *
 * WAJIB dipanggil di dalam transaksi yang sama dengan INSERT header.
 */
export async function nextInvoiceNumber(
  client: PoolClient,
  now: Date = new Date(),
): Promise<string> {
  const dateKey = formatDateKey(now, resolveTimeZone());
  const lockKey = Number.parseInt(dateKey, 10);

  if (!Number.isInteger(lockKey) || lockKey <= 0) {
    throw new AppError(
      500,
      'INTERNAL_ERROR',
      'Kunci tanggal untuk penomoran nota tidak valid.',
    );
  }

  const prefix = `${INVOICE_PREFIX}-${dateKey}-`;

  try {
    await client.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [
      INVOICE_LOCK_NAMESPACE,
      lockKey,
    ]);

    // ORDER BY length DESC lalu nilai DESC: tetap benar ketika nomor melewati
    // 9999 (lebar 5 digit) karena perbandingan string biasa akan salah urut.
    const last = await client.query<{ invoice_number: string }>(
      `SELECT invoice_number
       FROM transactions
       WHERE invoice_number LIKE $1
       ORDER BY length(invoice_number) DESC, invoice_number DESC
       LIMIT 1`,
      [`${prefix}%`],
    );

    const lastRow = last.rows[0];
    let nextSequence = 1;

    if (lastRow !== undefined) {
      const match = /^INV-\d{8}-(\d+)$/.exec(lastRow.invoice_number);
      const digits = match?.[1];

      if (digits !== undefined) {
        nextSequence = Number.parseInt(digits, 10) + 1;
      } else {
        // Nomor dengan format tak terduga: hitung saja jumlah nota hari itu.
        const counted = await client.query<{ total: string }>(
          'SELECT COUNT(*)::text AS total FROM transactions WHERE invoice_number LIKE $1',
          [`${prefix}%`],
        );
        const totalRow = counted.rows[0];
        nextSequence = totalRow === undefined ? 1 : Number.parseInt(totalRow.total, 10) + 1;
      }
    }

    return `${prefix}${String(nextSequence).padStart(INVOICE_SUFFIX_WIDTH, '0')}`;
  } catch (error: unknown) {
    throw toAppError(error, TRANSACTION_ERROR_TRANSLATION);
  }
}

/* =============================================================================
 * 5. OPERASI TULIS (WAJIB DI DALAM TRANSAKSI)
 * ========================================================================== */

/**
 * Menyimpan header transaksi.
 *
 * Nilai uang dibulatkan ke 2 desimal sebelum dikirim, agar CHECK
 * `change_amount = cash_paid - total_amount` selalu terpenuhi secara eksak.
 */
export async function createHeader(
  client: PoolClient,
  input: CreateTransactionInput,
): Promise<Transaction> {
  const totalAmount = roundMoney(input.totalAmount);
  const cashPaid = roundMoney(input.cashPaid);
  const changeAmount = roundMoney(input.changeAmount);

  const sql = `
    INSERT INTO transactions (invoice_number, total_amount, cash_paid, change_amount)
    VALUES ($1, $2, $3, $4)
    RETURNING ${TRANSACTION_COLUMNS}
  `;

  try {
    const result = await client.query<TransactionRow>(sql, [
      input.invoiceNumber,
      totalAmount,
      cashPaid,
      changeAmount,
    ]);

    const row = result.rows[0];
    if (row === undefined) {
      throw new AppError(
        500,
        'DATABASE_ERROR',
        'Transaksi gagal disimpan: database tidak mengembalikan data.',
      );
    }
    return mapTransactionRow(row);
  } catch (error: unknown) {
    throw toAppError(error, TRANSACTION_ERROR_TRANSLATION);
  }
}

/**
 * Menyimpan seluruh item nota dalam SATU statement INSERT multi-baris.
 *
 * Satu statement, bukan N statement dalam loop: perjalanan bolak-balik ke
 * database berkurang dari N+1 menjadi 1, dan seluruh item berada dalam
 * transaksi yang sama sehingga tidak mungkin tersimpan sebagian.
 */
export async function createItems(
  client: PoolClient,
  transactionId: number,
  lines: readonly CheckoutLine[],
): Promise<TransactionItem[]> {
  if (lines.length === 0) {
    return [];
  }

  const placeholders: string[] = [];
  const params: unknown[] = [];

  lines.forEach((line, index) => {
    const base = index * 5;
    placeholders.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`,
    );
    params.push(
      transactionId,
      line.productId,
      line.quantity,
      roundMoney(line.priceAtSale),
      roundMoney(line.subtotal),
    );
  });

  const sql = `
    INSERT INTO transaction_items
      (transaction_id, product_id, quantity, price_at_sale, subtotal)
    VALUES ${placeholders.join(', ')}
    RETURNING ${ITEM_COLUMNS}
  `;

  try {
    const result = await client.query<TransactionItemRow>(sql, params);
    return result.rows.map(mapItemRow);
  } catch (error: unknown) {
    throw toAppError(error, TRANSACTION_ERROR_TRANSLATION);
  }
}

/* =============================================================================
 * 6. OPERASI BACA
 * ========================================================================== */

/** Mengambil header transaksi berdasarkan id. `null` bila tidak ada. */
export async function findById(id: number): Promise<Transaction | null> {
  try {
    const result = await query<TransactionRow>(
      `SELECT ${TRANSACTION_COLUMNS} FROM transactions WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapTransactionRow(row);
  } catch (error: unknown) {
    throw toAppError(error, TRANSACTION_ERROR_TRANSLATION);
  }
}

/** Mengambil item + data produk memakai koneksi pool (non-transaksional). */
export async function findItemsByTransactionId(
  transactionId: number,
): Promise<TransactionItemDetail[]> {
  try {
    const result = await query<TransactionItemDetailRow>(ITEM_DETAIL_SELECT, [
      transactionId,
    ]);
    return result.rows.map(mapItemDetailRow);
  } catch (error: unknown) {
    throw toAppError(error, TRANSACTION_ERROR_TRANSLATION);
  }
}

/**
 * Versi transaksional dari pembacaan item.
 * Dipakai tepat setelah `createItems` agar data yang dikembalikan ke kasir
 * berasal dari database (bukan dari objek di memori), sehingga struk tidak
 * pernah menampilkan angka yang berbeda dari yang tersimpan.
 */
export async function findItemsByTransactionIdTx(
  client: PoolClient,
  transactionId: number,
): Promise<TransactionItemDetail[]> {
  try {
    const result = await client.query<TransactionItemDetailRow>(ITEM_DETAIL_SELECT, [
      transactionId,
    ]);
    return result.rows.map(mapItemDetailRow);
  } catch (error: unknown) {
    throw toAppError(error, TRANSACTION_ERROR_TRANSLATION);
  }
}

/**
 * Mengambil transaksi lengkap beserta itemnya untuk halaman struk & PDF.
 * `null` bila transaksi tidak ditemukan.
 */
export async function findDetailById(id: number): Promise<TransactionDetail | null> {
  const transaction = await findById(id);
  if (transaction === null) {
    return null;
  }
  const items = await findItemsByTransactionId(id);
  return { transaction, items };
}

/* =============================================================================
 * 7. EKSPOR NAMA DEFAULT
 * ========================================================================== */

const transactionModel = {
  roundMoney,
  formatDateKey,
  nextInvoiceNumber,
  createHeader,
  createItems,
  findById,
  findItemsByTransactionId,
  findItemsByTransactionIdTx,
  findDetailById,
} as const;

export default transactionModel;
