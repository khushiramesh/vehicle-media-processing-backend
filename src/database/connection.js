const sqlite3 = require('sqlite3').verbose();
const config = require('../config');
const { logger } = require('../utils/logger');

let db = null;

function getConnection() {
  if (!db) {
    db = new sqlite3.Database(config.dbPath, (err) => {
      if (err) {
        logger.error('Failed to connect to SQLite database:', err.message);
        throw err;
      }
      logger.info('Connected to SQLite database.');
    });
  }
  return db;
}

function closeConnection() {
  if (db) {
    db.close((err) => {
      if (err) {
        logger.error('Failed to close database connection:', err.message);
      } else {
        logger.info('Database connection closed.');
      }
    });
    db = null;
  }
}

module.exports = { getConnection, closeConnection };

