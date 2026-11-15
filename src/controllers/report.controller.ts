/**
 * =============================================================================
 * src/controllers/report.controller.ts
 * Logika HTTP halaman laporan harian.
 * =============================================================================
 *
 * Tanggung jawab: memvalidasi parameter tanggal, memanggil `report.model`,
 * dan merender hasilnya. Tidak ada SQL dan tidak ada agregasi di sini.
 *
 * Validasi tanggal dilakukan SEBELUM menyentuh database: `2026-02-30` ditolak
 * dengan 400, bukan diam-diam digeser ke 2 Maret oleh PostgreSQL.
 */

import type { Request, Response } from 'express';
import reportModel, { formatTodayKey } from '../models/report.model';
import { formatCurrency } from '../services/pdf.service';
import {
  AppError,
  isAppError,
  isValidDateKey,
  createViewContext,
  readFormValue,
  type ApiFailure,
  type ApiSuccess,
  type DailyReport,
  type ErrorCode,
} from '../types';

/* =============================================================================
 * 1. TIPE LOKAL
 * ========================================================================== */

type ReportRequest = Request<Record<string, string>, unknown, unknown>;

/* =============================================================================
 * 2. UTILITAS HTTP
 * ========================================================================== */

function wantsJson(req: ReportRequest): boolean {
  const accept = req.get('accept') ?? '';
  return accept.includes('application/json') || req.xhr;
}

function resolveAppError(error: unknown): AppError {
  if (isAppError(error)) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error('[report.controller] Kesalahan tak terduga:', message);
  return new AppError(500, 'INTERNAL_ERROR', 'Terjadi kesalahan internal pada server.');
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

function respondWithError(req: ReportRequest, res: Response<unknown>, error: unknown): void {
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
 * 3. HANDLER: LAPORAN HARIAN
 * ========================================================================== */

/**
 * GET /admin/reports/daily?date=YYYY-MM-DD
 *
 * `date` opsional; bila kosong dipakai tanggal hari ini menurut APP_TIMEZONE
 * (bukan tanggal server), sehingga laporan pukul 00:10 WIB tidak menampilkan
 * data hari kemarin.
 */
export async function showDailyReport(
  req: ReportRequest,
  res: Response<unknown>,
): Promise<void> {
  const rawDate = readFormValue(req.query.date);

  let dateKey: string;

  if (rawDate === undefined) {
    dateKey = formatTodayKey();
  } else if (!isValidDateKey(rawDate)) {
    const message = `Tanggal "${rawDate}" tidak valid. Gunakan format YYYY-MM-DD.`;
    if (wantsJson(req)) {
      sendJsonError(res, 400, 'VALIDATION_ERROR', message);
      return;
    }
    respondWithError(req, res, new AppError(400, 'VALIDATION_ERROR', message));
    return;
  } else {
    dateKey = rawDate;
  }

  try {
    const report: DailyReport = await reportModel.findDailyReport(dateKey);

    if (wantsJson(req)) {
      sendJsonSuccess(res, 200, report);
      return;
    }

    const viewContext = createViewContext('reports', 'Laporan Harian');

    res.status(200).render('admin/reports', {
      ...viewContext,
      report,
      todayKey: formatTodayKey(),
      formatCurrency,
    });
  } catch (error: unknown) {
    respondWithError(req, res, error);
  }
}

/* =============================================================================
 * 4. EKSPOR NAMA DEFAULT
 * ========================================================================== */

const reportController = {
  showDailyReport,
} as const;

export default reportController;
