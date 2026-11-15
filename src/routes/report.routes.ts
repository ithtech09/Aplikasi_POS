/**
 * =============================================================================
 * src/routes/report.routes.ts
 * Definisi rute laporan harian.
 * =============================================================================
 *
 * Rute ini dipasang pada `/admin/reports`, sehingga URL akhirnya adalah
 * `/admin/reports/daily` sesuai spesifikasi blueprint.
 */

import { Router } from 'express';
import reportController from '../controllers/report.controller';

const router = Router();

/** Laporan harian; parameter opsional `?date=YYYY-MM-DD`. */
router.get('/daily', reportController.showDailyReport);

export default router;
