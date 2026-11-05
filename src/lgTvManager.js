process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const fs = require('fs');
const path = require('path');
const LGTV = require('lgtv2');
const { discoverLGTVs } = require('./network');

class LGTVManager {
  constructor({ store, rootDir, logger = console }) {
    this.store = store;
    this.rootDir = rootDir || process.cwd();
    this.logger = logger;
    this.clients = new Map();
    this.statuses = new Map();
    this.keepAliveTimer = null;
    this.keepAliveActive = false;
    this.keepAliveIntervalMs = 5 * 60 * 1000;
    this.keepAliveNextRunAt = null;
    this.connectionHeartbeatTimer = null;
    this.connectionHeartbeatMs = 30 * 1000;
    this.deviceKeepAliveTimers = new Map();
    this.deviceKeepAliveNextRunAt = new Map();
  }

  keyForDevice(device) {
    return String(device?.mac || device?.ip || device?.id || 'unknown');
  }

  getKeyFilePath(device) {
    const tempDir = path.join(this.rootDir, '.lgtv-keys-temp');
    try {
      fs.mkdirSync(tempDir, { recursive: true });
    } catch (error) {
      this.logger.warn(`[KEYFILE] Could not create the temporary keys folder: ${error?.message || String(error)}`);
    }

    const mac = device?.mac ? String(device.mac).trim().toLowerCase().replace(/[^a-f0-9]/g, '') : '';
    const value = mac || String(device?.ip || device?.id || 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '_');
    return path.join(tempDir, `.${value}.key`);
  }

  getKeyCandidates(device) {
    const values = new Set();
    if (device?.mac) values.add(device.mac);
    if (device?.ip) values.add(device.ip);
    if (device?.id) values.add(device.id);
    const normalizedMac = device?.mac ? device.mac.toLowerCase().replace(/[^a-f0-9]/g, '') : null;
    if (normalizedMac) {
      const withColons = normalizedMac.match(/.{1,2}/g)?.join(':') || normalizedMac;
      values.add(withColons);
      values.add(normalizedMac);
    }
    return [...values].filter(Boolean);
  }

  resolveSavedKey(device) {
    for (const candidate of this.getKeyCandidates(device)) {
      const savedKey = this.store.getKey(candidate);
      if (savedKey) return savedKey;
    }

    const keyFile = this.getKeyFilePath(device);
    try {
      const raw = fs.readFileSync(keyFile, 'utf8').trim();
      if (raw && raw !== '{}' && /^[a-f0-9]{16,}$/i.test(raw)) return raw;
    } catch (error) {
      // ignore missing temp key files when reconnecting; the key will be restored from the store
    }

    return null;
  }

  persistKey(device, newKey, keyFile = this.getKeyFilePath(device)) {
    const keyValue = typeof newKey === 'string' ? newKey.trim() : '';
    if (!keyValue || keyValue === '{}' || !/^[a-f0-9]{16,}$/i.test(keyValue)) return null;

    for (const candidate of this.getKeyCandidates(device)) {
      this.store.setKey(candidate, keyValue);
    }

    try {
      fs.writeFileSync(keyFile, keyValue, 'utf8');
    } catch (error) {
      this.logger.warn(`[KEYFILE] Could not persist the key for ${device?.ip || device?.id || 'TV'}: ${error.message || String(error)}`);
    }

    return keyValue;
  }

  getDeviceById(id) {
    return this.store.getDeviceById(id) || this.store.getDeviceByMac(id) || this.store.getDeviceByIp(id);
  }

  getStatus(key) {
    return this.statuses.get(key) || { online: false, lastSeenAt: Date.now() };
  }

  shouldRetryPairingWithFreshKey(error) {
    const text = String(error?.message || error?.code || error || '').toLowerCase();
    return /(pair|unauthorized|auth|invalid.*key|client-key|not paired|not authorized|pairing|rejected|forbidden)/i.test(text);
  }

  clearSavedKeyForDevice(device) {
    const dbDevice = this.store.normalizeDevice(device);
    const keyCandidates = [dbDevice.mac, dbDevice.ip, dbDevice.id].filter(Boolean);

    for (const candidate of keyCandidates) {
      if (this.store.keys && Object.prototype.hasOwnProperty.call(this.store.keys, candidate)) {
        delete this.store.keys[candidate];
      }
      if (this.store.inventory) {
        for (const item of this.store.inventory) {
          if ((item.mac && item.mac === candidate) || (item.ip && item.ip === candidate) || item.id === candidate) {
            if (item.mac) delete this.store.keys[item.mac];
            if (item.ip) delete this.store.keys[item.ip];
          }
        }
      }
    }

    const keyFilePath = this.getKeyFilePath(dbDevice);
    try {
      if (fs.existsSync(keyFilePath)) {
        fs.unlinkSync(keyFilePath);
      }
    } catch (error) {
      this.logger.warn(`[PAIRING] Could not clear the temporary key for ${dbDevice.name || dbDevice.ip}: ${error?.message || String(error)}`);
    }

    try {
      this.store.writeJson(this.store.keysPath, this.store.keys || {});
    } catch (error) {
      this.logger.warn(`[PAIRING] Could not save the key state after clearing ${dbDevice.name || dbDevice.ip}: ${error?.message || String(error)}`);
    }

    return true;
  }

  setStatus(device, extra = {}) {
    const key = this.keyForDevice(device);
    const next = {
      id: device.id,
      ip: device.ip,
      mac: device.mac || null,
      name: device.name,
      group: device.group || 'default',
      online: false,
      keySaved: !!(device.mac && this.store.getKey(device.mac)),
      lastSeenAt: Date.now(),
      ...this.getStatus(key),
      ...extra,
    };

    this.statuses.set(key, next);
    return next;
  }

  async connectDevice(device) {
    const dbDevice = this.store.normalizeDevice(device);
    if (!dbDevice.ip) {
      throw new Error('No IP available to connect the TV');
    }

    const key = this.keyForDevice(dbDevice);
    const existing = this.clients.get(key);
    if (existing) return existing;

    const savedKey = this.resolveSavedKey(dbDevice);
    const keyFile = this.getKeyFilePath(dbDevice);

    if (savedKey) {
      this.persistKey(dbDevice, savedKey, keyFile);
    } else {
      try {
        const fileKey = fs.readFileSync(keyFile, 'utf8').trim();
        if (fileKey && fileKey !== '{}' && /^[a-f0-9]{16,}$/i.test(fileKey)) {
          this.persistKey(dbDevice, fileKey, keyFile);
        }
      } catch (error) {
        // ignore missing key files when there is no stored key yet
      }
    }

    const tv = new LGTV({
      url: `wss://${dbDevice.ip}:3001`,
      keyFile,
      clientKey: savedKey || undefined,
      verifyCert: false,
      reconnect: 5000,
      keepalive: true,
      timeout: 15000,
      wsconfig: {
        keepalive: true,
        keepaliveInterval: 10000,
        dropConnectionOnKeepaliveTimeout: true,
        keepaliveGracePeriod: 5000,
      },
      saveKey: (newKey) => {
        if (!newKey) return null;
        const finalKey = String(newKey).trim();
        if (dbDevice.mac) this.store.setKey(dbDevice.mac, finalKey);
        if (dbDevice.ip) this.store.setKey(dbDevice.ip, finalKey);
        try { fs.writeFileSync(keyFile, finalKey, 'utf8'); } catch (error) {}
        return finalKey;
      },
    });

    this.clients.set(key, tv);
    this.setStatus(dbDevice, { online: false, lastSeenAt: Date.now() });

    tv.on('connect', () => {
      const current = this.store.normalizeDevice(dbDevice);
      const saved = tv.clientKey || this.resolveSavedKey(current);
      if (saved) {
        this.persistKey(current, saved, keyFile);
      }

      this.setStatus(current, {
        online: true,
        keySaved: !!(current.mac ? this.store.getKey(current.mac) : this.store.getKey(current.ip)),
        lastSeenAt: Date.now(),
      });
      this.logger.log(`[OK] ${current.name} connected at ${current.ip}`);
    });

    tv.on('prompt', () => {
      this.logger.warn(`[PROMPT] ${dbDevice.name} at ${dbDevice.ip}: accept the request on the TV`);
      this.setStatus(dbDevice, { online: false, promptRequired: true, lastSeenAt: Date.now() });
      const keyValue = tv.clientKey || this.resolveSavedKey(dbDevice);
      if (keyValue) {
        this.persistKey(dbDevice, keyValue, keyFile);
      }
    });

    tv.on('error', (error) => {
      const message = error?.message || String(error);
      this.logger.warn(`[ERROR] ${dbDevice.name} (${dbDevice.ip}): ${message}`);

      if (this.shouldRetryPairingWithFreshKey(error)) {
        this.logger.warn(`[PAIRING] Retrying pairing without a saved key for ${dbDevice.name} (${dbDevice.ip})`);
        this.clearSavedKeyForDevice(dbDevice);
        if (this.clients.get(key) === tv) this.clients.delete(key);
        setTimeout(() => {
          this.ensureConnected(dbDevice).catch((retryError) => {
            this.logger.warn(`[PAIRING] Retry failed for ${dbDevice.name} (${dbDevice.ip}): ${retryError?.message || String(retryError)}`);
          });
        }, 1500);
        return;
      }

      this.setStatus(dbDevice, { online: false, lastSeenAt: Date.now() });
    });

    tv.on('close', () => {
      this.logger.warn(`[CLOSE] ${dbDevice.name} (${dbDevice.ip}) closed`);
      this.setStatus(dbDevice, { online: false, lastSeenAt: Date.now() });
    });

    tv.on('key', (clientKey) => {
      if (clientKey) {
        this.persistKey(dbDevice, clientKey, keyFile);
      }
    });

    return tv;
  }

  async ensureConnected(device) {
    const dbDevice = this.store.normalizeDevice(device);
    let client = this.clients.get(this.keyForDevice(dbDevice));
    if (!client) {
      client = await this.connectDevice(dbDevice);
    }

    const isConnected = !!(client && (client.connection === true || client.connection?.connected === true));
    if (!isConnected && client && typeof client.connect === 'function') {
      try {
        client.connect(`wss://${dbDevice.ip}:3001`);
      } catch (error) {
        this.logger.warn(`[RETRY] Could not reconnect ${dbDevice.ip}: ${error?.message || String(error)}`);
      }
    }
    return client;
  }

  async executeCommand(device, command, payload) {
    const dbDevice = this.store.normalizeDevice(device);
    if (!dbDevice.ip) {
      return { status: 'error', message: 'No IP available for this device' };
    }

    const client = await this.ensureConnected(dbDevice);
    const connectedNow = !!(client && (client.connection === true || client.connection?.connected === true));

    if (!client || !connectedNow) {
      this.setStatus(dbDevice, { online: false, lastSeenAt: Date.now() });
      return { status: 'error', name: dbDevice.name, ip: dbDevice.ip, message: 'The TV is not connected' };
    }

    try {
      const response = await client.request(command, payload);
      this.setStatus(dbDevice, {
        online: true,
        keySaved: !!(dbDevice.mac ? this.store.getKey(dbDevice.mac) : this.store.getKey(dbDevice.ip)),
        lastSeenAt: Date.now(),
      });
      return { status: 'ok', name: dbDevice.name, ip: dbDevice.ip, response };
    } catch (error) {
      this.setStatus(dbDevice, { online: false, lastSeenAt: Date.now() });
      return { status: 'error', name: dbDevice.name, ip: dbDevice.ip, message: error?.message || String(error) };
    }
  }

  async launchUrl(device, url) {
    const dbDevice = this.store.normalizeDevice(device);
    const targetUrl = url || 'https://6b10-mes.mobis.com/dashboard.do';

    if (!dbDevice.ip) {
      return { status: 'error', message: 'No IP available for this device' };
    }

    const client = await this.ensureConnected(dbDevice);
    const connectedNow = !!(client && (client.connection === true || client.connection?.connected === true));

    if (!client || !connectedNow) {
      this.setStatus(dbDevice, { online: false, lastSeenAt: Date.now() });
      return { status: 'error', name: dbDevice.name, ip: dbDevice.ip, message: 'The TV is not connected' };
    }

    try {
      const response = await client.request('ssap://system.launcher/open', { target: targetUrl });
      this.setStatus(dbDevice, {
        online: true,
        keySaved: !!(dbDevice.mac ? this.store.getKey(dbDevice.mac) : this.store.getKey(dbDevice.ip)),
        lastSeenAt: Date.now(),
      });
      return { status: 'ok', name: dbDevice.name, ip: dbDevice.ip, url: targetUrl, response };
    } catch (error) {
      this.setStatus(dbDevice, { online: false, lastSeenAt: Date.now() });
      return { status: 'error', name: dbDevice.name, ip: dbDevice.ip, message: error?.message || String(error), url: targetUrl };
    }
  }

  async discoverAndConnect(options = {}) {
    const discovered = await discoverLGTVs(options);

    return discovered.map((item) => {
      const normalized = this.store.normalizeDevice(item);
      const key = this.keyForDevice(normalized);
      const current = this.getStatus(key);
      this.statuses.set(key, {
        ...current,
        id: normalized.id,
        ip: normalized.ip,
        mac: normalized.mac,
        name: normalized.name,
        group: normalized.group || 'default',
        online: false,
        lastSeenAt: Date.now(),
      });
      return normalized;
    });
  }

  async sendVolumeKeepAlive(device, source = 'KEEPALIVE') {
    const dbDevice = this.store.normalizeDevice(device);
    if (!dbDevice.ip) {
      return { status: 'error', message: 'No IP available for this device' };
    }

    try {
      await this.executeCommand(dbDevice, 'ssap://audio/volumeDown');
    } catch (error) {
      this.logger.warn(`[KEEPALIVE] ${source} | ${dbDevice.name}: ${error?.message || String(error)}`);
    }

    let client;
    try {
      client = await this.ensureConnected(dbDevice);
    } catch (error) {
      this.logger.warn(`[KEEPALIVE] ${source} | ${dbDevice.name}: ${error?.message || String(error)}`);
      return { status: 'error', message: error?.message || String(error) };
    }

    const connectedNow = !!(client && (client.connection === true || client.connection?.connected === true));
    if (!connectedNow || typeof client.getSocket !== 'function') {
      return { status: 'skipped', name: dbDevice.name, ip: dbDevice.ip, message: 'No remote socket available' };
    }

    return new Promise((resolve) => {
      client.getSocket('ssap://com.webos.service.networkinput/getPointerInputSocket', (error, socket) => {
        if (error || !socket) {
          const message = error?.message || 'Remote socket is empty';
          this.logger.warn(`[KEEPALIVE] ${source} | ${dbDevice.name} (${dbDevice.ip}) | ERROR socket: ${message}`);
          return resolve({ status: 'error', name: dbDevice.name, ip: dbDevice.ip, message });
        }

        try {
          socket.send('move', { dx: 1, dy: 0, down: 0 });
          setTimeout(() => {
            try {
              socket.send('button', { name: 'VOLUMEDOWN' });
            } catch (innerError) {
              this.logger.warn(`[KEEPALIVE] ${source} | ${dbDevice.name} (${dbDevice.ip}) | ERROR VOLUMEDOWN: ${innerError?.message || String(innerError)}`);
            }
          }, 150);
          resolve({ status: 'ok', name: dbDevice.name, ip: dbDevice.ip });
        } catch (innerError) {
          this.logger.warn(`[KEEPALIVE] ${source} | ${dbDevice.name} (${dbDevice.ip}) | ERROR MOVE: ${innerError?.message || String(innerError)}`);
          resolve({ status: 'error', name: dbDevice.name, ip: dbDevice.ip, message: innerError?.message || String(innerError) });
        }
      });
    });
  }

  startConnectionHeartbeat() {
    if (this.connectionHeartbeatTimer) return { status: 'ok', active: true };

    const tick = async () => {
      const devices = this.store.listDevices();
      for (const device of devices) {
        try {
          if (!device.ip) continue;
          const client = await this.ensureConnected(device);
          const connectedNow = !!(client && (client.connection === true || client.connection?.connected === true));
          if (!client || !connectedNow) {
            this.setStatus(device, { online: false, lastSeenAt: Date.now() });
            continue;
          }
          const response = await client.request('ssap://audio/getVolume');
          this.setStatus(device, {
            online: true,
            keySaved: !!(device.mac ? this.store.getKey(device.mac) : this.store.getKey(device.ip)),
            lastSeenAt: Date.now(),
            response: response || null,
          });
        } catch (error) {
          this.setStatus(device, { online: false, lastSeenAt: Date.now(), error: error?.message || String(error) });
        }
      }
    };

    tick().catch(() => {});
    this.connectionHeartbeatTimer = setInterval(() => {
      tick().catch(() => {});
    }, this.connectionHeartbeatMs);

    return { status: 'ok', active: true, intervalMs: this.connectionHeartbeatMs };
  }

  stopConnectionHeartbeat() {
    if (this.connectionHeartbeatTimer) {
      clearInterval(this.connectionHeartbeatTimer);
      this.connectionHeartbeatTimer = null;
    }
    return { status: 'ok', active: false };
  }

  startKeepAlive() {
    if (this.keepAliveActive) return { status: 'ok', active: true };

    this.keepAliveActive = true;
    this.keepAliveNextRunAt = Date.now() + this.keepAliveIntervalMs;
    const tick = async () => {
      const devices = this.store.listDevices();
      for (const device of devices) {
        try {
          if (device.ip) {
            await this.sendVolumeKeepAlive(device, 'MASTER');
          }
        } catch (error) {
          this.logger.warn(`[KEEPALIVE] ${device.name}: ${error?.message || String(error)}`);
        }
      }
      this.keepAliveNextRunAt = Date.now() + this.keepAliveIntervalMs;
    };

    tick();
    this.keepAliveTimer = setInterval(() => {
      tick().catch(() => {});
    }, this.keepAliveIntervalMs);

    return { status: 'ok', active: true };
  }

  getDeviceKeepAliveState(device) {
    const dbDevice = this.store.normalizeDevice(device);
    const key = dbDevice.mac || dbDevice.ip || dbDevice.id || 'unknown';
    const timer = this.deviceKeepAliveTimers.get(key);
    const nextRunAt = this.deviceKeepAliveNextRunAt.get(key);
    const active = !!timer;
    const remainingMs = active && nextRunAt ? Math.max(0, nextRunAt - Date.now()) : 0;
    return {
      active,
      intervalMs: this.keepAliveIntervalMs,
      remainingMs,
      nextRunAt: nextRunAt || null,
    };
  }

  async startDeviceKeepAlive(device) {
    const dbDevice = this.store.normalizeDevice(device);
    const key = dbDevice.mac || dbDevice.ip || dbDevice.id || 'unknown';

    if (this.deviceKeepAliveTimers.has(key)) {
      return { status: 'ok', active: true, device: dbDevice.id, remainingMs: this.getDeviceKeepAliveState(dbDevice).remainingMs };
    }

    this.deviceKeepAliveNextRunAt.set(key, Date.now() + this.keepAliveIntervalMs);
    const tick = async () => {
      try {
        if (dbDevice.ip) {
          await this.sendVolumeKeepAlive(dbDevice, 'DEVICE');
        }
      } catch (error) {
        this.logger.warn(`[KEEPALIVE] ${dbDevice.name}: ${error?.message || String(error)}`);
      }
      this.deviceKeepAliveNextRunAt.set(key, Date.now() + this.keepAliveIntervalMs);
    };

    await tick();
    const timer = setInterval(() => {
      tick().catch(() => {});
    }, this.keepAliveIntervalMs);
    this.deviceKeepAliveTimers.set(key, timer);

    return { status: 'ok', active: true, device: dbDevice.id, remainingMs: this.keepAliveIntervalMs };
  }

  stopDeviceKeepAlive(device) {
    const dbDevice = this.store.normalizeDevice(device);
    const key = dbDevice.mac || dbDevice.ip || dbDevice.id || 'unknown';
    const timer = this.deviceKeepAliveTimers.get(key);

    if (timer) {
      clearInterval(timer);
      this.deviceKeepAliveTimers.delete(key);
    }
    this.deviceKeepAliveNextRunAt.delete(key);

    return { status: 'ok', active: false, device: dbDevice.id, remainingMs: 0 };
  }

  stopKeepAlive() {
    this.keepAliveActive = false;
    this.keepAliveNextRunAt = null;
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    return { status: 'ok', active: false };
  }

  async triggerVolumeDown(scope = 'all', targets = []) {
    const devices = [];
    const catalog = this.store.listDevices();

    if (scope === 'all') {
      catalog.forEach((device) => devices.push(device));
    } else if (scope === 'group') {
      const groupName = Array.isArray(targets) ? targets[0] : targets;
      catalog.forEach((device) => {
        if (device.group === groupName) devices.push(device);
      });
    } else if (Array.isArray(targets) && targets.length) {
      targets.forEach((id) => {
        const device = this.getDeviceById(id);
        if (device) devices.push(device);
      });
    }

    const unique = [];
    const seen = new Set();
    for (const device of devices) {
      const key = device.mac || device.ip || device.id;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(device);
      }
    }

    const results = [];
    for (const device of unique) {
      results.push(await this.executeCommand(device, 'ssap://audio/volumeDown'));
    }

    return { status: 'ok', results };
  }
}

module.exports = { LGTVManager };
