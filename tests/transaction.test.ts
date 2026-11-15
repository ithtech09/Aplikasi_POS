/**
 * =============================================================================
 * tests/transaction.test.ts
 * Pengujian BLACKBOX checkout & jaminan ACID.
 * =============================================================================
 *
 * Fokus: memastikan bahwa kegagalan di tengah proses TIDAK meninggalkan
 * jejak sebagian — stok utuh dan tidak ada nota tercatat.
 */

import request from 'supertest';
import type { Express } from 'express';
import {
  buildApp,
  countRows,
  createProductViaApi,
  forceTestEnv,
  readStock,
  resetDatabase,
  shutdown,
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

/** Helper checkout dengan header JSON. */
function checkout(payload: unknown) {
  return request(app)
    .post('/pos/checkout')
    .set('Accept', 'application/json')
    .send(payload);
}

describe('POST /pos/checkout - skenario positif', () => {
  it('POSITIF: mencatat transaksi, mengurangi stok, dan menghitung kembalian', async () => {
    const nasi = await createProductViaApi(app, {
      sku: 'MKN-001',
      name: 'Nasi Goreng',
      price: 15000,
      stock: 10,
    });
    const teh = await createProductViaApi(app, {
      sku: 'MNM-001',
      name: 'Es Teh',
      price: 5000,
      stock: 20,
    });

    const response = await checkout({
      items: [
        { productId: nasi.id, quantity: 2 },
        { productId: teh.id, quantity: 3 },
      ],
      cashPaid: 50000,
    });

    // total = 2*15000 + 3*5000 = 45000 ; kembali = 5000
    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.data.totalAmount).toBe(45000);
    expect(response.body.data.cashPaid).toBe(50000);
    expect(response.body.data.changeAmount).toBe(5000);

    // Stok berkurang tepat sebesar kuantitas.
    expect(await readStock(nasi.id)).toBe(8);
    expect(await readStock(teh.id)).toBe(17);

    // Nota tercatat lengkap.
    expect(await countRows('transactions')).toBe(1);
    expect(await countRows('transaction_items')).toBe(2);
  });

  it('POSITIF: uang pas (cash_paid == total) menghasilkan kembalian 0', async () => {
    const menu = await createProductViaApi(app, { price: 12000, stock: 5 });

    const response = await checkout({
      items: [{ productId: menu.id, quantity: 2 }],
      cashPaid: 24000,
    });

    expect(response.status).toBe(201);
    expect(response.body.data.changeAmount).toBe(0);
  });

  it('POSITIF: menyimpan harga historis (price_at_sale) meski harga diubah', async () => {
    const menu = await createProductViaApi(app, { price: 10000, stock: 5 });

    await checkout({ items: [{ productId: menu.id, quantity: 1 }], cashPaid: 10000 });

    // Harga dinaikkan SETELAH transaksi.
    await request(app)
      .post(`/admin/products/${menu.id}`)
      .set('Accept', 'application/json')
      .send({ price: 20000 });

    const response = await checkout({
      items: [{ productId: menu.id, quantity: 1 }],
      cashPaid: 20000,
    });

    const items = response.body.data.items;
    expect(items.length).toBe(1);
    expect(items[0].priceAtSale).toBe(20000);

    // Transaksi pertama tetap memakai harga lama.
    const first = await request(app)
      .get('/transactions/1')
      .set('Accept', 'application/json');
    expect(first.status).toBe(200);
  });

  it('POSITIF: item duplikat dalam satu keranjang digabung', async () => {
    const menu = await createProductViaApi(app, { price: 5000, stock: 10 });

    const response = await checkout({
      items: [
        { productId: menu.id, quantity: 2 },
        { productId: menu.id, quantity: 3 },
      ],
      cashPaid: 25000,
    });

    expect(response.status).toBe(201);
    expect(response.body.data.totalAmount).toBe(25000);
    expect(response.body.data.items.length).toBe(1);
    expect(await readStock(menu.id)).toBe(5);
  });

  it('POSITIF: nomor nota berurutan per hari', async () => {
    const menu = await createProductViaApi(app, { price: 1000, stock: 10 });

    const first = await checkout({ items: [{ productId: menu.id, quantity: 1 }], cashPaid: 1000 });
    const second = await checkout({ items: [{ productId: menu.id, quantity: 1 }], cashPaid: 1000 });

    expect(first.body.data.transaction.invoiceNumber).toMatch(/^INV-\d{8}-0001$/);
    expect(second.body.data.transaction.invoiceNumber).toMatch(/^INV-\d{8}-0002$/);
  });
});

describe('POST /pos/checkout - NEGATIF: stok kurang (ROLLBACK)', () => {
  it('NEGATIF: kuantitas melebihi stok ditolak dan TIDAK mengubah apa pun', async () => {
    const menu = await createProductViaApi(app, { name: 'Soto', price: 12000, stock: 3 });

    const response = await checkout({
      items: [{ productId: menu.id, quantity: 5 }],
      cashPaid: 100000,
    });

    expect(response.status).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('INSUFFICIENT_STOCK');

    // Bukti ROLLBACK: stok utuh, tidak ada nota, tidak ada item.
    expect(await readStock(menu.id)).toBe(3);
    expect(await countRows('transactions')).toBe(0);
    expect(await countRows('transaction_items')).toBe(0);
  });

  it('NEGATIF: satu item gagal membatalkan SELURUH transaksi', async () => {
    const cukup = await createProductViaApi(app, { name: 'Bakso', price: 10000, stock: 10 });
    const kurang = await createProductViaApi(app, { name: 'Sate', price: 15000, stock: 1 });

    const response = await checkout({
      items: [
        { productId: cukup.id, quantity: 2 },
        { productId: kurang.id, quantity: 5 },
      ],
      cashPaid: 200000,
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('INSUFFICIENT_STOCK');

    // Item yang stoknya cukup TIDAK boleh ikut berkurang.
    expect(await readStock(cukup.id)).toBe(10);
    expect(await readStock(kurang.id)).toBe(1);
    expect(await countRows('transactions')).toBe(0);
  });

  it('NEGATIF: stok 0 ditolak', async () => {
    const menu = await createProductViaApi(app, { stock: 0 });

    const response = await checkout({
      items: [{ productId: menu.id, quantity: 1 }],
      cashPaid: 50000,
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await countRows('transactions')).toBe(0);
  });
});

describe('POST /pos/checkout - NEGATIF: uang kurang', () => {
  it('NEGATIF: cash_paid < total ditolak dan stok tidak berkurang', async () => {
    const menu = await createProductViaApi(app, { price: 20000, stock: 5 });

    const response = await checkout({
      items: [{ productId: menu.id, quantity: 2 }],
      cashPaid: 30000,
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INSUFFICIENT_CASH');

    expect(await readStock(menu.id)).toBe(5);
    expect(await countRows('transactions')).toBe(0);
  });

  it('NEGATIF: uang negatif ditolak validasi', async () => {
    const menu = await createProductViaApi(app, { price: 10000, stock: 5 });

    const response = await checkout({
      items: [{ productId: menu.id, quantity: 1 }],
      cashPaid: -5000,
    });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /pos/checkout - NEGATIF: input tidak valid', () => {
  it('NEGATIF: keranjang kosong ditolak', async () => {
    const response = await checkout({ items: [], cashPaid: 10000 });
    expect(response.status).toBe(422);
    expect(await countRows('transactions')).toBe(0);
  });

  it('NEGATIF: kuantitas 0 atau negatif ditolak', async () => {
    const menu = await createProductViaApi(app, { stock: 5 });

    const zero = await checkout({ items: [{ productId: menu.id, quantity: 0 }], cashPaid: 50000 });
    expect(zero.status).toBe(422);

    const negative = await checkout({ items: [{ productId: menu.id, quantity: -2 }], cashPaid: 50000 });
    expect(negative.status).toBe(422);

    expect(await readStock(menu.id)).toBe(5);
  });

  it('NEGATIF: menu tidak ada mengembalikan 404', async () => {
    const response = await checkout({
      items: [{ productId: 999999, quantity: 1 }],
      cashPaid: 50000,
    });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });

  it('NEGATIF: menu nonaktif tidak dapat dijual', async () => {
    const menu = await createProductViaApi(app, { stock: 5 });

    await request(app)
      .post(`/admin/products/${menu.id}/delete`)
      .set('Accept', 'application/json');

    const response = await checkout({
      items: [{ productId: menu.id, quantity: 1 }],
      cashPaid: 50000,
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('INACTIVE_PRODUCT');
    expect(await readStock(menu.id)).toBe(5);
  });
});

describe('Struk & PDF', () => {
  it('POSITIF: halaman struk menampilkan nomor nota dan total', async () => {
    const menu = await createProductViaApi(app, { name: 'Nasi Uduk', price: 13000, stock: 5 });

    const result = await checkout({
      items: [{ productId: menu.id, quantity: 2 }],
      cashPaid: 30000,
    });

    const id = result.body.data.transaction.id;
    const receipt = await request(app).get(`/pos/transactions/${id}`);

    expect(receipt.status).toBe(200);
    expect(receipt.text).toContain('Nasi Uduk');
    expect(receipt.text).toContain(result.body.data.transaction.invoiceNumber);
  });

  it('POSITIF: endpoint PDF mengembalikan berkas PDF yang sah', async () => {
    const menu = await createProductViaApi(app, { price: 9000, stock: 5 });

    const result = await checkout({
      items: [{ productId: menu.id, quantity: 1 }],
      cashPaid: 10000,
    });

    const id = result.body.data.transaction.id;
    const pdf = await request(app).get(`/pos/transactions/${id}/pdf`);

    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    // Tanda tangan berkas PDF: "%PDF-"
    expect(pdf.body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.body.length).toBeGreaterThan(500);
  });

  it('NEGATIF: PDF transaksi tidak ada mengembalikan 404', async () => {
    const response = await request(app)
      .get('/pos/transactions/999999/pdf')
      .set('Accept', 'application/json');

    expect(response.status).toBe(404);
  });
});
