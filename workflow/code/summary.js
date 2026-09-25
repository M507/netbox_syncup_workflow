const items = $input.all().map((i) => i.json);
const results = items.filter((i) => i.result);
const source = results.length ? results : items;
let vms = 0;
let phys = 0;
let newVms = 0;
let newPhys = 0;
let errors = 0;
let created = 0;
let updated = 0;
const errorNames = [];
for (const row of source) {
  if (row.assetType === 'vm') {
    vms += 1;
    if (row.isNew) newVms += 1;
  } else if (row.assetType === 'physical') {
    phys += 1;
    if (row.isNew) newPhys += 1;
  }
  if (row.result === 'error') {
    errors += 1;
    errorNames.push(row.name || '?');
  }
  created += row.created || 0;
  updated += row.updated || 0;
}
const first = items[0] || {};
return [{
  json: {
    ok: errors === 0,
    startedAt: first.startedAt,
    finishedAt: new Date().toISOString(),
    inventoryCount: first.inventoryCount || source.length,
    ntopHostCount: first.ntopHostCount || 0,
    vcenterVmCount: first.vcenterVmCount || 0,
    pfsenseLeases: first.pfsenseLeases || 0,
    refreshedVms: vms - newVms,
    newVms,
    refreshedPhysical: phys - newPhys,
    newPhysical: newPhys,
    errors,
    errorNames: errorNames.slice(0, 20),
    apiCreated: created,
    apiUpdated: updated,
    dryRun: Boolean(first.dryRun),
  },
}];
