/**
 * =============================================================================
 * src/config/database.ts
 * Konfigurasi koneksi pool PostgreSQL (SINGLETON) + helper transaksi ACID.
 * =============================================================================
 *
 * Tanggung jawab file ini HANYA:
 *   1. Membaca konfigurasi koneksi dari environment & memvalidasinya.
 *   2. Menyediakan SATU instance `Pool` untuk seluruh aplikasi (singleton).
 *   3. Menyediakan `query()` bertipe untuk query non-transaksional.
 *   4. Menyediakan `withTransaction()` yang menjamin BEGIN/COMMIT/ROLLBACK.
 *
 * File ini TIDAK mengandung SQL domain (itu tugas `models/`) dan TIDAK
 * menyentuh `req`/`res` (itu tugas `controllers/`).
 */

import {
  Pool,
  type PoolClient,
  type PoolConfig,
  type QueryResult,
  type QueryResultRow,
} from 'pg';
import { AppError, isAppError, isPlainObject } from '../types';

/* =============================================================================
 * 1. KONSTANTA DEFAULT
 * ========================================================================== */

const DEFAULT_POOL_MAX = 10;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
const APPLICATION_NAME = 'express-pos-kantin';

/* =============================================================================
 * 2. PEMBACA ENVIRONMENT YANG KETAT
 * ========================================================================== */

/**
 * Membaca string environment; string kosong / hanya spasi dianggap tidak diset.
 * Mengembalikan `string | undefined` sehingga pemanggil wajib menangani kasus kosong.
 */
function readString(name: string): string | undefined {
  const raw: string | undefined = process.env[name];
  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Membaca bilangan bulat positif; nilai tidak valid langsung menggagalkan boot. */
function readPositiveInt(name: string, fallback: number): number {
  const raw = readString(name);
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `Konfigurasi database tidak valid: ${name} harus bilangan bulat positif, diterima "${raw}".`,
    );
  }
  return parsed;
}

/** Membaca boolean dari string umum (true/1/yes/on dan false/0/no/off). */
function readBoolean(name: string, fallback: boolean): boolean {
  const raw = readString(name);
  if (raw === undefined) {
    return fallback;
  }
  const normalized = raw.toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  throw new Error(
    `Konfigurasi database tidak valid: ${name} harus boolean (true/false), diterima "${raw}".`,
  );
}

/* =============================================================================
 * 3. RESOLUSI DATABASE URL (PEMISAHAN DEV vs TEST)
 * ========================================================================== */

/** True bila proses berjalan di bawah Jest. */
export function isTestEnvironment(): boolean {
  return process.env.NODE_ENV === 'test';
}

/**
 * Menentukan connection string yang dipakai.
 *
 * KEAMANAN: saat NODE_ENV=test, fungsi ini MENOLAK memakai `DATABASE_URL`.
 * Tanpa penjagaan ini, satu salah-ketik pada `npm test` akan menjalankan
 * TRUNCATE terhadap database kantin yang sesungguhnya. Lebih baik gagal
 * keras saat boot daripada kehilangan data produksi.
 */
export function resolveDatabaseUrl(): string {
  if (isTestEnvironment()) {
    const testUrl = readString('TEST_DATABASE_URL');
    if (testUrl === undefined) {
      throw new Error(
        'TEST_DATABASE_URL belum diset. Pengujian tidak diizinkan memakai DATABASE_URL ' +
          'agar data pengembangan/produksi tidak terhapus. Contoh: ' +
          'TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/pos_kantin_test',
      );
    }
    return testUrl;
  }

  const mainUrl = readString('DATABASE_URL');
  if (mainUrl === undefined) {
    throw new Error(
      'DATABASE_URL belum diset. Contoh: ' +
        'DATABASE_URL=postgresql://postgres:postgres@localhost:5432/pos_kantin_db',
    );
  }
  return mainUrl;
}

/* =============================================================================
 * 4. PEMBENTUK KONFIGURASI POOL
 * ========================================================================== */

/** Menyusun `PoolConfig` dari environment. Dipisah agar mudah diuji & di-log. */
export function buildPoolConfig(): PoolConfig {
  const useSsl = readBoolean('DB_SSL', false);
  const statementTimeoutMs = readPositiveInt(
    'DB_STATEMENT_TIMEOUT_MS',
    DEFAULT_STATEMENT_TIMEOUT_MS,
  );

  return {
    connectionString: resolveDatabaseUrl(),
    application_name: APPLICATION_NAME,
    max: readPositiveInt('DB_POOL_MAX', DEFAULT_POOL_MAX),
    idleTimeoutMillis: readPositiveInt('DB_IDLE_TIMEOUT_MS', DEFAULT_IDLE_TIMEOUT_MS),
    connectionTimeoutMillis: readPositiveInt(
      'DB_CONNECTION_TIMEOUT_MS',
      DEFAULT_CONNECTION_TIMEOUT_MS,
    ),
    keepAlive: true,
    // Batas waktu di level server: query yang menggantung tidak boleh
    // menahan koneksi pool selamanya (mis. lock dari transaksi lain).
    options: `-c statement_timeout=${statementTimeoutMs}`,
    ssl: useSsl
      ? { rejectUnauthorized: readBoolean('DB_SSL_REJECT_UNAUTHORIZED', true) }
      : false,
  };
}

/* =============================================================================
 * 5. SINGLETON POOL
 * ========================================================================== */

let poolInstance: Pool | null = null;

/** Membuat pool baru dan memasang penangan error agar proses tidak crash. */
function createPool(): Pool {
  const pool = new Pool(buildPoolConfig());

  // Tanpa listener ini, error pada koneksi idle (mis. server restart)
  // akan menjadi `unhandled 'error' event` dan mematikan proses Node.
  pool.on('error', (error: Error): void => {
    console.error('[database] Kesalahan tak terduga pada koneksi idle pool:', error.message);
  });

  return pool;
}

/** Mengembalikan instance pool tunggal, membuatnya bila belum ada. */
export function getPool(): Pool {
  if (poolInstance === null) {
    poolInstance = createPool();
  }
  return poolInstance;
}

/* =============================================================================
 * 6. QUERY BERTIPE (NON-TRANSAKSIONAL)
 * ========================================================================== */

/**
 * Menjalankan satu query dengan Parameterized Query ($1, $2, ...).
 *
 * `T` wajib `extends QueryResultRow` sehingga hasilnya bertipe dan tidak
 * perlu di-cast. Pemanggil menentukan bentuk barisnya, misalnya:
 *   `query<ProductRow>('SELECT * FROM products WHERE id = $1', [id])`
 *
 * @param text   SQL dengan placeholder posisional.
 * @param params Nilai yang di-bind; JANGAN menyisipkan nilai ke dalam `text`.
 */
export async function query<T extends QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, [...params]);
}

/* =============================================================================
 * 7. HELPER TRANSAKSI ACID
 * ========================================================================== */

/**
 * Menjalankan `work` di dalam satu transaksi database.
 *
 * Jaminan:
 *   - `BEGIN` selalu dipanggil sebelum `work`.
 *   - `COMMIT` hanya dipanggil bila `work` selesai tanpa melempar error.
 *   - `ROLLBACK` selalu dipanggil bila `work` melempar error, lalu error
 *     asli di-`throw` ulang agar Controller dapat memetakannya ke HTTP.
 *   - Client SELALU dikembalikan ke pool (`release`), termasuk pada jalur error.
 *   - Bila `ROLLBACK` sendiri gagal, koneksi ditandai rusak dan dibuang
 *     (`release(true)`) alih-alih dikembalikan ke pool dalam keadaan kotor.
 *
 * Catatan: `work` WAJIB memakai `client` yang diberikan, bukan `query()`,
 * karena `query()` mengambil koneksi lain dari pool dan berada di luar transaksi.
 */
export async function withTransaction<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  let destroyClient = false;

  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error: unknown) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError: unknown) {
      destroyClient = true;
      const message =
        rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      console.error('[database] ROLLBACK gagal; koneksi akan dibuang:', message);
    }
    throw error;
  } finally {
    client.release(destroyClient);
  }
}

/* =============================================================================
 * 8. UTILITAS SIKLUS HIDUP
 * ========================================================================== */

/**
 * Menutup pool dan mereset singleton.
 * Wajib dipanggil pada `afterAll()` setiap suite Jest, jika tidak Jest akan
 * menggantung karena handle koneksi masih terbuka.
 */
export async function closePool(): Promise<void> {
  if (poolInstance === null) {
    return;
  }
  const pool = poolInstance;
  poolInstance = null;
  await pool.end();
}

/**
 * Memeriksa konektivitas database. Mengembalikan `false` alih-alih melempar
 * error, sehingga aman dipakai pada endpoint health-check.
 */
export async function pingDatabase(): Promise<boolean> {
  try {
    await query<{ ok: number }>('SELECT 1 AS ok');
    return true;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[database] Ping gagal:', message);
    return false;
  }
}

/* =============================================================================
 * 9. PENERJEMAH ERROR POSTGRESQL (DIPAKAI SEMUA MODEL)
 * ========================================================================== */

/** Bentuk minimal error `pg` yang diperlukan aplikasi. */
export interface PgErrorLike {
  readonly code: string;
  readonly constraint?: string;
  readonly message?: string;
}

/** Type guard struktural untuk `catch (error: unknown)`. */
export function isPgErrorLike(value: unknown): value is PgErrorLike {
  return isPlainObject(value) && typeof value.code === 'string';
}

/**
 * Teks yang disesuaikan per domain (tabel) oleh masing-masing Model.
 * `constraints` memetakan nama CHECK constraint PostgreSQL ke pesan pengguna.
 */
export interface PgErrorTranslation {
  readonly logPrefix: string;
  readonly uniqueViolation: string;
  readonly foreignKeyViolation: string;
  readonly constraints?: Readonly<Record<string, string>>;
  readonly invalidText?: string;
}

const DEFAULT_INVALID_TEXT_MESSAGE =
  'Format data yang dikirim tidak sesuai tipe yang diharapkan.';

/**
 * Menerjemahkan error apa pun menjadi `AppError` siap-petakan-HTTP.
 * Detail teknis database hanya di-log, tidak pernah dikirim ke klien.
 */
export function toAppError(error: unknown, translation: PgErrorTranslation): AppError {
  if (isAppError(error)) {
    return error;
  }

  if (isPgErrorLike(error)) {
    switch (error.code) {
      case '23505':
        return new AppError(409, 'CONFLICT', translation.uniqueViolation);
      case '23514': {
        const name = error.constraint;
        const friendly = name !== undefined ? translation.constraints?.[name] : undefined;
        return new AppError(
          422,
          'VALIDATION_ERROR',
          friendly ?? 'Data melanggar aturan validasi database.',
        );
      }
      case '23503':
        return new AppError(409, 'CONFLICT', translation.foreignKeyViolation);
      case '22P02':
        return new AppError(
          400,
          'VALIDATION_ERROR',
          translation.invalidText ?? DEFAULT_INVALID_TEXT_MESSAGE,
        );
      default:
        console.error(
          `${translation.logPrefix} Kesalahan database (code=${error.code}):`,
          error.message ?? 'tanpa pesan',
        );
        return new AppError(500, 'DATABASE_ERROR', 'Terjadi kesalahan pada database.');
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  console.error(`${translation.logPrefix} Kesalahan tak terduga:`, message);
  return new AppError(500, 'INTERNAL_ERROR', 'Terjadi kesalahan internal pada server.');
}
