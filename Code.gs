/**
 * COCOTRACK ATTENDANCE SYSTEM - BACKEND (GOOGLE APPS SCRIPT) v3
 *
 * What changed in v3
 *  - Every request (except PING and LOGIN) needs a session token issued at login.
 *    Role and supervisor are read from the Users sheet, never trusted from the phone.
 *  - Passwords are stored salted + iterated. Old unsalted hashes still work once and are
 *    upgraded automatically on the next successful login.
 *  - Time IN / Time OUT photos (with watermark) are saved to Google Drive
 *    ("CocoTrack Photos/yyyy-MM") and linked in the Attendance sheet.
 *  - Geofence distance, hours worked and overtime are calculated on the server.
 *  - Leading zeros in IDs are preserved (cells are formatted as text BEFORE writing).
 *  - The phone only downloads recent attendance (default 60 days); reports use date ranges.
 *
 * Deploy: Execute as "Me", Who has access "Anyone". The first deploy after this update will
 * ask for Google Drive permission (needed for photos).
 */

var APP_VERSION = '3.0.0';
var DB_VERSION = '4'; // v4: Profile Photos sheet
var SESSION_DAYS = 30;
var HASH_ITERATIONS = 500;
var MAX_SYNC_RECORDS = 100;
var MAX_PHOTOS_PER_REQUEST = 4;
var MAX_PHOTO_BYTES = 2.5 * 1024 * 1024;
var PHOTO_ROOT_FOLDER = 'CocoTrack Photos';

var DEFAULT_SETTINGS = {
  photoMode: 'required',     // required | optional | off
  geofenceMode: 'warn',      // off | warn | block
  defaultRadiusMeters: 300,  // used when a location has no radius
  maxGpsAccuracyMeters: 100, // GPS readings worse than this are flagged
  regularHours: 8,
  breakMinutes: 60,          // deducted when the day is at least breakAfterHours long
  breakAfterHours: 5,
  restDay: 0,                // 0 = Sunday ... 6 = Saturday, -1 = none
  attendanceDays: 60,        // how many days of attendance a phone downloads
  offlineLoginDays: 30,      // how long a phone may log in offline after the last online login
  maxClockDriftMinutes: 5,
  workStartTime: '07:00 AM', // Time IN after this (+ grace) is late
  lateGraceMinutes: 0
};

var SHEET_NAMES = {
  EMPLOYEES: 'Employees',
  SUPERVISORS: 'Supervisors',
  LANDOWNERS: 'Landowners',
  LOCATIONS: 'Work Locations',
  ATTENDANCE: 'Attendance',
  AUDIT_LOGS: 'Audit Logs',
  USERS: 'Users',
  PROFILE_PHOTOS: 'Profile Photos'
};

var HEADERS = {
  EMPLOYEES: [
    'Employee ID', 'Employee Name', 'Position', 'Department',
    'Supervisor ID', 'Supervisor Name', 'Landowner ID', 'Landowner Name',
    'Location ID', 'Work Location', 'Employment Status', 'Date Enrolled'
  ],
  SUPERVISORS: [
    'Supervisor ID', 'Supervisor Name', 'Username', 'Password Hash', 'Account Status'
  ],
  LANDOWNERS: [
    'Landowner ID', 'Landowner Name', 'Location ID', 'Work Location', 'Supervisor ID', 'Status'
  ],
  LOCATIONS: [
    'Location ID', 'Work Location Name', 'Description', 'Landowner ID', 'Landowner Name', 'Supervisor ID', 'Status',
    'Latitude', 'Longitude', 'Radius Meters'
  ],
  ATTENDANCE: [
    'Attendance Record ID', 'Employee ID', 'Employee Name', 'Supervisor ID', 'Supervisor Name',
    'Landowner ID', 'Landowner Name', 'Location ID', 'Work Location', 'Attendance Date',
    'Time IN', 'Time OUT', 'Original Time IN', 'Original Time OUT', 'Adjusted By',
    'Adjustment Reason', 'Actual GPS IN', 'Actual GPS OUT', 'Device Timestamp',
    'Synchronization Date', 'Synchronization Status', 'Record Status',
    'Attendance Type', 'Leave Type', 'Leave Remarks',
    'Photo IN', 'Photo OUT', 'Distance IN Meters', 'Distance OUT Meters',
    'Geofence IN', 'Geofence OUT', 'Hours Worked', 'Overtime Hours', 'Clock Flag', 'Device Timestamp OUT'
  ],
  AUDIT_LOGS: [
    'Log ID', 'User ID', 'User Role', 'Action', 'Record ID',
    'Previous Value', 'New Value', 'Reason', 'Date and Time'
  ],
  USERS: [
    'User ID', 'Username', 'Password Hash', 'Role', 'Linked Supervisor ID', 'Account Status', 'Last Login',
    'Salt', 'Must Change Password'
  ],
  PROFILE_PHOTOS: [
    'Photo Key', 'Type', 'Owner ID', 'Image', 'Updated At', 'Updated By'
  ]
};

// Columns that hold numbers (everything else is written as plain text)
var NUMERIC_COLUMNS = {
  'Latitude': '0.000000', 'Longitude': '0.000000', 'Radius Meters': '0',
  'Distance IN Meters': '0', 'Distance OUT Meters': '0',
  'Hours Worked': '0.00', 'Overtime Hours': '0.00'
};

var PUBLIC_ACTIONS = { PING: true, SETUP_DB: true, LOGIN: true };
var ADMIN_ACTIONS = {
  SAVE_EMPLOYEE: true, SAVE_SUPERVISOR: true, SAVE_LANDOWNER: true, SAVE_LOCATION: true,
  SAVE_USER: true, GET_AUDIT_LOGS: true, SAVE_APP_SETTINGS: true
};
var WRITE_ACTIONS = {
  LOGIN: true, SYNC_ATTENDANCE_BATCH: true, UPLOAD_PHOTOS: true, SAVE_EMPLOYEE: true,
  SAVE_SUPERVISOR: true, SAVE_LANDOWNER: true, SAVE_LOCATION: true, SAVE_USER: true,
  SOFT_DELETE_ATTENDANCE: true, CHANGE_PASSWORD: true, SAVE_APP_SETTINGS: true, SAVE_PROFILE_PHOTO: true
};
var MAX_PROFILE_IMAGE_CHARS = 48000; // small JPEG (about 240 x 240) stored as text in one cell

/* ==========================================================================
   ENTRY POINTS
   ========================================================================== */

function doGet(e) {
  return respondJSON({
    success: true,
    message: 'CocoTrack Attendance API is running.',
    version: APP_VERSION,
    serverTime: new Date().toISOString()
  });
}

function doPost(e) {
  var payload;
  try {
    if (!e || !e.postData || !e.postData.contents) return fail('Missing request body.', 'VALIDATION');
    payload = JSON.parse(e.postData.contents);
  } catch (parseErr) {
    return fail('Request body is not valid JSON.', 'VALIDATION');
  }

  var action = payload.action;
  var lock = null;

  try {
    if (WRITE_ACTIONS[action]) {
      lock = LockService.getScriptLock();
      if (!lock.tryLock(30000)) return fail('Server busy, please retry in a moment.', 'BUSY');
    }

    ensureDatabase();

    if (action === 'PING' || action === 'SETUP_DB') {
      return respondJSON({ success: true, message: 'Connected. Database is ready.', version: APP_VERSION, serverTime: new Date().toISOString() });
    }
    if (action === 'LOGIN') return handleLogin(payload);

    var session = requireSession(payload.token);
    if (ADMIN_ACTIONS[action] && session.role !== 'Admin') {
      return fail('Only administrators can do this.', 'FORBIDDEN');
    }

    switch (action) {
      case 'LOGOUT': return handleLogout(payload);
      case 'CHANGE_PASSWORD': return handleChangePassword(session, payload);
      case 'GET_INITIAL_DATA': return handleGetInitialData(session, payload);
      case 'GET_ATTENDANCE_RANGE': return handleGetAttendanceRange(session, payload);
      case 'SYNC_ATTENDANCE_BATCH': return handleSyncAttendanceBatch(session, payload);
      case 'UPLOAD_PHOTOS': return handleUploadPhotos(session, payload);
      case 'GET_PHOTO': return handleGetPhoto(session, payload);
      case 'SAVE_EMPLOYEE': return handleSaveEmployee(session, payload);
      case 'SAVE_SUPERVISOR': return handleSaveSupervisor(session, payload);
      case 'SAVE_LANDOWNER': return handleSaveLandowner(session, payload);
      case 'SAVE_LOCATION': return handleSaveLocation(session, payload);
      case 'SAVE_USER': return handleSaveUser(session, payload);
      case 'SAVE_APP_SETTINGS': return handleSaveAppSettings(session, payload);
      case 'SOFT_DELETE_ATTENDANCE': return handleSoftDeleteAttendance(session, payload);
      case 'GET_AUDIT_LOGS': return handleGetAuditLogs(session, payload);
      case 'SAVE_PROFILE_PHOTO': return handleSaveProfilePhoto(session, payload);
      case 'GET_PROFILE_PHOTOS': return handleGetProfilePhotos(session, payload);
      default: return fail('Unknown action: ' + action, 'VALIDATION');
    }
  } catch (err) {
    if (err && err.code) return fail(err.message, err.code);
    console.error(err);
    return fail(String(err), 'SERVER');
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (x) {} }
  }
}

function respondJSON(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function fail(message, code) {
  return respondJSON({ success: false, error: message, code: code || 'SERVER' });
}

function AppError(message, code) {
  var e = new Error(message);
  e.code = code;
  return e;
}

/* ==========================================================================
   DATABASE SETUP & MIGRATION
   ========================================================================== */

function ensureDatabase() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('DB_VERSION') === DB_VERSION) return;
  setupDatabase();
  props.setProperty('DB_VERSION', DB_VERSION);
}

/** Run this once from the editor if you ever want to force a re-check of all sheets. */
function setupDatabase() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  for (var key in SHEET_NAMES) {
    var sheet = ss.getSheetByName(SHEET_NAMES[key]);
    var headers = HEADERS[key];
    if (!sheet) sheet = ss.insertSheet(SHEET_NAMES[key]);

    // Add any header that is missing (new columns are appended; existing data is untouched)
    var width = Math.max(sheet.getLastColumn(), headers.length);
    var current = sheet.getLastRow() === 0 ? [] : sheet.getRange(1, 1, 1, width).getValues()[0];
    for (var h = 0; h < headers.length; h++) {
      if (!current[h]) {
        var cell = sheet.getRange(1, h + 1);
        cell.setValue(headers[h]).setBackground('#15803d').setFontColor('#ffffff').setFontWeight('bold');
        sheet.setColumnWidth(h + 1, 160);
      }
    }
    sheet.setFrozenRows(1);
  }

  // Passwords now live only in the Users sheet (salted). Clear copies in the Supervisors sheet.
  var supSheet = ss.getSheetByName(SHEET_NAMES.SUPERVISORS);
  if (supSheet.getLastRow() > 1) {
    supSheet.getRange(2, 4, supSheet.getLastRow() - 1, 1).clearContent();
  }

  // Default admin (admin / admin123) - must change password at first login
  var userSheet = ss.getSheetByName(SHEET_NAMES.USERS);
  if (userSheet.getLastRow() <= 1) {
    var salt = newSalt();
    var clientHash = sha256Hex('admin123'); // same as what the app sends
    writeRow(userSheet, 2, HEADERS.USERS, {
      'User ID': 'USR-ADMIN-1', 'Username': 'admin', 'Password Hash': serverHash(salt, clientHash),
      'Role': 'Admin', 'Linked Supervisor ID': '', 'Account Status': 'Active', 'Last Login': '',
      'Salt': salt, 'Must Change Password': 'TRUE'
    });
  }
}

/* ==========================================================================
   SHEET HELPERS
   ========================================================================== */

function getSheet(name) {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
}

function headerIndex(headers) {
  var map = {};
  for (var i = 0; i < headers.length; i++) map[headers[i]] = i;
  return map;
}

/** Builds a row array (in header order) from an object keyed by header name. */
function buildRow(headers, obj) {
  return headers.map(function (h) {
    var v = obj[h];
    if (v === undefined || v === null) return '';
    if (NUMERIC_COLUMNS[h]) return (v === '' || isNaN(Number(v))) ? '' : Number(v);
    return String(v);
  });
}

function rowFormats(headers) {
  return headers.map(function (h) { return NUMERIC_COLUMNS[h] || '@'; });
}

/** Writes one row, formatting text cells as text FIRST so "0001" stays "0001". */
function writeRow(sheet, rowIndex, headers, obj) {
  var range = sheet.getRange(rowIndex, 1, 1, headers.length);
  range.setNumberFormats([rowFormats(headers)]);
  range.setValues([buildRow(headers, obj)]);
}

function writeRows(sheet, startRow, headers, objs) {
  if (!objs.length) return;
  var range = sheet.getRange(startRow, 1, objs.length, headers.length);
  var fmt = rowFormats(headers);
  range.setNumberFormats(objs.map(function () { return fmt; }));
  range.setValues(objs.map(function (o) { return buildRow(headers, o); }));
}

/** Reads a sheet into objects keyed by header NAME (raw) plus row number. */
function readRowsByHeader(sheetName, headers) {
  var sheet = getSheet(sheetName);
  var last = sheet.getLastRow();
  if (last <= 1) return [];
  var range = sheet.getRange(2, 1, last - 1, headers.length);
  var values = range.getValues();
  var display = range.getDisplayValues();
  var out = [];
  for (var r = 0; r < values.length; r++) {
    var o = { _row: r + 2 };
    for (var c = 0; c < headers.length; c++) {
      o[headers[c]] = normalizeCell(toCamelCase(headers[c]), values[r][c], display[r][c]);
    }
    out.push(o);
  }
  return out;
}

/** Converts header-keyed objects to camelCase objects for the app. */
function toApp(rowObj, headers, omit) {
  var o = {};
  headers.forEach(function (h) {
    if (omit && omit[h]) return;
    o[toCamelCase(h)] = rowObj[h] === undefined ? '' : rowObj[h];
  });
  return o;
}

function fromApp(appObj, headers) {
  var o = {};
  headers.forEach(function (h) {
    var k = toCamelCase(h);
    if (appObj[k] !== undefined) o[h] = appObj[k];
  });
  return o;
}

/**
 * Google Sheets turns "2026-10-26", "07:01 AM" or "0001" into dates/numbers.
 * Convert them back so the app always receives plain strings.
 */
function normalizeCell(key, v, displayValue) {
  if (v instanceof Date) {
    var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
    if (key === 'attendanceDate' || key === 'dateEnrolled') return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
    if (/^(time|originalTime)/.test(key)) {
      return (displayValue || '').replace(/(\d{1,2}:\d{2}):\d{2}(\s*[AaPp][Mm])/, '$1$2').replace(/^(\d):/, '0$1:');
    }
    return v.toISOString();
  }
  if (typeof v === 'number' && /Id$/.test(key)) return String(v);
  return v;
}

function toCamelCase(str) {
  return String(str).toLowerCase().replace(/[^a-zA-Z0-9]+(.)/g, function (m, chr) { return chr.toUpperCase(); });
}

/* ==========================================================================
   PASSWORDS & SESSIONS
   ========================================================================== */

function bytesToHex(bytes) {
  return bytes.map(function (b) { var x = (b < 0 ? b + 256 : b).toString(16); return x.length === 1 ? '0' + x : x; }).join('');
}

function sha256Hex(str) {
  return bytesToHex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8));
}

function newSalt() {
  return sha256Hex(Utilities.getUuid() + Math.random() + Date.now()).substring(0, 32);
}

/** clientHash = SHA-256(password) computed by the phone. We salt + stretch it before storing. */
function serverHash(salt, clientHash) {
  var h = salt + ':' + clientHash;
  for (var i = 0; i < HASH_ITERATIONS; i++) h = sha256Hex(salt + h);
  return h;
}

function safeEquals(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Returns true if clientHash matches. Upgrades legacy unsalted hashes in place. */
function verifyPassword(userRow, clientHash) {
  var sheet = getSheet(SHEET_NAMES.USERS);
  var salt = String(userRow['Salt'] || '');
  var stored = String(userRow['Password Hash'] || '');
  if (!clientHash || !stored) return false;

  if (!salt) {
    // Legacy v2 account: the stored value is the plain SHA-256 of the password.
    if (!safeEquals(stored, clientHash)) return false;
    var s = newSalt();
    userRow['Salt'] = s;
    userRow['Password Hash'] = serverHash(s, clientHash);
    writeRow(sheet, userRow._row, HEADERS.USERS, userRow);
    return true;
  }
  return safeEquals(stored, serverHash(salt, clientHash));
}

function setPassword(userRow, clientHash, mustChange) {
  var s = newSalt();
  userRow['Salt'] = s;
  userRow['Password Hash'] = serverHash(s, clientHash);
  userRow['Must Change Password'] = mustChange ? 'TRUE' : 'FALSE';
}

function findUserBy(field, value) {
  var users = readRowsByHeader(SHEET_NAMES.USERS, HEADERS.USERS);
  var v = String(value || '').trim().toLowerCase();
  for (var i = 0; i < users.length; i++) {
    if (String(users[i][field] || '').trim().toLowerCase() === v) return users[i];
  }
  return null;
}

function createSession(userId) {
  var token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  var exp = Date.now() + SESSION_DAYS * 86400000;
  PropertiesService.getScriptProperties().setProperty('S_' + sha256Hex(token), JSON.stringify({ u: userId, exp: exp }));
  return { token: token, expiresAt: new Date(exp).toISOString() };
}

function cleanupSessions() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var now = Date.now();
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('S_') !== 0) return;
    try { if (JSON.parse(all[k]).exp < now) props.deleteProperty(k); } catch (e) { props.deleteProperty(k); }
  });
}

/** Validates the token and returns the CURRENT user details from the Users sheet. */
function requireSession(token) {
  if (!token) throw AppError('Please log in again (no session).', 'AUTH_REQUIRED');
  var props = PropertiesService.getScriptProperties();
  var key = 'S_' + sha256Hex(String(token));
  var raw = props.getProperty(key);
  if (!raw) throw AppError('Your session has ended. Please log in again while online.', 'AUTH_REQUIRED');
  var s = JSON.parse(raw);
  if (s.exp < Date.now()) {
    props.deleteProperty(key);
    throw AppError('Your session expired. Please log in again while online.', 'AUTH_EXPIRED');
  }
  var user = findUserBy('User ID', s.u);
  if (!user) { props.deleteProperty(key); throw AppError('Account no longer exists.', 'AUTH_REQUIRED'); }
  if (user['Account Status'] !== 'Active') {
    props.deleteProperty(key);
    throw AppError('Account is deactivated. Contact administrator.', 'ACCOUNT_DISABLED');
  }
  return {
    key: key,
    userId: String(user['User ID']),
    username: String(user['Username']),
    role: String(user['Role'] || 'Supervisor'),
    supervisorId: String(user['Linked Supervisor ID'] || ''),
    mustChangePassword: String(user['Must Change Password']).toUpperCase() === 'TRUE'
  };
}

function getSupervisorName(supervisorId) {
  if (!supervisorId) return '';
  var sups = readRowsByHeader(SHEET_NAMES.SUPERVISORS, HEADERS.SUPERVISORS);
  for (var i = 0; i < sups.length; i++) {
    if (String(sups[i]['Supervisor ID']) === String(supervisorId)) return String(sups[i]['Supervisor Name']);
  }
  return '';
}

/* ==========================================================================
   SETTINGS
   ========================================================================== */

function getAppSettings() {
  var raw = PropertiesService.getScriptProperties().getProperty('APP_SETTINGS');
  var saved = {};
  try { saved = raw ? JSON.parse(raw) : {}; } catch (e) {}
  var out = {};
  for (var k in DEFAULT_SETTINGS) out[k] = saved[k] !== undefined ? saved[k] : DEFAULT_SETTINGS[k];
  return out;
}

function handleSaveAppSettings(session, payload) {
  var incoming = payload.settings || {};
  var cur = getAppSettings();
  var enums = { photoMode: ['required', 'optional', 'off'], geofenceMode: ['off', 'warn', 'block'] };
  var ranges = {
    defaultRadiusMeters: [10, 20000], maxGpsAccuracyMeters: [5, 5000], regularHours: [1, 24],
    breakMinutes: [0, 240], breakAfterHours: [0, 24], restDay: [-1, 6], attendanceDays: [7, 366],
    offlineLoginDays: [1, 90], maxClockDriftMinutes: [1, 120], lateGraceMinutes: [0, 120]
  };
  Object.keys(incoming).forEach(function (k) {
    if (k === 'workStartTime') {
      var mins = parseTimeToMinutes(incoming[k]);
      if (mins === null) throw AppError('Invalid work start time.', 'VALIDATION');
      cur[k] = String(incoming[k]).trim().toUpperCase();
    } else if (enums[k]) {
      if (enums[k].indexOf(incoming[k]) === -1) throw AppError('Invalid value for ' + k, 'VALIDATION');
      cur[k] = incoming[k];
    } else if (ranges[k]) {
      var n = Number(incoming[k]);
      if (isNaN(n) || n < ranges[k][0] || n > ranges[k][1]) throw AppError('Invalid value for ' + k, 'VALIDATION');
      cur[k] = n;
    }
  });
  PropertiesService.getScriptProperties().setProperty('APP_SETTINGS', JSON.stringify(cur));
  logAudits([auditEntry(session, 'UPDATE_SETTINGS', 'APP_SETTINGS', '', JSON.stringify(cur), 'System settings updated')]);
  return respondJSON({ success: true, settings: cur });
}

/* ==========================================================================
   AUTH HANDLERS
   ========================================================================== */

function handleLogin(payload) {
  var username = String(payload.username || '').trim();
  var clientHash = String(payload.passwordHash || '').trim();
  if (!username || !clientHash) return fail('Invalid username or password.', 'INVALID_CREDENTIALS');

  var user = findUserBy('Username', username);
  if (!user || !verifyPassword(user, clientHash)) {
    return fail('Invalid username or password.', 'INVALID_CREDENTIALS');
  }
  if (user['Account Status'] !== 'Active') {
    return fail('Account is deactivated. Contact administrator.', 'ACCOUNT_DISABLED');
  }

  user['Last Login'] = new Date().toISOString();
  writeRow(getSheet(SHEET_NAMES.USERS), user._row, HEADERS.USERS, user);

  if (Math.random() < 0.2) cleanupSessions();
  var sess = createSession(String(user['User ID']));
  var supId = String(user['Linked Supervisor ID'] || '');

  return respondJSON({
    success: true,
    token: sess.token,
    tokenExpiresAt: sess.expiresAt,
    serverTime: new Date().toISOString(),
    settings: getAppSettings(),
    user: {
      userId: String(user['User ID']),
      username: String(user['Username']),
      role: String(user['Role']),
      linkedSupervisorId: supId,
      name: getSupervisorName(supId) || String(user['Username']),
      accountStatus: 'Active',
      mustChangePassword: String(user['Must Change Password']).toUpperCase() === 'TRUE'
    }
  });
}

function handleLogout(payload) {
  try {
    PropertiesService.getScriptProperties().deleteProperty('S_' + sha256Hex(String(payload.token)));
  } catch (e) {}
  return respondJSON({ success: true });
}

function handleChangePassword(session, payload) {
  var cur = String(payload.currentPasswordHash || '');
  var next = String(payload.newPasswordHash || '');
  if (!/^[a-f0-9]{64}$/.test(next)) return fail('Invalid new password.', 'VALIDATION');
  var user = findUserBy('User ID', session.userId);
  if (!verifyPassword(user, cur)) return fail('Current password is incorrect.', 'INVALID_CREDENTIALS');
  if (safeEquals(cur, next)) return fail('New password must be different from the current one.', 'VALIDATION');
  user = findUserBy('User ID', session.userId); // re-read (verifyPassword may have upgraded it)
  setPassword(user, next, false);
  writeRow(getSheet(SHEET_NAMES.USERS), user._row, HEADERS.USERS, user);
  logAudits([auditEntry(session, 'CHANGE_PASSWORD', session.username, '', '', 'User changed own password')]);
  return respondJSON({ success: true });
}

/* ==========================================================================
   DATA DOWNLOAD
   ========================================================================== */

function dateDaysAgo(days) {
  var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  return Utilities.formatDate(new Date(Date.now() - days * 86400000), tz, 'yyyy-MM-dd');
}

function scopeAttendance(session, rows) {
  if (session.role === 'Admin') return rows;
  return rows.filter(function (a) { return String(a['Supervisor ID'] || '') === session.supervisorId; });
}

function handleGetInitialData(session, payload) {
  var settings = getAppSettings();
  var H = HEADERS;

  var employees = readRowsByHeader(SHEET_NAMES.EMPLOYEES, H.EMPLOYEES);
  var supervisors = readRowsByHeader(SHEET_NAMES.SUPERVISORS, H.SUPERVISORS);
  var landowners = readRowsByHeader(SHEET_NAMES.LANDOWNERS, H.LANDOWNERS);
  var locations = readRowsByHeader(SHEET_NAMES.LOCATIONS, H.LOCATIONS);
  var fromDate = dateDaysAgo(Number(settings.attendanceDays) || 60);
  var attendance = readRowsByHeader(SHEET_NAMES.ATTENDANCE, H.ATTENDANCE).filter(function (a) {
    return String(a['Attendance Date'] || '') >= fromDate;
  });
  var users = session.role === 'Admin' ? readRowsByHeader(SHEET_NAMES.USERS, H.USERS) : [];

  if (session.role !== 'Admin') {
    var sid = session.supervisorId;
    employees = employees.filter(function (e) { return String(e['Supervisor ID'] || '') === sid; });
    locations = locations.filter(function (l) { return String(l['Supervisor ID'] || '') === sid; });
    var myLocIds = {}, myLocLandownerIds = {};
    locations.forEach(function (loc) {
      if ((loc['Status'] || 'Active') === 'Active') {
        myLocIds[String(loc['Location ID'])] = true;
        if (loc['Landowner ID']) myLocLandownerIds[String(loc['Landowner ID'])] = true;
      }
    });
    landowners = landowners.filter(function (l) {
      if ((l['Status'] || 'Active') !== 'Active') return false;
      return !!myLocIds[String(l['Location ID'] || '')] || !!myLocLandownerIds[String(l['Landowner ID'] || '')];
    });
    supervisors = supervisors.filter(function (s) { return String(s['Supervisor ID']) === sid; });
    attendance = scopeAttendance(session, attendance);
  }

  return respondJSON({
    success: true,
    serverTime: new Date().toISOString(),
    settings: settings,
    attendanceFrom: fromDate,
    me: { role: session.role, linkedSupervisorId: session.supervisorId, mustChangePassword: session.mustChangePassword },
    data: {
      employees: employees.map(function (r) { return toApp(r, H.EMPLOYEES); }),
      supervisors: supervisors.map(function (r) { return toApp(r, H.SUPERVISORS, { 'Password Hash': true }); }),
      landowners: landowners.map(function (r) { return toApp(r, H.LANDOWNERS); }),
      locations: locations.map(function (r) { return toApp(r, H.LOCATIONS); }),
      attendance: attendance.map(function (r) { return toApp(r, H.ATTENDANCE); }),
      users: users.map(function (r) { return toApp(r, H.USERS, { 'Password Hash': true, 'Salt': true }); })
    }
  });
}

function handleGetAttendanceRange(session, payload) {
  var from = String(payload.from || ''), to = String(payload.to || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return fail('Invalid date range.', 'VALIDATION');
  var rows = readRowsByHeader(SHEET_NAMES.ATTENDANCE, HEADERS.ATTENDANCE).filter(function (a) {
    var d = String(a['Attendance Date'] || '');
    return d >= from && d <= to;
  });
  rows = scopeAttendance(session, rows);
  return respondJSON({ success: true, attendance: rows.map(function (r) { return toApp(r, HEADERS.ATTENDANCE); }) });
}

/* ==========================================================================
   ATTENDANCE SYNC
   ========================================================================== */

function parseTimeToMinutes(t) {
  var m = String(t || '').trim().match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])?$/);
  if (!m) return null;
  var h = Number(m[1]), min = Number(m[2]);
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    var pm = m[3].toUpperCase() === 'PM';
    if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12;
  } else if (h > 23) return null;
  return h * 60 + min;
}

function computeHours(timeIn, timeOut, settings) {
  var a = parseTimeToMinutes(timeIn), b = parseTimeToMinutes(timeOut);
  if (a === null || b === null) return { hours: '', overtime: '' };
  var diff = b - a;
  if (diff < 0) diff += 1440; // overnight shift
  if (diff >= Number(settings.breakAfterHours) * 60) diff -= Number(settings.breakMinutes) || 0;
  if (diff < 0) diff = 0;
  var hours = Math.round(diff / 60 * 100) / 100;
  var ot = Math.max(0, Math.round((hours - Number(settings.regularHours)) * 100) / 100);
  return { hours: hours, overtime: ot };
}

function parseGps(str) {
  var m = String(str || '').match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)(?:.*?±\s*(\d+(?:\.\d+)?))?/);
  if (!m) return null;
  return { lat: Number(m[1]), lng: Number(m[2]), acc: m[3] ? Number(m[3]) : null };
}

function distanceMeters(lat1, lng1, lat2, lng2) {
  var R = 6371000, toRad = Math.PI / 180;
  var dLat = (lat2 - lat1) * toRad, dLng = (lng2 - lng1) * toRad;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function geofenceCheck(gpsStr, loc, settings) {
  if (!gpsStr) return { distance: '', status: '' };
  var g = parseGps(gpsStr);
  if (!g) return { distance: '', status: 'NO_GPS' };
  if (!loc || loc['Latitude'] === '' || loc['Longitude'] === '' || loc['Latitude'] === undefined) {
    return { distance: '', status: 'NO_LOCATION_COORDS' };
  }
  var d = distanceMeters(g.lat, g.lng, Number(loc['Latitude']), Number(loc['Longitude']));
  var radius = Number(loc['Radius Meters']) || Number(settings.defaultRadiusMeters) || 300;
  var status = d <= radius ? 'INSIDE' : 'OUTSIDE';
  if (g.acc !== null && g.acc > Number(settings.maxGpsAccuracyMeters)) status += '_LOW_ACCURACY';
  return { distance: d, status: status };
}

function handleSyncAttendanceBatch(session, payload) {
  var records = payload.records || [];
  if (!records.length) return respondJSON({ success: true, syncedIds: [], rejected: [] });
  if (records.length > MAX_SYNC_RECORDS) return fail('Too many records in one batch (max ' + MAX_SYNC_RECORDS + ').', 'VALIDATION');

  var H = HEADERS.ATTENDANCE;
  var settings = getAppSettings();
  var sheet = getSheet(SHEET_NAMES.ATTENDANCE);
  var existing = readRowsByHeader(SHEET_NAMES.ATTENDANCE, H);
  var byId = {};
  existing.forEach(function (r) { byId[String(r['Attendance Record ID'])] = r; });

  var employees = {};
  readRowsByHeader(SHEET_NAMES.EMPLOYEES, HEADERS.EMPLOYEES).forEach(function (e) { employees[String(e['Employee ID'])] = e; });
  var locations = {};
  readRowsByHeader(SHEET_NAMES.LOCATIONS, HEADERS.LOCATIONS).forEach(function (l) { locations[String(l['Location ID'])] = l; });

  var isAdmin = session.role === 'Admin';
  var now = new Date();
  var nowIso = now.toISOString();
  var syncedIds = [], rejected = [], newRows = [], audits = [];
  var nextRow = Math.max(sheet.getLastRow(), 1) + 1;

  records.forEach(function (rec) {
    var id = String(rec.attendanceRecordId || '');
    try {
      if (!/^REC-[A-Za-z0-9-]{4,60}$/.test(id)) throw new Error('Invalid record ID.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(rec.attendanceDate || ''))) throw new Error('Invalid attendance date.');
      if (rec.timeIn && parseTimeToMinutes(rec.timeIn) === null) throw new Error('Invalid Time IN format.');
      if (rec.timeOut && parseTimeToMinutes(rec.timeOut) === null) throw new Error('Invalid Time OUT format.');

      var prev = byId[id];
      var emp = employees[String(rec.employeeId)];

      if (!isAdmin) {
        if (prev && String(prev['Supervisor ID']) !== session.supervisorId) throw new Error('This record belongs to another supervisor.');
        if (!prev && (!emp || String(emp['Supervisor ID']) !== session.supervisorId)) throw new Error('Employee is not assigned to you.');
      }
      if (!prev && !emp) throw new Error('Employee ID not found.');

      var obj = fromApp(rec, H);
      if (!isAdmin) {
        obj['Supervisor ID'] = prev ? prev['Supervisor ID'] : session.supervisorId;
        obj['Supervisor Name'] = prev ? prev['Supervisor Name'] : (emp['Supervisor Name'] || rec.supervisorName || '');
      }

      // Keep server-owned values the phone does not know about
      if (prev) {
        ['Photo IN', 'Photo OUT'].forEach(function (k) { if (!obj[k]) obj[k] = prev[k]; });
        if (!obj['Original Time IN']) obj['Original Time IN'] = prev['Original Time IN'];
        if (!obj['Original Time OUT']) obj['Original Time OUT'] = prev['Original Time OUT'];
      }

      var loc = locations[String(obj['Location ID'] || '')];
      var gIn = geofenceCheck(obj['Actual GPS IN'], loc, settings);
      var gOut = geofenceCheck(obj['Actual GPS OUT'], loc, settings);
      obj['Distance IN Meters'] = gIn.distance; obj['Geofence IN'] = gIn.status;
      obj['Distance OUT Meters'] = gOut.distance; obj['Geofence OUT'] = gOut.status;

      var hrs = computeHours(obj['Time IN'], obj['Time OUT'], settings);
      obj['Hours Worked'] = hrs.hours; obj['Overtime Hours'] = hrs.overtime;

      // Clock check: a device timestamp in the future means the phone clock is wrong
      var flags = String(rec.clockFlag || '').split(',').filter(String);
      var devTs = Date.parse(rec.deviceTimestamp || '');
      var driftMs = Number(settings.maxClockDriftMinutes) * 60000;
      if (!isNaN(devTs) && devTs - now.getTime() > driftMs && flags.indexOf('FUTURE_TIME') === -1) flags.push('FUTURE_TIME');
      obj['Clock Flag'] = flags.join(',');

      obj['Device Timestamp'] = obj['Device Timestamp'] || nowIso;
      obj['Synchronization Date'] = nowIso;
      obj['Synchronization Status'] = 'SYNCED';
      obj['Record Status'] = obj['Record Status'] || 'ACTIVE';
      obj['Attendance Type'] = obj['Attendance Type'] || 'PRESENT';

      var isLeave = String(obj['Attendance Type']).toUpperCase() === 'LEAVE';

      if (prev) {
        var before = {
          date: prev['Attendance Date'], timeIn: prev['Time IN'], timeOut: prev['Time OUT'],
          landowner: prev['Landowner Name'], status: prev['Record Status']
        };
        var after = {
          date: obj['Attendance Date'], timeIn: obj['Time IN'], timeOut: obj['Time OUT'],
          landowner: obj['Landowner Name'], status: obj['Record Status']
        };
        writeRow(sheet, prev._row, H, obj);
        obj._row = prev._row;
        byId[id] = obj;

        if (JSON.stringify(before) !== JSON.stringify(after)) {
          if (after.status === 'DELETED' && before.status !== 'DELETED') {
            audits.push(auditEntry(session, isLeave ? 'CANCEL_LEAVE' : 'SOFT_DELETE_ATTENDANCE', id, JSON.stringify(before), 'DELETED', rec.deleteReason || rec.employeeName || ''));
          } else if (rec.adjustmentReason && (before.timeIn !== after.timeIn || before.timeOut !== after.timeOut || before.date !== after.date || before.landowner !== after.landowner)) {
            audits.push(auditEntry(session, 'UPDATE_ATTENDANCE', id, JSON.stringify(before), JSON.stringify(after), rec.adjustmentReason));
          }
        }
      } else {
        obj._row = nextRow++;
        newRows.push(obj);
        byId[id] = obj;
        if (isLeave) audits.push(auditEntry(session, 'RECORD_LEAVE', id, '', (obj['Leave Type'] || 'Leave') + ' - ' + obj['Employee Name'] + ' - ' + obj['Attendance Date'], obj['Leave Remarks'] || ''));
        else if (rec.adjustmentReason) audits.push(auditEntry(session, 'MANUAL_ATTENDANCE', id, '', JSON.stringify({ date: obj['Attendance Date'], timeIn: obj['Time IN'], timeOut: obj['Time OUT'] }), rec.adjustmentReason));
      }
      syncedIds.push(id);
    } catch (err) {
      rejected.push({ id: id, reason: err.message });
    }
  });

  if (newRows.length) writeRows(sheet, newRows[0]._row, H, newRows);
  logAudits(audits);

  var serverValues = {};
  syncedIds.forEach(function (id) {
    var o = byId[id];
    serverValues[id] = {
      hoursWorked: o['Hours Worked'], overtimeHours: o['Overtime Hours'],
      distanceInMeters: o['Distance IN Meters'], distanceOutMeters: o['Distance OUT Meters'],
      geofenceIn: o['Geofence IN'], geofenceOut: o['Geofence OUT'],
      photoIn: o['Photo IN'] || '', photoOut: o['Photo OUT'] || '', clockFlag: o['Clock Flag'] || ''
    };
  });

  return respondJSON({ success: true, syncedIds: syncedIds, rejected: rejected, serverValues: serverValues, count: syncedIds.length });
}

/* ==========================================================================
   PHOTOS (Google Drive)
   ========================================================================== */

function getPhotoFolder(dateStr) {
  var props = PropertiesService.getScriptProperties();
  var rootId = props.getProperty('PHOTO_ROOT_ID');
  var root = null;
  if (rootId) { try { root = DriveApp.getFolderById(rootId); } catch (e) { root = null; } }
  if (!root) {
    var it = DriveApp.getFoldersByName(PHOTO_ROOT_FOLDER);
    root = it.hasNext() ? it.next() : DriveApp.createFolder(PHOTO_ROOT_FOLDER);
    props.setProperty('PHOTO_ROOT_ID', root.getId());
  }
  var month = String(dateStr || '').substring(0, 7) || 'undated';
  var sub = root.getFoldersByName(month);
  return sub.hasNext() ? sub.next() : root.createFolder(month);
}

function handleUploadPhotos(session, payload) {
  var photos = payload.photos || [];
  if (photos.length > MAX_PHOTOS_PER_REQUEST) return fail('Too many photos in one request.', 'VALIDATION');

  var H = HEADERS.ATTENDANCE;
  var sheet = getSheet(SHEET_NAMES.ATTENDANCE);
  var rows = readRowsByHeader(SHEET_NAMES.ATTENDANCE, H);
  var byId = {};
  rows.forEach(function (r) { byId[String(r['Attendance Record ID'])] = r; });

  var uploaded = [], rejected = [];

  photos.forEach(function (p) {
    try {
      var kind = p.kind === 'OUT' ? 'OUT' : 'IN';
      var col = kind === 'OUT' ? 'Photo OUT' : 'Photo IN';
      var row = byId[String(p.recordId)];
      if (!row) throw new Error('RECORD_NOT_SYNCED');
      if (session.role !== 'Admin' && String(row['Supervisor ID']) !== session.supervisorId) throw new Error('Not your record.');

      var fileName = row['Attendance Date'] + '_' + row['Employee ID'] + '_' + kind + '_' + p.recordId + '.jpg';
      var folder = getPhotoFolder(row['Attendance Date']);

      // Idempotent: if this photo was already uploaded, reuse it
      var file = null;
      var existing = folder.getFilesByName(fileName);
      if (existing.hasNext()) file = existing.next();

      if (!file) {
        var m = String(p.dataUrl || '').match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/);
        if (!m) throw new Error('Photo data is not a valid image.');
        var bytes = Utilities.base64Decode(m[2]);
        if (bytes.length > MAX_PHOTO_BYTES) throw new Error('Photo is too large.');
        var blob = Utilities.newBlob(bytes, 'image/jpeg', fileName);
        file = folder.createFile(blob);
        file.setDescription('CocoTrack ' + kind + ' | ' + row['Employee Name'] + ' | ' + row['Attendance Date'] +
          ' | taken ' + (p.takenAt || '') + ' | by ' + session.username);
      }

      var url = file.getUrl();
      if (row[col] !== url) {
        var colIdx = headerIndex(H)[col] + 1;
        sheet.getRange(row._row, colIdx).setNumberFormat('@').setValue(url);
        row[col] = url;
      }
      uploaded.push({ photoId: p.photoId, recordId: p.recordId, kind: kind, url: url, fileId: file.getId() });
    } catch (err) {
      rejected.push({ photoId: p.photoId, recordId: p.recordId, reason: err.message });
    }
  });

  return respondJSON({ success: true, uploaded: uploaded, rejected: rejected });
}

/** Returns a photo as a data URL so the app can show it without sharing the Drive file. */
function handleGetPhoto(session, payload) {
  var rows = readRowsByHeader(SHEET_NAMES.ATTENDANCE, HEADERS.ATTENDANCE);
  var row = null;
  for (var i = 0; i < rows.length; i++) if (String(rows[i]['Attendance Record ID']) === String(payload.recordId)) { row = rows[i]; break; }
  if (!row) return fail('Record not found.', 'VALIDATION');
  if (session.role !== 'Admin' && String(row['Supervisor ID']) !== session.supervisorId) return fail('Not your record.', 'FORBIDDEN');
  var url = String(row[payload.kind === 'OUT' ? 'Photo OUT' : 'Photo IN'] || '');
  var m = url.match(/[-\w]{25,}/);
  if (!m) return fail('No photo saved for this record.', 'VALIDATION');
  var blob = DriveApp.getFileById(m[0]).getBlob();
  return respondJSON({ success: true, dataUrl: 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes()), url: url });
}

/* ==========================================================================
   MASTER DATA (ADMIN)
   ========================================================================== */

function findRowIndex(sheetName, headers, keyHeader, keyValue) {
  var rows = readRowsByHeader(sheetName, headers);
  var v = String(keyValue).trim().toLowerCase();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][keyHeader]).trim().toLowerCase() === v) return rows[i];
  }
  return null;
}

function upsert(sheetName, headers, keyHeader, obj) {
  var sheet = getSheet(sheetName);
  var prev = findRowIndex(sheetName, headers, keyHeader, obj[keyHeader]);
  if (prev) {
    writeRow(sheet, prev._row, headers, obj);
  } else {
    writeRow(sheet, Math.max(sheet.getLastRow(), 1) + 1, headers, obj);
  }
  return prev;
}

function handleSaveEmployee(session, payload) {
  var emp = payload.employee || {};
  var empId = String(emp.employeeId || '').trim();
  if (!empId || !String(emp.employeeName || '').trim()) return fail('Employee ID and Full Name are mandatory.', 'VALIDATION');
  var isEdit = payload.isEdit === true;
  var H = HEADERS.EMPLOYEES;
  var prev = findRowIndex(SHEET_NAMES.EMPLOYEES, H, 'Employee ID', empId);
  if (!isEdit && prev) return fail('Employee ID "' + empId + '" already exists. Duplicate IDs are not allowed.', 'DUPLICATE');
  if (isEdit && !prev) return fail('Employee ID "' + empId + '" was not found on the server.', 'VALIDATION');

  emp.employeeId = empId;
  emp.employmentStatus = emp.employmentStatus || 'Active';
  emp.dateEnrolled = emp.dateEnrolled || Utilities.formatDate(new Date(), SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
  upsert(SHEET_NAMES.EMPLOYEES, H, 'Employee ID', fromApp(emp, H));
  logAudits([auditEntry(session, prev ? 'UPDATE_EMPLOYEE' : 'ENROLL_EMPLOYEE', empId,
    prev ? JSON.stringify(toApp(prev, H)) : '', JSON.stringify(emp), prev ? 'Employee updated/reassigned' : 'New employee enrollment')]);
  return respondJSON({ success: true, employee: emp });
}

function handleSaveSupervisor(session, payload) {
  var sup = payload.supervisor || {};
  var supId = String(sup.supervisorId || '').trim();
  var username = String(sup.username || '').trim();
  if (!supId || !String(sup.supervisorName || '').trim() || !username) return fail('Supervisor ID, Name, and Username are required.', 'VALIDATION');

  var prevSup = findRowIndex(SHEET_NAMES.SUPERVISORS, HEADERS.SUPERVISORS, 'Supervisor ID', supId);
  var users = readRowsByHeader(SHEET_NAMES.USERS, HEADERS.USERS);
  var ownUser = null, clash = null;
  users.forEach(function (u) {
    if (String(u['Linked Supervisor ID']) === supId && u['Role'] === 'Supervisor') ownUser = u;
  });
  users.forEach(function (u) {
    if (String(u['Username']).toLowerCase() === username.toLowerCase() && u !== ownUser) clash = u;
  });
  if (clash) return fail('Username "' + username + '" is already used by another account.', 'DUPLICATE');
  if (!ownUser && !/^[a-f0-9]{64}$/.test(String(sup.passwordHash || ''))) return fail('A password is required for a new supervisor.', 'VALIDATION');

  upsert(SHEET_NAMES.SUPERVISORS, HEADERS.SUPERVISORS, 'Supervisor ID', {
    'Supervisor ID': supId, 'Supervisor Name': sup.supervisorName, 'Username': username,
    'Password Hash': '', 'Account Status': sup.accountStatus || 'Active'
  });

  var userObj = ownUser || { 'User ID': 'USR-' + supId, 'Last Login': '' };
  userObj['Username'] = username;
  userObj['Role'] = 'Supervisor';
  userObj['Linked Supervisor ID'] = supId;
  userObj['Account Status'] = sup.accountStatus || 'Active';
  if (sup.passwordHash) setPassword(userObj, sup.passwordHash, true);
  var userSheet = getSheet(SHEET_NAMES.USERS);
  writeRow(userSheet, ownUser ? ownUser._row : Math.max(userSheet.getLastRow(), 1) + 1, HEADERS.USERS, userObj);

  logAudits([auditEntry(session, prevSup ? 'UPDATE_SUPERVISOR' : 'ENROLL_SUPERVISOR', supId, '',
    JSON.stringify({ name: sup.supervisorName, username: username, status: sup.accountStatus }), prevSup ? 'Supervisor updated' : 'New supervisor enrolled')]);
  delete sup.passwordHash;
  return respondJSON({ success: true, supervisor: sup });
}

function handleSaveLandowner(session, payload) {
  var lnd = payload.landowner || {};
  if (!lnd.landownerId || !lnd.landownerName) return fail('Landowner ID and Name are required.', 'VALIDATION');
  var H = HEADERS.LANDOWNERS;
  var prev = upsert(SHEET_NAMES.LANDOWNERS, H, 'Landowner ID', fromApp(lnd, H));
  logAudits([auditEntry(session, prev ? 'UPDATE_LANDOWNER' : 'ENROLL_LANDOWNER', lnd.landownerId,
    prev ? JSON.stringify(toApp(prev, H)) : '', JSON.stringify(lnd), prev ? 'Landowner updated' : 'New landowner enrolled')]);
  return respondJSON({ success: true, landowner: lnd });
}

function handleSaveLocation(session, payload) {
  var loc = payload.location || {};
  if (!loc.locationId || !loc.workLocationName) return fail('Location ID and Name are required.', 'VALIDATION');
  var lat = loc.latitude === '' || loc.latitude === undefined ? '' : Number(loc.latitude);
  var lng = loc.longitude === '' || loc.longitude === undefined ? '' : Number(loc.longitude);
  if ((lat === '') !== (lng === '')) return fail('Enter both latitude and longitude, or leave both empty.', 'VALIDATION');
  if (lat !== '' && (isNaN(lat) || lat < -90 || lat > 90 || isNaN(lng) || lng < -180 || lng > 180)) return fail('Latitude/Longitude are out of range.', 'VALIDATION');
  loc.latitude = lat; loc.longitude = lng;
  loc.radiusMeters = loc.radiusMeters === '' || loc.radiusMeters === undefined ? '' : Number(loc.radiusMeters);

  var H = HEADERS.LOCATIONS;
  var prev = upsert(SHEET_NAMES.LOCATIONS, H, 'Location ID', fromApp(loc, H));
  logAudits([auditEntry(session, prev ? 'UPDATE_LOCATION' : 'ENROLL_LOCATION', loc.locationId,
    prev ? JSON.stringify(toApp(prev, H)) : '', JSON.stringify(loc), prev ? 'Work location updated' : 'New work location enrolled')]);
  return respondJSON({ success: true, location: loc });
}

function handleSaveUser(session, payload) {
  var user = payload.user || {};
  var username = String(user.username || '').trim();
  if (!username) return fail('Username is required.', 'VALIDATION');
  var role = user.role === 'Admin' ? 'Admin' : 'Supervisor';

  var existing = findUserBy('Username', username);
  if (existing && user.userId && String(existing['User ID']) !== String(user.userId)) return fail('Username already taken.', 'DUPLICATE');
  if (!existing && !/^[a-f0-9]{64}$/.test(String(user.newPasswordHash || ''))) return fail('A password is required for a new account.', 'VALIDATION');
  if (existing && String(existing['User ID']) === session.userId && user.accountStatus && user.accountStatus !== 'Active') {
    return fail('You cannot deactivate your own account.', 'VALIDATION');
  }

  var row = existing || { 'User ID': user.userId || ('USR-' + Date.now()), 'Last Login': '' };
  row['Username'] = username;
  row['Role'] = role;
  row['Linked Supervisor ID'] = role === 'Supervisor' ? String(user.linkedSupervisorId || row['Linked Supervisor ID'] || '') : '';
  row['Account Status'] = user.accountStatus || row['Account Status'] || 'Active';
  if (user.newPasswordHash) setPassword(row, user.newPasswordHash, true);

  var sheet = getSheet(SHEET_NAMES.USERS);
  writeRow(sheet, existing ? existing._row : Math.max(sheet.getLastRow(), 1) + 1, HEADERS.USERS, row);
  logAudits([auditEntry(session, existing ? (user.newPasswordHash ? 'RESET_PASSWORD' : 'UPDATE_USER') : 'CREATE_USER', username, '',
    JSON.stringify({ role: role, status: row['Account Status'] }), existing ? 'User account updated' : 'New user created')]);
  return respondJSON({ success: true, user: toApp(row, HEADERS.USERS, { 'Password Hash': true, 'Salt': true }) });
}

function handleSoftDeleteAttendance(session, payload) {
  var recordId = String(payload.recordId || '');
  if (!recordId) return fail('Record ID required.', 'VALIDATION');
  var row = findRowIndex(SHEET_NAMES.ATTENDANCE, HEADERS.ATTENDANCE, 'Attendance Record ID', recordId);
  if (!row) return fail('Attendance record not found.', 'VALIDATION');
  if (session.role !== 'Admin' && String(row['Supervisor ID']) !== session.supervisorId) return fail('Not your record.', 'FORBIDDEN');
  var col = headerIndex(HEADERS.ATTENDANCE)['Record Status'] + 1;
  getSheet(SHEET_NAMES.ATTENDANCE).getRange(row._row, col).setValue('DELETED');
  logAudits([auditEntry(session, 'SOFT_DELETE_ATTENDANCE', recordId, 'ACTIVE', 'DELETED', payload.reason || 'Soft deleted by user')]);
  return respondJSON({ success: true, recordId: recordId });
}

/* ==========================================================================
   PROFILE PHOTOS (user avatars & employee registration photos)
   Stored as small JPEG data URLs in the "Profile Photos" sheet so phones can cache them offline.
   ========================================================================== */

function canTouchPhoto(session, type, ownerId) {
  if (session.role === 'Admin') return true;
  if (type === 'USER') return String(ownerId) === session.userId;
  if (type === 'EMPLOYEE') {
    var emp = findRowIndex(SHEET_NAMES.EMPLOYEES, HEADERS.EMPLOYEES, 'Employee ID', ownerId);
    return !!emp && String(emp['Supervisor ID']) === session.supervisorId;
  }
  return false;
}

function handleSaveProfilePhoto(session, payload) {
  var type = payload.type === 'EMPLOYEE' ? 'EMPLOYEE' : (payload.type === 'USER' ? 'USER' : '');
  var ownerId = String(payload.ownerId || '').trim();
  var image = String(payload.image || '');
  if (!type || !ownerId) return fail('Photo type and owner are required.', 'VALIDATION');
  if (image && (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/.test(image) || image.length > MAX_PROFILE_IMAGE_CHARS)) {
    return fail('Photo is not a valid small image.', 'VALIDATION');
  }
  if (type === 'USER' && !findUserBy('User ID', ownerId)) return fail('User not found.', 'VALIDATION');
  if (type === 'EMPLOYEE' && !findRowIndex(SHEET_NAMES.EMPLOYEES, HEADERS.EMPLOYEES, 'Employee ID', ownerId)) return fail('Employee not found.', 'VALIDATION');
  if (!canTouchPhoto(session, type, ownerId)) return fail('You cannot change this photo.', 'FORBIDDEN');

  var key = type + ':' + ownerId;
  var nowIso = new Date().toISOString();
  upsert(SHEET_NAMES.PROFILE_PHOTOS, HEADERS.PROFILE_PHOTOS, 'Photo Key', {
    'Photo Key': key, 'Type': type, 'Owner ID': ownerId, 'Image': image, 'Updated At': nowIso, 'Updated By': session.username
  });
  logAudits([auditEntry(session, image ? 'SET_PROFILE_PHOTO' : 'REMOVE_PROFILE_PHOTO', key, '', '', type === 'USER' ? 'User avatar' : 'Employee photo')]);
  return respondJSON({ success: true, key: key, updatedAt: nowIso });
}

/** Returns photos changed after `since` (ISO). Supervisors get their own avatar + their employees. */
function handleGetProfilePhotos(session, payload) {
  var since = String(payload.since || '');
  var readStartedAt = new Date().toISOString(); // next "since": anything saved after this moment is sent next time
  var rows = readRowsByHeader(SHEET_NAMES.PROFILE_PHOTOS, HEADERS.PROFILE_PHOTOS);
  var allowedEmp = null;
  if (session.role !== 'Admin') {
    allowedEmp = {};
    readRowsByHeader(SHEET_NAMES.EMPLOYEES, HEADERS.EMPLOYEES).forEach(function (e) {
      if (String(e['Supervisor ID']) === session.supervisorId) allowedEmp[String(e['Employee ID'])] = true;
    });
  }
  var photos = rows.filter(function (r) {
    if (since && String(r['Updated At']) < since) return false; // same-millisecond changes are re-sent (harmless)
    if (!allowedEmp) return true;
    if (r['Type'] === 'USER') return String(r['Owner ID']) === session.userId;
    return !!allowedEmp[String(r['Owner ID'])];
  }).map(function (r) {
    return { key: r['Photo Key'], type: r['Type'], ownerId: String(r['Owner ID']), image: r['Image'] || '', updatedAt: r['Updated At'] };
  });
  return respondJSON({ success: true, photos: photos, serverTime: readStartedAt });
}

/* ==========================================================================
   AUDIT LOGS
   ========================================================================== */

function auditEntry(session, action, recordId, prevVal, newVal, reason) {
  return {
    'Log ID': 'LOG-' + Date.now() + '-' + Math.floor(Math.random() * 100000),
    'User ID': session ? session.userId : 'SYSTEM',
    'User Role': session ? session.role : 'SYSTEM',
    'Action': action,
    'Record ID': recordId || '',
    'Previous Value': String(prevVal || '').substring(0, 45000),
    'New Value': String(newVal || '').substring(0, 45000),
    'Reason': reason || '',
    'Date and Time': new Date().toISOString()
  };
}

function logAudits(entries) {
  if (!entries || !entries.length) return;
  try {
    var sheet = getSheet(SHEET_NAMES.AUDIT_LOGS);
    writeRows(sheet, Math.max(sheet.getLastRow(), 1) + 1, HEADERS.AUDIT_LOGS, entries);
  } catch (e) {
    console.error('Audit Log failed:', e);
  }
}

function handleGetAuditLogs(session, payload) {
  var sheet = getSheet(SHEET_NAMES.AUDIT_LOGS);
  var last = sheet.getLastRow();
  if (last <= 1) return respondJSON({ success: true, logs: [] });
  var limit = Math.min(Number(payload.limit) || 500, 2000);
  var start = Math.max(2, last - limit + 1);
  var data = sheet.getRange(start, 1, last - start + 1, HEADERS.AUDIT_LOGS.length).getValues();
  var logs = data.map(function (row) {
    return {
      logId: row[0], userId: row[1], userRole: row[2], action: row[3], recordId: row[4],
      previousValue: row[5], newValue: row[6], reason: row[7],
      dateTime: row[8] instanceof Date ? row[8].toISOString() : row[8]
    };
  }).reverse();
  return respondJSON({ success: true, logs: logs });
}
