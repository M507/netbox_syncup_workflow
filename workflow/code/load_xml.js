const cfg = $input.first().json;
const staticData = $getWorkflowStaticData('global');
let xml = staticData.pfsenseXml || '';
if (!xml && $input.first().binary && $input.first().binary.data) {
  xml = Buffer.from($input.first().binary.data.data, 'base64').toString('utf8');
}
xml = String(xml || '').trim();
const ok = xml.length > 20 && (xml.startsWith('<?xml') || xml.startsWith('<pfsense'));
return [{
  json: Object.assign({}, cfg, {
    ok,
    error: ok ? '' : 'No stored pfSense XML. POST a redacted config to the webhook first.',
    xml,
    bytes: Buffer.byteLength(xml, 'utf8'),
  }),
}];
