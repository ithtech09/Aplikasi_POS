# Express POS Kantin

Aplikasi Manajemen Menu & Point of Sale (POS) kantin monolitik:
Node.js + Express + TypeScript + PostgreSQL + EJS + Tailwind CSS v4 + PDFKit.

## Prasyarat

- Node.js >= 18.18
- PostgreSQL >= 14
- npm >= 9

## Instalasi

```bash
npm install

# Buat database
createdb pos_kantin_db
createdb pos_kantin_test

# Terapkan skema ke database pengembangan
psql "$DATABASE_URL" -f database/schema.sql

# Terapkan skema ke database pengujian
psql "$TEST_DATABASE_URL" -f database/schema.sql

# Kompilasi Tailwind
npm run css:build
```

## Menjalankan

```bash
npm run dev        # pengembangan (ts-node-dev)
npm run build      # kompilasi TypeScript ke dist/
npm start          # produksi
```

Buka:

| Halaman | URL |
|---|---|
| Terminal kasir | http://localhost:3000/pos |
| Panel admin | http://localhost:3000/admin |
| Laporan harian | http://localhost:3000/admin/reports/daily |
| Health check | http://localhost:3000/health |

## Pengujian

```bash
npm test
```

Pengujian bersifat **blackbox**: hanya endpoint HTTP yang dipanggil, dan
efeknya diperiksa langsung di database. `NODE_ENV=test` memaksa pemakaian
`TEST_DATABASE_URL`, sehingga database pengembangan tidak pernah terhapus.

Cakupan:

- `tests/product.test.ts` — CRUD menu, penolakan `price < 0` / `stock < 0`, SKU duplikat, soft delete.
- `tests/transaction.test.ts` — checkout ACID, perhitungan kembalian, ROLLBACK saat stok kurang, penolakan uang kurang, struk & PDF.
- `tests/report.test.ts` — omzet harian, porsi terjual, isolasi per tanggal, harga historis.

## Struktur

```text
src/
├── config/database.ts      Pool singleton + helper transaksi ACID
├── controllers/            Handler HTTP (admin, pos, report)
├── models/                 Query SQL bertipe (product, transaction, report)
├── services/pdf.service.ts Generasi struk PDF 80mm
├── routes/                 Definisi rute
├── types/index.ts          Tipe global, AppError, validator, utilitas waktu
├── input.css               Sumber Tailwind CSS v4
└── server.ts               Entry point (createApp + startServer)
views/                      Template EJS
tests/                      Pengujian blackbox Jest + Supertest
database/schema.sql         DDL PostgreSQL
```

## Keputusan teknis penting

1. **Uang memakai `NUMERIC`, bukan float.** Driver `pg` mengembalikan NUMERIC
   sebagai string; konversi ke `number` hanya terjadi di layer model, dan
   `roundMoney()` dipakai sebelum menulis agar CHECK
   `change_amount = cash_paid - total_amount` selalu terpenuhi.
2. **Harga historis.** `transaction_items.price_at_sale` menyimpan salinan
   harga saat transaksi, sehingga laporan lama tidak berubah ketika harga
   menu diedit.
3. **Nomor nota race-safe.** `pg_advisory_xact_lock` per tanggal menyerialkan
   penomoran tanpa mengunci seluruh tabel.
4. **Deadlock dicegah.** `SELECT ... FOR UPDATE` selalu `ORDER BY id`.
5. **Batas hari laporan.** `created_at AT TIME ZONE current_setting('TimeZone')`
   membuat laporan benar walau zona waktu server database berbeda dari
   `APP_TIMEZONE`.
6. **Struk tanpa headless browser.** PDFKit menggambar langsung ke stream;
   `pipeline` menangani backpressure dan pembatalan.
