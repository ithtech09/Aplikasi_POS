/**
 * =============================================================================
 * tests/product.test.ts
 * Pengujian BLACKBOX modul Manajemen Menu.
 * =============================================================================
 *
 * Pendekatan blackbox: hanya endpoint HTTP yang dipanggil dan efeknya pada
 * database yang diperiksa. Tidak ada impor ke controller/model secara
 * langsung, sehingga pengujian tetap sah bila implementasi diubah.
 */

import request from 'supertest';
import type { Express } from 'express';
import {
  buildApp,
  countRows,
  createProductViaApi,
  forceTestEnv,
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

describe('POST /admin/products - tambah menu', () => {
  it('POSITIF: menyimpan menu valid dan mengembalikan 201', async () => {
    const response = await request(app)
      .post('/admin/products')
      .set('Accept', 'application/json')
      .send({
        sku: 'MKN-001',
        name: 'Nasi Goreng',
        category: 'Makanan',
        price: 15000,
        stock: 20,
      });

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.data).toMatchObject({
      sku: 'MKN-001',
      name: 'Nasi Goreng',
      category: 'Makanan',
      price: 15000,
      stock: 20,
      isActive: true,
    });
    expect(typeof response.body.data.id).toBe('number');

    // Efek samping: data benar-benar tersimpan.
    expect(await countRows('products')).toBe(1);
  });

  it('POSITIF: harga 0 dan stok 0 diterima (batas bawah yang sah)', async () => {
    const response = await request(app)
      .post('/admin/products')
      .set('Accept', 'application/json')
      .send({ sku: 'FREE-001', name: 'Air Putih', price: 0, stock: 0 });

    expect(response.status).toBe(201);
    expect(response.body.data.price).toBe(0);
    expect(response.body.data.stock).toBe(0);
  });

  it('NEGATIF: price < 0 ditolak 422 dan tidak menyimpan apa pun', async () => {
    const response = await request(app)
      .post('/admin/products')
      .set('Accept', 'application/json')
      .send({ sku: 'NEG-001', name: 'Menu Negatif', price: -1000, stock: 10 });

    expect(response.status).toBe(422);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(await countRows('products')).toBe(0);
  });

  it('NEGATIF: stock < 0 ditolak 422 dan tidak menyimpan apa pun', async () => {
    const response = await request(app)
      .post('/admin/products')
      .set('Accept', 'application/json')
      .send({ sku: 'NEG-002', name: 'Stok Negatif', price: 5000, stock: -5 });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(await countRows('products')).toBe(0);
  });

  it('NEGATIF: SKU duplikat ditolak 409', async () => {
    await createProductViaApi(app, { sku: 'DUP-001' });

    const response = await request(app)
      .post('/admin/products')
      .set('Accept', 'application/json')
      .send({ sku: 'DUP-001', name: 'Menu Lain', price: 8000, stock: 5 });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CONFLICT');
    expect(await countRows('products')).toBe(1);
  });

  it('NEGATIF: field wajib kosong ditolak 422', async () => {
    const response = await request(app)
      .post('/admin/products')
      .set('Accept', 'application/json')
      .send({ sku: '', name: '', price: '', stock: '' });

    expect(response.status).toBe(422);
    expect(Array.isArray(response.body.error.details)).toBe(true);
    expect(response.body.error.details.length).toBeGreaterThan(0);
    expect(await countRows('products')).toBe(0);
  });

  it('NEGATIF: harga bukan angka ditolak 422 (bukan dikonversi diam-diam)', async () => {
    const response = await request(app)
      .post('/admin/products')
      .set('Accept', 'application/json')
      .send({ sku: 'BAD-001', name: 'Harga Aneh', price: '12abc', stock: 5 });

    expect(response.status).toBe(422);
    expect(await countRows('products')).toBe(0);
  });
});

describe('POST /admin/products/:id - ubah menu', () => {
  it('POSITIF: memperbarui harga dan stok', async () => {
    const product = await createProductViaApi(app, { price: 10000, stock: 10 });

    const response = await request(app)
      .post(`/admin/products/${product.id}`)
      .set('Accept', 'application/json')
      .send({ price: 12500, stock: 30 });

    expect(response.status).toBe(200);
    expect(response.body.data.price).toBe(12500);
    expect(response.body.data.stock).toBe(30);
  });

  it('POSITIF: update parsial stok saja tidak mengubah harga', async () => {
    const product = await createProductViaApi(app, { price: 17500, stock: 10 });

    const response = await request(app)
      .post(`/admin/products/${product.id}`)
      .set('Accept', 'application/json')
      .send({ stock: 42 });

    expect(response.status).toBe(200);
    expect(response.body.data.stock).toBe(42);
    expect(response.body.data.price).toBe(17500);
  });

  it('NEGATIF: price < 0 ditolak dan data lama tidak berubah', async () => {
    const product = await createProductViaApi(app, { price: 10000, stock: 10 });

    const response = await request(app)
      .post(`/admin/products/${product.id}`)
      .set('Accept', 'application/json')
      .send({ price: -1 });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');

    const check = await request(app).get('/admin').set('Accept', 'application/json');
    expect(check.status).toBe(200);
    // Harga tetap seperti semula (tidak rusak).
    const still = await request(app)
      .post(`/admin/products/${product.id}`)
      .set('Accept', 'application/json')
      .send({ stock: 11 });
    expect(still.body.data.price).toBe(10000);
  });

  it('NEGATIF: stock < 0 ditolak dan stok lama tidak berubah', async () => {
    const product = await createProductViaApi(app, { stock: 10 });

    const response = await request(app)
      .post(`/admin/products/${product.id}`)
      .set('Accept', 'application/json')
      .send({ stock: -3 });

    expect(response.status).toBe(422);

    const after = await request(app)
      .post(`/admin/products/${product.id}`)
      .set('Accept', 'application/json')
      .send({ price: 11000 });
    expect(after.body.data.stock).toBe(10);
  });

  it('NEGATIF: id tidak valid ditolak 400', async () => {
    const response = await request(app)
      .post('/admin/products/abc')
      .set('Accept', 'application/json')
      .send({ stock: 5 });

    expect(response.status).toBe(400);
  });

  it('NEGATIF: id tidak ada mengembalikan 404', async () => {
    const response = await request(app)
      .post('/admin/products/999999')
      .set('Accept', 'application/json')
      .send({ stock: 5 });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });
});

describe('Soft delete menu', () => {
  it('POSITIF: menonaktifkan menu tanpa menghapus baris', async () => {
    const product = await createProductViaApi(app);

    const response = await request(app)
      .post(`/admin/products/${product.id}/delete`)
      .set('Accept', 'application/json');

    expect(response.status).toBe(200);
    expect(response.body.data.isActive).toBe(false);
    expect(await countRows('products')).toBe(1);
  });

  it('POSITIF: menu nonaktif tidak muncul di terminal kasir', async () => {
    const product = await createProductViaApi(app, { name: 'Menu Nonaktif' });

    await request(app)
      .post(`/admin/products/${product.id}/delete`)
      .set('Accept', 'application/json');

    const terminal = await request(app).get('/pos');
    expect(terminal.status).toBe(200);
    expect(terminal.text).not.toContain('Menu Nonaktif');
  });

  it('POSITIF: menu dapat diaktifkan kembali', async () => {
    const product = await createProductViaApi(app);

    await request(app)
      .post(`/admin/products/${product.id}/delete`)
      .set('Accept', 'application/json');

    const response = await request(app)
      .post(`/admin/products/${product.id}/restore`)
      .set('Accept', 'application/json');

    expect(response.status).toBe(200);
    expect(response.body.data.isActive).toBe(true);
  });
});

describe('GET /admin - dasbor', () => {
  it('POSITIF: merender halaman admin dengan daftar menu', async () => {
    await createProductViaApi(app, { name: 'Mie Ayam Spesial' });

    const response = await request(app).get('/admin');
    expect(response.status).toBe(200);
    expect(response.text).toContain('Mie Ayam Spesial');
    expect(response.text).toContain('Manajemen Menu');
  });
});
