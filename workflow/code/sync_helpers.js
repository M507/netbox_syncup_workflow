function parseIps(value) {
  if (!value) return [];
  return String(value).split(';').map((p) => p.trim()).filter(Boolean);
}

function primaryIp(row) {
  const ips = parseIps(row.ips_primary) || parseIps(row.ips);
  // Comma-separated list from PRIMARY_IP_CIDR; earlier subnets have priority.
  const cidrs = '{{ENV:PRIMARY_IP_CIDR}}'.split(',').map((c) => c.trim()).filter(Boolean);
  for (const cidr of cidrs) {
    for (const ip of ips) {
      if (ipInCidr(ip, cidr)) return ip;
    }
  }
  const ntop = String(row.ntop_ip || '').trim();
  if (ntop && ips.includes(ntop)) return ntop;
  if (ntop) return ntop;
  for (const ip of ips) {
    if (!isInterestingIp(ip)) continue;
    return ip;
  }
  return ips[0] || null;
}

function parseAddresses(row) {
  const raw = row.addresses || '';
  if (!raw) {
    const ip = primaryIp(row);
    return ip ? [[ip, 24, '']] : [];
  }
  const parsed = [];
  for (let part of raw.split(';')) {
    part = part.trim();
    if (!part) continue;
    let mac = '';
    if (part.includes('@')) {
      const bits = part.split('@');
      mac = bits.pop().trim().toLowerCase();
      part = bits.join('@');
    }
    if (part.includes('/')) {
      const [ip, length] = part.split('/');
      parsed.push([ip, parseInt(length, 10), mac]);
    } else parsed.push([part, 24, mac]);
  }
  return parsed;
}

function rowMacs(row) {
  return String(row.macs || '').split(';').map((p) => p.trim().toLowerCase()).filter(Boolean);
}

function rowBlob(row) {
  return ['name', 'hostname', 'notes', 'ntop_name', 'ntop_device'].map((k) => row[k] || '').join(' ').toLowerCase();
}

function roleFor(row) {
  const name = String(row.name || '').toLowerCase();
  const blob = rowBlob(row);
  if (blob.includes('synology') || name.endsWith('nas') || String(row.ntop_device || '').toLowerCase() === 'nas') return 'storage';
  if (blob.includes('archer') || blob.includes('access point') || blob.includes('wifi') || blob.includes('wi-fi')) return 'access-point';
  if (name.includes('pfsense') || name.includes('gateway') || name.startsWith('gw.') || name.endsWith('.254')) return 'gateway';
  const dev = String(row.ntop_device || '').toLowerCase();
  if (['phone', 'laptop', 'tablet', 'workstation', 'tv'].includes(dev)) return 'workstation';
  if (['windows', 'macbook', 'macos', 'iphone', 'watch', 'air', 'laptop'].some((x) => blob.includes(x))) return 'workstation';
  if (row.asset_type === 'physical' && /^\d+\.\d+\.\d+\.\d+$/.test(row.name || '')) return 'unknown';
  return 'server';
}

function deviceTypeFor(row) {
  const blob = rowBlob(row);
  if (blob.includes('synology') || blob.trim().endsWith('nas')) return 'synology-nas';
  if (blob.includes('archer')) return 'tp-link-archer';
  if (blob.includes('iphone')) return 'apple-iphone';
  if (blob.includes('macbook') || blob.includes('macos')) return 'apple-macbook';
  if (roleFor(row) === 'workstation') return 'generic-workstation';
  if (roleFor(row) === 'access-point') return 'tp-link-archer';
  return 'unspecified';
}

function vmStatus(power) { return power === 'POWERED_ON' ? 'active' : 'offline'; }

function validDns(name) {
  if (!name || name.includes('_') || name.includes(' ') || name.length > 253) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) return null;
  if (/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(name)) return name;
  return null;
}

function ntopNotes(row) {
  let items;
  try { items = row.ntop_json ? JSON.parse(row.ntop_json) : []; } catch (e) { return ''; }
  if (items && !Array.isArray(items) && typeof items === 'object') items = [items];
  if (!Array.isArray(items)) return '';
  const blocks = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const names = item.names || {};
    const nameBits = Object.entries(names).map(([k, v]) => `${k}=${v}`).join(', ');
    const protoBits = (item.protocols || []).map((p) => {
      const breed = p.breed && p.breed !== 'Acceptable' ? ` ${p.breed}` : '';
      return `${p.name} ${fmtBytes(p.bytes || 0)}${breed}`;
    }).join(', ');
    const catBits = (item.categories || []).map((c) => `${c.name} ${fmtBytes(c.bytes || 0)}`).join(', ');
    const lines = [
      `ntopng ${item.ip || '-'} (${item.name || '-'})`,
      `MAC ${item.mac || '-'}  OS ${item.os || '-'}  device ${item.device_type || '-'}`,
    ];
    if (nameBits) lines.push(`names: ${nameBits}`);
    if (item.first_seen || item.last_seen || item.duration) {
      lines.push(`seen ${item.first_seen || '-'} -> ${item.last_seen || '-'}${item.duration ? ` (${item.duration})` : ''}`);
    }
    lines.push(`traffic sent ${fmtBytes(item.bytes_sent || 0)} rcvd ${fmtBytes(item.bytes_rcvd || 0)} (${fmtBytes(item.bytes_total || 0)})`);
    if (item.throughput_bps) lines.push(`throughput ${fmtBytes(item.throughput_bps || 0)}/s  ${item.throughput_pps || 0} pps`);
    lines.push(`flows client ${item.flows_client || 0} server ${item.flows_server || 0}  contacts client ${item.contacts_client || 0} server ${item.contacts_server || 0}`);
    lines.push(`score ${item.score || 0} (client ${item.score_client || 0} / server ${item.score_server || 0})  alerts ${item.alerts || 0} flow-alerts ${item.flow_alerts || 0}`);
    if (item.blacklisted || item.blacklisted_flows || item.crawler) {
      lines.push(`blacklisted=${Boolean(item.blacklisted)} blacklisted_flows=${item.blacklisted_flows || 0} crawler=${Boolean(item.crawler)}`);
    }
    if (item.country || item.asname) lines.push(`geo ${item.country || '-'} ${item.city || ''} asn ${item.asn || 0} ${item.asname || ''}`.trim());
    if (protoBits) lines.push(`protocols: ${protoBits}`);
    if (catBits) lines.push(`categories: ${catBits}`);
    if (item.ja3_count || item.hassh_count) lines.push(`JA3 ${item.ja3_count || 0}  HASSH ${item.hassh_count || 0}`);
    for (const [label, key] of [['JA3 malicious', 'ja3_malicious'], ['HASSH malicious', 'hassh_malicious']]) {
      const hits = item[key] || [];
      if (hits.length) {
        lines.push(`${label}: ${hits.map((h) => `${h.fingerprint} x${h.uses || 0} ${h.app || ''}`.trim()).join(', ')}`);
      }
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n').slice(0, 12000);
}

function ntopCustom(row) {
  try { return row.ntop_json ? JSON.parse(row.ntop_json) : null; } catch (e) { return null; }
}

async function ensurePlatform(cfg, ctx, name) {
  const raw = String(name || '').trim();
  if (!raw || ['unknown', 'os-0', 'other'].includes(raw.toLowerCase())) return null;
  const slug = slugify(raw.replace(/_/g, ' '));
  if (ctx.platforms[slug]) return ctx.platforms[slug];
  const [obj] = await nbGetOrCreate.call(this, cfg, 'dcim/platforms', { slug }, {
    name: raw.slice(0, 100), slug, description: 'From vCenter guest OS or ntopng',
  });
  ctx.platforms[slug] = obj.id;
  return obj.id;
}

async function ensurePrefixCidr(cfg, cidr, siteId, description) {
  const found = await nbFirst.call(this, cfg, 'ipam/prefixes', { prefix: cidr });
  const payload = { prefix: cidr, status: 'active', scope_type: 'dcim.site', scope_id: siteId, description: String(description).slice(0, 200) };
  if (!found) { await nbPost.call(this, cfg, '/api/ipam/prefixes/', payload); return; }
  if ((found.description || '') !== payload.description) {
    await nbPatch.call(this, cfg, `/api/ipam/prefixes/${found.id}/`, { description: payload.description });
  }
}

async function ensureNamedInterface(cfg, kind, parentId, name, mac, description) {
  let endpoint; let path; let parentField; let parentFilter;
  if (kind === 'vm') {
    endpoint = 'virtualization/interfaces'; path = '/api/virtualization/interfaces/';
    parentField = 'virtual_machine'; parentFilter = { virtual_machine_id: parentId };
  } else {
    endpoint = 'dcim/interfaces'; path = '/api/dcim/interfaces/';
    parentField = 'device'; parentFilter = { device_id: parentId };
  }
  let found = null;
  if (mac) found = await nbFirst.call(this, cfg, endpoint, Object.assign({ mac_address: mac }, parentFilter));
  if (!found) found = await nbFirst.call(this, cfg, endpoint, Object.assign({ name }, parentFilter));
  const payload = { [parentField]: parentId, name: String(name).slice(0, 64), description: String(description).slice(0, 200), enabled: true };
  if (kind === 'device') payload.type = '1000base-t';
  if (mac) payload.mac_address = mac;
  if (!found) return nbPost.call(this, cfg, path, payload);
  const patch = { description: String(description).slice(0, 200) };
  if (mac && String(found.mac_address || '').toLowerCase() !== mac.toLowerCase()) patch.mac_address = mac;
  const wanted = String(name).slice(0, 64);
  const current = found.name || '';
  if (wanted && wanted !== current && /^(vmx|ovpnc)\d+$/i.test(wanted)) patch.name = wanted;
  return nbPatch.call(this, cfg, `${path}${found.id}/`, patch);
}

/** Upsert VPN names (no peer IPs) as interfaces on the pfSense VM. */
async function syncPfsenseVpns(cfg, vpns) {
  if (!vpns || !vpns.length) return 0;
  let fw = await nbFirst.call(this, cfg, 'virtualization/virtual-machines', { name: '{{ENV:PFSENSE_VM_NAME}}' });
  if (!fw) {
    const data = await nbGet.call(this, cfg, '/api/virtualization/virtual-machines/?limit=200');
    for (const candidate of (data.results || [])) {
      if (/pfsense/i.test(candidate.name || '')) { fw = candidate; break; }
    }
  }
  if (!fw) return 0;
  let count = 0;
  for (const vpn of vpns) {
    const name = String(vpn.name || '').trim().slice(0, 64);
    if (!name) continue;
    const role = vpn.role || 'vpn';
    const tech = vpn.technology || 'vpn';
    const enabled = String(vpn.enabled || 'true').toLowerCase() !== 'false';
    const parts = [vpn.description || `${tech} ${role}`, `role=${role}`, `tech=${tech}`];
    if (vpn.iface) parts.push(`if=${vpn.iface}`);
    await ensureNamedInterface.call(this, cfg, 'vm', fw.id, name, '', parts.join('; ').slice(0, 200));
    const found = await nbFirst.call(this, cfg, 'virtualization/interfaces', {
      name, virtual_machine_id: fw.id,
    });
    if (found && found.enabled !== enabled) {
      await nbPatch.call(this, cfg, `/api/virtualization/interfaces/${found.id}/`, { enabled });
    }
    count += 1;
  }
  return count;
}

async function clearPrimaryIfNeeded(cfg, ipObj, targetType, targetId) {
  if (ipObj.assigned_object_type === targetType && ipObj.assigned_object_id === targetId) return;
  const ipId = ipObj.id;
  const device = await nbFirst.call(this, cfg, 'dcim/devices', { primary_ip4_id: ipId });
  if (device) await nbPatch.call(this, cfg, `/api/dcim/devices/${device.id}/`, { primary_ip4: null });
  const vm = await nbFirst.call(this, cfg, 'virtualization/virtual-machines', { primary_ip4_id: ipId });
  if (vm) await nbPatch.call(this, cfg, `/api/virtualization/virtual-machines/${vm.id}/`, { primary_ip4: null });
}

async function assignIp(cfg, ip, assignedType, assignedId, dnsName, description, prefixlen) {
  const existing = await nbFirst.call(this, cfg, 'ipam/ip-addresses', { address: ip });
  let length = prefixlen;
  if (length == null) {
    if (existing && String(existing.address || '').includes('/')) length = parseInt(existing.address.split('/')[1], 10);
    else length = 24;
  }
  const payload = {
    address: `${ip}/${length}`, status: 'active', description: String(description).slice(0, 200),
    assigned_object_type: assignedType, assigned_object_id: assignedId,
  };
  const dns = validDns(dnsName);
  if (dns) payload.dns_name = dns;
  if (!existing) return nbPost.call(this, cfg, '/api/ipam/ip-addresses/', payload);
  await clearPrimaryIfNeeded.call(this, cfg, existing, assignedType, assignedId);
  return nbPatch.call(this, cfg, `/api/ipam/ip-addresses/${existing.id}/`, payload);
}

function choosePrimaryObj(addresses, assigned, row) {
  const preferred = primaryIp(row);
  if (preferred && assigned[preferred]) return assigned[preferred];
  if (addresses.length) return assigned[addresses[0][0]] || null;
  return null;
}
