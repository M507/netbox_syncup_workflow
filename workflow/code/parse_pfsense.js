const cfg = $input.first().json;
const xml = cfg.xml || '';
const ifaceBlock = section(xml, 'interfaces');
const interfaces = [];
const ifaceByKey = {};
const ovpnIfaceLabel = {};
for (const child of namedChildren(ifaceBlock)) {
  const ip = textOf(child.body, 'ipaddr');
  const bits = textOf(child.body, 'subnet');
  let prefix = '';
  let prefixlen = 24;
  if (ip && ip !== 'dhcp' && /^\d+$/.test(bits)) {
    const rec = prefixFromIpBits(ip, bits);
    prefix = rec.prefix;
    prefixlen = rec.prefixlen;
  }
  const iff = textOf(child.body, 'if');
  const descr = (textOf(child.body, 'descr') || child.tag).trim();
  if (/^ovpn/i.test(iff) && descr) ovpnIfaceLabel[iff] = descr;
  const rec = {
    key: child.tag,
    name: descr,
    iface: iff,
    mac: textOf(child.body, 'spoofmac').toLowerCase(),
    alias: '',
    ipaddr: ip && ip !== 'dhcp' ? ip : '',
    prefix,
    prefixlen,
  };
  interfaces.push(rec);
  ifaceByKey[child.tag] = rec;
}

const ipAliases = {};
const netAliases = [];
for (const alias of namedChildren(section(xml, 'aliases'))) {
  if (alias.tag !== 'alias') continue;
  const kind = textOf(alias.body, 'type');
  const name = textOf(alias.body, 'name');
  const address = textOf(alias.body, 'address');
  if (kind === 'host') {
    for (const part of address.split(/\s+/)) {
      if (/^\d+\.\d+\.\d+\.\d+$/.test(part)) {
        (ipAliases[part] || (ipAliases[part] = [])).push(name);
      }
    }
  } else if (kind === 'network') {
    for (const part of address.split(/\s+/)) {
      if (part.includes('/')) netAliases.push([name, part]);
    }
  }
}

const pools = [];
for (const child of namedChildren(section(xml, 'dhcpd'))) {
  const meta = ifaceByKey[child.tag] || {};
  const rangeBody = section(child.body, 'range');
  let pool = '';
  if (rangeBody) {
    pool = `${textOf(rangeBody, 'from')} - ${textOf(rangeBody, 'to')}`.replace(/^ - | - $/g, '');
  }
  const leases = [];
  const staticRe = /<staticmap>([\s\S]*?)<\/staticmap>/g;
  let sm;
  while ((sm = staticRe.exec(child.body))) {
    const ip = textOf(sm[1], 'ipaddr');
    if (!ip) continue;
    const hostname = textOf(sm[1], 'hostname') || textOf(sm[1], 'cid');
    let descr = textOf(sm[1], 'descr');
    const aliases = ipAliases[ip] || [];
    if (aliases.length) {
      const extra = `alias ${aliases.slice(0, 6).join(',')}`;
      descr = descr ? `${descr}; ${extra}` : extra;
    }
    leases.push({
      mac: textOf(sm[1], 'mac').toLowerCase(),
      hostname,
      ip,
      description: descr,
      user: '',
    });
  }
  const prefix = meta.prefix || '';
  pools.push({
    source: 'pfsense-latest.xml',
    network: meta.name || child.tag,
    prefix,
    prefixlen: meta.prefixlen || 24,
    pool,
    leases,
    alias_names: netAliases.filter(([, cidr]) => cidr === prefix).map(([name]) => name),
  });
}

// VPN names only — never ingest peer/endpoint IPs
const vpns = [];
const openvpnBlock = section(xml, 'openvpn') || '';
for (const client of namedChildren(openvpnBlock)) {
  if (client.tag !== 'openvpn-client') continue;
  const vpnid = textOf(client.body, 'vpnid');
  let name = textOf(client.body, 'description').trim();
  if (!name) name = `OpenVPN-Client-${vpnid || 'unknown'}`;
  const iff = vpnid ? `ovpnc${vpnid}` : '';
  const label = ovpnIfaceLabel[iff] || '';
  const disabled = /<disable\s*\/>|<disable><\/disable>/.test(client.body);
  vpns.push({
    name,
    role: 'egress-client',
    technology: 'openvpn',
    iface: iff,
    iface_label: label,
    enabled: disabled ? 'false' : 'true',
    description: `OpenVPN egress client on pfSense${label ? ` (${label})` : ''}`,
  });
}
for (const server of namedChildren(openvpnBlock)) {
  if (server.tag !== 'openvpn-server') continue;
  const vpnid = textOf(server.body, 'vpnid');
  let name = textOf(server.body, 'description').trim();
  const iff = vpnid ? `ovpns${vpnid}` : 'ovpns1';
  const label = ovpnIfaceLabel[iff] || '';
  if (!name) name = (label && !/^OPT\d+$/i.test(label)) ? label : 'OpenVPN-Server';
  const disabled = /<disable\s*\/>|<disable><\/disable>/.test(server.body);
  vpns.push({
    name,
    role: 'inbound-server',
    technology: 'openvpn',
    iface: iff,
    iface_label: label,
    enabled: disabled ? 'false' : 'true',
    description: `OpenVPN inbound server on pfSense${label ? ` (${label})` : ''}`,
  });
}
const pkgBlock = section(xml, 'installedpackages') || '';
for (const pkg of namedChildren(pkgBlock)) {
  if (pkg.tag !== 'package') continue;
  if (textOf(pkg.body, 'name').trim().toLowerCase() === 'tailscale') {
    vpns.push({
      name: 'Tailscale',
      role: 'mesh',
      technology: 'tailscale',
      iface: '',
      iface_label: '',
      enabled: 'true',
      description: 'Tailscale mesh VPN package on pfSense',
    });
    break;
  }
}

return [{
  json: Object.assign({}, cfg, {
    xml: undefined,
    interfaces,
    pools,
    vpns,
    pfsenseInterfaces: interfaces.length,
    pfsenseLeases: pools.reduce((n, p) => n + p.leases.length, 0),
    pfsenseVpns: vpns.length,
    step: 'parsed-pfsense',
  }),
}];
