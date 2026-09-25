const cfg = $input.first().json;
const token = cfg.vcenterToken;
if (typeof token !== 'string' || !token) {
  throw new Error('vCenter session token missing after login');
}

const headers = { 'vmware-api-session-id': token, Accept: 'application/json' };

const listRes = await httpRaw.call(this, 'GET', `${cfg.vcenterUrl}/api/vcenter/vm`, headers);
if (listRes.status !== 200 || !Array.isArray(listRes.body)) {
  throw new Error(`vCenter VM list failed (HTTP ${listRes.status}): ${JSON.stringify(listRes.body).slice(0, 200)}`);
}
const vms = listRes.body;

const byMac = {};
const byVm = {};
const enriched = [];

for (let i = 0; i < vms.length; i++) {
  const vm = vms[i];
  const nicsRes = await httpRaw.call(this, 'GET', `${cfg.vcenterUrl}/api/vcenter/vm/${encodeURIComponent(vm.vm)}/hardware/ethernet`, headers);
  const nics = Array.isArray(nicsRes.body) ? nicsRes.body : [];
  const named = [];
  for (const nic of nics) {
    const nicId = nic && nic.nic;
    if (!nicId) continue;
    const detailRes = await httpRaw.call(this, 'GET', `${cfg.vcenterUrl}/api/vcenter/vm/${encodeURIComponent(vm.vm)}/hardware/ethernet/${encodeURIComponent(nicId)}`, headers);
    const detail = detailRes.body || {};
    const mac = String(detail.mac_address || '').toLowerCase();
    if (!mac) continue;
    const backing = detail.backing || {};
    const rec = {
      mac,
      label: detail.label || '',
      network: backing.network_name || '',
      nic: String(nicId),
      vm_name: vm.name || '',
      vm_id: vm.vm,
    };
    byMac[mac] = rec;
    named.push(rec);
  }
  byVm[vm.name || vm.vm] = named;
  enriched.push(vm);
}

try {
  await httpRaw.call(this, 'DELETE', `${cfg.vcenterUrl}/api/session`, headers);
} catch (e) {
  // ignore logout failures
}

return [{
  json: Object.assign({}, cfg, {
    vcenterToken: token,
    vcenterVms: enriched,
    vcenterByMac: byMac,
    vcenterByVm: byVm,
    vcenterVmCount: enriched.length,
    step: 'vcenter-nics',
  }),
}];
