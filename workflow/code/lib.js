// Shared helpers for Update Netbox Code nodes (embedded by build_workflow.py).
// Do not read $env: this n8n instance sets N8N_BLOCK_ENV_ACCESS_IN_NODE.

function httpOpts(method, url, headers, body) {
  const opts = {
    method,
    url,
    headers: Object.assign({ Accept: 'application/json' }, headers || {}),
    skipSslCertificateValidation: {{ENVBOOL:SKIP_TLS_VERIFY}},
    timeout: 60000,
    ignoreHttpStatusErrors: true,
    returnFullResponse: true,
  };
  if (body !== undefined && body !== null) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = body;
  }
  return opts;
}

async function httpRaw(method, url, headers, body) {
  const res = await this.helpers.httpRequest(httpOpts(method, url, headers, body));
  const status = res.statusCode || res.status || 0;
  let parsed = res.body;
  if (typeof parsed === 'string' && parsed !== '') {
    try { parsed = JSON.parse(parsed); } catch (e) { /* keep string */ }
  }
  return { status, body: parsed, raw: res };
}

function fmtBytes(n) {
  let value = Number(n || 0);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  for (const unit of units) {
    if (value < 1024 || unit === 'TB') {
      return unit === 'B' ? `${Math.floor(value)}B` : `${value.toFixed(1)}${unit}`;
    }
    value /= 1024;
  }
  return `${value.toFixed(1)}TB`;
}

function isInterestingIp(ip) {
  if (!ip || String(ip).includes(':') || String(ip).startsWith('169.254.')) return false;
  if (String(ip).startsWith('172.')) {
    const second = parseInt(String(ip).split('.')[1], 10);
    if (!Number.isNaN(second) && second >= 16 && second <= 31) return false;
  }
  return true;
}

function ipToInt(ip) {
  const p = String(ip).split('.').map((x) => parseInt(x, 10));
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return (((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) >>> 0;
}

function intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function prefixFromIpBits(ip, bits) {
  const addr = ipToInt(ip);
  const b = parseInt(bits, 10);
  if (addr == null || Number.isNaN(b) || b < 0 || b > 32) return { prefix: '', prefixlen: 24 };
  const mask = b === 0 ? 0 : (0xFFFFFFFF << (32 - b)) >>> 0;
  return { prefix: `${intToIp((addr & mask) >>> 0)}/${b}`, prefixlen: b };
}

function ipInCidr(ip, cidr) {
  const [net, bitsS] = String(cidr).split('/');
  const bits = parseInt(bitsS, 10);
  const a = ipToInt(ip);
  const n = ipToInt(net);
  if (a == null || n == null || Number.isNaN(bits)) return false;
  const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
  return ((a & mask) >>> 0) === ((n & mask) >>> 0);
}

function asInt(value) {
  if (value === true) return 1;
  if (value == null || value === false) return 0;
  if (typeof value === 'number') return Math.trunc(value);
  if (typeof value === 'string') {
    const n = parseFloat(value);
    return Number.isNaN(n) ? 0 : Math.trunc(n);
  }
  if (typeof value === 'object') {
    if ('total' in value) return asInt(value.total);
    const client = value.tot_as_client != null ? value.tot_as_client : value.as_client;
    const server = value.tot_as_server != null ? value.tot_as_server : value.as_server;
    if (client != null || server != null) return asInt(client) + asInt(server);
    return Object.values(value).reduce((s, item) => (
      typeof item === 'number' || typeof item === 'string' ? s + asInt(item) : s
    ), 0);
  }
  return 0;
}

function fmtTs(value) {
  const ts = parseInt(value || 0, 10);
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

function fmtDuration(value) {
  const seconds = Math.trunc(parseFloat(value || 0));
  if (!seconds) return '';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function textOf(block, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
  const m = String(block || '').match(re);
  return m ? m[1].trim() : '';
}

function namedChildren(block) {
  const re = /<([A-Za-z0-9_]+)>([\s\S]*?)<\/\1>/g;
  const out = [];
  let m;
  const src = String(block || '');
  while ((m = re.exec(src))) out.push({ tag: m[1], body: m[2] });
  return out;
}

function section(xml, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
  const m = String(xml || '').match(re);
  return m ? m[1] : '';
}

function slugify(value) {
  const s = String(value || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  return s || 'item';
}

function parseBool(value) {
  return ['1', 'true', 'yes', 'y'].includes(String(value || '').trim().toLowerCase());
}

function flattenRow(row) {
  const flat = {};
  for (const [key, value] of Object.entries(row)) {
    if (Array.isArray(value)) flat[key] = value.filter((x) => x != null && x !== '').join(';');
    else if (typeof value === 'boolean') flat[key] = value ? 'true' : 'false';
    else if (value == null) flat[key] = '';
    else flat[key] = String(value);
  }
  return flat;
}
