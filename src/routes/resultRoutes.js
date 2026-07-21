const express = require('express');
const router = express.Router();
const { getResult } = require('../controllers/resultController');

// GET /result/:id — get complete analysis result by image ID
router.get('/:id', getResult);

module.exports = router;

