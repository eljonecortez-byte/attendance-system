/**
 * Synchronization Engine (v3)
 *
 * Order of one sync run:
 *   1. Admin outbox (employees, locations, users... saved while offline)
 *   2. Attendance records, in batches of 50
 *   3. Photos for records the server already has (3 per request)
 *   4. Download the latest data from Google Sheets
 *
 * Fixes vs v2:
 *   - A record changed while it was uploading (e.g. Time OUT tapped during sync) stays PENDING
 *     instead of being overwritten with the old copy (localRev check).
 *   - Records the server refuses are marked FAILED with the reason instead of failing the whole batch.
 *   - Only one sync runs at a time, including "Sync Selected".
 */

const RECORD_BATCH_SIZE = 50;
const PHOTO_BATCH_SIZE = 3;
const KEEP_FULL_PHOTO_DAYS = 3; // after upload, full-size photos are removed from the phone after N days (thumbnail stays)

class SyncService {
  constructor() {
    this.isSyncing = false;
    this.lastSyncTime = null;
    this.lastSyncError = null;
    this.listeners = [];
    this.initNetworkListeners();
    // Safety net: try again every 3 minutes while there is something pending
    setInterval(() => this.autoSync(), 180000);
  }

  initNetworkListeners() {
    window.addEventListener('online', () => {
      this.notifyListeners({ type: 'NETWORK_CHANGE', isOnline: true });
      this.autoSync();
    });
    window.addEventListener('offline', () => {
      this.notifyListeners({ type: 'NETWORK_CHANGE', isOnline: false });
    });
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'TRIGGER_AUTO_SYNC') this.autoSync();
      });
    }
  }

  subscribe(callback) {
    this.listeners.push(callback);
    return () => { this.listeners = this.listeners.filter((cb) => cb !== callback); };
  }

  notifyListeners(data) {
    this.listeners.forEach((cb) => {
      try { cb(data); } catch (e) { console.error('[Sync] Listener error:', e); }
    });
  }

  /** Ask the browser to wake us up when the connection returns (Android Chrome). */
  async requestBackgroundSync() {
    try {
      if ('serviceWorker' in navigator && 'SyncManager' in window) {
        const reg = await navigator.serviceWorker.ready;
        await reg.sync.register('sync-attendance');
      }
    } catch (e) { /* not supported: the online event + timer still cover it */ }
  }

  async getSyncStats() {
    await db.init();
    const [allAttendance, photos, outbox] = await Promise.all([db.getAll('attendance'), db.getAll('photos'), db.getAll('outbox')]);
    const validRecords = allAttendance.filter((r) => r.recordStatus !== 'DELETED' || r.syncStatus !== 'SYNCED');
    const count = (s) => validRecords.filter((r) => r.syncStatus === s).length;
    const savedLastSync = await db.getSetting('lastSyncTime');
    this.lastSyncTime = savedLastSync || this.lastSyncTime;
    return {
      totalRecords: validRecords.length,
      syncedRecords: count('SYNCED'),
      pendingRecords: count('PENDING') + count('SYNCING'),
      failedRecords: count('FAILED'),
      pendingPhotos: photos.filter((p) => p.syncStatus !== 'SYNCED').length,
      failedPhotos: photos.filter((p) => p.syncStatus === 'FAILED').length,
      outboxCount: outbox.length,
      outboxFailed: outbox.filter((o) => o.status === 'FAILED').length,
      isOnline: navigator.onLine,
      lastSyncTime: this.lastSyncTime ? new Date(this.lastSyncTime).toLocaleString() : 'Never',
      lastSyncError: this.lastSyncError
    };
  }

  async hasPendingWork() {
    const [att, photos, outbox] = await Promise.all([db.getPendingAttendance(), db.getAll('photos'), db.getAll('outbox')]);
    return att.length > 0 || photos.some((p) => p.syncStatus === 'PENDING') || outbox.some((o) => o.status !== 'FAILED');
  }

  async autoSync() {
    if (!auth.getCurrentUser() || !(await api.isReachable()) || this.isSyncing) return;
    if (!(await this.hasPendingWork())) return;
    try {
      await this.syncAllPending(true);
    } catch (e) {
      console.warn('[Sync] Auto-sync failed:', e.message);
    }
  }

  async ensureCanSync() {
    if (!(await api.getUrl())) throw new Error('Google Apps Script Web App URL is not configured. Please set it in Settings.');
    if (!navigator.onLine) throw new Error('You are offline. Records are safely stored on this phone and will upload when internet returns.');
    const user = auth.getCurrentUser();
    if (!user || !user.token) throw new Error('Please sign in online once so this phone can upload records.');
  }

  /** Full sync: outbox, records, photos, then download. */
  async syncAllPending(isSilent = false) {
    if (this.isSyncing) return { success: true, count: 0, message: 'A sync is already running.' };
    await this.ensureCanSync();

    this.isSyncing = true;
    this.notifyListeners({ type: 'SYNC_START' });
    try {
      const outbox = await api.processOutbox();
      const pending = await db.getPendingAttendance();
      const rec = await this.pushRecords(pending);
      const pho = await this.pushPhotos();
      await this.cleanupPhotos();

      const nowIso = new Date().toISOString();
      this.lastSyncTime = nowIso;
      await db.setSetting('lastSyncTime', nowIso);

      await this.pullRemoteData(true);

      const problems = rec.rejected.length + pho.failed + outbox.failed.length;
      this.lastSyncError = problems
        ? `${problems} item(s) could not be uploaded. Open the Sync page to see why.`
        : null;

      const msgParts = [];
      if (rec.synced) msgParts.push(`${rec.synced} record(s)`);
      if (pho.uploaded) msgParts.push(`${pho.uploaded} photo(s)`);
      if (outbox.sent) msgParts.push(`${outbox.sent} admin change(s)`);
      const message = msgParts.length ? `Uploaded ${msgParts.join(', ')}.` : 'Everything is up to date.';

      this.notifyListeners({ type: 'SYNC_COMPLETE', count: rec.synced + pho.uploaded + outbox.sent, problems, message, silent: isSilent });
      return { success: true, count: rec.synced, message };
    } catch (err) {
      this.lastSyncError = err.message;
      await this.resetSyncing();
      this.notifyListeners({ type: 'SYNC_ERROR', error: err.message, code: err.code });
      throw err;
    } finally {
      this.isSyncing = false;
    }
  }

  async retryFailed() {
    // Failed outbox items are retried only when the user asks
    if (this.isSyncing) return;
    await this.ensureCanSync();
    await api.processOutbox(true);
    const photos = await db.getAll('photos');
    for (const p of photos.filter((x) => x.syncStatus === 'FAILED')) {
      p.syncStatus = 'PENDING'; p.error = '';
      await db.put('photos', p);
    }
    return this.syncAllPending(false);
  }

  async syncSelected(recordIds) {
    if (!recordIds || !recordIds.length) return;
    if (this.isSyncing) throw new Error('A sync is already running. Please wait.');
    await this.ensureCanSync();
    this.isSyncing = true;
    this.notifyListeners({ type: 'SYNC_START' });
    try {
      const list = [];
      for (const id of recordIds) {
        const r = await db.get('attendance', id);
        if (r && r.syncStatus !== 'SYNCED') list.push(r);
      }
      const res = await this.pushRecords(list);
      await this.pushPhotos(new Set(recordIds));
      this.notifyListeners({ type: 'SYNC_COMPLETE', count: res.synced, problems: res.rejected.length, message: `Uploaded ${res.synced} record(s).` });
      return { success: true, count: res.synced };
    } catch (err) {
      await this.resetSyncing();
      this.notifyListeners({ type: 'SYNC_ERROR', error: err.message, code: err.code });
      throw err;
    } finally {
      this.isSyncing = false;
    }
  }

  async resetSyncing() {
    const all = await db.getAll('attendance');
    for (const r of all) {
      if (r.syncStatus === 'SYNCING') { r.syncStatus = 'PENDING'; await db.put('attendance', r); }
    }
  }

  /** Uploads attendance records. Returns { synced, rejected: [{id, reason}] }. */
  async pushRecords(records) {
    let synced = 0;
    const rejected = [];
    const user = auth.getCurrentUser() || {};

    for (let i = 0; i < records.length; i += RECORD_BATCH_SIZE) {
      const batch = records.slice(i, i + RECORD_BATCH_SIZE);
      const sentRev = {};
      for (const r of batch) {
        sentRev[r.attendanceRecordId] = Number(r.localRev) || 0;
        const fresh = await db.get('attendance', r.attendanceRecordId);
        if (fresh && (Number(fresh.localRev) || 0) === sentRev[r.attendanceRecordId]) {
          fresh.syncStatus = 'SYNCING';
          await db.put('attendance', fresh);
        }
      }
      this.notifyListeners({ type: 'SYNC_PROGRESS', status: 'SYNCING', count: batch.length });

      // Don't send local-only fields
      const payloadRecords = batch.map((r) => {
        const o = Object.assign({}, r);
        delete o.syncStatus; delete o.syncError; delete o.localRev; delete o.updatedAt;
        return o;
      });

      const result = await api.call('SYNC_ATTENDANCE_BATCH', { records: payloadRecords, userRole: user.role });
      const syncedIds = new Set(result.syncedIds || []);
      const rejectedMap = {};
      (result.rejected || []).forEach((x) => { rejectedMap[x.id] = x.reason; });
      const serverValues = result.serverValues || {};
      const nowIso = new Date().toISOString();

      for (const r of batch) {
        const id = r.attendanceRecordId;
        const current = await db.get('attendance', id);
        if (!current) continue;
        const unchanged = (Number(current.localRev) || 0) === sentRev[id];

        if (syncedIds.has(id)) {
          Object.assign(current, serverValues[id] || {});
          current.synchronizationDate = nowIso;
          // If it was edited during the upload, keep it PENDING so the newer version goes up next
          current.syncStatus = unchanged ? 'SYNCED' : 'PENDING';
          current.syncError = '';
          await db.put('attendance', current);
          synced++;
        } else {
          const reason = rejectedMap[id] || 'Not accepted by the server.';
          current.syncStatus = unchanged ? 'FAILED' : 'PENDING';
          current.syncError = reason;
          await db.put('attendance', current);
          rejected.push({ id, reason });
        }
      }
    }
    return { synced, rejected };
  }

  /** Uploads photos whose attendance record is already on the server. */
  async pushPhotos(onlyRecordIds) {
    const photos = (await db.getAll('photos')).filter((p) =>
      p.syncStatus === 'PENDING' && p.dataUrl && (!onlyRecordIds || onlyRecordIds.has(p.recordId))
    );
    let uploaded = 0, failed = 0;
    const ready = [];
    for (const p of photos) {
      const rec = await db.get('attendance', p.recordId);
      // The record must reach the server first (photo URL is written into its row)
      if (rec && (rec.syncStatus === 'SYNCED' || rec.synchronizationDate)) ready.push(p);
    }

    for (let i = 0; i < ready.length; i += PHOTO_BATCH_SIZE) {
      const batch = ready.slice(i, i + PHOTO_BATCH_SIZE);
      this.notifyListeners({ type: 'SYNC_PROGRESS', status: 'PHOTOS', count: batch.length });
      const result = await api.call('UPLOAD_PHOTOS', {
        photos: batch.map((p) => ({ photoId: p.photoId, recordId: p.recordId, kind: p.kind, dataUrl: p.dataUrl, takenAt: p.takenAt }))
      }, { timeoutMs: 120000 });

      for (const u of result.uploaded || []) {
        const p = await db.get('photos', u.photoId);
        if (p) { p.syncStatus = 'SYNCED'; p.url = u.url; p.error = ''; p.uploadedAt = new Date().toISOString(); await db.put('photos', p); }
        const rec = await db.get('attendance', u.recordId);
        if (rec) {
          rec[u.kind === 'OUT' ? 'photoOut' : 'photoIn'] = u.url;
          await db.put('attendance', rec); // no localRev bump: the server already has this URL
        }
        uploaded++;
      }
      for (const x of result.rejected || []) {
        if (x.reason === 'RECORD_NOT_SYNCED') continue; // try again next time
        const p = await db.get('photos', x.photoId);
        if (p) { p.syncStatus = 'FAILED'; p.error = x.reason; await db.put('photos', p); }
        failed++;
      }
    }
    return { uploaded, failed };
  }

  /** Frees phone storage: drop full-size images a few days after upload (thumbnail is kept). */
  async cleanupPhotos() {
    const cutoff = Date.now() - KEEP_FULL_PHOTO_DAYS * 86400000;
    const photos = await db.getAll('photos');
    for (const p of photos) {
      if (p.syncStatus === 'SYNCED' && p.dataUrl && Date.parse(p.takenAt) < cutoff) {
        delete p.dataUrl;
        await db.put('photos', p);
      }
    }
  }

  /** Downloads only the profile photos that changed since the last download. */
  async pullAvatars() {
    try {
      const since = await db.getSetting('avatarsSince', '');
      const res = await api.call('GET_PROFILE_PHOTOS', { since });
      for (const p of res.photos || []) {
        if (p.image) await db.put('avatars', { key: p.key, type: p.type, ownerId: p.ownerId, image: p.image, updatedAt: p.updatedAt });
        else await db.delete('avatars', p.key);
      }
      if (res.serverTime) await db.setSetting('avatarsSince', res.serverTime);
      if ((res.photos || []).length && typeof app !== 'undefined') await app.loadAvatars();
    } catch (e) {
      console.warn('[Sync] Could not pull profile photos:', e.message);
    }
  }

  /** Download the latest employees, locations, landowners, users and recent attendance. */
  async pullRemoteData(throwOnError = false) {
    if (!(await api.isReachable()) || !auth.getCurrentUser() || !auth.getCurrentUser().token) return;
    try {
      const result = await api.call('GET_INITIAL_DATA', {});
      const { employees, supervisors, landowners, locations, attendance, users } = result.data;

      if (result.settings) await db.setSetting('appSettings', result.settings);
      if (result.me) {
        const u = auth.getCurrentUser();
        if (u && (u.role !== result.me.role || String(u.linkedSupervisorId || '') !== String(result.me.linkedSupervisorId || ''))) {
          u.role = result.me.role;
          u.linkedSupervisorId = result.me.linkedSupervisorId;
          await db.setSetting('currentUser', u);
        }
      }

      // Mirror the server exactly (removes reassigned / deleted items) unless admin changes are still queued
      const outbox = await db.getAll('outbox');
      if (outbox.length === 0) {
        await db.clear('employees');
        await db.clear('supervisors');
        await db.clear('landowners');
        await db.clear('locations');
        if (auth.isAdmin()) await db.clear('users');
      }
      await db.batchPut('employees', employees || []);
      await db.batchPut('supervisors', supervisors || []);
      await db.batchPut('landowners', landowners || []);
      await db.batchPut('locations', locations || []);
      if (auth.isAdmin()) await db.batchPut('users', users || []);

      // Merge attendance: never overwrite local changes that are not uploaded yet
      for (const remoteRec of attendance || []) {
        const localRec = await db.get('attendance', remoteRec.attendanceRecordId);
        if (localRec && ['PENDING', 'FAILED', 'SYNCING'].includes(localRec.syncStatus)) continue;
        await db.put('attendance', Object.assign({}, localRec || {}, remoteRec, {
          syncStatus: 'SYNCED',
          localRev: localRec ? localRec.localRev : 0
        }));
      }

      await this.pullAvatars();
      this.notifyListeners({ type: 'DATA_PULLED' });
    } catch (err) {
      console.warn('[Sync] Could not pull remote data:', err.message);
      if (throwOnError && !err.isNetwork) throw err;
    }
  }
}

const syncService = new SyncService();
