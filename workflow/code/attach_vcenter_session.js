const cfg = $('Normalize ntopng hosts').first().json;
const login = $input.first().json;

function extractToken(raw) {
  if (raw == null) return '';
  // Text responseFormat often yields { data: '"abc..."' } or { data: 'abc' }
  if (typeof raw === 'string') return raw.replace(/^"+|"+$/g, '').trim();
  if (typeof raw !== 'object') return String(raw).trim();

  const candidates = [
    raw.token,
    raw.id,
    raw.value,
    typeof raw.data === 'string' ? raw.data : null,
    typeof raw.body === 'string' ? raw.body : null,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.replace(/^"+|"+$/g, '').trim();
  }
  const keys = Object.keys(raw);
  if (keys.length === 1 && typeof raw[keys[0]] === 'string') {
    return raw[keys[0]].replace(/^"+|"+$/g, '').trim();
  }
  return '';
}

function looksLikeSessionId(token) {
  if (!token || token.length < 16 || token.length > 128) return false;
  if (/[<>\s]/.test(token) || /html|doctype|script/i.test(token)) return false;
  return /^[A-Za-z0-9._+-]+$/.test(token);
}

const token = extractToken(login);
const ok = looksLikeSessionId(token);

return [{
  json: Object.assign({}, cfg, {
    xml: undefined,
    vcenterToken: ok ? token : '',
    vcenterLoginOk: ok,
    error: ok
      ? ''
      : `vCenter login did not return a session id (got ${token ? `len=${token.length} head=${JSON.stringify(token.slice(0, 60))}` : typeof login})`,
    step: 'vcenter-login',
  }),
}];
