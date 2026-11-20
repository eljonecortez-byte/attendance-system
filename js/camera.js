/**
 * Camera, Watermark & GPS helpers (v3)
 *
 * camera.capture(info) opens a live camera screen, takes a photo and stamps it with:
 *   TIME IN / TIME OUT, time, date, employee, landowner, work location, GPS + accuracy,
 *   geofence distance, supervisor, record ID and the CocoTrack emblem.
 * The live camera (getUserMedia) is used so old gallery pictures can't be picked.
 * If the camera API is unavailable, it falls back to the phone camera app and the
 * watermark says "SOURCE: FILE" so reviewers know.
 */

class GeoService {
  /** Fresh GPS reading (never reuses an old position). Resolves null on failure. */
  getFreshPosition(timeoutMs = 15000) {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          acc: Math.round(pos.coords.accuracy),
          at: new Date(pos.timestamp || Date.now()).toISOString()
        }),
        (err) => resolve({ error: err && err.code === 1 ? 'PERMISSION_DENIED' : 'UNAVAILABLE' }),
        { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 }
      );
    });
  }

  distanceMeters(lat1, lng1, lat2, lng2) {
    const R = 6371000, toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad, dLng = (lng2 - lng1) * toRad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
    return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
  }

  /**
   * Compares a GPS reading with a work location.
   * Returns { status: INSIDE | OUTSIDE | NO_GPS | NO_LOCATION_COORDS, distance, radius, lowAccuracy }
   */
  check(pos, location, settings) {
    if (!pos || pos.error) return { status: 'NO_GPS', distance: null, radius: null, lowAccuracy: false };
    const lat = Number(location && location.latitude), lng = Number(location && location.longitude);
    if (!location || location.latitude === '' || location.latitude === undefined || isNaN(lat) || isNaN(lng)) {
      return { status: 'NO_LOCATION_COORDS', distance: null, radius: null, lowAccuracy: false };
    }
    const radius = Number(location.radiusMeters) || Number(settings.defaultRadiusMeters) || 300;
    const distance = this.distanceMeters(pos.lat, pos.lng, lat, lng);
    return {
      status: distance <= radius ? 'INSIDE' : 'OUTSIDE',
      distance,
      radius,
      lowAccuracy: pos.acc > Number(settings.maxGpsAccuracyMeters || 100)
    };
  }

  format(pos) {
    if (!pos || pos.error) return 'GPS Unavailable';
    return `${pos.lat.toFixed(6)}, ${pos.lng.toFixed(6)} (±${pos.acc}m)`;
  }
}

class CameraService {
  constructor() {
    this.stream = null;
    this.facingMode = 'environment';
    this.logo = null;
    this.maxSide = 1280;
    this.quality = 0.72;
  }

  async loadLogo() {
    if (this.logo) return this.logo;
    this.logo = await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = 'icons/logo-emblem.png';
    });
    return this.logo;
  }

  hasLiveCamera() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  stopStream() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }

  async startStream(video) {
    this.stopStream();
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: this.facingMode }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });
    video.srcObject = this.stream;
    video.style.transform = this.facingMode === 'user' ? 'scaleX(-1)' : 'none';
    await video.play().catch(() => {});
  }

  /**
   * Opens the camera screen.
   * info: { kind: 'IN'|'OUT', title, employeeName, employeeId, landowner, workLocation, gpsText,
   *         geofenceText, supervisor, recordId, allowSkip }
   * Resolves: { dataUrl, thumbUrl, takenAt, source } | { skipped: true } | null (cancelled)
   */
  capture(info) {
    return new Promise(async (resolve) => {
      this.facingMode = (await db.getSetting('cameraFacing', 'environment')) || 'environment';
      await this.loadLogo();

      const overlay = document.createElement('div');
      overlay.className = 'camera-overlay';
      overlay.innerHTML = `
        <div class="camera-top">
          <div>
            <div class="camera-kind camera-kind-${info.kind === 'OUT' ? 'out' : 'in'}">${info.kind === 'OUT' ? 'TIME OUT' : 'TIME IN'} PHOTO</div>
            <div class="camera-emp">${app.escape(info.employeeName)} <small>(${app.escape(info.employeeId)})</small></div>
          </div>
          ${info.employeePhoto ? `<div class="camera-ref"><img src="${info.employeePhoto}" alt="Registered photo" /><span>Registered<br/>photo</span></div>` : ''}
          <button type="button" class="camera-btn-ghost" data-act="cancel" aria-label="Cancel">✕</button>
        </div>
        <div class="camera-stage">
          <video playsinline muted autoplay></video>
          <img class="camera-preview" alt="Captured photo preview" style="display:none" />
          <div class="camera-msg" style="display:none"></div>
        </div>
        ${info.geofenceText ? `<div class="camera-geo">${app.escape(info.geofenceText)}</div>` : ''}
        <div class="camera-controls live-controls">
          <button type="button" class="camera-btn-ghost" data-act="switch" title="Switch camera">⟲</button>
          <button type="button" class="camera-shutter" data-act="shoot" aria-label="Take photo"></button>
          ${info.allowSkip ? '<button type="button" class="camera-btn-ghost small" data-act="skip">Skip</button>' : '<span style="width:48px"></span>'}
        </div>
        <div class="camera-controls review-controls" style="display:none">
          <button type="button" class="btn btn-outline" data-act="retake">↺ Retake</button>
          <button type="button" class="btn btn-primary" data-act="use">✓ Use Photo</button>
        </div>
        <input type="file" accept="image/*" capture="environment" style="display:none" />
      `;
      document.body.appendChild(overlay);

      const video = overlay.querySelector('video');
      const preview = overlay.querySelector('.camera-preview');
      const msg = overlay.querySelector('.camera-msg');
      const fileInput = overlay.querySelector('input[type=file]');
      const live = overlay.querySelector('.live-controls');
      const review = overlay.querySelector('.review-controls');
      let result = null;
      let source = 'camera';

      const close = (value) => {
        this.stopStream();
        overlay.remove();
        resolve(value);
      };

      const showMessage = (text) => {
        msg.textContent = text;
        msg.style.display = 'flex';
        video.style.display = 'none';
      };

      const showReview = () => {
        preview.src = result.dataUrl;
        preview.style.display = 'block';
        video.style.display = 'none';
        msg.style.display = 'none';
        live.style.display = 'none';
        review.style.display = 'flex';
      };

      const backToLive = async () => {
        result = null;
        preview.style.display = 'none';
        review.style.display = 'none';
        live.style.display = 'flex';
        if (source === 'camera') {
          video.style.display = 'block';
          try { await this.startStream(video); } catch (e) { showMessage('Camera stopped. Tap the shutter to use the phone camera app.'); source = 'file'; }
        } else {
          showMessage('Tap the shutter button to open the camera.');
        }
      };

      const fromFile = () => {
        fileInput.value = '';
        fileInput.click();
      };

      fileInput.addEventListener('change', async () => {
        const f = fileInput.files && fileInput.files[0];
        if (!f) return;
        try {
          const img = await this.fileToImage(f);
          result = await this.stamp(img, img.naturalWidth, img.naturalHeight, info, 'FILE');
          showReview();
        } catch (e) {
          showMessage('Could not read that photo. Please try again.');
        }
      });

      overlay.addEventListener('click', async (ev) => {
        const act = ev.target.closest('[data-act]') && ev.target.closest('[data-act]').dataset.act;
        if (!act) return;
        if (act === 'cancel') return close(null);
        if (act === 'skip') return close({ skipped: true });
        if (act === 'retake') return backToLive();
        if (act === 'use') return close(Object.assign({ source }, result));
        if (act === 'switch' && source === 'camera') {
          this.facingMode = this.facingMode === 'environment' ? 'user' : 'environment';
          await db.setSetting('cameraFacing', this.facingMode);
          try { await this.startStream(video); } catch (e) { /* keep current */ }
          return;
        }
        if (act === 'shoot') {
          if (source === 'file') return fromFile();
          if (!video.videoWidth) return; // camera not ready yet
          result = await this.stamp(video, video.videoWidth, video.videoHeight, info, 'CAMERA');
          this.stopStream();
          showReview();
        }
      });

      if (this.hasLiveCamera()) {
        try {
          await this.startStream(video);
        } catch (e) {
          source = 'file';
          showMessage(e && e.name === 'NotAllowedError'
            ? 'Camera permission is blocked. Allow camera access in your browser settings, or tap the shutter to use the phone camera app.'
            : 'Live camera is not available. Tap the shutter to use the phone camera app.');
        }
      } else {
        source = 'file';
        showMessage('Tap the shutter button to open the camera.');
      }
    });
  }

  fileToImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
      img.src = url;
    });
  }

  /** Draws the image + watermark. Returns { dataUrl, thumbUrl, takenAt }. */
  async stamp(source, srcW, srcH, info, sourceTag) {
    const takenAt = info.now ? info.now() : new Date();
    const scale = Math.min(1, this.maxSide / Math.max(srcW, srcH));
    const W = Math.round(srcW * scale), H = Math.round(srcH * scale);

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(source, 0, 0, W, H);

    this.drawWatermark(ctx, W, H, info, takenAt, sourceTag);

    const dataUrl = canvas.toDataURL('image/jpeg', this.quality);

    const tScale = 320 / Math.max(W, H);
    const t = document.createElement('canvas');
    t.width = Math.round(W * tScale); t.height = Math.round(H * tScale);
    t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
    const thumbUrl = t.toDataURL('image/jpeg', 0.6);

    return { dataUrl, thumbUrl, takenAt };
  }

  drawWatermark(ctx, W, H, info, takenAt, sourceTag) {
    const base = Math.max(14, Math.round(Math.min(W, H) / 26));
    const pad = Math.round(base * 0.8);
    const lh = Math.round(base * 1.35);
    const font = '-apple-system, "Segoe UI", Roboto, Arial, sans-serif';

    const p = (n) => String(n).padStart(2, '0');
    let h = takenAt.getHours();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    const timeStr = `${p(h)}:${p(takenAt.getMinutes())}:${p(takenAt.getSeconds())} ${ampm}`;
    const dateStr = takenAt.toLocaleDateString('en-PH', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });

    const lines = [
      `${info.employeeName}  (ID ${info.employeeId})`,
      `Landowner: ${info.landowner || '-'}   |   Location: ${info.workLocation || '-'}`,
      `GPS: ${info.gpsText || 'Unavailable'}`,
      info.geofenceText ? `Geofence: ${info.geofenceText}` : null,
      `Supervisor: ${info.supervisor || '-'}   |   Source: ${sourceTag}`,
      `CocoTrack  •  ${info.recordId}`
    ].filter(Boolean);

    const headerH = Math.round(base * 2.1);
    const bandH = pad * 2 + headerH + lines.length * lh;

    // Dark band at the bottom
    const grad = ctx.createLinearGradient(0, H - bandH - base * 2, 0, H);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(0.18, 'rgba(0,0,0,0.55)');
    grad.addColorStop(1, 'rgba(0,0,0,0.78)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, H - bandH - base * 2, W, bandH + base * 2);

    let y = H - bandH + pad;

    // Badge: TIME IN / TIME OUT
    const badgeText = info.kind === 'OUT' ? 'TIME OUT' : 'TIME IN';
    ctx.font = `800 ${Math.round(base * 1.05)}px ${font}`;
    const bw = ctx.measureText(badgeText).width + pad * 1.6;
    const bh = Math.round(base * 1.7);
    ctx.fillStyle = info.kind === 'OUT' ? '#0284c7' : '#16a34a';
    this.roundRect(ctx, pad, y, bw, bh, Math.round(base * 0.35));
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(badgeText, pad + pad * 0.8, y + bh / 2);

    // Big time + date
    ctx.font = `800 ${Math.round(base * 1.55)}px ${font}`;
    ctx.fillText(timeStr, pad + bw + pad, y + bh / 2);
    const tw = ctx.measureText(timeStr).width;
    ctx.font = `500 ${Math.round(base * 0.95)}px ${font}`;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillText(dateStr, pad + bw + pad * 2 + tw, y + bh / 2);

    y += headerH;
    ctx.textBaseline = 'top';
    lines.forEach((line, i) => {
      ctx.font = `${i === 0 ? 700 : 500} ${Math.round(base * (i === 0 ? 1.0 : 0.82))}px ${font}`;
      ctx.fillStyle = i === 0 ? '#ffffff' : 'rgba(255,255,255,0.92)';
      ctx.fillText(this.fit(ctx, line, W - pad * 2), pad, y);
      y += lh;
    });

    // Emblem top-left
    if (this.logo) {
      const s = Math.round(Math.min(W, H) * 0.13);
      ctx.globalAlpha = 0.85;
      ctx.drawImage(this.logo, pad, pad, s, s);
      ctx.globalAlpha = 1;
    }
  }

  fit(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 4 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
  }

  roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}

const geo = new GeoService();
const camera = new CameraService();

/**
 * Profile photo picker (user avatar / employee registration photo).
 * Live camera with a round guide, or upload from the gallery. Returns a small square JPEG data URL.
 */
CameraService.prototype.pickProfilePhoto = function ({ title, facing } = {}) {
  return new Promise(async (resolve) => {
    const prevFacing = this.facingMode;
    this.facingMode = facing || 'user';
    const overlay = document.createElement('div');
    overlay.className = 'camera-overlay';
    overlay.innerHTML = `
      <div class="camera-top">
        <div><div class="camera-emp">${app.escape(title || 'Profile photo')}</div>
        <small style="opacity:.8">Center the face inside the circle</small></div>
        <button type="button" class="camera-btn-ghost" data-act="cancel" aria-label="Cancel">✕</button>
      </div>
      <div class="camera-stage">
        <video playsinline muted autoplay></video>
        <div class="profile-guide"></div>
        <img class="camera-preview" alt="Preview" style="display:none; max-width:min(80vw,60vh); border-radius:50%;" />
        <div class="camera-msg" style="display:none"></div>
      </div>
      <div class="camera-controls live-controls">
        <button type="button" class="camera-btn-ghost small" data-act="upload" title="Upload from gallery">🖼</button>
        <button type="button" class="camera-shutter" data-act="shoot" aria-label="Take photo"></button>
        <button type="button" class="camera-btn-ghost" data-act="switch" title="Switch camera">⟲</button>
      </div>
      <div class="camera-controls review-controls" style="display:none">
        <button type="button" class="btn btn-outline" data-act="retake">↺ Retake</button>
        <button type="button" class="btn btn-primary" data-act="use">✓ Use Photo</button>
      </div>
      <input type="file" accept="image/*" style="display:none" />`;
    document.body.appendChild(overlay);

    const video = overlay.querySelector('video');
    const guide = overlay.querySelector('.profile-guide');
    const preview = overlay.querySelector('.camera-preview');
    const msg = overlay.querySelector('.camera-msg');
    const fileInput = overlay.querySelector('input[type=file]');
    const live = overlay.querySelector('.live-controls');
    const review = overlay.querySelector('.review-controls');
    let result = null;

    const close = (v) => { this.stopStream(); this.facingMode = prevFacing; overlay.remove(); resolve(v); };
    const showReview = () => {
      preview.src = result; preview.style.display = 'block';
      video.style.display = 'none'; guide.style.display = 'none'; msg.style.display = 'none';
      live.style.display = 'none'; review.style.display = 'flex';
    };
    const startLive = async () => {
      preview.style.display = 'none'; review.style.display = 'none'; live.style.display = 'flex';
      if (!this.hasLiveCamera()) { msg.textContent = 'Camera not available. Tap 🖼 to upload a photo.'; msg.style.display = 'flex'; guide.style.display = 'none'; return; }
      try {
        video.style.display = 'block'; guide.style.display = 'block'; msg.style.display = 'none';
        await this.startStream(video);
      } catch (e) {
        video.style.display = 'none'; guide.style.display = 'none';
        msg.textContent = 'Camera is blocked or not available. Tap 🖼 to upload a photo instead.';
        msg.style.display = 'flex';
      }
    };

    fileInput.addEventListener('change', async () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      try {
        const img = await this.fileToImage(f);
        result = this.squareCrop(img, img.naturalWidth, img.naturalHeight);
        this.stopStream();
        showReview();
      } catch (e) { msg.textContent = 'Could not read that photo.'; msg.style.display = 'flex'; }
    });

    overlay.addEventListener('click', async (ev) => {
      const el = ev.target.closest('[data-act]');
      if (!el) return;
      const act = el.dataset.act;
      if (act === 'cancel') return close(null);
      if (act === 'use') return close(result);
      if (act === 'retake') { result = null; return startLive(); }
      if (act === 'upload') { fileInput.value = ''; return fileInput.click(); }
      if (act === 'switch') {
        this.facingMode = this.facingMode === 'user' ? 'environment' : 'user';
        try { await this.startStream(video); } catch (e) {}
        return;
      }
      if (act === 'shoot' && video.videoWidth) {
        result = this.squareCrop(video, video.videoWidth, video.videoHeight);
        this.stopStream();
        showReview();
      }
    });

    startLive();
  });
};

/** Center square crop -> 240x240 JPEG, re-compressed until it fits in one sheet cell. */
CameraService.prototype.squareCrop = function (src, w, h) {
  const side = Math.min(w, h);
  const sx = (w - side) / 2, sy = (h - side) / 2;
  const out = document.createElement('canvas');
  out.width = 240; out.height = 240;
  out.getContext('2d').drawImage(src, sx, sy, side, side, 0, 0, 240, 240);
  let q = 0.82, url = out.toDataURL('image/jpeg', q);
  while (url.length > 45000 && q > 0.3) { q -= 0.1; url = out.toDataURL('image/jpeg', q); }
  return url;
};
