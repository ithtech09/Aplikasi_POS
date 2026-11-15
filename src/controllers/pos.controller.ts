/**
 * =============================================================================
 * src/controllers/pos.controller.ts
 * Logika HTTP terminal kasir: daftar menu, checkout ACID, struk, PDF.
 * =============================================================================
 *
 * BATAS TANGGUNG JAWAB:
 *   - Mengelola siklus HTTP dan memanggil Model/Service.
 *   - DILARANG menulis SQL.
 *
 * INTI ACID ADA DI `checkout()`:
 *   seluruh pembacaan stok, pengurangan stok, dan pencatatan nota berjalan di
 *   dalam SATU `withTransaction()`. Bila salah satu langkah gagal - stok
 *   kurang, uang kurang, atau insert gagal - ROLLBACK mengembalikan stok dan
 *   tidak ada nota yang tercatat.
 */

import type { Request, Response } from 'express';
import productModel from '../models/product.model';
import transactionModel, { roundMoney } from '../models/transaction.model';
import { streamReceipt, formatCurrency, loadStoreProfile } from '../services/pdf.service';
import { withTransaction } from '../config/database';
import {
  AppError,
  isAppError,
  isPlainObject,
  createViewContext,
  parseDecimalField,
  parseIntegerField,
  readFormValue,
  unwrapOrCollect,
  type ApiFailure,
  type ApiSuccess,
  type CheckoutItemInput,
  type CheckoutLine,
  type CheckoutResponse,
  type ErrorCode,
  type Product,
  type ProductForCheckoutRow,
  type ValidationResult,
} from '../types';

/* =============================================================================
 * 1. KONSTANTA
 * ========================================================================== */

const MAX_QUANTITY = 999;
const PRICE_MAX = 9_999_999_999.99;
const ID_PATTERN = /^[1-9]\d*$/;
const POS_PATH = '/pos';

/* =============================================================================
 * 2. TIPE LOKAL
 * ========================================================================== */

type PosRequest = Request<Record<string, string>, unknown, unknown>;

/* =============================================================================
 * 3. UTILITAS HTTP
 * ========================================================================== */

function readBody(req: PosRequest): Record<string, unknown> {
  return isPlainObject(req.body) ? req.body : {};
}

function wantsJson(req: PosRequest): boolean {
  const accept = req.get('accept') ?? '';
  return accept.includes('application/json') || req.xhr;
}

function resolveAppError(error: unknown): AppError {
  if (isAppError(error)) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error('[pos.controller] Kesalahan tak terduga:', message);
  return new AppError(500, 'INTERNAL_ERROR', 'Terjadi kesalahan internal pada server.');
}

function parseId(raw: string | undefined): number | null {
  if (raw === undefined || !ID_PATTERN.test(raw)) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
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

function respondWithError(req: PosRequest, res: Response<unknown>, error: unknown): void {
  const appError = resolveAppError(error);

  if (res.headersSent) {
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
 * 4. VALIDASI KERANJANG
 * ========================================================================== */

/**
 * Memvalidasi daftar item dari klien.
 *
 * Duplikat `productId` DIGABUNG, bukan ditolak: keranjang yang mengirim
 * menu yang sama dua kali tetap menghasilkan satu baris nota dengan jumlah
 * total, sehingga laporan tidak memecah satu menu menjadi dua baris.
 */
function parseCartItems(raw: unknown): ValidationResult<readonly CheckoutItemInput[]> {
  if (!Array.isArray(raw)) {
    return { ok: false, errors: ['Daftar pesanan tidak valid.'] };
  }
  if (raw.length === 0) {
    return { ok: false, errors: ['Keranjang masih kosong.'] };
  }

  const errors: string[] = [];
  const merged = new Map<number, number>();

  raw.forEach((entry: unknown, index: number): void => {
    const position = index + 1;

    if (!isPlainObject(entry)) {
      errors.push(`Item ke-${position} tidak valid.`);
      return;
    }

    const productId = unwrapOrCollect(
      parseIntegerField(
        readFormValue(entry.productId),
        `Id menu item ke-${position}`,
        1,
        Number.MAX_SAFE_INTEGER,
      ),
      errors,
    );
    const quantity = unwrapOrCollect(
      parseIntegerField(
        readFormValue(entry.quantity),
        `Jumlah item ke-${position}`,
        1,
        MAX_QUANTITY,
      ),
      errors,
    );

    if (productId === null || quantity === null) {
      return;
    }

    const previous = merged.get(productId) ?? 0;
    const combined = previous + quantity;

    if (combined > MAX_QUANTITY) {
      errors.push(`Jumlah item ke-${position} melebihi batas ${MAX_QUANTITY} porsi.`);
      return;
    }

    merged.set(productId, combined);
  });

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const items: CheckoutItemInput[] = [];
  merged.forEach((quantity: number, productId: number): void => {
    items.push({ productId, quantity });
  });

  if (items.length === 0) {
    return { ok: false, errors: ['Keranjang masih kosong.'] };
  }

  return { ok: true, value: items };
}

/** NUMERIC (string) -> number untuk harga dari database. */
function toMoney(value: string): number {
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

/* =============================================================================
 * 5. HANDLER: HALAMAN KASIR
 * ========================================================================== */

/** GET /pos - terminal kasir dengan daftar menu aktif. */
export async function showTerminal(
  req: PosRequest,
  res: Response<unknown>,
): Promise<void> {
  try {
    const products: readonly Product[] = await productModel.findAll({ onlyActive: true });
    const viewContext = createViewContext('pos', 'Terminal Kasir');

    res.status(200).render('pos/index', {
      ...viewContext,
      products,
      formatCurrency,
      posPath: POS_PATH,
    });
  } catch (error: unknown) {
    respondWithError(req, res, error);
  }
}

/* =============================================================================
 * 6. HANDLER: CHECKOUT (ACID)
 * ========================================================================== */

/**
 * POST /pos/checkout - memproses pembayaran.
 *
 * Urutan di dalam transaksi database:
 *   1. Kunci baris produk (`FOR UPDATE`, urut id) untuk mencegah balapan.
 *   2. Validasi keberadaan, status aktif, dan kecukupan stok.
 *   3. Hitung subtotal & total dari HARGA DATABASE (bukan harga kiriman klien).
 *   4. Tolak bila uang tunai kurang.
 *   5. Buat nomor nota (advisory lock per tanggal).
 *   6. Insert header, kurangi stok, insert item.
 *   7. Baca ulang item dari database untuk struk.
 *
 * Setiap kegagalan di langkah mana pun melempar error, sehingga
 * `withTransaction` menjalankan ROLLBACK: stok utuh, nota tidak tercatat.
 */
export async function checkout(req: PosRequest, res: Response<unknown>): Promise<void> {
  const body = readBody(req);
  const errors: string[] = [];

  const parsedItems = parseCartItems(body.items);
  const items = unwrapOrCollect(parsedItems, errors);

  const cashPaid = unwrapOrCollect(
    parseDecimalField(readFormValue(body.cashPaid), 'Uang tunai', 0, PRICE_MAX),
    errors,
  );

  if (errors.length > 0 || items === null || cashPaid === null) {
    sendJsonError(res, 422, 'VALIDATION_ERROR', 'Data pembayaran tidak valid.', errors);
    return;
  }

  try {
    const result = await withTransaction<CheckoutResponse>(async (client) => {
      const productIds = items.map((item: CheckoutItemInput): number => item.productId);

      const lockedRows: readonly ProductForCheckoutRow[] =
        await productModel.lockForCheckout(client, productIds);

      const byId = new Map<number, ProductForCheckoutRow>();
      for (const row of lockedRows) {
        byId.set(row.id, row);
      }

      const lines: CheckoutLine[] = [];

      for (const item of items) {
        const row = byId.get(item.productId);

        if (row === undefined) {
          throw new AppError(
            404,
            'NOT_FOUND',
            `Menu dengan id ${item.productId} tidak ditemukan.`,
          );
        }

        if (!row.is_active) {
          throw new AppError(
            409,
            'INACTIVE_PRODUCT',
            `Menu "${row.name}" sedang tidak dijual.`,
          );
        }

        if (row.stock < item.quantity) {
          throw new AppError(
            409,
            'INSUFFICIENT_STOCK',
            `Stok "${row.name}" tersisa ${row.stock} porsi, diminta ${item.quantity}.`,
          );
        }

        const priceAtSale = roundMoney(toMoney(row.price));
        const subtotal = roundMoney(priceAtSale * item.quantity);

        lines.push({
          productId: row.id,
          sku: row.sku,
          name: row.name,
          quantity: item.quantity,
          priceAtSale,
          subtotal,
        });
      }

      const totalAmount = roundMoney(
        lines.reduce((sum: number, line: CheckoutLine): number => sum + line.subtotal, 0),
      );

      if (cashPaid < totalAmount) {
        throw new AppError(
          400,
          'INSUFFICIENT_CASH',
          `Uang tunai ${formatCurrency(cashPaid)} kurang dari total ${formatCurrency(totalAmount)}.`,
        );
      }

      const changeAmount = roundMoney(cashPaid - totalAmount);

      const invoiceNumber = await transactionModel.nextInvoiceNumber(client);

      const transaction = await transactionModel.createHeader(client, {
        invoiceNumber,
        totalAmount,
        cashPaid,
        changeAmount,
      });

      for (const line of lines) {
        const remaining = await productModel.decrementStock(
          client,
          line.productId,
          line.quantity,
        );

        // Jaring pengaman terakhir: lock sudah mencegah ini, tetapi bila stok
        // berubah karena sebab lain, transaksi harus dibatalkan - bukan
        // menyimpan stok negatif.
        if (remaining === null) {
          throw new AppError(
            409,
            'INSUFFICIENT_STOCK',
            `Stok "${line.name}" tidak lagi mencukupi. Transaksi dibatalkan.`,
          );
        }
      }

      await transactionModel.createItems(client, transaction.id, lines);

      const savedItems = await transactionModel.findItemsByTransactionIdTx(
        client,
        transaction.id,
      );

      return {
        transaction,
        items: savedItems,
        totalAmount,
        cashPaid,
        changeAmount,
        receiptUrl: `/transactions/${transaction.id}`,
      };
    });

    if (wantsJson(req)) {
      sendJsonSuccess(res, 201, result, 'Transaksi berhasil.');
      return;
    }

    res.redirect(303, result.receiptUrl);
  } catch (error: unknown) {
    respondWithError(req, res, error);
  }
}

/* =============================================================================
 * 7. HANDLER: STRUK & PDF
 * ========================================================================== */

/** GET /transactions/:id - pratinjau nota + tombol unduh PDF. */
export async function showReceipt(
  req: PosRequest,
  res: Response<unknown>,
): Promise<void> {
  const id = parseId(req.params.id);
  if (id === null) {
    respondWithError(req, res, new AppError(400, 'VALIDATION_ERROR', 'Id transaksi tidak valid.'));
    return;
  }

  try {
    const detail = await transactionModel.findDetailById(id);

    if (detail === null) {
      respondWithError(req, res, new AppError(404, 'NOT_FOUND', 'Transaksi tidak ditemukan.'));
      return;
    }

    const viewContext = createViewContext('pos', `Nota ${detail.transaction.invoiceNumber}`);

    res.status(200).render('receipt', {
      ...viewContext,
      transaction: detail.transaction,
      items: detail.items,
      formatCurrency,
    });
  } catch (error: unknown) {
    respondWithError(req, res, error);
  }
}

/** GET /transactions/:id/pdf - mengalirkan struk PDF 80mm. */
export async function downloadReceiptPdf(
  req: PosRequest,
  res: Response<unknown>,
): Promise<void> {
  const id = parseId(req.params.id);
  if (id === null) {
    respondWithError(req, res, new AppError(400, 'VALIDATION_ERROR', 'Id transaksi tidak valid.'));
    return;
  }

  try {
    const detail = await transactionModel.findDetailById(id);

    if (detail === null) {
      respondWithError(req, res, new AppError(404, 'NOT_FOUND', 'Transaksi tidak ditemukan.'));
      return;
    }

    const safeInvoice = detail.transaction.invoiceNumber.replace(/[^A-Za-z0-9-]/g, '');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="struk-${safeInvoice}.pdf"`,
    );
    // Struk tidak boleh di-cache: nomor nota bisa dipakai ulang setelah reset.
    res.setHeader('Cache-Control', 'no-store');

    await streamReceipt(
      {
        store: loadStoreProfile(),
        transaction: detail.transaction,
        items: detail.items,
      },
      res,
    );
  } catch (error: unknown) {
    respondWithError(req, res, error);
  }
}

/* =============================================================================
 * 8. EKSPOR NAMA DEFAULT
 * ========================================================================== */

const posController = {
  showTerminal,
  checkout,
  showReceipt,
  downloadReceiptPdf,
} as const;

export default posController;
