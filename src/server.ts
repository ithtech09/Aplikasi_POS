/**
 * =============================================================================
 * src/server.ts
 * Entry point utama server Express.
 * =============================================================================
 *
 * Tanggung jawab:
 *   1. Memuat `.env` paling awal (sebelum modul lain membaca process.env).
 *   2. Menyusun middleware global (body parser, static, view engine).
 *   3. Memasang seluruh router.
 *   4. Menangani 404 dan error terpusat.
 *   5. Menutup koneksi database dengan rapi saat proses dihentikan.
 *
 * EKSPOR `createApp()` DIPISAH DARI `startServer()` agar Supertest dapat
 * menguji aplikasi tanpa benar-benar membuka port - pola standar untuk
 * pengujian blackbox HTTP.
 */

import 'dotenv/config';

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import path from 'node:path';

import adminRoutes from './routes/admin.routes';
import posRoutes from './routes/pos.routes';
import reportRoutes from './routes/report.routes';
import { closePool, pingDatabase } from './config/database';
import { AppError, isAppError, type ApiFailure } from './types';

/* =============================================================================
 * 1. KONSTANTA
 * ========================================================================== */

const DEFAULT_PORT = 3000;

/** Batas ukuran body: keranjang besar tetap wajar, payload raksasa ditolak. */
const BODY_LIMIT = '256kb';

/* =============================================================================
 * 2. PEMBUAT APLIKASI
 * ========================================================================== */

/**
 * Menyusun instance Express lengkap dengan seluruh middleware dan router.
 * Tidak membuka port, sehingga aman dipanggil berkali-kali di dalam test.
 */
export function createApp(): Express {
  const app = express();

  // View engine EJS; folder `views/` berada di root proyek.
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));

  // Menyembunyikan header `X-Powered-By: Express`.
  app.disable('x-powered-by');

  // `extended: false` membatasi parser ke pasangan kunci-nilai sederhana,
  // sehingga body bersarang dalam tidak dapat menyusup sebagai objek.
  app.use(express.urlencoded({ extended: false, limit: BODY_LIMIT }));
  app.use(express.json({ limit: BODY_LIMIT }));

  // Aset statis: hasil kompilasi Tailwind.
  app.use('/public', express.static(path.join(__dirname, '..', 'public')));

  /* ------------------------------ Health check ------------------------ */

  app.get('/health', async (_req: Request, res: Response): Promise<void> => {
    const databaseUp = await pingDatabase();
    res.status(databaseUp ? 200 : 503).json({
      success: databaseUp,
      data: { database: databaseUp ? 'up' : 'down' },
    });
  });

  /* -------------------------------- Halaman --------------------------- */

  app.get('/', (_req: Request, res: Response): void => {
    res.redirect(302, '/pos');
  });

  app.use('/admin/reports', reportRoutes);
  app.use('/admin', adminRoutes);
  app.use('/pos', posRoutes);

  /* ------------------------------ 404 --------------------------------- */

  app.use((req: Request, res: Response): void => {
    const accept = req.get('accept') ?? '';
    const message = `Halaman "${req.method} ${req.originalUrl}" tidak ditemukan.`;

    if (accept.includes('application/json')) {
      const payload: ApiFailure = {
        success: false,
        error: { code: 'NOT_FOUND', message, details: [] },
      };
      res.status(404).json(payload);
      return;
    }

    res.status(404).type('text/plain').send(message);
  });

  /* --------------------------- Error terpusat -------------------------- */

  // Express mengenali error handler dari empat parameter; `_next` wajib ada
  // meskipun tidak dipakai, jika tidak Express memperlakukannya sebagai
  // middleware biasa.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    const appError = isAppError(error)
      ? error
      : new AppError(
          500,
          'INTERNAL_ERROR',
          'Terjadi kesalahan internal pada server.',
        );

    if (!isAppError(error)) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[server] Kesalahan tak tertangani:', message);
    }

    if (res.headersSent) {
      res.end();
      return;
    }

    res.status(appError.statusCode).json(appError.toPayload());
  });

  return app;
}

/* =============================================================================
 * 3. MENJALANKAN SERVER
 * ========================================================================== */

/** Membaca PORT dari env dengan validasi; nilai aneh tidak menggagalkan boot. */
function resolvePort(): number {
  const raw = process.env.PORT;
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_PORT;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    console.warn(`[server] PORT "${raw}" tidak valid; memakai ${DEFAULT_PORT}.`);
    return DEFAULT_PORT;
  }
  return parsed;
}

/** Menjalankan HTTP server dan memasang penanganan penghentian. */
export function startServer(): void {
  const app = createApp();
  const port = resolvePort();

  const server = app.listen(port, (): void => {
    console.log(`[server] Berjalan di http://localhost:${port}`);
    console.log('[server] Kasir: /pos | Admin: /admin | Laporan: /admin/reports/daily');
  });

  /**
   * Menutup server lalu pool database.
   * Tanpa ini, `pm2 restart` akan meninggalkan koneksi PostgreSQL
   * menggantung sampai `idle_timeout` server tercapai.
   */
  const shutdown = (signal: string): void => {
    console.log(`[server] Menerima ${signal}; menutup koneksi...`);
    server.close((): void => {
      void closePool()
        .then((): void => {
          console.log('[server] Pool database ditutup. Keluar.');
          process.exit(0);
        })
        .catch((error: unknown): void => {
          const message = error instanceof Error ? error.message : String(error);
          console.error('[server] Gagal menutup pool:', message);
          process.exit(1);
        });
    });
  };

  process.on('SIGINT', (): void => shutdown('SIGINT'));
  process.on('SIGTERM', (): void => shutdown('SIGTERM'));
}

// Hanya boot otomatis bila dijalankan langsung (`node dist/server.js`),
// bukan saat diimpor oleh Supertest.
if (require.main === module) {
  startServer();
}

export default createApp;
