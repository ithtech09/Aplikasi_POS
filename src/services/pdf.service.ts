/**
 * =============================================================================
 * src/services/pdf.service.ts
 * Service terisolasi generasi Struk PDF menggunakan PDFKit.
 * =============================================================================
 *
 * BATAS TANGGUNG JAWAB (Bagian 5 blueprint):
 *   - Menangani logika bisnis spesifik yang berdiri sendiri: menggambar struk
 *     dan mengalirkannya sebagai stream.
 *   - TIDAK menyentuh SQL, TIDAK menyentuh `req`.
 *
 * MENGAPA TANPA HEADLESS BROWSER:
 *   PDFKit menggambar langsung ke stream PDF (vektor + teks), sehingga satu
 *   struk hanya memakai beberapa ratus kilobyte RAM. Chromium/Puppeteer akan
 *   memakan 100-300 MB per instance dan tidak layak untuk server kantin.
 *
 * UKURAN KERTAS:
 *   Standar printer thermal 80mm = 226.77 points (80 / 25.4 * 72).
 *
 * CATATAN FONT (PENTING):
 *   Font bawaan PDFKit (Helvetica) memakai encoding WinAnsi dan TIDAK
 *   mendukung karakter di luar Latin-1. Em dash, bullet, dan simbol kotak
 *   akan tercetak sebagai karakter sampah. Karena itu seluruh teks struk di
 *   file ini memakai ASCII murni: '-' dan '*'.
 */

import PDFDocument from 'pdfkit';
import { pipeline } from 'node:stream/promises';
import type { Writable } from 'node:stream';
import {
  AppError,
  resolveTimeZone,
  type ReceiptPayload,
  type StoreProfile,
  type TransactionItemDetail,
} from '../types';

/* =============================================================================
 * 1. KONSTANTA TATA LETAK (satuan: point, 1 point = 1/72 inci)
 * ========================================================================== */

/** Lebar kertas thermal 80mm. 80mm / 25.4 * 72 = 226.77 pt. */
const DEFAULT_PAPER_WIDTH = 226.77;

/** Margin kiri/kanan. Printer thermal punya area cetak efektif ~72mm. */
const MARGIN_X = 10;

/** Margin atas dan bawah. */
const MARGIN_TOP = 12;
const MARGIN_BOTTOM = 14;

/** Tinggi minimum halaman agar struk pendek tidak terlihat terpotong. */
const MIN_PAGE_HEIGHT = 200;

/** Perkiraan tinggi satu blok item (2 baris teks + jarak). */
const ITEM_BLOCK_HEIGHT = 30;

/** Tinggi bagian header (nama toko, alamat, telepon, garis, info nota). */
const HEADER_HEIGHT = 118;

/** Tinggi bagian total + footer. */
const TOTALS_HEIGHT = 74;
const FOOTER_HEIGHT = 56;

const FONT_REGULAR = 'Helvetica';
const FONT_BOLD = 'Helvetica-Bold';

/* =============================================================================
 * 2. PEMBACA KONFIGURASI
 * ========================================================================== */

/** Membaca string env; kosong/hanya spasi dianggap tidak diset. */
function readEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  if (typeof raw !== 'string') {
    return fallback;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

/** Lebar kertas dari env, divalidasi agar tidak menghasilkan PDF rusak. */
function resolvePaperWidth(): number {
  const raw = readEnv('RECEIPT_PAPER_WIDTH', String(DEFAULT_PAPER_WIDTH));
  const parsed = Number.parseFloat(raw);

  if (!Number.isFinite(parsed) || parsed < 100 || parsed > 1000) {
    console.warn(
      `[pdf.service] RECEIPT_PAPER_WIDTH "${raw}" tidak wajar; memakai ${DEFAULT_PAPER_WIDTH}.`,
    );
    return DEFAULT_PAPER_WIDTH;
  }
  return parsed;
}

/**
 * Identitas toko untuk header struk.
 * Dipisah dari payload agar Controller tidak perlu tahu nama variabel env.
 */
export function loadStoreProfile(): StoreProfile {
  return {
    name: readEnv('STORE_NAME', 'Kantin'),
    address: readEnv('STORE_ADDRESS', ''),
    phone: readEnv('STORE_PHONE', ''),
    footer: readEnv('RECEIPT_FOOTER', 'Terima kasih atas kunjungan Anda'),
  };
}

/* =============================================================================
 * 3. PEMFORMATAN
 * ========================================================================== */

/**
 * Format rupiah tanpa simbol mata uang bawaan Intl.
 * `Intl.NumberFormat` dipakai untuk pemisah ribuan gaya Indonesia (titik),
 * lalu prefiks "Rp " ditambahkan manual agar hasilnya konsisten dan ASCII.
 */
export function formatCurrency(value: number): string {
  if (!Number.isFinite(value)) {
    return 'Rp 0';
  }
  const formatted = new Intl.NumberFormat('id-ID', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value);
  return `Rp ${formatted}`;
}

/** Tanggal & jam nota pada zona waktu aplikasi. */
function formatReceiptDate(date: Date): string {
  try {
    return new Intl.DateTimeFormat('id-ID', {
      timeZone: resolveTimeZone(),
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  } catch (error: unknown) {
    // Tanggal tidak valid tidak boleh menggagalkan cetak struk.
    const message = error instanceof Error ? error.message : String(error);
    console.error('[pdf.service] Gagal memformat tanggal nota:', message);
    return '-';
  }
}

/**
 * Membersihkan teks agar aman dicetak dengan font WinAnsi.
 * Karakter di luar Latin-1 diganti '?' alih-alih menjadi glyph sampah.
 */
function toPrintableAscii(value: string): string {
  return value.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
}

/* =============================================================================
 * 4. PENGGAMBAR STRUK
 * ========================================================================== */

/** Menggambar garis putus-putus pemisah pada posisi y tertentu. */
function drawDivider(document: PDFKit.PDFDocument, y: number, contentWidth: number): void {
  document
    .save()
    .moveTo(MARGIN_X, y)
    .lineTo(MARGIN_X + contentWidth, y)
    .dash(2, { space: 2 })
    .lineWidth(0.5)
    .strokeColor('#666666')
    .stroke()
    .restore()
    .undash();
}

/**
 * Menggambar satu baris item: nama menu, lalu "qty x harga" dan subtotal.
 * Nama panjang dibungkus otomatis oleh PDFKit dan tinggi baris dihitung dari
 * hasil `heightOfString` agar baris berikutnya tidak menimpa teks.
 */
function drawItem(
  document: PDFKit.PDFDocument,
  item: TransactionItemDetail,
  y: number,
  contentWidth: number,
): number {
  const name = toPrintableAscii(item.productName);
  const sku = toPrintableAscii(item.sku);
  const title = `${name} (${sku})`;

  document
    .font(FONT_BOLD)
    .fontSize(8)
    .fillColor('#000000')
    .text(title, MARGIN_X, y, {
      width: contentWidth,
      align: 'left',
    });

  const nameHeight = document.heightOfString(title, { width: contentWidth });
  const detailY = y + nameHeight + 1;

  document
    .font(FONT_REGULAR)
    .fontSize(8)
    .text(`${item.quantity} x ${formatCurrency(item.priceAtSale)}`, MARGIN_X, detailY, {
      width: contentWidth * 0.6,
      align: 'left',
    });

  document
    .font(FONT_REGULAR)
    .fontSize(8)
    .text(formatCurrency(item.subtotal), MARGIN_X + contentWidth * 0.4, detailY, {
      width: contentWidth * 0.6,
      align: 'right',
    });

  return detailY + 12;
}

/** Menggambar baris "label ... nilai" rata kiri-kanan. */
function drawKeyValue(
  document: PDFKit.PDFDocument,
  label: string,
  value: string,
  y: number,
  contentWidth: number,
  bold: boolean,
): number {
  const font = bold ? FONT_BOLD : FONT_REGULAR;
  const size = bold ? 9 : 8;

  document
    .font(font)
    .fontSize(size)
    .fillColor('#000000')
    .text(toPrintableAscii(label), MARGIN_X, y, {
      width: contentWidth * 0.5,
      align: 'left',
    });

  document
    .font(font)
    .fontSize(size)
    .text(toPrintableAscii(value), MARGIN_X + contentWidth * 0.5, y, {
      width: contentWidth * 0.5,
      align: 'right',
    });

  return y + (bold ? 14 : 12);
}

/**
 * Membangun dokumen PDF struk.
 *
 * Tinggi halaman dihitung dari jumlah item agar struk pendek tidak menyisakan
 * kertas kosong panjang dan struk panjang tidak terpotong. Nilai ini hanya
 * perkiraan; pemeriksaan batas halaman tetap menjaga agar tidak ada teks
 * keluar area cetak.
 */
export function buildReceiptDocument(payload: ReceiptPayload): PDFKit.PDFDocument {
  const paperWidth = resolvePaperWidth();
  const contentWidth = paperWidth - MARGIN_X * 2;

  const itemCount = payload.items.length;
  const estimatedHeight =
    MARGIN_TOP +
    HEADER_HEIGHT +
    itemCount * ITEM_BLOCK_HEIGHT +
    TOTALS_HEIGHT +
    FOOTER_HEIGHT +
    MARGIN_BOTTOM;

  const pageHeight = Math.max(MIN_PAGE_HEIGHT, Math.ceil(estimatedHeight));

  const document = new PDFDocument({
    size: [paperWidth, pageHeight],
    margins: {
      top: MARGIN_TOP,
      bottom: MARGIN_BOTTOM,
      left: MARGIN_X,
      right: MARGIN_X,
    },
    autoFirstPage: false,
    info: {
      Title: `Struk ${payload.transaction.invoiceNumber}`,
      Author: payload.store.name,
      Subject: 'Struk Pembayaran',
    },
  });

  document.addPage({ size: [paperWidth, pageHeight] });

  let y = MARGIN_TOP;

  /* ---------------------------- HEADER TOKO ---------------------------- */

  const storeName = toPrintableAscii(payload.store.name);
  document
    .font(FONT_BOLD)
    .fontSize(11)
    .fillColor('#000000')
    .text(storeName, MARGIN_X, y, { width: contentWidth, align: 'center' });
  y += document.heightOfString(storeName, { width: contentWidth }) + 3;

  if (payload.store.address.length > 0) {
    const address = toPrintableAscii(payload.store.address);
    document
      .font(FONT_REGULAR)
      .fontSize(7)
      .text(address, MARGIN_X, y, { width: contentWidth, align: 'center' });
    y += document.heightOfString(address, { width: contentWidth }) + 1;
  }

  if (payload.store.phone.length > 0) {
    const phone = toPrintableAscii(`Telp: ${payload.store.phone}`);
    document
      .font(FONT_REGULAR)
      .fontSize(7)
      .text(phone, MARGIN_X, y, { width: contentWidth, align: 'center' });
    y += document.heightOfString(phone, { width: contentWidth }) + 1;
  }

  y += 6;
  drawDivider(document, y, contentWidth);
  y += 8;

  /* --------------------------- INFO NOTA ------------------------------ */

  y = drawKeyValue(
    document,
    'No. Nota',
    payload.transaction.invoiceNumber,
    y,
    contentWidth,
    false,
  );
  y = drawKeyValue(
    document,
    'Tanggal',
    formatReceiptDate(payload.transaction.createdAt),
    y,
    contentWidth,
    false,
  );

  y += 4;
  drawDivider(document, y, contentWidth);
  y += 8;

  /* ----------------------------- ITEM --------------------------------- */

  if (itemCount === 0) {
    document
      .font(FONT_REGULAR)
      .fontSize(8)
      .fillColor('#000000')
      .text('Tidak ada item pada nota ini.', MARGIN_X, y, {
        width: contentWidth,
        align: 'center',
      });
    y += 16;
  } else {
    for (const item of payload.items) {
      // Jaga-jaga bila perkiraan tinggi meleset: pindah halaman baru.
      if (y > pageHeight - MARGIN_BOTTOM - TOTALS_HEIGHT - FOOTER_HEIGHT) {
        document.addPage({ size: [paperWidth, pageHeight] });
        y = MARGIN_TOP;
      }
      y = drawItem(document, item, y, contentWidth);
    }
  }

  y += 2;
  drawDivider(document, y, contentWidth);
  y += 8;

  /* ----------------------------- TOTAL -------------------------------- */

  y = drawKeyValue(
    document,
    'TOTAL',
    formatCurrency(payload.transaction.totalAmount),
    y,
    contentWidth,
    true,
  );
  y = drawKeyValue(
    document,
    'Tunai',
    formatCurrency(payload.transaction.cashPaid),
    y,
    contentWidth,
    false,
  );
  y = drawKeyValue(
    document,
    'Kembali',
    formatCurrency(payload.transaction.changeAmount),
    y,
    contentWidth,
    true,
  );

  y += 6;
  drawDivider(document, y, contentWidth);
  y += 8;

  /* ----------------------------- FOOTER ------------------------------- */

  if (payload.store.footer.length > 0) {
    const footer = toPrintableAscii(payload.store.footer);
    document
      .font(FONT_REGULAR)
      .fontSize(7)
      .fillColor('#000000')
      .text(footer, MARGIN_X, y, { width: contentWidth, align: 'center' });
    y += document.heightOfString(footer, { width: contentWidth }) + 2;
  }

  const printedAt = toPrintableAscii(`Dicetak: ${formatReceiptDate(new Date())}`);
  document
    .font(FONT_REGULAR)
    .fontSize(6)
    .fillColor('#444444')
    .text(printedAt, MARGIN_X, y, { width: contentWidth, align: 'center' });

  return document;
}

/* =============================================================================
 * 5. STREAMING KE HTTP RESPONSE
 * ========================================================================== */

/**
 * Mengalirkan struk PDF ke tujuan tulis (biasanya `res` Express).
 *
 * `pipeline` dipakai, bukan `doc.pipe(res)` polos, karena:
 *   - backpressure ditangani otomatis (kasir dengan koneksi lambat tidak
 *     membuat seluruh PDF tertahan di memori);
 *   - error pada tujuan (klien menutup tab) ikut membatalkan dokumen sumber,
 *     sehingga tidak ada generator PDF yang terus berjalan tanpa pembaca.
 *
 * Parameter `destination` bertipe `Writable` - bukan `Response` Express -
 * agar service ini tetap bebas dari dependensi framework dan dapat diuji
 * dengan stream in-memory.
 */
export async function streamReceipt(
  payload: ReceiptPayload,
  destination: Writable,
): Promise<void> {
  const document = buildReceiptDocument(payload);

  try {
    const finished = pipeline(document, destination);
    // `end()` memicu PDFKit menulis seluruh isi dokumen ke stream.
    document.end();
    await finished;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[pdf.service] Gagal mengalirkan struk PDF:', message);

    // Bila header HTTP sudah terkirim, response tidak dapat diubah lagi;
    // biarkan Controller yang memutus koneksi.
    throw new AppError(
      500,
      'INTERNAL_ERROR',
      'Struk PDF gagal dibuat. Silakan coba cetak ulang.',
    );
  }
}

/**
 * Membangun struk sebagai Buffer.
 * Berguna untuk pengujian blackbox (memeriksa ukuran & tanda tangan `%PDF`)
 * tanpa perlu server HTTP.
 */
export async function renderReceiptBuffer(payload: ReceiptPayload): Promise<Buffer> {
  const document = buildReceiptDocument(payload);
  const chunks: Buffer[] = [];

  return new Promise<Buffer>((resolve, reject) => {
    document.on('data', (chunk: Buffer): void => {
      chunks.push(chunk);
    });
    document.on('end', (): void => {
      resolve(Buffer.concat(chunks));
    });
    document.on('error', (error: Error): void => {
      reject(
        new AppError(
          500,
          'INTERNAL_ERROR',
          `Struk PDF gagal dibuat: ${error.message}`,
        ),
      );
    });

    document.end();
  });
}

/* =============================================================================
 * 6. EKSPOR NAMA DEFAULT
 * ========================================================================== */

const pdfService = {
  loadStoreProfile,
  formatCurrency,
  buildReceiptDocument,
  streamReceipt,
  renderReceiptBuffer,
} as const;

export default pdfService;
