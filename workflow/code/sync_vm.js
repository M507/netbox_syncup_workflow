const item = $input.first().json;
const row = item.asset;
const ctx = item.ctx;
const cfg = {
  netboxUrl: item.netboxUrl,
  netboxToken: item.netboxToken,
  dryRun: item.dryRun,
  _created: 0,
  _updated: 0,
};

const name = String(row.name || '').trim().slice(0, 64);
if (!name) {
  return [{ json: Object.assign({}, item, { result: 'skip', isNew: false, error: 'empty name', created: 0, updated: 0 }) }];
}

try {
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

  const byMac = {};
  macs.forEach((mac, i) => { if (mac && ifaces[i]) byMac[mac] = ifaces[i]; });
  const byName = {};
  for (const iface of ifaces) byName[String(iface.name || '').toLowerCase()] = iface;
  const assigned = {};
  for (const [ip, length, ref] of addresses) {
    let target = (ref && ref.includes(':')) ? byMac[ref] : null;
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

  return [{ json: Object.assign({}, item, { result: 'ok', assetType: 'vm', name, isNew, error: '', created: cfg._created, updated: cfg._updated }) }];
} catch (err) {
  return [{ json: Object.assign({}, item, { result: 'error', assetType: 'vm', name, isNew: false, error: String(err.message || err), created: cfg._created, updated: cfg._updated }) }];
}
