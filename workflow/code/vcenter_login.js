const cfg = $input.first().json;

const loginRes = await this.helpers.httpRequest({
  method: 'POST',
  url: `${cfg.vcenterUrl}/api/session`,
  headers: {
    Authorization: `Basic ${cfg.vcenterBasic}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  },
  body: {},
  skipSslCertificateValidation: true,
  timeout: 60000,
  ignoreHttpStatusErrors: true,
  returnFullResponse: true,
});

const status = loginRes.statusCode || loginRes.status || 0;
let raw = loginRes.body;
if (typeof raw === 'object' && raw !== null) {
  raw = raw.token || raw.value || raw.id || raw.data || JSON.stringify(raw);
}
let token = String(raw == null ? '' : raw).trim().replace(/^"+|"+$/g, '');

function looksLikeSessionId(t) {
  if (!t || t.length < 16 || t.length > 128) return false;
  if (/[<>\s]/.test(t) || /html|doctype|script/i.test(t)) return false;
  return /^[A-Za-z0-9._+-]+$/.test(t);
}

const ok = status >= 200 && status < 300 && looksLikeSessionId(token);

return [{
  json: Object.assign({}, cfg, {
    xml: undefined,
    vcenterToken: ok ? token : '',
    vcenterLoginOk: ok,
    vcenterLoginStatus: status,
    error: ok
      ? ''
      : `vCenter login failed (HTTP ${status}, token_len=${token.length}, head=${JSON.stringify(token.slice(0, 80))})`,
    step: 'vcenter-login',
  }),
}];
