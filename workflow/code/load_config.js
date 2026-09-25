const staticData = $getWorkflowStaticData('global');
const netboxUrl = '{{ENV:NETBOX_URL}}';
const ntopngUrl = '{{ENV:NTOPNG_URL}}';
const vcenterUrl = '{{ENV:VCENTER_URL}}';
const vcenterUser = '{{ENV:VCENTER_USER}}';
const vcenterPassword = '{{ENV:VCENTER_PASSWORD}}';
return [{
  json: {
    dryRun: {{ENVBOOL:DRY_RUN}},
    poweredOnOnly: {{ENVBOOL:POWERED_ON_ONLY}},
    netboxUrl,
    netboxToken: '{{ENV:NETBOX_TOKEN}}',
    ntopngUrl,
    ntopngToken: '{{ENV:NTOPNG_TOKEN}}',
    ntopngIfid: '{{ENV:NTOPNG_IFID}}',
    vcenterUrl,
    vcenterUser,
    vcenterPassword,
    vcenterBasic: Buffer.from(`${vcenterUser}:${vcenterPassword}`).toString('base64'),
    hasStoredXml: Boolean(staticData.pfsenseXml),
    pfsenseBytes: staticData.pfsenseBytes || 0,
    pfsenseReceivedAt: staticData.pfsenseReceivedAt || '',
    startedAt: new Date().toISOString(),
  },
}];
