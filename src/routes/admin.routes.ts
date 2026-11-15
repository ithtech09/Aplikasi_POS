/**
 * =============================================================================
 * src/routes/admin.routes.ts
 * Definisi rute panel Admin & manajemen menu.
 * =============================================================================
 *
 * Route hanya memetakan URL ke handler controller. Tidak ada logika bisnis,
 * tidak ada validasi, tidak ada SQL di lapisan ini.
 */

import { Router } from 'express';
import adminController from '../controllers/admin.controller';

const router = Router();

/** Dasbor: daftar seluruh menu (aktif & nonaktif). */
router.get('/', adminController.showDashboard);

/** Membuat menu baru. */
router.post('/products', adminController.createProduct);

/** Memperbarui menu secara parsial (harga, stok, nama, kategori, SKU). */
router.post('/products/:id', adminController.updateProduct);

/** Soft delete: menu berhenti dijual, riwayat transaksi tetap utuh. */
router.post('/products/:id/delete', adminController.deactivateProduct);

/** Mengaktifkan kembali menu yang sebelumnya dinonaktifkan. */
router.post('/products/:id/restore', adminController.activateProduct);

export default router;
