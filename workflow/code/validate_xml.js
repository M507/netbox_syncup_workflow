const item = $input.first();
const headers = (item.json && item.json.headers) || {};
const headerMap = {};
for (const [k, v] of Object.entries(headers)) headerMap[String(k).toLowerCase()] = v;

const expected = '{{ENV:PFSENSE_WEBHOOK_TOKEN}}';
const got = headerMap['x-pfsense-token'] || headerMap['x-webhook-token'] || '';
if (expected && String(got) !== expected) {
  return [{ json: { ok: false, error: 'unauthorized webhook token', bytes: 0, xml: '' } }];
}

let xml = '';
if (item.binary && item.binary.data) {
  xml = Buffer.from(item.binary.data.data, 'base64').toString('utf8');
} else if (typeof item.json.body === 'string') {
  xml = item.json.body;
} else if (typeof item.json.data === 'string') {
  xml = item.json.data;
} else if (typeof item.json.xml === 'string') {
  xml = item.json.xml;
} else if (item.json.body && typeof item.json.body === 'object') {
  xml = JSON.stringify(item.json.body);
}

xml = String(xml || '').replace(/^\uFEFF/, '').trim();
const head = xml.slice(0, 64);
const looksXml = head.startsWith('<?xml') || head.startsWith('<pfsense');
const ok = xml.length > 20 && looksXml;
return [{
  json: {
    ok,
    error: ok ? '' : 'body is empty or not pfSense XML',
    bytes: Buffer.byteLength(xml, 'utf8'),
    receivedAt: new Date().toISOString(),
    xml,
  },
}];
