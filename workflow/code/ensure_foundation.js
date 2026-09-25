const cfg = $('Fetch ntopng host details').first().json;
cfg._created = 0;
cfg._updated = 0;

const [site] = await nbGetOrCreate.call(this, cfg, 'dcim/sites', { slug: 'home' }, {
  name: 'Home', slug: 'home', status: 'active',
  description: 'Local network inventory synced from vCenter + ntopng',
});

const roles = {
  gateway: ['Gateway', '607d8b'],
  server: ['Server', '2196f3'],
  workstation: ['Workstation', '4caf50'],
  'access-point': ['Access Point', 'ff9800'],
  storage: ['Storage', '9c27b0'],
  unknown: ['Unknown', '9e9e9e'],
  'virtual-machine': ['Virtual Machine', '3f51b5'],
};
const roleIds = {};
for (const [slug, [label, color]] of Object.entries(roles)) {
  const [obj] = await nbGetOrCreate.call(this, cfg, 'dcim/device-roles', { slug }, {
    name: label, slug, color, vm_role: ['server', 'virtual-machine', 'unknown'].includes(slug),
  });
  roleIds[slug] = obj.id;
}

const manufacturers = {};
for (const [slug, label] of [['generic', 'Generic'], ['synology', 'Synology'], ['tp-link', 'TP-Link'], ['apple', 'Apple']]) {
  const [obj] = await nbGetOrCreate.call(this, cfg, 'dcim/manufacturers', { slug }, { name: label, slug });
  manufacturers[slug] = obj.id;
}

const deviceTypes = {};
const typeSpecs = [
  ['unspecified', 'generic', 'Unspecified', 'Placeholder type when hardware is unknown'],
  ['generic-workstation', 'generic', 'Workstation', 'Physical workstation from pfSense DHCP'],
  ['synology-nas', 'synology', 'NAS', 'Synology NAS from pfSense DHCP'],
  ['tp-link-archer', 'tp-link', 'Archer', 'TP-Link Archer AP/router from pfSense DHCP'],
  ['apple-iphone', 'apple', 'iPhone', 'Apple iPhone from pfSense DHCP'],
  ['apple-macbook', 'apple', 'MacBook', 'Apple Mac from pfSense DHCP'],
];
for (const [slug, manufacturer, model, desc] of typeSpecs) {
  const [obj] = await nbGetOrCreate.call(this, cfg, 'dcim/device-types', { slug }, {
    manufacturer: manufacturers[manufacturer], model, slug, description: desc,
  });
  deviceTypes[slug] = obj.id;
}

const [ctype] = await nbGetOrCreate.call(this, cfg, 'virtualization/cluster-types', { slug: 'vmware-vcenter' }, {
  name: 'VMware vCenter', slug: 'vmware-vcenter', description: 'Synced from vcenter.example.com',
});
const [cluster] = await nbGetOrCreate.call(this, cfg, 'virtualization/clusters', { name: 'Home vSphere' }, {
  name: 'Home vSphere', type: ctype.id, status: 'active',
  scope_type: 'dcim.site', scope_id: site.id, description: 'vCenter inventory cluster',
});

const tags = {};
const tagSpecs = {
  'source-vmware': ['source:vmware', '0057d8'],
  'source-ntopng': ['source:ntopng', '2e7d32'],
  'powered-on': ['powered-on', '43a047'],
  'powered-off': ['powered-off', '757575'],
  physical: ['physical', '6d4c41'],
  'source-pfsense': ['source:pfsense', 'c62828'],
};
for (const [slug, [label, color]] of Object.entries(tagSpecs)) {
  const [obj] = await nbGetOrCreate.call(this, cfg, 'extras/tags', { slug }, { name: label, slug, color });
  tags[slug] = obj.id;
}

await nbGetOrCreate.call(this, cfg, 'extras/custom-fields', { name: 'ntopng' }, {
  name: 'ntopng', label: 'ntopng', type: 'json',
  object_types: ['dcim.device', 'virtualization.virtualmachine'],
  description: 'Identity and traffic observed by ntopng. Not a source of new assets.',
  weight: 100,
});

const ctx = {
  site_id: site.id,
  role_ids: roleIds,
  device_type_id: deviceTypes.unspecified,
  device_types: deviceTypes,
  cluster_id: cluster.id,
  tags,
  platforms: {},
};

const assets = (cfg.rows || []).map((row) => flattenRow(row));
return assets.map((row, index) => ({
  json: {
    asset: row,
    assetIndex: index + 1,
    assetTotal: assets.length,
    ctx,
    dryRun: cfg.dryRun,
    netboxUrl: cfg.netboxUrl,
    netboxToken: cfg.netboxToken,
    prefixNotes: row.prefix_notes || '',
    startedAt: cfg.startedAt,
    inventoryCount: assets.length,
    ntopHostCount: cfg.ntopHostCount,
    vcenterVmCount: cfg.vcenterVmCount,
    pfsenseLeases: cfg.pfsenseLeases,
    pfsenseVpns: (cfg.vpns || []).length,
    vpns: cfg.vpns || [],
    _created: cfg._created || 0,
    _updated: cfg._updated || 0,
  },
}));
