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
    this.keys = this.readJson(this.keysPath, {});
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
    if (!value) return null;

    const keysToWrite = new Set();
    const normalized = normalizeMac(identifier);
    if (normalized) keysToWrite.add(normalized);

    const rawIdentifier = typeof identifier === 'string' ? identifier.trim() : '';
    if (rawIdentifier) keysToWrite.add(rawIdentifier);

    for (const entry of keysToWrite) {
      this.keys[entry] = value;
    }

    this.writeJson(this.keysPath, this.keys);
    return value;
  }

  getKey(identifier) {
    if (!identifier) return null;

    const normalized = normalizeMac(identifier);
    if (normalized && this.keys[normalized]) return this.keys[normalized];

    const rawIdentifier = String(identifier).trim();
    if (rawIdentifier && this.keys[rawIdentifier]) return this.keys[rawIdentifier];

    return null;
  }
}

module.exports = { DeviceStore, normalizeMac };
