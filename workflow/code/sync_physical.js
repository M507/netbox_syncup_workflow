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

const name = String(row.name || row.ntop_name || row.ntop_ip || '').trim().slice(0, 64);
if (!name) {
  return [{ json: Object.assign({}, item, { result: 'skip', isNew: false, error: 'empty name', created: 0, updated: 0 }) }];
}

try {
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

  return [{ json: Object.assign({}, item, { result: 'ok', assetType: 'physical', name, isNew, error: '', created: cfg._created, updated: cfg._updated }) }];
} catch (err) {
  return [{ json: Object.assign({}, item, { result: 'error', assetType: 'physical', name, isNew: false, error: String(err.message || err), created: cfg._created, updated: cfg._updated }) }];
}
