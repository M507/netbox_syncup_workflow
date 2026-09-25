const OS_NAMES = { 0: 'Unknown', 1: 'Linux', 2: 'Windows', 3: 'macOS', 4: 'iOS', 5: 'Android', 6: 'FreeBSD' };
const DEV_NAMES = {
  0: 'Unknown', 1: 'Printer', 2: 'Video', 3: 'Workstation', 4: 'Laptop', 5: 'Tablet',
  6: 'Phone', 7: 'TV', 8: 'Networking', 9: 'Wi-Fi', 10: 'NAS', 11: 'Multimedia', 12: 'IoT',
};

const cfg = $input.first().json;
const rows = cfg.rows || [];
const summaryByIp = cfg.ntopByIp || {};

function topNdpi(ndpi, limit) {
  if (!ndpi || typeof ndpi !== 'object') return [];
  const ranked = [];
  for (const [name, info] of Object.entries(ndpi)) {
    if (!info || typeof info !== 'object') continue;
    const total = Number(info['bytes.sent'] || 0) + Number(info['bytes.rcvd'] || 0);
    if (total <= 0 && !info.num_flows) continue;
    ranked.push({ name, bytes: Math.trunc(total), flows: parseInt(info.num_flows || 0, 10) || 0, breed: info.breed || '' });
  }
  ranked.sort((a, b) => b.bytes - a.bytes);
  return ranked.slice(0, limit || 8);
}

function topCategories(categories) {
  if (!categories || typeof categories !== 'object') return [];
  const ranked = [];
  for (const [name, info] of Object.entries(categories)) {
    if (!info || typeof info !== 'object') continue;
    const total = Number(info.bytes || 0);
    if (total <= 0) continue;
    ranked.push({ name, bytes: Math.trunc(total) });
  }
  ranked.sort((a, b) => b.bytes - a.bytes);
  return ranked;
}

function fingerprints(raw) {
  if (!raw || typeof raw !== 'object') return [0, []];
  const bad = [];
  for (const [fingerprint, info] of Object.entries(raw)) {
    if (!info || typeof info !== 'object' || !info.is_malicious) continue;
    bad.push({ fingerprint, uses: parseInt(info.num_uses || 0, 10) || 0, app: info.app_name || '' });
  }
  bad.sort((a, b) => b.uses - a.uses);
  return [Object.keys(raw).length, bad.slice(0, 8)];
}

const wanted = new Set();
for (const [ip, summary] of Object.entries(summaryByIp)) {
  if (summary.is_localhost && ip && !ip.includes(':') && isInterestingIp(ip)) wanted.add(ip);
}
for (const row of rows) {
  for (const ip of row.ips || []) {
    if (summaryByIp[ip] && !String(ip).includes(':')) wanted.add(ip);
  }
}

const byIp = {};
const byMac = {};
for (const ip of [...wanted].sort()) {
  const url = `${cfg.ntopngUrl}/lua/rest/v2/get/host/data.lua?ifid=${encodeURIComponent(cfg.ntopngIfid)}&host=${encodeURIComponent(ip)}`;
  let res;
  try {
    res = await httpRaw.call(this, 'GET', url, { Authorization: `Token ${cfg.ntopngToken}` });
  } catch (e) {
    continue;
  }
  const rsp = res.status === 200 && res.body && typeof res.body === 'object' ? res.body.rsp : null;
  if (!rsp || typeof rsp !== 'object' || !rsp.ip) continue;
  const summary = summaryByIp[ip] || {};
  let names = rsp.names && typeof rsp.names === 'object' ? rsp.names : {};
  names = Object.fromEntries(Object.entries(names).filter(([, v]) => v));
  let osId = rsp.os;
  if ((osId == null || osId === '' || osId === 0) && summary.os != null && summary.os !== '' && summary.os !== 0) osId = summary.os;
  const sent = Number(rsp['bytes.sent'] || summary.bytes_sent || 0);
  const rcvd = Number(rsp['bytes.rcvd'] || summary.bytes_rcvd || 0);
  let scoreTotal = summary.score;
  if (rsp.score && typeof rsp.score === 'object') scoreTotal = rsp.score.total || scoreTotal;
  else if (typeof rsp.score === 'number' && rsp.score) scoreTotal = rsp.score;
  const [ja3Count, ja3Bad] = fingerprints(rsp.ja3_fingerprint);
  const [hasshCount, hasshBad] = fingerprints(rsp.hassh_fingerprint);
  const detail = {
    ip: rsp.ip || ip,
    name: rsp.name || summary.ntop_name || '',
    names,
    mac: String(rsp.mac || '').toLowerCase(),
    os: OS_NAMES[parseInt(osId || 0, 10)] || `os-${osId}`,
    device_type: DEV_NAMES[parseInt(rsp.devtype || 0, 10)] || `device-${rsp.devtype}`,
    vlan: rsp.vlan != null && rsp.vlan !== '' ? rsp.vlan : (summary.vlan || 0),
    country: rsp.country || summary.country || '',
    city: rsp.city || '',
    asn: rsp.asn || 0,
    asname: rsp.asname || '',
    first_seen: fmtTs(summary.first_seen),
    last_seen: fmtTs(summary.last_seen),
    duration: fmtDuration(rsp.duration),
    bytes_sent: Math.trunc(sent),
    bytes_rcvd: Math.trunc(rcvd),
    bytes_total: Math.trunc(sent + rcvd),
    throughput_bps: summary.thpt_bps || 0,
    throughput_pps: summary.thpt_pps || 0,
    flows_client: asInt(rsp['flows.as_client'] || summary.flows_client),
    flows_server: asInt(rsp['flows.as_server'] || summary.flows_server),
    contacts_client: asInt(rsp['contacts.as_client']),
    contacts_server: asInt(rsp['contacts.as_server']),
    alerts: asInt(rsp.num_alerts || summary.alerts),
    flow_alerts: asInt(rsp.num_flow_alerts),
    score: asInt(scoreTotal),
    score_client: asInt(summary.score_client),
    score_server: asInt(summary.score_server),
    blacklisted: Boolean(rsp.is_blacklisted || summary.is_blacklisted),
    blacklisted_flows: asInt(rsp.num_blacklisted_flows),
    crawler: Boolean(rsp.crawlerBotScannerHost),
    protocols: topNdpi(rsp.ndpi),
    categories: topCategories(rsp.ndpi_categories),
    ja3_count: ja3Count,
    ja3_malicious: ja3Bad,
    hassh_count: hasshCount,
    hassh_malicious: hasshBad,
  };
  byIp[detail.ip] = detail;
  if (detail.mac) byMac[detail.mac] = byMac[detail.mac] || detail;
}

let enriched = 0;
for (const row of rows) {
  const matched = [];
  const seen = new Set();
  for (const ip of row.ips || []) {
    const detail = byIp[ip];
    if (detail && !seen.has(detail.ip)) { matched.push(detail); seen.add(detail.ip); }
  }
  for (const mac of row.macs || []) {
    const detail = byMac[String(mac || '').toLowerCase()];
    if (detail && !seen.has(detail.ip)) { matched.push(detail); seen.add(detail.ip); }
  }
  if (!matched.length) continue;
  enriched += 1;
  const primary = matched.reduce((a, b) => ((a.bytes_total || 0) >= (b.bytes_total || 0) ? a : b));
  const names = primary.names || {};
  row.ntop_matched = true;
  row.ntop_ip = primary.ip;
  row.ntop_name = primary.name || names.dhcp || names.resolved;
  row.ntop_bytes_human = fmtBytes(primary.bytes_total || 0);
  row.ntop_flows = (primary.flows_client || 0) + (primary.flows_server || 0);
  row.ntop_alerts = primary.alerts;
  row.ntop_score = primary.score;
  row.ntop_os = primary.os || '';
  row.ntop_device = primary.device_type || '';
  row.ntop_mac = primary.mac || '';
  row.ntop_protocols = (primary.protocols || []).slice(0, 4).map((p) => p.name).join(', ');
  row.ntop_json = JSON.stringify(matched);
  const sources = String(row.sources || '').split('+').filter(Boolean);
  if (!sources.includes('ntopng')) sources.push('ntopng');
  row.sources = sources.join('+');
}

return [{
  json: Object.assign({}, cfg, {
    rows,
    ntopDetailCount: wanted.size,
    ntopEnriched: enriched,
    step: 'ntopng-details',
  }),
}];
