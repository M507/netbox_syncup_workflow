const cfg = $('Load stored pfSense XML').first().json;
const page1 = $input.first().json;
const index = {};

function ingest(data) {
  const batch = ((data || {}).rsp || {}).data || [];
  for (const host of batch) {
    const ip = host.ip;
    if (!ip) continue;
    const bytesInfo = host.bytes || {};
    const flows = host.num_flows || {};
    const score = host.score || {};
    const thpt = host.thpt || {};
    index[ip] = {
      ntop_name: host.name,
      is_localhost: Boolean(host.is_localhost),
      is_blacklisted: Boolean(host.is_blacklisted),
      country: host.country || '',
      vlan: host.vlan || 0,
      os: host.os,
      first_seen: host.first_seen,
      last_seen: host.last_seen,
      bytes_total: Number(bytesInfo.total || 0),
      bytes_sent: Number(bytesInfo.sent || 0),
      bytes_rcvd: Number(bytesInfo.recvd || 0),
      flows: parseInt(flows.total || 0, 10) || 0,
      flows_client: parseInt(flows.as_client || 0, 10) || 0,
      flows_server: parseInt(flows.as_server || 0, 10) || 0,
      alerts: parseInt(host.num_alerts || 0, 10) || 0,
      score: parseInt(score.total || 0, 10) || 0,
      score_client: parseInt(score.as_client || 0, 10) || 0,
      score_server: parseInt(score.as_server || 0, 10) || 0,
      thpt_bps: Number(thpt.bps || 0),
      thpt_pps: Number(thpt.pps || 0),
    };
  }
  return ((data || {}).rsp || {}).data || [];
}

let batch = ingest(page1);
let page = 2;
while (batch.length >= 100 && page <= 50) {
  const url = `${cfg.ntopngUrl}/lua/rest/v2/get/host/active.lua?ifid=${encodeURIComponent(cfg.ntopngIfid)}&currentPage=${page}&perPage=100`;
  const res = await httpRaw.call(this, 'GET', url, { Authorization: `Token ${cfg.ntopngToken}` });
  if (res.status !== 200) break;
  batch = ingest(res.body);
  if (batch.length < 100) break;
  page += 1;
}

return [{
  json: Object.assign({}, cfg, {
    ntopByIp: index,
    ntopHostCount: Object.keys(index).length,
    ntopPages: page - 1,
    step: 'ntopng-index',
  }),
}];
