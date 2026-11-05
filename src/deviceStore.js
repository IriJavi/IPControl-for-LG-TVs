const fs = require('fs');
const path = require('path');

function normalizeMac(value) {
  if (!value) return null;
  const cleaned = String(value).trim().toLowerCase().replace(/[^a-f0-9]/g, '');
  if (cleaned.length !== 12) return null;
  return cleaned.match(/.{1,2}/g).join(':');
}

class DeviceStore {
  constructor(rootDir) {
    this.rootDir = rootDir || process.cwd();
    this.inventoryPath = path.join(this.rootDir, 'devices.json');
    this.keysPath = path.join(this.rootDir, 'keys.json');
    this.inventory = this.readJson(this.inventoryPath, []);
    this.keys = this.normalizeKeyMap(this.readJson(this.keysPath, {}));
  }

  normalizeKeyIdentifier(identifier) {
    if (identifier === null || identifier === undefined) return null;
    const raw = String(identifier).trim();
    if (!raw) return null;
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(raw)) return raw;
    const mac = normalizeMac(raw);
    if (mac) return mac;
    return raw;
  }

  normalizeKeyMap(rawMap = {}) {
    const next = {};
    const seen = new Set();

    Object.entries(rawMap || {}).forEach(([key, value]) => {
      if (typeof value !== 'string') return;
      const trimmed = value.trim();
      if (!trimmed || trimmed === '{}' || !/^[a-f0-9]{16,}$/i.test(trimmed)) return;
      if (String(key).includes('.key.mac') || String(key).includes('.key') || String(key).toLowerCase().includes('wired') || String(key).toLowerCase().includes('wifi')) {
        return;
      }

      const normalizedKey = this.normalizeKeyIdentifier(key);
      if (!normalizedKey) return;
      const isIp = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(normalizedKey);
      const isMac = !!normalizeMac(normalizedKey);
      if (!isIp && !isMac) return;

      const canonicalKey = isIp ? normalizedKey : normalizeMac(normalizedKey);
      if (seen.has(canonicalKey)) return;
      seen.add(canonicalKey);
      next[canonicalKey] = trimmed;
    });

    return next;
  }

  getKeyAliases(identifier) {
    const aliases = new Set();
    const raw = typeof identifier === 'string' ? identifier.trim() : '';
    if (!raw) return [];

    const normalizedMac = normalizeMac(raw);
    if (normalizedMac) aliases.add(normalizedMac);
    if (raw.includes(':')) aliases.add(raw.replace(/:/g, ''));
    aliases.add(raw);

    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(raw)) {
      aliases.add(raw);
    }

    return [...aliases].filter(Boolean);
  }

  readJson(filePath, fallback) {
    try {
      if (!fs.existsSync(filePath)) return fallback;
      const raw = fs.readFileSync(filePath, 'utf8');
      if (!raw.trim()) return fallback;
      return JSON.parse(raw);
    } catch (error) {
      return fallback;
    }
  }

  writeJson(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  normalizeDevice(device = {}) {
    const rawMac = normalizeMac(device.mac || device.id || device.deviceId || '');
    const ip = typeof device.ip === 'string' ? device.ip.trim() : '';
    const name = String(device.name || device.label || (rawMac ? `LG-TV-${rawMac.slice(-6)}` : 'LG-TV')).trim() || 'LG-TV';

    return {
      id: device.id || rawMac || ip || `tv-${Date.now()}`,
      name,
      ip,
      mac: rawMac || null,
      group: device.group || 'default',
      notes: device.notes || '',
      autoDiscovered: !!device.autoDiscovered,
      lastSeenAt: device.lastSeenAt || Date.now(),
      online: !!device.online,
    };
  }

  listDevices() {
    return this.inventory.map((device) => this.normalizeDevice(device));
  }

  filterDiscoveredDevices(discovered = []) {
    const existing = new Set();
    for (const device of this.inventory) {
      const normalized = this.normalizeDevice(device);
      if (normalized.id) existing.add(String(normalized.id));
      if (normalized.ip) existing.add(String(normalized.ip));
      if (normalized.mac) existing.add(String(normalized.mac).toLowerCase());
    }

    return (Array.isArray(discovered) ? discovered : []).filter((device) => {
      const normalized = this.normalizeDevice(device);
      const candidates = [normalized.id, normalized.ip, normalized.mac].filter(Boolean).map((value) => String(value));
      return !candidates.some((value) => existing.has(value) || existing.has(value.toLowerCase()));
    });
  }

  getDeviceById(id) {
    return this.inventory.find((device) => device.id === id || device.mac === id || device.ip === id) || null;
  }

  getDeviceByMac(mac) {
    const normalized = normalizeMac(mac);
    if (!normalized) return null;
    return this.inventory.find((device) => normalizeMac(device.mac) === normalized) || null;
  }

  getDeviceByIp(ip) {
    return this.inventory.find((device) => device.ip === ip) || null;
  }

  saveInventory() {
    this.writeJson(this.inventoryPath, this.inventory);
  }

  registerOrUpdate(incoming) {
    const device = this.normalizeDevice(incoming);
    const index = this.inventory.findIndex((item) => {
      if (device.mac && normalizeMac(item.mac) === device.mac) return true;
      if (device.ip && item.ip === device.ip) return true;
      return item.id === device.id;
    });

    if (index >= 0) {
      this.inventory[index] = { ...this.inventory[index], ...device, lastSeenAt: Date.now() };
    } else {
      this.inventory.push({ ...device, lastSeenAt: Date.now() });
    }

    this.saveInventory();
    return this.normalizeDevice(this.inventory[index >= 0 ? index : this.inventory.length - 1]);
  }

  removeDeviceById(id) {
    const device = this.getDeviceById(id);
    if (!device) return null;

    this.inventory = this.inventory.filter((item) => {
      const sameMac = normalizeMac(item.mac) && normalizeMac(device.mac) && normalizeMac(item.mac) === normalizeMac(device.mac);
      const sameIp = item.ip && device.ip && item.ip === device.ip;
      return !(sameMac || sameIp || item.id === device.id);
    });

    this.saveInventory();
    return device;
  }

  setKey(identifier, key) {
    const value = String(key || '').trim();
    if (!value || !/^[a-f0-9]{16,}$/i.test(value)) return null;

    const normalizedMap = this.normalizeKeyMap(this.keys);
    const aliases = new Set(this.getKeyAliases(identifier));

    const normalizedTargetMac = normalizeMac(identifier);
    if (normalizedTargetMac) {
      const matchingDevice = this.inventory.find((device) => normalizeMac(device.mac) === normalizedTargetMac || device.id === identifier || device.ip === identifier);
      if (matchingDevice?.ip) aliases.add(matchingDevice.ip);
      if (matchingDevice?.mac) aliases.add(normalizeMac(matchingDevice.mac));
    }

    const rawTargetIp = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(String(identifier || '')) ? String(identifier) : '';
    if (rawTargetIp) {
      const matchingDevice = this.inventory.find((device) => device.ip === rawTargetIp || device.id === rawTargetIp || normalizeMac(device.mac) === rawTargetIp);
      if (matchingDevice?.mac) aliases.add(normalizeMac(matchingDevice.mac));
      if (matchingDevice?.ip) aliases.add(matchingDevice.ip);
    }

    for (const entry of aliases) {
      const canonical = this.normalizeKeyIdentifier(entry);
      if (canonical) normalizedMap[canonical] = value;
    }

    this.keys = normalizedMap;
    this.writeJson(this.keysPath, this.keys);
    return value;
  }

  getKey(identifier) {
    if (!identifier) return null;

    const aliases = this.getKeyAliases(identifier);
    for (const alias of aliases) {
      const direct = this.keys[alias];
      if (direct) return direct;
    }

    return null;
  }
}

module.exports = { DeviceStore, normalizeMac };
