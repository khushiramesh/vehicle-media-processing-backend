const express = require('express');
const router = express.Router();
const { getStatus } = require('../controllers/statusController');

// GET /status/:id — get processing status by image ID
router.get('/:id', getStatus);

module.exports = router;

