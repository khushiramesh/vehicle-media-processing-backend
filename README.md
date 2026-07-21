# Vehicle Media Processing Backend

## Overview

Vehicle Media Processing Backend is a RESTful API built using Node.js and Express.js for automated vehicle image analysis. The application processes uploaded images asynchronously using an in-memory job queue and performs multiple analyses including blur detection, brightness evaluation, OCR-based text extraction, Indian vehicle number plate recognition, duplicate image detection, screenshot detection, and confidence score calculation.

---

## Features

- Asynchronous image processing using an in-memory job queue
- Image upload with Multer
- Blur detection using Variance of Laplacian
- Brightness analysis
- OCR-based text extraction using Tesseract.js
- Indian vehicle number plate extraction and validation
- Duplicate image detection using SHA-256 hashing
- Screenshot detection using image heuristics
- Overall confidence score calculation
- SQLite database integration
- Structured logging and retry mechanism
- RESTful API architecture

---

## Technology Stack

| Technology | Purpose |
|------------|---------|
| Node.js | Runtime Environment |
| Express.js | REST API Framework |
| SQLite | Database |
| Sharp | Image Processing |
| Tesseract.js | OCR Engine |
| Multer | File Upload |
| UUID | Unique Identifier Generation |

---

## Project Structure

```
vehicle-media-processing-backend/
│
├── src/
│   ├── config/
│   ├── controllers/
│   ├── database/
│   ├── middlewares/
│   ├── models/
│   ├── queue/
│   ├── routes/
│   ├── services/
│   └── utils/
│
├── uploads/
├── server.js
├── package.json
├── package-lock.json
└── README.md
```

---

## Installation

Clone the repository:

```bash
git clone https://github.com/khushiramesh/vehicle-media-processing-backend.git
```

Navigate to the project directory:

```bash
cd vehicle-media-processing-backend
```

Install dependencies:

```bash
npm install
```

Start the application:

```bash
npm start
```

The server will run at:

```
http://localhost:3000
```

---

## API Endpoints

| Method | Endpoint | Description |
|---------|----------|-------------|
| POST | `/api/upload` | Upload a vehicle image |
| GET | `/api/status/:id` | Check processing status |
| GET | `/api/result/:id` | Retrieve analysis result |
| GET | `/api/health` | Health check |

---

## Upload Request

**Endpoint**

```
POST /api/upload
```

**Content-Type**

```
multipart/form-data
```

**Body**

| Key | Type |
|-----|------|
| image | File |

**Sample Response**

```json
{
  "id": "uuid",
  "status": "pending"
}
```

---

## Sample Analysis Response

```json
{
  "status": "completed",
  "analysis": {
    "blur": false,
    "blurScore": 244.10,
    "brightness": "Good",
    "brightnessScore": 142.85,
    "ocrText": "MH12NG8556",
    "vehicleNumber": "MH12NG8556",
    "validNumberPlate": true,
    "duplicate": false,
    "screenshot": false,
    "overallConfidence": 95
  }
}
```

---

## Image Analysis Pipeline

The backend performs the following analysis on every uploaded image:

- Blur Detection
- Brightness Analysis
- OCR-based Text Extraction
- Vehicle Number Plate Extraction
- Number Plate Validation
- Duplicate Detection
- Screenshot Detection
- Confidence Score Calculation

---

## Performance

- Average processing time: 1–2 seconds per image
- Queue concurrency: 2 jobs
- Maximum upload size: 10 MB
- Asynchronous background processing

---

## Future Improvements

- Redis-based distributed job queue
- PostgreSQL integration
- Docker support
- JWT Authentication
- Cloud storage integration
- Machine Learning-based vehicle classification

---

## Author

Khushi 

Backend + AI Engineering Assignment