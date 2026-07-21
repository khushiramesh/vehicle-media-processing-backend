const path = require('path');

const config = {
  port: process.env.PORT || 3000,
  uploadDir: path.join(__dirname, '..', '..', 'uploads'),
  dbPath: path.join(__dirname, '..', '..', 'database.db'),
  allowedMimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'],
  maxFileSize: 10 * 1024 * 1024, // 10 MB
  queue: {
    concurrency: 2,
    pollIntervalMs: 500,
  },
};

module.exports = config;

