import type { Config } from 'jest';

/**
 * Konfigurasi Jest untuk proyek TypeScript (CommonJS).
 * Pengujian bersifat BLACKBOX: memanggil endpoint HTTP via Supertest
 * dan memverifikasi dampaknya langsung ke database PostgreSQL.
 */
const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',

  roots: ['<rootDir>/tests'],
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],

  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.json',
        diagnostics: { warnOnly: false },
      },
    ],
  },

  // Memuat .env (PORT, DATABASE_URL, TEST_DATABASE_URL, dst) sebelum test berjalan.
  setupFiles: ['dotenv/config'],

  // Database tunggal yang dipakai bersama => test WAJIB berurutan, bukan paralel.
  maxWorkers: 1,
  testTimeout: 30000,

  clearMocks: true,
  restoreMocks: true,
  verbose: true,
  bail: false,
  forceExit: false,

  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/server.ts',
    '!src/types/**/*.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov'],
};

export default config;
