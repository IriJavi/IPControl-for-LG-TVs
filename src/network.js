const fs = require('fs');
const os = require('os');
const net = require('net');
const { execFile } = require('child_process');
const util = require('util');

const execFileAsync = util.promisify(execFile);

function normalizeMac(value) {
  if (!value) return null;
  const cleaned = String(value).trim().toLowerCase().replace(/[^a-f0-9]/g, '');
  if (cleaned.length !== 12) return null;
  return cleaned.match(/.{1,2}/g).join(':');
}

function ipToInt(ip) {
  return ip.split('.').reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0);
}

function intToIp(value) {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

function getLocalNetworks() {
  const entries = [];
  const interfaces = os.networkInterfaces();

  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const item of addresses || []) {
      if (item.family !== 'IPv4' || item.internal) continue;
      const mask = item.netmask || '255.255.255.0';
      const network = intToIp((ipToInt(item.address) & ipToInt(mask)) >>> 0);
      const prefix = mask.split('.').map((part) => Number(part)).reduce((count, octet) => {
        let bits = 0;
        let value = octet;
        while (value > 0) {
          bits += value & 1;
          value = value >>> 1;
        }
        return count + bits;
      }, 0);
      entries.push({ name, address: item.address, network, mask, cidr: `${network}/${prefix}` });
    }
  }

  return entries;
}

function generateIpsFromCidr(cidr) {
  if (!cidr) return [];
  const [networkPart, prefixPart] = cidr.split('/');
  const prefix = Number(prefixPart);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return [];

  const network = ipToInt(networkPart);
  const mask = prefix === 0 ? 0 : ((0xffffffff << (32 - prefix)) >>> 0);
  const start = (network & mask) >>> 0;
  const maxHosts = 2 ** (32 - prefix);
  const ips = [];

  for (let offset = 1; offset < Math.min(maxHosts - 1, 254); offset += 1) {
    ips.push(intToIp((start + offset) >>> 0));
  }

  return ips;
}

function generateIpsFromRange(startIp, endIp) {
  if (!startIp || !endIp) return [];
  const start = ipToInt(startIp);
  const end = ipToInt(endIp);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];

  const ips = [];
  for (let value = start; value <= end; value += 1) {
    ips.push(intToIp(value >>> 0));
  }
  return ips;
}

function buildTargetIps({ cidr, startIp, endIp } = {}) {
  const unique = new Set();

  if (cidr) {
    for (const ip of generateIpsFromCidr(cidr)) unique.add(ip);
  }

  if (startIp && endIp) {
    for (const ip of generateIpsFromRange(startIp, endIp)) unique.add(ip);
  }

  if (!unique.size) {
    for (const network of getLocalNetworks()) {
      for (const ip of generateIpsFromCidr(network.cidr)) unique.add(ip);
    }
  }

  return [...unique];
}

function parseArpTable(raw) {
  const map = {};
  if (!raw || !raw.trim()) return map;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('Interface') || trimmed.startsWith('Internet')) continue;

    const ipMatch = trimmed.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
    const macMatch = trimmed.match(/([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})/);
    if (ipMatch && macMatch) {
      const ip = ipMatch[1];
      const mac = normalizeMac(macMatch[1]);
      if (ip && mac) map[ip] = mac;
    }
  }

  return map;
}

async function readArpTable() {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('arp', ['-a']);
      return parseArpTable(stdout || '');
    }
    const { stdout } = await execFileAsync('arp', ['-an']);
    return parseArpTable(stdout || '');
  } catch (error) {
    return {};
  }
}

function portIsOpen(ip, port, timeoutMs = 120) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const answer = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => answer(true));
    socket.once('timeout', () => answer(false));
    socket.once('error', () => answer(false));
    socket.connect(port, ip);
  });
}

async function discoverLGTVs({ timeoutMs = 120, cidr, startIp, endIp } = {}) {
  const arpMap = await readArpTable();
  const discovered = [];
  const seen = new Set();
  const candidates = buildTargetIps({ cidr, startIp, endIp });
  const concurrency = 24;

  for (let index = 0; index < candidates.length; index += concurrency) {
    const batch = candidates.slice(index, index + concurrency);
    const batchResults = await Promise.all(batch.map(async (ip) => {
      if (!ip || seen.has(ip)) return null;

      const isOpen = await portIsOpen(ip, 3000, timeoutMs);
      if (!isOpen) return null;

      const mac = arpMap[ip] || null;
      const id = mac || ip;
      if (seen.has(id)) return null;

      seen.add(id);
      seen.add(ip);

      return {
        id,
        ip,
        mac,
        name: mac ? `LG-TV-${mac.slice(-6).replace(/:/g, '')}` : `LG-TV-${ip.replace(/\./g, '-')}`,
        group: 'default',
        autoDiscovered: true,
        lastSeenAt: Date.now(),
      };
    }));

    for (const item of batchResults) {
      if (item) discovered.push(item);
    }
  }

  return discovered.sort((a, b) => a.ip.localeCompare(b.ip));
}

module.exports = {
  normalizeMac,
  readArpTable,
  getLocalNetworks,
  generateIpsFromCidr,
  generateIpsFromRange,
  buildTargetIps,
  discoverLGTVs,
};
