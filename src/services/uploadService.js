const { v4: uuidv4 } = require('uuid');
const path = require('path');
const sharp = require('sharp');
const imageModel = require('../models/imageModel');
const processingLogModel = require('../models/processingLogModel');
const { enqueueImageAnalysis } = require('../queue');
const { logger } = require('../utils/logger');
const { PROCESSING_STEPS } = require('../utils/constants');

/**
 * Process the uploaded file:
 *   1. Generate a UUID for the image.
 *   2. Rename/move file to UUID-based filename (Multer already stores it).
 *   3. Save metadata in SQLite.
 *   4. Capture file metadata (size, dimensions, mime type) via Sharp.
 *   5. Enqueue image for background analysis.
 *
 * @param {Object} file - The Multer file object.
 * @returns {Object} { id, status }
 */
async function handleUpload(file) {
  const imageId = uuidv4();
  const ext = path.extname(file.originalname);
  const newFilename = `${imageId}${ext}`;

  // Multer already saved the file; the filename is already UUID-based
  // via the storage engine. We record the filename that was actually used.
  const storedFilename = file.filename || newFilename;

  const uploadTime = new Date().toISOString();

  // Log: UPLOAD_RECEIVED
  await processingLogModel.logSuccess(
    imageId,
    PROCESSING_STEPS.UPLOAD_RECEIVED,
    `File "${file.originalname}" received (${file.size} bytes, ${file.mimetype})`
  );

  const imageRecord = {
    id: imageId,
    filename: storedFilename,
    status: 'pending',
    uploadTime,
  };

  // Save basic metadata to SQLite
  await imageModel.create(imageRecord);

  // Log: IMAGE_SAVED
  await processingLogModel.logSuccess(
    imageId,
    PROCESSING_STEPS.IMAGE_SAVED,
    `Image record created in database (id=${imageId})`
  );

  // Capture file metadata using Sharp
  try {
    const filePath = path.join(__dirname, '..', '..', 'uploads', storedFilename);
    const metadata = await sharp(filePath).metadata();
    const fileMetadata = {
      fileSize: file.size,
      imageWidth: metadata.width || null,
      imageHeight: metadata.height || null,
      mimeType: file.mimetype,
      extension: ext.replace('.', ''),
      originalName: file.originalname,
    };

    await imageModel.updateFileMetadata(imageId, fileMetadata);
    logger.info(
      `File metadata captured: ${fileMetadata.imageWidth}x${fileMetadata.imageHeight}, ${fileMetadata.mimeType}`,
      imageId,
      'FILE_METADATA'
    );
  } catch (metaErr) {
    logger.warn(`Failed to capture file metadata: ${metaErr.message}`, imageId, 'FILE_METADATA');
    // Non-fatal — continue even if metadata capture fails
  }

  // Enqueue background analysis job
  enqueueImageAnalysis(imageId);

  // Log: QUEUE_STARTED
  await processingLogModel.logSuccess(
    imageId,
    PROCESSING_STEPS.QUEUE_STARTED,
    `Image enqueued for background analysis`
  );

  logger.info(`Image uploaded: id=${imageId}, filename=${storedFilename}`);

  return {
    id: imageId,
    status: 'pending',
  };
}

module.exports = { handleUpload };

