# CocoTrack Attendance & Field Monitoring — v3
### Offline-ready PWA · Google Sheets database · Google Apps Script API · Watermarked photo proof

---

## What's new in v3

| Area | Change |
|---|---|
| **Photo proof** | Time IN and Time OUT open a live camera. The photo is stamped with **TIME IN/OUT, time (with seconds), date, employee + ID, landowner, work location, GPS ± accuracy, geofence result, supervisor, record ID** and the CocoTrack emblem. Photos are saved to Google Drive (`CocoTrack Photos/yyyy-MM`) and linked in the Attendance sheet. |
| **Security** | Every request needs a **session token** from login. Role and supervisor are read from the Users sheet, never trusted from the phone. Passwords are **salted + stretched** on the server. Deactivating a user ends their sessions immediately. |
| **Login fix** | A server "no" (wrong password, deactivated) no longer falls back to the offline login. Offline login only works when the server can't be reached, and only within *N* days of the last online login. |
| **Default admin** | `admin / admin123` must be changed at first login. Reset passwords are temporary and must be changed too. |
| **Geofence** | Each work location can have latitude, longitude and radius ("Use my current GPS" button). Out-of-area punches are **warned + flagged** or **blocked** (admin setting). The server re-checks the distance. |
| **Fresh GPS** | GPS is read at the moment of each punch (no more stale positions). |
| **Phone clock check** | Records are flagged when the phone clock differs from the server clock, or jumps backwards. |
| **Hours & overtime** | Calculated on the phone and on the server (break deduction and regular hours are configurable). |
| **Cut-off summary** | On the **Admin dashboard** (all manpower, with per-supervisor subtotals) and the **Supervisor dashboard** (only their assigned manpower), plus its own page. Pick any **From → To** dates or a quick cut-off (1–15 / 16–end, previous cut-off, this/last month). Per person: **days present, absent, leave, times late, total late time, hours, OT**. Tap a person for a day-by-day list. CSV export for payroll. |
| **Sync** | Batches of 50; per-record errors shown; a record edited during upload is not lost; photos upload after their record; admin changes made offline are queued (outbox). |
| **Data accuracy** | Leading zeros kept (`0001` stays `0001`). Adjust form validates time format, prevents 2 records on one day, and stores the landowner ID together with the name. Audit log stores the real before → after values. |
| **Performance** | Phones download only the last 60 days (configurable). Database setup runs once, not on every request. App opens from cache after 3.5 s on weak signal. |
| **Themes** | 8 color themes: Coconut Green, Ocean Blue, Lagoon Teal, Sunset Orange, Royal Purple, Rose Pink, Copra Brown and **Sunlight Contrast** (for bright sun). Menu › Theme, or 🎨 on the login screen. Each user keeps their own theme on each phone. |
| **Dark mode** | Works with every color theme (except Sunlight Contrast). One-tap 🌙/☀️ button in the top bar and on the login screen, or Menu › Theme › **Light / Dark / Auto** (Auto follows the phone's day/night setting). Remembered per user. Users who chose the old "Midnight Dark" theme are moved to Green + Dark automatically. |
| **Profile photos** | Every user can set an avatar (tap the circle at the bottom of the menu, or Menu › My Profile Photo). Admins can set any user's photo on the User Accounts page. |
| **Employee photos** | A photo is **required when registering a new employee** (camera or upload). Existing employees show a dashed circle until a photo is added – admins or their supervisor can tap it to add one. The photo appears on attendance cards, history, cut-off summary, and **at the top of the Time IN/OUT camera** so the supervisor can compare faces. |
| **Admin** | Edit supervisors / landowners / locations, activate/deactivate users, create admin accounts, "Photo, GPS & Pay Rules" page, audit log from the server with search. |

---

## Upgrade from v2 (existing spreadsheet)

1. **Back up** the spreadsheet (File › Make a copy).
2. In Apps Script, replace all of `Code.gs` with the new one. Check **Project Settings › Time zone = (GMT+08:00) Manila**.
3. **Deploy › Manage deployments › ✏ Edit › Version: New version › Deploy.** Google will ask for permission again — approve **Google Drive** (needed for photos). The Web App URL stays the same.
4. Upload the new web files to GitHub, keeping this structure:

```text
index.html  manifest.json  sw.js
css/styles.css
js/db.js  js/api.js  js/auth.js  js/sync.js  js/camera.js  js/app.js
icons/ (logo-full.png, logo-emblem.png, favicon-64.png, apple-touch-icon-v2.png,
        app-icon-192.png, app-icon-512.png, app-icon-maskable-192.png, app-icon-maskable-512.png)
```

> On GitHub the file names must be exact: `app.js`, not `app (1).js`. `Code.gs` is **not** uploaded to GitHub — it lives only in Apps Script.

5. **Everyone signs in once with internet.** Old phone sessions don't have a token, so the app asks for a fresh login. Old passwords still work and are upgraded automatically on that login.
6. **Before** the first online login on each phone, upload any PENDING records still on it with the v2 app (or keep the phone online so v3 uploads them after login — records are never deleted).
7. Admin: open **Work Locations › Edit** and set the coordinates + radius for each block, then choose the rules under **Photo, GPS & Pay Rules**.
8. Employee IDs that already lost their leading zeros in v2 (e.g. `1` instead of `0001`) must be fixed by hand in the Employees sheet (format the column as Plain text first).

What the update changes in the spreadsheet automatically:
- **Attendance**: new columns Photo IN, Photo OUT, Distance IN/OUT Meters, Geofence IN/OUT, Hours Worked, Overtime Hours, Clock Flag, Device Timestamp OUT.
- **Work Locations**: Latitude, Longitude, Radius Meters.
- **Users**: Salt, Must Change Password.
- **Supervisors**: the Password Hash column is cleared (passwords now live only in Users, salted).
- **Profile Photos** (new sheet): `Photo Key, Type (USER / EMPLOYEE), Owner ID, Image, Updated At, Updated By`. Photos are small (240×240 JPEG) and stored as text so phones can cache them for offline use. Only changed photos are downloaded at each sync.

---

## New installation

1. Create a Google Sheet › **Extensions › Apps Script** › paste `Code.gs` › Save.
2. **Deploy › New deployment › Web app**: Execute as **Me**, Who has access **Anyone** › Deploy › approve Sheets **and** Drive access › copy the URL ending in `/exec`.
3. Host the web files (GitHub Pages works) and open `index.html`.
4. **⚙ API Settings** › paste the URL › **Test Connection** (this creates all sheets) › Save.
5. Sign in with `admin` / `admin123` › you'll be asked to set a new password.

"Anyone" access is required so phones can reach the API without a Google login popup. It is safe in v3 because every action except PING and LOGIN needs a valid session token.

---

## How a Time IN works

1. Supervisor picks the **landowner area** they are checking.
2. Taps **TIME IN** on a worker → the phone gets a **fresh GPS** reading.
3. Geofence rule: inside ✓ / outside → warn or block (admin setting).
4. **Live camera** opens → take the photo → review → **Use Photo**. The watermark is burned into the image.
5. The record and photo are saved on the phone (PENDING) and upload automatically when there is signal: record first, then photo to Drive. The Drive link is written into the Attendance row.
6. Full-size photos are removed from the phone 3 days after upload (a thumbnail stays). The original is always in Drive.

If the browser can't open the live camera, the phone camera app is used instead and the watermark says **Source: FILE**, so reviewers know.

---

## Admin settings ("Photo, GPS & Pay Rules")

| Setting | Default |
|---|---|
| Photo | Required (options: Optional with Skip button, Off) |
| Geofence | Warn & flag (options: Block, Off) |
| Default radius | 300 m |
| Weak GPS above | 100 m accuracy |
| Work starts at / grace period (for "late") | 07:00 AM / 0 min |
| Regular hours / break / break after | 8 h / 60 min / 5 h |
| Rest day | Sunday |
| Attendance days kept on phones | 60 |
| Offline login allowed for | 30 days after last online login |
| Phone clock tolerance | 5 minutes |

---

## Cut-off summary rules

- **Present** = a day with a Time IN.
- **Late** = Time IN after *Work starts at* + *grace period*. Late time is counted from *Work starts at* (grace 15 → 07:15 is on time, 07:16 is 16 min late).
- **Absent** = a working day (up to today) with no Time IN and no leave. The rest day and days before the employee's *Date Enrolled* are not counted.
- **Leave** = days marked On Leave.
- Online, the summary reads the full range from Google Sheets (any dates). Offline, it uses only the records on the phone and shows a warning.

## Google Sheets structure

1. **Employees** — `Employee ID, Employee Name, Position, Department, Supervisor ID, Supervisor Name, Landowner ID, Landowner Name, Location ID, Work Location, Employment Status, Date Enrolled`
2. **Supervisors** — `Supervisor ID, Supervisor Name, Username, Password Hash (empty), Account Status`
3. **Landowners** — `Landowner ID, Landowner Name, Location ID, Work Location, Supervisor ID, Status`
4. **Work Locations** — `… Status, Latitude, Longitude, Radius Meters`
5. **Attendance** — v2 columns + `Photo IN, Photo OUT, Distance IN Meters, Distance OUT Meters, Geofence IN, Geofence OUT, Hours Worked, Overtime Hours, Clock Flag, Device Timestamp OUT`
6. **Audit Logs** — `Log ID, User ID, User Role, Action, Record ID, Previous Value, New Value, Reason, Date and Time`
7. **Users** — `User ID, Username, Password Hash, Role, Linked Supervisor ID, Account Status, Last Login, Salt, Must Change Password`

Sessions and settings are stored in Apps Script **Script Properties** (not in the sheet).

---

## Security notes

- Passwords: the phone sends SHA-256(password); the server stores `salt + 500× SHA-256`. The offline copy on the phone is PBKDF2 (150,000 rounds) with its own salt.
- Supervisors only receive and can only change their own employees' records and photos (checked on the server).
- Photos in Drive stay **private** to the script owner. The app shows them through the API, so you don't need to share Drive links.
- Anyone with edit access to the spreadsheet can still change data directly. Keep sheet sharing limited to admins.

---

## Testing offline

1. Sign in online once, open **Record Attendance**.
2. DevTools › Network › **Offline**. Do a Time IN (camera + GPS still work).
3. The card shows **PENDING** and the Sync button shows a counter.
4. Switch back online: the record and then the photo upload automatically.
