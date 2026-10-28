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

  async init() {
    console.log('[App] Initializing application...');

    // Initialize Database
    await db.init();

    // Check existing session
    const user = await auth.initSession();
    this.sessionLandowner = await db.getSetting('sessionLandowner', null);

    // Register Service Worker
    this.registerServiceWorker();

    // Start background GPS tracker
    this.initGpsTracking();

    // Bind event listeners
    this.bindEvents();

    // Subscribe to Sync updates
    syncService.subscribe((event) => this.handleSyncEvent(event));

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
    } else {
      this.showLoginView();
    }
  }

  // Register Service Worker for PWA & Offline Support
  registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js')
        .then((reg) => console.log('[SW] Service Worker registered. Scope:', reg.scope))
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

  handleSyncEvent(event) {
    if (event.type === 'NETWORK_CHANGE') {
      this.updateNetworkBadge();
      if (event.isOnline) {
        this.showToast('Internet connection restored. Synchronizing...', 'info');
      } else {
        this.showToast('You are offline. Attendance will be saved locally.', 'warning');
      }
    } else if (event.type === 'SYNC_COMPLETE') {
      this.showToast(event.count > 0 ? `Synchronized ${event.count} records!` : 'Database is up to date.', 'success');
      this.refreshCurrentView();
    } else if (event.type === 'SYNC_ERROR') {
      this.showToast(`Sync issue: ${event.error}`, 'error');
      this.refreshCurrentView();
    } else if (event.type === 'DATA_PULLED') {
      this.lastDataPull = new Date();
      this.validateSessionLandowner().then(() => this.refreshCurrentView());
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
    if (userAvatarEl) userAvatarEl.textContent = (user.name || user.username).charAt(0).toUpperCase();

    // Render navigation links based on Role
    this.renderNavigation();
    this.renderGpsPill();
    this.updateNetworkBadge();

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
    let workLoc = locInput ? locInput.value.trim() : '';

    const selectedOpt = select.options[select.selectedIndex];
    if (customInput && customInput.value.trim()) {
      lndName = customInput.value.trim();
      lndId = `LND-CUST-${Date.now()}`;
    } else if (selectedOpt && selectedOpt.value) {
      lndName = selectedOpt.value;
      lndId = selectedOpt.dataset.id || '';
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
      <div class="nav-item ${this.currentView === 'sync' ? 'active' : ''}" onclick="app.navigateTo('sync')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
        <span>Sync Dashboard</span>
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
      <div class="login-card" style="width: 100%; max-width: 440px; padding: 32px; background: #ffffff; border-radius: 16px; box-shadow: var(--shadow-lg); border: 1px solid var(--border);">
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
          <button type="button" class="btn btn-outline" style="font-size: 12px; padding: 4px 10px;" onclick="app.openSettingsModal()">
            ⚙ API Settings
          </button>
        </div>

        <div style="margin-top: 12px; font-size: 11px; color: var(--text-light); text-align: center;">
          Default setup login: <strong>admin</strong> / <strong>admin123</strong>
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
        const apiUrl = await db.getSetting('apiUrl', '');
        if (navigator.onLine && apiUrl && res.mode === 'online') {
          submitBtn.textContent = 'Loading your areas...';
          await syncService.pullRemoteData();
        }
        await this.validateSessionLandowner();

        this.showToast(res.message, res.mode === 'offline' ? 'warning' : 'success');
        this.renderAppShell();
        this.navigateTo('dashboard');

        // If supervisor logged in without selecting landowner, prompt them immediately
        if (auth.isSupervisor() && (!this.sessionLandowner || !this.sessionLandowner.name)) {
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
        <div class="content-card banner-card" style="background: linear-gradient(135deg, #15803d, #16a34a); color: #ffffff; padding: 16px 20px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-bottom: 20px;">
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
      <div class="content-card banner-card" style="background: linear-gradient(135deg, #15803d, #16a34a); color: #ffffff; padding: 20px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-bottom: 24px;">
        <div>
          <h3 style="font-size: 18px; font-weight: 700; margin-bottom: 4px;">Ready to record attendance?</h3>
          <p style="font-size: 13px; opacity: 0.9;">Time IN and Time OUT work seamlessly offline and online.</p>
        </div>
        <button class="btn" style="background: #ffffff; color: var(--primary); font-weight: 700;" onclick="app.navigateTo('attendance')">
          Go to Attendance
        </button>
      </div>

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
    let rings = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#e2e8f0" stroke-width="${sw}"/>`;
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
        <text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="28" font-weight="700" fill="#0f172a">${centerBig}</text>
        <text x="${cx}" y="${cy + 24}" text-anchor="middle" font-size="11" fill="#64748b">${centerSmall}</text>
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
        ${noData ? `<rect x="${x}" y="${H - padB - 6}" width="${bw}" height="6" fill="#e2e8f0" rx="2"/>` : seg(hp, '#16a34a') + seg(hl, '#f59e0b') + seg(ha, '#fca5a5')}
        <text x="${x + bw / 2}" y="${H - 12}" text-anchor="middle" font-size="10" fill="#64748b">${lbl}</text>
        <text x="${x + bw / 2}" y="${H - 1}" text-anchor="middle" font-size="9" fill="#94a3b8">${dt.getDate()}</text></g>`;
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
      </div>
    `;

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
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Attendance_Day_Report_${data.date}.csv`;
    a.click();
    URL.revokeObjectURL(url);
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
        await db.put('attendance', {
          attendanceRecordId: `REC-LV-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`,
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
          syncStatus: 'PENDING',
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
      rec.syncStatus = 'PENDING';
      await db.put('attendance', rec);

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

    const [allEmployees, allAttendance, landowners, locations] = await Promise.all([
      db.getAll('employees'),
      db.getAll('attendance'),
      db.getAll('landowners'),
      db.getAll('locations')
    ]);

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
      <div class="content-card banner-card" style="background: linear-gradient(135deg, #15803d, #16a34a); color: #ffffff; padding: 16px 20px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-bottom: 20px;">
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

    this.cachedRecordingData = { employees, allAttendance, todayDate };
    this.filterAttendanceList();
  }

  async filterAttendanceList() {
    const container = document.getElementById('attendance-cards-container');
    if (!container || !this.cachedRecordingData) return;

    const query = (document.getElementById('att-search-input')?.value || '').toLowerCase().trim();
    const selectedLocation = document.getElementById('att-filter-location')?.value || '';

    const { employees, allAttendance, todayDate } = this.cachedRecordingData;

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
            <div>
              <span class="emp-id-badge">${this.escape(emp.employeeId)}</span>
              <div class="emp-name">${this.escape(emp.employeeName)}</div>
              <div class="emp-location-info">
                <span>📍 Location: <strong>${this.escape(emp.workLocation || 'Unassigned')}</strong></span>
                <span>🌾 Landowner Area: <strong>${this.escape(todayRec?.landownerName || (this.sessionLandowner ? this.sessionLandowner.name : 'Pending Time IN'))}</strong></span>
                <span>👤 Supervisor: ${this.escape(emp.supervisorName || 'Unassigned')}</span>
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
            <div style="font-size: 11px; color: var(--text-muted); background: #f8fafc; padding: 4px 8px; border-radius: 4px;">
              Actual GPS: ${this.escape(todayRec.actualGpsIn)}
            </div>
          ` : ''}

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

  // Record Standard Time IN
  async recordTimeIn(employeeId) {
    try {
      // Ensure active Landowner area is selected for area checking
      if (!this.sessionLandowner || !this.sessionLandowner.name) {
        this.promptSelectSessionLandowner();
        this.showToast('Please select the Landowner area you are checking before recording Time IN.', 'warning');
        return;
      }

      const emp = await db.get('employees', employeeId);
      if (!emp) throw new Error('Employee not found');

      const todayDate = this.todayStr();
      const allAtt = await db.getAll('attendance');
      const existing = allAtt.find(
        (a) => String(a.employeeId) === String(employeeId) && this.ymd(a.attendanceDate) === todayDate && a.recordStatus !== 'DELETED'
      );

      if (existing && this.isLeave(existing)) {
        throw new Error('This employee is marked On Leave today. Cancel the leave first to record Time IN.');
      }
      if (existing && existing.timeIn) {
        throw new Error('Employee already has an active Time IN record for today.');
      }

      const now = new Date();
      const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
      const recordId = `REC-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
      const currentUser = auth.getCurrentUser() || {};

      const newRecord = {
        attendanceRecordId: recordId,
        employeeId: emp.employeeId,
        employeeName: emp.employeeName,
        supervisorId: emp.supervisorId || currentUser.linkedSupervisorId || '',
        supervisorName: emp.supervisorName || currentUser.name || '',
        landownerId: (this.sessionLandowner && this.sessionLandowner.id) ? this.sessionLandowner.id : '',
        landownerName: (this.sessionLandowner && this.sessionLandowner.name) ? this.sessionLandowner.name : '',
        locationId: emp.locationId || '',
        workLocation: (this.sessionLandowner && this.sessionLandowner.workLocation) ? this.sessionLandowner.workLocation : (emp.workLocation || ''),
        attendanceDate: todayDate,
        timeIn: timeStr,
        timeOut: '',
        originalTimeIn: timeStr,
        originalTimeOut: '',
        adjustedBy: '',
        adjustmentReason: '',
        actualGpsIn: this.activeGps.coords ? `${this.activeGps.coords} (±${this.activeGps.accuracy}m)` : 'GPS Unavailable',
        actualGpsOut: '',
        deviceTimestamp: now.toISOString(),
        synchronizationDate: '',
        syncStatus: 'PENDING',
        recordStatus: 'ACTIVE',
        attendanceType: 'PRESENT'
      };

      await db.put('attendance', newRecord);

      this.showToast(`Time IN recorded for ${emp.employeeName} at ${this.sessionLandowner.name}. (Pending Sync)`, 'success');
      this.renderAttendanceRecording(document.getElementById('view-content-root'));

      // Auto sync if online
      if (navigator.onLine) {
        syncService.autoSync();
      }
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  }

  // Record Standard Time OUT
  async recordTimeOut(attendanceRecordId) {
    try {
      const record = await db.get('attendance', attendanceRecordId);
      if (!record) throw new Error('Attendance record not found');
      if (record.timeOut) throw new Error('Time OUT already recorded for this session.');

      const now = new Date();
      const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });

      record.timeOut = timeStr;
      record.originalTimeOut = timeStr;
      record.actualGpsOut = this.activeGps.coords ? `${this.activeGps.coords} (±${this.activeGps.accuracy}m)` : 'GPS Unavailable';
      record.syncStatus = 'PENDING'; // Ready to sync update to server

      await db.put('attendance', record);

      this.showToast(`Time OUT recorded for ${record.employeeName} at ${timeStr}.`, 'success');
      this.renderAttendanceRecording(document.getElementById('view-content-root'));

      if (navigator.onLine) {
        syncService.autoSync();
      }
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  }

  // Adjustment Modal for Manual Attendance Adjustments
  async openAdjustmentModal(employeeId, existingRecordId) {
    const emp = await db.get('employees', employeeId);
    let record = null;
    if (existingRecordId) {
      record = await db.get('attendance', existingRecordId);
    }

    const todayDate = this.todayStr();
    const allowedLnd = await this.getAllowedLandowners();
    const curLnd = record ? (record.landownerName || '') : (this.sessionLandowner ? this.sessionLandowner.name : '');
    const lndNames = allowedLnd.map((l) => l.landownerName);
    if (curLnd && !lndNames.includes(curLnd)) lndNames.unshift(curLnd); // keep what the record already has
    const lndOptions = `<option value="">-- None --</option>` + lndNames.map((n) => `<option value="${this.escape(n)}" ${n === curLnd ? 'selected' : ''}>${this.escape(n)}</option>`).join('');
    const nowTimeStr = new Date().toTimeString().substring(0, 5); // HH:MM for time input

    const modal = document.getElementById('adjustment-modal');
    const modalBody = document.getElementById('adjustment-modal-body');
    if (!modal || !modalBody) return;

    modalBody.innerHTML = `
      <form id="adjustment-form">
        <div style="background: var(--bg-page); padding: 12px; border-radius: var(--radius-sm); margin-bottom: 16px;">
          <div style="font-weight: 700; color: var(--text-main);">${this.escape(emp.employeeName)}</div>
          <div style="font-size: 12px; color: var(--text-muted);">ID: ${this.escape(emp.employeeId)} | Location: ${this.escape(emp.workLocation || 'None')}</div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label class="form-label required">Attendance Date</label>
            <input type="date" id="adj-date" class="form-control" value="${record ? record.attendanceDate : todayDate}" required />
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Time IN</label>
            <input type="text" id="adj-time-in" class="form-control" placeholder="e.g. 07:30 AM" value="${record ? (record.timeIn || '') : ''}" />
            <div class="form-helper">Format: hh:mm AM/PM</div>
          </div>
          <div class="form-group">
            <label class="form-label">Time OUT</label>
            <input type="text" id="adj-time-out" class="form-control" placeholder="e.g. 04:30 PM" value="${record ? (record.timeOut || '') : ''}" />
            <div class="form-helper">Format: hh:mm AM/PM</div>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">🌾 Area Checking Landowner</label>
          <select id="adj-landowner" class="form-control">${lndOptions}</select>
          <div class="form-helper">Landowner where area checking was conducted.</div>
        </div>

        <div class="form-group">
          <label class="form-label required">Reason for Adjustment</label>
          <textarea id="adj-reason" class="form-control" rows="2" placeholder="Explain why the timestamp was manually adjusted (Required for audit log)" required>${record?.adjustmentReason || ''}</textarea>
        </div>

        <div style="font-size: 11px; color: var(--text-muted);">
          * Manual adjustments preserve original device timestamps and record the editor's username in the system audit logs.
        </div>
      </form>
    `;

    document.getElementById('save-adjustment-btn').onclick = async () => {
      const adjDate = document.getElementById('adj-date').value;
      const adjTimeIn = document.getElementById('adj-time-in').value.trim();
      const adjTimeOut = document.getElementById('adj-time-out').value.trim();
      const adjLandowner = (document.getElementById('adj-landowner')?.value || '').trim();
      const adjReason = document.getElementById('adj-reason').value.trim();

      if (!adjDate) {
        alert('Please choose an attendance date.');
        return;
      }
      if (!adjReason) {
        alert('A reason is strictly required for manual attendance adjustments.');
        return;
      }

      const currentUser = auth.getCurrentUser() || {};
      const now = new Date();
      const deviceTimeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });

      if (record) {
        // Adjust existing record
        if (!record.originalTimeIn && record.timeIn) record.originalTimeIn = record.timeIn;
        if (!record.originalTimeOut && record.timeOut) record.originalTimeOut = record.timeOut;

        record.attendanceDate = adjDate;
        if (adjTimeIn) record.timeIn = adjTimeIn;
        if (adjTimeOut) record.timeOut = adjTimeOut;
        if (adjLandowner) record.landownerName = adjLandowner;
        record.adjustedBy = currentUser.name || currentUser.username || 'Supervisor';
        record.adjustmentReason = adjReason;
        record.syncStatus = 'PENDING';

        await db.put('attendance', record);
      } else {
        // Create new adjusted attendance entry
        const recordId = `REC-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
        const newRecord = {
          attendanceRecordId: recordId,
          employeeId: emp.employeeId,
          employeeName: emp.employeeName,
          supervisorId: emp.supervisorId || currentUser.linkedSupervisorId || '',
          supervisorName: emp.supervisorName || currentUser.name || '',
          landownerId: (this.sessionLandowner && this.sessionLandowner.id) ? this.sessionLandowner.id : '',
          landownerName: adjLandowner || (this.sessionLandowner ? this.sessionLandowner.name : ''),
          locationId: emp.locationId || '',
          workLocation: (this.sessionLandowner && this.sessionLandowner.workLocation) ? this.sessionLandowner.workLocation : (emp.workLocation || ''),
          attendanceDate: adjDate,
          timeIn: adjTimeIn,
          timeOut: adjTimeOut,
          originalTimeIn: deviceTimeStr,
          originalTimeOut: '',
          adjustedBy: currentUser.name || currentUser.username || 'Supervisor',
          adjustmentReason: adjReason,
          actualGpsIn: this.activeGps.coords ? `${this.activeGps.coords} (±${this.activeGps.accuracy}m)` : 'GPS Unavailable',
          actualGpsOut: '',
          deviceTimestamp: now.toISOString(),
          synchronizationDate: '',
          syncStatus: 'PENDING',
          recordStatus: 'ACTIVE',
          attendanceType: 'PRESENT'
        };
        await db.put('attendance', newRecord);
      }

      this.closeModal('adjustment-modal');
      this.showToast('Attendance adjustment saved successfully.', 'success');
      this.refreshCurrentView();

      if (navigator.onLine) {
        syncService.autoSync();
      }
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
                  <th>Actual GPS</th>
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

    this.cachedHistoryData = { records, isAdmin };
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

    const { records, isAdmin } = this.cachedHistoryData;

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
      tbody.innerHTML = `<tr><td colspan="${isAdmin ? 12 : 11}" style="text-align: center; padding: 32px; color: var(--text-muted);">No records found matching filters.</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map((r) => `
      <tr>
        <td><small style="font-family: monospace;">${this.escape(r.attendanceRecordId)}</small></td>
        <td><strong>${this.escape(r.attendanceDate)}</strong></td>
        <td><span class="emp-id-badge">${this.escape(r.employeeId)}</span></td>
        <td><strong>${this.escape(r.employeeName)}</strong></td>
        <td>${this.escape(r.workLocation || '-')}</td>
        <td>${this.escape(r.landownerName || '-')}</td>
        ${isAdmin ? `<td>${this.escape(r.supervisorName || '-')}</td>` : ''}
        <td>${this.isLeave(r) ? `<span class="status-pill badge-leave">On Leave${r.leaveType ? ' – ' + this.escape(r.leaveType) : ''}</span>` : `<span style="color: var(--primary); font-weight: 600;">${this.escape(r.timeIn || '-')}</span>`}</td>
        <td><span style="color: #0284c7; font-weight: 600;">${this.escape(r.timeOut || '-')}</span></td>
        <td><small style="color: var(--text-muted);">${this.escape(r.actualGpsIn || '-')}</small></td>
        <td><span class="status-pill badge-${(r.syncStatus || 'PENDING').toLowerCase()}">${r.syncStatus}</span></td>
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
          <div>Employee: <strong>${this.escape(rec.employeeName)} (${this.escape(rec.employeeId)})</strong></div>
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
        </div>
      </div>
    `;

    this.openModal('details-modal');
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
      rec.syncStatus = 'PENDING'; // Sync deletion to Sheets
      await db.put('attendance', rec);

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

  // Export Attendance to CSV
  async exportHistoryCsv() {
    const allAttendance = await db.getAll('attendance');
    const validRecords = allAttendance.filter((r) => r.recordStatus !== 'DELETED');

    if (validRecords.length === 0) {
      alert('No attendance records available to export.');
      return;
    }

    const headers = [
      'Attendance Record ID', 'Employee ID', 'Employee Name', 'Supervisor ID', 'Supervisor Name',
      'Landowner ID', 'Landowner Name', 'Location ID', 'Work Location', 'Attendance Date',
      'Time IN', 'Time OUT', 'Original Time IN', 'Original Time OUT', 'Adjusted By',
      'Adjustment Reason', 'Actual GPS IN', 'Actual GPS OUT', 'Device Timestamp',
      'Synchronization Date', 'Synchronization Status',
      'Attendance Type', 'Leave Type', 'Leave Remarks'
    ];

    const rows = validRecords.map((r) => [
      `"${r.attendanceRecordId}"`,
      `"${r.employeeId}"`,
      `"${r.employeeName}"`,
      `"${r.supervisorId || ''}"`,
      `"${r.supervisorName || ''}"`,
      `"${r.landownerId || ''}"`,
      `"${r.landownerName || ''}"`,
      `"${r.locationId || ''}"`,
      `"${r.workLocation || ''}"`,
      `"${r.attendanceDate}"`,
      `"${r.timeIn || ''}"`,
      `"${r.timeOut || ''}"`,
      `"${r.originalTimeIn || ''}"`,
      `"${r.originalTimeOut || ''}"`,
      `"${r.adjustedBy || ''}"`,
      `"${(r.adjustmentReason || '').replace(/"/g, '""')}"`,
      `"${r.actualGpsIn || ''}"`,
      `"${r.actualGpsOut || ''}"`,
      `"${r.deviceTimestamp || ''}"`,
      `"${r.synchronizationDate || ''}"`,
      `"${r.syncStatus}"`,
      `"${this.isLeave(r) ? 'LEAVE' : 'PRESENT'}"`,
      `"${r.leaveType || ''}"`,
      `"${(r.leaveRemarks || '').replace(/"/g, '""')}"`
    ]);

    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map((row) => row.join(','))].join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Attendance_Report_${this.todayStr()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /* ==========================================================================
     SYNCHRONIZATION CENTER VIEW
     ========================================================================== */
  async renderSyncView(container) {
    const stats = await syncService.getSyncStats();
    const allAtt = await db.getAll('attendance');
    const pendingList = allAtt.filter((r) => r.syncStatus === 'PENDING' || r.syncStatus === 'FAILED' || r.syncStatus === 'SYNCING');

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
          <span class="metric-title">Total Local Records</span>
          <div class="metric-value">${stats.totalRecords}</div>
        </div>
      </div>

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
          ${pendingList.length === 0 ? `
            <div style="text-align: center; padding: 32px; color: var(--text-muted); background: var(--bg-page); border-radius: 8px;">
              🎉 All records are successfully synchronized with Google Sheets!
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
                      <td><span class="status-pill badge-${r.syncStatus.toLowerCase()}">${r.syncStatus}</span></td>
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
      this.showToast('Retrying failed records...', 'info');
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
      this.showToast('Pulling latest metadata from Google Sheets...', 'info');
      await syncService.pullRemoteData();
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
                  ${supervisors.map((s) => `<option value="${s.supervisorId}" data-name="${this.escape(s.supervisorName)}">${this.escape(s.supervisorName)} (${s.supervisorId})</option>`).join('')}
                </select>
              </div>

              <div class="form-group">
                <label class="form-label required">Assigned Work Location</label>
                <select id="emp-loc-select" class="form-control" required>
                  <option value="">Select Location</option>
                  ${locations.map((loc) => `<option value="${loc.locationId}" data-name="${this.escape(loc.workLocationName)}">${this.escape(loc.workLocationName)}</option>`).join('')}
                </select>
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
        </div>
        <div class="card-body" style="padding: 0;">
          <div class="table-responsive">
            <table class="data-table">
              <thead>
                <tr>
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
                ${employees.length === 0 ? `<tr><td colspan="8" style="text-align: center; padding: 24px;">No employees enrolled yet.</td></tr>` : employees.map((emp) => `
                  <tr>
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

    const supervisorId = supSelect.value;
    const supervisorName = supSelect.options[supSelect.selectedIndex]?.getAttribute('data-name') || '';

    const locationId = locSelect.value;
    const workLocation = locSelect.options[locSelect.selectedIndex]?.getAttribute('data-name') || '';

    const isEdit = !!this.currentEditEmployee;

    // Check duplicate Employee ID if adding new
    if (!isEdit) {
      const existing = await db.get('employees', empId);
      if (existing) {
        alert(`Employee ID "${empId}" already exists. Duplicate IDs are not allowed!`);
        return;
      }
    }

    const employeeObj = {
      employeeId: empId,
      employeeName: empName,
      position: position,
      department: dept,
      supervisorId: supervisorId,
      supervisorName: supervisorName,
      landownerId: '',
      landownerName: '',
      locationId: locationId,
      workLocation: workLocation,
      employmentStatus: status,
      dateEnrolled: dateEnrolled
    };

    // Save locally to IndexedDB
    await db.put('employees', employeeObj);

    // If online, save directly to Google Sheets API
    const apiUrl = await db.getSetting('apiUrl', '');
    if (navigator.onLine && apiUrl) {
      try {
        const currentUser = auth.getCurrentUser() || {};
        await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({
            action: 'SAVE_EMPLOYEE',
            employee: employeeObj,
            isEdit: isEdit,
            userId: currentUser.userId || 'ADMIN',
            userRole: currentUser.role || 'Admin'
          })
        });
      } catch (e) {
        console.warn('[Employee] Server save will sync later:', e);
      }
    }

    this.showToast(`Employee ${empName} saved successfully!`, 'success');
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
  }

  /* ==========================================================================
     ADMIN MODULE 2: SUPERVISOR ENROLLMENT
     ========================================================================== */
  async renderSupervisorsView(container) {
    const supervisors = await db.getAll('supervisors');

    container.innerHTML = `
      <div class="content-card">
        <div class="card-header">
          <h3 class="card-title">Supervisor Enrollment</h3>
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
                <input type="text" id="sup-user-input" class="form-control" placeholder="e.g. jdelacruz" required />
              </div>
            </div>

            <div class="form-row">
              <div class="form-group">
                <label class="form-label required">Password</label>
                <input type="password" id="sup-pass-input" class="form-control" placeholder="••••••••" required />
              </div>
              <div class="form-group">
                <label class="form-label required">Account Status</label>
                <select id="sup-status-select" class="form-control">
                  <option value="Active">Active</option>
                  <option value="Inactive">Inactive</option>
                </select>
              </div>
            </div>

            <div style="text-align: right; margin-top: 10px;">
              <button type="submit" class="btn btn-primary">Enroll Supervisor</button>
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
                  <th>Supervisor ID</th>
                  <th>Full Name</th>
                  <th>Username</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                ${supervisors.map((s) => `
                  <tr>
                    <td><span class="emp-id-badge">${this.escape(s.supervisorId)}</span></td>
                    <td><strong>${this.escape(s.supervisorName)}</strong></td>
                    <td>${this.escape(s.username)}</td>
                    <td><span class="status-pill ${s.accountStatus === 'Active' ? 'status-online' : 'status-offline'}">${s.accountStatus}</span></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;

    document.getElementById('enroll-sup-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const supId = document.getElementById('sup-id-input').value.trim();
      const supName = document.getElementById('sup-name-input').value.trim();
      const username = document.getElementById('sup-user-input').value.trim();
      const pass = document.getElementById('sup-pass-input').value;
      const status = document.getElementById('sup-status-select').value;

      const passwordHash = await auth.hashPassword(pass);

      const supervisorObj = {
        supervisorId: supId,
        supervisorName: supName,
        username: username,
        passwordHash: passwordHash,
        accountStatus: status
      };

      await db.put('supervisors', supervisorObj);

      // Sync account to users store
      const userObj = {
        userId: `USR-${supId}`,
        username: username,
        passwordHash: passwordHash,
        role: 'Supervisor',
        linkedSupervisorId: supId,
        name: supName,
        accountStatus: status,
        lastLogin: ''
      };
      await db.put('users', userObj);

      const apiUrl = await db.getSetting('apiUrl', '');
      if (navigator.onLine && apiUrl) {
        try {
          const currentUser = auth.getCurrentUser() || {};
          await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({
              action: 'SAVE_SUPERVISOR',
              supervisor: supervisorObj,
              userId: currentUser.userId || 'ADMIN',
              userRole: currentUser.role || 'Admin'
            })
          });
        } catch (err) {
          console.warn('[Supervisor] Server sync pending:', err);
        }
      }

      this.showToast(`Supervisor ${supName} enrolled!`, 'success');
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

    container.innerHTML = `
      <div class="content-card">
        <div class="card-header">
          <h3 class="card-title">Landowner Enrollment</h3>
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
                  ${locations.map((loc) => `<option value="${loc.locationId}" data-name="${this.escape(loc.workLocationName)}">${this.escape(loc.workLocationName)}</option>`).join('')}
                </select>
              </div>
            </div>

            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Supervisor <small style="font-weight: normal; color: var(--text-muted);">(automatic, from the Work Location)</small></label>
                <select id="lnd-sup-select" class="form-control" disabled>
                  <option value="">Select a Work Location first</option>
                  ${supervisors.map((s) => `<option value="${s.supervisorId}">${this.escape(s.supervisorName)}</option>`).join('')}
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

            <div style="text-align: right; margin-top: 10px;">
              <button type="submit" class="btn btn-primary">Enroll Landowner</button>
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
                </tr>
              </thead>
              <tbody>
                ${landowners.map((l) => `
                  <tr>
                    <td><span class="emp-id-badge">${this.escape(l.landownerId)}</span></td>
                    <td><strong>${this.escape(l.landownerName)}</strong></td>
                    ${(() => {
                      const loc = locations.find((x) => String(x.locationId) === String(l.locationId)) ||
                                  locations.find((x) => x.landownerId && String(x.landownerId) === String(l.landownerId));
                      const sup = loc ? supervisors.find((x) => String(x.supervisorId) === String(loc.supervisorId)) : null;
                      return `<td>${this.escape((loc && loc.workLocationName) || l.workLocation || '-')}</td>
                    <td>${sup ? this.escape(sup.supervisorName) : '<span class="status-pill badge-leave">No supervisor yet</span>'}</td>`;
                    })()}
                    <td><span class="status-pill ${l.status === 'Active' ? 'status-online' : 'status-offline'}">${l.status}</span></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;

    // Show which supervisor the chosen Work Location belongs to
    document.getElementById('lnd-loc-select').addEventListener('change', (ev) => {
      const loc = locations.find((x) => String(x.locationId) === String(ev.target.value));
      const supSel = document.getElementById('lnd-sup-select');
      supSel.value = loc && loc.supervisorId ? loc.supervisorId : '';
      if (loc && !loc.supervisorId) this.showToast('This location has no supervisor yet. Assign one under Work Locations so the supervisor can see this landowner.', 'warning');
    });

    document.getElementById('enroll-lnd-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const lndId = document.getElementById('lnd-id-input').value.trim();
      const lndName = document.getElementById('lnd-name-input').value.trim();
      const locSelect = document.getElementById('lnd-loc-select');
      const locationId = locSelect.value;
      const workLocation = locSelect.options[locSelect.selectedIndex]?.getAttribute('data-name') || '';
      const chosenLoc = locations.find((x) => String(x.locationId) === String(locationId)) || {};
      const supervisorId = chosenLoc.supervisorId || '';
      const status = document.getElementById('lnd-status-select').value;

      const landownerObj = {
        landownerId: lndId,
        landownerName: lndName,
        locationId: locationId,
        workLocation: workLocation,
        supervisorId: supervisorId,
        status: status
      };

      await db.put('landowners', landownerObj);

      const apiUrl = await db.getSetting('apiUrl', '');
      if (navigator.onLine && apiUrl) {
        try {
          const currentUser = auth.getCurrentUser() || {};
          await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({
              action: 'SAVE_LANDOWNER',
              landowner: landownerObj,
              userId: currentUser.userId || 'ADMIN',
              userRole: currentUser.role || 'Admin'
            })
          });
        } catch (err) {
          console.warn('[Landowner] Server sync pending:', err);
        }
      }

      this.showToast(`Landowner ${lndName} saved!`, 'success');
      this.renderLandownersView(document.getElementById('view-content-root'));
    });
  }

  /* ==========================================================================
     ADMIN MODULE 4: WORK LOCATION ENROLLMENT
     ========================================================================== */
  async renderLocationsView(container) {
    const [locations, landowners, supervisors] = await Promise.all([
      db.getAll('locations'),
      db.getAll('landowners'),
      db.getAll('supervisors')
    ]);

    container.innerHTML = `
      <div class="content-card">
        <div class="card-header">
          <h3 class="card-title">Work Location Enrollment</h3>
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
                <input type="text" id="loc-name-input" class="form-control" placeholder="e.g. North Plantation Block A" required />
              </div>
              <div class="form-group">
                <label class="form-label">Description</label>
                <input type="text" id="loc-desc-input" class="form-control" placeholder="e.g. Citrus Groves section" />
              </div>
            </div>

            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Landowner Name</label>
                <select id="loc-lnd-select" class="form-control">
                  <option value="">Select Landowner (Optional)</option>
                  ${landowners.map((l) => `<option value="${l.landownerId}" data-name="${this.escape(l.landownerName)}">${this.escape(l.landownerName)}</option>`).join('')}
                </select>
              </div>
              <div class="form-group">
                <label class="form-label">Assigned Supervisor</label>
                <select id="loc-sup-select" class="form-control">
                  <option value="">Select Supervisor (Optional)</option>
                  ${supervisors.map((s) => `<option value="${s.supervisorId}">${this.escape(s.supervisorName)}</option>`).join('')}
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

            <div style="text-align: right; margin-top: 10px;">
              <button type="submit" class="btn btn-primary">Enroll Location</button>
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
                  <th>Description</th>
                  <th>Landowner</th>
                  <th>Supervisor ID</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                ${locations.map((loc) => `
                  <tr>
                    <td><span class="emp-id-badge">${this.escape(loc.locationId)}</span></td>
                    <td><strong>${this.escape(loc.workLocationName)}</strong></td>
                    <td>${this.escape(loc.description || '-')}</td>
                    <td>${this.escape(loc.landownerName || '-')}</td>
                    <td>${this.escape(loc.supervisorId || '-')}</td>
                    <td><span class="status-pill ${loc.status === 'Active' ? 'status-online' : 'status-offline'}">${loc.status}</span></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;

    document.getElementById('enroll-loc-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const locId = document.getElementById('loc-id-input').value.trim();
      const locName = document.getElementById('loc-name-input').value.trim();
      const desc = document.getElementById('loc-desc-input').value.trim();
      const lndSelect = document.getElementById('loc-lnd-select');
      const landownerId = lndSelect.value;
      const landownerName = lndSelect.options[lndSelect.selectedIndex]?.getAttribute('data-name') || '';
      const supervisorId = document.getElementById('loc-sup-select').value;
      const status = document.getElementById('loc-status-select').value;

      const locObj = {
        locationId: locId,
        workLocationName: locName,
        description: desc,
        landownerId: landownerId,
        landownerName: landownerName,
        supervisorId: supervisorId,
        status: status
      };

      await db.put('locations', locObj);

      const apiUrl = await db.getSetting('apiUrl', '');
      if (navigator.onLine && apiUrl) {
        try {
          const currentUser = auth.getCurrentUser() || {};
          await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({
              action: 'SAVE_LOCATION',
              location: locObj,
              userId: currentUser.userId || 'ADMIN',
              userRole: currentUser.role || 'Admin'
            })
          });
        } catch (err) {
          console.warn('[Location] Server sync pending:', err);
        }
      }

      this.showToast(`Location ${locName} saved!`, 'success');
      this.renderLocationsView(document.getElementById('view-content-root'));
    });
  }

  /* ==========================================================================
     ADMIN MODULE 5: USER ACCOUNTS & MANAGEMENT
     ========================================================================== */
  async renderUsersView(container) {
    const users = await db.getAll('users');

    container.innerHTML = `
      <div class="content-card">
        <div class="card-header">
          <h3 class="card-title">User Accounts & Authentication</h3>
        </div>
        <div class="card-body">
          <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 16px;">
            Manage credentials for Administrators and Supervisors. Passwords are encrypted with SHA-256 both offline and online.
          </p>
          <div class="table-responsive">
            <table class="data-table">
              <thead>
                <tr>
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
                    <td><small style="font-family: monospace;">${this.escape(u.userId)}</small></td>
                    <td><strong>${this.escape(u.username)}</strong></td>
                    <td><span class="status-pill status-online">${u.role}</span></td>
                    <td>${this.escape(u.linkedSupervisorId || 'None (Admin)')}</td>
                    <td><span class="status-pill ${u.accountStatus === 'Active' ? 'status-online' : 'status-offline'}">${u.accountStatus}</span></td>
                    <td><small>${this.escape(u.lastLogin || 'Never')}</small></td>
                    <td>
                      <button class="btn btn-outline" style="padding: 4px 8px; font-size: 11px;" onclick="app.promptResetPassword('${u.username}')">Reset Password</button>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  }

  async promptResetPassword(username) {
    const newPass = prompt(`Enter new password for ${username}:`);
    if (!newPass || !newPass.trim()) return;

    const hash = await auth.hashPassword(newPass.trim());
    const users = await db.getAll('users');
    const user = users.find((u) => u.username === username);

    if (user) {
      user.passwordHash = hash;
      await db.put('users', user);

      const apiUrl = await db.getSetting('apiUrl', '');
      if (navigator.onLine && apiUrl) {
        try {
          await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({
              action: 'SAVE_USER',
              user: user,
              userId: auth.getCurrentUser()?.userId || 'ADMIN',
              userRole: 'Admin'
            })
          });
        } catch (e) {
          console.warn('[User] Server update failed:', e);
        }
      }

      this.showToast(`Password updated for user ${username}.`, 'success');
      this.renderUsersView(document.getElementById('view-content-root'));
    }
  }

  /* ==========================================================================
     ADMIN MODULE 6: AUDIT TRAIL LOGS
     ========================================================================== */
  async renderAuditView(container) {
    const localLogs = await db.getAll('auditLogs');
    localLogs.sort((a, b) => (b.dateTime > a.dateTime ? 1 : -1));

    container.innerHTML = `
      <div class="content-card">
        <div class="card-header">
          <h3 class="card-title">System Audit Logs & Adjustments</h3>
          <span class="status-pill status-online">${localLogs.length} Entries</span>
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
                  <th>Reason / Details</th>
                </tr>
              </thead>
              <tbody>
                ${localLogs.length === 0 ? `<tr><td colspan="5" style="text-align: center; padding: 32px; color: var(--text-muted);">No audit entries yet. Adjustments and deletions appear here.</td></tr>` : localLogs.map((log) => `
                  <tr>
                    <td><small>${this.escape(log.dateTime || '-')}</small></td>
                    <td><strong>${this.escape(log.action)}</strong></td>
                    <td>${this.escape(log.userId || '-')} (${this.escape(log.userRole || '-')})</td>
                    <td><small style="font-family: monospace;">${this.escape(log.recordId || '-')}</small></td>
                    <td>${this.escape(log.reason || '-')}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
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

    document.getElementById('save-settings-btn').onclick = async () => {
      const newUrl = input.value.trim();
      await db.setSetting('apiUrl', newUrl);
      this.showToast('Google Apps Script API URL saved.', 'success');
      this.closeModal('settings-modal');

      if (newUrl && navigator.onLine) {
        syncService.pullRemoteData();
      }
    };

    document.getElementById('test-api-btn').onclick = async () => {
      const testUrl = input.value.trim();
      if (!testUrl) {
        alert('Please enter a Google Apps Script Web App URL first.');
        return;
      }
      const testStatusEl = document.getElementById('settings-test-status');
      testStatusEl.textContent = 'Testing connection...';
      testStatusEl.style.color = 'var(--text-muted)';

      try {
        const res = await fetch(testUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ action: 'SETUP_DB' })
        });
        const data = await res.json();
        if (data && data.success) {
          testStatusEl.textContent = '✓ Connected successfully! Google Sheets database is ready.';
          testStatusEl.style.color = 'var(--primary)';
        } else {
          testStatusEl.textContent = `Server responded: ${data.error || 'Unknown error'}`;
          testStatusEl.style.color = 'var(--accent-red)';
        }
      } catch (err) {
        testStatusEl.textContent = `Connection failed: ${err.message}. Check Web App deployment permissions (set to 'Anyone').`;
        testStatusEl.style.color = 'var(--accent-red)';
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
