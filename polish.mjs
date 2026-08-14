import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

const OUT = path.resolve('generated');
const specPath = path.join(OUT, 'openapi.json');
const collectionPath = path.join(OUT, 'postman-collection.json');
const spec = JSON.parse(await fs.readFile(specPath, 'utf8'));
let collection = null;
try { collection = JSON.parse(await fs.readFile(collectionPath, 'utf8')); } catch {}

const secretNames = new Set(['key','token','api_key','apikey','api-key','authorization']);
const placeholder = 'YOUR_API_TOKEN';
const CANONICAL_API_ORIGIN = 'https://api.rocketlink.io';

function cleanHtml(s) {
  if (typeof s !== 'string' || !s.includes('<')) return s;
  return s
    .replace(/<h[1-6][^>]*>/gi, '\n## ')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '')
    .replace(/<p[^>]*>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function canonicalPath(p) {
  if (typeof p !== 'string' || !p) return p;
  if (p === '/api') return '/';
  return p.replace(/^\/api(?=\/)/i, '') || '/';
}

function canonicalizeEndpointString(s) {
  if (typeof s !== 'string') return s;

  let out = s
    .replace(/https?:\/\/app\.rocketlink\.io\/api(?=\/|\?|#|$)/gi, CANONICAL_API_ORIGIN)
    .replace(/https?:\/\/app\.rocketlink\.io(?=\/|\?|#|$)/gi, CANONICAL_API_ORIGIN)
    .replace(/\bapp\.rocketlink\.io\/api(?=\/|\?|#|$)/gi, 'api.rocketlink.io')
    .replace(/\bapp\.rocketlink\.io\b/gi, 'api.rocketlink.io');

  // If a full canonical API URL still contains a legacy /api prefix, remove it.
  out = out.replace(/(https?:\/\/api\.rocketlink\.io)\/api(?=\/|\?|#|$)/gi, '$1');
  return out;
}

function sanitizeString(s) {
  if (typeof s !== 'string') return s;
  return canonicalizeEndpointString(s)
    .replace(/([?&](?:key|token|api[_-]?key|apikey|authorization)=)[^&#\s"']+/gi, `$1${placeholder}`)
    .replace(/("(?:key|token|api_key|apikey|api-key|authorization)"\s*:\s*")[^"]+("\s*[,}])/gi, `$1${placeholder}$2`)
    .replace(/((?:Authorization|X-API-Key)\s*:\s*(?:Bearer\s+)?)[A-Za-z0-9._~+\/-]{12,}/gi, `$1${placeholder}`);
}

function scrubSpec(o) {
  if (Array.isArray(o)) return o.map(x => scrubSpec(x));
  if (!o || typeof o !== 'object') return typeof o === 'string' ? sanitizeString(o) : o;
  for (const [k,v] of Object.entries(o)) {
    const lk = k.toLowerCase();
    if (secretNames.has(lk) && (typeof v === 'string' || typeof v === 'number')) {
      o[k] = placeholder;
      continue;
    }
    if ((k === 'description' || k === 'summary') && typeof v === 'string') o[k] = cleanHtml(sanitizeString(v));
    else if (typeof v === 'string') o[k] = sanitizeString(v);
    else o[k] = scrubSpec(v);
  }
  return o;
}

function normalizeSpecEndpoints(s) {
  // The API host is canonical. The old app.rocketlink.io/api prefix was documentation error.
  s.servers = [{ url: CANONICAL_API_ORIGIN }];

  const normalizedPaths = {};
  for (const [oldPath, pathItem] of Object.entries(s.paths || {})) {
    const newPath = canonicalPath(oldPath);
    if (!normalizedPaths[newPath]) {
      normalizedPaths[newPath] = pathItem;
      continue;
    }

    // Merge in case both /api/v1/... and /v1/... existed in the legacy collection.
    normalizedPaths[newPath] = { ...normalizedPaths[newPath], ...pathItem };
  }
  s.paths = normalizedPaths;
  return s;
}

function normalizeCollectionRequestUrl(req) {
  if (!req?.url) return;

  if (typeof req.url === 'string') {
    req.url = canonicalizeEndpointString(req.url);
    return;
  }

  if (typeof req.url.raw === 'string') {
    req.url.raw = canonicalizeEndpointString(req.url.raw);
  }

  const host = req.url.host;
  if (Array.isArray(host) && host.join('.').toLowerCase() === 'app.rocketlink.io') {
    req.url.host = ['api', 'rocketlink', 'io'];
  } else if (typeof host === 'string' && host.toLowerCase() === 'app.rocketlink.io') {
    req.url.host = 'api.rocketlink.io';
  }

  if (Array.isArray(req.url.path) && String(req.url.path[0] || '').toLowerCase() === 'api') {
    req.url.path = req.url.path.slice(1);
  } else if (typeof req.url.path === 'string') {
    req.url.path = canonicalPath(req.url.path);
  }
}

function sanitizeCollection(o) {
  if (Array.isArray(o)) {
    for (const x of o) sanitizeCollection(x);
    return o;
  }
  if (!o || typeof o !== 'object') return o;

  // Postman represents parameters/auth entries as { key: "key", value: "secret" }.
  // Preserve the parameter name and redact only its value.
  if (typeof o.key === 'string' && secretNames.has(o.key.toLowerCase()) && 'value' in o) {
    o.value = placeholder;
  }

  for (const [k,v] of Object.entries(o)) {
    if (k === 'key' && typeof v === 'string') continue;
    if (typeof v === 'string') o[k] = sanitizeString(v);
    else sanitizeCollection(v);
  }
  return o;
}

function walkRequests(items, fn) {
  for (const item of items || []) {
    if (item?.item) walkRequests(item.item, fn);
    else if (item?.request?.method) fn(item);
  }
}

function rawUrl(req) {
  if (typeof req?.url === 'string') return req.url;
  return req?.url?.raw || '';
}

function requestPath(req) {
  const raw = canonicalizeEndpointString(rawUrl(req));
  try { return canonicalPath(new URL(raw).pathname || '/'); }
  catch { return canonicalPath(raw.split('?')[0].replace(/^https?:\/\/[^/]+/i, '') || '/'); }
}

normalizeSpecEndpoints(spec);

if (collection) {
  walkRequests(collection.item, item => normalizeCollectionRequestUrl(item.request));
}

// Recover query parameters before sanitizing the source collection so their names survive intact.
if (collection) {
  walkRequests(collection.item, item => {
    const req = item.request;
    const method = String(req.method).toLowerCase();
    const p = requestPath(req);
    const op = spec.paths?.[p]?.[method];
    if (!op) return;
    const raw = canonicalizeEndpointString(rawUrl(req));
    let url;
    try { url = new URL(raw); } catch { return; }
    const params = op.parameters || [];
    for (const [name, value] of url.searchParams.entries()) {
      if (params.some(x => x.in === 'query' && x.name === name)) continue;
      const isSecret = secretNames.has(name.toLowerCase());
      params.push({
        name,
        in: 'query',
        required: isSecret,
        schema: { type: 'string' },
        example: isSecret ? placeholder : value,
        ...(isSecret ? { description: 'RocketLink API token generated in the user API settings.' } : {})
      });
    }
    if (params.length) op.parameters = params;
  });
}

scrubSpec(spec);
if (collection) sanitizeCollection(collection);

function scalarHTML(s) {
  const embedded = JSON.stringify(s).replace(/<\/script/gi, '<\\/script');
  const title = String(s.info?.title || 'API').replace(/[<>&"]/g, '');
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${title} — API Reference</title>
  <style>
    html,body,#app{margin:0;width:100%;min-height:100%}
    #app{padding-bottom:34px;box-sizing:border-box}
    .wj-footer{
      position:fixed;
      left:0;
      right:0;
      bottom:0;
      z-index:9999;
      box-sizing:border-box;
      height:34px;
      display:flex;
      align-items:center;
      justify-content:center;
      gap:4px;
      font:12px/1.2 -apple-system,BlinkMacSystemFont,"SF Pro Text",Inter,system-ui,sans-serif;
      color:rgba(120,120,128,.95);
      background:color-mix(in srgb, Canvas 90%, transparent);
      border-top:1px solid rgba(128,128,128,.18);
      backdrop-filter:blur(14px);
      -webkit-backdrop-filter:blur(14px);
    }
    .wj-heart{color:#ff3b30;font-size:13px}
  </style>
</head>
<body>
  <div id="app"></div>
  <footer class="wj-footer">Made with <span class="wj-heart" aria-label="heart">♥</span> by Wojciech Jasnos</footer>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  <script>Scalar.createApiReference('#app',{content:${embedded},theme:'default',showSidebar:true,hideDownloadButton:false});</script>
</body>
</html>`;
}

await fs.writeFile(path.join(OUT, 'openapi.json'), JSON.stringify(spec, null, 2));
await fs.writeFile(path.join(OUT, 'openapi.yaml'), YAML.stringify(spec));
await fs.writeFile(path.join(OUT, 'index.html'), scalarHTML(spec));
if (collection) await fs.writeFile(collectionPath, JSON.stringify(collection, null, 2));
console.log(`Polished API docs: canonical endpoint ${CANONICAL_API_ORIGIN}, legacy /api prefix removed, HTML cleaned, query params recovered, secrets redacted, footer added.`);
