# Vehicle Media Processing Backend

GitHub Repository: https://github.com/khushiramesh/vehicle-media-processing-backend.git

## Overview

Vehicle Media Processing Backend is a production-ready RESTful API built using Node.js and Express.js for automated vehicle image analysis. The application processes uploaded images asynchronously using an in-memory job queue and performs multiple image analysis tasks, including blur detection, brightness analysis, OCR-based text extraction, Indian vehicle number plate recognition, duplicate image detection, screenshot detection, and confidence score calculation.

The project also includes a lightweight web-based dashboard that allows users to upload vehicle images and view the analysis results directly in the browser.

---

## Features

- Asynchronous image processing using an in-memory job queue
- Web-based dashboard for image upload and result visualization
- Image upload using Multer
- Blur detection using Variance of Laplacian
- Brightness analysis
- OCR-based text extraction using Tesseract.js
- Indian vehicle number plate extraction and validation
- Duplicate image detection using SHA-256 hashing
- Screenshot detection using image heuristics
- Overall confidence score calculation
- Processing time tracking
- File metadata extraction
- Structured logging and retry mechanism
- SQLite database integration
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

```text
vehicle-media-processing-backend/
│
├── public/
│   ├── index.html
│   ├── style.css
│   └── script.js
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

### Clone the repository

```bash
git clone https://github.com/khushiramesh/vehicle-media-processing-backend.git
```

### Navigate to the project

```bash
cd vehicle-media-processing-backend
```

### Install dependencies

```bash
npm install
```

### Start the server

```bash
npm start
```

The application will be available at:

**Local**

```
http://localhost:3000
```

---

## Live Deployment

**Render**

```
https://vehicle-media-processing-backend.onrender.com
```

---

## API Endpoints

| Method | Endpoint | Description |
|---------|----------|-------------|
| POST | `/api/upload` | Upload a vehicle image |
| GET | `/api/status/:id` | Check processing status |
| GET | `/api/result/:id` | Retrieve image analysis result |
| GET | `/api/health` | Health check |

---

## Upload Request

### Endpoint

```
POST /api/upload
```

### Content Type

```
multipart/form-data
```

### Request Body

| Key | Type |
|-----|------|
| image | File |

### Sample Response

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

Each uploaded image goes through the following processing pipeline:

1. Image Upload
2. Background Queue Processing
3. Blur Detection
4. Brightness Analysis
5. OCR Text Extraction
6. Vehicle Number Plate Detection
7. Number Plate Validation
8. Duplicate Image Detection
9. Screenshot Detection
10. Confidence Score Calculation
11. Result Storage
12. API Response

---

## Web Dashboard

The project includes a simple frontend dashboard served by Express.js.

Features include:

- Upload vehicle images
- Preview selected image
- Track processing status
- View analysis results
- Display OCR output
- Responsive user interface

---

## Performance

- Average processing time: **2–6 seconds** (depending on image size and OCR complexity)
- Queue concurrency: **2 jobs**
- Maximum upload size: **10 MB**
- Asynchronous background processing

---

## Future Improvements

- Redis-based distributed job queue
- PostgreSQL integration
- Docker support
- JWT Authentication
- Cloud storage integration
- Machine Learning-based vehicle detection
- Automatic license plate localization using OpenCV
- Higher OCR accuracy using deep learning models

---


**Khushi**

Backend + AI Engineering Take-Home Assignment
