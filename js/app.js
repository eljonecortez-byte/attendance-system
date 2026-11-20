/**
 * MAIN APPLICATION CONTROLLER
 * Employee Attendance Monitoring System
 */

class AttendanceApp {
  constructor() {
    this.currentView = 'dashboard';
    this.activeGps = { coords: '', accuracy: null, status: 'Checking...' };
    this.selectedSyncIds = new Set();
    this.currentEditEmployee = null;
    this.currentAdjustRecord = null;
    this.sessionLandowner = null; // Active Landowner for area checking { id, name, workLocation }
    this.adminDash = null;        // Remembers the admin dashboard date / filters
    this.leaveEmployeeId = null;
    this.lastDataPull = null;
  }

  /* ---------- Date / status helpers ---------- */
  fmtLocalDate(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // Today's date in the DEVICE's local time zone (yyyy-MM-dd).
  // (toISOString() uses UTC, which is the previous day before 8:00 AM in the Philippines.)
  todayStr() {
    return this.fmtLocalDate(new Date());
  }

  shiftDate(ymdStr, days) {
    const [y, m, d] = ymdStr.split('-').map(Number);
    return this.fmtLocalDate(new Date(y, m - 1, d + days));
  }

  ymd(v) {
    if (!v) return '';
    if (typeof v === 'string') return v.slice(0, 10);
    try { return this.fmtLocalDate(new Date(v)); } catch (e) { return ''; }
  }

  isLeave(r) {
    return !!r && String(r.attendanceType || '').toUpperCase() === 'LEAVE';
  }

  csvCell(v) {
    return `"${String(v === null || v === undefined ? '' : v).replace(/"/g, '""')}"`;
  }

  /* ---------- v3 helpers ---------- */

  // Always "hh:mm AM" regardless of the phone's language settings
  fmtTime(d) {
    const p = (n) => String(n).padStart(2, '0');
    let h = d.getHours();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${p(h)}:${p(d.getMinutes())} ${ampm}`;
  }

  // Accepts "7:30 am", "07:30AM", "19:30" -> "07:30 AM" / "07:30 PM". Returns null if invalid.
  normalizeTime(str) {
    const m = String(str || '').trim().match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])?$/);
    if (!m) return null;
    let h = Number(m[1]);
    const min = Number(m[2]);
    if (min > 59) return null;
    let ampm = m[3] ? m[3].toUpperCase() : null;
    if (ampm) {
      if (h < 1 || h > 12) return null;
    } else {
      if (h > 23) return null;
      ampm = h >= 12 ? 'PM' : 'AM';
      h = h % 12 || 12;
    }
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')} ${ampm}`;
  }

  timeToMinutes(t) {
    const n = this.normalizeTime(t);
    if (!n) return null;
    let [hm, ampm] = n.split(' ');
    let [h, m] = hm.split(':').map(Number);
    if (h === 12) h = ampm === 'PM' ? 12 : 0; else if (ampm === 'PM') h += 12;
    return h * 60 + m;
  }

  // Same rule as the server: break deducted on long days, overtime above regular hours
  computeHours(timeIn, timeOut, settings) {
    const a = this.timeToMinutes(timeIn), b = this.timeToMinutes(timeOut);
    if (a === null || b === null) return { hours: '', overtime: '' };
    let diff = b - a;
    if (diff < 0) diff += 1440;
    if (diff >= Number(settings.breakAfterHours) * 60) diff -= Number(settings.breakMinutes) || 0;
    diff = Math.max(0, diff);
    const hours = Math.round((diff / 60) * 100) / 100;
    return { hours, overtime: Math.max(0, Math.round((hours - Number(settings.regularHours)) * 100) / 100) };
  }

  newRecordId(prefix = 'REC') {
    const rnd = (crypto.getRandomValues ? Array.from(crypto.getRandomValues(new Uint8Array(4))).map((b) => b.toString(36)).join('') : Math.random().toString(36).slice(2, 8));
    return `${prefix}-${Date.now()}-${rnd.toUpperCase().slice(0, 6)}`;
  }

  // Detects a wrong phone clock (compared with the server clock at the last sync)
  async getClockFlags(now) {
    const flags = [];
    const settings = await auth.getAppSettings();
    const offset = await db.getSetting('clockOffsetMs', null);
    if (offset !== null && Math.abs(offset) > Number(settings.maxClockDriftMinutes || 5) * 60000) {
      flags.push(`CLOCK_OFF_${Math.round(offset / 60000)}MIN`);
    }
    const lastTs = await db.getSetting('lastPunchTs', 0);
    if (lastTs && now.getTime() + 60000 < lastTs) flags.push('CLOCK_WENT_BACK');
    await db.setSetting('lastPunchTs', Math.max(now.getTime(), lastTs || 0));
    return flags.join(',');
  }

  geofenceLabel(status, distance, radius) {
    switch (status) {
      case 'INSIDE': return `Inside area (${distance} m from center, limit ${radius} m)`;
      case 'OUTSIDE': return `OUTSIDE area: ${distance} m from center (limit ${radius} m)`;
      case 'NO_GPS': return 'No GPS signal';
      case 'NO_LOCATION_COORDS': return 'Work location has no map coordinates yet';
      default: return '';
    }
  }

  // Small colored pills for geofence / clock / photo problems
  renderFlags(r) {
    const out = [];
    const geoPill = (label, st) => {
      if (!st) return;
      if (st.startsWith('INSIDE')) out.push(`<span class="flag-pill ${st.includes('LOW') ? 'flag-warn' : 'flag-ok'}" title="${this.escape(st)}">${label} ✓${st.includes('LOW') ? ' (weak GPS)' : ''}</span>`);
      else if (st.startsWith('OUTSIDE')) out.push(`<span class="flag-pill flag-bad" title="${this.escape(st)}">${label} outside</span>`);
      else if (st === 'NO_GPS') out.push(`<span class="flag-pill flag-warn">${label} no GPS</span>`);
    };
    geoPill('IN', r.geofenceIn);
    geoPill('OUT', r.geofenceOut);
    if (r.clockFlag) out.push(`<span class="flag-pill flag-bad" title="${this.escape(r.clockFlag)}">Clock?</span>`);
    if (!this.isLeave(r) && r.timeIn && !r.photoIn && r.photoInSkipped) out.push('<span class="flag-pill flag-warn">No IN photo</span>');
    if (r.adjustedBy) out.push('<span class="flag-pill flag-warn">Adjusted</span>');
    return out.join('');
  }

  async findLocation(locationId, workLocationName) {
    const locs = await db.getAll('locations');
    return locs.find((l) => String(l.locationId) === String(locationId || '')) ||
           locs.find((l) => workLocationName && l.workLocationName === workLocationName) || null;
  }

  openImage(src) {
    if (!src) return;
    const v = document.createElement('div');
    v.className = 'image-viewer';
    v.innerHTML = `<img src="${src}" alt="Attendance photo" />`;
    v.onclick = () => v.remove();
    document.body.appendChild(v);
  }

  // Generic modal (used for password change, confirmations, outbox)
  showGenericModal({ title, body, footer, onOpen, locked }) {
    document.getElementById('generic-modal-title').textContent = title;
    document.getElementById('generic-modal-body').innerHTML = body;
    document.getElementById('generic-modal-footer').innerHTML = footer || `<button type="button" class="btn btn-outline" onclick="app.closeModal('generic-modal')">Close</button>`;
    document.getElementById('generic-modal-close').style.display = locked ? 'none' : '';
    this.openModal('generic-modal');
    if (onOpen) onOpen();
  }

  /* ---------- LANDOWNER RULE ----------
     A supervisor can only use landowners that are registered under the Work Location(s)
     assigned to that supervisor. Example: Farm 4 Block 1 is assigned to Francis, so Francis
     only sees the landowners of Farm 4 Block 1.
     A landowner matches when its Location ID is one of the supervisor's locations,
     or when one of the supervisor's locations lists that landowner. */
  filterLandownersForSupervisor(landowners, locations, supervisorId) {
    const sid = String(supervisorId || '');
    if (!sid) return [];
    const myLocs = (locations || []).filter(
      (loc) => String(loc.supervisorId || '') === sid && (loc.status || 'Active') === 'Active'
    );
    const locById = new Map(myLocs.map((loc) => [String(loc.locationId), loc]));
    const locByLandowner = new Map();
    myLocs.forEach((loc) => { if (loc.landownerId) locByLandowner.set(String(loc.landownerId), loc); });

    const result = [];
    (landowners || []).forEach((l) => {
      if ((l.status || 'Active') !== 'Active') return;
      const loc = locById.get(String(l.locationId || '')) || locByLandowner.get(String(l.landownerId));
      if (!loc) return;
      result.push(Object.assign({}, l, {
        locationId: loc.locationId,
        workLocation: loc.workLocationName || l.workLocation || ''
      }));
    });
    return result.sort((a, b) =>
      String(a.workLocation).localeCompare(String(b.workLocation)) ||
      String(a.landownerName).localeCompare(String(b.landownerName))
    );
  }

  // Landowners the current user may pick (supervisor: only their locations; admin: all active)
  async getAllowedLandowners() {
    const [landowners, locations] = await Promise.all([db.getAll('landowners'), db.getAll('locations')]);
    if (auth.isSupervisor()) {
      return this.filterLandownersForSupervisor(landowners, locations, auth.getLinkedSupervisorId());
    }
    return landowners.filter((l) => (l.status || 'Active') === 'Active');
  }

  // Drop a remembered area-checking landowner that this supervisor is no longer allowed to use
  // (different account on the same phone, or the location was reassigned by the admin).
  async validateSessionLandowner() {
    if (!this.sessionLandowner) return;
    if (!auth.isSupervisor()) return;
    const locations = await db.getAll('locations');
    if (locations.length === 0) return; // data not downloaded yet: do not clear anything
    const allowed = await this.getAllowedLandowners();
    const cur = this.sessionLandowner;
    const ok = allowed.some((l) => String(l.landownerId) === String(cur.id) || l.landownerName === cur.name);
    if (!ok) {
      this.sessionLandowner = null;
      await db.setSetting('sessionLandowner', null);
      const pillText = document.getElementById('session-landowner-name-display');
      if (pillText) pillText.textContent = 'Area: Select Landowner';
    }
  }

  /* ==========================================================================
     THEMES
     ========================================================================== */
  getThemes() {
    return [
      { id: 'green', name: 'Coconut Green', desc: 'Default CocoTrack look', primary: '#15803d', p2: '#16a34a', page: '#f8fafc', surface: '#ffffff', bar: '#e2e8f0' },
      { id: 'ocean', name: 'Ocean Blue', desc: 'Calm blue', primary: '#1d4ed8', p2: '#2563eb', page: '#f8fafc', surface: '#ffffff', bar: '#e2e8f0' },
      { id: 'teal', name: 'Lagoon Teal', desc: 'Fresh blue-green', primary: '#0f766e', p2: '#0d9488', page: '#f8fafc', surface: '#ffffff', bar: '#e2e8f0' },
      { id: 'sunset', name: 'Sunset Orange', desc: 'Warm and bright', primary: '#c2410c', p2: '#ea580c', page: '#f8fafc', surface: '#ffffff', bar: '#e2e8f0' },
      { id: 'purple', name: 'Royal Purple', desc: 'Bold purple', primary: '#7e22ce', p2: '#9333ea', page: '#f8fafc', surface: '#ffffff', bar: '#e2e8f0' },
      { id: 'rose', name: 'Rose Pink', desc: 'Soft pink', primary: '#be185d', p2: '#db2777', page: '#f8fafc', surface: '#ffffff', bar: '#e2e8f0' },
      { id: 'earth', name: 'Copra Brown', desc: 'Earthy farm tones', primary: '#854d0e', p2: '#a16207', page: '#faf7f2', surface: '#ffffff', bar: '#e7e0d4' },
      { id: 'sunlight', name: 'Sunlight Contrast', desc: 'Strong contrast for bright sun', primary: '#005c16', p2: '#007a1f', page: '#ffffff', surface: '#ffffff', bar: '#000000' }
    ];
  }

  applyTheme(id) {
    if (id === 'midnight') { id = 'green'; this.applyMode('dark'); } // v3.1 "Midnight" theme -> Green + Dark mode
    const theme = this.getThemes().find((t) => t.id === id) || this.getThemes()[0];
    if (theme.id === 'green') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme.id);
    try { localStorage.setItem('cocotrack-theme', theme.id); } catch (e) { /* storage may be unavailable */ }
    const meta = document.querySelector('meta[name="theme-color"]');
    this.currentTheme = theme.id;
    this.applyMode(this.currentMode || 'light'); // Sunlight forces light; others keep the chosen mode
    if (meta && document.documentElement.getAttribute('data-mode') !== 'dark') meta.setAttribute('content', theme.primary);
  }

  /* ---------- Dark mode: 'light' | 'dark' | 'auto' (follow the phone setting) ---------- */
  applyMode(mode) {
    this.currentMode = ['light', 'dark', 'auto'].includes(mode) ? mode : 'light';
    try { localStorage.setItem('cocotrack-mode', this.currentMode); } catch (e) { /* ignore */ }
    const systemDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const dark = (this.currentMode === 'dark' || (this.currentMode === 'auto' && systemDark)) && this.currentTheme !== 'sunlight';
    if (dark) document.documentElement.setAttribute('data-mode', 'dark');
    else document.documentElement.removeAttribute('data-mode');
    const meta = document.querySelector('meta[name="theme-color"]');
    const theme = this.getThemes().find((t) => t.id === this.currentTheme) || this.getThemes()[0];
    if (meta) meta.setAttribute('content', dark ? '#0b1220' : theme.primary);
    this.updateDarkToggleIcon(dark);

    // In Auto, follow the phone when it switches between day and night
    if (!this._modeListener && window.matchMedia) {
      this._modeListener = () => { if (this.currentMode === 'auto') this.applyMode('auto'); };
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', this._modeListener);
      else if (mq.addListener) mq.addListener(this._modeListener);
    }
  }

  isDark() {
    return document.documentElement.getAttribute('data-mode') === 'dark';
  }

  updateDarkToggleIcon(dark) {
    const btn = document.getElementById('dark-toggle-btn');
    if (!btn) return;
    btn.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
    btn.innerHTML = dark
      ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>'
      : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  }

  async setMode(mode) {
    if (this.currentTheme === 'sunlight' && mode !== 'light') {
      this.showToast('Sunlight Contrast is a light theme. Pick another color theme to use dark mode.', 'info');
      await this.setTheme('green');
    }
    this.applyMode(mode);
    const user = auth.getCurrentUser();
    if (user) await db.setSetting(`mode:${user.userId}`, this.currentMode);
    document.querySelectorAll('.mode-switch button').forEach((b) => b.classList.toggle('active', b.dataset.mode === this.currentMode));
    this.refreshCurrentView();
  }

  /** Top-bar button: one tap between light and dark. */
  toggleDarkMode() {
    this.setMode(this.isDark() ? 'light' : 'dark');
  }

  /** Each user keeps their own theme on this phone. */
  async applyUserTheme() {
    const user = auth.getCurrentUser();
    if (!user) return;
    const savedMode = await db.getSetting(`mode:${user.userId}`, null);
    if (savedMode) this.currentMode = savedMode;
    const saved = await db.getSetting(`theme:${user.userId}`, null);
    if (saved) this.applyTheme(saved);
    else this.applyMode(this.currentMode || 'light');
  }

  async setTheme(id) {
    this.applyTheme(id);
    const user = auth.getCurrentUser();
    if (user) await db.setSetting(`theme:${user.userId}`, id);
    document.querySelectorAll('.theme-card').forEach((c) => c.classList.toggle('active', c.dataset.theme === id));
    this.refreshCurrentView();
  }

  openThemePicker() {
    const cur = this.currentTheme || (document.documentElement.getAttribute('data-theme') || 'green');
    this.showGenericModal({
      title: '🎨 Choose a Theme',
      body: `
        <div style="font-weight:700;font-size:13px;margin-bottom:6px;">Mode</div>
        <div class="mode-switch" role="group" aria-label="Light or dark mode">
          ${[['light', '☀️ Light'], ['dark', '🌙 Dark'], ['auto', '📱 Auto']].map(([m, l]) => `<button type="button" data-mode="${m}" class="${(this.currentMode || 'light') === m ? 'active' : ''}" onclick="app.setMode('${m}')">${l}</button>`).join('')}
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin:-8px 0 14px;">Auto follows your phone's day/night setting. Dark mode works with every color below except Sunlight Contrast.</div>
        <div style="font-weight:700;font-size:13px;margin-bottom:6px;">Color</div>
        <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">Saved for ${auth.getCurrentUser() ? 'your account on this phone' : 'this phone'}. Other users keep their own theme.</p>
        <div class="theme-grid">
          ${this.getThemes().map((t) => `
            <button type="button" class="theme-card ${t.id === cur ? 'active' : ''}" data-theme="${t.id}" onclick="app.setTheme('${t.id}')">
              <div class="theme-preview" style="background:${t.page}">
                <div class="tp-side" style="background:${t.surface}; border-right:1px solid ${t.bar}"></div>
                <div class="tp-main">
                  <div class="tp-bar" style="background:linear-gradient(135deg, ${t.primary}, ${t.p2})"></div>
                  <div class="tp-bar" style="background:${t.bar}; width:80%"></div>
                  <div class="tp-btn" style="background:${t.primary}"></div>
                </div>
              </div>
              <div class="tc-name">${t.id === cur ? '✓ ' : ''}${this.escape(t.name)}</div>
              <div class="tc-desc">${this.escape(t.desc)}</div>
            </button>`).join('')}
        </div>`
    });
  }

  /* ==========================================================================
     AVATARS (user profile pictures & employee registration photos)
     ========================================================================== */
  async loadAvatars() {
    const [avatars, users] = await Promise.all([db.getAll('avatars'), db.getAll('users')]);
    this.avatars = new Map(avatars.map((a) => [a.key, a.image]));
    // supervisorId -> userId (admin phones have the user list)
    this.userIdBySupervisor = new Map(users.filter((u) => u.linkedSupervisorId).map((u) => [String(u.linkedSupervisorId), String(u.userId)]));
    const me = auth.getCurrentUser();
    if (me && me.linkedSupervisorId) this.userIdBySupervisor.set(String(me.linkedSupervisorId), String(me.userId));
    this.renderSidebarAvatar();
  }

  getAvatar(type, id) {
    return (this.avatars && this.avatars.get(`${type}:${id}`)) || '';
  }

  supervisorAvatarKey(supervisorId) {
    const uid = this.userIdBySupervisor && this.userIdBySupervisor.get(String(supervisorId));
    return uid ? { type: 'USER', id: uid } : null;
  }

  avatarColor(name) {
    let h = 0;
    for (const ch of String(name || '?')) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return `hsl(${h}, 55%, 42%)`;
  }

  initials(name) {
    const parts = String(name || '?').trim().split(/\s+/);
    return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }

  /** Round avatar: photo if we have one, otherwise colored initials. */
  avatarHtml(type, id, name, size = 36, { onclick = '', markMissing = false } = {}) {
    const img = type && id ? this.getAvatar(type, id) : '';
    const cls = `avatar${onclick ? ' clickable' : ''}${!img && markMissing ? ' avatar-missing' : ''}`;
    const click = onclick ? ` onclick="event.stopPropagation(); ${onclick}"` : '';
    const title = img ? this.escape(name) : `${this.escape(name)}${markMissing ? ' – no photo yet' : ''}`;
    return img
      ? `<span class="${cls}" style="--size:${size}px" title="${title}"${click}><img src="${img}" alt="${this.escape(name)}" loading="lazy" /></span>`
      : `<span class="${cls}" style="--size:${size}px; background:${this.avatarColor(name)}" title="${title}"${click}>${this.escape(this.initials(name))}</span>`;
  }

  employeeAvatar(emp, size = 36, opts = {}) {
    return this.avatarHtml('EMPLOYEE', emp.employeeId, emp.employeeName, size, opts);
  }

  renderSidebarAvatar() {
    const el = document.getElementById('user-display-avatar');
    const user = auth.getCurrentUser();
    if (!el || !user) return;
    const img = this.getAvatar('USER', user.userId);
    el.classList.toggle('has-photo', !!img);
    el.innerHTML = img ? `<img src="${img}" alt="My photo" />` : this.escape(this.initials(user.name || user.username));
    el.title = 'Change my profile photo';
    el.onclick = () => this.openProfilePhotoModal('USER', user.userId, user.name || user.username);
  }

  /** Saves a photo locally right away, then online (or queued when offline). */
  async saveProfilePhoto(type, ownerId, image, label) {
    const key = `${type}:${ownerId}`;
    if (image) await db.put('avatars', { key, type, ownerId: String(ownerId), image, updatedAt: new Date().toISOString() });
    else await db.delete('avatars', key);
    if (!this.avatars) this.avatars = new Map();
    if (image) this.avatars.set(key, image); else this.avatars.delete(key);
    this.renderSidebarAvatar();
    try {
      const res = await api.saveMaster('SAVE_PROFILE_PHOTO', { type, ownerId: String(ownerId), image }, label);
      this.showToast(res.queued ? `${label}: saved on this phone, will upload when online.` : `${label}: saved.`, res.queued ? 'warning' : 'success');
      this.updateSyncBadge();
      return true;
    } catch (err) {
      this.showToast(`Photo not saved on the server: ${err.message}`, 'error');
      return false;
    }
  }

  /** Modal to view / take / upload / remove a profile photo. */
  openProfilePhotoModal(type, ownerId, name) {
    const me = auth.getCurrentUser() || {};
    const canEdit = auth.isAdmin() || (type === 'USER' && String(ownerId) === String(me.userId)) || (type === 'EMPLOYEE' && auth.isSupervisor());
    const img = this.getAvatar(type, ownerId);
    const label = type === 'USER' ? `Profile photo of ${name}` : `Photo of ${name}`;
    this.showGenericModal({
      title: type === 'USER' ? '👤 Profile Photo' : '🪪 Employee Photo',
      body: `
        <div style="display:flex;flex-direction:column;align-items:center;gap:12px;">
          ${img ? `<img src="${img}" alt="${this.escape(name)}" style="width:200px;height:200px;border-radius:50%;object-fit:cover;cursor:zoom-in;" onclick="app.openImage(this.src)" />`
                : this.avatarHtml(type, ownerId, name, 160)}
          <div style="font-weight:700;font-size:16px;">${this.escape(name)}</div>
          <div style="font-size:12px;color:var(--text-muted);">${img ? 'Tap the photo to enlarge.' : 'No photo yet.'}</div>
        </div>`,
      footer: `
        <button type="button" class="btn btn-outline" onclick="app.closeModal('generic-modal')">Close</button>
        ${canEdit && img ? `<button type="button" class="btn btn-danger" id="pp-remove">Remove</button>` : ''}
        ${canEdit ? `<button type="button" class="btn btn-primary" id="pp-take">📷 ${img ? 'Change' : 'Add'} Photo</button>` : ''}`,
      onOpen: () => {
        const take = document.getElementById('pp-take');
        if (take) take.onclick = async () => {
          this.closeModal('generic-modal');
          const shot = await camera.pickProfilePhoto({ title: label, facing: type === 'USER' && String(ownerId) === String(me.userId) ? 'user' : 'environment' });
          if (!shot) return;
          await this.saveProfilePhoto(type, ownerId, shot, label);
          this.refreshCurrentView();
        };
        const rm = document.getElementById('pp-remove');
        if (rm) rm.onclick = async () => {
          if (!confirm(`Remove the photo of ${name}?`)) return;
          this.closeModal('generic-modal');
          await this.saveProfilePhoto(type, ownerId, '', label);
          this.refreshCurrentView();
        };
      }
    });
  }

  /** Employee form: take/upload a registration photo (kept until the form is saved). */
  async captureEmployeePhoto() {
    const name = document.getElementById('emp-name-input').value.trim() || 'New employee';
    const shot = await camera.pickProfilePhoto({ title: `Registration photo – ${name}`, facing: 'environment' });
    if (!shot) return;
    this.pendingEmployeePhoto = shot;
    this.renderEmployeePhotoPreview();
  }

  removeEmployeePhoto() {
    this.pendingEmployeePhoto = 'REMOVE';
    this.renderEmployeePhotoPreview();
  }

  renderEmployeePhotoPreview() {
    const box = document.getElementById('emp-photo-preview');
    if (!box) return;
    const emp = this.currentEditEmployee;
    let img = '';
    if (this.pendingEmployeePhoto && this.pendingEmployeePhoto !== 'REMOVE') img = this.pendingEmployeePhoto;
    else if (!this.pendingEmployeePhoto && emp) img = this.getAvatar('EMPLOYEE', emp.employeeId);
    box.innerHTML = img
      ? `<span class="avatar" style="--size:96px"><img src="${img}" alt="Employee photo" /></span>`
      : `<span class="avatar avatar-missing" style="--size:96px; background:var(--bg-hover); color:var(--text-muted); font-size:30px;">📷</span>`;
    const rm = document.getElementById('emp-photo-remove');
    if (rm) rm.style.display = img ? 'inline-flex' : 'none';
    const btn = document.getElementById('emp-photo-btn');
    if (btn) btn.textContent = img ? '📷 Retake / Change Photo' : '📷 Take or Upload Photo';
  }

  async init() {
    console.log('[App] Initializing application...');

    // Initialize Database
    await db.init();

    // Check existing session
    const user = await auth.initSession();
    this.sessionLandowner = await db.getSetting('sessionLandowner', null);
    this.currentTheme = document.documentElement.getAttribute('data-theme') || 'green';
    try { this.currentMode = localStorage.getItem('cocotrack-mode') || 'light'; } catch (e) { this.currentMode = 'light'; }
    if (localStorage.getItem && (await db.getSetting('migratedMidnight', false)) === false) {
      // users who picked the old "Midnight" theme keep dark mode
      const u = auth.getCurrentUser();
      if (u && (await db.getSetting(`theme:${u.userId}`, null)) === 'midnight') {
        await db.setSetting(`theme:${u.userId}`, 'green');
        await db.setSetting(`mode:${u.userId}`, 'dark');
      }
      await db.setSetting('migratedMidnight', true);
    }
    await this.applyUserTheme();
    this.applyMode(this.currentMode);
    await this.loadAvatars();

    // Register Service Worker
    this.registerServiceWorker();

    // Start background GPS tracker
    this.initGpsTracking();

    // Bind event listeners
    this.bindEvents();

    // Subscribe to Sync updates
    syncService.subscribe((event) => this.handleSyncEvent(event));

    // Server says the session/account is no longer valid
    window.addEventListener('cocotrack:auth-invalid', (ev) => this.handleAuthInvalid(ev.detail));

    // Update connection badge
    this.updateNetworkBadge();

    // Route to appropriate view
    if (user) {
      await this.validateSessionLandowner();
      this.renderAppShell();
      this.navigateTo('dashboard');
      // If online, sync pending or pull latest data in background
      if (navigator.onLine) {
        syncService.autoSync();
        syncService.pullRemoteData(); // keeps assigned locations / landowners up to date
      }
      if (user.mustChangePassword) setTimeout(() => this.openChangePasswordModal(true), 400);
    } else {
      this.showLoginView();
    }
  }

  // Register Service Worker for PWA & Offline Support
  registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js')
        .then((reg) => console.log('[SW] Service Worker registered.', reg && reg.scope))
        .catch((err) => console.warn('[SW] Service Worker registration failed:', err));
    }
  }

  // GPS Acquisition
  async initGpsTracking() {
    if (!navigator.geolocation) {
      this.activeGps = { coords: '', accuracy: null, status: 'Not Supported' };
      this.renderGpsPill();
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude.toFixed(6);
        const lng = pos.coords.longitude.toFixed(6);
        const acc = Math.round(pos.coords.accuracy);
        this.activeGps = { coords: `${lat}, ${lng}`, accuracy: acc, status: 'Acquired' };
        this.renderGpsPill();
      },
      (err) => {
        this.activeGps = { coords: '', accuracy: null, status: 'Permission Denied / Off' };
        this.renderGpsPill();
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
    );
  }

  renderGpsPill() {
    const pill = document.getElementById('gps-status-pill');
    if (!pill) return;
    if (this.activeGps.coords) {
      pill.className = 'gps-pill gps-active';
      pill.innerHTML = `
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 2a8 8 0 0 0-8 8c0 5.25 8 12 8 12s8-6.75 8-12a8 8 0 0 0-8-8z"/>
          <circle cx="12" cy="10" r="3"/>
        </svg>
        <span class="gps-text">GPS<span class="gps-coords">: ${this.activeGps.coords}</span> (±${this.activeGps.accuracy}m)</span>
      `;
    } else {
      pill.className = 'gps-pill';
      pill.innerHTML = `
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <span>GPS: ${this.activeGps.status}</span>
      `;
    }
  }

  // Shows the number of items waiting to upload on the header Sync button
  async updateSyncBadge() {
    const btn = document.getElementById('quick-sync-btn');
    if (!btn) return;
    const stats = await syncService.getSyncStats();
    const n = stats.pendingRecords + stats.failedRecords + stats.pendingPhotos + stats.outboxCount;
    let badge = btn.querySelector('.sync-count');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'sync-count';
      badge.style.cssText = 'background:#f59e0b;color:#fff;border-radius:999px;font-size:10px;font-weight:700;padding:1px 6px;margin-left:4px;';
      btn.appendChild(badge);
    }
    badge.textContent = n;
    badge.style.display = n ? 'inline-block' : 'none';
    badge.style.background = stats.failedRecords || stats.failedPhotos || stats.outboxFailed ? '#ef4444' : '#f59e0b';
  }

  updateNetworkBadge() {
    const isOnline = navigator.onLine;
    const badge = document.getElementById('network-status-badge');
    if (!badge) return;

    if (isOnline) {
      badge.className = 'status-pill status-online';
      badge.innerHTML = '<span class="status-dot"></span> Online';
    } else {
      badge.className = 'status-pill status-offline';
      badge.innerHTML = '<span class="status-dot"></span> Offline';
    }
  }

  async handleAuthInvalid(detail) {
    if (this._authInvalidShown) return;
    this._authInvalidShown = true;
    await auth.invalidate(detail.code);
    this.showLoginView();
    const errEl = document.getElementById('login-error-alert');
    if (errEl) {
      errEl.textContent = `${detail.message} Your unsent records are still saved on this phone and will upload after you sign in.`;
      errEl.style.display = 'block';
    }
    setTimeout(() => { this._authInvalidShown = false; }, 3000);
  }

  handleSyncEvent(event) {
    if (event.type === 'NETWORK_CHANGE') {
      this.updateNetworkBadge();
      if (event.isOnline) {
        this.showToast('Internet connection restored. Synchronizing...', 'info');
      } else {
        this.showToast('You are offline. Attendance will be saved locally.', 'warning');
      }
    } else if (event.type === 'SYNC_COMPLETE') {
      if (event.problems) this.showToast(`${event.message} ${event.problems} item(s) need attention – see the Sync page.`, 'warning');
      else if (!event.silent || event.count > 0) this.showToast(event.message || 'Database is up to date.', 'success');
      this.updateSyncBadge();
      this.refreshCurrentView();
    } else if (event.type === 'SYNC_ERROR') {
      if (!['AUTH_REQUIRED', 'AUTH_EXPIRED', 'ACCOUNT_DISABLED'].includes(event.code)) this.showToast(`Sync issue: ${event.error}`, 'error');
      this.updateSyncBadge();
      this.refreshCurrentView();
    } else if (event.type === 'DATA_PULLED') {
      this.lastDataPull = new Date();
      Promise.all([this.validateSessionLandowner(), this.loadAvatars()]).then(() => this.refreshCurrentView());
    }
  }

  // Toast Notification Manager
  showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    let iconSvg = '';
    if (type === 'success') {
      iconSvg = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`;
    } else if (type === 'error') {
      iconSvg = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;
    } else if (type === 'warning') {
      iconSvg = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
    } else {
      iconSvg = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
    }

    toast.innerHTML = `
      ${iconSvg}
      <div style="flex: 1; word-break: break-word;">${message}</div>
    `;

    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  // Bind Global UI Events
  bindEvents() {
    // Keep table cells labelled for the mobile card layout
    const viewRoot = document.getElementById('view-content-root');
    if (viewRoot && !this._tableObserver) {
      this._tableObserver = new MutationObserver(() => this.labelTableCells(viewRoot));
      this._tableObserver.observe(viewRoot, { childList: true, subtree: true });
    }

    // Mobile Sidebar toggle
    const toggleBtn = document.getElementById('sidebar-toggle');
    const sidebar = document.getElementById('sidebar');
    if (toggleBtn && sidebar) {
      toggleBtn.addEventListener('click', () => sidebar.classList.toggle('open'));
    }

    // Close sidebar when clicking outside on mobile
    document.addEventListener('click', (e) => {
      if (sidebar && sidebar.classList.contains('open') && !sidebar.contains(e.target) && !toggleBtn.contains(e.target)) {
        sidebar.classList.remove('open');
      }
    });

    // Logout
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        const stats = await syncService.getSyncStats();
        const waiting = stats.pendingRecords + stats.failedRecords + stats.pendingPhotos;
        if (waiting && !confirm(`${waiting} item(s) are not uploaded yet. They stay saved on this phone and will upload the next time you sign in online. Sign out anyway?`)) return;
        await auth.logout();
        this.showLoginView();
      });
    }

    // Settings Modal
    const settingsBtn = document.getElementById('settings-btn');
    if (settingsBtn) {
      settingsBtn.addEventListener('click', () => this.openSettingsModal());
    }

    // Sync button in header
    const quickSyncBtn = document.getElementById('quick-sync-btn');
    if (quickSyncBtn) {
      quickSyncBtn.addEventListener('click', async () => {
        try {
          quickSyncBtn.disabled = true;
          this.showToast('Starting synchronization...', 'info');
          await syncService.syncAllPending();
        } catch (err) {
          this.showToast(err.message, 'error');
        } finally {
          quickSyncBtn.disabled = false;
        }
      });
    }
  }

  showLoginView() {
    document.getElementById('app-layout').style.display = 'none';
    document.getElementById('login-view-wrapper').style.display = 'flex';
    this.renderLoginForm();
  }

  renderAppShell() {
    document.getElementById('login-view-wrapper').style.display = 'none';
    document.getElementById('app-layout').style.display = 'flex';

    const user = auth.getCurrentUser();
    if (!user) return;

    // Update user info in sidebar
    const userNameEl = document.getElementById('user-display-name');
    const userRoleEl = document.getElementById('user-display-role');
    const userAvatarEl = document.getElementById('user-display-avatar');

    if (userNameEl) userNameEl.textContent = user.name || user.username;
    if (userRoleEl) userRoleEl.textContent = `${user.role} ${user.isOfflineSession ? '(Offline)' : ''}`;
    if (userAvatarEl) this.renderSidebarAvatar();

    // Render navigation links based on Role
    this.renderNavigation();
    this.renderGpsPill();
    this.updateNetworkBadge();
    this.updateSyncBadge();

    // Update active landowner pill for supervisor area checking
    const sessionLandownerPill = document.getElementById('session-landowner-pill');
    const sessionLandownerNameDisplay = document.getElementById('session-landowner-name-display');
    if (sessionLandownerPill) {
      if (auth.isSupervisor()) {
        sessionLandownerPill.style.display = 'inline-flex';
        if (sessionLandownerNameDisplay) {
          sessionLandownerNameDisplay.textContent = this.sessionLandowner ? `Area: ${this.sessionLandowner.name}` : 'Area: Select Landowner';
        }
      } else {
        sessionLandownerPill.style.display = 'none';
      }
    }
  }

  // Active Landowner Modal for Supervisor Area Checking
  async promptSelectSessionLandowner() {
    const modal = document.getElementById('landowner-session-modal');
    const select = document.getElementById('modal-landowner-select');
    const customInput = document.getElementById('modal-landowner-custom');
    const locInput = document.getElementById('modal-landowner-location');
    if (!modal || !select) return;

    // Only landowners registered under this supervisor's assigned location(s)
    const landowners = await this.getAllowedLandowners();
    const emptyNote = document.getElementById('modal-landowner-empty');
    if (emptyNote) emptyNote.style.display = landowners.length === 0 ? 'block' : 'none';
    if (locInput) locInput.readOnly = true;
    select.innerHTML = landowners.length === 0
      ? '<option value="">-- No landowner registered for your location --</option>'
      : '<option value="">-- Choose Landowner --</option>';
    landowners.forEach((l) => {
      const opt = document.createElement('option');
      opt.value = l.landownerName;
      opt.dataset.id = l.landownerId;
      opt.dataset.location = l.workLocation || '';
      opt.dataset.locationId = l.locationId || '';
      opt.textContent = `${l.landownerName}${l.workLocation ? ' (' + l.workLocation + ')' : ''}`;
      if (this.sessionLandowner && this.sessionLandowner.name === l.landownerName) {
        opt.selected = true;
      }
      select.appendChild(opt);
    });

    if (customInput) customInput.value = '';
    if (locInput) locInput.value = this.sessionLandowner ? (this.sessionLandowner.workLocation || '') : '';

    this.openModal('landowner-session-modal');
  }

  onModalLandownerSelectChange() {
    const select = document.getElementById('modal-landowner-select');
    const locInput = document.getElementById('modal-landowner-location');
    const customInput = document.getElementById('modal-landowner-custom');
    const selectedOpt = select.options[select.selectedIndex];
    if (selectedOpt && selectedOpt.value) {
      if (locInput && selectedOpt.dataset.location) {
        locInput.value = selectedOpt.dataset.location;
      }
      if (customInput) customInput.value = '';
    }
  }

  async saveSessionLandownerFromModal() {
    const select = document.getElementById('modal-landowner-select');
    const customInput = document.getElementById('modal-landowner-custom');
    const locInput = document.getElementById('modal-landowner-location');

    let lndName = '';
    let lndId = '';
    let locId = '';
    let workLoc = locInput ? locInput.value.trim() : '';

    const selectedOpt = select.options[select.selectedIndex];
    if (selectedOpt && selectedOpt.value) {
      lndName = selectedOpt.value;
      lndId = selectedOpt.dataset.id || '';
      locId = selectedOpt.dataset.locationId || '';
      if (!workLoc && selectedOpt.dataset.location) {
        workLoc = selectedOpt.dataset.location;
      }
    }

    if (!lndName) {
      alert('Please select or enter a Landowner name for area checking.');
      return;
    }

    const landownerObj = {
      id: lndId,
      name: lndName,
      locationId: locId,
      workLocation: workLoc
    };

    this.sessionLandowner = landownerObj;
    await db.setSetting('sessionLandowner', landownerObj);

    this.closeModal('landowner-session-modal');
    this.showToast(`Area Checking Landowner set to: ${lndName}`, 'success');
    this.renderAppShell();
    this.refreshCurrentView();
  }

  renderNavigation() {
    const nav = document.getElementById('sidebar-nav-links');
    const bottomNav = document.getElementById('bottom-nav');
    if (!nav) return;

    const isAdmin = auth.isAdmin();

    let linksHtml = `
      <div class="nav-section-title">Main</div>
      <div class="nav-item ${this.currentView === 'dashboard' ? 'active' : ''}" onclick="app.navigateTo('dashboard')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
        <span>Dashboard</span>
      </div>
      ${isAdmin ? '' : `
      <div class="nav-item ${this.currentView === 'attendance' ? 'active' : ''}" onclick="app.navigateTo('attendance')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        <span>Record Attendance</span>
      </div>
      `}
      <div class="nav-item ${this.currentView === 'history' ? 'active' : ''}" onclick="app.navigateTo('history')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
        <span>Attendance History</span>
      </div>
      <div class="nav-item ${this.currentView === 'reports' ? 'active' : ''}" onclick="app.navigateTo('reports')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
        <span>Cut-off Summary</span>
      </div>
      <div class="nav-item ${this.currentView === 'sync' ? 'active' : ''}" onclick="app.navigateTo('sync')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
        <span>Sync Dashboard</span>
      </div>
      <div class="nav-item" onclick="app.openThemePicker()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="13.5" cy="6.5" r="1.5"/><circle cx="17.5" cy="10.5" r="1.5"/><circle cx="8.5" cy="7.5" r="1.5"/><circle cx="6.5" cy="12.5" r="1.5"/><path d="M12 2a10 10 0 0 0 0 20c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2.4A5.6 5.6 0 0 0 23 10 10 10 0 0 0 12 2z"/></svg>
        <span>Theme</span>
      </div>
      <div class="nav-item" onclick="app.openProfilePhotoModal('USER', auth.getCurrentUser().userId, auth.getCurrentUser().name || auth.getCurrentUser().username)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        <span>My Profile Photo</span>
      </div>
      <div class="nav-item" onclick="app.openChangePasswordModal(false)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        <span>Change My Password</span>
      </div>
    `;

    if (isAdmin) {
      linksHtml += `
        <div class="nav-section-title">Administration</div>
        <div class="nav-item ${this.currentView === 'employees' ? 'active' : ''}" onclick="app.navigateTo('employees')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          <span>Employees</span>
        </div>
        <div class="nav-item ${this.currentView === 'supervisors' ? 'active' : ''}" onclick="app.navigateTo('supervisors')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          <span>Supervisors</span>
        </div>
        <div class="nav-item ${this.currentView === 'landowners' ? 'active' : ''}" onclick="app.navigateTo('landowners')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
          <span>Landowners</span>
        </div>
        <div class="nav-item ${this.currentView === 'locations' ? 'active' : ''}" onclick="app.navigateTo('locations')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
          <span>Work Locations</span>
        </div>
        <div class="nav-item ${this.currentView === 'users' ? 'active' : ''}" onclick="app.navigateTo('users')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          <span>User Accounts</span>
        </div>
        <div class="nav-item ${this.currentView === 'audit' ? 'active' : ''}" onclick="app.navigateTo('audit')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          <span>Audit Logs</span>
        </div>
        <div class="nav-item ${this.currentView === 'appsettings' ? 'active' : ''}" onclick="app.navigateTo('appsettings')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>
          <span>Photo, GPS & Pay Rules</span>
        </div>
      `;
    }

    nav.innerHTML = linksHtml;

    // Mobile Bottom Nav
    if (bottomNav) {
      bottomNav.innerHTML = `
        <div class="bottom-nav-item ${this.currentView === 'dashboard' ? 'active' : ''}" onclick="app.navigateTo('dashboard')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
          <span>Home</span>
        </div>
        ${isAdmin ? '' : `
        <div class="bottom-nav-item ${this.currentView === 'attendance' ? 'active' : ''}" onclick="app.navigateTo('attendance')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          <span>Record</span>
        </div>
        `}
        <div class="bottom-nav-item ${this.currentView === 'history' ? 'active' : ''}" onclick="app.navigateTo('history')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          <span>History</span>
        </div>
        <div class="bottom-nav-item ${this.currentView === 'sync' ? 'active' : ''}" onclick="app.navigateTo('sync')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          <span>Sync</span>
        </div>
        ${isAdmin ? `
        <div class="bottom-nav-item" onclick="event.stopPropagation(); app.toggleSidebar()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
          <span>More</span>
        </div>` : ''}
      `;
    }
  }

  toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    if (sidebar) sidebar.classList.toggle('open');
  }

  // Mobile: tag every table cell with its column name so CSS can show tables as stacked cards
  labelTableCells(root) {
    (root || document).querySelectorAll('table.data-table').forEach((table) => {
      const headers = Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent.trim());
      table.querySelectorAll('tbody tr').forEach((tr) => {
        Array.from(tr.children).forEach((td, i) => {
          if (!td.hasAttribute('data-label') && !td.hasAttribute('colspan')) {
            td.setAttribute('data-label', headers[i] || '');
          }
        });
      });
    });
  }

  navigateTo(viewName) {
    this.currentView = viewName;
    const sidebar = document.getElementById('sidebar');
    if (sidebar && sidebar.classList.contains('open')) {
      sidebar.classList.remove('open');
    }

    this.renderNavigation();
    this.renderCurrentView();
  }

  refreshCurrentView() {
    this.renderCurrentView();
  }

  renderCurrentView() {
    if (!auth.getCurrentUser()) return; // nothing renders behind the login screen
    const container = document.getElementById('view-content-root');
    const titleEl = document.getElementById('page-title-text');
    if (!container) return;

    switch (this.currentView) {
      case 'dashboard':
        if (titleEl) titleEl.textContent = auth.isAdmin() ? 'Administrator Dashboard' : 'Supervisor Dashboard';
        this.renderDashboard(container);
        break;

      case 'attendance':
        if (auth.isAdmin()) {
          this.currentView = 'dashboard';
          this.renderNavigation();
          if (titleEl) titleEl.textContent = 'Administrator Dashboard';
          this.renderDashboard(container);
          break;
        }
        if (titleEl) titleEl.textContent = 'Record Attendance';
        this.renderAttendanceRecording(container);
        break;

      case 'history':
        if (titleEl) titleEl.textContent = 'Attendance History';
        this.renderHistory(container);
        break;

      case 'sync':
        if (titleEl) titleEl.textContent = 'Synchronization Center';
        this.renderSyncView(container);
        break;

      case 'employees':
        if (titleEl) titleEl.textContent = 'Employee Enrollment & Management';
        this.renderEmployeesView(container);
        break;

      case 'supervisors':
        if (titleEl) titleEl.textContent = 'Supervisor Enrollment';
        this.renderSupervisorsView(container);
        break;

      case 'landowners':
        if (titleEl) titleEl.textContent = 'Landowner Enrollment';
        this.renderLandownersView(container);
        break;

      case 'locations':
        if (titleEl) titleEl.textContent = 'Work Location Enrollment';
        this.renderLocationsView(container);
        break;

      case 'users':
        if (titleEl) titleEl.textContent = 'User Accounts & Security';
        this.renderUsersView(container);
        break;

      case 'audit':
        if (titleEl) titleEl.textContent = 'Audit Trail & Change Logs';
        this.renderAuditView(container);
        break;

      case 'reports':
        if (titleEl) titleEl.textContent = 'Cut-off Summary';
        this.renderReportsView(container);
        break;

      case 'appsettings':
        if (!auth.isAdmin()) { this.navigateTo('dashboard'); return; }
        if (titleEl) titleEl.textContent = 'Photo, GPS & Pay Rules';
        this.renderAppSettingsView(container);
        break;

      default:
        this.renderDashboard(container);
    }
  }

  /* ==========================================================================
     LOGIN VIEW
     ========================================================================== */
  async renderLoginForm() {
    const root = document.getElementById('login-view-wrapper');
    if (!root) return;

    root.innerHTML = `
      <div class="login-card" style="width: 100%; max-width: 440px; padding: 32px; background: var(--bg-surface); border-radius: 16px; box-shadow: var(--shadow-lg); border: 1px solid var(--border);">
        <div style="text-align: center; margin-bottom: 24px;">
          <img src="icons/logo-full.png" class="login-logo" alt="CocoTrack Attendance & Monitoring" />
          <p style="font-size: 13px; color: var(--text-muted); margin-top: 10px;">Online & Offline Mobile Attendance Monitoring</p>
        </div>

        <form id="login-form">
          <div class="form-group">
            <label class="form-label required">Username</label>
            <input type="text" id="login-username" class="form-control" placeholder="e.g. admin or supervisor1" required autocomplete="username" />
          </div>

          <div class="form-group">
            <label class="form-label required">Password</label>
            <input type="password" id="login-password" class="form-control" placeholder="••••••••" required autocomplete="current-password" />
          </div>

          <div id="login-error-alert" style="display: none; padding: 10px 14px; background: #fee2e2; color: #b91c1c; border-radius: 8px; font-size: 13px; margin-bottom: 16px;"></div>

          <button type="submit" id="login-submit-btn" class="btn btn-primary" style="width: 100%; padding: 12px; font-size: 15px;">
            Sign In
          </button>
        </form>

        <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center;">
          <span style="font-size: 12px; color: var(--text-muted);">
            Network: <strong id="login-network-status">${navigator.onLine ? 'Online' : 'Offline'}</strong>
          </span>
          <span style="display:flex; gap:6px;">
            <button type="button" class="btn btn-outline" style="font-size: 12px; padding: 4px 10px;" onclick="app.toggleDarkMode()" title="Dark mode">🌙</button>
            <button type="button" class="btn btn-outline" style="font-size: 12px; padding: 4px 10px;" onclick="app.openThemePicker()" title="Theme">🎨</button>
            <button type="button" class="btn btn-outline" style="font-size: 12px; padding: 4px 10px;" onclick="app.openSettingsModal()">
              ⚙ API Settings
            </button>
          </span>
        </div>

        <div style="margin-top: 12px; font-size: 11px; color: var(--text-light); text-align: center;">
          First login on a new phone needs internet. After that you can sign in offline.
        </div>
      </div>
    `;

    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('login-username').value;
      const password = document.getElementById('login-password').value;
      const errEl = document.getElementById('login-error-alert');
      const submitBtn = document.getElementById('login-submit-btn');

      errEl.style.display = 'none';
      submitBtn.disabled = true;
      submitBtn.textContent = 'Verifying...';

      try {
        const res = await auth.login(username, password);

        // Download this account's latest locations / landowners, then drop any area that is not theirs
        if (res.mode === 'online') {
          submitBtn.textContent = 'Loading your areas...';
          await syncService.pullRemoteData();
          syncService.autoSync(); // upload anything left from an earlier session
        }
        await this.validateSessionLandowner();
        await this.applyUserTheme();
        await this.loadAvatars();

        this.showToast(res.message, res.mode === 'offline' ? 'warning' : 'success');
        this.renderAppShell();
        this.navigateTo('dashboard');

        if (res.user.mustChangePassword && res.mode === 'online') {
          setTimeout(() => this.openChangePasswordModal(true), 350);
        } else if (auth.isSupervisor() && (!this.sessionLandowner || !this.sessionLandowner.name)) {
          // If supervisor logged in without selecting landowner, prompt them immediately
          setTimeout(() => this.promptSelectSessionLandowner(), 350);
        }
      } catch (err) {
        errEl.textContent = err.message;
        errEl.style.display = 'block';
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Sign In';
      }
    });
  }

  /* ==========================================================================
     DASHBOARD VIEW (ADMIN & SUPERVISOR)
     ========================================================================== */
  async renderDashboard(container) {
    if (auth.isAdmin()) {
      return this.renderAdminDashboard(container);
    }
    container.innerHTML = `<div style="text-align: center; padding: 40px; color: var(--text-muted);">Loading dashboard data...</div>`;

    const isAdmin = auth.isAdmin();
    const supervisorId = auth.getLinkedSupervisorId();

    const [allEmployees, allSupervisors, allLandowners, allLocations, allAttendance, syncStats] = await Promise.all([
      db.getAll('employees'),
      db.getAll('supervisors'),
      db.getAll('landowners'),
      db.getAll('locations'),
      db.getAll('attendance'),
      syncService.getSyncStats()
    ]);

    // Role filtering: supervisors ONLY see their assigned data!
    let employees = allEmployees.filter((e) => (e.employmentStatus || 'Active') === 'Active');
    let attendance = allAttendance.filter((a) => a.recordStatus !== 'DELETED');
    let landowners = allLandowners;
    let locations = allLocations;

    if (!isAdmin && supervisorId) {
      employees = allEmployees.filter((e) => (e.supervisorId || '').toString() === supervisorId.toString());
      attendance = attendance.filter((a) => (a.supervisorId || '').toString() === supervisorId.toString());
      landowners = this.filterLandownersForSupervisor(allLandowners, allLocations, supervisorId);
      locations = allLocations.filter((loc) => (loc.supervisorId || '').toString() === supervisorId.toString());
    }

    const todayDate = this.todayStr();
    const todayRecords = attendance.filter((a) => this.ymd(a.attendanceDate) === todayDate);

    const totalEmployeesCount = employees.length;
    const presentTodayCount = todayRecords.filter((a) => !this.isLeave(a) && !!a.timeIn).length;
    const leaveTodayCount = todayRecords.filter((a) => this.isLeave(a)).length;
    const clockedOutTodayCount = todayRecords.filter((a) => !!a.timeOut).length;
    const notYetRecordedCount = Math.max(0, totalEmployeesCount - presentTodayCount - leaveTodayCount);

    const pendingSyncCount = syncStats.pendingRecords + syncStats.failedRecords;
    const syncedCount = syncStats.syncedRecords;

    container.innerHTML = `
      ${!isAdmin ? `
        <div class="content-card banner-card" style="background: linear-gradient(135deg, var(--primary), var(--primary-2)); color: #ffffff; padding: 16px 20px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-bottom: 20px;">
          <div style="display: flex; align-items: center; gap: 14px;">
            <div style="width: 44px; height: 44px; border-radius: 50%; background: rgba(255,255,255,0.2); display: flex; align-items: center; justify-content: center; font-size: 22px;">🌾</div>
            <div>
              <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.9;">Current Area Checking (Landowner)</div>
              <div style="font-size: 18px; font-weight: 700;">${this.sessionLandowner ? this.escape(this.sessionLandowner.name) : 'No Landowner Selected'}</div>
              <div style="font-size: 12px; opacity: 0.9;">${this.sessionLandowner?.workLocation ? 'Location: ' + this.escape(this.sessionLandowner.workLocation) : 'Daily worker Time IN punches will record this Landowner name'}</div>
            </div>
          </div>
          <button class="btn" style="background: #ffffff; color: var(--primary); font-weight: 700; font-size: 13px;" onclick="app.promptSelectSessionLandowner()">
            ✏️ Change Landowner Area
          </button>
        </div>
      ` : ''}

      <div class="metrics-grid">
        <div class="metric-card">
          <div class="metric-card-header">
            <span class="metric-title">${isAdmin ? 'Total Employees' : 'Assigned Employees'}</span>
            <div class="metric-icon icon-green">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
            </div>
          </div>
          <div class="metric-value">${totalEmployeesCount}</div>
        </div>

        <div class="metric-card">
          <div class="metric-card-header">
            <span class="metric-title">Present Today (Time IN)</span>
            <div class="metric-icon icon-green">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            </div>
          </div>
          <div class="metric-value" style="color: var(--primary);">${presentTodayCount}</div>
        </div>

        <div class="metric-card">
          <div class="metric-card-header">
            <span class="metric-title">On Leave Today</span>
            <div class="metric-icon icon-amber">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            </div>
          </div>
          <div class="metric-value" style="color: #b45309;">${leaveTodayCount}</div>
        </div>

        <div class="metric-card">
          <div class="metric-card-header">
            <span class="metric-title">Not Yet Recorded</span>
            <div class="metric-icon icon-red">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            </div>
          </div>
          <div class="metric-value" style="color: var(--accent-red);">${notYetRecordedCount}</div>
        </div>

        <div class="metric-card">
          <div class="metric-card-header">
            <span class="metric-title">Pending Upload</span>
            <div class="metric-icon icon-amber">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/></svg>
            </div>
          </div>
          <div class="metric-value" style="color: #b45309;">${pendingSyncCount}</div>
        </div>

        <div class="metric-card">
          <div class="metric-card-header">
            <span class="metric-title">Synced to Sheets</span>
            <div class="metric-icon icon-blue">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
          </div>
          <div class="metric-value" style="color: var(--accent-blue);">${syncedCount}</div>
        </div>
      </div>

      <!-- Quick Action Banner -->
      <div class="content-card banner-card" style="background: linear-gradient(135deg, var(--primary), var(--primary-2)); color: #ffffff; padding: 20px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-bottom: 24px;">
        <div>
          <h3 style="font-size: 18px; font-weight: 700; margin-bottom: 4px;">Ready to record attendance?</h3>
          <p style="font-size: 13px; opacity: 0.9;">Time IN and Time OUT work seamlessly offline and online.</p>
        </div>
        <button class="btn" style="background: #ffffff; color: var(--primary); font-weight: 700;" onclick="app.navigateTo('attendance')">
          Go to Attendance
        </button>
      </div>

      <div id="cutoff-host"></div>

      <!-- Summary by Date and Location -->
      <div class="content-card">
        <div class="card-header">
          <h3 class="card-title">Attendance Summary (Today - ${todayDate})</h3>
          <span style="font-size: 13px; color: var(--text-muted);">${todayRecords.length} recorded session(s)</span>
        </div>
        <div class="card-body">
          ${todayRecords.length === 0 ? `
            <div style="text-align: center; padding: 32px; color: var(--text-muted);">
              No attendance recorded yet for today (${todayDate}).
            </div>
          ` : `
            <div class="table-responsive">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Employee ID</th>
                    <th>Name</th>
                    <th>Location</th>
                    <th>Landowner</th>
                    <th>Time IN</th>
                    <th>Time OUT</th>
                    <th>GPS Coordinates</th>
                    <th>Sync Status</th>
                  </tr>
                </thead>
                <tbody>
                  ${todayRecords.map((r) => `
                    <tr>
                      <td><span class="emp-id-badge">${this.escape(r.employeeId)}</span></td>
                      <td><strong>${this.escape(r.employeeName)}</strong></td>
                      <td>${this.escape(r.workLocation || '-')}</td>
                      <td>${this.escape(r.landownerName || '-')}</td>
                      <td>${this.isLeave(r) ? `<span class="status-pill badge-leave">On Leave${r.leaveType ? ' – ' + this.escape(r.leaveType) : ''}</span>` : `<strong style="color: var(--primary);">${this.escape(r.timeIn || '-')}</strong>`}</td>
                      <td>${this.escape(r.timeOut || '-')}</td>
                      <td><small style="color: var(--text-muted);">${this.escape(r.actualGpsIn || '-')}</small></td>
                      <td><span class="status-pill badge-${(r.syncStatus || 'PENDING').toLowerCase()}">${r.syncStatus}</span></td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          `}
        </div>
      </div>
    `;
    this.renderCutoffSection(document.getElementById('cutoff-host'), { compact: true });
  }

  /* ==========================================================================
     ADMIN DASHBOARD (SUMMARY ONLY - NO RECORDING)
     ========================================================================== */
  getAdminDashState() {
    if (!this.adminDash) {
      this.adminDash = { date: this.todayStr(), supervisorId: '', location: '' };
    }
    return this.adminDash;
  }

  // Work out PRESENT / LEAVE / ABSENT for every employee on one date
  computeDayStatuses(employees, recsForDate, date) {
    const byEmp = new Map();
    recsForDate.forEach((r) => {
      const key = String(r.employeeId);
      const prev = byEmp.get(key);
      // if an employee has both a leave entry and a punch, the punch wins (they actually came)
      if (!prev || (this.isLeave(prev) && !this.isLeave(r))) byEmp.set(key, r);
    });
    const isFuture = date > this.todayStr();
    return employees.map((emp) => {
      const rec = byEmp.get(String(emp.employeeId)) || null;
      let status;
      if (rec && this.isLeave(rec)) status = 'LEAVE';
      else if (rec && rec.timeIn) status = 'PRESENT';
      else status = isFuture ? 'NONE' : 'ABSENT';
      return { emp, rec, status };
    });
  }

  donutSvg(segments, total, centerBig, centerSmall) {
    const r = 70, cx = 90, cy = 90, sw = 28;
    const C = 2 * Math.PI * r;
    let offset = 0;
    let rings = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" style="stroke:var(--border)" stroke-width="${sw}"/>`;
    if (total > 0) {
      segments.forEach((seg) => {
        if (seg.value <= 0) return;
        const len = (seg.value / total) * C;
        rings += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${seg.color}" stroke-width="${sw}"
          stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})"><title>${this.escape(seg.label)}: ${seg.value}</title></circle>`;
        offset += len;
      });
    }
    return `
      <svg viewBox="0 0 180 180" class="donut-svg" role="img" aria-label="Attendance pie chart">
        ${rings}
        <text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="28" font-weight="700" style="fill:var(--text-main)">${centerBig}</text>
        <text x="${cx}" y="${cy + 24}" text-anchor="middle" font-size="11" style="fill:var(--text-muted)">${centerSmall}</text>
      </svg>`;
  }

  trendSvg(days) {
    // days: [{date, present, leave, absent, total}]
    const W = 340, H = 150, padL = 4, padB = 26, padT = 8;
    const bw = 30, gap = (W - padL * 2 - bw * days.length) / Math.max(1, days.length - 1);
    const maxH = H - padB - padT;
    let bars = '';
    days.forEach((d, i) => {
      const x = padL + i * (bw + gap);
      const t = Math.max(1, d.total);
      const hp = (d.present / t) * maxH;
      const hl = (d.leave / t) * maxH;
      const ha = (d.absent / t) * maxH;
      let y = H - padB;
      const seg = (h, color) => { if (h <= 0) return ''; y -= h; return `<rect x="${x}" y="${y}" width="${bw}" height="${h}" fill="${color}" rx="2"/>`; };
      const noData = d.present + d.leave === 0;
      const dt = new Date(d.date + 'T00:00:00');
      const lbl = dt.toLocaleDateString([], { weekday: 'short' });
      bars += `<g><title>${d.date}: ${noData ? 'no records' : d.present + ' present, ' + d.leave + ' on leave, ' + d.absent + ' absent'}</title>
        ${noData ? `<rect x="${x}" y="${H - padB - 6}" width="${bw}" height="6" style="fill:var(--border)" rx="2"/>` : seg(hp, '#16a34a') + seg(hl, '#f59e0b') + seg(ha, '#fca5a5')}
        <text x="${x + bw / 2}" y="${H - 12}" text-anchor="middle" font-size="10" style="fill:var(--text-muted)">${lbl}</text>
        <text x="${x + bw / 2}" y="${H - 1}" text-anchor="middle" font-size="9" style="fill:var(--text-light)">${dt.getDate()}</text></g>`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" class="trend-svg" role="img" aria-label="7 day attendance trend">${bars}</svg>`;
  }

  async renderAdminDashboard(container) {
    const state = this.getAdminDashState();
    if (!container.querySelector('#admin-dash-root')) {
      container.innerHTML = `<div style="text-align: center; padding: 40px; color: var(--text-muted);">Loading dashboard data...</div>`;
    }

    const [allEmployees, supervisors, allAttendance, syncStats] = await Promise.all([
      db.getAll('employees'),
      db.getAll('supervisors'),
      db.getAll('attendance'),
      syncService.getSyncStats()
    ]);

    const supName = new Map(supervisors.map((s) => [String(s.supervisorId), s.supervisorName]));
    const supLabel = (emp) => supName.get(String(emp.supervisorId || '')) || emp.supervisorName || 'Unassigned';

    // Only active employees count
    const activeEmployees = allEmployees.filter((e) => (e.employmentStatus || 'Active') === 'Active');

    const locations = [...new Set(activeEmployees.map((e) => e.workLocation).filter(Boolean))].sort();
    const supOptions = [...supervisors].sort((a, b) => String(a.supervisorName).localeCompare(String(b.supervisorName)));

    // Apply filters
    let employees = activeEmployees;
    if (state.supervisorId) employees = employees.filter((e) => String(e.supervisorId || '') === String(state.supervisorId));
    if (state.location) employees = employees.filter((e) => (e.workLocation || '') === state.location);

    // Group attendance by date once
    const attByDate = new Map();
    allAttendance.forEach((r) => {
      if (r.recordStatus === 'DELETED') return;
      const d = this.ymd(r.attendanceDate);
      if (!attByDate.has(d)) attByDate.set(d, []);
      attByDate.get(d).push(r);
    });

    const date = state.date;
    const isFuture = date > this.todayStr();
    const rows = this.computeDayStatuses(employees, attByDate.get(date) || [], date);

    const count = (st) => rows.filter((x) => x.status === st).length;
    const total = rows.length;
    const present = count('PRESENT');
    const leave = count('LEAVE');
    const absent = count('ABSENT');
    const pct = (n, t) => (t > 0 ? Math.round((n / t) * 100) : 0);

    // Per supervisor
    const groups = new Map();
    rows.forEach((x) => {
      const key = String(x.emp.supervisorId || '');
      if (!groups.has(key)) groups.set(key, { id: key, name: supLabel(x.emp), items: [] });
      groups.get(key).items.push(x);
    });
    const groupList = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
    this.adminDashData = { groups: groupList, date, isFuture };

    const supRowsHtml = groupList.map((g) => {
      const p = g.items.filter((x) => x.status === 'PRESENT').length;
      const l = g.items.filter((x) => x.status === 'LEAVE').length;
      const a = g.items.filter((x) => x.status === 'ABSENT').length;
      const rate = pct(p, g.items.length);
      return `
        <tr class="clickable-row" onclick="app.showSupervisorDetail('${this.escape(g.id)}')">
          <td><strong>${this.escape(g.name)}</strong></td>
          <td>${g.items.length}</td>
          <td><strong style="color: var(--primary);">${p}</strong></td>
          <td><strong style="color: #b45309;">${l}</strong></td>
          <td><strong style="color: var(--accent-red);">${isFuture ? '-' : a}</strong></td>
          <td><div class="pct-cell"><span>${rate}%</span><div class="bar"><i style="width: ${rate}%;"></i></div></div></td>
          <td><button class="btn btn-outline view-btn" onclick="event.stopPropagation(); app.showSupervisorDetail('${this.escape(g.id)}')">View ›</button></td>
        </tr>`;
    }).join('');

    // Absent follow-up list (grouped by supervisor)
    const absentGroups = groupList
      .map((g) => ({ name: g.name, items: g.items.filter((x) => x.status === 'ABSENT') }))
      .filter((g) => g.items.length > 0);

    // 7-day trend ending on selected date
    const trendDays = [];
    for (let i = 6; i >= 0; i--) {
      const d = this.shiftDate(date, -i);
      const st = this.computeDayStatuses(employees, attByDate.get(d) || [], d);
      const p = st.filter((x) => x.status === 'PRESENT').length;
      const l = st.filter((x) => x.status === 'LEAVE').length;
      const a = st.filter((x) => x.status === 'ABSENT').length;
      trendDays.push({ date: d, present: p, leave: l, absent: a, total: st.length });
    }

    const prettyDate = new Date(date + 'T00:00:00').toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const updatedText = this.lastDataPull
      ? `Updated ${this.lastDataPull.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : 'Showing data saved on this device';
    const pendingCount = syncStats.pendingRecords + syncStats.failedRecords;

    container.innerHTML = `
      <div id="admin-dash-root">
        <div class="toolbar admin-tools">
          <div class="date-controls">
            <button class="btn btn-outline btn-icon" onclick="app.adminDashShiftDate(-1)" title="Previous day">‹</button>
            <input type="date" id="admin-dash-date" class="select-filter" value="${date}" onchange="app.adminDashSetDate(this.value)" />
            <button class="btn btn-outline btn-icon" onclick="app.adminDashShiftDate(1)" title="Next day">›</button>
            <button class="btn btn-outline" onclick="app.adminDashSetDate(app.todayStr())">Today</button>
          </div>

          <select id="admin-dash-sup" class="select-filter" onchange="app.adminDashSetFilter('supervisorId', this.value)">
            <option value="">All Supervisors</option>
            ${supOptions.map((s) => `<option value="${this.escape(s.supervisorId)}" ${String(state.supervisorId) === String(s.supervisorId) ? 'selected' : ''}>${this.escape(s.supervisorName)}</option>`).join('')}
          </select>

          <select id="admin-dash-loc" class="select-filter" onchange="app.adminDashSetFilter('location', this.value)">
            <option value="">All Work Locations</option>
            ${locations.map((l) => `<option value="${this.escape(l)}" ${state.location === l ? 'selected' : ''}>${this.escape(l)}</option>`).join('')}
          </select>

          <button class="btn btn-outline" onclick="app.refreshAdminDashboard()">↻ Refresh</button>
          <button class="btn btn-outline" onclick="app.exportDayReport()">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Export CSV
          </button>
        </div>

        <div class="dash-subtitle"><strong>${this.escape(prettyDate)}</strong> · <span>${this.escape(updatedText)}</span>${isFuture ? ' · <span style="color: #b45309;">Future date: absences are not counted yet</span>' : ''}${(!isFuture && rows.length > 0 && rows.every((x) => !x.rec)) ? ' · <span style="color: #b45309;">No attendance records for this day (not synced yet, or no work)</span>' : ''}</div>

        <div class="metrics-grid five">
          <div class="metric-card">
            <div class="metric-card-header"><span class="metric-title">Total Employees</span>
              <div class="metric-icon icon-blue"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg></div></div>
            <div class="metric-value">${total}</div>
          </div>
          <div class="metric-card">
            <div class="metric-card-header"><span class="metric-title">Present</span>
              <div class="metric-icon icon-green"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg></div></div>
            <div class="metric-value" style="color: var(--primary);">${present}</div>
          </div>
          <div class="metric-card">
            <div class="metric-card-header"><span class="metric-title">On Leave</span>
              <div class="metric-icon icon-amber"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/></svg></div></div>
            <div class="metric-value" style="color: #b45309;">${leave}</div>
          </div>
          <div class="metric-card">
            <div class="metric-card-header"><span class="metric-title">Absent</span>
              <div class="metric-icon icon-red"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></div></div>
            <div class="metric-value" style="color: var(--accent-red);">${isFuture ? '-' : absent}</div>
          </div>
          <div class="metric-card">
            <div class="metric-card-header"><span class="metric-title">Pending Upload</span>
              <div class="metric-icon icon-amber"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/></svg></div></div>
            <div class="metric-value">${pendingCount}</div>
          </div>
        </div>

        ${total === 0 ? `
          <div class="content-card" style="padding: 40px; text-align: center; color: var(--text-muted);">
            No active employees match the selected filters.
          </div>
        ` : `
        <div class="dash-grid">
          <div class="content-card">
            <div class="card-header"><h3 class="card-title">Attendance Overview</h3></div>
            <div class="card-body donut-wrap">
              ${this.donutSvg([
                { label: 'Present', value: present, color: '#16a34a' },
                { label: 'On Leave', value: leave, color: '#f59e0b' },
                { label: 'Absent', value: absent, color: '#ef4444' }
              ], isFuture ? present + leave : total, `${pct(present, total)}%`, 'Present')}
              <div class="legend">
                <div><i style="background: #16a34a;"></i> Present <strong>${present}</strong> <span>${pct(present, total)}%</span></div>
                <div><i style="background: #f59e0b;"></i> On Leave <strong>${leave}</strong> <span>${pct(leave, total)}%</span></div>
                <div><i style="background: #ef4444;"></i> Absent <strong>${isFuture ? '-' : absent}</strong> <span>${isFuture ? '' : pct(absent, total) + '%'}</span></div>
              </div>
            </div>
          </div>

          <div class="content-card">
            <div class="card-header"><h3 class="card-title">Attendance per Supervisor</h3>
              <span style="font-size: 12px; color: var(--text-muted);">${groupList.length} supervisor(s)</span></div>
            <div class="card-body" style="padding: 0;">
              <div class="table-responsive">
                <table class="data-table keep-table">
                  <thead>
                    <tr><th>Supervisor</th><th>Team</th><th>Present</th><th>Leave</th><th>Absent</th><th>Rate</th><th></th></tr>
                  </thead>
                  <tbody>
                    ${supRowsHtml}
                    <tr class="total-row">
                      <td><strong>TOTAL</strong></td>
                      <td><strong>${total}</strong></td>
                      <td><strong style="color: var(--primary);">${present}</strong></td>
                      <td><strong style="color: #b45309;">${leave}</strong></td>
                      <td><strong style="color: var(--accent-red);">${isFuture ? '-' : absent}</strong></td>
                      <td><div class="pct-cell"><span>${pct(present, total)}%</span><div class="bar"><i style="width: ${pct(present, total)}%;"></i></div></div></td>
                      <td></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        <div class="dash-grid dash-grid-even">
          <div class="content-card">
            <div class="card-header"><h3 class="card-title">Last 7 Days</h3>
              <span class="trend-legend"><i style="background:#16a34a"></i>Present <i style="background:#f59e0b"></i>Leave <i style="background:#fca5a5"></i>Absent</span></div>
            <div class="card-body">${this.trendSvg(trendDays)}</div>
          </div>

          <div class="content-card">
            <div class="card-header"><h3 class="card-title">Absent – Needs Follow-up</h3>
              <span class="status-pill ${absent > 0 && !isFuture ? 'badge-failed' : 'badge-synced'}">${isFuture ? 0 : absent}</span></div>
            <div class="card-body absent-scroll">
              ${isFuture || absentGroups.length === 0
                ? `<div style="text-align: center; color: var(--text-muted); padding: 24px;">🎉 No absent employees for this day.</div>`
                : absentGroups.map((g) => `
                  <div class="absent-group">
                    <div class="absent-group-title">${this.escape(g.name)} <span>(${g.items.length})</span></div>
                    ${g.items.map((x) => `
                      <div class="absent-row">
                        <span class="emp-id-badge">${this.escape(x.emp.employeeId)}</span>
                        <span class="absent-name">${this.escape(x.emp.employeeName)}</span>
                        <small>${this.escape(x.emp.workLocation || '')}</small>
                      </div>`).join('')}
                  </div>`).join('')}
            </div>
          </div>
        </div>
        `}
        <div id="cutoff-host"></div>
      </div>
    `;
    this.renderCutoffSection(document.getElementById('cutoff-host'), { compact: true });

    // Pull the newest data from Google Sheets when the dashboard is opened (at most once a minute)
    if (navigator.onLine && Date.now() - (this._lastAdminPull || 0) > 60000) {
      this._lastAdminPull = Date.now();
      syncService.pullRemoteData();
    }
  }

  adminDashSetDate(value) {
    if (!value) return;
    this.getAdminDashState().date = value;
    this.renderAdminDashboard(document.getElementById('view-content-root'));
  }

  adminDashShiftDate(days) {
    const st = this.getAdminDashState();
    this.adminDashSetDate(this.shiftDate(st.date, days));
  }

  adminDashSetFilter(key, value) {
    this.getAdminDashState()[key] = value;
    this.renderAdminDashboard(document.getElementById('view-content-root'));
  }

  async refreshAdminDashboard() {
    if (!navigator.onLine) {
      this.showToast('You are offline. Showing data saved on this device.', 'warning');
      return;
    }
    this.showToast('Refreshing from Google Sheets...', 'info');
    await syncService.pullRemoteData();
    this._lastAdminPull = Date.now();
    this.showToast('Dashboard updated.', 'success');
  }

  showSupervisorDetail(supervisorId) {
    const data = this.adminDashData;
    if (!data) return;
    const g = data.groups.find((x) => String(x.id) === String(supervisorId));
    if (!g) return;

    const section = (title, status, color) => {
      const list = g.items.filter((x) => x.status === status);
      return `
        <div class="detail-section">
          <div class="detail-title" style="color: ${color};">${title} (${list.length})</div>
          ${list.length === 0 ? '<div class="detail-empty">None</div>' : list.map((x) => `
            <div class="detail-row">
              <div><span class="emp-id-badge">${this.escape(x.emp.employeeId)}</span> <strong>${this.escape(x.emp.employeeName)}</strong>
                <div style="font-size: 11px; color: var(--text-muted);">${this.escape(x.emp.workLocation || '')}</div></div>
              <div class="detail-time">
                ${status === 'PRESENT' ? `${this.escape(x.rec.timeIn || '')}${x.rec.timeOut ? ' – ' + this.escape(x.rec.timeOut) : ''}` : ''}
                ${status === 'LEAVE' ? this.escape(x.rec.leaveType || 'Leave') : ''}
              </div>
            </div>`).join('')}
        </div>`;
    };

    document.getElementById('sup-detail-title').textContent = `${g.name} – ${data.date}`;
    document.getElementById('sup-detail-body').innerHTML =
      section('Present', 'PRESENT', '#15803d') +
      section('On Leave', 'LEAVE', '#b45309') +
      (data.isFuture ? '' : section('Absent', 'ABSENT', '#b91c1c'));
    this.openModal('sup-detail-modal');
  }

  exportDayReport() {
    const data = this.adminDashData;
    if (!data) return;
    const headers = ['Date', 'Supervisor', 'Employee ID', 'Employee Name', 'Work Location', 'Status', 'Leave Type', 'Leave Remarks', 'Time IN', 'Time OUT', 'Landowner Area'];
    const label = { PRESENT: 'Present', LEAVE: 'On Leave', ABSENT: 'Absent', NONE: '' };
    const lines = [];
    data.groups.forEach((g) => {
      g.items.forEach((x) => {
        lines.push([
          this.csvCell(data.date),
          this.csvCell(g.name),
          `="${String(x.emp.employeeId).replace(/"/g, '')}"`, // keeps leading zeros in Excel
          this.csvCell(x.emp.employeeName),
          this.csvCell(x.emp.workLocation || ''),
          this.csvCell(label[x.status]),
          this.csvCell(x.rec ? (x.rec.leaveType || '') : ''),
          this.csvCell(x.rec ? (x.rec.leaveRemarks || '') : ''),
          this.csvCell(x.rec && !this.isLeave(x.rec) ? (x.rec.timeIn || '') : ''),
          this.csvCell(x.rec && !this.isLeave(x.rec) ? (x.rec.timeOut || '') : ''),
          this.csvCell(x.rec && !this.isLeave(x.rec) ? (x.rec.landownerName || '') : '')
        ].join(','));
      });
    });
    if (lines.length === 0) {
      alert('Nothing to export for the selected filters.');
      return;
    }
    const csv = '\uFEFF' + [headers.map((h) => this.csvCell(h)).join(','), ...lines].join('\r\n');
    this.downloadText(csv, `Attendance_Day_Report_${data.date}.csv`);
  }

  /* ==========================================================================
     ON LEAVE (SUPERVISOR)
     ========================================================================== */
  async openLeaveModal(employeeId) {
    const emp = await db.get('employees', employeeId);
    if (!emp) return;
    this.leaveEmployeeId = employeeId;
    const today = this.todayStr();

    document.getElementById('leave-modal-emp').innerHTML = `
      <div style="font-weight: 700;">${this.escape(emp.employeeName)}</div>
      <div style="font-size: 12px; color: var(--text-muted);">ID: ${this.escape(emp.employeeId)} | Location: ${this.escape(emp.workLocation || 'None')}</div>`;
    document.getElementById('leave-type').selectedIndex = 0;
    document.getElementById('leave-from').value = today;
    document.getElementById('leave-to').value = '';
    document.getElementById('leave-remarks').value = '';
    this.openModal('leave-modal');
  }

  async saveLeave() {
    try {
      const emp = await db.get('employees', this.leaveEmployeeId);
      if (!emp) throw new Error('Employee not found.');

      const leaveType = document.getElementById('leave-type').value;
      const from = document.getElementById('leave-from').value;
      const to = document.getElementById('leave-to').value || from;
      const remarks = document.getElementById('leave-remarks').value.trim();

      if (!from) throw new Error('Please choose the leave start date.');
      if (to < from) throw new Error('"To Date" cannot be earlier than "From Date".');
      if (leaveType === 'Other' && !remarks) throw new Error('Please add a remark for "Other" leave.');

      const dates = [];
      for (let cur = from; cur <= to; cur = this.shiftDate(cur, 1)) {
        dates.push(cur);
        if (dates.length > 31) throw new Error('Leave can cover at most 31 days at a time.');
      }

      const allAtt = await db.getAll('attendance');
      const taken = new Set(
        allAtt
          .filter((a) => String(a.employeeId) === String(emp.employeeId) && a.recordStatus !== 'DELETED')
          .map((a) => this.ymd(a.attendanceDate))
      );

      const currentUser = auth.getCurrentUser() || {};
      const nowIso = new Date().toISOString();
      const skipped = [];
      let created = 0;

      for (const d of dates) {
        if (taken.has(d)) { skipped.push(d); continue; }
        await db.saveAttendance({
          attendanceRecordId: this.newRecordId('REC-LV'),
          employeeId: emp.employeeId,
          employeeName: emp.employeeName,
          supervisorId: emp.supervisorId || currentUser.linkedSupervisorId || '',
          supervisorName: emp.supervisorName || currentUser.name || '',
          landownerId: '',
          landownerName: '',
          locationId: emp.locationId || '',
          workLocation: emp.workLocation || '',
          attendanceDate: d,
          timeIn: '',
          timeOut: '',
          originalTimeIn: '',
          originalTimeOut: '',
          adjustedBy: '',
          adjustmentReason: '',
          actualGpsIn: '',
          actualGpsOut: '',
          deviceTimestamp: nowIso,
          synchronizationDate: '',
          recordStatus: 'ACTIVE',
          attendanceType: 'LEAVE',
          leaveType: leaveType,
          leaveRemarks: remarks
        });
        created++;
      }

      this.closeModal('leave-modal');

      if (created === 0) {
        this.showToast('No leave saved: the employee already has attendance on those date(s).', 'warning');
      } else {
        let msg = `${leaveType} saved for ${emp.employeeName} (${created} day${created > 1 ? 's' : ''}).`;
        if (skipped.length) msg += ` Skipped ${skipped.length} day(s) that already have a record.`;
        this.showToast(msg, 'success');
      }

      this.refreshCurrentView();
      if (navigator.onLine) syncService.autoSync();
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  }

  async cancelLeave(recordId) {
    if (!confirm('Cancel this leave entry? The employee will be able to Time IN again.')) return;
    try {
      const rec = await db.get('attendance', recordId);
      if (!rec) throw new Error('Leave record not found.');
      rec.recordStatus = 'DELETED';
      rec.deleteReason = `${rec.leaveType || 'Leave'} cancelled`;
      await db.saveAttendance(rec);

      const currentUser = auth.getCurrentUser() || {};
      await db.put('auditLogs', {
        logId: `LOG-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        userId: currentUser.userId || 'SYSTEM',
        userRole: currentUser.role || 'Supervisor',
        action: 'CANCEL_LEAVE',
        recordId: recordId,
        previousValue: 'ACTIVE',
        newValue: 'DELETED',
        reason: `${rec.leaveType || 'Leave'} cancelled`,
        dateTime: new Date().toISOString()
      });

      this.showToast('Leave cancelled.', 'success');
      this.refreshCurrentView();
      if (navigator.onLine) syncService.autoSync();
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  }

  /* ==========================================================================
     ATTENDANCE RECORDING VIEW (TIME IN & TIME OUT)
     ========================================================================== */
  async renderAttendanceRecording(container) {
    const isAdmin = auth.isAdmin();
    const supervisorId = auth.getLinkedSupervisorId();

    const [allEmployees, allAttendance, landowners, locations, allPhotos] = await Promise.all([
      db.getAll('employees'),
      db.getAll('attendance'),
      db.getAll('landowners'),
      db.getAll('locations'),
      db.getAll('photos')
    ]);
    const photosByRecord = {};
    allPhotos.forEach((p) => { (photosByRecord[p.recordId] = photosByRecord[p.recordId] || {})[p.kind] = p; });

    // Filter strictly by supervisor
    let employees = allEmployees.filter((e) => e.employmentStatus === 'Active');
    let myLandowners = landowners;
    let myLocations = locations;

    if (!isAdmin && supervisorId) {
      employees = employees.filter((e) => (e.supervisorId || '').toString() === supervisorId.toString());
      myLandowners = this.filterLandownersForSupervisor(landowners, locations, supervisorId);
      myLocations = locations.filter((loc) => (loc.supervisorId || '').toString() === supervisorId.toString());
    }

    const todayDate = this.todayStr();

    container.innerHTML = `
      <!-- Active Area Checking Banner for Supervisor -->
      <div class="content-card banner-card" style="background: linear-gradient(135deg, var(--primary), var(--primary-2)); color: #ffffff; padding: 16px 20px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-bottom: 20px;">
        <div style="display: flex; align-items: center; gap: 14px;">
          <div style="width: 44px; height: 44px; border-radius: 50%; background: rgba(255,255,255,0.2); display: flex; align-items: center; justify-content: center; font-size: 22px;">🌾</div>
          <div>
            <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.9;">Current Area Checking (Landowner)</div>
            <div style="font-size: 18px; font-weight: 700;" id="recording-active-landowner">${this.sessionLandowner ? this.escape(this.sessionLandowner.name) : 'No Landowner Selected'}</div>
            <div style="font-size: 12px; opacity: 0.9;">${this.sessionLandowner?.workLocation ? 'Location: ' + this.escape(this.sessionLandowner.workLocation) : 'Daily workers who Time IN will record this Landowner name'}</div>
          </div>
        </div>
        <button class="btn" style="background: #ffffff; color: var(--primary); font-weight: 700; font-size: 13px;" onclick="app.promptSelectSessionLandowner()">
          ✏️ Change Landowner Area
        </button>
      </div>

      <!-- Toolbar Filters -->
      <div class="toolbar">
        <div class="search-input-wrapper">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input type="text" id="att-search-input" class="search-input" placeholder="Search employee name or ID..." oninput="app.filterAttendanceList()" />
        </div>

        <select id="att-filter-location" class="select-filter" onchange="app.filterAttendanceList()">
          <option value="">All Work Locations</option>
          ${myLocations.map((loc) => `<option value="${this.escape(loc.workLocationName)}">${this.escape(loc.workLocationName)}</option>`).join('')}
        </select>

        <button class="btn btn-outline" onclick="app.refreshGpsManual()">
          📍 Refresh GPS
        </button>
      </div>

      <!-- Attendance List Container -->
      <div id="attendance-cards-container">
        <!-- Rendered dynamically -->
      </div>
    `;

    this.cachedRecordingData = { employees, allAttendance, todayDate, photosByRecord };
    this.filterAttendanceList();
  }

  async filterAttendanceList() {
    const container = document.getElementById('attendance-cards-container');
    if (!container || !this.cachedRecordingData) return;

    const query = (document.getElementById('att-search-input')?.value || '').toLowerCase().trim();
    const selectedLocation = document.getElementById('att-filter-location')?.value || '';

    const { employees, allAttendance, todayDate, photosByRecord } = this.cachedRecordingData;

    const filtered = employees.filter((emp) => {
      const matchQuery = emp.employeeName.toLowerCase().includes(query) || emp.employeeId.toLowerCase().includes(query);
      const matchLocation = !selectedLocation || (emp.workLocation || '') === selectedLocation;
      return matchQuery && matchLocation;
    });

    if (filtered.length === 0) {
      container.innerHTML = `
        <div class="content-card" style="padding: 40px; text-align: center; color: var(--text-muted);">
          No assigned employees found matching the filters.
        </div>
      `;
      return;
    }

    container.innerHTML = filtered.map((emp) => {
      // Find today's active attendance record for this employee
      const todayRec = allAttendance.find(
        (a) => String(a.employeeId) === String(emp.employeeId) && this.ymd(a.attendanceDate) === todayDate && a.recordStatus !== 'DELETED'
      );

      const isLeave = this.isLeave(todayRec);
      const hasTimeIn = todayRec && !isLeave && !!todayRec.timeIn;
      const hasTimeOut = todayRec && !!todayRec.timeOut;
      const syncStatus = todayRec ? todayRec.syncStatus : null;

      let statusPill = `<span class="status-pill status-offline">Not Recorded</span>`;
      if (isLeave) {
        statusPill = `<span class="status-pill badge-leave">On Leave</span>`;
      } else if (hasTimeIn && !hasTimeOut) {
        statusPill = `<span class="status-pill status-online">Clocked IN</span>`;
      } else if (hasTimeIn && hasTimeOut) {
        statusPill = `<span class="status-pill" style="background: #e0f2fe; color: #0369a1;">Clocked OUT</span>`;
      }

      return `
        <div class="emp-attendance-card">
          <div class="emp-card-header">
            <div style="display:flex; gap:12px; align-items:flex-start; min-width:0;">
              ${this.employeeAvatar(emp, 52, { markMissing: true, onclick: `app.openProfilePhotoModal('EMPLOYEE', '${this.escape(emp.employeeId)}', '${this.escape(emp.employeeName).replace(/&#39;/g, '')}')` })}
              <div style="min-width:0;">
              <span class="emp-id-badge">${this.escape(emp.employeeId)}</span>
              <div class="emp-name">${this.escape(emp.employeeName)}</div>
              <div class="emp-location-info">
                <span>📍 Location: <strong>${this.escape(emp.workLocation || 'Unassigned')}</strong></span>
                <span>🌾 Landowner Area: <strong>${this.escape(todayRec?.landownerName || (this.sessionLandowner ? this.sessionLandowner.name : 'Pending Time IN'))}</strong></span>
                <span>👤 Supervisor: ${this.escape(emp.supervisorName || 'Unassigned')}</span>
              </div>
              </div>
            </div>
            <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 6px;">
              ${statusPill}
              ${syncStatus ? `<span class="status-pill badge-${syncStatus.toLowerCase()}">${syncStatus}</span>` : ''}
            </div>
          </div>

          ${isLeave ? `
            <div class="leave-info">
              <strong>🏖 ${this.escape(todayRec.leaveType || 'On Leave')}</strong>
              ${todayRec.leaveRemarks ? `<div>${this.escape(todayRec.leaveRemarks)}</div>` : ''}
            </div>
          ` : ''}

          <!-- Times Display -->
          <div class="emp-time-status" ${isLeave ? 'style="display: none;"' : ''}>
            <div>
              <span style="font-size: 11px; color: var(--text-muted); display: block;">TIME IN</span>
              <strong style="color: var(--primary); font-size: 14px;">${todayRec?.timeIn || '--:--'}</strong>
              ${todayRec?.originalTimeIn && todayRec.originalTimeIn !== todayRec.timeIn ? `<small style="display:block; font-size:10px; color: var(--accent-amber);">(Adj from ${todayRec.originalTimeIn})</small>` : ''}
            </div>
            <div style="text-align: right;">
              <span style="font-size: 11px; color: var(--text-muted); display: block;">TIME OUT</span>
              <strong style="color: #0284c7; font-size: 14px;">${todayRec?.timeOut || '--:--'}</strong>
              ${todayRec?.originalTimeOut && todayRec.originalTimeOut !== todayRec.timeOut ? `<small style="display:block; font-size:10px; color: var(--accent-amber);">(Adj from ${todayRec.originalTimeOut})</small>` : ''}
            </div>
          </div>

          ${todayRec?.actualGpsIn ? `
            <div style="font-size: 11px; color: var(--text-muted); background: var(--bg-page); padding: 4px 8px; border-radius: 4px;">
              Actual GPS: ${this.escape(todayRec.actualGpsIn)}
            </div>
          ` : ''}

          ${todayRec && !isLeave ? (() => {
            const ph = photosByRecord[todayRec.attendanceRecordId] || {};
            const thumbs = ['IN', 'OUT'].filter((k) => ph[k]).map((k) =>
              `<img src="${ph[k].thumbUrl}" alt="${k} photo" title="Time ${k} photo" onclick="app.viewPhoto('${todayRec.attendanceRecordId}', '${k}')" />`).join('');
            const flags = this.renderFlags(todayRec);
            return (thumbs || flags) ? `<div style="display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap;">
              <div class="photo-thumbs">${thumbs}</div><div>${flags}</div></div>` : '';
          })() : ''}
          ${todayRec?.syncError ? `<div class="sync-error-text">Upload problem: ${this.escape(todayRec.syncError)}</div>` : ''}

          <!-- Large Action Buttons -->
          <div class="emp-actions">
            ${isLeave ? `
              <button class="btn btn-danger" style="flex: 1;" onclick="app.cancelLeave('${todayRec.attendanceRecordId}')">
                ✕ Cancel Leave
              </button>
            ` : !hasTimeIn ? `
              <button class="btn btn-time-in" style="flex: 1;" onclick="app.recordTimeIn('${emp.employeeId}')">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                TIME IN
              </button>
            ` : !hasTimeOut ? `
              <button class="btn btn-time-out" style="flex: 1;" onclick="app.recordTimeOut('${todayRec.attendanceRecordId}')">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                TIME OUT
              </button>
            ` : `
              <div style="flex: 1; padding: 10px; text-align: center; background: #f0fdf4; color: #166534; font-weight: 600; border-radius: 8px; font-size: 13px;">
                ✓ Completed Today
              </div>
            `}

            <!-- Adjustment Button -->
            ${isLeave ? '' : `
            <button class="btn btn-outline" title="Adjust date/time with audit trail" onclick="app.openAdjustmentModal('${emp.employeeId}', '${todayRec ? todayRec.attendanceRecordId : ''}')">
              ⚙ Adjust
            </button>`}
          </div>

          ${(!hasTimeIn && !isLeave) ? `
            <button class="btn btn-leave" onclick="app.openLeaveModal('${emp.employeeId}')">
              🏖 Mark On Leave
            </button>
          ` : ''}
        </div>
      `;
    }).join('');
  }

  // Refresh GPS Coordinates manually
  async refreshGpsManual() {
    this.showToast('Acquiring high-accuracy GPS coordinates...', 'info');
    await this.initGpsTracking();
    this.showToast(this.activeGps.coords ? `GPS Acquired: ${this.activeGps.coords}` : 'GPS not available.', this.activeGps.coords ? 'success' : 'warning');
  }

  updateActiveGpsFromPos(pos) {
    if (pos && !pos.error) {
      this.activeGps = { coords: `${pos.lat.toFixed(6)}, ${pos.lng.toFixed(6)}`, accuracy: pos.acc, status: 'Acquired' };
    } else {
      this.activeGps = { coords: '', accuracy: null, status: pos && pos.error === 'PERMISSION_DENIED' ? 'Permission Denied' : 'No signal' };
    }
    this.renderGpsPill();
  }

  /**
   * Shared by Time IN and Time OUT: fresh GPS -> geofence rule -> camera + watermark.
   * Returns { pos, gf, photo, takenAt, skipped } or null if the user cancelled / it was blocked.
   */
  async capturePunch(kind, { emp, recordId, landowner, workLocation, locationId }) {
    const settings = await auth.getAppSettings();
    const currentUser = auth.getCurrentUser() || {};
    const label = kind === 'OUT' ? 'Time OUT' : 'Time IN';

    this.showToast('Getting a fresh GPS location...', 'info');
    const pos = await geo.getFreshPosition(15000);
    this.updateActiveGpsFromPos(pos);

    const loc = await this.findLocation(locationId, workLocation);
    const gf = geo.check(pos, loc, settings);
    const mode = settings.geofenceMode;

    if (mode === 'block') {
      if (gf.status === 'OUTSIDE') {
        throw new Error(`${label} blocked: you are ${gf.distance} m from ${loc.workLocationName} (allowed ${gf.radius} m). Move closer to the work area and try again.`);
      }
      if (gf.status === 'NO_GPS') {
        throw new Error(`${label} blocked: GPS is required. Turn on Location (high accuracy) and try again.`);
      }
    } else if (mode === 'warn') {
      if (gf.status === 'OUTSIDE' && !confirm(`Warning: you are ${gf.distance} m away from ${loc.workLocationName} (allowed ${gf.radius} m).\n\nRecord ${label} anyway? It will be flagged for the admin.`)) return null;
      if (gf.status === 'NO_GPS' && !confirm(`No GPS signal.\n\nRecord ${label} without location? It will be flagged for the admin.`)) return null;
    }

    let photo = null;
    let takenAt = new Date();
    let skipped = false;
    if (settings.photoMode !== 'off') {
      const res = await camera.capture({
        kind,
        employeeName: emp.employeeName,
        employeeId: emp.employeeId,
        employeePhoto: this.getAvatar('EMPLOYEE', emp.employeeId),
        landowner,
        workLocation,
        gpsText: geo.format(pos),
        geofenceText: mode !== 'off' ? this.geofenceLabel(gf.status, gf.distance, gf.radius) : '',
        supervisor: currentUser.name || currentUser.username || '',
        recordId,
        allowSkip: settings.photoMode === 'optional'
      });
      if (!res) {
        this.showToast(`${label} cancelled. Nothing was saved.`, 'warning');
        return null;
      }
      if (res.skipped) skipped = true;
      else { photo = res; takenAt = res.takenAt; }
    }

    const geoStatus = gf.status === 'INSIDE' || gf.status === 'OUTSIDE'
      ? gf.status + (gf.lowAccuracy ? '_LOW_ACCURACY' : '')
      : gf.status;
    return { pos, gf, geoStatus, photo, takenAt, skipped };
  }

  async savePunchPhoto(recordId, kind, photo) {
    if (!photo) return;
    await db.put('photos', {
      photoId: `${recordId}-${kind}`,
      recordId,
      kind,
      dataUrl: photo.dataUrl,
      thumbUrl: photo.thumbUrl,
      source: photo.source || 'camera',
      takenAt: photo.takenAt.toISOString(),
      syncStatus: 'PENDING',
      error: ''
    });
  }

  afterPunchSaved() {
    this.renderAttendanceRecording(document.getElementById('view-content-root'));
    this.updateSyncBadge();
    syncService.requestBackgroundSync();
    if (navigator.onLine) syncService.autoSync();
  }

  // Record Time IN (fresh GPS + geofence + watermarked photo)
  async recordTimeIn(employeeId) {
    if (this._punchBusy) return;
    this._punchBusy = true;
    try {
      if (!this.sessionLandowner || !this.sessionLandowner.name) {
        this.promptSelectSessionLandowner();
        this.showToast('Please select the Landowner area you are checking before recording Time IN.', 'warning');
        return;
      }

      const emp = await db.get('employees', employeeId);
      if (!emp) throw new Error('Employee not found');

      const findToday = async () => (await db.getAll('attendance')).find(
        (a) => String(a.employeeId) === String(employeeId) && this.ymd(a.attendanceDate) === this.todayStr() && a.recordStatus !== 'DELETED'
      );
      let existing = await findToday();
      if (existing && this.isLeave(existing)) throw new Error('This employee is marked On Leave today. Cancel the leave first to record Time IN.');
      if (existing && existing.timeIn) throw new Error('Employee already has a Time IN record for today.');

      const recordId = this.newRecordId();
      const sl = this.sessionLandowner;
      const locationId = sl.locationId || emp.locationId || '';
      const workLocation = sl.workLocation || emp.workLocation || '';

      const punch = await this.capturePunch('IN', { emp, recordId, landowner: sl.name, workLocation, locationId });
      if (!punch) return;

      // Check again (the camera screen may have been open for a while)
      existing = await findToday();
      if (existing && (existing.timeIn || this.isLeave(existing))) throw new Error('Another Time IN or leave was saved for this employee meanwhile.');

      const currentUser = auth.getCurrentUser() || {};
      const timeStr = this.fmtTime(punch.takenAt);
      const record = {
        attendanceRecordId: recordId,
        employeeId: emp.employeeId,
        employeeName: emp.employeeName,
        supervisorId: emp.supervisorId || currentUser.linkedSupervisorId || '',
        supervisorName: emp.supervisorName || currentUser.name || '',
        landownerId: sl.id || '',
        landownerName: sl.name || '',
        locationId,
        workLocation,
        attendanceDate: this.fmtLocalDate(punch.takenAt),
        timeIn: timeStr,
        timeOut: '',
        originalTimeIn: timeStr,
        originalTimeOut: '',
        adjustedBy: '',
        adjustmentReason: '',
        actualGpsIn: geo.format(punch.pos),
        actualGpsOut: '',
        deviceTimestamp: punch.takenAt.toISOString(),
        synchronizationDate: '',
        recordStatus: 'ACTIVE',
        attendanceType: 'PRESENT',
        photoIn: '',
        photoOut: '',
        distanceInMeters: punch.gf.distance === null ? '' : punch.gf.distance,
        geofenceIn: punch.geoStatus,
        clockFlag: await this.getClockFlags(punch.takenAt),
        photoInSkipped: punch.skipped
      };

      await db.saveAttendance(record);
      await this.savePunchPhoto(recordId, 'IN', punch.photo);

      this.showToast(`Time IN ${timeStr} saved for ${emp.employeeName}${punch.photo ? ' with photo' : ''}. (Pending upload)`, 'success');
      this.afterPunchSaved();
    } catch (err) {
      this.showToast(err.message, 'error');
    } finally {
      this._punchBusy = false;
    }
  }

  // Record Time OUT (fresh GPS + geofence + watermarked photo)
  async recordTimeOut(attendanceRecordId) {
    if (this._punchBusy) return;
    this._punchBusy = true;
    try {
      let record = await db.get('attendance', attendanceRecordId);
      if (!record) throw new Error('Attendance record not found');
      if (record.timeOut) throw new Error('Time OUT already recorded for this employee.');
      const emp = (await db.get('employees', record.employeeId)) || { employeeId: record.employeeId, employeeName: record.employeeName };

      const punch = await this.capturePunch('OUT', {
        emp,
        recordId: attendanceRecordId,
        landowner: record.landownerName,
        workLocation: record.workLocation,
        locationId: record.locationId
      });
      if (!punch) return;

      // Re-read: a sync may have updated the record while the camera was open
      record = await db.get('attendance', attendanceRecordId);
      if (record.timeOut) throw new Error('Time OUT was already saved meanwhile.');

      const settings = await auth.getAppSettings();
      const timeStr = this.fmtTime(punch.takenAt);
      record.timeOut = timeStr;
      record.originalTimeOut = timeStr;
      record.actualGpsOut = geo.format(punch.pos);
      record.deviceTimestampOut = punch.takenAt.toISOString();
      record.distanceOutMeters = punch.gf.distance === null ? '' : punch.gf.distance;
      record.geofenceOut = punch.geoStatus;
      record.photoOutSkipped = punch.skipped;
      const flags = await this.getClockFlags(punch.takenAt);
      if (flags) record.clockFlag = [record.clockFlag, flags].filter(Boolean).join(',');
      const hrs = this.computeHours(record.timeIn, record.timeOut, settings);
      record.hoursWorked = hrs.hours;
      record.overtimeHours = hrs.overtime;

      await db.saveAttendance(record);
      await this.savePunchPhoto(attendanceRecordId, 'OUT', punch.photo);

      this.showToast(`Time OUT ${timeStr} saved for ${record.employeeName}${hrs.hours !== '' ? ` (${hrs.hours} h)` : ''}.`, 'success');
      this.afterPunchSaved();
    } catch (err) {
      this.showToast(err.message, 'error');
    } finally {
      this._punchBusy = false;
    }
  }

  // Adjustment Modal for Manual Attendance Adjustments
  async openAdjustmentModal(employeeId, existingRecordId) {
    const emp = await db.get('employees', employeeId);
    if (!emp) { this.showToast('Employee not found on this phone.', 'error'); return; }
    let record = null;
    if (existingRecordId) record = await db.get('attendance', existingRecordId);

    const todayDate = this.todayStr();
    const allowedLnd = await this.getAllowedLandowners();
    const curLndId = record ? String(record.landownerId || '') : (this.sessionLandowner ? String(this.sessionLandowner.id || '') : '');
    const curLndName = record ? (record.landownerName || '') : (this.sessionLandowner ? this.sessionLandowner.name : '');
    const options = allowedLnd.map((l) => ({ id: String(l.landownerId), name: l.landownerName, locationId: l.locationId || '', workLocation: l.workLocation || '' }));
    if (curLndName && !options.some((o) => o.id === curLndId || o.name === curLndName)) {
      options.unshift({ id: curLndId, name: curLndName, locationId: record ? record.locationId : '', workLocation: record ? record.workLocation : '' });
    }
    const lndOptions = `<option value="">-- None --</option>` + options.map((o, i) =>
      `<option value="${i}" ${(o.id && o.id === curLndId) || o.name === curLndName ? 'selected' : ''}>${this.escape(o.name)}${o.workLocation ? ' (' + this.escape(o.workLocation) + ')' : ''}</option>`).join('');

    const modalBody = document.getElementById('adjustment-modal-body');
    if (!modalBody) return;

    modalBody.innerHTML = `
      <form id="adjustment-form" onsubmit="return false;">
        <div style="background: var(--bg-page); padding: 12px; border-radius: var(--radius-sm); margin-bottom: 16px;">
          <div style="font-weight: 700; color: var(--text-main);">${this.escape(emp.employeeName)}</div>
          <div style="font-size: 12px; color: var(--text-muted);">ID: ${this.escape(emp.employeeId)} | Location: ${this.escape(emp.workLocation || 'None')}</div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label class="form-label required">Attendance Date</label>
            <input type="date" id="adj-date" class="form-control" max="${todayDate}" value="${this.escape(record ? record.attendanceDate : todayDate)}" required />
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Time IN</label>
            <input type="text" id="adj-time-in" class="form-control" placeholder="e.g. 07:30 AM" value="${this.escape(record ? (record.timeIn || '') : '')}" />
            <div class="form-helper">hh:mm AM/PM or 24h (e.g. 07:30 AM or 16:30)</div>
          </div>
          <div class="form-group">
            <label class="form-label">Time OUT</label>
            <input type="text" id="adj-time-out" class="form-control" placeholder="e.g. 04:30 PM" value="${this.escape(record ? (record.timeOut || '') : '')}" />
            <div class="form-helper" id="adj-hours-preview">&nbsp;</div>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">🌾 Area Checking Landowner</label>
          <select id="adj-landowner" class="form-control">${lndOptions}</select>
          <div class="form-helper">Landowner where area checking was conducted.</div>
        </div>

        <div class="form-group">
          <label class="form-label required">Reason for Adjustment</label>
          <textarea id="adj-reason" class="form-control" rows="2" placeholder="Explain why the time was adjusted (required for the audit log)" required>${this.escape(record?.adjustmentReason || '')}</textarea>
        </div>

        <div id="adj-error" class="alert-banner bad" style="display:none"></div>
        <div style="font-size: 11px; color: var(--text-muted);">
          * The original device times are kept, and your name and reason are written to the audit log.
          Manual entries have no photo, so they are marked "Adjusted" for the admin.
        </div>
      </form>
    `;

    const settings = await auth.getAppSettings();
    const preview = () => {
      const tin = this.normalizeTime(document.getElementById('adj-time-in').value);
      const tout = this.normalizeTime(document.getElementById('adj-time-out').value);
      const h = this.computeHours(tin, tout, settings);
      document.getElementById('adj-hours-preview').textContent = h.hours !== '' ? `Hours worked: ${h.hours} h${h.overtime ? ` (OT ${h.overtime} h)` : ''}` : ' ';
    };
    document.getElementById('adj-time-in').addEventListener('input', preview);
    document.getElementById('adj-time-out').addEventListener('input', preview);
    preview();

    document.getElementById('save-adjustment-btn').onclick = async () => {
      const errBox = document.getElementById('adj-error');
      const showErr = (m) => { errBox.textContent = m; errBox.style.display = 'block'; };
      errBox.style.display = 'none';

      const adjDate = document.getElementById('adj-date').value;
      const rawIn = document.getElementById('adj-time-in').value.trim();
      const rawOut = document.getElementById('adj-time-out').value.trim();
      const adjReason = document.getElementById('adj-reason').value.trim();
      const sel = document.getElementById('adj-landowner').value;
      const lnd = sel === '' ? null : options[Number(sel)];

      if (!adjDate) return showErr('Please choose an attendance date.');
      if (adjDate > todayDate) return showErr('The date cannot be in the future.');
      const adjTimeIn = rawIn ? this.normalizeTime(rawIn) : '';
      const adjTimeOut = rawOut ? this.normalizeTime(rawOut) : '';
      if (rawIn && !adjTimeIn) return showErr('Time IN is not valid. Use hh:mm AM/PM, e.g. 07:30 AM.');
      if (rawOut && !adjTimeOut) return showErr('Time OUT is not valid. Use hh:mm AM/PM, e.g. 04:30 PM.');
      if (!adjTimeIn && !(record && record.timeIn)) return showErr('Time IN is required.');
      if (adjTimeOut && !adjTimeIn && !(record && record.timeIn)) return showErr('Enter Time IN before Time OUT.');
      if (adjReason.length < 5) return showErr('Please write a clear reason (at least 5 characters).');

      // One record per employee per day
      const all = await db.getAll('attendance');
      const clash = all.find((a) => String(a.employeeId) === String(emp.employeeId) && this.ymd(a.attendanceDate) === adjDate &&
        a.recordStatus !== 'DELETED' && (!record || a.attendanceRecordId !== record.attendanceRecordId));
      if (clash) return showErr(`${emp.employeeName} already has a ${this.isLeave(clash) ? 'leave' : 'attendance'} record on ${adjDate}. Adjust that record instead.`);

      const currentUser = auth.getCurrentUser() || {};
      const editor = currentUser.name || currentUser.username || 'Supervisor';

      if (record) {
        if (!record.originalTimeIn && record.timeIn) record.originalTimeIn = record.timeIn;
        if (!record.originalTimeOut && record.timeOut) record.originalTimeOut = record.timeOut;
        record.attendanceDate = adjDate;
        if (adjTimeIn) record.timeIn = adjTimeIn;
        if (adjTimeOut) record.timeOut = adjTimeOut;
        if (lnd) {
          record.landownerId = lnd.id;
          record.landownerName = lnd.name;
          if (lnd.locationId) record.locationId = lnd.locationId;
          if (lnd.workLocation) record.workLocation = lnd.workLocation;
        }
        record.adjustedBy = editor;
        record.adjustmentReason = adjReason;
      } else {
        const sl = this.sessionLandowner || {};
        record = {
          attendanceRecordId: this.newRecordId(),
          employeeId: emp.employeeId,
          employeeName: emp.employeeName,
          supervisorId: emp.supervisorId || currentUser.linkedSupervisorId || '',
          supervisorName: emp.supervisorName || currentUser.name || '',
          landownerId: lnd ? lnd.id : (sl.id || ''),
          landownerName: lnd ? lnd.name : (sl.name || ''),
          locationId: (lnd && lnd.locationId) || sl.locationId || emp.locationId || '',
          workLocation: (lnd && lnd.workLocation) || sl.workLocation || emp.workLocation || '',
          attendanceDate: adjDate,
          timeIn: adjTimeIn,
          timeOut: adjTimeOut,
          originalTimeIn: '',
          originalTimeOut: '',
          adjustedBy: editor,
          adjustmentReason: adjReason,
          actualGpsIn: this.activeGps.coords ? `${this.activeGps.coords} (±${this.activeGps.accuracy}m)` : 'GPS Unavailable',
          actualGpsOut: '',
          deviceTimestamp: new Date().toISOString(),
          synchronizationDate: '',
          recordStatus: 'ACTIVE',
          attendanceType: 'PRESENT',
          photoIn: '',
          photoOut: ''
        };
      }
      const h = this.computeHours(record.timeIn, record.timeOut, settings);
      record.hoursWorked = h.hours;
      record.overtimeHours = h.overtime;
      await db.saveAttendance(record);

      this.closeModal('adjustment-modal');
      this.showToast('Attendance adjustment saved.', 'success');
      this.refreshCurrentView();
      this.updateSyncBadge();
      if (navigator.onLine) syncService.autoSync();
    };

    this.openModal('adjustment-modal');
  }

  /* ==========================================================================
     ATTENDANCE HISTORY VIEW & EXPORT
     ========================================================================== */
  async renderHistory(container) {
    const isAdmin = auth.isAdmin();
    const supervisorId = auth.getLinkedSupervisorId();

    const [allAttendance, allEmployees, landowners, locations, supervisors] = await Promise.all([
      db.getAll('attendance'),
      db.getAll('employees'),
      db.getAll('landowners'),
      db.getAll('locations'),
      db.getAll('supervisors')
    ]);

    let records = allAttendance.filter((r) => r.recordStatus !== 'DELETED');
    if (!isAdmin && supervisorId) {
      records = records.filter((r) => (r.supervisorId || '').toString() === supervisorId.toString());
    }

    // Sort newest date first
    records.sort((a, b) => (b.attendanceDate > a.attendanceDate ? 1 : -1));

    // Landowner filter list: admin sees all; a supervisor only sees landowners of their own location(s)
    // (plus any landowner already stamped on their own past records)
    const historyLandownerNames = new Set();
    if (isAdmin) {
      landowners.forEach((l) => historyLandownerNames.add(l.landownerName));
    } else {
      this.filterLandownersForSupervisor(landowners, locations, supervisorId).forEach((l) => historyLandownerNames.add(l.landownerName));
      records.forEach((r) => { if (r.landownerName) historyLandownerNames.add(r.landownerName); });
    }

    container.innerHTML = `
      <!-- History Toolbar -->
      <div class="toolbar">
        <div class="search-input-wrapper">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input type="text" id="hist-search-input" class="search-input" placeholder="Search employee or record ID..." oninput="app.filterHistoryTable()" />
        </div>

        <input type="date" id="hist-date-filter" class="select-filter" onchange="app.filterHistoryTable()" title="Filter by date" />

        <select id="hist-landowner-filter" class="select-filter" onchange="app.filterHistoryTable()">
          <option value="">All Landowners</option>
          ${[...historyLandownerNames].sort().map((n) => `<option value="${this.escape(n)}">${this.escape(n)}</option>`).join('')}
        </select>

        <select id="hist-location-filter" class="select-filter" onchange="app.filterHistoryTable()">
          <option value="">All Locations</option>
          ${locations.map((loc) => `<option value="${this.escape(loc.workLocationName)}">${this.escape(loc.workLocationName)}</option>`).join('')}
        </select>

        <select id="hist-type-filter" class="select-filter" onchange="app.filterHistoryTable()">
          <option value="">All Types</option>
          <option value="PRESENT">Present</option>
          <option value="LEAVE">On Leave</option>
        </select>

        <select id="hist-sync-filter" class="select-filter" onchange="app.filterHistoryTable()">
          <option value="">All Sync Statuses</option>
          <option value="SYNCED">SYNCED</option>
          <option value="PENDING">PENDING</option>
          <option value="FAILED">FAILED</option>
        </select>

        <button class="btn btn-outline" onclick="app.exportHistoryCsv()">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Export CSV
        </button>
      </div>

      <!-- History Data Table -->
      <div class="content-card">
        <div class="card-header">
          <h3 class="card-title">Attendance Log Records</h3>
          <span id="hist-count-badge" class="status-pill status-online">${records.length} Records</span>
        </div>
        <div class="card-body" style="padding: 0;">
          <div class="table-responsive">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Record ID</th>
                  <th>Date</th>
                  <th>Employee ID</th>
                  <th>Employee Name</th>
                  <th>Location</th>
                  <th>Landowner</th>
                  ${isAdmin ? '<th>Supervisor</th>' : ''}
                  <th>Time IN</th>
                  <th>Time OUT</th>
                  <th>Hours</th>
                  <th>Photos</th>
                  <th>Checks</th>
                  <th>Sync Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody id="history-table-body">
                <!-- Rendered dynamically -->
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;

    const photos = await db.getAll('photos');
    const photosByRecord = {};
    photos.forEach((p) => { (photosByRecord[p.recordId] = photosByRecord[p.recordId] || {})[p.kind] = p; });
    this.cachedHistoryData = { records, isAdmin, photosByRecord };
    this.filterHistoryTable();
  }

  filterHistoryTable() {
    const tbody = document.getElementById('history-table-body');
    const countBadge = document.getElementById('hist-count-badge');
    if (!tbody || !this.cachedHistoryData) return;

    const query = (document.getElementById('hist-search-input')?.value || '').toLowerCase().trim();
    const dateVal = document.getElementById('hist-date-filter')?.value || '';
    const lndVal = document.getElementById('hist-landowner-filter')?.value || '';
    const locVal = document.getElementById('hist-location-filter')?.value || '';
    const syncVal = document.getElementById('hist-sync-filter')?.value || '';
    const typeVal = document.getElementById('hist-type-filter')?.value || '';

    const { records, isAdmin, photosByRecord } = this.cachedHistoryData;

    const filtered = records.filter((r) => {
      const matchQuery = r.employeeName.toLowerCase().includes(query) ||
                         r.employeeId.toLowerCase().includes(query) ||
                         r.attendanceRecordId.toLowerCase().includes(query);
      const matchDate = !dateVal || this.ymd(r.attendanceDate) === dateVal;
      const matchType = !typeVal || (typeVal === 'LEAVE' ? this.isLeave(r) : !this.isLeave(r));
      const matchLnd = !lndVal || (r.landownerName || '') === lndVal;
      const matchLoc = !locVal || (r.workLocation || '') === locVal;
      const matchSync = !syncVal || r.syncStatus === syncVal;
      return matchQuery && matchDate && matchType && matchLnd && matchLoc && matchSync;
    });

    if (countBadge) countBadge.textContent = `${filtered.length} Records`;

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="${isAdmin ? 14 : 13}" style="text-align: center; padding: 32px; color: var(--text-muted);">No records found matching filters.</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map((r) => `
      <tr>
        <td><small style="font-family: monospace;">${this.escape(r.attendanceRecordId)}</small></td>
        <td><strong>${this.escape(r.attendanceDate)}</strong></td>
        <td><span class="emp-id-badge">${this.escape(r.employeeId)}</span></td>
        <td><span class="name-with-avatar">${this.avatarHtml('EMPLOYEE', r.employeeId, r.employeeName, 28)}<strong>${this.escape(r.employeeName)}</strong></span></td>
        <td>${this.escape(r.workLocation || '-')}</td>
        <td>${this.escape(r.landownerName || '-')}</td>
        ${isAdmin ? `<td>${this.escape(r.supervisorName || '-')}</td>` : ''}
        <td>${this.isLeave(r) ? `<span class="status-pill badge-leave">On Leave${r.leaveType ? ' – ' + this.escape(r.leaveType) : ''}</span>` : `<span style="color: var(--primary); font-weight: 600;">${this.escape(r.timeIn || '-')}</span>`}</td>
        <td><span style="color: #0284c7; font-weight: 600;">${this.escape(r.timeOut || '-')}</span></td>
        <td>${r.hoursWorked !== undefined && r.hoursWorked !== '' ? `<strong>${this.escape(r.hoursWorked)}</strong>${Number(r.overtimeHours) > 0 ? `<small style="display:block;color:#b45309;">OT ${this.escape(r.overtimeHours)}</small>` : ''}` : '-'}</td>
        <td>${(() => {
          const ph = (photosByRecord || {})[r.attendanceRecordId] || {};
          const parts = ['IN', 'OUT'].map((k) => {
            if (ph[k] && ph[k].thumbUrl) return `<img src="${ph[k].thumbUrl}" alt="${k}" title="Time ${k} photo" onclick="app.viewPhoto('${r.attendanceRecordId}', '${k}')" />`;
            if (r[k === 'IN' ? 'photoIn' : 'photoOut']) return `<button class="btn btn-outline" style="padding:2px 6px;font-size:10px;" onclick="app.viewPhoto('${r.attendanceRecordId}', '${k}')">${k} 📷</button>`;
            return '';
          }).join('');
          return parts ? `<div class="photo-thumbs">${parts}</div>` : '<small style="color:var(--text-light)">-</small>';
        })()}</td>
        <td>${this.renderFlags(r) || '<small style="color:var(--text-light)">-</small>'}</td>
        <td><span class="status-pill badge-${(r.syncStatus || 'PENDING').toLowerCase()}">${r.syncStatus}</span>${r.syncError ? `<div class="sync-error-text">${this.escape(r.syncError)}</div>` : ''}</td>
        <td>
          <button class="btn btn-outline" style="padding: 4px 8px; font-size: 11px;" onclick="app.viewRecordDetails('${r.attendanceRecordId}')">
            Details
          </button>
          <button class="btn btn-danger" style="padding: 4px 8px; font-size: 11px;" onclick="app.confirmSoftDelete('${r.attendanceRecordId}')">
            Delete
          </button>
        </td>
      </tr>
    `).join('');
  }

  // View Detailed Modal with Audit trail & GPS
  async viewRecordDetails(recordId) {
    const rec = await db.get('attendance', recordId);
    if (!rec) return;

    const modal = document.getElementById('details-modal');
    const modalBody = document.getElementById('details-modal-body');
    if (!modal || !modalBody) return;

    modalBody.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 12px; font-size: 13px;">
        <div style="background: var(--bg-page); padding: 12px; border-radius: var(--radius-sm);">
          <div>Record ID: <strong style="font-family: monospace;">${this.escape(rec.attendanceRecordId)}</strong></div>
          <div style="display:flex;align-items:center;gap:10px;margin:4px 0;">${this.avatarHtml('EMPLOYEE', rec.employeeId, rec.employeeName, 48, { onclick: this.getAvatar('EMPLOYEE', rec.employeeId) ? `app.openImage(app.getAvatar('EMPLOYEE', '${this.escape(rec.employeeId)}'))` : '' })}
            <div>Employee: <strong>${this.escape(rec.employeeName)} (${this.escape(rec.employeeId)})</strong><div style="font-size:11px;color:var(--text-muted)">Registered photo – compare with the Time IN/OUT photos below</div></div></div>
          <div>Date: <strong>${this.escape(rec.attendanceDate)}</strong></div>
        </div>

        ${this.isLeave(rec) ? `
          <div style="background: #fef3c7; padding: 10px; border-radius: 6px; border: 1px solid #fde68a;">
            <div style="font-weight: 700; color: #b45309;">🏖 On Leave</div>
            <div>Type: <strong>${this.escape(rec.leaveType || '-')}</strong></div>
            <div>Remarks: ${this.escape(rec.leaveRemarks || '-')}</div>
          </div>
        ` : ''}

        <div style="display: ${this.isLeave(rec) ? 'none' : 'grid'}; grid-template-columns: 1fr 1fr; gap: 12px;">
          <div style="background: #f0fdf4; padding: 10px; border-radius: 6px;">
            <div style="font-weight: 600; color: var(--primary);">TIME IN</div>
            <div style="font-size: 16px; font-weight: 700;">${this.escape(rec.timeIn || 'None')}</div>
            <div style="font-size: 11px; color: var(--text-muted);">Orig: ${this.escape(rec.originalTimeIn || 'None')}</div>
            <div style="font-size: 11px; color: var(--text-muted);">GPS: ${this.escape(rec.actualGpsIn || 'None')}</div>
          </div>

          <div style="background: #e0f2fe; padding: 10px; border-radius: 6px;">
            <div style="font-weight: 600; color: #0284c7;">TIME OUT</div>
            <div style="font-size: 16px; font-weight: 700;">${this.escape(rec.timeOut || 'None')}</div>
            <div style="font-size: 11px; color: var(--text-muted);">Orig: ${this.escape(rec.originalTimeOut || 'None')}</div>
            <div style="font-size: 11px; color: var(--text-muted);">GPS: ${this.escape(rec.actualGpsOut || 'None')}</div>
          </div>
        </div>

        ${this.isLeave(rec) ? '' : `
        <div class="photo-pair">
          <div class="photo-slot" id="detail-photo-IN"><span>Time IN photo: loading…</span></div>
          <div class="photo-slot" id="detail-photo-OUT"><span>Time OUT photo: loading…</span></div>
        </div>
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 12px;">
          <div>Hours worked: <strong>${this.escape(rec.hoursWorked !== undefined && rec.hoursWorked !== '' ? rec.hoursWorked : '-')}</strong>${Number(rec.overtimeHours) > 0 ? ` (OT ${this.escape(rec.overtimeHours)})` : ''}</div>
          <div>Checks: ${this.renderFlags(rec) || 'None'}</div>
          <div>Distance IN: ${rec.distanceInMeters !== undefined && rec.distanceInMeters !== '' ? this.escape(rec.distanceInMeters) + ' m' : '-'} ${this.escape(rec.geofenceIn || '')}</div>
          <div>Distance OUT: ${rec.distanceOutMeters !== undefined && rec.distanceOutMeters !== '' ? this.escape(rec.distanceOutMeters) + ' m' : '-'} ${this.escape(rec.geofenceOut || '')}</div>
          ${rec.clockFlag ? `<div style="grid-column: 1 / -1; color:#b91c1c;">Clock warning: ${this.escape(rec.clockFlag)}</div>` : ''}
        </div>`}

        <div>Assigned Work Location: <strong>${this.escape(rec.workLocation || 'Unassigned')}</strong></div>
        <div>Assigned Landowner: <strong>${this.escape(rec.landownerName || 'Unassigned')}</strong></div>
        <div>Supervisor: <strong>${this.escape(rec.supervisorName || 'Unassigned')}</strong></div>

        ${rec.adjustedBy ? `
          <div style="background: #fef3c7; padding: 10px; border-radius: 6px; border: 1px solid #fde68a;">
            <div style="font-weight: 700; color: #b45309;">Adjustment Audit Trail</div>
            <div>Adjusted By: <strong>${this.escape(rec.adjustedBy)}</strong></div>
            <div>Reason: <em>"${this.escape(rec.adjustmentReason)}"</em></div>
          </div>
        ` : ''}

        <div style="border-top: 1px solid var(--border); padding-top: 8px; font-size: 11px; color: var(--text-muted);">
          <div>Device Capture Timestamp: ${this.escape(rec.deviceTimestamp || '-')}</div>
          <div>Synchronization Date: ${this.escape(rec.synchronizationDate || 'Not yet synced')}</div>
          <div>Status: <span class="status-pill badge-${(rec.syncStatus || 'PENDING').toLowerCase()}">${rec.syncStatus}</span></div>
          ${rec.syncError ? `<div style="color:#b91c1c;">Upload problem: ${this.escape(rec.syncError)}</div>` : ''}
        </div>
      </div>
    `;

    this.openModal('details-modal');
    if (!this.isLeave(rec)) {
      ['IN', 'OUT'].forEach((k) => this.fillPhotoSlot(rec, k, document.getElementById(`detail-photo-${k}`)));
    }
  }

  /** Finds the best available image: full local copy, server copy (online), or thumbnail. */
  async getPhotoSrc(rec, kind, preferFull = true) {
    const local = await db.get('photos', `${rec.attendanceRecordId}-${kind}`);
    if (local && local.dataUrl) return { src: local.dataUrl, local };
    const url = rec[kind === 'OUT' ? 'photoOut' : 'photoIn'];
    if (preferFull && url && (await api.isReachable())) {
      try {
        const res = await api.call('GET_PHOTO', { recordId: rec.attendanceRecordId, kind });
        return { src: res.dataUrl, url, local };
      } catch (e) { /* fall back to thumbnail */ }
    }
    if (local && local.thumbUrl) return { src: local.thumbUrl, local, url };
    return { src: '', url, local };
  }

  async fillPhotoSlot(rec, kind, el) {
    if (!el) return;
    const label = kind === 'OUT' ? 'Time OUT' : 'Time IN';
    const info = await this.getPhotoSrc(rec, kind);
    if (info.src) {
      el.innerHTML = `<img src="${info.src}" alt="${label} photo" />
        <div class="photo-cap">${label}${info.local && info.local.syncStatus !== 'SYNCED' ? ' • not uploaded yet' : ''}
        ${info.url ? ` • <a href="${this.escape(info.url)}" target="_blank" rel="noopener">Drive</a>` : ''}</div>`;
      el.querySelector('img').onclick = () => this.openImage(info.src);
    } else if (info.url) {
      el.innerHTML = `<div class="photo-cap">${label} photo saved in Drive</div><a class="btn btn-outline" style="font-size:11px;padding:4px 8px;" href="${this.escape(info.url)}" target="_blank" rel="noopener">Open in Drive</a><small style="padding:4px;">Connect to the internet to preview here.</small>`;
    } else {
      const skipped = rec[kind === 'OUT' ? 'photoOutSkipped' : 'photoInSkipped'];
      const hasTime = kind === 'OUT' ? rec.timeOut : rec.timeIn;
      el.innerHTML = `<span>${hasTime ? (skipped ? `${label}: photo skipped` : `No ${label} photo`) : `No ${label} yet`}</span>`;
    }
  }

  async viewPhoto(recordId, kind) {
    const rec = await db.get('attendance', recordId);
    if (!rec) return;
    this.showToast('Opening photo…', 'info');
    const info = await this.getPhotoSrc(rec, kind);
    if (info.src) this.openImage(info.src);
    else if (info.url) window.open(info.url, '_blank', 'noopener');
    else this.showToast('Photo is not available on this phone.', 'warning');
  }

  // Soft Delete Attendance Confirmation
  async confirmSoftDelete(recordId) {
    const reason = prompt('Please enter the reason for deleting this attendance record (Required for Audit Trail):');
    if (!reason || !reason.trim()) {
      alert('Deletion cancelled. A reason is required for deletion.');
      return;
    }

    try {
      const rec = await db.get('attendance', recordId);
      if (!rec) throw new Error('Record not found.');

      rec.recordStatus = 'DELETED';
      rec.deleteReason = reason.trim();
      await db.saveAttendance(rec); // the deletion uploads on the next sync

      // Log audit
      const currentUser = auth.getCurrentUser() || {};
      const auditLog = {
        logId: `LOG-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        userId: currentUser.userId || 'SYSTEM',
        userRole: currentUser.role || 'Supervisor',
        action: 'SOFT_DELETE_ATTENDANCE',
        recordId: recordId,
        previousValue: 'ACTIVE',
        newValue: 'DELETED',
        reason: reason.trim(),
        dateTime: new Date().toISOString()
      };
      await db.put('auditLogs', auditLog);

      this.showToast('Attendance record soft-deleted and logged to audit trail.', 'success');
      this.refreshCurrentView();

      if (navigator.onLine) {
        syncService.autoSync();
      }
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  }

  // Export Attendance to CSV (respects the current history filters)
  async exportHistoryCsv() {
    let validRecords = (await db.getAll('attendance')).filter((r) => r.recordStatus !== 'DELETED');
    if (!auth.isAdmin()) {
      const sid = String(auth.getLinkedSupervisorId() || '');
      validRecords = validRecords.filter((r) => String(r.supervisorId || '') === sid);
    }
    if (validRecords.length === 0) {
      alert('No attendance records available to export.');
      return;
    }
    validRecords.sort((a, b) => (a.attendanceDate > b.attendanceDate ? 1 : -1));

    const cols = [
      ['Attendance Record ID', 'attendanceRecordId'], ['Employee ID', 'employeeId'], ['Employee Name', 'employeeName'],
      ['Supervisor ID', 'supervisorId'], ['Supervisor Name', 'supervisorName'], ['Landowner ID', 'landownerId'],
      ['Landowner Name', 'landownerName'], ['Location ID', 'locationId'], ['Work Location', 'workLocation'],
      ['Attendance Date', 'attendanceDate'], ['Time IN', 'timeIn'], ['Time OUT', 'timeOut'],
      ['Hours Worked', 'hoursWorked'], ['Overtime Hours', 'overtimeHours'],
      ['Original Time IN', 'originalTimeIn'], ['Original Time OUT', 'originalTimeOut'], ['Adjusted By', 'adjustedBy'],
      ['Adjustment Reason', 'adjustmentReason'], ['Actual GPS IN', 'actualGpsIn'], ['Actual GPS OUT', 'actualGpsOut'],
      ['Distance IN (m)', 'distanceInMeters'], ['Geofence IN', 'geofenceIn'], ['Distance OUT (m)', 'distanceOutMeters'],
      ['Geofence OUT', 'geofenceOut'], ['Clock Flag', 'clockFlag'], ['Photo IN', 'photoIn'], ['Photo OUT', 'photoOut'],
      ['Device Timestamp', 'deviceTimestamp'], ['Synchronization Date', 'synchronizationDate'], ['Synchronization Status', 'syncStatus'],
      ['Attendance Type', null], ['Leave Type', 'leaveType'], ['Leave Remarks', 'leaveRemarks']
    ];
    const rows = validRecords.map((r) => cols.map(([h, k]) => this.csvCell(k ? r[k] : (this.isLeave(r) ? 'LEAVE' : 'PRESENT'))));
    const csvContent = '﻿' + [cols.map((c) => this.csvCell(c[0])).join(','), ...rows.map((row) => row.join(','))].join('\r\n');
    this.downloadText(csvContent, `Attendance_Report_${this.todayStr()}.csv`);
  }

  downloadText(text, filename) {
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ==========================================================================
     SYNCHRONIZATION CENTER VIEW
     ========================================================================== */
  async renderSyncView(container) {
    const stats = await syncService.getSyncStats();
    const allAtt = await db.getAll('attendance');
    const pendingList = allAtt.filter((r) => r.syncStatus === 'PENDING' || r.syncStatus === 'FAILED' || r.syncStatus === 'SYNCING');
    const failedPhotos = (await db.getAll('photos')).filter((p) => p.syncStatus === 'FAILED');
    const outbox = await api.getOutbox();

    container.innerHTML = `
      <div class="metrics-grid">
        <div class="metric-card">
          <span class="metric-title">Connection Status</span>
          <div class="metric-value">
            <span class="status-pill ${stats.isOnline ? 'status-online' : 'status-offline'}">
              <span class="status-dot"></span> ${stats.isOnline ? 'Online' : 'Offline'}
            </span>
          </div>
        </div>

        <div class="metric-card">
          <span class="metric-title">Pending Upload</span>
          <div class="metric-value" style="color: #b45309;">${stats.pendingRecords}</div>
        </div>

        <div class="metric-card">
          <span class="metric-title">Failed Attempts</span>
          <div class="metric-value" style="color: var(--accent-red);">${stats.failedRecords}</div>
        </div>

        <div class="metric-card">
          <span class="metric-title">Synced to Sheets</span>
          <div class="metric-value" style="color: var(--primary);">${stats.syncedRecords}</div>
        </div>

        <div class="metric-card">
          <span class="metric-title">Photos Waiting</span>
          <div class="metric-value" style="color: ${stats.failedPhotos ? 'var(--accent-red)' : '#b45309'};">${stats.pendingPhotos}</div>
        </div>

        ${auth.isAdmin() ? `
        <div class="metric-card">
          <span class="metric-title">Admin Changes Queued</span>
          <div class="metric-value" style="color: ${stats.outboxFailed ? 'var(--accent-red)' : '#b45309'};">${stats.outboxCount}</div>
        </div>` : ''}

        <div class="metric-card">
          <span class="metric-title">Total Local Records</span>
          <div class="metric-value">${stats.totalRecords}</div>
        </div>
      </div>

      ${outbox.length ? `
      <div class="content-card">
        <div class="card-header"><h3 class="card-title">Changes Waiting to Upload</h3></div>
        <div class="card-body" style="padding:0;">
          <div class="table-responsive"><table class="data-table">
            <thead><tr><th>Saved</th><th>Change</th><th>Status</th><th>Action</th></tr></thead>
            <tbody>${outbox.map((o) => `
              <tr>
                <td><small>${this.escape(new Date(o.createdAt).toLocaleString())}</small></td>
                <td>${this.escape(o.label)}</td>
                <td>${o.status === 'FAILED' ? `<span class="status-pill badge-failed">FAILED</span><div class="sync-error-text">${this.escape(o.error)}</div>` : '<span class="status-pill badge-pending">PENDING</span>'}</td>
                <td><button class="btn btn-outline" style="padding:4px 8px;font-size:11px;" onclick="app.discardOutboxItem('${o.id}')">Discard</button></td>
              </tr>`).join('')}
            </tbody>
          </table></div>
        </div>
      </div>` : ''}

      ${failedPhotos.length ? `
      <div class="alert-banner bad">
        <strong>${failedPhotos.length} photo(s) could not be uploaded:</strong>
        ${failedPhotos.slice(0, 5).map((p) => `<div>• ${this.escape(p.recordId)} (${p.kind}): ${this.escape(p.error || 'unknown error')}</div>`).join('')}
        <div style="margin-top:6px;">Tap "Retry Failed" to try again. Photos stay on this phone until they upload.</div>
      </div>` : ''}

      <!-- Sync Controls -->
      <div class="content-card">
        <div class="card-header">
          <h3 class="card-title">Synchronization Controls</h3>
          <span style="font-size: 12px; color: var(--text-muted);">Last Sync: <strong>${stats.lastSyncTime}</strong></span>
        </div>
        <div class="card-body">
          <div style="display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 20px;">
            <button class="btn btn-primary" onclick="app.triggerSyncAll()">
              ⚡ Sync All Pending Records
            </button>
            <button class="btn btn-outline" onclick="app.triggerRetryFailed()">
              🔄 Retry Failed Records
            </button>
            <button class="btn btn-outline" onclick="app.triggerSyncSelected()">
              📤 Sync Selected Records
            </button>
            <button class="btn btn-outline" onclick="app.pullFreshData()">
              ⬇ Pull Latest from Google Sheets
            </button>
          </div>

          ${stats.lastSyncError ? `
            <div style="padding: 12px; background: #fee2e2; color: #b91c1c; border-radius: 8px; font-size: 13px; margin-bottom: 16px;">
              <strong>Last Sync Error:</strong> ${this.escape(stats.lastSyncError)}
            </div>
          ` : ''}

          <h4 style="font-size: 14px; font-weight: 700; margin-bottom: 10px;">Queue of Pending & Failed Records</h4>
          ${pendingList.length === 0 && stats.pendingPhotos === 0 ? `
            <div style="text-align: center; padding: 32px; color: var(--text-muted); background: var(--bg-page); border-radius: 8px;">
              🎉 All records are successfully synchronized with Google Sheets!
            </div>
          ` : pendingList.length === 0 ? `
            <div style="text-align: center; padding: 20px; color: var(--text-muted); background: var(--bg-page); border-radius: 8px;">
              All records are uploaded. ${stats.pendingPhotos} photo(s) are still waiting.
            </div>
          ` : `
            <div class="table-responsive">
              <table class="data-table">
                <thead>
                  <tr>
                    <th width="30"><input type="checkbox" onchange="app.toggleSelectAllSync(this)" /></th>
                    <th>Record ID</th>
                    <th>Date</th>
                    <th>Employee ID</th>
                    <th>Employee Name</th>
                    <th>Time IN</th>
                    <th>Time OUT</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  ${pendingList.map((r) => `
                    <tr>
                      <td><input type="checkbox" class="sync-row-checkbox" value="${r.attendanceRecordId}" onchange="app.toggleSyncCheckbox('${r.attendanceRecordId}', this.checked)" /></td>
                      <td><small style="font-family: monospace;">${this.escape(r.attendanceRecordId)}</small></td>
                      <td>${this.escape(r.attendanceDate)}</td>
                      <td><span class="emp-id-badge">${this.escape(r.employeeId)}</span></td>
                      <td><strong>${this.escape(r.employeeName)}</strong></td>
                      <td>${this.escape(r.timeIn || '-')}</td>
                      <td>${this.escape(r.timeOut || '-')}</td>
                      <td><span class="status-pill badge-${r.syncStatus.toLowerCase()}">${r.syncStatus}</span>${r.syncError ? `<div class="sync-error-text">${this.escape(r.syncError)}</div>` : ''}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          `}
        </div>
      </div>
    `;
  }

  async discardOutboxItem(id) {
    if (!confirm('Discard this change? It will NOT be saved to Google Sheets.')) return;
    await db.delete('outbox', id);
    this.showToast('Change discarded. Pull latest data to refresh the lists.', 'info');
    this.renderSyncView(document.getElementById('view-content-root'));
  }

  toggleSyncCheckbox(id, isChecked) {
    if (isChecked) this.selectedSyncIds.add(id);
    else this.selectedSyncIds.delete(id);
  }

  toggleSelectAllSync(masterCheckbox) {
    const checkboxes = document.querySelectorAll('.sync-row-checkbox');
    checkboxes.forEach((cb) => {
      cb.checked = masterCheckbox.checked;
      this.toggleSyncCheckbox(cb.value, masterCheckbox.checked);
    });
  }

  async triggerSyncAll() {
    try {
      this.showToast('Starting batch sync...', 'info');
      const res = await syncService.syncAllPending();
      this.showToast(res.message, 'success');
      this.renderSyncView(document.getElementById('view-content-root'));
    } catch (err) {
      this.showToast(err.message, 'error');
      this.renderSyncView(document.getElementById('view-content-root'));
    }
  }

  async triggerRetryFailed() {
    try {
      this.showToast('Retrying failed items...', 'info');
      await syncService.retryFailed();
      this.renderSyncView(document.getElementById('view-content-root'));
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  }

  async triggerSyncSelected() {
    if (this.selectedSyncIds.size === 0) {
      alert('Please check at least one record to sync.');
      return;
    }
    try {
      this.showToast(`Syncing ${this.selectedSyncIds.size} selected records...`, 'info');
      await syncService.syncSelected(Array.from(this.selectedSyncIds));
      this.selectedSyncIds.clear();
      this.renderSyncView(document.getElementById('view-content-root'));
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  }

  async pullFreshData() {
    try {
      this.showToast('Pulling latest data from Google Sheets...', 'info');
      await syncService.pullRemoteData(true);
      this.showToast('Local database updated from Google Sheets.', 'success');
      this.renderSyncView(document.getElementById('view-content-root'));
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  }

  /* ==========================================================================
     ADMIN MODULE 1: EMPLOYEE ENROLLMENT & MANAGEMENT
     ========================================================================== */
  async renderEmployeesView(container) {
    const [employees, supervisors, landowners, locations] = await Promise.all([
      db.getAll('employees'),
      db.getAll('supervisors'),
      db.getAll('landowners'),
      db.getAll('locations')
    ]);

    container.innerHTML = `
      <div class="content-card">
        <div class="card-header">
          <h3 class="card-title">Employee Enrollment (Admin)</h3>
          <span style="font-size: 12px; color: var(--text-muted);">* Employee ID must be manually entered and unique</span>
        </div>
        <div class="card-body">
          <form id="enroll-employee-form">
            <div class="form-row">
              <div class="form-group">
                <label class="form-label required">Employee ID (Manual Entry)</label>
                <input type="text" id="emp-id-input" class="form-control" placeholder="e.g. 00123 or EMP-042" required />
                <div class="form-helper">Exact format, letters, numbers, and leading zeros will be preserved.</div>
              </div>

              <div class="form-group">
                <label class="form-label required">Employee Full Name</label>
                <input type="text" id="emp-name-input" class="form-control" placeholder="e.g. Pedro Santos" required />
              </div>

              <div class="form-group">
                <label class="form-label required">Position</label>
                <input type="text" id="emp-pos-input" class="form-control" placeholder="e.g. Harvester / Field Tech" required />
              </div>
            </div>

            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Department (Optional)</label>
                <input type="text" id="emp-dept-input" class="form-control" placeholder="e.g. Agriculture Operations" />
              </div>

              <div class="form-group">
                <label class="form-label required">Assigned Supervisor</label>
                <select id="emp-sup-select" class="form-control" required>
                  <option value="">Select Supervisor</option>
                  ${supervisors.filter((s) => s.accountStatus !== 'Inactive').map((s) => `<option value="${this.escape(s.supervisorId)}" data-name="${this.escape(s.supervisorName)}">${this.escape(s.supervisorName)} (${this.escape(s.supervisorId)})</option>`).join('')}
                </select>
              </div>

              <div class="form-group">
                <label class="form-label required">Assigned Work Location</label>
                <select id="emp-loc-select" class="form-control" required>
                  <option value="">Select Location</option>
                  ${locations.map((loc) => `<option value="${this.escape(loc.locationId)}" data-name="${this.escape(loc.workLocationName)}">${this.escape(loc.workLocationName)}</option>`).join('')}
                </select>
              </div>
            </div>

            <div class="form-group">
              <label class="form-label required">Employee Photo <small style="font-weight:normal;color:var(--text-muted)">(required for new employees – used to check the face on Time IN/OUT photos)</small></label>
              <div class="emp-photo-row">
                <div id="emp-photo-preview"></div>
                <div style="display:flex;gap:8px;flex-wrap:wrap;">
                  <button type="button" id="emp-photo-btn" class="btn btn-outline" onclick="app.captureEmployeePhoto()">📷 Take or Upload Photo</button>
                  <button type="button" id="emp-photo-remove" class="btn btn-outline" style="display:none" onclick="app.removeEmployeePhoto()">Remove</button>
                </div>
              </div>
            </div>

            <div class="form-row">
              <div class="form-group">
                <label class="form-label required">Employment Status</label>
                <select id="emp-status-select" class="form-control" required>
                  <option value="Active">Active</option>
                  <option value="Inactive">Inactive</option>
                </select>
              </div>

              <div class="form-group">
                <label class="form-label required">Date Enrolled</label>
                <input type="date" id="emp-date-enrolled" class="form-control" value="${this.todayStr()}" required />
              </div>
            </div>

            <div style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 10px;">
              <button type="button" id="emp-cancel-edit-btn" class="btn btn-outline" style="display: none;" onclick="app.cancelEmployeeEdit()">Cancel Edit</button>
              <button type="submit" id="emp-save-btn" class="btn btn-primary">Enroll Employee</button>
            </div>
          </form>
        </div>
      </div>

      <!-- Enrolled Employees Table -->
      <div class="content-card">
        <div class="card-header">
          <h3 class="card-title">Enrolled Employees Directory (${employees.length})</h3>
          ${employees.filter((e) => !this.getAvatar('EMPLOYEE', e.employeeId)).length ? `<span class="flag-pill flag-warn">${employees.filter((e) => !this.getAvatar('EMPLOYEE', e.employeeId)).length} without photo – tap the circle to add</span>` : ''}
        </div>
        <div class="card-body" style="padding: 0;">
          <div class="table-responsive">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Photo</th>
                  <th>Employee ID</th>
                  <th>Full Name</th>
                  <th>Position</th>
                  <th>Supervisor</th>
                  <th>Location</th>
                  <th>Status</th>
                  <th>Enrolled</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${employees.length === 0 ? `<tr><td colspan="9" style="text-align: center; padding: 24px;">No employees enrolled yet.</td></tr>` : employees.map((emp) => `
                  <tr>
                    <td>${this.employeeAvatar(emp, 40, { markMissing: true, onclick: `app.openProfilePhotoModal('EMPLOYEE', '${this.escape(emp.employeeId)}', '${this.escape(emp.employeeName).replace(/&#39;/g, '')}')` })}</td>
                    <td><span class="emp-id-badge">${this.escape(emp.employeeId)}</span></td>
                    <td><strong>${this.escape(emp.employeeName)}</strong></td>
                    <td>${this.escape(emp.position || '-')}</td>
                    <td>${this.escape(emp.supervisorName || '-')}</td>
                    <td>${this.escape(emp.workLocation || '-')}</td>
                    <td><span class="status-pill ${emp.employmentStatus === 'Active' ? 'status-online' : 'status-offline'}">${emp.employmentStatus}</span></td>
                    <td><small>${this.escape(emp.dateEnrolled || '-')}</small></td>
                    <td>
                      <button class="btn btn-outline" style="padding: 4px 8px; font-size: 11px;" onclick="app.editEmployee('${emp.employeeId}')">Edit / Reassign</button>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;

    document.getElementById('enroll-employee-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      await this.saveEmployeeHandler();
    });
    this.pendingEmployeePhoto = null;
    this.renderEmployeePhotoPreview();
  }

  /** Saves admin data online, or queues it when offline. Returns true when saved/queued. */
  async saveMasterAndReport(action, data, label, successMsg) {
    try {
      const res = await api.saveMaster(action, data, label);
      if (res.queued) {
        this.showToast(`${label}: saved on this phone only. It will upload to Google Sheets when you are online.`, 'warning');
        this.updateSyncBadge();
      } else {
        this.showToast(successMsg, 'success');
      }
      return true;
    } catch (err) {
      this.showToast(`Not saved: ${err.message}`, 'error');
      return false;
    }
  }

  async saveEmployeeHandler() {
    const empId = document.getElementById('emp-id-input').value.trim();
    const empName = document.getElementById('emp-name-input').value.trim();
    const position = document.getElementById('emp-pos-input').value.trim();
    const dept = document.getElementById('emp-dept-input').value.trim();
    const supSelect = document.getElementById('emp-sup-select');
    const locSelect = document.getElementById('emp-loc-select');
    const status = document.getElementById('emp-status-select').value;
    const dateEnrolled = document.getElementById('emp-date-enrolled').value;

    if (!/^[A-Za-z0-9._-]{1,30}$/.test(empId)) {
      alert('Employee ID can only contain letters, numbers, dot, dash or underscore (max 30).');
      return;
    }

    const isEdit = !!this.currentEditEmployee;
    const photo = this.pendingEmployeePhoto;
    if (!isEdit && (!photo || photo === 'REMOVE')) {
      alert('Please take or upload the employee\'s photo before enrolling.');
      return;
    }
    if (!isEdit && (await db.get('employees', empId))) {
      alert(`Employee ID "${empId}" already exists. Duplicate IDs are not allowed!`);
      return;
    }

    const employeeObj = {
      employeeId: empId,
      employeeName: empName,
      position,
      department: dept,
      supervisorId: supSelect.value,
      supervisorName: supSelect.options[supSelect.selectedIndex]?.getAttribute('data-name') || '',
      landownerId: '',
      landownerName: '',
      locationId: locSelect.value,
      workLocation: locSelect.options[locSelect.selectedIndex]?.getAttribute('data-name') || '',
      employmentStatus: status,
      dateEnrolled
    };

    const btn = document.getElementById('emp-save-btn');
    btn.disabled = true;
    const ok = await this.saveMasterAndReport('SAVE_EMPLOYEE', { employee: employeeObj, isEdit },
      `${isEdit ? 'Update' : 'Enroll'} employee ${empName} (${empId})`, `Employee ${empName} saved to Google Sheets.`);
    btn.disabled = false;
    if (!ok) return;

    await db.put('employees', employeeObj);
    if (photo) await this.saveProfilePhoto('EMPLOYEE', empId, photo === 'REMOVE' ? '' : photo, `Photo of ${empName}`);
    this.pendingEmployeePhoto = null;
    this.cancelEmployeeEdit();
    this.renderEmployeesView(document.getElementById('view-content-root'));
  }

  async editEmployee(employeeId) {
    const emp = await db.get('employees', employeeId);
    if (!emp) return;

    this.currentEditEmployee = emp;

    document.getElementById('emp-id-input').value = emp.employeeId;
    document.getElementById('emp-id-input').disabled = true; // Employee ID remains unchanged on edit
    document.getElementById('emp-name-input').value = emp.employeeName;
    document.getElementById('emp-pos-input').value = emp.position || '';
    document.getElementById('emp-dept-input').value = emp.department || '';
    document.getElementById('emp-sup-select').value = emp.supervisorId || '';
    document.getElementById('emp-loc-select').value = emp.locationId || '';
    document.getElementById('emp-status-select').value = emp.employmentStatus || 'Active';
    document.getElementById('emp-date-enrolled').value = emp.dateEnrolled || '';

    document.getElementById('emp-cancel-edit-btn').style.display = 'inline-flex';
    document.getElementById('emp-save-btn').textContent = 'Update & Reassign Employee';
    this.pendingEmployeePhoto = null;
    this.renderEmployeePhotoPreview();

    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  cancelEmployeeEdit() {
    this.currentEditEmployee = null;
    const form = document.getElementById('enroll-employee-form');
    if (form) form.reset();
    const idInput = document.getElementById('emp-id-input');
    if (idInput) idInput.disabled = false;
    const cancelBtn = document.getElementById('emp-cancel-edit-btn');
    if (cancelBtn) cancelBtn.style.display = 'none';
    const saveBtn = document.getElementById('emp-save-btn');
    if (saveBtn) saveBtn.textContent = 'Enroll Employee';
    this.pendingEmployeePhoto = null;
    this.renderEmployeePhotoPreview();
  }

  /* ==========================================================================
     ADMIN MODULE 2: SUPERVISOR ENROLLMENT
     ========================================================================== */
  async renderSupervisorsView(container) {
    const supervisors = await db.getAll('supervisors');
    this.editingSupervisorId = null;

    container.innerHTML = `
      <div class="content-card">
        <div class="card-header">
          <h3 class="card-title" id="sup-form-title">Supervisor Enrollment</h3>
        </div>
        <div class="card-body">
          <form id="enroll-sup-form">
            <div class="form-row">
              <div class="form-group">
                <label class="form-label required">Supervisor ID</label>
                <input type="text" id="sup-id-input" class="form-control" placeholder="e.g. SUP-001" required />
              </div>
              <div class="form-group">
                <label class="form-label required">Full Name</label>
                <input type="text" id="sup-name-input" class="form-control" placeholder="e.g. Juan Dela Cruz" required />
              </div>
              <div class="form-group">
                <label class="form-label required">Username (Login Account)</label>
                <input type="text" id="sup-user-input" class="form-control" placeholder="e.g. jdelacruz" required autocomplete="off" />
              </div>
            </div>

            <div class="form-row">
              <div class="form-group">
                <label class="form-label" id="sup-pass-label">Password (min. 8 characters)</label>
                <input type="password" id="sup-pass-input" class="form-control" placeholder="••••••••" autocomplete="new-password" />
                <div class="form-helper" id="sup-pass-help">The supervisor must change it at first login.</div>
              </div>
              <div class="form-group">
                <label class="form-label required">Account Status</label>
                <select id="sup-status-select" class="form-control">
                  <option value="Active">Active</option>
                  <option value="Inactive">Inactive (cannot log in, even offline)</option>
                </select>
              </div>
            </div>

            <div style="display:flex; gap:10px; justify-content:flex-end; margin-top: 10px;">
              <button type="button" id="sup-cancel-btn" class="btn btn-outline" style="display:none" onclick="app.renderSupervisorsView(document.getElementById('view-content-root'))">Cancel Edit</button>
              <button type="submit" id="sup-save-btn" class="btn btn-primary">Enroll Supervisor</button>
            </div>
          </form>
        </div>
      </div>

      <div class="content-card">
        <div class="card-header">
          <h3 class="card-title">Supervisors Directory (${supervisors.length})</h3>
        </div>
        <div class="card-body" style="padding: 0;">
          <div class="table-responsive">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Photo</th>
                  <th>Supervisor ID</th>
                  <th>Full Name</th>
                  <th>Username</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                ${supervisors.map((s) => `
                  <tr>
                    <td>${(() => { const k = this.supervisorAvatarKey(s.supervisorId); return this.avatarHtml(k ? k.type : '', k ? k.id : '', s.supervisorName, 40, k ? { onclick: `app.openProfilePhotoModal('USER', '${this.escape(k.id)}', '${this.escape(s.supervisorName).replace(/&#39;/g, '')}')` } : {}); })()}</td>
                    <td><span class="emp-id-badge">${this.escape(s.supervisorId)}</span></td>
                    <td><strong>${this.escape(s.supervisorName)}</strong></td>
                    <td>${this.escape(s.username)}</td>
                    <td><span class="status-pill ${s.accountStatus === 'Active' ? 'status-online' : 'status-offline'}">${this.escape(s.accountStatus)}</span></td>
                    <td><button class="btn btn-outline" style="padding: 4px 8px; font-size: 11px;" data-sup="${this.escape(s.supervisorId)}">Edit</button></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;

    container.querySelectorAll('button[data-sup]').forEach((b) => b.addEventListener('click', () => {
      const s = supervisors.find((x) => String(x.supervisorId) === b.dataset.sup);
      if (!s) return;
      this.editingSupervisorId = s.supervisorId;
      document.getElementById('sup-id-input').value = s.supervisorId;
      document.getElementById('sup-id-input').disabled = true;
      document.getElementById('sup-name-input').value = s.supervisorName || '';
      document.getElementById('sup-user-input').value = s.username || '';
      document.getElementById('sup-status-select').value = s.accountStatus || 'Active';
      document.getElementById('sup-pass-input').value = '';
      document.getElementById('sup-pass-help').textContent = 'Leave blank to keep the current password. A new password must be changed at next login.';
      document.getElementById('sup-form-title').textContent = `Edit Supervisor ${s.supervisorId}`;
      document.getElementById('sup-save-btn').textContent = 'Update Supervisor';
      document.getElementById('sup-cancel-btn').style.display = 'inline-flex';
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }));

    document.getElementById('enroll-sup-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const isEdit = !!this.editingSupervisorId;
      const supId = isEdit ? this.editingSupervisorId : document.getElementById('sup-id-input').value.trim();
      const supName = document.getElementById('sup-name-input').value.trim();
      const username = document.getElementById('sup-user-input').value.trim();
      const pass = document.getElementById('sup-pass-input').value;
      const status = document.getElementById('sup-status-select').value;

      if (!isEdit && (await db.get('supervisors', supId))) { alert(`Supervisor ID "${supId}" already exists. Use Edit instead.`); return; }
      if (!/^[A-Za-z0-9._-]{3,30}$/.test(username)) { alert('Username: 3-30 letters, numbers, dot, dash or underscore.'); return; }
      if (!isEdit && !pass) { alert('Please set a password for the new supervisor.'); return; }
      if (pass && pass.length < 8) { alert('Password must be at least 8 characters.'); return; }

      const supervisorObj = {
        supervisorId: supId,
        supervisorName: supName,
        username,
        accountStatus: status,
        passwordHash: pass ? await auth.hashPassword(pass) : ''
      };

      const ok = await this.saveMasterAndReport('SAVE_SUPERVISOR', { supervisor: supervisorObj },
        `${isEdit ? 'Update' : 'Enroll'} supervisor ${supName}`, `Supervisor ${supName} saved.`);
      if (!ok) return;

      delete supervisorObj.passwordHash;
      await db.put('supervisors', supervisorObj);
      this.renderSupervisorsView(document.getElementById('view-content-root'));
    });
  }

  /* ==========================================================================
     ADMIN MODULE 3: LANDOWNER ENROLLMENT
     ========================================================================== */
  async renderLandownersView(container) {
    const [landowners, locations, supervisors] = await Promise.all([
      db.getAll('landowners'),
      db.getAll('locations'),
      db.getAll('supervisors')
    ]);
    this.editingLandownerId = null;

    container.innerHTML = `
      <div class="content-card">
        <div class="card-header">
          <h3 class="card-title" id="lnd-form-title">Landowner Enrollment</h3>
        </div>
        <div class="card-body">
          <form id="enroll-lnd-form">
            <div class="form-row">
              <div class="form-group">
                <label class="form-label required">Landowner ID</label>
                <input type="text" id="lnd-id-input" class="form-control" placeholder="e.g. LND-001" required />
              </div>
              <div class="form-group">
                <label class="form-label required">Landowner Full Name</label>
                <input type="text" id="lnd-name-input" class="form-control" placeholder="e.g. Don Ramon Agricultural Estate" required />
              </div>
              <div class="form-group">
                <label class="form-label required">Assigned Work Location</label>
                <select id="lnd-loc-select" class="form-control" required>
                  <option value="">Select Location</option>
                  ${locations.map((loc) => `<option value="${this.escape(loc.locationId)}" data-name="${this.escape(loc.workLocationName)}">${this.escape(loc.workLocationName)}</option>`).join('')}
                </select>
              </div>
            </div>

            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Supervisor <small style="font-weight: normal; color: var(--text-muted);">(automatic, from the Work Location)</small></label>
                <select id="lnd-sup-select" class="form-control" disabled>
                  <option value="">Select a Work Location first</option>
                  ${supervisors.map((s) => `<option value="${this.escape(s.supervisorId)}">${this.escape(s.supervisorName)}</option>`).join('')}
                </select>
              </div>
              <div class="form-group">
                <label class="form-label required">Status</label>
                <select id="lnd-status-select" class="form-control">
                  <option value="Active">Active</option>
                  <option value="Inactive">Inactive</option>
                </select>
              </div>
            </div>

            <div style="display:flex; gap:10px; justify-content:flex-end; margin-top: 10px;">
              <button type="button" id="lnd-cancel-btn" class="btn btn-outline" style="display:none" onclick="app.renderLandownersView(document.getElementById('view-content-root'))">Cancel Edit</button>
              <button type="submit" id="lnd-save-btn" class="btn btn-primary">Enroll Landowner</button>
            </div>
          </form>
        </div>
      </div>

      <div class="content-card">
        <div class="card-header">
          <h3 class="card-title">Landowners Directory (${landowners.length})</h3>
        </div>
        <div class="card-body" style="padding: 0;">
          <div class="table-responsive">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Landowner ID</th>
                  <th>Full Name</th>
                  <th>Assigned Location</th>
                  <th>Supervisor (via location)</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                ${landowners.map((l) => {
                  const loc = locations.find((x) => String(x.locationId) === String(l.locationId)) ||
                              locations.find((x) => x.landownerId && String(x.landownerId) === String(l.landownerId));
                  const sup = loc ? supervisors.find((x) => String(x.supervisorId) === String(loc.supervisorId)) : null;
                  return `
                  <tr>
                    <td><span class="emp-id-badge">${this.escape(l.landownerId)}</span></td>
                    <td><strong>${this.escape(l.landownerName)}</strong></td>
                    <td>${this.escape((loc && loc.workLocationName) || l.workLocation || '-')}</td>
                    <td>${sup ? this.escape(sup.supervisorName) : '<span class="status-pill badge-leave">No supervisor yet</span>'}</td>
                    <td><span class="status-pill ${l.status === 'Active' ? 'status-online' : 'status-offline'}">${this.escape(l.status)}</span></td>
                    <td><button class="btn btn-outline" style="padding: 4px 8px; font-size: 11px;" data-lnd="${this.escape(l.landownerId)}">Edit</button></td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;

    const showSup = (locId) => {
      const loc = locations.find((x) => String(x.locationId) === String(locId));
      document.getElementById('lnd-sup-select').value = loc && loc.supervisorId ? loc.supervisorId : '';
      return loc;
    };
    document.getElementById('lnd-loc-select').addEventListener('change', (ev) => {
      const loc = showSup(ev.target.value);
      if (loc && !loc.supervisorId) this.showToast('This location has no supervisor yet. Assign one under Work Locations so the supervisor can see this landowner.', 'warning');
    });

    container.querySelectorAll('button[data-lnd]').forEach((b) => b.addEventListener('click', () => {
      const l = landowners.find((x) => String(x.landownerId) === b.dataset.lnd);
      if (!l) return;
      this.editingLandownerId = l.landownerId;
      document.getElementById('lnd-id-input').value = l.landownerId;
      document.getElementById('lnd-id-input').disabled = true;
      document.getElementById('lnd-name-input').value = l.landownerName || '';
      document.getElementById('lnd-loc-select').value = l.locationId || '';
      document.getElementById('lnd-status-select').value = l.status || 'Active';
      showSup(l.locationId);
      document.getElementById('lnd-form-title').textContent = `Edit Landowner ${l.landownerId}`;
      document.getElementById('lnd-save-btn').textContent = 'Update Landowner';
      document.getElementById('lnd-cancel-btn').style.display = 'inline-flex';
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }));

    document.getElementById('enroll-lnd-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const isEdit = !!this.editingLandownerId;
      const lndId = isEdit ? this.editingLandownerId : document.getElementById('lnd-id-input').value.trim();
      if (!isEdit && landowners.some((x) => String(x.landownerId).toLowerCase() === lndId.toLowerCase())) {
        alert(`Landowner ID "${lndId}" already exists. Use Edit instead.`);
        return;
      }
      const lndName = document.getElementById('lnd-name-input').value.trim();
      const locSelect = document.getElementById('lnd-loc-select');
      const locationId = locSelect.value;
      const workLocation = locSelect.options[locSelect.selectedIndex]?.getAttribute('data-name') || '';
      const chosenLoc = locations.find((x) => String(x.locationId) === String(locationId)) || {};

      const landownerObj = {
        landownerId: lndId,
        landownerName: lndName,
        locationId,
        workLocation,
        supervisorId: chosenLoc.supervisorId || '',
        status: document.getElementById('lnd-status-select').value
      };

      const ok = await this.saveMasterAndReport('SAVE_LANDOWNER', { landowner: landownerObj },
        `${isEdit ? 'Update' : 'Enroll'} landowner ${lndName}`, `Landowner ${lndName} saved.`);
      if (!ok) return;
      await db.put('landowners', landownerObj);
      this.renderLandownersView(document.getElementById('view-content-root'));
    });
  }

  /* ==========================================================================
     ADMIN MODULE 4: WORK LOCATION ENROLLMENT (with map coordinates for geofencing)
     ========================================================================== */
  async renderLocationsView(container) {
    const [locations, landowners, supervisors, settings] = await Promise.all([
      db.getAll('locations'),
      db.getAll('landowners'),
      db.getAll('supervisors'),
      auth.getAppSettings()
    ]);
    this.editingLocationId = null;
    const supName = (id) => (supervisors.find((s) => String(s.supervisorId) === String(id)) || {}).supervisorName || id || '-';

    container.innerHTML = `
      <div class="content-card">
        <div class="card-header">
          <h3 class="card-title" id="loc-form-title">Work Location Enrollment</h3>
        </div>
        <div class="card-body">
          <form id="enroll-loc-form">
            <div class="form-row">
              <div class="form-group">
                <label class="form-label required">Location ID</label>
                <input type="text" id="loc-id-input" class="form-control" placeholder="e.g. LOC-001" required />
              </div>
              <div class="form-group">
                <label class="form-label required">Work Location Name</label>
                <input type="text" id="loc-name-input" class="form-control" placeholder="e.g. Farm 4 Block 1" required />
              </div>
              <div class="form-group">
                <label class="form-label">Description</label>
                <input type="text" id="loc-desc-input" class="form-control" placeholder="e.g. Coconut block near the river" />
              </div>
            </div>

            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Landowner Name</label>
                <select id="loc-lnd-select" class="form-control">
                  <option value="">Select Landowner (Optional)</option>
                  ${landowners.map((l) => `<option value="${this.escape(l.landownerId)}" data-name="${this.escape(l.landownerName)}">${this.escape(l.landownerName)}</option>`).join('')}
                </select>
              </div>
              <div class="form-group">
                <label class="form-label">Assigned Supervisor</label>
                <select id="loc-sup-select" class="form-control">
                  <option value="">Select Supervisor (Optional)</option>
                  ${supervisors.map((s) => `<option value="${this.escape(s.supervisorId)}">${this.escape(s.supervisorName)}</option>`).join('')}
                </select>
              </div>
              <div class="form-group">
                <label class="form-label required">Location Status</label>
                <select id="loc-status-select" class="form-control">
                  <option value="Active">Active</option>
                  <option value="Inactive">Inactive</option>
                </select>
              </div>
            </div>

            <div style="background: var(--primary-subtle); border: 1px solid var(--primary-border); border-radius: 8px; padding: 12px; margin-bottom: 12px;">
              <div style="font-weight:700; font-size: 13px; margin-bottom: 6px;">📍 Geofence (center of the work area)</div>
              <div class="form-row">
                <div class="form-group">
                  <label class="form-label">Latitude</label>
                  <input type="number" step="any" id="loc-lat-input" class="form-control" placeholder="e.g. 7.123456" />
                </div>
                <div class="form-group">
                  <label class="form-label">Longitude</label>
                  <input type="number" step="any" id="loc-lng-input" class="form-control" placeholder="e.g. 125.123456" />
                </div>
                <div class="form-group">
                  <label class="form-label">Allowed Radius (meters)</label>
                  <input type="number" min="10" max="20000" id="loc-radius-input" class="form-control" placeholder="Default ${this.escape(settings.defaultRadiusMeters)}" />
                </div>
              </div>
              <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
                <button type="button" class="btn btn-outline" id="loc-gps-btn">📍 Use my current GPS</button>
                <span class="form-helper" id="loc-gps-status">Stand in the middle of the block and tap the button, or paste coordinates from Google Maps.</span>
              </div>
            </div>

            <div style="display:flex; gap:10px; justify-content:flex-end; margin-top: 10px;">
              <button type="button" id="loc-cancel-btn" class="btn btn-outline" style="display:none" onclick="app.renderLocationsView(document.getElementById('view-content-root'))">Cancel Edit</button>
              <button type="submit" id="loc-save-btn" class="btn btn-primary">Enroll Location</button>
            </div>
          </form>
        </div>
      </div>

      <div class="content-card">
        <div class="card-header">
          <h3 class="card-title">Work Locations Directory (${locations.length})</h3>
        </div>
        <div class="card-body" style="padding: 0;">
          <div class="table-responsive">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Location ID</th>
                  <th>Location Name</th>
                  <th>Landowner</th>
                  <th>Supervisor</th>
                  <th>Geofence</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                ${locations.map((loc) => `
                  <tr>
                    <td><span class="emp-id-badge">${this.escape(loc.locationId)}</span></td>
                    <td><strong>${this.escape(loc.workLocationName)}</strong><small style="display:block;color:var(--text-muted)">${this.escape(loc.description || '')}</small></td>
                    <td>${this.escape(loc.landownerName || '-')}</td>
                    <td>${this.escape(supName(loc.supervisorId))}</td>
                    <td>${loc.latitude !== '' && loc.latitude !== undefined && loc.latitude !== null
                      ? `<a href="https://maps.google.com/?q=${encodeURIComponent(loc.latitude + ',' + loc.longitude)}" target="_blank" rel="noopener">${Number(loc.latitude).toFixed(5)}, ${Number(loc.longitude).toFixed(5)}</a><small style="display:block">± ${this.escape(loc.radiusMeters || settings.defaultRadiusMeters)} m</small>`
                      : '<span class="flag-pill flag-warn">Not set</span>'}</td>
                    <td><span class="status-pill ${loc.status === 'Active' ? 'status-online' : 'status-offline'}">${this.escape(loc.status)}</span></td>
                    <td><button class="btn btn-outline" style="padding: 4px 8px; font-size: 11px;" data-loc="${this.escape(loc.locationId)}">Edit</button></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;

    document.getElementById('loc-gps-btn').addEventListener('click', async () => {
      const st = document.getElementById('loc-gps-status');
      st.textContent = 'Getting GPS… keep the phone still.';
      const pos = await geo.getFreshPosition(20000);
      if (!pos || pos.error) { st.textContent = 'Could not get GPS. Turn on Location and try again.'; return; }
      document.getElementById('loc-lat-input').value = pos.lat.toFixed(6);
      document.getElementById('loc-lng-input').value = pos.lng.toFixed(6);
      st.textContent = `Got it (accuracy ±${pos.acc} m)${pos.acc > 30 ? ' – accuracy is weak, try again in an open area' : ''}.`;
    });

    container.querySelectorAll('button[data-loc]').forEach((b) => b.addEventListener('click', () => {
      const loc = locations.find((x) => String(x.locationId) === b.dataset.loc);
      if (!loc) return;
      this.editingLocationId = loc.locationId;
      document.getElementById('loc-id-input').value = loc.locationId;
      document.getElementById('loc-id-input').disabled = true;
      document.getElementById('loc-name-input').value = loc.workLocationName || '';
      document.getElementById('loc-desc-input').value = loc.description || '';
      document.getElementById('loc-lnd-select').value = loc.landownerId || '';
      document.getElementById('loc-sup-select').value = loc.supervisorId || '';
      document.getElementById('loc-status-select').value = loc.status || 'Active';
      document.getElementById('loc-lat-input').value = loc.latitude ?? '';
      document.getElementById('loc-lng-input').value = loc.longitude ?? '';
      document.getElementById('loc-radius-input').value = loc.radiusMeters ?? '';
      document.getElementById('loc-form-title').textContent = `Edit Location ${loc.locationId}`;
      document.getElementById('loc-save-btn').textContent = 'Update Location';
      document.getElementById('loc-cancel-btn').style.display = 'inline-flex';
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }));

    document.getElementById('enroll-loc-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const isEdit = !!this.editingLocationId;
      const locId = isEdit ? this.editingLocationId : document.getElementById('loc-id-input').value.trim();
      if (!isEdit && locations.some((x) => String(x.locationId).toLowerCase() === locId.toLowerCase())) {
        alert(`Location ID "${locId}" already exists. Use Edit instead.`);
        return;
      }
      const lat = document.getElementById('loc-lat-input').value.trim();
      const lng = document.getElementById('loc-lng-input').value.trim();
      const radius = document.getElementById('loc-radius-input').value.trim();
      if ((lat === '') !== (lng === '')) { alert('Enter both latitude and longitude, or leave both empty.'); return; }
      if (lat !== '' && (Math.abs(Number(lat)) > 90 || Math.abs(Number(lng)) > 180)) { alert('Latitude/Longitude are out of range.'); return; }

      const lndSelect = document.getElementById('loc-lnd-select');
      const locObj = {
        locationId: locId,
        workLocationName: document.getElementById('loc-name-input').value.trim(),
        description: document.getElementById('loc-desc-input').value.trim(),
        landownerId: lndSelect.value,
        landownerName: lndSelect.options[lndSelect.selectedIndex]?.getAttribute('data-name') || '',
        supervisorId: document.getElementById('loc-sup-select').value,
        status: document.getElementById('loc-status-select').value,
        latitude: lat === '' ? '' : Number(lat),
        longitude: lng === '' ? '' : Number(lng),
        radiusMeters: radius === '' ? '' : Number(radius)
      };

      const ok = await this.saveMasterAndReport('SAVE_LOCATION', { location: locObj },
        `${isEdit ? 'Update' : 'Enroll'} location ${locObj.workLocationName}`, `Location ${locObj.workLocationName} saved.`);
      if (!ok) return;
      await db.put('locations', locObj);
      this.renderLocationsView(document.getElementById('view-content-root'));
    });
  }

  /* ==========================================================================
     ADMIN MODULE 5: USER ACCOUNTS & MANAGEMENT
     ========================================================================== */
  async renderUsersView(container) {
    const users = await db.getAll('users');
    const me = auth.getCurrentUser() || {};

    container.innerHTML = `
      <div class="content-card">
        <div class="card-header">
          <h3 class="card-title">Add Administrator Account</h3>
        </div>
        <div class="card-body">
          <form id="new-admin-form" class="form-row" style="align-items:flex-end;">
            <div class="form-group">
              <label class="form-label required">Username</label>
              <input type="text" id="new-admin-user" class="form-control" required autocomplete="off" />
            </div>
            <div class="form-group">
              <label class="form-label required">Temporary Password (min. 8)</label>
              <input type="password" id="new-admin-pass" class="form-control" required autocomplete="new-password" />
            </div>
            <div class="form-group">
              <button type="submit" class="btn btn-primary" style="width:100%">Create Admin</button>
            </div>
          </form>
          <div class="form-helper">Supervisor logins are created on the Supervisors page.</div>
        </div>
      </div>

      <div class="content-card">
        <div class="card-header">
          <h3 class="card-title">User Accounts & Authentication</h3>
        </div>
        <div class="card-body">
          <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 16px;">
            Passwords are stored salted and hashed on the server. A deactivated account is blocked immediately online,
            and is also blocked offline the next time that phone connects.
          </p>
          <div class="table-responsive">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Photo</th>
                  <th>User ID</th>
                  <th>Username</th>
                  <th>Role</th>
                  <th>Linked Supervisor</th>
                  <th>Status</th>
                  <th>Last Login</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                ${users.map((u) => `
                  <tr>
                    <td>${this.avatarHtml('USER', u.userId, u.username, 40, { onclick: `app.openProfilePhotoModal('USER', '${this.escape(u.userId)}', '${this.escape(u.username)}')` })}</td>
                    <td><small style="font-family: monospace;">${this.escape(u.userId)}</small></td>
                    <td><strong>${this.escape(u.username)}</strong>${String(u.mustChangePassword).toUpperCase() === 'TRUE' ? '<small style="display:block;color:#b45309;">must change password</small>' : ''}</td>
                    <td><span class="status-pill status-online">${this.escape(u.role)}</span></td>
                    <td>${this.escape(u.linkedSupervisorId || 'None (Admin)')}</td>
                    <td><span class="status-pill ${u.accountStatus === 'Active' ? 'status-online' : 'status-offline'}">${this.escape(u.accountStatus)}</span></td>
                    <td><small>${this.escape(u.lastLogin ? new Date(u.lastLogin).toLocaleString() : 'Never')}</small></td>
                    <td style="white-space:nowrap;">
                      <button class="btn btn-outline" style="padding: 4px 8px; font-size: 11px;" data-reset="${this.escape(u.userId)}">Reset Password</button>
                      ${u.userId === me.userId ? '' : `<button class="btn ${u.accountStatus === 'Active' ? 'btn-danger' : 'btn-outline'}" style="padding: 4px 8px; font-size: 11px;" data-toggle="${this.escape(u.userId)}">${u.accountStatus === 'Active' ? 'Deactivate' : 'Activate'}</button>`}
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;

    const byId = (id) => users.find((u) => String(u.userId) === String(id));
    container.querySelectorAll('button[data-reset]').forEach((b) => b.addEventListener('click', () => this.promptResetPassword(byId(b.dataset.reset))));
    container.querySelectorAll('button[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
      const u = byId(b.dataset.toggle);
      const next = u.accountStatus === 'Active' ? 'Inactive' : 'Active';
      if (!confirm(`${next === 'Inactive' ? 'Deactivate' : 'Activate'} ${u.username}?`)) return;
      if (!(await api.isReachable())) { alert('Changing account status needs internet so it takes effect right away.'); return; }
      try {
        await api.call('SAVE_USER', { user: { userId: u.userId, username: u.username, role: u.role, linkedSupervisorId: u.linkedSupervisorId, accountStatus: next } });
        u.accountStatus = next;
        await db.put('users', u);
        if (u.linkedSupervisorId) {
          const sup = await db.get('supervisors', u.linkedSupervisorId);
          if (sup) { sup.accountStatus = next; await db.put('supervisors', sup); }
        }
        this.showToast(`${u.username} is now ${next}.`, 'success');
        this.renderUsersView(document.getElementById('view-content-root'));
      } catch (err) {
        this.showToast(`Not saved: ${err.message}`, 'error');
      }
    }));

    document.getElementById('new-admin-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('new-admin-user').value.trim();
      const pass = document.getElementById('new-admin-pass').value;
      if (!/^[A-Za-z0-9._-]{3,30}$/.test(username)) { alert('Username: 3-30 letters, numbers, dot, dash or underscore.'); return; }
      if (pass.length < 8) { alert('Password must be at least 8 characters.'); return; }
      if (!(await api.isReachable())) { alert('Creating accounts needs internet.'); return; }
      try {
        const res = await api.call('SAVE_USER', { user: { username, role: 'Admin', accountStatus: 'Active', newPasswordHash: await auth.hashPassword(pass) } });
        await db.put('users', res.user);
        this.showToast(`Admin ${username} created. They must change the password at first login.`, 'success');
        this.renderUsersView(document.getElementById('view-content-root'));
      } catch (err) {
        this.showToast(`Not saved: ${err.message}`, 'error');
      }
    });
  }

  async promptResetPassword(user) {
    if (!user) return;
    const newPass = prompt(`Enter a temporary password for ${user.username} (min. 8 characters).\nThey will be asked to change it at next login.`);
    if (!newPass) return;
    if (newPass.trim().length < 8) { alert('Password must be at least 8 characters.'); return; }
    if (!(await api.isReachable())) { alert('Resetting a password needs internet.'); return; }
    try {
      const res = await api.call('SAVE_USER', {
        user: {
          userId: user.userId, username: user.username, role: user.role,
          linkedSupervisorId: user.linkedSupervisorId, accountStatus: user.accountStatus,
          newPasswordHash: await auth.hashPassword(newPass.trim())
        }
      });
      await db.put('users', res.user);
      this.showToast(`Temporary password set for ${user.username}.`, 'success');
      this.renderUsersView(document.getElementById('view-content-root'));
    } catch (err) {
      this.showToast(`Not saved: ${err.message}`, 'error');
    }
  }

  /* ==========================================================================
     ADMIN MODULE 6: AUDIT TRAIL LOGS
     ========================================================================== */
  async renderAuditView(container) {
    container.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-muted);">Loading audit logs…</div>`;
    let logs = [];
    let source = 'server';
    if (await api.isReachable()) {
      try {
        logs = (await api.call('GET_AUDIT_LOGS', { limit: 500 })).logs || [];
      } catch (e) {
        source = 'phone';
      }
    } else {
      source = 'phone';
    }
    if (source === 'phone') {
      logs = await db.getAll('auditLogs');
      logs.sort((a, b) => (b.dateTime > a.dateTime ? 1 : -1));
    }

    container.innerHTML = `
      <div class="content-card">
        <div class="card-header">
          <h3 class="card-title">System Audit Logs & Adjustments</h3>
          <span class="status-pill status-online">${logs.length} Entries ${source === 'server' ? '(latest from Google Sheets)' : '(this phone only – go online for all)'}</span>
        </div>
        <div class="toolbar" style="padding: 12px 16px 0;">
          <div class="search-input-wrapper">
            <input type="text" id="audit-search" class="search-input" placeholder="Search action, user, record, reason…" />
          </div>
        </div>
        <div class="card-body" style="padding: 0;">
          <div class="table-responsive">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Action</th>
                  <th>User ID / Role</th>
                  <th>Record ID</th>
                  <th>Before → After</th>
                  <th>Reason / Details</th>
                </tr>
              </thead>
              <tbody id="audit-body"></tbody>
            </table>
          </div>
        </div>
      </div>
    `;

    const short = (v) => {
      const t = String(v || '');
      return t.length > 140 ? t.slice(0, 140) + '…' : t;
    };
    const render = () => {
      const q = (document.getElementById('audit-search').value || '').toLowerCase();
      const rows = logs.filter((l) => !q || JSON.stringify(l).toLowerCase().includes(q));
      document.getElementById('audit-body').innerHTML = rows.length === 0
        ? `<tr><td colspan="6" style="text-align: center; padding: 32px; color: var(--text-muted);">No audit entries.</td></tr>`
        : rows.map((log) => `
          <tr>
            <td><small>${this.escape(log.dateTime ? new Date(log.dateTime).toLocaleString() : '-')}</small></td>
            <td><strong>${this.escape(log.action)}</strong></td>
            <td>${this.escape(log.userId || '-')} (${this.escape(log.userRole || '-')})</td>
            <td><small style="font-family: monospace;">${this.escape(log.recordId || '-')}</small></td>
            <td><small style="color:var(--text-muted)">${this.escape(short(log.previousValue))}${log.previousValue || log.newValue ? ' → ' : ''}${this.escape(short(log.newValue))}</small></td>
            <td>${this.escape(log.reason || '-')}</td>
          </tr>`).join('');
    };
    document.getElementById('audit-search').addEventListener('input', render);
    render();
  }

  /* ==========================================================================
     CUT-OFF SUMMARY (per person: present, absent, leave, late, hours, OT)
     Admin: all manpower (optional supervisor / location filter)
     Supervisor: only the manpower assigned to them
     ========================================================================== */

  // Default = the current payroll cut-off: 1-15 or 16-end of month
  currentCutoff(ref) {
    const d = ref ? new Date(ref + 'T00:00:00') : new Date();
    const y = d.getFullYear(), m = d.getMonth();
    const last = new Date(y, m + 1, 0).getDate();
    const p = (n) => String(n).padStart(2, '0');
    const ym = `${y}-${p(m + 1)}`;
    return d.getDate() <= 15 ? { from: `${ym}-01`, to: `${ym}-15` } : { from: `${ym}-16`, to: `${ym}-${p(last)}` };
  }

  previousCutoff(fromStr) {
    return this.currentCutoff(this.shiftDate(fromStr, -1));
  }

  getCutoffState() {
    if (!this.cutoff) this.cutoff = Object.assign({ supervisorId: '', location: '' }, this.currentCutoff());
    return this.cutoff;
  }

  async loadAttendanceForRange(from, to) {
    // Use the server when online (covers dates older than what the phone keeps). Cached for 60 s.
    const key = `${from}|${to}`;
    let remote = null;
    if (this._rangeCache && this._rangeCache.key === key && Date.now() - this._rangeCache.at < 60000) {
      remote = this._rangeCache.data;
    } else if (auth.getCurrentUser() && auth.getCurrentUser().token && (await api.isReachable())) {
      try {
        remote = (await api.call('GET_ATTENDANCE_RANGE', { from, to })).attendance;
        this._rangeCache = { key, at: Date.now(), data: remote };
      } catch (e) { remote = null; }
    }
    const local = (await db.getAll('attendance')).filter((a) => this.ymd(a.attendanceDate) >= from && this.ymd(a.attendanceDate) <= to);
    if (!remote) return { records: local, source: 'phone' };
    // Server data + local changes that are not uploaded yet
    const map = new Map(remote.map((r) => [r.attendanceRecordId, r]));
    local.forEach((l) => { if (l.syncStatus !== 'SYNCED' || !map.has(l.attendanceRecordId)) map.set(l.attendanceRecordId, l); });
    return { records: [...map.values()], source: 'server' };
  }

  /** Minutes late for one Time IN (0 = on time). Counted from the schedule start once past the grace period. */
  lateMinutes(timeIn, settings) {
    const t = this.timeToMinutes(timeIn);
    const start = this.timeToMinutes(settings.workStartTime || '07:00 AM');
    if (t === null || start === null) return 0;
    const late = t - start;
    return late > Number(settings.lateGraceMinutes || 0) ? late : 0;
  }

  fmtMinutes(min) {
    if (!min) return '0';
    const h = Math.floor(min / 60), m = min % 60;
    return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
  }

  /** Builds the per-person summary for a date range. */
  async computeCutoffSummary({ from, to, supervisorId, location }) {
    const settings = await auth.getAppSettings();
    const today = this.todayStr();
    const restDay = Number(settings.restDay);

    // Working days in the range, up to today, without the rest day
    const workDays = [];
    for (let d = from; d <= to && d <= today; d = this.shiftDate(d, 1)) {
      const [y, m, dd] = d.split('-').map(Number);
      if (new Date(y, m - 1, dd).getDay() !== restDay) workDays.push(d);
    }

    const [{ records, source }, allEmployees, supervisors] = await Promise.all([
      this.loadAttendanceForRange(from, to), db.getAll('employees'), db.getAll('supervisors')
    ]);
    const supName = new Map(supervisors.map((s) => [String(s.supervisorId), s.supervisorName]));

    // Role scoping: a supervisor only ever sees their own manpower
    let sup = supervisorId;
    if (!auth.isAdmin()) sup = String(auth.getLinkedSupervisorId() || '');
    let employees = allEmployees;
    if (sup) employees = employees.filter((e) => String(e.supervisorId || '') === String(sup));
    if (location) employees = employees.filter((e) => (e.workLocation || '') === location);

    const active = records.filter((r) => r.recordStatus !== 'DELETED');
    const byEmp = new Map();
    active.forEach((r) => {
      const k = String(r.employeeId);
      if (!byEmp.has(k)) byEmp.set(k, []);
      byEmp.get(k).push(r);
    });

    const rows = employees
      .filter((e) => (e.employmentStatus || 'Active') === 'Active' || byEmp.has(String(e.employeeId)))
      .map((e) => {
        const recs = byEmp.get(String(e.employeeId)) || [];
        const byDate = new Map();
        recs.forEach((r) => byDate.set(this.ymd(r.attendanceDate), r));
        const enrolled = e.dateEnrolled || '0000-00-00';

        let present = 0, leave = 0, absent = 0, lateCount = 0, lateMin = 0, hours = 0, ot = 0, noOut = 0, flagged = 0;
        const days = [];
        const allDates = new Set([...workDays, ...byDate.keys()]);
        [...allDates].sort().forEach((d) => {
          if (d > today) return;
          const r = byDate.get(d);
          if (r && this.isLeave(r)) {
            leave++;
            days.push({ date: d, status: 'LEAVE', note: r.leaveType || 'Leave' });
          } else if (r && r.timeIn) {
            present++;
            const lm = this.lateMinutes(r.timeIn, settings);
            if (lm) { lateCount++; lateMin += lm; }
            const h = r.hoursWorked !== undefined && r.hoursWorked !== '' && r.hoursWorked !== null
              ? { hours: Number(r.hoursWorked), overtime: Number(r.overtimeHours) || 0 }
              : this.computeHours(r.timeIn, r.timeOut, settings);
            if (h.hours === '' || isNaN(h.hours)) noOut++; else { hours += h.hours; ot += h.overtime; }
            if (String(r.geofenceIn || '').startsWith('OUTSIDE') || String(r.geofenceOut || '').startsWith('OUTSIDE') || r.clockFlag) flagged++;
            days.push({ date: d, status: 'PRESENT', timeIn: r.timeIn, timeOut: r.timeOut, late: lm, hours: h.hours, adjusted: !!r.adjustedBy });
          } else if (workDays.includes(d) && d >= enrolled) {
            absent++;
            days.push({ date: d, status: 'ABSENT' });
          }
        });

        const expected = present + absent;
        return {
          id: String(e.employeeId), name: e.employeeName,
          supId: String(e.supervisorId || ''), sup: supName.get(String(e.supervisorId || '')) || e.supervisorName || 'Unassigned',
          loc: e.workLocation || '',
          present, absent, leave, lateCount, lateMin,
          hours: Math.round(hours * 100) / 100, ot: Math.round(ot * 100) / 100,
          noOut, flagged, rate: expected ? Math.round((present / expected) * 100) : 0, days
        };
      })
      .sort((a, b) => a.sup.localeCompare(b.sup) || a.name.localeCompare(b.name));

    const totals = rows.reduce((t, r) => {
      ['present', 'absent', 'leave', 'lateCount', 'lateMin', 'hours', 'ot', 'noOut', 'flagged'].forEach((k) => { t[k] += r[k]; });
      return t;
    }, { present: 0, absent: 0, leave: 0, lateCount: 0, lateMin: 0, hours: 0, ot: 0, noOut: 0, flagged: 0 });
    totals.hours = Math.round(totals.hours * 100) / 100;
    totals.ot = Math.round(totals.ot * 100) / 100;
    totals.manpower = rows.length;
    totals.rate = totals.present + totals.absent ? Math.round((totals.present / (totals.present + totals.absent)) * 100) : 0;

    // Per-supervisor subtotals (admin)
    const groups = new Map();
    rows.forEach((r) => {
      if (!groups.has(r.supId)) groups.set(r.supId, { id: r.supId, name: r.sup, manpower: 0, present: 0, absent: 0, leave: 0, lateCount: 0, lateMin: 0, hours: 0 });
      const g = groups.get(r.supId);
      g.manpower++; g.present += r.present; g.absent += r.absent; g.leave += r.leave;
      g.lateCount += r.lateCount; g.lateMin += r.lateMin; g.hours += r.hours;
    });

    return { from, to, rows, totals, groups: [...groups.values()], workDays: workDays.length, source, settings };
  }

  /** Renders the cut-off summary into `host`. Used on both dashboards and on the Cut-off Summary page. */
  async renderCutoffSection(host, { compact = false } = {}) {
    if (!host) return;
    const st = this.getCutoffState();
    const isAdmin = auth.isAdmin();
    const [supervisors, employees] = await Promise.all([db.getAll('supervisors'), db.getAll('employees')]);
    const locs = [...new Set(employees.filter((e) => isAdmin || String(e.supervisorId) === String(auth.getLinkedSupervisorId())).map((e) => e.workLocation).filter(Boolean))].sort();
    const prev = this.previousCutoff(st.from);
    const cur = this.currentCutoff();

    host.innerHTML = `
      <div class="content-card cutoff-card">
        <div class="card-header" style="flex-wrap:wrap; gap:8px;">
          <h3 class="card-title">📅 Cut-off Summary ${isAdmin ? '– All Manpower' : '– My Manpower'}</h3>
          <span style="font-size:12px;color:var(--text-muted)" id="cutoff-range-label"></span>
        </div>
        <div class="card-body">
          <div class="toolbar cutoff-tools" style="margin-bottom:12px;">
            <label class="cutoff-field">From <input type="date" id="cutoff-from" class="select-filter" value="${st.from}" max="${this.todayStr()}" /></label>
            <label class="cutoff-field">To <input type="date" id="cutoff-to" class="select-filter" value="${st.to}" /></label>
            <select id="cutoff-preset" class="select-filter">
              <option value="">Quick select…</option>
              <option value="cur">This cut-off (${cur.from.slice(5)} → ${cur.to.slice(5)})</option>
              <option value="prev">Previous cut-off (${prev.from.slice(5)} → ${prev.to.slice(5)})</option>
              <option value="month">This whole month</option>
              <option value="lastmonth">Last month</option>
            </select>
            ${isAdmin ? `<select id="cutoff-sup" class="select-filter">
              <option value="">All Supervisors</option>
              ${supervisors.map((s) => `<option value="${this.escape(s.supervisorId)}" ${String(st.supervisorId) === String(s.supervisorId) ? 'selected' : ''}>${this.escape(s.supervisorName)}</option>`).join('')}
            </select>` : ''}
            ${locs.length > 1 ? `<select id="cutoff-loc" class="select-filter">
              <option value="">All Locations</option>
              ${locs.map((l) => `<option value="${this.escape(l)}" ${st.location === l ? 'selected' : ''}>${this.escape(l)}</option>`).join('')}
            </select>` : ''}
            <button class="btn btn-primary" id="cutoff-run">Show</button>
            <button class="btn btn-outline" id="cutoff-csv">⬇ Export CSV</button>
          </div>
          <div id="cutoff-out"><div style="text-align:center;padding:24px;color:var(--text-muted);">Calculating…</div></div>
        </div>
      </div>
    `;

    const readInputs = () => {
      st.from = host.querySelector('#cutoff-from').value;
      st.to = host.querySelector('#cutoff-to').value;
      st.supervisorId = isAdmin ? (host.querySelector('#cutoff-sup')?.value || '') : '';
      st.location = host.querySelector('#cutoff-loc')?.value || '';
    };
    const run = async () => {
      readInputs();
      const out = host.querySelector('#cutoff-out');
      if (!st.from || !st.to) { out.innerHTML = '<div class="alert-banner warn">Choose both dates.</div>'; return; }
      if (st.to < st.from) { out.innerHTML = '<div class="alert-banner warn">"To" date must be on or after the "From" date.</div>'; return; }
      const span = (Date.parse(st.to) - Date.parse(st.from)) / 86400000;
      if (span > 92) { out.innerHTML = '<div class="alert-banner warn">Please choose at most 3 months at a time.</div>'; return; }
      out.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted);">Calculating…</div>';
      const data = await this.computeCutoffSummary(st);
      this.lastCutoff = data;
      this.renderCutoffResult(host, data, compact);
    };

    host.querySelector('#cutoff-preset').addEventListener('change', (ev) => {
      const v = ev.target.value;
      const t = this.todayStr();
      let r = null;
      if (v === 'cur') r = this.currentCutoff();
      if (v === 'prev') r = this.previousCutoff(this.currentCutoff().from);
      if (v === 'month' || v === 'lastmonth') {
        const base = v === 'month' ? t : this.shiftDate(t.slice(0, 8) + '01', -1);
        const [y, m] = base.split('-').map(Number);
        r = { from: `${base.slice(0, 7)}-01`, to: `${base.slice(0, 7)}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}` };
      }
      if (r) {
        host.querySelector('#cutoff-from').value = r.from;
        host.querySelector('#cutoff-to').value = r.to;
        run();
      }
      ev.target.value = '';
    });
    host.querySelector('#cutoff-run').addEventListener('click', run);
    ['#cutoff-sup', '#cutoff-loc'].forEach((sel) => { const el = host.querySelector(sel); if (el) el.addEventListener('change', run); });
    host.querySelector('#cutoff-csv').addEventListener('click', () => this.exportCutoffCsv());
    run();
  }

  renderCutoffResult(host, data, compact) {
    const { rows, totals, groups, settings } = data;
    const isAdmin = auth.isAdmin();
    const pretty = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
    host.querySelector('#cutoff-range-label').textContent = `${pretty(data.from)} – ${pretty(data.to)} • ${data.workDays} working day(s) so far`;
    const out = host.querySelector('#cutoff-out');

    const showGroups = isAdmin && !this.cutoff.supervisorId && groups.length > 1;
    out.innerHTML = `
      ${data.source === 'phone' ? '<div class="alert-banner warn">Offline: using only the records saved on this phone. Go online for the complete cut-off.</div>' : ''}
      <div class="metrics-grid">
        <div class="metric-card"><span class="metric-title">${isAdmin ? 'Total Manpower' : 'My Manpower'}</span><div class="metric-value">${totals.manpower}</div></div>
        <div class="metric-card"><span class="metric-title">Present (man-days)</span><div class="metric-value" style="color:var(--primary)">${totals.present}</div></div>
        <div class="metric-card"><span class="metric-title">Absent (man-days)</span><div class="metric-value" style="color:var(--accent-red)">${totals.absent}</div></div>
        <div class="metric-card"><span class="metric-title">Leave (man-days)</span><div class="metric-value" style="color:#b45309">${totals.leave}</div></div>
        <div class="metric-card"><span class="metric-title">Total Late</span><div class="metric-value" style="color:#b45309">${totals.lateCount}<small style="font-size:13px;color:var(--text-muted)"> times · ${this.fmtMinutes(totals.lateMin)}</small></div></div>
        <div class="metric-card"><span class="metric-title">Attendance Rate</span><div class="metric-value">${totals.rate}%</div></div>
      </div>

      ${showGroups ? `
      <div class="table-responsive" style="margin-bottom:16px;">
        <table class="data-table keep-table">
          <thead><tr><th>Supervisor</th><th>Manpower</th><th>Present</th><th>Absent</th><th>Leave</th><th>Late</th><th>Late Time</th><th>Hours</th></tr></thead>
          <tbody>
            ${groups.map((g) => `
              <tr class="clickable-row" data-supfilter="${this.escape(g.id)}">
                <td><span class="name-with-avatar">${(() => { const k = this.supervisorAvatarKey(g.id); return this.avatarHtml(k ? k.type : '', k ? k.id : '', g.name, 28); })()}<strong>${this.escape(g.name)}</strong></span></td><td>${g.manpower}</td>
                <td style="color:var(--primary);font-weight:700">${g.present}</td>
                <td style="color:var(--accent-red);font-weight:700">${g.absent}</td>
                <td>${g.leave}</td><td>${g.lateCount}</td><td>${this.fmtMinutes(g.lateMin)}</td><td>${Math.round(g.hours * 10) / 10}</td>
              </tr>`).join('')}
            <tr class="total-row"><td><strong>TOTAL</strong></td><td><strong>${totals.manpower}</strong></td><td><strong>${totals.present}</strong></td><td><strong>${totals.absent}</strong></td><td><strong>${totals.leave}</strong></td><td><strong>${totals.lateCount}</strong></td><td><strong>${this.fmtMinutes(totals.lateMin)}</strong></td><td><strong>${Math.round(totals.hours * 10) / 10}</strong></td></tr>
          </tbody>
        </table>
      </div>` : ''}

      <div class="search-input-wrapper" style="margin-bottom:10px; max-width:340px;">
        <input type="text" class="search-input" id="cutoff-search" placeholder="Search name or ID…" />
      </div>
      <div class="table-responsive">
        <table class="data-table">
          <thead><tr>
            <th>Employee ID</th><th>Name</th>${isAdmin ? '<th>Supervisor</th>' : ''}<th>Present</th><th>Absent</th><th>Leave</th>
            <th>Late (times)</th><th>Late Time</th><th>Hours</th><th>OT</th>${compact ? '' : '<th>No Time OUT</th><th>Flagged</th>'}<th></th>
          </tr></thead>
          <tbody id="cutoff-rows"></tbody>
        </table>
      </div>
      <div class="form-helper" style="margin-top:8px;">
        Late = Time IN after ${this.escape(settings.workStartTime || '07:00 AM')}${Number(settings.lateGraceMinutes) ? ` + ${settings.lateGraceMinutes} min grace (late time is counted from ${this.escape(settings.workStartTime || '07:00 AM')})` : ''}.
        Absent = working day with no Time IN and no leave (rest day and days before enrollment are not counted). Tap a person to see each day.
      </div>
    `;

    const draw = () => {
      const q = (out.querySelector('#cutoff-search').value || '').toLowerCase();
      const list = rows.filter((r) => !q || r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q));
      out.querySelector('#cutoff-rows').innerHTML = list.length === 0
        ? `<tr><td colspan="13" style="text-align:center;padding:24px;color:var(--text-muted)">No manpower found.</td></tr>`
        : list.map((r) => `
          <tr class="clickable-row" data-emp="${this.escape(r.id)}">
            <td><span class="emp-id-badge">${this.escape(r.id)}</span></td>
            <td><span class="name-with-avatar">${this.avatarHtml('EMPLOYEE', r.id, r.name, 28)}<strong>${this.escape(r.name)}</strong></span></td>
            ${isAdmin ? `<td>${this.escape(r.sup)}</td>` : ''}
            <td><strong style="color:var(--primary)">${r.present}</strong></td>
            <td>${r.absent ? `<strong style="color:var(--accent-red)">${r.absent}</strong>` : '0'}</td>
            <td>${r.leave || '0'}</td>
            <td>${r.lateCount ? `<span class="flag-pill flag-warn">${r.lateCount}</span>` : '0'}</td>
            <td>${r.lateMin ? this.fmtMinutes(r.lateMin) : '-'}</td>
            <td>${r.hours}</td>
            <td>${r.ot || '-'}</td>
            ${compact ? '' : `<td>${r.noOut ? `<span class="flag-pill flag-warn">${r.noOut}</span>` : '-'}</td><td>${r.flagged ? `<span class="flag-pill flag-bad">${r.flagged}</span>` : '-'}</td>`}
            <td><button class="btn btn-outline view-btn">Days ›</button></td>
          </tr>`).join('');
      out.querySelectorAll('tr[data-emp]').forEach((tr) => tr.addEventListener('click', () => this.showCutoffPersonDetail(tr.dataset.emp)));
    };
    out.querySelector('#cutoff-search').addEventListener('input', draw);
    out.querySelectorAll('tr[data-supfilter]').forEach((tr) => tr.addEventListener('click', () => {
      const sel = host.querySelector('#cutoff-sup');
      if (sel) { sel.value = tr.dataset.supfilter; sel.dispatchEvent(new Event('change')); }
    }));
    draw();
  }

  showCutoffPersonDetail(empId) {
    const data = this.lastCutoff;
    if (!data) return;
    const r = data.rows.find((x) => x.id === empId);
    if (!r) return;
    const dayName = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric' });
    this.showGenericModal({
      title: `${r.name} (${r.id})`,
      body: `
        <div style="display:flex;justify-content:center;margin-bottom:8px;">${this.avatarHtml('EMPLOYEE', r.id, r.name, 72)}</div>
        <div style="font-size:13px;color:var(--text-muted);margin-bottom:10px;">${this.escape(data.from)} → ${this.escape(data.to)} • ${this.escape(r.sup)} • ${this.escape(r.loc)}</div>
        <div class="metrics-grid" style="margin-bottom:12px;">
          <div class="metric-card"><span class="metric-title">Present</span><div class="metric-value" style="color:var(--primary)">${r.present}</div></div>
          <div class="metric-card"><span class="metric-title">Absent</span><div class="metric-value" style="color:var(--accent-red)">${r.absent}</div></div>
          <div class="metric-card"><span class="metric-title">Late</span><div class="metric-value" style="color:#b45309">${r.lateCount}<small style="font-size:12px"> · ${this.fmtMinutes(r.lateMin)}</small></div></div>
        </div>
        <div class="table-responsive"><table class="data-table keep-table">
          <thead><tr><th>Date</th><th>Status</th><th>IN</th><th>OUT</th><th>Late</th><th>Hours</th></tr></thead>
          <tbody>${r.days.length === 0 ? '<tr><td colspan="6" style="text-align:center;padding:16px;">No working days in this range yet.</td></tr>' : r.days.map((d) => `
            <tr>
              <td>${dayName(d.date)}</td>
              <td>${d.status === 'PRESENT' ? '<span class="flag-pill flag-ok">Present</span>' : d.status === 'LEAVE' ? `<span class="status-pill badge-leave">${this.escape(d.note)}</span>` : '<span class="flag-pill flag-bad">Absent</span>'}${d.adjusted ? ' <span class="flag-pill flag-warn">Adj</span>' : ''}</td>
              <td>${this.escape(d.timeIn || '-')}</td>
              <td>${this.escape(d.timeOut || '-')}</td>
              <td>${d.late ? `<strong style="color:#b45309">${this.fmtMinutes(d.late)}</strong>` : '-'}</td>
              <td>${d.hours !== undefined && d.hours !== '' ? d.hours : '-'}</td>
            </tr>`).join('')}
          </tbody>
        </table></div>`
    });
  }

  exportCutoffCsv() {
    const data = this.lastCutoff;
    if (!data || !data.rows.length) { alert('Nothing to export yet.'); return; }
    const head = ['Cut-off From', 'Cut-off To', 'Employee ID', 'Employee Name', 'Supervisor', 'Work Location', 'Working Days',
      'Days Present', 'Days Absent', 'Days Leave', 'Times Late', 'Late Minutes', 'Total Hours', 'Overtime Hours', 'Days Without Time OUT', 'Flagged Days', 'Attendance Rate %'];
    const lines = data.rows.map((r) => [data.from, data.to, r.id, r.name, r.sup, r.loc, data.workDays, r.present, r.absent, r.leave,
      r.lateCount, r.lateMin, r.hours, r.ot, r.noOut, r.flagged, r.rate].map((v) => this.csvCell(v)).join(','));
    const t = data.totals;
    lines.push(['', '', '', 'TOTAL', '', '', '', t.present, t.absent, t.leave, t.lateCount, t.lateMin, t.hours, t.ot, t.noOut, t.flagged, t.rate].map((v) => this.csvCell(v)).join(','));
    this.downloadText('﻿' + [head.map((h) => this.csvCell(h)).join(','), ...lines].join('\r\n'), `Cutoff_Summary_${data.from}_to_${data.to}.csv`);
  }

  async renderReportsView(container) {
    container.innerHTML = '<div id="cutoff-page-host"></div>';
    this.renderCutoffSection(document.getElementById('cutoff-page-host'));
  }

  /* ==========================================================================
     ADMIN: PHOTO, GPS & PAY RULES
     ========================================================================== */
  async renderAppSettingsView(container) {
    const s = await auth.getAppSettings();
    const opt = (val, cur, label) => `<option value="${val}" ${String(val) === String(cur) ? 'selected' : ''}>${label}</option>`;
    container.innerHTML = `
      <div class="content-card">
        <div class="card-header"><h3 class="card-title">Rules for all phones</h3><span style="font-size:12px;color:var(--text-muted)">Phones receive changes at their next sync.</span></div>
        <div class="card-body">
          <form id="rules-form">
            <h4 style="font-size:14px;margin-bottom:8px;">📷 Time IN / Time OUT photo</h4>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Photo</label>
                <select id="r-photoMode" class="form-control">
                  ${opt('required', s.photoMode, 'Required (cannot skip)')}
                  ${opt('optional', s.photoMode, 'Optional (Skip button shown)')}
                  ${opt('off', s.photoMode, 'Off (no photo)')}
                </select>
                <div class="form-helper">Photos are watermarked with time, date, employee, area and GPS, then saved to Google Drive.</div>
              </div>
            </div>

            <h4 style="font-size:14px;margin:12px 0 8px;">📍 Geofence</h4>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">When outside the work area</label>
                <select id="r-geofenceMode" class="form-control">
                  ${opt('warn', s.geofenceMode, 'Warn and flag (recommended)')}
                  ${opt('block', s.geofenceMode, 'Block Time IN / OUT')}
                  ${opt('off', s.geofenceMode, 'Off')}
                </select>
              </div>
              <div class="form-group">
                <label class="form-label">Default radius (m)</label>
                <input type="number" id="r-defaultRadiusMeters" class="form-control" min="10" max="20000" value="${this.escape(s.defaultRadiusMeters)}" />
                <div class="form-helper">Used when a location has no radius.</div>
              </div>
              <div class="form-group">
                <label class="form-label">Weak GPS above (m)</label>
                <input type="number" id="r-maxGpsAccuracyMeters" class="form-control" min="5" max="5000" value="${this.escape(s.maxGpsAccuracyMeters)}" />
              </div>
            </div>

            <h4 style="font-size:14px;margin:12px 0 8px;">⏱ Schedule, late, hours & overtime</h4>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Work starts at</label>
                <input type="text" id="r-workStartTime" class="form-control" placeholder="07:00 AM" value="${this.escape(s.workStartTime)}" />
                <div class="form-helper">Time IN after this (plus grace) counts as late.</div>
              </div>
              <div class="form-group">
                <label class="form-label">Grace period (minutes)</label>
                <input type="number" id="r-lateGraceMinutes" class="form-control" min="0" max="120" value="${this.escape(s.lateGraceMinutes)}" />
                <div class="form-helper">e.g. 15 = 07:15 is still on time, 07:16 is 16 min late.</div>
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Regular hours per day</label>
                <input type="number" step="0.5" id="r-regularHours" class="form-control" min="1" max="24" value="${this.escape(s.regularHours)}" />
              </div>
              <div class="form-group">
                <label class="form-label">Unpaid break (minutes)</label>
                <input type="number" id="r-breakMinutes" class="form-control" min="0" max="240" value="${this.escape(s.breakMinutes)}" />
              </div>
              <div class="form-group">
                <label class="form-label">Deduct break when day is at least (hours)</label>
                <input type="number" step="0.5" id="r-breakAfterHours" class="form-control" min="0" max="24" value="${this.escape(s.breakAfterHours)}" />
              </div>
              <div class="form-group">
                <label class="form-label">Rest day (not counted as absent)</label>
                <select id="r-restDay" class="form-control">
                  ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => opt(i, s.restDay, d)).join('')}
                  ${opt(-1, s.restDay, 'No rest day')}
                </select>
              </div>
            </div>

            <h4 style="font-size:14px;margin:12px 0 8px;">📱 Phones</h4>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Attendance days kept on phones</label>
                <input type="number" id="r-attendanceDays" class="form-control" min="7" max="366" value="${this.escape(s.attendanceDays)}" />
              </div>
              <div class="form-group">
                <label class="form-label">Offline login allowed for (days)</label>
                <input type="number" id="r-offlineLoginDays" class="form-control" min="1" max="90" value="${this.escape(s.offlineLoginDays)}" />
              </div>
              <div class="form-group">
                <label class="form-label">Flag phone clock off by more than (min)</label>
                <input type="number" id="r-maxClockDriftMinutes" class="form-control" min="1" max="120" value="${this.escape(s.maxClockDriftMinutes)}" />
              </div>
            </div>

            <div style="text-align:right;margin-top:10px;"><button type="submit" class="btn btn-primary">Save Rules</button></div>
          </form>
        </div>
      </div>
    `;

    document.getElementById('rules-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!(await api.isReachable())) { alert('Saving rules needs internet.'); return; }
      const startNorm = this.normalizeTime(document.getElementById('r-workStartTime').value);
      if (!startNorm) { alert('"Work starts at" must be a time like 07:00 AM.'); return; }
      document.getElementById('r-workStartTime').value = startNorm;
      const keys = ['workStartTime', 'lateGraceMinutes', 'photoMode', 'geofenceMode', 'defaultRadiusMeters', 'maxGpsAccuracyMeters', 'regularHours', 'breakMinutes', 'breakAfterHours', 'restDay', 'attendanceDays', 'offlineLoginDays', 'maxClockDriftMinutes'];
      const settings = {};
      keys.forEach((k) => {
        const v = document.getElementById(`r-${k}`).value;
        settings[k] = ['photoMode', 'geofenceMode', 'workStartTime'].includes(k) ? v : Number(v);
      });
      try {
        const res = await api.call('SAVE_APP_SETTINGS', { settings });
        await db.setSetting('appSettings', res.settings);
        this._rangeCache = null;
        this.showToast('Rules saved. Phones get them at their next sync.', 'success');
      } catch (err) {
        this.showToast(`Not saved: ${err.message}`, 'error');
      }
    });
  }

  /* ==========================================================================
     CHANGE PASSWORD (forced after first login / reset, or voluntary)
     ========================================================================== */
  openChangePasswordModal(forced) {
    this.showGenericModal({
      title: forced ? '🔒 Please set your own password' : '🔒 Change My Password',
      locked: forced,
      body: `
        ${forced ? '<div class="alert-banner warn">You are using a temporary password. Choose your own password to continue.</div>' : ''}
        <form id="pw-form" onsubmit="return false;">
          <div class="form-group">
            <label class="form-label required">Current password</label>
            <input type="password" id="pw-current" class="form-control" autocomplete="current-password" />
          </div>
          <div class="form-group">
            <label class="form-label required">New password (min. 8 characters)</label>
            <input type="password" id="pw-new" class="form-control" autocomplete="new-password" />
          </div>
          <div class="form-group">
            <label class="form-label required">Repeat new password</label>
            <input type="password" id="pw-new2" class="form-control" autocomplete="new-password" />
          </div>
          <div id="pw-error" class="alert-banner bad" style="display:none"></div>
        </form>`,
      footer: `
        ${forced ? `<button type="button" class="btn btn-outline" onclick="app.closeModal('generic-modal'); document.getElementById('logout-btn').click();">Sign out</button>` : `<button type="button" class="btn btn-outline" onclick="app.closeModal('generic-modal')">Cancel</button>`}
        <button type="button" class="btn btn-primary" id="pw-save">Save Password</button>`,
      onOpen: () => {
        document.getElementById('pw-save').onclick = async () => {
          const err = document.getElementById('pw-error');
          const show = (m) => { err.textContent = m; err.style.display = 'block'; };
          const cur = document.getElementById('pw-current').value;
          const n1 = document.getElementById('pw-new').value;
          const n2 = document.getElementById('pw-new2').value;
          if (n1 !== n2) return show('The new passwords do not match.');
          if (!(await api.isReachable())) return show('You need internet to change your password.');
          try {
            await auth.changePassword(cur, n1);
            this.closeModal('generic-modal');
            this.showToast('Password changed.', 'success');
            if (auth.isSupervisor() && (!this.sessionLandowner || !this.sessionLandowner.name)) {
              setTimeout(() => this.promptSelectSessionLandowner(), 300);
            }
          } catch (e) {
            show(e.message);
          }
        };
      }
    });
  }

  /* ==========================================================================
     SETTINGS & API CONFIGURATION MODAL
     ========================================================================== */
  async openSettingsModal() {
    const modal = document.getElementById('settings-modal');
    const input = document.getElementById('settings-api-url');
    if (!modal || !input) return;

    const currentUrl = await db.getSetting('apiUrl', '');
    input.value = currentUrl;
    const status = document.getElementById('settings-test-status');
    status.textContent = '';

    // Changing the server URL while logged in would mix data from two databases
    const loggedIn = !!auth.getCurrentUser();
    input.readOnly = loggedIn && !auth.isAdmin() && !!currentUrl;

    document.getElementById('save-settings-btn').onclick = async () => {
      const newUrl = input.value.trim();
      if (newUrl && !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(newUrl)) {
        status.textContent = 'This does not look like an Apps Script Web App URL (it should end with /exec).';
        status.style.color = 'var(--accent-red)';
        return;
      }
      await db.setSetting('apiUrl', newUrl);
      this.showToast('Google Apps Script API URL saved.', 'success');
      this.closeModal('settings-modal');
      if (newUrl && navigator.onLine && loggedIn) syncService.pullRemoteData();
    };

    document.getElementById('test-api-btn').onclick = async () => {
      const testUrl = input.value.trim();
      if (!testUrl) {
        alert('Please enter a Google Apps Script Web App URL first.');
        return;
      }
      status.textContent = 'Testing connection...';
      status.style.color = 'var(--text-muted)';
      try {
        const data = await api.call('PING', {}, { noToken: true, url: testUrl });
        status.textContent = `✓ Connected (server v${data.version || '?'}). Google Sheets database is ready.`;
        status.style.color = 'var(--primary)';
      } catch (err) {
        status.textContent = `Connection failed: ${err.message}`;
        status.style.color = 'var(--accent-red)';
      }
    };

    this.openModal('settings-modal');
  }

  // Modal Helpers
  openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.add('active');
  }

  closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.remove('active');
  }

  // HTML Entity Escaper for XSS safety
  escape(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}

// Global App Instance
const app = new AttendanceApp();

// Initialize on DOM load
window.addEventListener('DOMContentLoaded', () => {
  app.init();
});
