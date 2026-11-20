/**
 * API client for the Google Apps Script backend.
 *  - Adds the session token to every request.
 *  - Separates NETWORK problems (retry later / work offline) from SERVER answers
 *    (wrong password, no permission, validation error) so the app never treats a
 *    server "no" as "offline".
 *  - Keeps an outbox for admin changes made while offline.
 */

class ApiError extends Error {
  constructor(message, code, extra) {
    super(message);
    this.code = code || 'SERVER';
    this.isNetwork = this.code === 'NETWORK';
    Object.assign(this, extra || {});
  }
}

const AUTH_ERROR_CODES = ['AUTH_REQUIRED', 'AUTH_EXPIRED', 'ACCOUNT_DISABLED'];

class ApiClient {
  async getUrl() {
    return db.getSetting('apiUrl', '');
  }

  async isReachable() {
    return navigator.onLine && !!(await this.getUrl());
  }

  /**
   * Call a backend action. Throws ApiError.
   * opts.noToken: send without a token (LOGIN / PING)
   * opts.url: override the saved URL (connection test)
   */
  async call(action, data = {}, opts = {}) {
    const url = opts.url || (await this.getUrl());
    if (!url) throw new ApiError('Google Apps Script URL is not set. Open ⚙ Settings first.', 'NO_URL');
    if (!navigator.onLine) throw new ApiError('You are offline.', 'NETWORK');

    const body = Object.assign({ action }, data);
    if (!opts.noToken) {
      const user = auth.getCurrentUser();
      body.token = user && user.token ? user.token : '';
    }

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutMs = opts.timeoutMs || 45000;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    const sentAt = Date.now();

    let result;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined
      });
      const text = await res.text();
      try {
        result = JSON.parse(text);
      } catch (e) {
        // Apps Script returns an HTML page when the deployment is wrong (not "Anyone", or wrong URL)
        throw new ApiError('The server did not return data. Check the Web App URL and that access is set to "Anyone".', 'BAD_RESPONSE');
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
      const msg = err && err.name === 'AbortError' ? 'The server took too long to answer.' : 'Could not reach the server.';
      throw new ApiError(msg, 'NETWORK');
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (result && result.offline) throw new ApiError(result.error || 'Offline.', 'NETWORK');

    // Keep track of the difference between this phone's clock and the server clock
    if (result && result.serverTime) {
      const roundTrip = Date.now() - sentAt;
      const offset = Date.parse(result.serverTime) + roundTrip / 2 - Date.now();
      if (!isNaN(offset)) {
        await db.setSetting('clockOffsetMs', Math.round(offset));
        await db.setSetting('clockCheckedAt', new Date().toISOString());
      }
    }

    if (!result || !result.success) {
      const code = (result && result.code) || 'SERVER';
      const err = new ApiError((result && result.error) || 'Server returned an error.', code);
      if (AUTH_ERROR_CODES.includes(code) && !opts.noToken) {
        window.dispatchEvent(new CustomEvent('cocotrack:auth-invalid', { detail: { code, message: err.message } }));
      }
      throw err;
    }
    return result;
  }

  /**
   * Save admin data (employee, supervisor, landowner, location, user).
   * Online: sends now and throws if the server refuses (e.g. duplicate ID).
   * Offline / network failure: queues it and returns { queued: true }.
   */
  async saveMaster(action, data, label) {
    if (await this.isReachable()) {
      try {
        const res = await this.call(action, data);
        return { queued: false, result: res };
      } catch (err) {
        if (!err.isNetwork) throw err;
      }
    }
    await db.put('outbox', {
      id: `OBX-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      action,
      data,
      label: label || action,
      createdAt: new Date().toISOString(),
      status: 'PENDING',
      error: ''
    });
    return { queued: true };
  }

  async getOutbox() {
    const items = await db.getAll('outbox');
    return items.sort((a, b) => (a.createdAt > b.createdAt ? 1 : -1));
  }

  /** Sends queued admin changes in the order they were made. */
  async processOutbox(includeFailed = false) {
    const items = (await this.getOutbox()).filter((i) => includeFailed || i.status !== 'FAILED');
    let sent = 0;
    const failed = [];
    for (const item of items) {
      try {
        await this.call(item.action, item.data);
        await db.delete('outbox', item.id);
        sent++;
      } catch (err) {
        if (err.isNetwork || AUTH_ERROR_CODES.includes(err.code)) throw err; // stop, try later
        item.status = 'FAILED';
        item.error = err.message;
        await db.put('outbox', item);
        failed.push(item);
      }
    }
    return { sent, failed };
  }
}

const api = new ApiClient();
