/**
 * EMPLOYEE ATTENDANCE MONITORING SYSTEM - BACKEND (GOOGLE APPS SCRIPT)
 * 
 * Google Sheets Database Structure:
 * 1. Employees
 * 2. Supervisors
 * 3. Landowners
 * 4. Work Locations
 * 5. Attendance
 * 6. Audit Logs
 * 7. Users
 */

const SHEET_NAMES = {
  EMPLOYEES: 'Employees',
  SUPERVISORS: 'Supervisors',
  LANDOWNERS: 'Landowners',
  LOCATIONS: 'Work Locations',
  ATTENDANCE: 'Attendance',
  AUDIT_LOGS: 'Audit Logs',
  USERS: 'Users'
};

const HEADERS = {
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
    'Location ID', 'Work Location Name', 'Description', 'Landowner ID', 'Landowner Name', 'Supervisor ID', 'Status'
  ],
  ATTENDANCE: [
    'Attendance Record ID', 'Employee ID', 'Employee Name', 'Supervisor ID', 'Supervisor Name',
    'Landowner ID', 'Landowner Name', 'Location ID', 'Work Location', 'Attendance Date',
    'Time IN', 'Time OUT', 'Original Time IN', 'Original Time OUT', 'Adjusted By',
    'Adjustment Reason', 'Actual GPS IN', 'Actual GPS OUT', 'Device Timestamp',
    'Synchronization Date', 'Synchronization Status', 'Record Status',
    'Attendance Type', 'Leave Type', 'Leave Remarks'
  ],
  AUDIT_LOGS: [
    'Log ID', 'User ID', 'User Role', 'Action', 'Record ID',
    'Previous Value', 'New Value', 'Reason', 'Date and Time'
  ],
  USERS: [
    'User ID', 'Username', 'Password Hash', 'Role', 'Linked Supervisor ID', 'Account Status', 'Last Login'
  ]
};

/**
 * Handle HTTP GET Requests (Health check and direct browser access)
 */
function doGet(e) {
  setupDatabase();
  return ContentService.createTextOutput(JSON.stringify({
    success: true,
    message: 'Attendance System Google Apps Script API is active and operational.',
    timestamp: new Date().toISOString()
  })).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Handle HTTP POST Requests from Web App
 */
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000); // 30-second concurrency lock
  } catch (lockError) {
    return respondJSON({ success: false, error: 'Server busy, please retry in a moment.' });
  }

  try {
    setupDatabase(); // Ensure all sheets & headers exist

    if (!e || !e.postData || !e.postData.contents) {
      return respondJSON({ success: false, error: 'Missing request body.' });
    }

    var payload = JSON.parse(e.postData.contents);
    var action = payload.action;

    switch (action) {
      case 'SETUP_DB':
        return respondJSON({ success: true, message: 'Database verified & initialized.' });

      case 'LOGIN':
        return handleLogin(payload);

      case 'GET_INITIAL_DATA':
        return handleGetInitialData(payload);

      case 'SYNC_ATTENDANCE_BATCH':
        return handleSyncAttendanceBatch(payload);

      case 'SAVE_EMPLOYEE':
        return handleSaveEmployee(payload);

      case 'SAVE_SUPERVISOR':
        return handleSaveSupervisor(payload);

      case 'SAVE_LANDOWNER':
        return handleSaveLandowner(payload);

      case 'SAVE_LOCATION':
        return handleSaveLocation(payload);

      case 'SAVE_USER':
        return handleSaveUser(payload);

      case 'SOFT_DELETE_ATTENDANCE':
        return handleSoftDeleteAttendance(payload);

      case 'GET_AUDIT_LOGS':
        return handleGetAuditLogs();

      default:
        return respondJSON({ success: false, error: 'Unknown action: ' + action });
    }
  } catch (err) {
    return respondJSON({ success: false, error: err.toString() });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Helper to respond with JSON & CORS
 */
function respondJSON(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Setup Database: Creates missing sheets and sets headers with styling
 */
function setupDatabase() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  for (var key in SHEET_NAMES) {
    var sheetName = SHEET_NAMES[key];
    var sheet = ss.getSheetByName(sheetName);
    var headers = HEADERS[key];

    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
    }

    if (sheet.getLastRow() === 0) {
      sheet.appendRow(headers);
      var headerRange = sheet.getRange(1, 1, 1, headers.length);
      headerRange.setBackground('#15803d'); // Deep Emerald Green
      headerRange.setFontColor('#ffffff');
      headerRange.setFontWeight('bold');
      sheet.setFrozenRows(1);

      // Auto-resize columns
      for (var col = 1; col <= headers.length; col++) {
        sheet.setColumnWidth(col, 160);
      }
    }
  }

  // MIGRATION: add any new Attendance columns (Attendance Type, Leave Type, Leave Remarks)
  // to an existing sheet without touching the existing data.
  var attSheet = ss.getSheetByName(SHEET_NAMES.ATTENDANCE);
  var neededHeaders = HEADERS.ATTENDANCE;
  var currentHeaders = attSheet.getRange(1, 1, 1, Math.max(attSheet.getLastColumn(), neededHeaders.length)).getValues()[0];
  for (var h = 0; h < neededHeaders.length; h++) {
    if (!currentHeaders[h]) {
      var hc = attSheet.getRange(1, h + 1);
      hc.setValue(neededHeaders[h]);
      hc.setBackground('#15803d');
      hc.setFontColor('#ffffff');
      hc.setFontWeight('bold');
      attSheet.setColumnWidth(h + 1, 160);
    }
  }

  // Ensure default Admin user exists in Users sheet
  var userSheet = ss.getSheetByName(SHEET_NAMES.USERS);
  if (userSheet.getLastRow() <= 1) {
    // SHA-256 for 'admin123' = '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9'
    var defaultAdminHash = '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9';
    userSheet.appendRow([
      'USR-ADMIN-1',
      'admin',
      defaultAdminHash,
      'Admin',
      '',
      'Active',
      new Date().toISOString()
    ]);
  }
}

/**
 * Login Handler
 */
function handleLogin(payload) {
  var username = (payload.username || '').trim().toLowerCase();
  var passwordHash = (payload.passwordHash || '').trim();

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var userSheet = ss.getSheetByName(SHEET_NAMES.USERS);
  var data = userSheet.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var rowUsername = (row[1] || '').toString().trim().toLowerCase();
    var rowHash = (row[2] || '').toString().trim();
    var role = row[3];
    var supervisorId = row[4];
    var status = row[5];

    if (rowUsername === username) {
      if (rowHash !== passwordHash) {
        return respondJSON({ success: false, error: 'Incorrect password.' });
      }
      if (status !== 'Active') {
        return respondJSON({ success: false, error: 'Account is deactivated. Contact administrator.' });
      }

      // Update Last Login
      userSheet.getRange(i + 1, 7).setValue(new Date().toISOString());

      // Find supervisor name if applicable
      var supervisorName = '';
      if (supervisorId) {
        var supSheet = ss.getSheetByName(SHEET_NAMES.SUPERVISORS);
        var supData = supSheet.getDataRange().getValues();
        for (var s = 1; s < supData.length; s++) {
          if (supData[s][0].toString() === supervisorId.toString()) {
            supervisorName = supData[s][1];
            break;
          }
        }
      }

      return respondJSON({
        success: true,
        user: {
          userId: row[0],
          username: row[1],
          role: role,
          linkedSupervisorId: supervisorId,
          name: supervisorName || row[1],
          accountStatus: status
        }
      });
    }
  }

  return respondJSON({ success: false, error: 'User account not found.' });
}

/**
 * Get Initial Data with Strict Role Scoping
 */
function handleGetInitialData(payload) {
  var role = payload.role || 'Admin';
  var supervisorId = (payload.supervisorId || '').toString().trim();

  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // Helper to read all rows as objects
  function getSheetObjects(sheetName) {
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet || sheet.getLastRow() <= 1) return [];
    var range = sheet.getDataRange();
    var data = range.getValues();
    var display = range.getDisplayValues();
    var headers = data[0];
    var rows = [];
    for (var r = 1; r < data.length; r++) {
      var row = data[r];
      var obj = {};
      for (var c = 0; c < headers.length; c++) {
        var key = toCamelCase(headers[c]);
        obj[key] = normalizeCell(key, row[c], display[r][c]);
      }
      rows.push(obj);
    }
    return rows;
  }

  var allEmployees = getSheetObjects(SHEET_NAMES.EMPLOYEES);
  var allSupervisors = getSheetObjects(SHEET_NAMES.SUPERVISORS);
  var allLandowners = getSheetObjects(SHEET_NAMES.LANDOWNERS);
  var allLocations = getSheetObjects(SHEET_NAMES.LOCATIONS);
  var allAttendance = getSheetObjects(SHEET_NAMES.ATTENDANCE);
  var allUsers = role === 'Admin' ? getSheetObjects(SHEET_NAMES.USERS) : [];

  var filteredEmployees = allEmployees;
  var filteredLandowners = allLandowners;
  var filteredLocations = allLocations;
  var filteredAttendance = allAttendance;

  // STRICT SUPERVISOR SCOPING:
  // If user is a Supervisor, ONLY return their assigned employees, locations, landowners, and attendance!
  if (role === 'Supervisor' && supervisorId) {
    filteredEmployees = allEmployees.filter(function(e) {
      return (e.supervisorId || '').toString() === supervisorId;
    });

    filteredLandowners = allLandowners.filter(function(l) {
      return !l.supervisorId || (l.supervisorId || '').toString() === supervisorId;
    });
    if (filteredLandowners.length === 0) {
      filteredLandowners = allLandowners.filter(function(l) {
        return l.status === 'Active';
      });
    }

    filteredLocations = allLocations.filter(function(loc) {
      return (loc.supervisorId || '').toString() === supervisorId;
    });

    filteredAttendance = allAttendance.filter(function(a) {
      return (a.supervisorId || '').toString() === supervisorId;
    });
  }

  return respondJSON({
    success: true,
    data: {
      employees: filteredEmployees,
      supervisors: allSupervisors,
      landowners: filteredLandowners,
      locations: filteredLocations,
      attendance: filteredAttendance,
      users: allUsers
    }
  });
}

/**
 * Google Sheets silently converts text such as "2026-10-26", "07:01 AM" or "0001"
 * into Date / number values. Convert them back so the app always receives
 * plain strings (yyyy-MM-dd dates, "hh:mm AM" times, text IDs).
 */
function normalizeCell(key, v, displayValue) {
  if (v instanceof Date) {
    var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
    if (key === 'attendanceDate' || key === 'dateEnrolled') {
      return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
    }
    if (/^(time|originalTime)/.test(key)) {
      return (displayValue || '').replace(/(\d{1,2}:\d{2}):\d{2}(\s*[AaPp][Mm])/, '$1$2').replace(/^(\d):/, '0$1:');
    }
    return v.toISOString();
  }
  if (typeof v === 'number' && /Id$/.test(key)) {
    return String(v);
  }
  return v;
}

/**
 * Synchronize Attendance Batch: Upsert logic to prevent duplicate records
 */
function handleSyncAttendanceBatch(payload) {
  var records = payload.records || [];
  var userId = payload.userId || 'SYSTEM';
  var userRole = payload.userRole || 'Supervisor';

  if (!records || records.length === 0) {
    return respondJSON({ success: true, syncedIds: [], message: 'No records to sync.' });
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAMES.ATTENDANCE);
  var data = sheet.getDataRange().getValues();

  // Map existing Attendance Record IDs to their row indices (1-indexed for Sheet)
  var recordMap = {};
  for (var i = 1; i < data.length; i++) {
    var recId = data[i][0].toString();
    recordMap[recId] = i + 1;
  }

  var syncedIds = [];
  var now = new Date().toISOString();
  var nextRow = sheet.getLastRow() + 1;

  records.forEach(function(rec) {
    var recId = rec.attendanceRecordId;
    var rowValues = [
      rec.attendanceRecordId,
      rec.employeeId,
      rec.employeeName,
      rec.supervisorId,
      rec.supervisorName,
      rec.landownerId || '',
      rec.landownerName || '',
      rec.locationId || '',
      rec.workLocation || '',
      rec.attendanceDate,
      rec.timeIn || '',
      rec.timeOut || '',
      rec.originalTimeIn || '',
      rec.originalTimeOut || '',
      rec.adjustedBy || '',
      rec.adjustmentReason || '',
      rec.actualGpsIn || '',
      rec.actualGpsOut || '',
      rec.deviceTimestamp || now,
      now, // Synchronization Date
      'SYNCED',
      rec.recordStatus || 'ACTIVE',
      rec.attendanceType || 'PRESENT',
      rec.leaveType || '',
      rec.leaveRemarks || ''
    ];

    var isLeave = (rec.attendanceType || '').toUpperCase() === 'LEAVE';

    if (recordMap[recId]) {
      // Record already exists: Update existing row (Preserves ID & avoids duplicates)
      var rowIndex = recordMap[recId];
      var rowRange = sheet.getRange(rowIndex, 1, 1, rowValues.length);
      rowRange.setNumberFormat('@'); // plain text: keeps dates, times and IDs like 0001 exactly as sent
      rowRange.setValues([rowValues]);

      if (isLeave && rec.recordStatus === 'DELETED') {
        logAudit(userId, userRole, 'CANCEL_LEAVE', recId, (rec.leaveType || 'Leave') + ' ' + rec.attendanceDate, 'DELETED', rec.employeeName);
      } else if (rec.adjustmentReason) {
        logAudit(userId, userRole, 'UPDATE_ATTENDANCE', recId, 'Previous Record', JSON.stringify(rec), rec.adjustmentReason);
      }
    } else {
      // New record: write into the next empty row as plain text
      var newRange = sheet.getRange(nextRow, 1, 1, rowValues.length);
      newRange.setNumberFormat('@');
      newRange.setValues([rowValues]);
      recordMap[recId] = nextRow;
      nextRow++;

      if (isLeave) {
        logAudit(userId, userRole, 'RECORD_LEAVE', recId, '', (rec.leaveType || 'Leave') + ' - ' + rec.employeeName + ' - ' + rec.attendanceDate, rec.leaveRemarks || '');
      }
    }

    syncedIds.push(recId);
  });

  return respondJSON({
    success: true,
    syncedIds: syncedIds,
    count: syncedIds.length
  });
}

/**
 * Save / Update Employee (Manual Employee ID strictly required and unique)
 */
function handleSaveEmployee(payload) {
  var emp = payload.employee;
  var userId = payload.userId || 'ADMIN';
  var userRole = payload.userRole || 'Admin';

  if (!emp || !emp.employeeId || !emp.employeeName) {
    return respondJSON({ success: false, error: 'Employee ID and Full Name are mandatory.' });
  }

  var empId = emp.employeeId.toString().trim();
  var isEdit = payload.isEdit === true;

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAMES.EMPLOYEES);
  var data = sheet.getDataRange().getValues();

  var foundRow = -1;
  for (var i = 1; i < data.length; i++) {
    if (data[i][0].toString().trim().toLowerCase() === empId.toLowerCase()) {
      foundRow = i + 1;
      break;
    }
  }

  // Prevent duplicate Employee ID if adding new
  if (!isEdit && foundRow !== -1) {
    return respondJSON({ success: false, error: 'Employee ID "' + empId + '" already exists. Duplicate IDs are not allowed.' });
  }

  var rowValues = [
    empId,
    emp.employeeName,
    emp.position || '',
    emp.department || '',
    emp.supervisorId || '',
    emp.supervisorName || '',
    emp.landownerId || '',
    emp.landownerName || '',
    emp.locationId || '',
    emp.workLocation || '',
    emp.employmentStatus || 'Active',
    emp.dateEnrolled || new Date().toISOString().split('T')[0]
  ];

  if (isEdit && foundRow !== -1) {
    var prev = JSON.stringify(data[foundRow - 1]);
    sheet.getRange(foundRow, 1, 1, rowValues.length).setValues([rowValues]);
    logAudit(userId, userRole, 'UPDATE_EMPLOYEE', empId, prev, JSON.stringify(emp), 'Employee updated/reassigned');
  } else {
    sheet.appendRow(rowValues);
    // Explicitly set text format to preserve leading zeros
    sheet.getRange(sheet.getLastRow(), 1).setNumberFormat('@');
    logAudit(userId, userRole, 'ENROLL_EMPLOYEE', empId, '', JSON.stringify(emp), 'New employee enrollment');
  }

  return respondJSON({ success: true, employee: emp });
}

/**
 * Save Supervisor
 */
function handleSaveSupervisor(payload) {
  var sup = payload.supervisor;
  var userId = payload.userId || 'ADMIN';
  var userRole = payload.userRole || 'Admin';

  if (!sup || !sup.supervisorId || !sup.supervisorName || !sup.username) {
    return respondJSON({ success: false, error: 'Supervisor ID, Name, and Username are required.' });
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAMES.SUPERVISORS);
  var data = sheet.getDataRange().getValues();

  var foundRow = -1;
  for (var i = 1; i < data.length; i++) {
    if (data[i][0].toString() === sup.supervisorId.toString()) {
      foundRow = i + 1;
      break;
    }
  }

  var rowValues = [
    sup.supervisorId,
    sup.supervisorName,
    sup.username,
    sup.passwordHash || '',
    sup.accountStatus || 'Active'
  ];

  if (foundRow !== -1) {
    sheet.getRange(foundRow, 1, 1, rowValues.length).setValues([rowValues]);
    logAudit(userId, userRole, 'UPDATE_SUPERVISOR', sup.supervisorId, '', JSON.stringify(sup), 'Supervisor updated');
  } else {
    sheet.appendRow(rowValues);
    logAudit(userId, userRole, 'ENROLL_SUPERVISOR', sup.supervisorId, '', JSON.stringify(sup), 'New supervisor enrolled');
  }

  // Also sync account to Users sheet
  syncSupervisorUserAccount(sup);

  return respondJSON({ success: true, supervisor: sup });
}

/**
 * Sync Supervisor to Users sheet
 */
function syncSupervisorUserAccount(sup) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var userSheet = ss.getSheetByName(SHEET_NAMES.USERS);
  var data = userSheet.getDataRange().getValues();

  var foundRow = -1;
  for (var i = 1; i < data.length; i++) {
    if (data[i][4].toString() === sup.supervisorId.toString() ||
        data[i][1].toString().toLowerCase() === sup.username.toLowerCase()) {
      foundRow = i + 1;
      break;
    }
  }

  var userRowValues = [
    'USR-' + sup.supervisorId,
    sup.username,
    sup.passwordHash || '',
    'Supervisor',
    sup.supervisorId,
    sup.accountStatus || 'Active',
    new Date().toISOString()
  ];

  if (foundRow !== -1) {
    // Preserve existing password if new one not supplied
    if (!sup.passwordHash) {
      userRowValues[2] = data[foundRow - 1][2];
    }
    userSheet.getRange(foundRow, 1, 1, userRowValues.length).setValues([userRowValues]);
  } else {
    userSheet.appendRow(userRowValues);
  }
}

/**
 * Save Landowner
 */
function handleSaveLandowner(payload) {
  var lnd = payload.landowner;
  var userId = payload.userId || 'ADMIN';
  var userRole = payload.userRole || 'Admin';

  if (!lnd || !lnd.landownerId || !lnd.landownerName) {
    return respondJSON({ success: false, error: 'Landowner ID and Name are required.' });
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAMES.LANDOWNERS);
  var data = sheet.getDataRange().getValues();

  var foundRow = -1;
  for (var i = 1; i < data.length; i++) {
    if (data[i][0].toString() === lnd.landownerId.toString()) {
      foundRow = i + 1;
      break;
    }
  }

  var rowValues = [
    lnd.landownerId,
    lnd.landownerName,
    lnd.locationId || '',
    lnd.workLocation || '',
    lnd.supervisorId || '',
    lnd.status || 'Active'
  ];

  if (foundRow !== -1) {
    sheet.getRange(foundRow, 1, 1, rowValues.length).setValues([rowValues]);
    logAudit(userId, userRole, 'UPDATE_LANDOWNER', lnd.landownerId, '', JSON.stringify(lnd), 'Landowner updated');
  } else {
    sheet.appendRow(rowValues);
    logAudit(userId, userRole, 'ENROLL_LANDOWNER', lnd.landownerId, '', JSON.stringify(lnd), 'New landowner enrolled');
  }

  return respondJSON({ success: true, landowner: lnd });
}

/**
 * Save Location
 */
function handleSaveLocation(payload) {
  var loc = payload.location;
  var userId = payload.userId || 'ADMIN';
  var userRole = payload.userRole || 'Admin';

  if (!loc || !loc.locationId || !loc.workLocationName) {
    return respondJSON({ success: false, error: 'Location ID and Name are required.' });
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAMES.LOCATIONS);
  var data = sheet.getDataRange().getValues();

  var foundRow = -1;
  for (var i = 1; i < data.length; i++) {
    if (data[i][0].toString() === loc.locationId.toString()) {
      foundRow = i + 1;
      break;
    }
  }

  var rowValues = [
    loc.locationId,
    loc.workLocationName,
    loc.description || '',
    loc.landownerId || '',
    loc.landownerName || '',
    loc.supervisorId || '',
    loc.status || 'Active'
  ];

  if (foundRow !== -1) {
    sheet.getRange(foundRow, 1, 1, rowValues.length).setValues([rowValues]);
    logAudit(userId, userRole, 'UPDATE_LOCATION', loc.locationId, '', JSON.stringify(loc), 'Work location updated');
  } else {
    sheet.appendRow(rowValues);
    logAudit(userId, userRole, 'ENROLL_LOCATION', loc.locationId, '', JSON.stringify(loc), 'New work location enrolled');
  }

  return respondJSON({ success: true, location: loc });
}

/**
 * Save User / Reset Password
 */
function handleSaveUser(payload) {
  var user = payload.user;
  var userId = payload.userId || 'ADMIN';
  var userRole = payload.userRole || 'Admin';

  if (!user || !user.username) {
    return respondJSON({ success: false, error: 'Username is required.' });
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAMES.USERS);
  var data = sheet.getDataRange().getValues();

  var foundRow = -1;
  for (var i = 1; i < data.length; i++) {
    if (data[i][1].toString().toLowerCase() === user.username.toLowerCase()) {
      foundRow = i + 1;
      break;
    }
  }

  var rowValues = [
    user.userId || ('USR-' + Date.now()),
    user.username,
    user.passwordHash || '',
    user.role || 'Supervisor',
    user.linkedSupervisorId || '',
    user.accountStatus || 'Active',
    new Date().toISOString()
  ];

  if (foundRow !== -1) {
    if (!user.passwordHash) {
      rowValues[2] = data[foundRow - 1][2]; // Keep existing hash
    }
    sheet.getRange(foundRow, 1, 1, rowValues.length).setValues([rowValues]);
    logAudit(userId, userRole, 'UPDATE_USER', user.username, '', '', 'User account updated');
  } else {
    sheet.appendRow(rowValues);
    logAudit(userId, userRole, 'CREATE_USER', user.username, '', '', 'New user created');
  }

  return respondJSON({ success: true, user: user });
}

/**
 * Soft Delete Attendance (Never permanently erased; preserves audit history)
 */
function handleSoftDeleteAttendance(payload) {
  var recordId = payload.recordId;
  var userId = payload.userId || 'ADMIN';
  var userRole = payload.userRole || 'Admin';
  var reason = payload.reason || 'Soft deleted by user';

  if (!recordId) {
    return respondJSON({ success: false, error: 'Record ID required.' });
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAMES.ATTENDANCE);
  var data = sheet.getDataRange().getValues();

  var foundRow = -1;
  for (var i = 1; i < data.length; i++) {
    if (data[i][0].toString() === recordId.toString()) {
      foundRow = i + 1;
      break;
    }
  }

  if (foundRow === -1) {
    return respondJSON({ success: false, error: 'Attendance record not found.' });
  }

  // Update Record Status (Column 22 = V) to 'DELETED'
  sheet.getRange(foundRow, 22).setValue('DELETED');

  logAudit(userId, userRole, 'SOFT_DELETE_ATTENDANCE', recordId, 'ACTIVE', 'DELETED', reason);

  return respondJSON({ success: true, recordId: recordId, message: 'Record soft-deleted successfully.' });
}

/**
 * Audit Logging Helper
 */
function logAudit(userId, userRole, action, recordId, prevVal, newVal, reason) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_NAMES.AUDIT_LOGS);
    if (!sheet) return;

    var logId = 'LOG-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    sheet.appendRow([
      logId,
      userId,
      userRole,
      action,
      recordId,
      prevVal || '',
      newVal || '',
      reason || '',
      new Date().toISOString()
    ]);
  } catch (e) {
    console.error('Audit Log failed:', e);
  }
}

/**
 * Get Audit Logs
 */
function handleGetAuditLogs() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAMES.AUDIT_LOGS);
  if (!sheet || sheet.getLastRow() <= 1) {
    return respondJSON({ success: true, logs: [] });
  }

  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var logs = [];

  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    logs.push({
      logId: row[0],
      userId: row[1],
      userRole: row[2],
      action: row[3],
      recordId: row[4],
      previousValue: row[5],
      newValue: row[6],
      reason: row[7],
      dateTime: row[8]
    });
  }

  // Sort newest first
  logs.reverse();

  return respondJSON({ success: true, logs: logs });
}

/**
 * Utility: String to camelCase
 */
function toCamelCase(str) {
  return str.toLowerCase().replace(/[^a-zA-Z0-9]+(.)/g, function(match, chr) {
    return chr.toUpperCase();
  });
}
