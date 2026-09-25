const cfg = $('Fetch vCenter NIC MACs').first().json;
const interfaces = cfg.interfaces || [];
const pools = cfg.pools || [];
const ntopByIp = cfg.ntopByIp || {};
const byVm = cfg.vcenterByVm || {};
const vms = cfg.vcenterVms || [];
const vmByName = {};
for (const vm of vms) vmByName[vm.name] = vm;

function ntopFields(ips) {
  const matches = ips.filter((ip) => ntopByIp[ip]).map((ip) => Object.assign({ ip }, ntopByIp[ip]));
  const primary = matches.length ? matches.reduce((a, b) => ((a.bytes_total || 0) >= (b.bytes_total || 0) ? a : b)) : null;
  return {
    ntop_matched: matches.length > 0,
    ntop_ip: primary ? primary.ip : null,
    ntop_name: primary ? primary.ntop_name : null,
    ntop_bytes_human: primary ? fmtBytes(primary.bytes_total) : null,
    ntop_flows: primary ? primary.flows : null,
    ntop_alerts: primary ? primary.alerts : null,
    ntop_score: primary ? primary.score : null,
    ips_primary: ips.filter(isInterestingIp),
  };
}

function blankRow(name, assetType) {
  return {
    name,
    asset_type: assetType,
    source: assetType,
    sources: '',
    power_state: assetType === 'vm' ? 'POWERED_OFF' : 'PHYSICAL',
    cpu_count: null,
    memory_gib: null,
    guest_os: null,
    hostname: null,
    vm_id: null,
    macs: [],
    nic_networks: [],
    nic_names: [],
    ips: [],
    addresses: [],
    prefix_notes: '',
    ips_primary: [],
    notes: '',
  };
}

function prefixlenForKnownIp(ip) {
  const addrOk = ipToInt(ip) != null;
  if (!addrOk) return 24;
  let best = 0;
  for (const item of interfaces.concat(pools)) {
    const cidr = item.prefix || '';
    if (!cidr) continue;
    const bits = parseInt(String(cidr.split('/')[1] || '0'), 10);
    if (ipInCidr(ip, cidr) && bits > best) best = bits;
  }
  return best || 24;
}

function matchIfaceMac(iface, nics) {
  const mac = String(iface.mac || '').toLowerCase();
  if (mac) return mac;
  const keys = [];
  const descrKey = String(iface.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (descrKey) keys.push(descrKey);
  const nums = String(iface.name || '').match(/\d{3,}/g) || [];
  keys.push(...nums);
  for (const key of keys) {
    const hits = nics.filter((nic) => {
      const blob = String(nic.network || nic.label || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      return blob.includes(key);
    });
    if (hits.length === 1) return hits[0].mac;
  }
  return '';
}

const leasesByMac = {};
for (const pool of pools) {
  for (const lease of pool.leases || []) {
    const mac = String(lease.mac || '').toLowerCase();
    if (!mac) continue;
    (leasesByMac[mac] || (leasesByMac[mac] = [])).push(Object.assign({}, lease, {
      prefixlen: pool.prefixlen || 24,
    }));
  }
}

let pfsenseVmName = '';
if (byVm['{{ENV:PFSENSE_VM_NAME}}']) pfsenseVmName = '{{ENV:PFSENSE_VM_NAME}}';
else {
  for (const [name, meta] of Object.entries(vmByName)) {
    if (String(name || '').toLowerCase().includes('pfsense') && meta.power_state === 'POWERED_ON') {
      pfsenseVmName = name;
      break;
    }
  }
}

const claimed = new Set();
const rows = [];
let matchedLeases = 0;
const headers = { 'vmware-api-session-id': cfg.vcenterToken };

for (const [name, nics] of Object.entries(byVm)) {
  const meta = vmByName[name] || {};
  if (cfg.poweredOnOnly && meta.power_state !== 'POWERED_ON' && name !== pfsenseVmName) continue;
  const row = blankRow(name, 'vm');
  row.power_state = meta.power_state || 'POWERED_OFF';
  row.cpu_count = meta.cpu_count;
  row.memory_gib = Math.round(((meta.memory_size_MiB || 0) / 1024) * 10) / 10;
  row.vm_id = meta.vm;
  row.macs = nics.map((n) => n.mac);
  row.nic_networks = nics.map((n) => n.network || '');
  row.nic_names = nics.map((n) => n.network || n.label || '');
  if (meta.vm) {
    const osRes = await httpRaw.call(this, 'GET', `${cfg.vcenterUrl}/api/vcenter/vm/${encodeURIComponent(meta.vm)}`, headers);
    if (osRes.status === 200 && osRes.body) {
      let guestOs = osRes.body.guest_OS;
      if (guestOs && typeof guestOs === 'object') guestOs = guestOs.default_message || guestOs.id;
      row.guest_os = guestOs ? String(guestOs) : null;
    }
  }
  const sources = ['vcenter'];
  for (const nic of nics) {
    for (const lease of (leasesByMac[nic.mac] || [])) {
      claimed.add(nic.mac);
      matchedLeases += 1;
      const ip = lease.ip;
      const length = parseInt(lease.prefixlen || 24, 10);
      if (!row.ips.includes(ip)) {
        row.ips.push(ip);
        row.addresses.push(`${ip}/${length}@${nic.mac}`);
      }
      if (lease.hostname && !row.hostname) row.hostname = lease.hostname;
      if (lease.description && !(row.notes || '').includes(lease.description)) {
        row.notes = [row.notes, lease.description].filter(Boolean).join('; ');
      }
      if (!sources.includes('pfsense')) sources.push('pfsense');
    }
  }
  if (name === pfsenseVmName) {
    const notes = [];
    for (const iface of interfaces) {
      if (iface.prefix) {
        let note = `pfSense ${iface.name} ${iface.iface || ''}`.trim();
        const pool = pools.find((item) => item.network === iface.name);
        if (pool && pool.pool) note += ` DHCP ${pool.pool}`;
        if (pool && pool.alias_names && pool.alias_names.length) note += ` aliases ${pool.alias_names.slice(0, 4).join(',')}`;
        notes.push(`${iface.prefix}=${note}`);
      }
      if (!iface.ipaddr) continue;
      const ip = iface.ipaddr;
      const length = parseInt(iface.prefixlen || 24, 10);
      const mac = matchIfaceMac(iface, nics);
      const label = String(iface.iface || '').trim();
      if (mac) {
        row.macs.forEach((nicMac, index) => {
          if (nicMac === mac && label) row.nic_names[index] = label;
        });
      } else if (label && !row.nic_names.includes(label)) {
        row.nic_names.push(label);
        row.macs.push('');
        row.nic_networks.push(iface.name || label);
      }
      const ref = mac || label.toLowerCase();
      if (!row.ips.includes(ip)) {
        row.ips.push(ip);
        row.addresses.push(ref ? `${ip}/${length}@${ref}` : `${ip}/${length}`);
      }
    }
    row.prefix_notes = notes.join('|');
    if (!sources.includes('pfsense')) sources.push('pfsense');
  }
  if (!row.hostname && meta.vm) {
    const ident = await httpRaw.call(this, 'GET', `${cfg.vcenterUrl}/api/vcenter/vm/${encodeURIComponent(meta.vm)}/guest/identity`, headers);
    if (ident.status === 200 && ident.body && ident.body.host_name) row.hostname = ident.body.host_name;
  }
  if (!row.ips.length && meta.vm) {
    const guest = await httpRaw.call(this, 'GET', `${cfg.vcenterUrl}/api/vcenter/vm/${encodeURIComponent(meta.vm)}/guest/networking/interfaces`, headers);
    if (guest.status === 200 && Array.isArray(guest.body)) {
      for (const nic of guest.body) {
        for (const ipx of ((nic.ip || {}).ip_addresses || [])) {
          const addr = ipx.ip_address;
          if (addr && !row.ips.includes(addr) && isInterestingIp(addr)) {
            const length = prefixlenForKnownIp(addr);
            row.ips.push(addr);
            row.addresses.push(`${addr}/${length}`);
          }
        }
      }
    }
  }
  Object.assign(row, ntopFields(row.ips));
  if (row.ntop_matched && !sources.includes('ntopng')) sources.push('ntopng');
  row.sources = sources.join('+');
  row.source = 'vmware';
  rows.push(row);
}

const usedNames = new Set(rows.map((r) => String(r.name || '').toLowerCase()));
for (const [mac, leases] of Object.entries(leasesByMac)) {
  if (claimed.has(mac)) continue;
  const lease = leases[0];
  const base = lease.hostname || lease.ip;
  let name = base;
  if (usedNames.has(String(name).toLowerCase())) name = `${base}-${mac.replace(/:/g, '').slice(-4)}`;
  usedNames.add(String(name).toLowerCase());
  const row = blankRow(name, 'physical');
  row.macs = [mac];
  row.hostname = lease.hostname || null;
  row.notes = leases.map((item) => item.description || '').filter(Boolean).join('; ');
  const sources = ['pfsense'];
  for (const item of leases) {
    const length = parseInt(item.prefixlen || 24, 10);
    if (!row.ips.includes(item.ip)) {
      row.ips.push(item.ip);
      row.addresses.push(`${item.ip}/${length}`);
    }
  }
  Object.assign(row, ntopFields(row.ips));
  if (row.ntop_matched) sources.push('ntopng');
  row.sources = sources.join('+');
  row.source = 'pfsense';
  rows.push(row);
}

return [{
  json: Object.assign({}, cfg, {
    rows,
    inventoryCount: rows.length,
    matchedLeases,
    step: 'joined-inventory',
  }),
}];
