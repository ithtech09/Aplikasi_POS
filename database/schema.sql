-- =============================================================================
-- SKEMA DATABASE — express-pos-kantin
-- PostgreSQL 14+
--
-- Menjalankan: psql "$DATABASE_URL" -f database/schema.sql
-- Skrip ini IDEMPOTEN (aman dijalankan berulang) dan dibungkus satu transaksi,
-- sehingga bila ada satu statement gagal, seluruh DDL di-ROLLBACK.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. TABEL PRODUCTS (Menu Kantin)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
    id          SERIAL PRIMARY KEY,
    sku         VARCHAR(50)  NOT NULL,
    name        VARCHAR(150) NOT NULL,
    category    VARCHAR(50)  NOT NULL DEFAULT 'Makanan',
    price       NUMERIC(12, 2) NOT NULL,
    stock       INT          NOT NULL,
    is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT products_sku_unique          UNIQUE (sku),
    CONSTRAINT products_sku_not_blank       CHECK (btrim(sku) <> ''),
    CONSTRAINT products_name_not_blank      CHECK (btrim(name) <> ''),
    CONSTRAINT products_category_not_blank  CHECK (btrim(category) <> ''),
    CONSTRAINT products_price_non_negative  CHECK (price >= 0),
    CONSTRAINT products_stock_non_negative  CHECK (stock >= 0)
);

COMMENT ON TABLE  products           IS 'Master menu kantin beserta harga jual dan stok porsi.';
COMMENT ON COLUMN products.sku       IS 'Kode menu unik, dipakai untuk pencarian cepat di terminal kasir.';
COMMENT ON COLUMN products.is_active IS 'Soft delete: FALSE berarti menu tidak dijual lagi tetapi histori transaksi tetap utuh.';
COMMENT ON COLUMN products.stock     IS 'Stok porsi tersedia; dikurangi secara atomik saat checkout.';

-- -----------------------------------------------------------------------------
-- 2. TABEL TRANSACTIONS (Header Nota)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
    id             SERIAL PRIMARY KEY,
    invoice_number VARCHAR(50) NOT NULL,
    total_amount   NUMERIC(12, 2) NOT NULL,
    cash_paid      NUMERIC(12, 2) NOT NULL,
    change_amount  NUMERIC(12, 2) NOT NULL,
    created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT transactions_invoice_unique      UNIQUE (invoice_number),
    CONSTRAINT transactions_invoice_not_blank   CHECK (btrim(invoice_number) <> ''),
    CONSTRAINT transactions_total_non_negative  CHECK (total_amount >= 0),
    CONSTRAINT transactions_cash_non_negative   CHECK (cash_paid >= 0),
    CONSTRAINT transactions_change_non_negative CHECK (change_amount >= 0),
    -- Pertahanan terakhir di level database: uang tunai tidak boleh kurang dari total.
    CONSTRAINT transactions_cash_covers_total   CHECK (cash_paid >= total_amount),
    -- Kembalian harus konsisten secara aritmetika (NUMERIC bersifat eksak).
    CONSTRAINT transactions_change_consistent   CHECK (change_amount = cash_paid - total_amount)
);

COMMENT ON TABLE  transactions                IS 'Header transaksi penjualan; satu baris = satu nota.';
COMMENT ON COLUMN transactions.invoice_number IS 'Nomor nota unik, contoh: INV-20261115-0001.';

-- -----------------------------------------------------------------------------
-- 3. TABEL TRANSACTION_ITEMS (Detail Nota)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transaction_items (
    id             SERIAL PRIMARY KEY,
    transaction_id INT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    product_id     INT NOT NULL REFERENCES products(id)     ON DELETE RESTRICT,
    quantity       INT NOT NULL,
    price_at_sale  NUMERIC(12, 2) NOT NULL,
    subtotal       NUMERIC(12, 2) NOT NULL,

    CONSTRAINT transaction_items_quantity_positive     CHECK (quantity > 0),
    CONSTRAINT transaction_items_price_non_negative    CHECK (price_at_sale >= 0),
    CONSTRAINT transaction_items_subtotal_non_negative CHECK (subtotal >= 0),
    -- Subtotal harus sama dengan harga saat transaksi dikali kuantitas.
    CONSTRAINT transaction_items_subtotal_consistent   CHECK (subtotal = price_at_sale * quantity)
);

COMMENT ON TABLE  transaction_items               IS 'Rincian item per nota; menyimpan snapshot harga historis.';
COMMENT ON COLUMN transaction_items.price_at_sale IS 'SALINAN harga saat transaksi terjadi, agar laporan historis tidak berubah ketika harga menu diedit.';

-- -----------------------------------------------------------------------------
-- 4. INDEXES (mendukung pencarian kasir & laporan harian)
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_products_active     ON products (is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_products_category   ON products (category);
CREATE INDEX IF NOT EXISTS idx_products_name_lower ON products (lower(name));
CREATE INDEX IF NOT EXISTS idx_products_sku_lower  ON products (lower(sku));

-- Laporan harian memakai rentang created_at (>= awal hari AND < awal hari berikutnya),
-- sehingga index B-Tree biasa pada created_at sudah efektif.
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions (created_at);

CREATE INDEX IF NOT EXISTS idx_transaction_items_transaction_id ON transaction_items (transaction_id);
CREATE INDEX IF NOT EXISTS idx_transaction_items_product_id     ON transaction_items (product_id);

-- -----------------------------------------------------------------------------
-- 5. TRIGGER updated_at PADA PRODUCTS
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_products_set_updated_at ON products;
CREATE TRIGGER trg_products_set_updated_at
    BEFORE UPDATE ON products
    FOR EACH ROW
    EXECUTE FUNCTION fn_set_updated_at();

COMMIT;

-- =============================================================================
-- RESET KHUSUS DEVELOPMENT / TESTING (JANGAN dijalankan di produksi)
-- =============================================================================
-- TRUNCATE TABLE transaction_items, transactions RESTART IDENTITY CASCADE;
-- TRUNCATE TABLE products RESTART IDENTITY CASCADE;
