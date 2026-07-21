const { getConnection } = require('./connection');
const { logger } = require('../utils/logger');

function initializeDatabase() {
  const db = getConnection();

  db.exec(`
    CREATE TABLE IF NOT EXISTS images (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
      uploadTime TEXT NOT NULL,
      blurScore REAL,
      blur INTEGER DEFAULT 0,
      brightness TEXT,
      brightnessScore REAL,
      ocrText TEXT,
      vehicleNumber TEXT,
      validNumberPlate INTEGER,
      duplicate INTEGER DEFAULT 0,
      screenshot INTEGER DEFAULT 0,
      imageHash TEXT,
      overallConfidence REAL,
      error TEXT,
      processingStartedAt TEXT,
      processingCompletedAt TEXT,
      processingTimeMs INTEGER,
      retryCount INTEGER DEFAULT 0,
      fileSize INTEGER,
      imageWidth INTEGER,
      imageHeight INTEGER,
      mimeType TEXT,
      extension TEXT,
      analysisVersion TEXT DEFAULT 'v1.0.0',
      originalName TEXT
    )
  `, (err) => {
    if (err) {
      logger.error('Failed to initialize database schema:', err.message);
      throw err;
    }
    logger.info('Database schema initialized successfully.');

    // --- Migration: add new columns if upgrading from old schema ---
    // This ensures backward compatibility with databases created before these columns existed.
    const migrations = [
      { column: 'blur', type: 'INTEGER DEFAULT 0' },
      { column: 'brightnessScore', type: 'REAL' },
      { column: 'screenshot', type: 'INTEGER DEFAULT 0' },
      { column: 'imageHash', type: 'TEXT' },
      { column: 'overallConfidence', type: 'REAL' },
      { column: 'processingStartedAt', type: 'TEXT' },
      { column: 'processingCompletedAt', type: 'TEXT' },
      { column: 'processingTimeMs', type: 'INTEGER' },
      { column: 'retryCount', type: 'INTEGER DEFAULT 0' },
      { column: 'fileSize', type: 'INTEGER' },
      { column: 'imageWidth', type: 'INTEGER' },
      { column: 'imageHeight', type: 'INTEGER' },
      { column: 'mimeType', type: 'TEXT' },
      { column: 'extension', type: 'TEXT' },
      { column: 'analysisVersion', type: 'TEXT DEFAULT \'v1.0.0\'' },
      { column: 'originalName', type: 'TEXT' },
    ];

    // Helper: run migrations sequentially
    function runNextMigration(index) {
      if (index >= migrations.length) return;
      const { column, type } = migrations[index];

      // Check if column already exists before adding
      db.get(`SELECT COUNT(*) AS cnt FROM pragma_table_info('images') WHERE name = ?`, [column], (checkErr, row) => {
        if (checkErr) {
          logger.warn(`Migration: error checking column ${column} - ${checkErr.message}`);
          runNextMigration(index + 1);
          return;
        }
        if (row && row.cnt === 0) {
          db.exec(`ALTER TABLE images ADD COLUMN ${column} ${type}`, (alterErr) => {
            if (alterErr) {
              logger.warn(`Migration: failed to add column ${column} - ${alterErr.message}`);
            } else {
              logger.info(`Migration: added column ${column} to images table.`);
            }
            runNextMigration(index + 1);
          });
        } else {
          runNextMigration(index + 1);
        }
      });
    }

    runNextMigration(0);
  });

  // --- Create processing_logs table (always safe to run since IF NOT EXISTS) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS processing_logs (
      id TEXT PRIMARY KEY,
      imageId TEXT NOT NULL,
      step TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK (status IN ('STARTED', 'SUCCESS', 'FAILURE')),
      message TEXT,
      timestamp TEXT NOT NULL
    )
  `, (err) => {
    if (err) {
      logger.error('Failed to create processing_logs table:', err.message);
      throw err;
    }
    logger.info('processing_logs table ready.');
  });

  // Create index for faster log lookups by imageId
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_processing_logs_imageId
    ON processing_logs (imageId)
  `, (err) => {
    if (err) {
      logger.warn('Failed to create index on processing_logs:', err.message);
    }
  });
}

module.exports = { initializeDatabase };

