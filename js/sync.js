/**
 * Synchronization Engine
 * Handles automatic and manual syncing between IndexedDB and Google Sheets.
 * Prevents duplicates via unique Attendance Record IDs, detects connectivity, and retains local history.
 */

class SyncService {
  constructor() {
    this.isSyncing = false;
    this.isOnline = navigator.onLine;
    this.lastSyncTime = null;
    this.lastSyncError = null;
    this.listeners = [];

    this.initNetworkListeners();
  }

  initNetworkListeners() {
    window.addEventListener('online', () => {
      console.log('[Sync] Device connected to the internet.');
      this.isOnline = true;
      this.notifyListeners({ type: 'NETWORK_CHANGE', isOnline: true });
      this.autoSync();
    });

    window.addEventListener('offline', () => {
      console.log('[Sync] Device is now offline.');
      this.isOnline = false;
      this.notifyListeners({ type: 'NETWORK_CHANGE', isOnline: false });
    });

    // Check Service Worker messages
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'TRIGGER_AUTO_SYNC') {
          console.log('[Sync] Received auto-sync trigger from Service Worker');
          this.autoSync();
        }
      });
    }
  }

  subscribe(callback) {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter((cb) => cb !== callback);
    };
  }

  notifyListeners(data) {
    this.listeners.forEach((cb) => {
      try {
        cb(data);
      } catch (e) {
        console.error('[Sync] Listener error:', e);
      }
    });
  }

  async getSyncStats() {
    await db.init();
    const allAttendance = await db.getAll('attendance');
    const validRecords = allAttendance.filter((r) => r.recordStatus !== 'DELETED');

    const total = validRecords.length;
    const synced = validRecords.filter((r) => r.syncStatus === 'SYNCED').length;
    const pending = validRecords.filter((r) => r.syncStatus === 'PENDING').length;
    const failed = validRecords.filter((r) => r.syncStatus === 'FAILED').length;
    const syncing = validRecords.filter((r) => r.syncStatus === 'SYNCING').length;

    const savedLastSync = await db.getSetting('lastSyncTime');
    this.lastSyncTime = savedLastSync || this.lastSyncTime;

    return {
      totalRecords: total,
      syncedRecords: synced,
      pendingRecords: pending,
      failedRecords: failed,
      syncingRecords: syncing,
      isOnline: navigator.onLine,
      lastSyncTime: this.lastSyncTime ? new Date(this.lastSyncTime).toLocaleString() : 'Never',
      lastSyncError: this.lastSyncError
    };
  }

  // Automatic sync when coming back online
  async autoSync() {
    const apiUrl = await db.getSetting('apiUrl', '');
    if (!apiUrl || !navigator.onLine) return;

    const pending = await db.getPendingAttendance();
    if (pending.length > 0) {
      console.log(`[Sync] Auto-syncing ${pending.length} pending records...`);
      await this.syncAllPending(true);
    }
  }

  // Sync all records that are PENDING or FAILED
  async syncAllPending(isSilent = false) {
    if (this.isSyncing) {
      console.log('[Sync] Sync already in progress, skipping duplicate call.');
      return;
    }

    const apiUrl = await db.getSetting('apiUrl', '');
    if (!apiUrl) {
      throw new Error('Google Apps Script Web App URL is not configured. Please set it in Settings.');
    }

    if (!navigator.onLine) {
      throw new Error('You are currently offline. Records are safely stored locally and will sync when internet returns.');
    }

    this.isSyncing = true;
    this.notifyListeners({ type: 'SYNC_START' });

    try {
      const allAttendance = await db.getAll('attendance');
      const recordsToSync = allAttendance.filter(
        (r) => r.syncStatus === 'PENDING' || r.syncStatus === 'FAILED'
      );

      if (recordsToSync.length === 0) {
        // Also pull remote updates if there are no pending records to push
        await this.pullRemoteData();
        this.isSyncing = false;
        this.notifyListeners({ type: 'SYNC_COMPLETE', count: 0 });
        return { success: true, count: 0, message: 'All records are already up to date.' };
      }

      // Mark records as SYNCING in IndexedDB
      for (const rec of recordsToSync) {
        rec.syncStatus = 'SYNCING';
        await db.put('attendance', rec);
      }
      this.notifyListeners({ type: 'SYNC_PROGRESS', status: 'SYNCING', count: recordsToSync.length });

      const currentUser = auth.getCurrentUser() || {};

      // Send batch to Google Apps Script
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          action: 'SYNC_ATTENDANCE_BATCH',
          records: recordsToSync,
          userId: currentUser.userId || 'OFFLINE-USER',
          userRole: currentUser.role || 'Supervisor'
        })
      });

      const result = await response.json();

      if (result && result.success) {
        const syncedIds = new Set(result.syncedIds || recordsToSync.map((r) => r.attendanceRecordId));
        const nowIso = new Date().toISOString();

        // Update local records to SYNCED (DO NOT DELETE!)
        for (const rec of recordsToSync) {
          if (syncedIds.has(rec.attendanceRecordId)) {
            rec.syncStatus = 'SYNCED';
            rec.synchronizationDate = nowIso;
            await db.put('attendance', rec);
          }
        }

        this.lastSyncTime = nowIso;
        this.lastSyncError = null;
        await db.setSetting('lastSyncTime', nowIso);

        // Also fetch latest metadata from sheets
        await this.pullRemoteData();

        this.isSyncing = false;
        this.notifyListeners({ type: 'SYNC_COMPLETE', count: recordsToSync.length });

        return {
          success: true,
          count: recordsToSync.length,
          message: `Successfully synchronized ${recordsToSync.length} attendance record(s) to Google Sheets.`
        };
      } else {
        throw new Error(result.error || 'Server returned an error during sync.');
      }
    } catch (err) {
      console.error('[Sync] Sync failed:', err);
      this.lastSyncError = err.message;

      // Mark all syncing records back to FAILED
      const allAttendance = await db.getAll('attendance');
      for (const rec of allAttendance) {
        if (rec.syncStatus === 'SYNCING') {
          rec.syncStatus = 'FAILED';
          await db.put('attendance', rec);
        }
      }

      this.isSyncing = false;
      this.notifyListeners({ type: 'SYNC_ERROR', error: err.message });
      throw err;
    }
  }

  // Retry specifically failed records
  async retryFailed() {
    return this.syncAllPending(false);
  }

  // Sync specific selected record IDs
  async syncSelected(recordIds) {
    if (!recordIds || recordIds.length === 0) return;
    const apiUrl = await db.getSetting('apiUrl', '');
    if (!apiUrl) throw new Error('API URL is not configured.');
    if (!navigator.onLine) throw new Error('Device is offline.');

    const recordsToSync = [];
    for (const id of recordIds) {
      const rec = await db.get('attendance', id);
      if (rec) recordsToSync.push(rec);
    }

    if (recordsToSync.length === 0) return;

    for (const rec of recordsToSync) {
      rec.syncStatus = 'SYNCING';
      await db.put('attendance', rec);
    }
    this.notifyListeners({ type: 'SYNC_START' });

    try {
      const currentUser = auth.getCurrentUser() || {};
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          action: 'SYNC_ATTENDANCE_BATCH',
          records: recordsToSync,
          userId: currentUser.userId || 'OFFLINE-USER',
          userRole: currentUser.role || 'Supervisor'
        })
      });

      const result = await response.json();
      if (result && result.success) {
        const syncedIds = new Set(result.syncedIds || recordsToSync.map((r) => r.attendanceRecordId));
        const nowIso = new Date().toISOString();
        for (const rec of recordsToSync) {
          if (syncedIds.has(rec.attendanceRecordId)) {
            rec.syncStatus = 'SYNCED';
            rec.synchronizationDate = nowIso;
            await db.put('attendance', rec);
          }
        }
        this.notifyListeners({ type: 'SYNC_COMPLETE', count: recordsToSync.length });
        return { success: true, count: recordsToSync.length };
      } else {
        throw new Error(result.error || 'Sync failed');
      }
    } catch (err) {
      for (const rec of recordsToSync) {
        rec.syncStatus = 'FAILED';
        await db.put('attendance', rec);
      }
      this.notifyListeners({ type: 'SYNC_ERROR', error: err.message });
      throw err;
    }
  }

  // Pull latest data (Employees, Landowners, Locations, Supervisors, Users, Attendance) from Google Sheets
  async pullRemoteData() {
    const apiUrl = await db.getSetting('apiUrl', '');
    if (!apiUrl || !navigator.onLine) return;

    try {
      const currentUser = auth.getCurrentUser();
      const role = currentUser ? currentUser.role : 'Admin';
      const supervisorId = currentUser ? currentUser.linkedSupervisorId : '';

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          action: 'GET_INITIAL_DATA',
          role: role,
          supervisorId: supervisorId
        })
      });

      const result = await response.json();

      if (result && result.success && result.data) {
        const { employees, supervisors, landowners, locations, attendance, users } = result.data;

        // Batch save into IndexedDB
        if (employees) await db.batchPut('employees', employees);
        if (supervisors) await db.batchPut('supervisors', supervisors);
        if (landowners) await db.batchPut('landowners', landowners);
        if (locations) await db.batchPut('locations', locations);
        if (users) await db.batchPut('users', users);

        // When updating attendance from server, preserve any local PENDING changes!
        if (attendance && attendance.length > 0) {
          for (const remoteRec of attendance) {
            const localRec = await db.get('attendance', remoteRec.attendanceRecordId);
            // If local record is PENDING or FAILED, don't overwrite with older remote data
            if (!localRec || (localRec.syncStatus !== 'PENDING' && localRec.syncStatus !== 'FAILED')) {
              await db.put('attendance', {
                ...remoteRec,
                syncStatus: 'SYNCED'
              });
            }
          }
        }

        console.log('[Sync] Remote data successfully pulled and cached into IndexedDB.');
        this.notifyListeners({ type: 'DATA_PULLED' });
      }
    } catch (err) {
      console.warn('[Sync] Could not pull remote data:', err.message);
    }
  }
}

// Global Sync instance
const syncService = new SyncService();
