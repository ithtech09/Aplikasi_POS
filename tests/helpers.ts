/**
 * =============================================================================
 * tests/helpers.ts
 * Utilitas bersama untuk pengujian blackbox.
 * =============================================================================
 *
 * BUKAN file test (tidak cocok dengan pola `*.test.ts`), sehingga tidak
 * dijalankan Jest sebagai suite. Berisi:
 *   - pemuatan environment test,
 *   - pembersihan database,
 *   - pembuatan menu uji lewat HTTP (bukan INSERT langsung), agar pengujian
 *     tetap blackbox: aplikasi diperlakukan sebagai kotak hitam.
 */

import 'dotenv/config';
import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/server';
import { closePool, query } from '../src/config/database';
import type { Product } from '../src/types';

/** Memaksa NODE_ENV=test agar `resolveDatabaseUrl()` memakai TEST_DATABASE_URL. */
export function forceTestEnv(): void {
  process.env.NODE_ENV = 'test';
}

/** Instance aplikasi tanpa membuka port. */
export function buildApp(): Express {
  forceTestEnv();
  return createApp();
}

/**
 * Mengosongkan seluruh tabel.
 * RESTART IDENTITY membuat id kembali dari 1 sehingga assertion bisa
 * memakai angka yang dapat diprediksi.
 */
export async function resetDatabase(): Promise<void> {
  await query('TRUNCATE TABLE transaction_items, transactions RESTART IDENTITY CASCADE');
  await query('TRUNCATE TABLE products RESTART IDENTITY CASCADE');
}

/** Menutup pool agar Jest tidak menggantung karena handle terbuka. */
export async function shutdown(): Promise<void> {
  await closePool();
}

/** Membuat menu lewat endpoint HTTP dan mengembalikan entitasnya. */
export async function createProductViaApi(
  app: Express,
  overrides: Partial<{
    sku: string;
    name: string;
    category: string;
    price: number;
    stock: number;
  }> = {},
): Promise<Product> {
  const payload = {
    sku: overrides.sku ?? `TST-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    name: overrides.name ?? 'Menu Uji',
    category: overrides.category ?? 'Makanan',
    price: overrides.price ?? 10000,
    stock: overrides.stock ?? 50,
  };

  const response = await request(app)
    .post('/admin/products')
    .set('Accept', 'application/json')
    .send(payload);

  if (response.status !== 201) {
    throw new Error(
      `Gagal membuat menu uji (status ${response.status}): ${JSON.stringify(response.body)}`,
    );
  }

  return response.body.data as Product;
}

/** Membaca stok terkini langsung dari database (verifikasi efek samping). */
export async function readStock(productId: number): Promise<number> {
  const result = await query<{ stock: number }>(
    'SELECT stock FROM products WHERE id = $1',
    [productId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`Menu id ${productId} tidak ditemukan.`);
  }
  return row.stock;
}

/** Menghitung jumlah baris pada sebuah tabel. */
export async function countRows(table: 'products' | 'transactions' | 'transaction_items'): Promise<number> {
  const result = await query<{ total: string }>(`SELECT COUNT(*)::text AS total FROM ${table}`);
  const row = result.rows[0];
  return row === undefined ? 0 : Number.parseInt(row.total, 10);
}

/** Tanggal hari ini menurut APP_TIMEZONE, format YYYY-MM-DD. */
export function todayKey(): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: process.env.APP_TIMEZONE ?? 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());

  const read = (type: 'year' | 'month' | 'day'): string => {
    const found = parts.find((part) => part.type === type);
    return found === undefined ? '1970' : found.value;
  };

  return `${read('year')}-${read('month')}-${read('day')}`;
}
