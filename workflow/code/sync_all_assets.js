const items = $input.all().map((i) => i.json);
const first = items[0] || {};
const ctx = first.ctx;
const cfgBase = {
  netboxUrl: first.netboxUrl,
  netboxToken: first.netboxToken,
  dryRun: first.dryRun,
};

let newVms = 0;
let newPhys = 0;
let vms = 0;
let phys = 0;
let errors = 0;
let created = 0;
let updated = 0;
let vpnCount = 0;
const errorNames = [];
const results = [];

// Once per run: ingest VPN names (no peer IPs) onto the pfSense VM
try {
  const vpnCfg = Object.assign({}, cfgBase, { _created: 0, _updated: 0 });
  vpnCount = await syncPfsenseVpns.call(this, vpnCfg, first.vpns || []);
  created += vpnCfg._created || 0;
  updated += vpnCfg._updated || 0;
} catch (err) {
  errors += 1;
  errorNames.push(`vpn-sync:${err.message || err}`);
}

for (const item of items) {
  const row = item.asset || {};
  const type = String(row.asset_type || '').toLowerCase();
  const cfg = Object.assign({}, cfgBase, { _created: 0, _updated: 0 });
  const payload = {
    asset: row,
    assetIndex: item.assetIndex,
    assetTotal: item.assetTotal,
    ctx: item.ctx || ctx,
    dryRun: item.dryRun,
    netboxUrl: item.netboxUrl,
    netboxToken: item.netboxToken,
    prefixNotes: item.prefixNotes || row.prefix_notes || '',
  };

  // Reuse the same helpers by temporarily setting $json-like input via call pattern.
  // Inline dispatch:
  let out;
  try {
    if (type === 'vm') {
      // emulate sync_vm input
      const fakeItems = [{ json: payload }];
      // Direct call of sync logic through duplicated minimal wrapper:
      out = await syncOneVm.call(this, payload, cfg);
      vms += 1;
      if (out.isNew) newVms += 1;
    } else if (type === 'physical') {
      out = await syncOnePhysical.call(this, payload, cfg);
      phys += 1;
      if (out.isNew) newPhys += 1;
    } else {
      out = { result: 'skip', name: row.name || '', error: `unknown asset_type=${type}`, isNew: false, created: 0, updated: 0, assetType: type };
    }
  } catch (err) {
    out = {
      result: 'error',
      name: row.name || '',
      error: String(err.message || err),
      isNew: false,
      created: cfg._created || 0,
      updated: cfg._updated || 0,
      assetType: type || 'unknown',
    };
  }

  created += out.created || 0;
  updated += out.updated || 0;
  if (out.result === 'error') {
    errors += 1;
    errorNames.push(out.name || '?');
  }
  results.push(out);
}

return [{
  json: {
    ok: errors === 0,
    startedAt: first.startedAt,
    finishedAt: new Date().toISOString(),
    inventoryCount: first.inventoryCount || items.length,
    ntopHostCount: first.ntopHostCount || 0,
    vcenterVmCount: first.vcenterVmCount || 0,
    pfsenseLeases: first.pfsenseLeases || 0,
    pfsenseVpns: first.pfsenseVpns || (first.vpns || []).length,
    vpnInterfacesSynced: vpnCount,
    refreshedVms: vms - newVms,
    newVms,
    refreshedPhysical: phys - newPhys,
    newPhysical: newPhys,
    errors,
    errorNames: errorNames.slice(0, 20),
    apiCreated: created,
    apiUpdated: updated,
    dryRun: Boolean(first.dryRun),
    processed: results.length,
  },
}];

async function syncOneVm(item, cfg) {
  const row = item.asset;
  const ctx = item.ctx;
  const name = String(row.name || '').trim().slice(0, 64);
  if (!name) return { result: 'skip', assetType: 'vm', name: '', isNew: false, error: 'empty name', created: 0, updated: 0 };

  for (const note of String(item.prefixNotes || '').split('|')) {
    if (!note.includes('=')) continue;
    const idx = note.indexOf('=');
    await ensurePrefixCidr.call(this, cfg, note.slice(0, idx), ctx.site_id, note.slice(idx + 1));
  }

  const power = row.power_state || 'POWERED_OFF';
  const sources = row.sources || 'vcenter';
  const tags = [];
  if (sources.includes('vcenter') || sources.includes('vmware')) tags.push(ctx.tags['source-vmware']);
  if (sources.includes('pfsense')) tags.push(ctx.tags['source-pfsense']);
  if (parseBool(row.ntop_matched) || sources.includes('ntopng')) tags.push(ctx.tags['source-ntopng']);
  tags.push(power === 'POWERED_ON' ? ctx.tags['powered-on'] : ctx.tags['powered-off']);

  let memoryMb = null;
  if (row.memory_gib) {
    const n = parseFloat(row.memory_gib);
    if (!Number.isNaN(n)) memoryMb = Math.trunc(n * 1024);
  }
  let vcpus = null;
  if (row.cpu_count) {
    const n = parseFloat(row.cpu_count);
    if (!Number.isNaN(n)) vcpus = Math.trunc(n);
  }

  const descParts = [];
  if (row.guest_os) descParts.push(row.guest_os);
  if (row.ntop_os && row.ntop_os !== 'Unknown') descParts.push(row.ntop_os);
  if (row.ntop_device && row.ntop_device !== 'Unknown') descParts.push(row.ntop_device);
  if (row.ntop_bytes_human) descParts.push(`ntop ${row.ntop_bytes_human}`);
  if (row.ntop_protocols) descParts.push(row.ntop_protocols);

  const notes = ntopNotes(row);
  let comments = `Synced from pfSense and vCenter${notes ? ' with ntopng.' : '.'}\nvCenter id: ${row.vm_id || '-'}\nhostname: ${row.hostname || '-'}`;
  if (row.notes) comments += `\npfSense: ${row.notes}`;
  if (notes) comments = `${comments}\n\n${notes}`;
  comments = comments.slice(0, 12000);

  const platformId = await ensurePlatform.call(this, cfg, ctx, row.guest_os || (row.ntop_os !== 'Unknown' ? row.ntop_os : ''));
  const payload = {
    name, status: vmStatus(power), site: ctx.site_id, cluster: ctx.cluster_id,
    role: ctx.role_ids['virtual-machine'], vcpus, memory: memoryMb,
    description: descParts.join('; ').slice(0, 200), comments, tags,
  };
  if (platformId) payload.platform = platformId;
  const custom = ntopCustom(row);
  if (custom != null) payload.custom_fields = { ntopng: custom };
  for (const k of Object.keys(payload)) if (payload[k] == null) delete payload[k];

  const [vm, isNew] = await nbUpsert.call(
    this, cfg, 'virtualization/virtual-machines', { name }, payload,
    ['status', 'site', 'cluster', 'role', 'vcpus', 'memory', 'description', 'comments', 'tags', 'custom_fields', 'platform'],
  );

  const macs = rowMacs(row);
  const networks = String(row.nic_networks || '').split(';').map((p) => p.trim());
  const nicNames = String(row.nic_names || '').split(';').map((p) => p.trim());
  const addresses = parseAddresses(row);
  const ifaces = [];
  const usedNames = new Set();
  const nicCount = Math.max(macs.length, 1);
  for (let index = 0; index < nicCount; index++) {
    let ifaceName = (index < nicNames.length && nicNames[index]) ? nicNames[index]
      : (index === 0 ? 'eth0' : (networks[index] || `nic${index}`));
    ifaceName = ifaceName.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || `nic${index}`;
    const base = ifaceName;
    let suffix = 2;
    while (usedNames.has(ifaceName.toLowerCase())) {
      ifaceName = `${base}-${suffix}`.slice(0, 64);
      suffix += 1;
    }
    usedNames.add(ifaceName.toLowerCase());
    const mac = index < macs.length ? macs[index] : '';
    const netLabel = index < networks.length ? networks[index] : '';
    const desc = (ifaceName.startsWith('vmx') || ifaceName.startsWith('ovpnc'))
      ? `pfSense ${ifaceName}${netLabel ? ` (${netLabel})` : ''}`
      : (mac ? `vCenter ${netLabel}`.trim() : 'Primary guest interface');
    ifaces.push(await ensureNamedInterface.call(this, cfg, 'vm', vm.id, ifaceName, mac, desc));
  }

  const byMacMap = {};
  macs.forEach((mac, i) => { if (mac && ifaces[i]) byMacMap[mac] = ifaces[i]; });
  const byName = {};
  for (const iface of ifaces) byName[String(iface.name || '').toLowerCase()] = iface;
  const assigned = {};
  for (const [ip, length, ref] of addresses) {
    let target = (ref && ref.includes(':')) ? byMacMap[ref] : null;
    if (!target && ref) target = byName[ref.toLowerCase()];
    if (!target && ref && /^(vmx|ovpnc)\d+$/i.test(ref)) {
      target = await ensureNamedInterface.call(this, cfg, 'vm', vm.id, ref, '', `pfSense ${ref}`);
      byName[ref.toLowerCase()] = target;
      ifaces.push(target);
    }
    target = target || ifaces[0];
    const rec = prefixFromIpBits(ip, length);
    if (rec.prefix && !(await nbFirst.call(this, cfg, 'ipam/prefixes', { prefix: rec.prefix }))) {
      await nbPost.call(this, cfg, '/api/ipam/prefixes/', {
        prefix: rec.prefix, status: 'active', scope_type: 'dcim.site', scope_id: ctx.site_id,
        description: 'From joined pfSense/vCenter inventory',
      });
    }
    let ipDesc = `${name} (${row.ntop_name || row.sources || 'inventory'})`;
    if (row.notes) ipDesc = `${ipDesc}; ${row.notes}`.slice(0, 200);
    assigned[ip] = await assignIp.call(this, cfg, ip, 'virtualization.vminterface', target.id, row.hostname || row.ntop_name || name, ipDesc, length);
  }
  const primary = choosePrimaryObj(addresses, assigned, row);
  if (primary && ((vm.primary_ip4 || {}).id) !== primary.id) {
    await nbPatch.call(this, cfg, `/api/virtualization/virtual-machines/${vm.id}/`, { primary_ip4: primary.id });
  }
  return { result: 'ok', assetType: 'vm', name, isNew, error: '', created: cfg._created, updated: cfg._updated };
}

async function syncOnePhysical(item, cfg) {
  const row = item.asset;
  const ctx = item.ctx;
  const name = String(row.name || row.ntop_name || row.ntop_ip || '').trim().slice(0, 64);
  if (!name) return { result: 'skip', assetType: 'physical', name: '', isNew: false, error: 'empty name', created: 0, updated: 0 };

  const sources = row.sources || 'pfsense';
  const tags = [ctx.tags.physical];
  if (sources.includes('pfsense')) tags.push(ctx.tags['source-pfsense']);
  if (sources.includes('ntopng') || parseBool(row.ntop_matched)) tags.push(ctx.tags['source-ntopng']);
  const addresses = parseAddresses(row);
  const macs = rowMacs(row);

  let description = sources.includes('pfsense') ? 'pfSense DHCP host' : 'Physical host';
  if (row.ntop_os && row.ntop_os !== 'Unknown') description += `; ${row.ntop_os}`;
  if (row.ntop_device && row.ntop_device !== 'Unknown') description += `; ${row.ntop_device}`;
  if (row.ntop_bytes_human) description += `; ntop ${row.ntop_bytes_human}`;
  if (row.ntop_protocols) description += `; ${row.ntop_protocols}`;
  description = description.slice(0, 200);

  const notes = ntopNotes(row);
  let comments = `Synced from pfSense and vCenter (${row.sources || '-'}).\nMAC: ${macs.join(', ') || '-'}`;
  if (row.notes) comments += `\npfSense: ${row.notes}`;
  if (notes) comments = `${comments}\n\n${notes}`;
  comments = comments.slice(0, 12000);

  const typeSlug = deviceTypeFor(row);
  const roleSlug = roleFor(row);
  const payload = {
    name,
    device_type: ctx.device_types[typeSlug] || ctx.device_type_id,
    role: ctx.role_ids[roleSlug] || ctx.role_ids.unknown,
    site: ctx.site_id,
    status: 'active',
    description,
    comments,
    tags,
  };
  const custom = ntopCustom(row);
  if (custom != null) payload.custom_fields = { ntopng: custom };

  const [device, isNew] = await nbUpsert.call(
    this, cfg, 'dcim/devices', { name }, payload,
    ['device_type', 'role', 'site', 'status', 'description', 'comments', 'tags', 'custom_fields'],
  );

  const mac = macs[0] || row.ntop_mac || '';
  const iface = await ensureNamedInterface.call(this, cfg, 'device', device.id, 'eth0', mac, sources.includes('pfsense') ? 'pfSense DHCP' : 'LAN');
  const assigned = {};
  for (const [ip, length] of addresses) {
    const rec = prefixFromIpBits(ip, length);
    if (rec.prefix && !(await nbFirst.call(this, cfg, 'ipam/prefixes', { prefix: rec.prefix }))) {
      await nbPost.call(this, cfg, '/api/ipam/prefixes/', {
        prefix: rec.prefix, status: 'active', scope_type: 'dcim.site', scope_id: ctx.site_id,
        description: 'From joined pfSense/vCenter inventory',
      });
    }
    let ipDesc = `${name} (${row.sources || 'physical'})`;
    if (row.notes) ipDesc = `${ipDesc}; ${row.notes}`.slice(0, 200);
    assigned[ip] = await assignIp.call(this, cfg, ip, 'dcim.interface', iface.id, row.hostname || row.ntop_name || name, ipDesc, length);
  }
  const primary = choosePrimaryObj(addresses, assigned, row);
  if (primary && ((device.primary_ip4 || {}).id) !== primary.id) {
    await nbPatch.call(this, cfg, `/api/dcim/devices/${device.id}/`, { primary_ip4: primary.id });
  }
  return { result: 'ok', assetType: 'physical', name, isNew, error: '', created: cfg._created, updated: cfg._updated };
}
