# Employee Attendance Monitoring System
### Mobile-First, Offline-Ready PWA with Google Sheets Database & Google Apps Script API

A complete, responsive, mobile-friendly **Employee Attendance Monitoring System** built with HTML5, CSS3, JavaScript, and Google Apps Script, with Google Sheets serving as the central cloud database.

---

## 🌟 Key Features

1. **Role-Based Access Control**:
   - **Admin**: Full organization control, employee enrollment, supervisor assignments, landowner & location management, global attendance monitoring, user management, and audit logs.
   - **Supervisor**: Restricted access. Supervisors can **only view and manage employees assigned to them**, their designated landowners, and work locations.
   - **Employee**: Field personnel monitored by the system.

2. **Admin Dashboard (summary only)**:
   - Admins do not record attendance. The dashboard shows a summary for any date: Total, Present, On Leave, Absent, Pending Upload.
   - Pie (donut) chart of Present / On Leave / Absent, a per-supervisor table (Team, Present, Leave, Absent, Rate), a 7-day trend, and an "Absent - Needs Follow-up" list grouped by supervisor.
   - Filters by Supervisor and Work Location, previous/next day, **Export CSV** day report.
   - *Absent* is calculated automatically: an active employee with no Time IN and no leave for that date.

3. **Landowners follow the Work Location**:
   - Admin registers a Landowner under a Work Location (Landowners page). The supervisor is taken automatically from that location (Work Locations page).
   - A supervisor only sees landowners registered under the location(s) assigned to him/her. Example: Farm 4 Block 1 is assigned to Francis, so Francis only sees the landowners of Farm 4 Block 1.
   - This applies to the Area Checking popup, the Adjust form, the History filter and the data downloaded to the phone (`Code.gs`). Supervisors cannot type a custom landowner, and the login screen no longer lists landowners.
   - If a location has no supervisor, or a landowner has no location, nobody sees that landowner until the admin fixes it.

4. **On Leave** (Supervisor):
   - On **Record Attendance**, tap **Mark On Leave** on an employee: choose Leave Type (Sick, Vacation, Emergency, Personal, Other), From date, optional To date (one record is created per day, up to 31 days) and remarks.
   - An employee on leave cannot Time IN that day until the leave is cancelled (**Cancel Leave** keeps an audit trail).
   - Leave syncs offline/online like any other record and appears in History (filter by type), the dashboards and CSV exports.

5. **100% Offline Capability**:
   - Built with **IndexedDB** for storing thousands of offline attendance records safely on the device.
   - **Service Worker (`sw.js`)** pre-caches application assets for instant offline load.
   - **Offline Authentication**: Supervisors and Admins who have logged in once can log in offline using cryptographically hashed credentials (SHA-256 via Web Crypto API).
   - Generates a local unique **Attendance Record ID** for every punch.

6. **Smart Synchronization & Duplicate Prevention**:
   - **Automatic Sync**: Detects internet restoration (`online` event & Service Worker message) and syncs pending records automatically.
   - **Manual Sync**: Sync All Pending, Retry Failed, or Sync Selected records.
   - **Idempotent Upsert**: Backend validates `Attendance Record ID` before inserting. If a record already exists, it updates the record (e.g. adding Time OUT or manual adjustment) instead of creating duplicate rows.
   - **History Retention**: Local records are **never deleted** after synchronization; their status simply changes to `SYNCED`.

7. **Accurate Attendance Recording (Time IN & Time OUT)**:
   - High-accuracy GPS coordinate capture (Latitude, Longitude, Accuracy in meters) via `navigator.geolocation`.
   - **Separation of Locations**: Assigned Work Location and Actual GPS Location are tracked separately to verify field presence.
   - Device timestamping and supervisor signature.
   - **Manual Adjustments with Audit Trail**: Editable date and time with mandatory reason, recording both original and adjusted timestamps.

8. **Data Protection & Soft Deletion**:
   - Records are never permanently deleted by accident. Authorized deletions mark `recordStatus = 'DELETED'` and log the action, timestamp, and user reason into the **Audit Logs**.
   - One-click **Export to CSV / Excel** with UTF-8 BOM encoding.

---

## 📁 Project File Structure

```text
Attendance System/
│
├── index.html            # Main Single-Page Application (SPA) UI
├── manifest.json         # PWA Manifest for installability on mobile/desktop
├── sw.js                 # Service Worker for offline asset caching & sync
├── Code.gs               # Google Apps Script Web App Backend & Sheets API
├── README.md             # Setup, Deployment, and Testing Guide
│
├── css/
│   └── styles.css        # Responsive Green & White theme, Mobile Bottom Nav, Desktop Sidebar
│
├── js/
│   ├── db.js             # IndexedDB wrapper (attendance, employees, supervisors, users, etc.)
│   ├── auth.js           # Web Crypto SHA-256 hashing, offline session management
│   ├── sync.js           # Background & manual sync engine, connectivity monitoring
│   └── app.js            # UI routing, GPS capture, Attendance recording, CSV Export
│
└── icons/
    ├── logo-full.png         # CocoTrack logo with text (login screen)
    ├── logo-emblem.png       # Round emblem (sidebar)
    ├── favicon-64.png        # Browser tab icon
    ├── apple-touch-icon.png  # iPhone home-screen icon
    ├── app-icon-192/512.png, app-icon-maskable-192/512.png   # Android / PWA home-screen icons (emblem + COCOTRACK)
    └── apple-touch-icon-v2.png  # iPhone home-screen icon
```

---

## 📊 Google Sheets Central Database Structure

When Google Apps Script runs, it automatically creates and formats the following 7 sheets if they do not exist:

1. **`Employees`**:
   `[Employee ID, Employee Name, Position, Department, Supervisor ID, Supervisor Name, Landowner ID, Landowner Name, Location ID, Work Location, Employment Status, Date Enrolled]`
   *Note: Employee ID is manually entered by Admin and strictly preserved with leading zeros as plain text (`@`). Daily workers are enrolled under a Supervisor and Work Location. The Landowner is not statically assigned to the worker; instead, the Supervisor selects the Landowner during login or when conducting area checking, dynamically stamping attendance punches with the checked landowner.*
2. **`Supervisors`**:
   `[Supervisor ID, Supervisor Name, Username, Password Hash, Account Status]`
3. **`Landowners`**:
   `[Landowner ID, Landowner Name, Location ID, Work Location, Supervisor ID, Status]`
4. **`Work Locations`**:
   `[Location ID, Work Location Name, Description, Landowner ID, Landowner Name, Supervisor ID, Status]`
5. **`Attendance`**:
   `[Attendance Record ID, Employee ID, Employee Name, Supervisor ID, Supervisor Name, Landowner ID, Landowner Name, Location ID, Work Location, Attendance Date, Time IN, Time OUT, Original Time IN, Original Time OUT, Adjusted By, Adjustment Reason, Actual GPS IN, Actual GPS OUT, Device Timestamp, Synchronization Date, Synchronization Status, Record Status, Attendance Type, Leave Type, Leave Remarks]`
6. **`Audit Logs`**:
   `[Log ID, User ID, User Role, Action, Record ID, Previous Value, New Value, Reason, Date and Time]`
7. **`Users`**:
   `[User ID, Username, Password Hash, Role, Linked Supervisor ID, Account Status, Last Login]`

---

## 🚀 Setup & Deployment Instructions

### Step 1: Create Google Spreadsheet & Deploy Google Apps Script

1. Open your web browser and go to [Google Sheets](https://sheets.new) to create a new blank Google Spreadsheet.
2. Name the spreadsheet (e.g., `Employee Attendance Database`).
3. In the top menu, click **Extensions** &gt; **Apps Script**.
4. In the Apps Script code editor, delete any code inside `Code.gs` and copy-paste the entire contents of `Code.gs` from this project.
5. Save the project (click the disk icon or press `Ctrl + S`).
6. Deploy the Web App:
   - Click the blue **Deploy** button (top right) &gt; **New deployment**.
   - Click the gear icon next to *Select type* and choose **Web app**.
   - Configure the following settings:
     - **Description**: `Attendance API v1`
     - **Execute as**: `Me (your email address)`
     - **Who has access**: `Anyone` *(Crucial: allows the offline/mobile client app to submit records without OAuth login popups)*.
   - Click **Deploy**.
   - If prompted, click **Authorize access**, choose your Google account, click **Advanced**, and click **Go to Untitled project (unsafe)** to grant spreadsheet access.
   - Copy the generated **Web App URL** (it ends with `/exec`).

> **Updating an existing deployment?** Paste the new `Code.gs`, click **Deploy > Manage deployments > (pencil) Edit > Version: New version > Deploy**. The Web App URL stays the same. The three new Attendance columns are added to your existing sheet automatically on the next request, and existing data is kept. Also check **Project Settings > Time zone = (GMT+08:00) Manila**.

### Step 2: Connect the Frontend Application to Google Sheets

1. Open `index.html` in your web browser (or serve it via a local web server or web host).
2. On the login screen or top-right header, click **⚙ API Settings** (or the gear icon).
3. Paste the **Google Apps Script Web App URL** into the field.
4. Click **🔌 Test Connection & Initialize Sheets**.
   - The system will connect to Google Apps Script, initialize all 7 sheets with green headers, and confirm connectivity!
5. Click **Save Settings**.

---

## 🔑 Initial Default Login Credentials

Upon first initialization, the system creates a default Administrator account:

- **Username**: `admin`
- **Password**: `admin123`
- **Role**: `Admin`

*Tip: After logging in, you can change your password or create additional supervisors and admins in the **User Accounts** menu.*

---

## 📱 How to Use as an Installable Mobile / Desktop Web App (PWA)

This system is built as a Progressive Web App (PWA) and does not require an App Store or Play Store account:

### On Android (Chrome / Edge):
1. Open the application URL in Google Chrome.
2. Tap the three dots menu (⋮) in the top-right corner.
3. Tap **Install app** or **Add to Home screen**.
4. An icon will appear on your device's home screen that opens in full-screen standalone mode without browser bars!

### On iPhone / iPad (Safari):
1. Open the application URL in Safari.
2. Tap the **Share** button (box with an upward arrow at the bottom).
3. Scroll down and tap **Add to Home Screen**.
4. Tap **Add**. The app will launch like a native iOS application.

### On Desktop (Windows / Mac / Linux):
1. Open in Google Chrome or Microsoft Edge.
2. Click the **Install** icon on the right side of the URL address bar.
3. The app opens in its own clean desktop window.

---

## 🧪 Testing Offline Functionality

You can thoroughly verify offline behavior right from your browser's Developer Tools:

1. **Log in online once**:
   - Log in with `admin` / `admin123` or a supervisor account while connected.
   - The app automatically caches credentials, employee assignments, and static files into IndexedDB and Cache Storage.
2. **Simulate Offline Mode**:
   - Open Developer Tools (`F12` or right-click &gt; *Inspect*).
   - Go to the **Network** tab.
   - In the throttling dropdown (where it says *No throttling*), select **Offline**.
3. **Record Attendance Offline**:
   - Notice the connection pill switches to **Offline** (Red).
   - Go to **Record Attendance**.
   - Click **TIME IN** for an employee.
   - The attendance punch is recorded instantly with the exact device timestamp and GPS coordinates.
   - Notice the sync badge displays **PENDING** (Orange).
4. **Log Out & Log In Offline**:
   - Click the logout button.
   - Notice you are still on the login page even with no internet!
   - Enter your credentials and click **Sign In**.
   - The app verifies your password hash against IndexedDB and logs you in offline!
5. **Simulate Online Reconnection**:
   - In the Developer Tools Network tab, switch back from **Offline** to **No throttling** (Online).
   - Watch the connection badge immediately turn green (**Online**).
   - The system detects reconnection and **automatically uploads pending records to Google Sheets**!
   - The badge turns green (**SYNCED**) and Google Sheets receives the new rows with zero duplicates.

---

## 🛡 Security & Role-Based Rules

- **Client-Side Storage**: Sensitive passwords are never stored in plaintext; they are hashed with **SHA-256** using the browser's native Web Crypto API.
- **Strict Supervisor Isolation**: When a supervisor logs in, both the client queries and backend Google Apps Script filter employees and attendance exclusively by that supervisor's ID.
- **Audit Logging**: Every attendance adjustment, employee reassignment, or record soft deletion records an immutable audit entry with the editor's identity, timestamp, and reason.
