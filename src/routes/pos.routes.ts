/**
 * =============================================================================
 * src/routes/pos.routes.ts
 * Definisi rute terminal kasir, checkout, struk, dan cetak PDF.
 * =============================================================================
 */

import { Router } from 'express';
import posController from '../controllers/pos.controller';

const router = Router();

/** Terminal kasir: daftar menu aktif + keranjang. */
router.get('/', posController.showTerminal);

/** Checkout ACID: validasi stok, hitung kembalian, catat nota. */
router.post('/checkout', posController.checkout);

/** Pratinjau nota (HTML) + tombol unduh PDF. */
router.get('/transactions/:id', posController.showReceipt);

/** Struk PDF 80mm, dialirkan on-the-fly tanpa headless browser. */
router.get('/transactions/:id/pdf', posController.downloadReceiptPdf);

export default router;
