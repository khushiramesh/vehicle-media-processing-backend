const express = require('express');
const router = express.Router();
const upload = require('../middlewares/uploadMiddleware');
const { uploadImage } = require('../controllers/uploadController');

// POST /upload — accept image upload
router.post('/', upload.single('image'), uploadImage);

module.exports = router;

