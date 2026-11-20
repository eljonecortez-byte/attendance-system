/**
 * Authentication & Session Management (v3)
 *
 * Online login: the server checks the password and returns a session token.
 *   If the server says NO (wrong password, deactivated) the app does NOT fall back
 *   to offline login - that was the v2 bug that let deactivated users in.
 * Offline login: only when the server cannot be reached. Uses a PBKDF2 hash stored
 *   on this phone, and only within `offlineLoginDays` of the last online login.
 */

class AuthService {
  constructor() {
    this.currentUser = null;
  }

  /** SHA-256 hex of the password (this is what is sent to the server, which salts it again). */
  async hashPassword(password) {
    if (!password) return '';
    const data = new TextEncoder().encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /** Slow, salted hash for the offline login copy kept on the phone. */
  async offlineHash(password, saltHex) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: enc.encode(saltHex), iterations: 150000, hash: 'SHA-256' },
      key,
      256
    );
    return Array.from(new Uint8Array(bits)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  randomHex(bytes = 16) {
    const arr = new Uint8Array(bytes);
    crypto.getRandomValues(arr);
    return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async initSession() {
    await db.init();
    const user = await db.getSetting('currentUser');
    // v2 sessions have no token: ask for a fresh online login once.
    if (user && user.token) {
      this.currentUser = user;
    } else if (user) {
      await db.setSetting('currentUser', null);
    }
    return this.currentUser;
  }

  getCurrentUser() {
    return this.currentUser;
  }

  isAdmin() {
    return !!this.currentUser && this.currentUser.role === 'Admin';
  }

  isSupervisor() {
    return !!this.currentUser && this.currentUser.role === 'Supervisor';
  }

  getLinkedSupervisorId() {
    return this.currentUser ? this.currentUser.linkedSupervisorId : null;
  }

  async getAppSettings() {
    return Object.assign({
      photoMode: 'required', geofenceMode: 'warn', defaultRadiusMeters: 300, maxGpsAccuracyMeters: 100,
      regularHours: 8, breakMinutes: 60, breakAfterHours: 5, restDay: 0, attendanceDays: 60,
      offlineLoginDays: 30, maxClockDriftMinutes: 5, workStartTime: '07:00 AM', lateGraceMinutes: 0
    }, await db.getSetting('appSettings', {}) || {});
  }

  async login(username, password) {
    if (!username || !password) throw new Error('Please enter both username and password.');

    const cleanUsername = username.trim();
    const key = cleanUsername.toLowerCase();
    const passwordHash = await this.hashPassword(password);

    // 1. Online login
    if (await api.isReachable()) {
      try {
        const result = await api.call('LOGIN', { username: cleanUsername, passwordHash }, { noToken: true });
        const u = result.user;
        const nowIso = new Date().toISOString();
        const user = {
          userId: u.userId,
          username: u.username,
          role: u.role,
          linkedSupervisorId: u.linkedSupervisorId || '',
          name: u.name || u.username,
          accountStatus: u.accountStatus || 'Active',
          mustChangePassword: !!u.mustChangePassword,
          token: result.token,
          tokenExpiresAt: result.tokenExpiresAt,
          lastOnlineLogin: nowIso,
          isOfflineSession: false
        };

        if (result.settings) await db.setSetting('appSettings', result.settings);

        // Offline login copy (salted PBKDF2, never the server hash)
        const salt = this.randomHex(16);
        await db.put('credentials', {
          username: key,
          salt,
          hash: await this.offlineHash(password, salt),
          user: Object.assign({}, user, { token: undefined }),
          lastOnlineLogin: nowIso
        });

        // If a different person used this phone before, forget their area selection
        const prev = await db.getSetting('lastUserId', null);
        if (prev && prev !== user.userId) await db.setSetting('sessionLandowner', null);
        await db.setSetting('lastUserId', user.userId);

        await db.setSetting('currentUser', user);
        this.currentUser = user;
        return { success: true, user, mode: 'online', message: 'Logged in online successfully.' };
      } catch (err) {
        if (!err.isNetwork) {
          // The server answered "no": never fall back to the offline copy.
          if (err.code === 'INVALID_CREDENTIALS' || err.code === 'ACCOUNT_DISABLED') {
            await db.delete('credentials', key);
          }
          throw err;
        }
        console.warn('[Auth] Server unreachable, trying offline login.', err.message);
      }
    }

    // 2. Offline login
    const cred = await db.get('credentials', key);
    if (!cred) {
      throw new Error('This account has not logged in online on this phone yet. Connect to the internet for the first login.');
    }
    if ((await this.offlineHash(password, cred.salt)) !== cred.hash) {
      throw new Error('Invalid username or password.');
    }
    if (cred.user.accountStatus !== 'Active') {
      throw new Error('This account has been deactivated. Please contact an administrator.');
    }
    const settings = await this.getAppSettings();
    const ageDays = (Date.now() - Date.parse(cred.lastOnlineLogin)) / 86400000;
    if (ageDays > Number(settings.offlineLoginDays || 30)) {
      throw new Error(`Offline login expired (last online login was ${Math.floor(ageDays)} days ago). Please log in once with internet.`);
    }

    const saved = await db.getSetting('currentUser', null);
    const token = saved && saved.userId === cred.user.userId ? saved.token : (await db.getSetting(`token:${cred.user.userId}`, ''));
    const user = Object.assign({}, cred.user, { token: token || '', isOfflineSession: true });
    await db.setSetting('currentUser', user);
    this.currentUser = user;
    return { success: true, user, mode: 'offline', message: 'Logged in offline. Records will upload when you are back online.' };
  }

  /** Changes the logged-in user's own password (online only). */
  async changePassword(currentPassword, newPassword) {
    if (!newPassword || newPassword.length < 8) throw new Error('New password must be at least 8 characters.');
    if (/^(admin123|password|12345678)$/i.test(newPassword)) throw new Error('Please choose a less common password.');
    const currentHash = await this.hashPassword(currentPassword);
    const newHash = await this.hashPassword(newPassword);
    await api.call('CHANGE_PASSWORD', { currentPasswordHash: currentHash, newPasswordHash: newHash });

    const user = this.currentUser;
    user.mustChangePassword = false;
    await db.setSetting('currentUser', user);
    const salt = this.randomHex(16);
    await db.put('credentials', {
      username: user.username.toLowerCase(),
      salt,
      hash: await this.offlineHash(newPassword, salt),
      user: Object.assign({}, user, { token: undefined }),
      lastOnlineLogin: new Date().toISOString()
    });
  }

  /** Called when the server says the session or account is no longer valid. */
  async invalidate(code) {
    if (this.currentUser && code === 'ACCOUNT_DISABLED') {
      await db.delete('credentials', this.currentUser.username.toLowerCase());
    }
    await this.logout(true);
  }

  async logout(skipServer = false) {
    const user = this.currentUser;
    if (user && user.token) {
      // Keep the token so an offline re-login on the same phone can still sync later
      await db.setSetting(`token:${user.userId}`, user.token);
      if (!skipServer && navigator.onLine) {
        api.call('LOGOUT', { token: user.token }, { noToken: true }).catch(() => {});
        await db.setSetting(`token:${user.userId}`, '');
      }
    }
    this.currentUser = null;
    await db.setSetting('currentUser', null);
  }
}

const auth = new AuthService();
