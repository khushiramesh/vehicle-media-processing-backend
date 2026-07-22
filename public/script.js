/* =============================================
   Vehicle Media Processing System - Frontend Logic
   ============================================= */

(function () {
  'use strict';

  // ===== DOM References =====
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const fileInput = $('#fileInput');
  const uploadArea = $('#uploadArea');
  const uploadPlaceholder = $('#uploadPlaceholder');
  const imagePreview = $('#imagePreview');
  const analyzeBtn = $('#analyzeBtn');
  const uploadCard = $('#uploadCard');
  const progressCard = $('#progressCard');
  const resultCard = $('#resultCard');
  const errorCard = $('#errorCard');
  const errorMessage = $('#errorMessage');
  const errorRetryBtn = $('#errorRetryBtn');
  const resetBtn = $('#resetBtn');
  const serverStatusDot = $('#serverStatusDot');
  const serverStatusText = $('#serverStatusText');

  // Progress elements
  const progressStatus = $('#progressStatus');
  const progressBarFill = $('#progressBarFill');
  const spinnerText = $('#spinnerText');

  // Result meta elements
  const rStatus = $('#rStatus');
  const rFileName = $('#rFileName');
  const rFileSize = $('#rFileSize');
  const rDimensions = $('#rDimensions');
  const rProcessingTime = $('#rProcessingTime');
  const rAnalysisVersion = $('#rAnalysisVersion');
  const statusBadge = $('#statusBadge');

  // Analysis metric elements
  const bBlur = $('#bBlur');
  const vBlurScore = $('#vBlurScore');
  const bBrightness = $('#bBrightness');
  const vBrightnessScore = $('#vBrightnessScore');
  const vOcrText = $('#vOcrText');
  const vVehicleNumber = $('#vVehicleNumber');
  const bPlate = $('#bPlate');
  const bDuplicate = $('#bDuplicate');
  const bScreenshot = $('#bScreenshot');
  const confidenceText = $('#confidenceText');
  const confidenceArc = $('#confidenceArc');

  // ===== State =====
  let selectedFile = null;
  let pollingId = null;
  let isProcessing = false;

  // ===== Health Check on Load =====
  async function checkServerHealth() {
    try {
      const res = await fetch('/api/health');
      if (!res.ok) throw new Error('Server not healthy');
      const data = await res.json();
      serverStatusDot.className = 'status-dot online';
      serverStatusText.textContent = `Online · ${data.processedJobs || 0} processed`;
    } catch {
      serverStatusDot.className = 'status-dot offline';
      serverStatusText.textContent = 'Offline';
    }
  }
  checkServerHealth();
  setInterval(checkServerHealth, 15000);

  // ===== File Selection & Preview =====
  function triggerFileSelect() {
    fileInput.click();
  }

  uploadArea.addEventListener('click', (e) => {
    // Don't trigger if preview is shown (preview click shouldn't re-open)
    if (uploadArea.classList.contains('has-image')) return;
    triggerFileSelect();
  });

  uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('dragover');
  });

  uploadArea.addEventListener('dragleave', () => {
    uploadArea.classList.remove('dragover');
  });

  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      handleFileSelect(e.dataTransfer.files[0]);
    }
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) {
      handleFileSelect(fileInput.files[0]);
    }
  });

  function handleFileSelect(file) {
    const validTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'];
    if (!validTypes.includes(file.type)) {
      showError('Invalid file type. Please select JPEG, PNG, GIF, WebP, or BMP.');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      showError('File too large. Maximum size is 10 MB.');
      return;
    }

    selectedFile = file;

    // Preview
    const reader = new FileReader();
    reader.onload = (e) => {
      imagePreview.src = e.target.result;
      imagePreview.classList.remove('hidden');
      uploadPlaceholder.classList.add('hidden');
      uploadArea.classList.add('has-image');
      analyzeBtn.disabled = false;
    };
    reader.readAsDataURL(file);
  }

  // ===== Formatting Helpers =====
  function formatFileSize(bytes) {
    if (!bytes) return '—';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function formatTime(ms) {
    if (!ms) return '—';
    if (ms < 1000) return ms + ' ms';
    return (ms / 1000).toFixed(2) + ' s';
  }

  // ===== Badge Helpers =====
  function setBadge(el, type, text) {
    el.textContent = text;
    el.className = 'badge';
    if (type) el.classList.add('badge-' + type);
  }

  // ===== Confidence Arc =====
  function setConfidence(score) {
    const clamped = Math.max(0, Math.min(100, Math.round(score || 0)));
    const circumference = 100; // using percentage-based dasharray
    const offset = circumference - (clamped / 100) * circumference;
    confidenceArc.setAttribute('stroke-dasharray', `${circumference} ${circumference}`);
    confidenceArc.setAttribute('stroke-dashoffset', offset);
    confidenceText.textContent = clamped + '%';

    // Color based on score
    let color = 'var(--danger)';
    if (clamped >= 80) color = 'var(--success)';
    else if (clamped >= 60) color = 'var(--warning)';
    confidenceArc.setAttribute('stroke', color);
  }

  // ===== Show / Hide Helpers =====
  function showError(message) {
    errorMessage.textContent = message;
    errorCard.classList.remove('hidden');
    // Auto-hide success/result
    resultCard.classList.add('hidden');
    progressCard.classList.add('hidden');
  }

  function hideAllResults() {
    resultCard.classList.add('hidden');
    errorCard.classList.add('hidden');
    progressCard.classList.add('hidden');
  }

  function resetUpload() {
    hideAllResults();
    selectedFile = null;
    fileInput.value = '';
    imagePreview.src = '';
    imagePreview.classList.add('hidden');
    uploadPlaceholder.classList.remove('hidden');
    uploadArea.classList.remove('has-image');
    analyzeBtn.disabled = true;
    if (pollingId) {
      clearInterval(pollingId);
      pollingId = null;
    }
    isProcessing = false;
  }

  // ===== Main Analyze Flow =====
  analyzeBtn.addEventListener('click', startAnalysis);

  async function startAnalysis() {
    if (!selectedFile || isProcessing) return;

    isProcessing = true;
    hideAllResults();
    progressCard.classList.remove('hidden');

    try {
      // Phase 1: Upload
      progressStatus.textContent = 'Uploading...';
      progressBarFill.style.width = '20%';
      spinnerText.textContent = 'Uploading image to server...';

      const formData = new FormData();
      formData.append('image', selectedFile);

      const uploadRes = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      if (!uploadRes.ok) {
        const errData = await uploadRes.json().catch(() => ({}));
        throw new Error(errData.message || `Upload failed (HTTP ${uploadRes.status})`);
      }

      const uploadData = await uploadRes.json();
      const imageId = uploadData.id;
      if (!imageId) throw new Error('No image ID returned from server');

      // Phase 2: Poll for result
      progressStatus.textContent = 'Processing...';
      progressBarFill.style.width = '50%';
      spinnerText.textContent = 'Running AI analysis on the image...';

      const result = await pollForResult(imageId);

      // Phase 3: Display
      progressStatus.textContent = 'Fetching Result...';
      progressBarFill.style.width = '80%';
      spinnerText.textContent = 'Building result dashboard...';

      // Small delay for UX polish
      await new Promise((r) => setTimeout(r, 300));

      progressBarFill.style.width = '100%';
      await new Promise((r) => setTimeout(r, 200));

      // Hide progress, show result
      progressCard.classList.add('hidden');
      displayResult(result);

    } catch (err) {
      progressCard.classList.add('hidden');
      showError(err.message || 'An unexpected error occurred.');
    } finally {
      isProcessing = false;
    }
  }

  // ===== Polling =====
  function pollForResult(imageId) {
    return new Promise((resolve, reject) => {
      const MAX_ATTEMPTS = 120; // 120 * 2s = 4 minutes max wait
      let attempts = 0;

      poll();

      function poll() {
        attempts++;
        if (attempts > MAX_ATTEMPTS) {
          reject(new Error('Analysis timed out. Please try again.'));
          return;
        }

        fetch('/api/result/' + imageId)
          .then((res) => {
            if (!res.ok) throw new Error('Failed to fetch result');
            return res.json();
          })
          .then((data) => {
            if (data.status === 'completed' || data.status === 'failed') {
              if (data.status === 'failed') {
                reject(new Error(data.error || 'Analysis failed on the server.'));
              } else {
                resolve(data);
              }
            } else {
              // Still processing — update progress message
              const msgs = [
                'Analyzing blur and brightness...',
                'Running OCR engine...',
                'Extracting vehicle number plate...',
                'Checking for duplicates...',
                'Validating number plate...',
                'Calculating confidence score...',
              ];
              const idx = Math.min(attempts - 1, msgs.length - 1);
              spinnerText.textContent = 'Processing... ' + msgs[idx];
              progressBarFill.style.width = Math.min(50 + attempts * 2, 75) + '%';
              // Poll again after 2 seconds
              pollingId = setTimeout(poll, 2000);
            }
          })
          .catch((err) => {
            reject(err);
          });
      }
    });
  }

  // ===== Display Results =====
  function displayResult(data) {
    const a = data.analysis || {};
    const p = data.processing || {};
    const f = data.file || {};

    // ----- Status -----
    rStatus.textContent = data.status || '—';
    statusBadge.textContent = (data.status || '').charAt(0).toUpperCase() + (data.status || '').slice(1);
    statusBadge.className = 'badge';
    if (data.status === 'completed') {
      statusBadge.classList.add('badge-completed');
      rStatus.style.color = 'var(--success)';
    } else if (data.status === 'failed') {
      statusBadge.classList.add('badge-danger');
      rStatus.style.color = 'var(--danger)';
    } else {
      statusBadge.classList.add('badge-processing');
    }

    // ----- File Meta -----
    rFileName.textContent = f.name || '—';
    rFileSize.textContent = formatFileSize(f.size);
    rDimensions.textContent = f.width && f.height ? f.width + ' × ' + f.height : '—';
    rProcessingTime.textContent = formatTime(p.timeMs);
    rAnalysisVersion.textContent = data.analysisVersion || '—';

    // ----- Blur -----
    const isBlur = a.blur === true;
    vBlurScore.textContent = a.blurScore != null ? a.blurScore : '—';
    if (a.blurScore != null) {
      setBadge(bBlur, isBlur ? 'danger' : 'success', isBlur ? 'Blurry' : 'Sharp');
    } else {
      setBadge(bBlur, 'neutral', '—');
    }

    // ----- Brightness -----
    vBrightnessScore.textContent = a.brightnessScore != null ? a.brightnessScore : '—';
    const brightLabel = a.brightness || '—';
    let brightType = 'info';
    if (a.brightness === 'Very Dark' || a.brightness === 'Very Bright') brightType = 'danger';
    else if (a.brightness === 'Dark' || a.brightness === 'Bright') brightType = 'warning';
    else if (a.brightness === 'Good') brightType = 'success';
    setBadge(bBrightness, brightType, brightLabel);

    // ----- OCR Text -----
    vOcrText.textContent = a.ocrText || 'No text detected';

    // ----- Vehicle Number -----
    vVehicleNumber.textContent = a.vehicleNumber || 'Not found';

    // ----- Valid Number Plate -----
    const isValidPlate = a.validNumberPlate === true;
    setBadge(bPlate, isValidPlate ? 'success' : 'danger', isValidPlate ? 'Valid' : 'Invalid');

    // ----- Duplicate -----
    const isDuplicate = a.duplicate === true;
    setBadge(bDuplicate, isDuplicate ? 'danger' : 'success', isDuplicate ? 'Duplicate' : 'Unique');

    // ----- Screenshot -----
    const isScreenshot = a.screenshot === true;
    setBadge(bScreenshot, isScreenshot ? 'warning' : 'info', isScreenshot ? 'Screenshot' : 'Photo');

    // ----- Confidence -----
    setConfidence(a.overallConfidence);

    // ----- Show result card -----
    resultCard.classList.remove('hidden');
    resultCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ===== Reset / Retry =====
  resetBtn.addEventListener('click', () => {
    resetUpload();
    uploadCard.scrollIntoView({ behavior: 'smooth' });
  });

  errorRetryBtn.addEventListener('click', () => {
    errorCard.classList.add('hidden');
    if (selectedFile) {
      startAnalysis();
    } else {
      resetUpload();
    }
  });

  // ===== Allow clicking anywhere on upload area only when no image =====
  // Already handled in click listener above.

  // ===== Expose for debugging =====
  window.__app = { resetUpload, startAnalysis, checkServerHealth };

})();

