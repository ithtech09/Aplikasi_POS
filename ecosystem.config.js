/**
 * =============================================================================
 * ecosystem.config.js
 * Konfigurasi PM2 untuk deployment produksi (Bagian 7 blueprint).
 * =============================================================================
 *
 * Menjalankan: pm2 start ecosystem.config.js && pm2 save
 *
 * `exec_mode: "fork"` dengan `instances: 1` dipilih dengan sengaja:
 * penomoran nota memakai advisory lock PostgreSQL yang aman untuk banyak
 * proses, tetapi satu instance menyederhanakan operasi dan menghindari
 * perebutan koneksi pool pada server kantin berkapasitas kecil.
 */

module.exports = {
  apps: [
    {
      name: 'express-pos-kantin',
      script: './dist/server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      // Beri waktu koneksi database ditutup dengan rapi sebelum SIGKILL.
      kill_timeout: 5000,
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
