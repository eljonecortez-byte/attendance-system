/**
 * IndexedDB Database Service for Offline Attendance System
 * Database Name: AttendanceSystemDB
 */
class AttendanceDB {
  constructor() {
    this.dbName = 'AttendanceSystemDB';
    this.dbVersion = 1;
    this.db = null;
  }

  async init() {
    if (this.db) return this.db;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // 1. Attendance Store
        if (!db.objectStoreNames.contains('attendance')) {
          const attStore = db.createObjectStore('attendance', { keyPath: 'attendanceRecordId' });
          attStore.createIndex('employeeId', 'employeeId', { unique: false });
          attStore.createIndex('supervisorId', 'supervisorId', { unique: false });
          attStore.createIndex('attendanceDate', 'attendanceDate', { unique: false });
          attStore.createIndex('syncStatus', 'syncStatus', { unique: false });
          attStore.createIndex('recordStatus', 'recordStatus', { unique: false });
        }

        // 2. Employees Store (Key is Employee ID manually entered by Admin)
        if (!db.objectStoreNames.contains('employees')) {
          const empStore = db.createObjectStore('employees', { keyPath: 'employeeId' });
          empStore.createIndex('supervisorId', 'supervisorId', { unique: false });
          empStore.createIndex('landownerId', 'landownerId', { unique: false });
          empStore.createIndex('locationId', 'locationId', { unique: false });
          empStore.createIndex('employmentStatus', 'employmentStatus', { unique: false });
        }

        // 3. Supervisors Store
        if (!db.objectStoreNames.contains('supervisors')) {
          const supStore = db.createObjectStore('supervisors', { keyPath: 'supervisorId' });
          supStore.createIndex('username', 'username', { unique: true });
        }

        // 4. Landowners Store
        if (!db.objectStoreNames.contains('landowners')) {
          const lndStore = db.createObjectStore('landowners', { keyPath: 'landownerId' });
          lndStore.createIndex('supervisorId', 'supervisorId', { unique: false });
        }

        // 5. Work Locations Store
        if (!db.objectStoreNames.contains('locations')) {
          const locStore = db.createObjectStore('locations', { keyPath: 'locationId' });
          locStore.createIndex('supervisorId', 'supervisorId', { unique: false });
        }

        // 6. Users Store (for offline auth credentials caching)
        if (!db.objectStoreNames.contains('users')) {
          const userStore = db.createObjectStore('users', { keyPath: 'userId' });
          userStore.createIndex('username', 'username', { unique: true });
        }

        // 7. Audit Logs Store
        if (!db.objectStoreNames.contains('auditLogs')) {
          const auditStore = db.createObjectStore('auditLogs', { keyPath: 'logId' });
          auditStore.createIndex('recordId', 'recordId', { unique: false });
          auditStore.createIndex('dateTime', 'dateTime', { unique: false });
        }

        // 8. Settings & App Cache Store (API URL, active user session, last sync time)
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        console.log('[DB] IndexedDB initialized successfully.');
        resolve(this.db);
      };

      request.onerror = (event) => {
        console.error('[DB] Failed to open IndexedDB:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  async getTransaction(storeNames, mode = 'readonly') {
    const db = await this.init();
    return db.transaction(storeNames, mode);
  }

  async put(storeName, item) {
    const tx = await this.getTransaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    return new Promise((resolve, reject) => {
      const request = store.put(item);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async batchPut(storeName, items) {
    if (!items || items.length === 0) return Promise.resolve();
    const tx = await this.getTransaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    return new Promise((resolve, reject) => {
      items.forEach((item) => store.put(item));
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  async get(storeName, key) {
    const tx = await this.getTransaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    return new Promise((resolve, reject) => {
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getAll(storeName) {
    const tx = await this.getTransaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async delete(storeName, key) {
    const tx = await this.getTransaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    return new Promise((resolve, reject) => {
      const request = store.delete(key);
      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(request.error);
    });
  }

  async clear(storeName) {
    const tx = await this.getTransaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    return new Promise((resolve, reject) => {
      const request = store.clear();
      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(request.error);
    });
  }

  async getByIndex(storeName, indexName, value) {
    const tx = await this.getTransaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const index = store.index(indexName);
    return new Promise((resolve, reject) => {
      const request = index.getAll(value);
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async getPendingAttendance() {
    const all = await this.getAll('attendance');
    // Pending sync includes PENDING, FAILED, and any updated records
    return all.filter((r) => r.syncStatus === 'PENDING' || r.syncStatus === 'FAILED');
  }

  async updateAttendanceStatus(recordId, syncStatus, syncDate = null) {
    const record = await this.get('attendance', recordId);
    if (!record) return null;
    record.syncStatus = syncStatus;
    if (syncDate) {
      record.synchronizationDate = syncDate;
    }
    await this.put('attendance', record);
    return record;
  }

  async getSetting(key, defaultValue = null) {
    const res = await this.get('settings', key);
    return res ? res.value : defaultValue;
  }

  async setSetting(key, value) {
    return this.put('settings', { key, value });
  }
}

// Global DB instance
const db = new AttendanceDB();
