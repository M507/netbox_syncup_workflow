const data = $input.first().json;
const xml = data.xml || '';
const staticData = $getWorkflowStaticData('global');
staticData.pfsenseXml = xml;
staticData.pfsenseReceivedAt = data.receivedAt || new Date().toISOString();
staticData.pfsenseBytes = data.bytes || Buffer.byteLength(xml, 'utf8');

const binary = await this.helpers.prepareBinaryData(
  Buffer.from(xml, 'utf8'),
  'pfsense-latest.xml',
  'application/xml',
);

return [{
  json: {
    ok: true,
    stored: true,
    bytes: staticData.pfsenseBytes,
    receivedAt: staticData.pfsenseReceivedAt,
    fileName: 'pfsense-latest.xml',
  },
  binary: { data: binary },
}];
