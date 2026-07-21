const express = require('express');
const router = express.Router();

const uploadRoutes = require('./uploadRoutes');
const statusRoutes = require('./statusRoutes');
const resultRoutes = require('./resultRoutes');
const healthRoutes = require('./healthRoutes');

router.use('/upload', uploadRoutes);
router.use('/status', statusRoutes);
router.use('/result', resultRoutes);
router.use('/health', healthRoutes);

module.exports = router;

