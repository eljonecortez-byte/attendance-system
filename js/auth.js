/**
 * Authentication & Session Management
 * Handles Web Crypto SHA-256 hashing, online/offline login, and role-based permissions.
 */

class AuthService {
  constructor() {
    this.currentUser = null;
  }

  // SHA-256 Hash using standard Web Crypto API
  async hashPassword(password) {
    if (!password) return '';
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Load existing session on app startup
  async initSession() {
    await db.init();
    const user = await db.getSetting('currentUser');
    if (user) {
      this.currentUser = user;
    }
    return this.currentUser;
  }

  getCurrentUser() {
    return this.currentUser;
  }

  isAdmin() {
    return this.currentUser && this.currentUser.role === 'Admin';
  }

  isSupervisor() {
    return this.currentUser && this.currentUser.role === 'Supervisor';
  }

  getLinkedSupervisorId() {
    return this.currentUser ? this.currentUser.linkedSupervisorId : null;
  }

  // Login handler with seamless Offline fallback
  async login(username, password) {
    if (!username || !password) {
      throw new Error('Please enter both username and password.');
    }

    const cleanUsername = username.trim();
    const passwordHash = await this.hashPassword(password);
    const apiUrl = await db.getSetting('apiUrl', '');

    const isOnline = navigator.onLine && !!apiUrl;

    // 1. Try Online Login if connected and API URL exists
    if (isOnline) {
      try {
        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({
            action: 'LOGIN',
            username: cleanUsername,
            passwordHash: passwordHash
          })
        });

        const result = await response.json();

        if (result && result.success && result.user) {
          const user = {
            userId: result.user.userId,
            username: result.user.username,
            role: result.user.role,
            linkedSupervisorId: result.user.linkedSupervisorId || '',
            name: result.user.name || result.user.username,
            accountStatus: result.user.accountStatus || 'Active',
            passwordHash: passwordHash, // cached for offline login
            lastLogin: new Date().toISOString(),
            isOfflineSession: false
          };

          // Cache user credentials into IndexedDB
          await db.put('users', user);
          await db.setSetting('currentUser', user);
          this.currentUser = user;

          return { success: true, user: user, mode: 'online', message: 'Logged in online successfully.' };
        } else {
          // If server explicitly rejected credentials, don't fall back to offline
          throw new Error(result.error || 'Invalid username or password.');
        }
      } catch (err) {
        console.warn('[Auth] Online login failed or network down. Attempting offline login...', err.message);
        // If error was explicit credential mismatch from server, rethrow
        if (err.message.includes('Invalid username')) {
          throw err;
        }
      }
    }

    // 2. Offline Login using cached credentials in IndexedDB
    const users = await db.getAll('users');
    const cachedUser = users.find(
      (u) => u.username.toLowerCase() === cleanUsername.toLowerCase()
    );

    if (cachedUser) {
      if (cachedUser.passwordHash === passwordHash) {
        if (cachedUser.accountStatus !== 'Active') {
          throw new Error('This account has been deactivated. Please contact an administrator.');
        }

        const user = {
          ...cachedUser,
          isOfflineSession: true
        };

        await db.setSetting('currentUser', user);
        this.currentUser = user;

        return {
          success: true,
          user: user,
          mode: 'offline',
          message: 'Logged in offline using cached credentials.'
        };
      } else {
        throw new Error('Incorrect password for cached offline account.');
      }
    }

    // Default Fallback when first setting up the system offline:
    // If no users exist anywhere and username is 'admin' and password is 'admin123'
    if (users.length === 0 && cleanUsername.toLowerCase() === 'admin' && password === 'admin123') {
      const defaultAdmin = {
        userId: 'USR-ADMIN-1',
        username: 'admin',
        role: 'Admin',
        linkedSupervisorId: '',
        name: 'System Administrator',
        accountStatus: 'Active',
        passwordHash: passwordHash,
        lastLogin: new Date().toISOString(),
        isOfflineSession: true
      };
      await db.put('users', defaultAdmin);
      await db.setSetting('currentUser', defaultAdmin);
      this.currentUser = defaultAdmin;

      return {
        success: true,
        user: defaultAdmin,
        mode: 'initial_offline',
        message: 'Initial default administrator account initialized.'
      };
    }

    throw new Error('User not found. To log in offline, you must have logged in online at least once on this device.');
  }

  // Logout current user
  async logout() {
    this.currentUser = null;
    await db.setSetting('currentUser', null);
  }
}

// Global Auth instance
const auth = new AuthService();
