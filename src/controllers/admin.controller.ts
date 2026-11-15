/**
 * =============================================================================
 * src/controllers/admin.controller.ts
 * Logika HTTP panel Admin: dasbor, tambah menu, ubah menu, aktif/nonaktif.
 * =============================================================================
 *
 * BATAS TANGGUNG JAWAB (Bagian 5 blueprint):
 *   - HANYA mengelola siklus HTTP request/response.
 *   - DILARANG menulis string SQL; seluruh akses data lewat `product.model`.
 *   - Validasi input dilakukan di sini (lapisan HTTP), BUKAN di model.
 *
 * DUA MODE RESPONS:
 *   Endpoint yang sama melayani form HTML dan klien JSON (ditentukan header
 *   `Accept`). Ini membuat pengujian blackbox dapat memeriksa status & body
 *   JSON tanpa mengikuti redirect, sementara panel admin tetap memakai alur
 *   form biasa (POST lalu redirect 303).
 *
 * PESAN SUKSES:
 *   Tech stack tidak memuat `express-session`, jadi pesan sukses dikirim lewat
 *   query string (`?success=created`) dan dipetakan ke teks di sini. Menambah
 *   session hanya untuk flash message akan menambah dependensi dan store
 *   tambahan tanpa manfaat nyata untuk aplikasi satu-kasir.
 */

import type { Request, Response } from 'express';
import productModel from '../models/product.model';
import {
  AppError,
  isAppError,
  isPlainObject,
  LOW_STOCK_THRESHOLD,
  PRODUCT_CATEGORIES,
  createViewContext,
  parseDecimalField,
  parseIntegerField,
  parseTextField,
  readFormValue,
  unwrapOrCollect,
  type ApiFailure,
  type ApiSuccess,
  type CreateProductInput,
  type ErrorCode,
  type Product,
  type UpdateProductInput,
} from '../types';

/* =============================================================================
 * 1. KONSTANTA VALIDASI
 * ========================================================================== */

const SKU_MAX_LENGTH = 50;
const NAME_MAX_LENGTH = 150;
const CATEGORY_MAX_LENGTH = 50;

/** Batas NUMERIC(12,2): 10 digit di depan koma, 2 di belakang. */
const PRICE_MAX = 9_999_999_999.99;

/** Batas kolom INT PostgreSQL. */
const STOCK_MAX = 2_147_483_647;

const DEFAULT_CATEGORY = 'Makanan';
const ADMIN_PATH = '/admin';

/** Id valid: bilangan bulat positif tanpa nol di depan. */
const ID_PATTERN = /^[1-9]\d*$/;

const SUCCESS_MESSAGES: Readonly<Record<string, string>> = {
  created: 'Menu baru berhasil ditambahkan.',
  updated: 'Data menu berhasil diperbarui.',
  deleted: 'Menu dinonaktifkan. Riwayat transaksi tetap tersimpan.',
  restored: 'Menu diaktifkan kembali.',
};

/* =============================================================================
 * 2. TIPE LOKAL
 * ========================================================================== */

/**
 * Request bertipe eksplisit.
 * `ReqBody` sengaja `unknown` (bukan `any` bawaan Express), sehingga setiap
 * akses nilai form WAJIB melewati `readBody()` + `readFormValue()`.
 */
type AdminRequest = Request<Record<string, string>, unknown, unknown>;

/** Nilai form yang dikirim balik ke view saat validasi gagal. */
interface ProductFormValues {
  readonly sku: string;
  readonly name: string;
  readonly category: string;
  readonly price: string;
  readonly stock: string;
}

interface AdminIndexOptions {
  readonly search: string;
  readonly errors: readonly string[];
  readonly successMessage: string | null;
  readonly form: ProductFormValues;
  readonly status: number;
}

/** Objek update yang dapat diisi bertahap sebelum dikirim ke model. */
interface MutableProductUpdate {
  sku?: string;
  name?: string;
  category?: string;
  price?: number;
  stock?: number;
}

const EMPTY_FORM: ProductFormValues = {
  sku: '',
  name: '',
  category: DEFAULT_CATEGORY,
  price: '',
  stock: '',
};

/* =============================================================================
 * 3. UTILITAS HTTP
 * ========================================================================== */

/** Body sebagai objek biasa; body non-objek diperlakukan sebagai kosong. */
function readBody(req: AdminRequest): Record<string, unknown> {
  return isPlainObject(req.body) ? req.body : {};
}

/** True bila klien mengharapkan JSON (fetch/AJAX) alih-alih halaman HTML. */
function wantsJson(req: AdminRequest): boolean {
  const accept = req.get('accept') ?? '';
  return accept.includes('application/json') || req.xhr;
}

/** Menormalkan error apa pun menjadi `AppError` tanpa membocorkan detail. */
function resolveAppError(error: unknown): AppError {
  if (isAppError(error)) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error('[admin.controller] Kesalahan tak terduga:', message);
  return new AppError(500, 'INTERNAL_ERROR', 'Terjadi kesalahan internal pada server.');
}

/** Membaca dan memvalidasi `:id` dari URL. `null` bila tidak valid. */
function parseId(raw: string | undefined): number | null {
  if (raw === undefined || !ID_PATTERN.test(raw)) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Nilai mentah untuk ditampilkan kembali di form (string kosong bila tidak ada). */
function rawOrEmpty(raw: unknown): string {
  if (typeof raw === 'string') {
    return raw;
  }
  if (typeof raw === 'number' || typeof raw === 'boolean') {
    return String(raw);
  }
  if (Array.isArray(raw)) {
    const first: unknown = raw[0];
    return typeof first === 'string' ? first : '';
  }
  return '';
}

/** Menyusun nilai form dari body agar input pengguna tidak hilang saat error. */
function toFormValues(body: Record<string, unknown>): ProductFormValues {
  return {
    sku: rawOrEmpty(body.sku),
    name: rawOrEmpty(body.name),
    category: rawOrEmpty(body.category),
    price: rawOrEmpty(body.price),
    stock: rawOrEmpty(body.stock),
  };
}

/** Pesan sukses dari query string, hanya untuk kode yang dikenal. */
function readSuccessMessage(req: AdminRequest): string | null {
  const code = readFormValue(req.query.success);
  if (code === undefined) {
    return null;
  }
  return SUCCESS_MESSAGES[code] ?? null;
}

function sendJsonSuccess<T>(
  res: Response<unknown>,
  status: number,
  data: T,
  message?: string,
): void {
  const payload: ApiSuccess<T> =
    message === undefined ? { success: true, data } : { success: true, data, message };
  res.status(status).json(payload);
}

function sendJsonError(
  res: Response<unknown>,
  status: number,
  code: ErrorCode,
  message: string,
  details: readonly string[] = [],
): void {
  const payload: ApiFailure = { success: false, error: { code, message, details } };
  res.status(status).json(payload);
}

/**
 * Respons error terakhir: JSON untuk klien API, teks biasa untuk browser.
 * Dipakai ketika view sendiri gagal dirender (mis. database mati), sehingga
 * tidak ada percobaan render kedua yang pasti gagal juga.
 */
function respondWithError(req: AdminRequest, res: Response<unknown>, error: unknown): void {
  const appError = resolveAppError(error);

  if (res.headersSent) {
    // Header sudah terkirim: tidak ada status/body yang bisa diubah lagi.
    res.end();
    return;
  }

  if (wantsJson(req)) {
    sendJsonError(res, appError.statusCode, appError.code, appError.message, appError.details);
    return;
  }

  res.status(appError.statusCode).type('text/plain').send(appError.message);
}

/* =============================================================================
 * 4. RENDER DASBOR
 * ========================================================================== */

/**
 * Merender `views/admin/index.ejs` beserta daftar menu.
 * Daftar diambil ulang setiap render agar perubahan stok/harga dari kasir
 * langsung terlihat di panel admin tanpa refresh manual tambahan.
 */
async function renderAdminIndex(
  res: Response<unknown>,
  options: AdminIndexOptions,
): Promise<void> {
  const products: readonly Product[] = await productModel.findAll(
    options.search.length > 0 ? { search: options.search } : {},
  );

  const viewContext = createViewContext('admin', 'Manajemen Menu');

  res.status(options.status).render('admin/index', {
    ...viewContext,
    products,
    categories: PRODUCT_CATEGORIES,
    lowStockThreshold: LOW_STOCK_THRESHOLD,
    search: options.search,
    errors: options.errors,
    successMessage: options.successMessage,
    form: options.form,
    adminPath: ADMIN_PATH,
  });
}

/* =============================================================================
 * 5. HANDLER: DASBOR
 * ========================================================================== */

/** GET /admin - daftar seluruh menu (termasuk yang nonaktif). */
export async function showDashboard(
  req: AdminRequest,
  res: Response<unknown>,
): Promise<void> {
  const search = readFormValue(req.query.q) ?? '';

  try {
    await renderAdminIndex(res, {
      search,
      errors: [],
      successMessage: readSuccessMessage(req),
      form: EMPTY_FORM,
      status: 200,
    });
  } catch (error: unknown) {
    respondWithError(req, res, error);
  }
}

/* =============================================================================
 * 6. HANDLER: TAMBAH MENU
 * ========================================================================== */

/** POST /admin/products - membuat menu baru. */
export async function createProduct(
  req: AdminRequest,
  res: Response<unknown>,
): Promise<void> {
  const body = readBody(req);
  const errors: string[] = [];

  const sku = unwrapOrCollect(
    parseTextField(readFormValue(body.sku), 'Kode menu (SKU)', SKU_MAX_LENGTH),
    errors,
  );
  const name = unwrapOrCollect(
    parseTextField(readFormValue(body.name), 'Nama menu', NAME_MAX_LENGTH),
    errors,
  );

  const rawCategory = readFormValue(body.category);
  const category =
    rawCategory === undefined
      ? DEFAULT_CATEGORY
      : unwrapOrCollect(parseTextField(rawCategory, 'Kategori', CATEGORY_MAX_LENGTH), errors);

  const price = unwrapOrCollect(
    parseDecimalField(readFormValue(body.price), 'Harga jual', 0, PRICE_MAX),
    errors,
  );
  const stock = unwrapOrCollect(
    parseIntegerField(readFormValue(body.stock), 'Stok porsi', 0, STOCK_MAX),
    errors,
  );

  if (
    errors.length > 0 ||
    sku === null ||
    name === null ||
    category === null ||
    price === null ||
    stock === null
  ) {
    if (wantsJson(req)) {
      sendJsonError(res, 422, 'VALIDATION_ERROR', 'Data menu tidak valid.', errors);
      return;
    }

    try {
      await renderAdminIndex(res, {
        search: '',
        errors,
        successMessage: null,
        form: toFormValues(body),
        status: 422,
      });
    } catch (error: unknown) {
      respondWithError(req, res, error);
    }
    return;
  }

  const input: CreateProductInput = { sku, name, category, price, stock };

  try {
    const product = await productModel.create(input);

    if (wantsJson(req)) {
      sendJsonSuccess(res, 201, product, 'Menu berhasil ditambahkan.');
      return;
    }
    res.redirect(303, `${ADMIN_PATH}?success=created`);
  } catch (error: unknown) {
    const appError = resolveAppError(error);

    if (wantsJson(req)) {
      sendJsonError(res, appError.statusCode, appError.code, appError.message, appError.details);
      return;
    }

    try {
      await renderAdminIndex(res, {
        search: '',
        errors: [appError.message],
        successMessage: null,
        form: toFormValues(body),
        status: appError.statusCode,
      });
    } catch (renderError: unknown) {
      respondWithError(req, res, renderError);
    }
  }
}

/* =============================================================================
 * 7. HANDLER: UBAH MENU
 * ========================================================================== */

/**
 * POST /admin/products/:id - memperbarui menu secara parsial.
 *
 * Hanya field yang BENAR-BENAR ADA di body yang diproses. Form "ubah stok"
 * yang tidak memuat input harga tidak akan mengubah harga menjadi 0.
 * Field yang ada tetapi kosong tetap ditolak sebagai error validasi - bukan
 * dilewati diam-diam, karena itu akan menyembunyikan salah ketik.
 */
export async function updateProduct(
  req: AdminRequest,
  res: Response<unknown>,
): Promise<void> {
  const id = parseId(req.params.id);
  if (id === null) {
    if (wantsJson(req)) {
      sendJsonError(res, 400, 'VALIDATION_ERROR', 'Id menu tidak valid.');
      return;
    }
    respondWithError(req, res, new AppError(400, 'VALIDATION_ERROR', 'Id menu tidak valid.'));
    return;
  }

  const body = readBody(req);
  const errors: string[] = [];
  const updates: MutableProductUpdate = {};

  if (body.sku !== undefined) {
    const sku = unwrapOrCollect(
      parseTextField(readFormValue(body.sku), 'Kode menu (SKU)', SKU_MAX_LENGTH),
      errors,
    );
    if (sku !== null) {
      updates.sku = sku;
    }
  }

  if (body.name !== undefined) {
    const name = unwrapOrCollect(
      parseTextField(readFormValue(body.name), 'Nama menu', NAME_MAX_LENGTH),
      errors,
    );
    if (name !== null) {
      updates.name = name;
    }
  }

  if (body.category !== undefined) {
    const category = unwrapOrCollect(
      parseTextField(readFormValue(body.category), 'Kategori', CATEGORY_MAX_LENGTH),
      errors,
    );
    if (category !== null) {
      updates.category = category;
    }
  }

  if (body.price !== undefined) {
    const price = unwrapOrCollect(
      parseDecimalField(readFormValue(body.price), 'Harga jual', 0, PRICE_MAX),
      errors,
    );
    if (price !== null) {
      updates.price = price;
    }
  }

  if (body.stock !== undefined) {
    const stock = unwrapOrCollect(
      parseIntegerField(readFormValue(body.stock), 'Stok porsi', 0, STOCK_MAX),
      errors,
    );
    if (stock !== null) {
      updates.stock = stock;
    }
  }

  if (errors.length === 0 && Object.keys(updates).length === 0) {
    errors.push('Tidak ada data yang diubah.');
  }

  if (errors.length > 0) {
    if (wantsJson(req)) {
      sendJsonError(res, 422, 'VALIDATION_ERROR', 'Data menu tidak valid.', errors);
      return;
    }
    try {
      await renderAdminIndex(res, {
        search: '',
        errors,
        successMessage: null,
        form: toFormValues(body),
        status: 422,
      });
    } catch (error: unknown) {
      respondWithError(req, res, error);
    }
    return;
  }

  const input: UpdateProductInput = updates;

  try {
    const product = await productModel.update(id, input);

    if (product === null) {
      if (wantsJson(req)) {
        sendJsonError(res, 404, 'NOT_FOUND', 'Menu tidak ditemukan.');
        return;
      }
      respondWithError(req, res, new AppError(404, 'NOT_FOUND', 'Menu tidak ditemukan.'));
      return;
    }

    if (wantsJson(req)) {
      sendJsonSuccess(res, 200, product, 'Menu berhasil diperbarui.');
      return;
    }
    res.redirect(303, `${ADMIN_PATH}?success=updated`);
  } catch (error: unknown) {
    const appError = resolveAppError(error);

    if (wantsJson(req)) {
      sendJsonError(res, appError.statusCode, appError.code, appError.message, appError.details);
      return;
    }
    try {
      await renderAdminIndex(res, {
        search: '',
        errors: [appError.message],
        successMessage: null,
        form: toFormValues(body),
        status: appError.statusCode,
      });
    } catch (renderError: unknown) {
      respondWithError(req, res, renderError);
    }
  }
}

/* =============================================================================
 * 8. HANDLER: SOFT DELETE & RESTORE
 * ========================================================================== */

/** POST /admin/products/:id/delete - menonaktifkan menu (soft delete). */
export async function deactivateProduct(
  req: AdminRequest,
  res: Response<unknown>,
): Promise<void> {
  const id = parseId(req.params.id);
  if (id === null) {
    if (wantsJson(req)) {
      sendJsonError(res, 400, 'VALIDATION_ERROR', 'Id menu tidak valid.');
      return;
    }
    respondWithError(req, res, new AppError(400, 'VALIDATION_ERROR', 'Id menu tidak valid.'));
    return;
  }

  try {
    const product = await productModel.softDelete(id);

    if (product === null) {
      if (wantsJson(req)) {
        sendJsonError(res, 404, 'NOT_FOUND', 'Menu tidak ditemukan.');
        return;
      }
      respondWithError(req, res, new AppError(404, 'NOT_FOUND', 'Menu tidak ditemukan.'));
      return;
    }

    if (wantsJson(req)) {
      sendJsonSuccess(res, 200, product, 'Menu dinonaktifkan.');
      return;
    }
    res.redirect(303, `${ADMIN_PATH}?success=deleted`);
  } catch (error: unknown) {
    respondWithError(req, res, error);
  }
}

/** POST /admin/products/:id/restore - mengaktifkan kembali menu. */
export async function activateProduct(
  req: AdminRequest,
  res: Response<unknown>,
): Promise<void> {
  const id = parseId(req.params.id);
  if (id === null) {
    if (wantsJson(req)) {
      sendJsonError(res, 400, 'VALIDATION_ERROR', 'Id menu tidak valid.');
      return;
    }
    respondWithError(req, res, new AppError(400, 'VALIDATION_ERROR', 'Id menu tidak valid.'));
    return;
  }

  try {
    const product = await productModel.restore(id);

    if (product === null) {
      if (wantsJson(req)) {
        sendJsonError(res, 404, 'NOT_FOUND', 'Menu tidak ditemukan.');
        return;
      }
      respondWithError(req, res, new AppError(404, 'NOT_FOUND', 'Menu tidak ditemukan.'));
      return;
    }

    if (wantsJson(req)) {
      sendJsonSuccess(res, 200, product, 'Menu diaktifkan kembali.');
      return;
    }
    res.redirect(303, `${ADMIN_PATH}?success=restored`);
  } catch (error: unknown) {
    respondWithError(req, res, error);
  }
}

/* =============================================================================
 * 9. EKSPOR NAMA DEFAULT
 * ========================================================================== */

const adminController = {
  showDashboard,
  createProduct,
  updateProduct,
  deactivateProduct,
  activateProduct,
} as const;

export default adminController;
