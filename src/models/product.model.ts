/**
 * =============================================================================
 * src/models/product.model.ts
 * Query SQL & pemetaan tipe untuk tabel `products` (menu kantin).
 * =============================================================================
 *
 * BATAS TANGGUNG JAWAB (Bagian 5 blueprint):
 *   - HANYA mengeksekusi SQL dan mengembalikan data bertipe.
 *   - DILARANG menyentuh `req` / `res`.
 *   - SELURUH nilai masuk lewat Parameterized Query ($1, $2, ...) — tidak ada
 *     satu pun nilai yang disisipkan ke dalam string SQL.
 *
 * KONVERSI UANG:
 *   `pg` mengembalikan NUMERIC sebagai string. Konversi ke `number` terjadi
 *   HANYA di sini (fungsi `toMoney`), sehingga layer di atas selalu menerima
 *   angka dan tidak pernah menjumlahkan string secara tidak sengaja.
 */

import type { PoolClient } from 'pg';
import { query, toAppError, type PgErrorTranslation } from '../config/database';
import {
  AppError,
  type CreateProductInput,
  type DbNumeric,
  type Product,
  type ProductFilters,
  type ProductForCheckoutRow,
  type ProductRow,
  type UpdateProductInput,
} from '../types';

/* =============================================================================
 * 1. KONSTANTA SQL
 * ========================================================================== */

/** Daftar kolom eksplisit; `SELECT *` dihindari agar urutan kolom tidak rapuh. */
const PRODUCT_COLUMNS =
  'id, sku, name, category, price, stock, is_active, created_at, updated_at';

/** Pesan ramah untuk setiap CHECK constraint pada tabel `products`. */
const CHECK_CONSTRAINT_MESSAGES: Readonly<Record<string, string>> = {
  products_price_non_negative: 'Harga menu tidak boleh bernilai negatif.',
  products_stock_non_negative: 'Stok porsi tidak boleh bernilai negatif.',
  products_sku_not_blank: 'Kode menu (SKU) tidak boleh kosong.',
  products_name_not_blank: 'Nama menu tidak boleh kosong.',
  products_category_not_blank: 'Kategori menu tidak boleh kosong.',
};

/* =============================================================================
 * 2. PEMETAAN BARIS -> ENTITAS DOMAIN
 * ========================================================================== */

/**
 * Mengubah NUMERIC (string) menjadi number dengan pemeriksaan ketat.
 * Nilai korup dari database tidak boleh menjadi `NaN` yang menyebar diam-diam
 * ke perhitungan total dan kembalian.
 */
function toMoney(value: DbNumeric): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new AppError(
      500,
      'DATABASE_ERROR',
      'Nilai harga pada database tidak dapat dibaca sebagai angka.',
    );
  }
  return parsed;
}

/** Memetakan satu baris mentah `products` menjadi entitas domain. */
function mapProductRow(row: ProductRow): Product {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    category: row.category,
    price: toMoney(row.price),
    stock: row.stock,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/* =============================================================================
 * 3. PENERJEMAH ERROR POSTGRESQL (DELEGASI KE config/database.ts)
 * ========================================================================== */

/**
 * Pesan ramah khusus domain menu. Kode SQLSTATE generik (23505, 23503, 22P02)
 * ditangani terpusat oleh `toAppError`; di sini hanya teks spesifik tabel
 * `products` yang disuplai.
 */
const PRODUCT_ERROR_TRANSLATION: PgErrorTranslation = {
  logPrefix: '[product.model]',
  uniqueViolation: 'Kode menu (SKU) sudah digunakan oleh menu lain.',
  foreignKeyViolation:
    'Menu ini masih dirujuk oleh data transaksi sehingga tidak dapat dihapus permanen.',
  constraints: CHECK_CONSTRAINT_MESSAGES,
};

/**
 * Melarikan karakter wildcard LIKE (`%`, `_`, `\`) pada kata kunci pencarian.
 * Tanpa ini, kasir yang mengetik `_` akan mencocokkan SEMUA menu, dan `%`
 * membuat pencarian mengembalikan seluruh katalog.
 */
function escapeLikePattern(raw: string): string {
  return raw.replace(/[\\%_]/g, (character: string): string => `\\${character}`);
}

/* =============================================================================
 * 4. OPERASI BACA
 * ========================================================================== */

/**
 * Mengambil daftar menu dengan filter opsional.
 * Urutan: menu aktif lebih dulu, lalu kategori, lalu nama — agar tampilan
 * terminal kasir stabil dan tidak "melompat" antar-render.
 */
export async function findAll(filters: ProductFilters = {}): Promise<Product[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.onlyActive === true) {
    conditions.push('is_active = TRUE');
  }

  const search = filters.search?.trim();
  if (search !== undefined && search.length > 0) {
    params.push(`%${escapeLikePattern(search.toLowerCase())}%`);
    const placeholder = `$${params.length}`;
    conditions.push(`(lower(name) LIKE ${placeholder} OR lower(sku) LIKE ${placeholder})`);
  }

  const category = filters.category?.trim();
  if (category !== undefined && category.length > 0) {
    params.push(category);
    conditions.push(`category = $${params.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `
    SELECT ${PRODUCT_COLUMNS}
    FROM products
    ${whereClause}
    ORDER BY is_active DESC, category ASC, name ASC
  `;

  try {
    const result = await query<ProductRow>(sql, params);
    return result.rows.map(mapProductRow);
  } catch (error: unknown) {
    throw toAppError(error, PRODUCT_ERROR_TRANSLATION);
  }
}

/** Mengambil satu menu berdasarkan primary key. `null` bila tidak ditemukan. */
export async function findById(id: number): Promise<Product | null> {
  try {
    const result = await query<ProductRow>(
      `SELECT ${PRODUCT_COLUMNS} FROM products WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapProductRow(row);
  } catch (error: unknown) {
    throw toAppError(error, PRODUCT_ERROR_TRANSLATION);
  }
}

/** Mengambil satu menu berdasarkan SKU. `null` bila tidak ditemukan. */
export async function findBySku(sku: string): Promise<Product | null> {
  try {
    const result = await query<ProductRow>(
      `SELECT ${PRODUCT_COLUMNS} FROM products WHERE lower(sku) = lower($1)`,
      [sku.trim()],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapProductRow(row);
  } catch (error: unknown) {
    throw toAppError(error, PRODUCT_ERROR_TRANSLATION);
  }
}

/**
 * Memeriksa keberadaan SKU tanpa memuat seluruh baris.
 * `excludeId` dipakai saat update agar SKU milik menu itu sendiri tidak
 * dianggap duplikat.
 */
export async function existsBySku(sku: string, excludeId?: number): Promise<boolean> {
  const params: unknown[] = [sku.trim()];
  let sql = 'SELECT 1 AS found FROM products WHERE lower(sku) = lower($1)';

  if (excludeId !== undefined) {
    params.push(excludeId);
    sql += ` AND id <> $${params.length}`;
  }

  sql += ' LIMIT 1';

  try {
    const result = await query<{ found: number }>(sql, params);
    return result.rows.length > 0;
  } catch (error: unknown) {
    throw toAppError(error, PRODUCT_ERROR_TRANSLATION);
  }
}

/* =============================================================================
 * 5. OPERASI TULIS
 * ========================================================================== */

/** Menyimpan menu baru dan mengembalikan baris hasil INSERT. */
export async function create(input: CreateProductInput): Promise<Product> {
  const sql = `
    INSERT INTO products (sku, name, category, price, stock, is_active)
    VALUES ($1, $2, $3, $4, $5, TRUE)
    RETURNING ${PRODUCT_COLUMNS}
  `;

  try {
    const result = await query<ProductRow>(sql, [
      input.sku,
      input.name,
      input.category,
      input.price,
      input.stock,
    ]);

    const row = result.rows[0];
    if (row === undefined) {
      throw new AppError(
        500,
        'DATABASE_ERROR',
        'Menu gagal disimpan: database tidak mengembalikan data.',
      );
    }
    return mapProductRow(row);
  } catch (error: unknown) {
    throw toAppError(error, PRODUCT_ERROR_TRANSLATION);
  }
}

/**
 * Memperbarui menu secara parsial.
 *
 * Hanya field yang benar-benar dikirim yang masuk ke klausa SET. Ini mencegah
 * bug nyata pada panel admin: form "ubah stok" yang tidak memuat input harga
 * tidak boleh mengosongkan harga menjadi 0.
 *
 * Mengembalikan `null` bila id tidak ada.
 */
export async function update(
  id: number,
  input: UpdateProductInput,
): Promise<Product | null> {
  const assignments: string[] = [];
  const params: unknown[] = [];

  if (input.sku !== undefined) {
    params.push(input.sku);
    assignments.push(`sku = $${params.length}`);
  }
  if (input.name !== undefined) {
    params.push(input.name);
    assignments.push(`name = $${params.length}`);
  }
  if (input.category !== undefined) {
    params.push(input.category);
    assignments.push(`category = $${params.length}`);
  }
  if (input.price !== undefined) {
    params.push(input.price);
    assignments.push(`price = $${params.length}`);
  }
  if (input.stock !== undefined) {
    params.push(input.stock);
    assignments.push(`stock = $${params.length}`);
  }
  if (input.isActive !== undefined) {
    params.push(input.isActive);
    assignments.push(`is_active = $${params.length}`);
  }

  // Tidak ada field yang dikirim: tidak perlu menyentuh database sama sekali.
  if (assignments.length === 0) {
    return findById(id);
  }

  params.push(id);
  const sql = `
    UPDATE products
    SET ${assignments.join(', ')}
    WHERE id = $${params.length}
    RETURNING ${PRODUCT_COLUMNS}
  `;

  try {
    const result = await query<ProductRow>(sql, params);
    const row = result.rows[0];
    return row === undefined ? null : mapProductRow(row);
  } catch (error: unknown) {
    throw toAppError(error, PRODUCT_ERROR_TRANSLATION);
  }
}

/**
 * Mengubah status aktif menu (soft delete / restore).
 * `is_active = FALSE` menyembunyikan menu dari kasir TANPA menghapus riwayat
 * transaksi yang merujuknya. `null` berarti id tidak ditemukan.
 */
export async function setActive(id: number, isActive: boolean): Promise<Product | null> {
  try {
    const result = await query<ProductRow>(
      `UPDATE products SET is_active = $1 WHERE id = $2 RETURNING ${PRODUCT_COLUMNS}`,
      [isActive, id],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapProductRow(row);
  } catch (error: unknown) {
    throw toAppError(error, PRODUCT_ERROR_TRANSLATION);
  }
}

/** Soft delete: menu berhenti dijual tetapi tetap tersimpan untuk laporan. */
export async function softDelete(id: number): Promise<Product | null> {
  return setActive(id, false);
}

/** Mengaktifkan kembali menu yang sebelumnya di-soft delete. */
export async function restore(id: number): Promise<Product | null> {
  return setActive(id, true);
}

/* =============================================================================
 * 6. OPERASI KHUSUS CHECKOUT (WAJIB DI DALAM TRANSAKSI)
 * ========================================================================== */

/**
 * Mengunci baris produk untuk checkout (`SELECT ... FOR UPDATE`).
 *
 * `ORDER BY id` WAJIB: dua kasir yang melakukan checkout dengan urutan produk
 * berbeda tanpa pengurutan dapat saling mengunci (deadlock) dan PostgreSQL akan
 * membatalkan salah satu transaksi. Pengurutan konsisten membuat setiap
 * transaksi memperoleh lock dalam urutan yang sama.
 *
 * Fungsi ini menerima `client` (bukan memakai `query()` global) supaya lock
 * berada di dalam transaksi yang sama dengan UPDATE stok nanti.
 */
export async function lockForCheckout(
  client: PoolClient,
  productIds: readonly number[],
): Promise<ProductForCheckoutRow[]> {
  if (productIds.length === 0) {
    return [];
  }

  const sql = `
    SELECT id, sku, name, price, stock, is_active
    FROM products
    WHERE id = ANY($1::int[])
    ORDER BY id
    FOR UPDATE
  `;

  try {
    const result = await client.query<ProductForCheckoutRow>(sql, [[...productIds]]);
    return result.rows;
  } catch (error: unknown) {
    throw toAppError(error, PRODUCT_ERROR_TRANSLATION);
  }
}

/**
 * Mengurangi stok secara atomik dan aman terhadap balapan (race condition).
 *
 * Klausa `AND stock >= $2` adalah inti pengamanannya: bila stok tidak cukup,
 * UPDATE tidak mengenai baris apa pun dan fungsi mengembalikan `null` — bukan
 * stok negatif. Pemeriksaan di Controller bersifat tambahan untuk pesan error
 * yang ramah; kebenaran data dijamin di sini dan oleh CHECK constraint.
 *
 * @returns stok baru, atau `null` bila stok tidak mencukupi / menu tidak ada.
 */
export async function decrementStock(
  client: PoolClient,
  productId: number,
  quantity: number,
): Promise<number | null> {
  const sql = `
    UPDATE products
    SET stock = stock - $2
    WHERE id = $1 AND stock >= $2
    RETURNING stock
  `;

  try {
    const result = await client.query<{ stock: number }>(sql, [productId, quantity]);
    const row = result.rows[0];
    return row === undefined ? null : row.stock;
  } catch (error: unknown) {
    throw toAppError(error, PRODUCT_ERROR_TRANSLATION);
  }
}

/* =============================================================================
 * 7. EKSPOR NAMA DEFAULT (memudahkan impor bergaya `productModel.findAll`)
 * ========================================================================== */

const productModel = {
  findAll,
  findById,
  findBySku,
  existsBySku,
  create,
  update,
  setActive,
  softDelete,
  restore,
  lockForCheckout,
  decrementStock,
} as const;

export default productModel;
