const express = require('express');
const path = require('path');
const config = require('./src/config');
const { initializeDatabase } = require('./src/database/schema');
const { closeConnection } = require('./src/database/connection');
const { startQueue, stopQueue } = require('./src/queue');
const routes = require('./src/routes');
const errorHandler = require('./src/middlewares/errorHandler');
const { logger } = require('./src/utils/logger');

const app = express();

// ----- Middleware -----
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve uploaded images statically (optional, for debugging)
app.use('/uploads', express.static(config.uploadDir));

// ----- API Routes -----
app.use('/api', routes);

// ----- Global Error Handler -----
app.use(errorHandler);

// ----- Initialize & Start -----
function startServer() {
  try {
    // 1. Initialize database schema
    initializeDatabase();

    // 2. Start the background job queue
    startQueue();

    // 3. Start HTTP server
    const server = app.listen(config.port, () => {
      logger.info(`Server running on http://localhost:${config.port}`);
      logger.info(`API endpoints:`);
      logger.info(`  POST   /api/upload    - Upload an image`);
      logger.info(`  GET    /api/status/:id - Get processing status`);
      logger.info(`  GET    /api/result/:id - Get analysis result`);
      logger.info(`  GET    /api/health     - Health check`);
    });

    // Graceful shutdown
    const shutdown = (signal) => {
      logger.info(`Received ${signal}. Shutting down gracefully...`);
      server.close(() => {
        stopQueue();
        closeConnection();
        logger.info('Server shut down complete.');
        process.exit(0);
      });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    logger.error('Failed to start server:', err.message);
    process.exit(1);
  }
}

startServer();

module.exports = app;

