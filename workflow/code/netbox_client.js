function nbHeaders(cfg) {
  return { Authorization: `Bearer ${cfg.netboxToken}`, Accept: 'application/json' };
}

async function nbRequest(cfg, method, path, body) {
  const url = path.startsWith('http') ? path : `${cfg.netboxUrl}${path}`;
  if (cfg.dryRun && ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) {
    cfg._created = (cfg._created || 0) + (method === 'POST' ? 1 : 0);
    cfg._updated = (cfg._updated || 0) + (['PATCH', 'PUT'].includes(method) ? 1 : 0);
    const fake = Object.assign({ id: 900000 + (cfg._created || 0) + (cfg._updated || 0) }, body || {});
    if (fake.name) fake.display = fake.name;
    return fake;
  }
  const res = await httpRaw.call(this, method, url, nbHeaders(cfg), body);
  if (res.status >= 400) {
    throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(res.body).slice(0, 800)}`);
  }
  return res.body || {};
}

async function nbGet(cfg, path) { return nbRequest.call(this, cfg, 'GET', path); }
async function nbPost(cfg, path, body) {
  const obj = await nbRequest.call(this, cfg, 'POST', path, body);
  if (!cfg.dryRun) cfg._created = (cfg._created || 0) + 1;
  return obj;
}
async function nbPatch(cfg, path, body) {
  const obj = await nbRequest.call(this, cfg, 'PATCH', path, body);
  if (!cfg.dryRun) cfg._updated = (cfg._updated || 0) + 1;
  return obj;
}

async function nbFirst(cfg, path, params) {
  const parts = [];
  for (const [k, v] of Object.entries(params || {})) {
    if (v != null && v !== '') parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  parts.push('limit=1');
  const data = await nbGet.call(this, cfg, `/api/${path}/?${parts.join('&')}`);
  const results = (data && data.results) || [];
  return results[0] || null;
}

async function nbGetOrCreate(cfg, path, lookup, payload) {
  const found = await nbFirst.call(this, cfg, path, lookup);
  if (found) return [found, false];
  return [await nbPost.call(this, cfg, `/api/${path}/`, payload), true];
}

async function nbUpsert(cfg, path, lookup, payload, updateFields) {
  const found = await nbFirst.call(this, cfg, path, lookup);
  if (!found) return [await nbPost.call(this, cfg, `/api/${path}/`, payload), true];
  const patchBody = {};
  for (const k of updateFields) {
    if (k in payload) patchBody[k] = payload[k];
  }
  if (!Object.keys(patchBody).length) return [found, false];
  return [await nbPatch.call(this, cfg, `/api/${path}/${found.id}/`, patchBody), false];
}
