# Vehicle Media Processing Backend

A production-grade Express.js backend for automated vehicle image analysis. Supports asynchronous processing via an in-memory job queue with blur detection, brightness analysis, OCR, Indian vehicle number plate extraction, duplicate detection, screenshot heuristics, and confidence scoring.

---

## Quick Start

```bash
# Install dependencies
npm install

# Start the server
npm start

# Or with auto-reload on file changes
npm run dev
```

The server starts on `http://localhost:3000`.

---

## API Endpoints

### 1. Upload an Image

```http
POST /api/upload
Content-Type: multipart/form-data

image=<file>
```

**Response (201):**
```json
{
  "id": "uuid-string",
  "status": "pending"
}
```

Supported formats: `jpeg`, `png`, `gif`, `webp`, `bmp`. Max file size: 10 MB.

---

### 2. Check Processing Status

```http
GET /api/status/:id
```

**Response:**
```json
{
  "id": "uuid-string",
  "status": "pending" | "processing" | "completed" | "failed"
}
```

---

### 3. Get Analysis Result

```http
GET /api/result/:id
```

**Response (completed):**
```json
{
  "id": "b670707c-...",
  "status": "completed",
  "processing": {
    "startedAt": "2026-07-21T16:38:51.188Z",
    "completedAt": "2026-07-21T16:38:52.336Z",
    "timeMs": 1148,
    "retryCount": 0
  },
  "file": {
    "name": "test-plate.png",
    "size": 15053,
    "mimeType": "image/png",
    "width": 800,
    "height": 400
  },
  "analysisVersion": "v1.0.0",
  "analysis": {
    "blur": false,
    "blurScore": 244.1,
    "brightness": "Very Bright",
    "brightnessScore": 241.88,
    "ocrText": "MH12NG8556",
    "vehicleNumber": "MH12NG8556",
    "validNumberPlate": true,
    "duplicate": false,
    "screenshot": false,
    "overallConfidence": 95
  },
  "error": null
}
```

**Response (still processing):**
```json
{
  "id": "uuid-string",
  "status": "processing",
  "message": "Analysis is still in progress. Please check back later."
}
```

**Response (not found):**
```json
{
  "error": true,
  "message": "Image not found."
}
```

---

### 4. Health Check

```http
GET /api/health
```

**Response:**
```json
{
  "status": "running",
  "uptime": "00:05:23",
  "uptimeSeconds": 323,
  "queueLength": 0,
  "processedJobs": 5,
  "failedJobs": 0,
  "version": "1.0.0"
}
```

---

## Analysis Algorithms — Detailed Explanation

### 1. Blur Detection (`analyzeBlur`)

**Algorithm:** Variance of Laplacian (VoL)

1. The image is converted to grayscale (single channel).
2. A 3×3 Laplacian kernel is applied via convolution.

```
Laplacian kernel:
  0   1  0
  1  -4  1
  0   1  0
```

3. The variance of the resulting pixel values is computed.

**Why it works:** The Laplacian operator highlights regions of rapid intensity change (edges). A sharp image contains many strong edges, producing a high variance. A blurry image has few weak edges, producing a low variance.

**Threshold:** `blurScore < 100` → `blur = true`
- This threshold (100) is widely adopted from Adrian Rosebrock's "Blur Detection with OpenCV" tutorial.
- It was calibrated against thousands of natural images and vehicle photos.
- Higher values indicate a sharper image.

**Implementation note:** Uses `sharp.convolve()` instead of OpenCV for Windows compatibility and zero native build dependencies.

---

### 2. Brightness Detection (`analyzeBrightness`)

**Algorithm:** Mean channel brightness

1. `sharp.stats()` returns per-channel statistics (mean, stdev).
2. The average of all channel means gives a `brightnessScore` in [0, 255].

**Classification thresholds:**

| Range       | Label         | Typical Scenario                  |
|-------------|---------------|-----------------------------------|
| 0–25        | Very Dark     | Nighttime, underexposed           |
| 25–50       | Dark          | Dimly lit, shadows                |
| 50–150      | Good          | Normal daylight, well-lit         |
| 150–200     | Bright        | Overcast sky, direct sun          |
| 200–255     | Very Bright   | Snow, direct sun on white surface |

**Why these thresholds:** Based on standard photographic exposure zones (modified Ansel Adams zone system compressed to 5 levels for simplicity).

---

### 3. OCR Detection (`extractOCR`)

**Algorithm:** Tesseract.js — LSTM-based neural OCR

1. Image is passed directly to Tesseract.js with the `eng` language pack.
2. All visible text is extracted as a plain string.

**Why Tesseract.js:** It is the most accurate open-source OCR engine, runs entirely in Node.js without external binaries, and supports Indian number plate fonts well.

**Fallback:** If OCR fails (e.g., corrupted image, Tesseract bug), the function returns an empty string and processing continues.

---

### 4. Vehicle Number Plate Extraction (`extractVehicleNumber`)

**Algorithm:** Regular expression matching

The regex pattern:
```
/[A-Z]{2}[0-9]{1,2}[A-Z]{1,2}[0-9]{4}/
```

**Supported formats:**
- `AA00AA0000` (e.g., `KA19AB1234`)
- `AA00A0000`  (e.g., `DL01C5678`)

**Steps:**
1. OCR text is uppercased and non-alphanumeric characters are replaced with spaces.
2. The regex searches for the first match of the Indian plate pattern.

**Why text cleaning:** OCR often introduces spaces, hyphens, or bullet characters between characters (e.g., "MH 12 NG 8556"). Normalizing to uppercase and splitting on non-alphanumerics ensures robust matching.

**Limitation:** Only extracts the first match. If multiple plates are visible, only the first is returned.

---

### 5. Number Plate Validation (`validateVehicleNumber`)

**Algorithm:** Same regex as extraction

Returns `true` if the extracted number matches the Indian plate format, `false` otherwise.

**Why separate from extraction:** Keeps the single-responsibility principle. Extraction finds the plate; validation confirms it. In production, you might also validate against state codes (KA, MH, DL, etc.) or checksum digits.

---

### 6. Duplicate Detection (`checkDuplicate`)

**Algorithm:** SHA-256 hash comparison

1. The uploaded file is read from disk.
2. `crypto.createHash('sha256')` generates a 64-character hex digest.
3. A database query checks if the same hash already exists.

**Why SHA-256:** Cryptographic hash ensures near-zero collision probability. Even a single pixel change produces a completely different hash.

**Storage:** The hash is stored in the `imageHash` column for future lookups.

---

### 7. Screenshot Detection (`detectScreenshot`)

**Algorithm:** Four heuristic tests (≥3 positive = screenshot)

| # | Heuristic                | Test Method                                      | Why It Works                                  |
|---|--------------------------|--------------------------------------------------|-----------------------------------------------|
| 1 | No/minimal EXIF data     | `sharp.metadata().exif` + `exif-parser`          | Screenshots from digital sources rarely have camera EXIF |
| 2 | High resolution          | Both dimensions ≥ 1080px                         | Screenshots are typically captured at display resolution (≥1080p) |
| 3 | Perfect aspect ratio     | Within 2% of 16:9 (1.778) or 16:10 (1.6)        | Modern displays use these exact ratios        |
| 4 | Low pixel complexity     | Average channel stdev < 40                       | UI elements have flat-color regions; natural photos have higher variance |

**Threshold:** 3 or more heuristics positive → `screenshot = true`

**Rationale:** No single heuristic is reliable. Combining four gives robust detection:
- A photo can accidentally have no EXIF (web download, stripped metadata).
- A screenshot can be small (mobile screenshot at 720p).
- But all four simultaneously being true is very unlikely for a natural photo.

---

### 8. Confidence Score (`calculateConfidence`)

**Algorithm:** Weighted formula clamped to [0, 100]

| Component                    | Points | Rationale                                   |
|------------------------------|--------|---------------------------------------------|
| Base score                   | 50     | Neutral starting point                      |
| Penalty if blurry            | −20    | Blurry images degrade all downstream analysis |
| Brightness bonus             | 0–10   | Very Dark/Very Bright = 0, Dark/Bright = 3–5, Good = 10 |
| OCR text found               | +15    | Text presence significantly increases confidence |
| Valid number plate           | +25    | Single most important indicator of successful analysis |

**Maximum achievable score:** 100 (base 50 + brightness 10 + OCR 15 + plate 25).

**Why this formula:** It's intentionally conservative. The base is 50 (not 0) to avoid large negative scores for borderline images. The plate validation bonus (25 points) reflects its outsized importance in the use case.

---

## Architecture

```
POST /api/upload
      ↓
uploadMiddleware (Multer) → saves file to /uploads
      ↓
uploadService → creates DB record, captures file metadata via Sharp
      ↓
enqueueImageAnalysis() → adds job to in-memory queue
      ↓
queue/index.js → registers handler with retry wrapper (3 attempts)
      ↓
processImage() → orchestrator with timing and step logging
      ↓
  ┌────────────┬────────────┬─────────────┬──────────────┐
  │ analyzeBlur│analyzeBrigh│ checkDuplic │ detectScreens│
  │ (sharp)    │ tness(sharp)│ ate(crypto) │ hot(heuristic)│
  └────────────┴────────────┴─────────────┴──────────────┘
      ↓
  extractOCR (Tesseract.js)
      ↓
  extractVehicleNumber (regex)
      ↓
  validateVehicleNumber (regex)
      ↓
  calculateConfidence
      ↓
imageModel.updateAnalysis() → saves to SQLite
```

### Key Design Decisions

- **In-memory queue** (no Redis/RabbitMQ): Keeps deployment simple. Sufficient for moderate throughput. For production scaling, swap to Bull/BullMQ with Redis.
- **Sharp instead of OpenCV:** Zero native build dependencies, reliable on Windows, excellent performance.
- **SQLite:** Zero-config, file-based, sufficient for single-server deployments. Migrates naturally to PostgreSQL.
- **Step-level logging:** Every analysis step is logged to the `processing_logs` table with timestamps, enabling audit trails and debugging.
- **Error isolation:** If OCR fails, blur/brightness/duplicate/screenshot continue. Partial results are saved instead of failing the entire job.
- **Retry with backoff:** Failed jobs retry up to 3 times with 1-second delays.

---

## Database Schema

### `images` table
| Column                  | Type    | Description                              |
|-------------------------|---------|------------------------------------------|
| id                      | TEXT PK | UUID                                     |
| filename                | TEXT    | Stored filename                          |
| status                  | TEXT    | pending/processing/completed/failed      |
| uploadTime              | TEXT    | ISO 8601 timestamp                       |
| blurScore               | REAL    | Variance of Laplacian score              |
| blur                    | INTEGER | 0 = sharp, 1 = blurry                    |
| brightness              | TEXT    | Very Dark/Dark/Good/Bright/Very Bright   |
| brightnessScore         | REAL    | Average pixel brightness (0–255)         |
| ocrText                 | TEXT    | Extracted text from OCR                  |
| vehicleNumber           | TEXT    | Extracted Indian plate number            |
| validNumberPlate        | INTEGER | 1 if plate matches regex                 |
| duplicate               | INTEGER | 1 if SHA256 hash matches existing record |
| screenshot              | INTEGER | 1 if heuristic check says screenshot      |
| imageHash               | TEXT    | SHA256 hex digest                        |
| overallConfidence       | REAL    | Composite score 0–100                    |
| error                   | TEXT    | Error message if failed                  |
| processingStartedAt     | TEXT    | ISO 8601 timestamp                       |
| processingCompletedAt   | TEXT    | ISO 8601 timestamp                       |
| processingTimeMs        | INTEGER | Processing duration (milliseconds)       |
| retryCount              | INTEGER | Number of retry attempts                 |
| fileSize                | INTEGER | File size in bytes                       |
| imageWidth              | INTEGER | Pixel width                              |
| imageHeight             | INTEGER | Pixel height                             |
| mimeType                | TEXT    | MIME type (image/png, etc.)              |
| extension               | TEXT    | File extension (png, jpg, etc.)          |
| analysisVersion         | TEXT    | Analysis algorithm version               |
| originalName            | TEXT    | Original upload filename                 |

### `processing_logs` table
| Column    | Type    | Description                     |
|-----------|---------|---------------------------------|
| id        | TEXT PK | UUID                            |
| imageId   | TEXT    | FK to images.id                 |
| step      | TEXT    | Step name (e.g., BLUR_ANALYSIS) |
| status    | TEXT    | STARTED / SUCCESS / FAILURE     |
| message   | TEXT    | Human-readable log message      |
| timestamp | TEXT    | ISO 8601 timestamp              |

---

## Project Structure

```
├── server.js                      # Express server entry point
├── package.json
├── database.db                    # SQLite database (auto-created)
├── uploads/                       # Uploaded images
├── src/
│   ├── config/
│   │   └── index.js               # Configuration (port, paths, limits)
│   ├── database/
│   │   ├── connection.js          # SQLite connection singleton
│   │   └── schema.js              # Schema initialization + migrations
│   ├── controllers/
│   │   ├── uploadController.js    # POST /api/upload
│   │   ├── statusController.js    # GET /api/status/:id
│   │   ├── resultController.js    # GET /api/result/:id
│   │   └── healthController.js    # GET /api/health
│   ├── models/
│   │   ├── imageModel.js          # CRUD for images table
│   │   └── processingLogModel.js  # CRUD for processing_logs table
│   ├── services/
│   │   ├── imageAnalysisService.js # Core analysis: blur, brightness, OCR,
│   │   │                            # plate extraction, validation, duplicate,
│   │   │                            # screenshot, confidence
│   │   ├── uploadService.js       # Upload orchestration + file metadata
│   │   └── retryService.js        # Retry wrapper for fault tolerance
│   ├── queue/
│   │   ├── jobQueue.js            # Generic in-memory job queue
│   │   └── index.js               # Image analysis queue + retry integration
│   ├── routes/
│   │   ├── index.js               # Route aggregation
│   │   ├── uploadRoutes.js
│   │   ├── statusRoutes.js
│   │   ├── resultRoutes.js
│   │   └── healthRoutes.js
│   ├── middlewares/
│   │   ├── uploadMiddleware.js    # Multer configuration
│   │   └── errorHandler.js       # Global error handler
│   └── utils/
│       ├── constants.js           # Enums and constants
│       └── logger.js              # Structured logging with image context
└── TODO.md                        # Task tracking
```

---

## Error Handling Philosophy

1. **Graceful degradation:** If any single analysis fails, the others still run and partial results are saved.
2. **Retry on failure:** The retry service wraps the entire `processImage()` pipeline. Up to 3 attempts with 1-second delay.
3. **Non-fatal warnings:** Metadata capture errors, screenshot detection optional heuristics — logged but not thrown.
4. **Validation at boundaries:** File type, file size, and database constraints are enforced at ingress.

---

## Dependencies

| Package        | Version | Purpose                                 |
|----------------|---------|-----------------------------------------|
| express        | ^4.18   | HTTP framework                          |
| multer         | ^1.4    | File upload handling                    |
| sqlite3        | ^5.1    | Database engine                         |
| uuid           | ^9.0    | Unique ID generation                    |
| sharp          | latest  | Image processing (blur, brightness, metadata) |
| tesseract.js   | latest  | OCR engine                              |
| exif-parser    | latest  | EXIF data parsing (screenshot detection) |

---

## Performance

- **Processing time per image:** ~1–2 seconds (varies with image size and CPU).
- **Concurrency:** 2 simultaneous jobs (configurable in `src/config/index.js`).
- **Memory:** ~200–500 MB per concurrent OCR job.
- **File size limit:** 10 MB (configurable).

---

## License

ISC — see `package.json`

