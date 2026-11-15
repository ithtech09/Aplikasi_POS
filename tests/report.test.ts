/**
 * =============================================================================
 * tests/report.test.ts
 * Pengujian BLACKBOX laporan harian.
 * =============================================================================
 *
 * Verifikasi: kalkulasi omzet, jumlah transaksi, dan porsi terjual harus
 * sesuai dengan data transaksi pada tanggal yang diminta — dan TIDAK
 * terpengaruh transaksi pada tanggal lain.
 */

import request from 'supertest';
import type { Express } from 'express';
import { query } from '../src/config/database';
import {
  buildApp,
  countRows,
  createProductViaApi,
  forceTestEnv,
  resetDatabase,
  shutdown,
  todayKey,
} from './helpers';

let app: Express;

beforeAll(() => {
  forceTestEnv();
  app = buildApp();
});

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await shutdown();
});

function checkout(payload: unknown) {
  return request(app)
    .post('/pos/checkout')
    .set('Accept', 'application/json')
    .send(payload);
}

describe('GET /admin/reports/daily', () => {
  it('POSITIF: menghitung omzet, transaksi, dan porsi terjual dengan benar', async () => {
    const nasi = await createProductViaApi(app, {
      sku: 'MKN-001',
      name: 'Nasi Goreng',
      price: 15000,
      stock: 50,
    });
    const teh = await createProductViaApi(app, {
      sku: 'MNM-001',
      name: 'Es Teh',
      price: 5000,
      stock: 50,
    });

    // Transaksi 1: 2 nasi + 1 teh = 35000
    await checkout({
      items: [
        { productId: nasi.id, quantity: 2 },
        { productId: teh.id, quantity: 1 },
      ],
      cashPaid: 50000,
    });

    // Transaksi 2: 1 nasi + 3 teh = 30000
    await checkout({
      items: [
        { productId: nasi.id, quantity: 1 },
        { productId: teh.id, quantity: 3 },
      ],
      cashPaid: 50000,
    });

    const response = await request(app)
      .get(`/admin/reports/daily?date=${todayKey()}`)
      .set('Accept', 'application/json');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);

    const report = response.body.data;

    // Omzet = 35000 + 30000
    expect(report.summary.totalRevenue).toBe(65000);
    expect(report.summary.totalTransactions).toBe(2);
    // Porsi = (2+1) nasi + (1+3) teh
    expect(report.summary.totalItemsSold).toBe(7);

    // Rincian per menu.
    expect(report.items.length).toBe(2);

    const nasiRow = report.items.find((item: { sku: string }) => item.sku === 'MKN-001');
    const tehRow = report.items.find((item: { sku: string }) => item.sku === 'MNM-001');

    expect(nasiRow).toBeDefined();
    expect(nasiRow.totalQuantity).toBe(3);
    expect(nasiRow.totalRevenue).toBe(45000);
    expect(nasiRow.priceAtSale).toBe(15000);

    expect(tehRow).toBeDefined();
    expect(tehRow.totalQuantity).toBe(4);
    expect(tehRow.totalRevenue).toBe(20000);
    expect(tehRow.priceAtSale).toBe(5000);
  });

  it('POSITIF: tanggal tanpa transaksi menghasilkan nol, bukan NaN', async () => {
    const response = await request(app)
      .get('/admin/reports/daily?date=2020-01-01')
      .set('Accept', 'application/json');

    expect(response.status).toBe(200);
    expect(response.body.data.summary.totalRevenue).toBe(0);
    expect(response.body.data.summary.totalTransactions).toBe(0);
    expect(response.body.data.summary.totalItemsSold).toBe(0);
    expect(response.body.data.items).toEqual([]);
  });

  it('POSITIF: transaksi tanggal lain tidak masuk hitungan', async () => {
    const menu = await createProductViaApi(app, { price: 10000, stock: 50 });

    await checkout({ items: [{ productId: menu.id, quantity: 2 }], cashPaid: 20000 });

    // Geser transaksi ke 5 hari lalu.
    await query(
      "UPDATE transactions SET created_at = created_at - INTERVAL '5 days'",
    );

    const today = await request(app)
      .get(`/admin/reports/daily?date=${todayKey()}`)
      .set('Accept', 'application/json');

    expect(today.body.data.summary.totalRevenue).toBe(0);
    expect(today.body.data.summary.totalTransactions).toBe(0);

    // Tanggal lampau memuat transaksi tersebut.
    const past = new Date();
    past.setDate(past.getDate() - 5);
    const pastKey = new Intl.DateTimeFormat('en-CA', {
      timeZone: process.env.APP_TIMEZONE ?? 'Asia/Jakarta',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(past);

    const pastReport = await request(app)
      .get(`/admin/reports/daily?date=${pastKey}`)
      .set('Accept', 'application/json');

    expect(pastReport.status).toBe(200);
    expect(pastReport.body.data.summary.totalRevenue).toBe(20000);
    expect(pastReport.body.data.summary.totalTransactions).toBe(1);
  });

  it('POSITIF: tanpa parameter date memakai tanggal hari ini', async () => {
    const menu = await createProductViaApi(app, { price: 7000, stock: 10 });
    await checkout({ items: [{ productId: menu.id, quantity: 1 }], cashPaid: 7000 });

    const response = await request(app)
      .get('/admin/reports/daily')
      .set('Accept', 'application/json');

    expect(response.status).toBe(200);
    expect(response.body.data.date).toBe(todayKey());
    expect(response.body.data.summary.totalRevenue).toBe(7000);
  });

  it('POSITIF: laporan memakai harga historis, bukan harga terkini', async () => {
    const menu = await createProductViaApi(app, { price: 10000, stock: 20 });

    await checkout({ items: [{ productId: menu.id, quantity: 2 }], cashPaid: 20000 });

    // Harga dinaikkan setelah transaksi.
    await request(app)
      .post(`/admin/products/${menu.id}`)
      .set('Accept', 'application/json')
      .send({ price: 50000 });

    const response = await request(app)
      .get(`/admin/reports/daily?date=${todayKey()}`)
      .set('Accept', 'application/json');

    // Omzet tetap 20000 (harga saat transaksi), bukan 100000.
    expect(response.body.data.summary.totalRevenue).toBe(20000);
    expect(response.body.data.items[0].priceAtSale).toBe(10000);
  });

  it('NEGATIF: tanggal tidak valid ditolak 400', async () => {
    const bad = await request(app)
      .get('/admin/reports/daily?date=2026-02-30')
      .set('Accept', 'application/json');

    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');

    const malformed = await request(app)
      .get('/admin/reports/daily?date=kemarin')
      .set('Accept', 'application/json');

    expect(malformed.status).toBe(400);
  });

  it('POSITIF: halaman HTML laporan merender kartu metrik', async () => {
    const menu = await createProductViaApi(app, { price: 11000, stock: 10 });
    await checkout({ items: [{ productId: menu.id, quantity: 1 }], cashPaid: 11000 });

    const response = await request(app).get(`/admin/reports/daily?date=${todayKey()}`);

    expect(response.status).toBe(200);
    expect(response.text).toContain('Total Omzet Harian');
    expect(response.text).toContain('Total Transaksi Berhasil');
    expect(response.text).toContain('Total Porsi Menu Terjual');
    expect(response.text).toContain('11.000');
  });
});

describe('Konsistensi laporan dengan database', () => {
  it('POSITIF: total omzet laporan sama dengan jumlah total_amount di database', async () => {
    const menu = await createProductViaApi(app, { price: 8000, stock: 30 });

    await checkout({ items: [{ productId: menu.id, quantity: 3 }], cashPaid: 30000 });
    await checkout({ items: [{ productId: menu.id, quantity: 2 }], cashPaid: 20000 });

    const dbResult = await query<{ total: string }>(
      'SELECT COALESCE(SUM(total_amount), 0)::text AS total FROM transactions',
    );
    const dbTotal = Number.parseFloat(dbResult.rows[0]?.total ?? '0');

    const response = await request(app)
      .get(`/admin/reports/daily?date=${todayKey()}`)
      .set('Accept', 'application/json');

    expect(response.body.data.summary.totalRevenue).toBe(dbTotal);
    expect(await countRows('transactions')).toBe(2);
  });
});
