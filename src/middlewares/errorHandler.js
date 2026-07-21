const { logger } = require('../utils/logger');

/**
 * Global error handling middleware.
 */
function errorHandler(err, req, res, _next) {
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal Server Error';

  logger.error(`[${statusCode}] ${message}`);

  res.status(statusCode).json({
    error: true,
    message,
  });
}

module.exports = errorHandler;

