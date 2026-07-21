const express = require('express');
const router = express.Router();
const { getHealth } = require('../controllers/healthController');

// GET /health — health check endpoint
router.get('/', getHealth);

module.exports = router;

