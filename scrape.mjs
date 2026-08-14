import { chromium } from 'playwright';
import YAML from 'yaml';
import fs from 'node:fs/promises';
import path from 'node:path';

const SOURCE_URL = process.env.SOURCE_URL || 'https://documenter.getpostman.com/view/3616447/SVn2PvjX';
const API_TITLE = process.env.API_TITLE || 'RocketLink API v1';
const OUT = path.resolve('generated');
await fs.mkdir(OUT, { recursive: true });

const safeJSON = s => { try { return JSON.parse(s); } catch { return null; } };
const description = v => typeof v === 'string' ? v : (v?.content || v?.description || '');

function walk(obj, fn, seen = new WeakSet()) {
  if (!obj || typeof obj !== 'object' || seen.has(obj)) return;
  seen.add(obj); fn(obj);
  for (const v of Array.isArray(obj) ? obj : Object.values(obj)) walk(v, fn, seen);
}

function requestCount(items) {
  let n = 0;
  const rec = xs => (xs || []).forEach(x => { if (x?.request?.method) n++; if (x?.item) rec(x.item); });
  rec(items); return n;
}

function findCollection(roots) {
  let best = null, score = 0;
  for (const root of roots) walk(root, o => {
    const n = requestCount(o?.item);
    const s = n ? n * 100 + (o?.info?.name ? 20 : 0) + (o?.info?.schema ? 10 : 0) : 0;
    if (s > score) { score = s; best = o; }
  });
  return best;
}

function schema(v) {
  if (v === null) return { type: ['null'] };
  if (Array.isArray(v)) return { type: 'array', ...(v.length ? { items: schema(v[0]) } : {}) };
  if (typeof v === 'string') return { type: 'string' };
  if (typeof v === 'boolean') return { type: 'boolean' };
  if (typeof v === 'number') return { type: Number.isInteger(v) ? 'integer' : 'number' };
  if (typeof v === 'object') return { type: 'object', properties: Object.fromEntries(Object.entries(v).map(([k,x]) => [k, schema(x)])) };
  return {};
}

function variables(collection) {
  return Object.fromEntries((collection?.variable || []).filter(v => v?.key).map(v => [v.key, v.value ?? v.initial ?? '']));
}

function subst(s, vars, asPath = false) {
  return String(s || '').replace(/\{\{([^}]+)\}\}/g, (_, k) => asPath ? `{${k.trim()}}` : (vars[k.trim()] || `{${k.trim()}}`));
}

function rawUrl(req, vars) {
  const u = req?.url;
  if (typeof u === 'string') return subst(u, vars);
  if (u?.raw) return subst(u.raw, vars);
  if (u && typeof u === 'object') {
    const host = Array.isArray(u.host) ? u.host.join('.') : (u.host || '');
    const p = Array.isArray(u.path) ? '/' + u.path.join('/') : (u.path || '');
    return subst(`${u.protocol ? u.protocol + '://' : ''}${host}${p}`, vars);
  }
  return '';
}

function normPath(p) {
  p = String(p || '/').replace(/\{\{([^}]+)\}\}/g, '{$1}').replace(/\/:([A-Za-z0-9_.-]+)/g, '/{$1}');
  if (!p.startsWith('/')) p = '/' + p;
  return p.replace(/\/+/g, '/') || '/';
}

function pathOf(req, vars) {
  if (Array.isArray(req?.url?.path)) return normPath('/' + req.url.path.map(x => subst(x, vars, true)).join('/'));
  const raw = rawUrl(req, vars);
  return normPath(raw.replace(/^https?:\/\/[^/]+/i, '').split('?')[0].split('#')[0] || '/');
}

function bodyOf(body) {
  if (!body) return null;
  if (body.mode === 'raw' && typeof body.raw === 'string') {
    const parsed = safeJSON(body.raw);
    const media = parsed !== null || body?.options?.raw?.language === 'json' ? 'application/json' : 'text/plain';
    return { content: { [media]: { schema: parsed !== null ? schema(parsed) : { type: 'string' }, example: parsed !== null ? parsed : body.raw } } };
  }
  if (body.mode === 'urlencoded') {
    const props = Object.fromEntries((body.urlencoded || []).filter(x => !x.disabled && x.key).map(x => [x.key, { type: 'string' }]));
    return { content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', properties: props } } } };
  }
  if (body.mode === 'formdata') {
    const props = Object.fromEntries((body.formdata || []).filter(x => !x.disabled && x.key).map(x => [x.key, x.type === 'file' ? { type: 'string', format: 'binary' } : { type: 'string' }]));
    return { content: { 'multipart/form-data': { schema: { type: 'object', properties: props } } };
  }
  return null;
}

function authOf(auth, components) {
  if (!auth?.type) return null;
  if (auth.type === 'bearer') { components.securitySchemes.bearerAuth ??= { type: 'http', scheme: 'bearer' }; return [{ bearerAuth: [] }]; }
  if (auth.type === 'basic') { components.securitySchemes.basicAuth ??= { type: 'http', scheme: 'basic' }; return [{ basicAuth: [] }]; }
  if (auth.type === 'apikey') {
    const arr = auth.apikey || [], get = k => arr.find(x => x?.key === k)?.value;
    components.securitySchemes.apiKeyAuth ??= { type: 'apiKey', in: get('in') === 'query' ? 'query' : 'header', name: get('key') || 'X-API-Key' };
    return [{ apiKeyAuth: [] }];
  }
  return null;
}

function toOpenAPI(collection) {
  const vars = variables(collection), components = { securitySchemes: {} }, servers = new Set();
  const spec = { openapi: '3.1.0', info: { title: collection?.info?.name || API_TITLE, version: '1.0.0', ...(description(collection?.info?.description) ? { description: description(collection.info.description) } : {}) }, paths: {}, components };

  const rec = (items, tags = [], inheritedAuth = collection?.auth) => (items || []).forEach(item => {
    if (item?.item) return rec(item.item, [...tags, item.name || 'Other'], item.auth || inheritedAuth);
    const req = item?.request; if (!req?.method) return;
    const method = req.method.toLowerCase(); if (!['get','post','put','patch','delete','head','options'].includes(method)) return;
    const p = pathOf(req, vars), raw = rawUrl(req, vars), host = raw.match(/^(https?:\/\/[^/]+)/i)?.[1]; if (host) servers.add(host);
    const op = { summary: item.name || `${req.method} ${p}`, responses: {} };
    const d = description(req.description) || description(item.description); if (d) op.description = d;
    if (tags.length) op.tags = [tags[0]];

    const params = [];
    for (const q of req?.url?.query || []) if (!q.disabled && q.key) params.push({ name: q.key, in: 'query', required: false, schema: { type: 'string' }, ...(q.value ? { example: q.value } : {}), ...(description(q.description) ? { description: description(q.description) } : {}) });
    for (const h of req?.header || []) if (!h.disabled && h.key && !/^(authorization|content-type|accept)$/i.test(h.key)) params.push({ name: h.key, in: 'header', required: false, schema: { type: 'string' }, ...(h.value ? { example: h.value } : {}) });
    for (const name of [...p.matchAll(/\{([^}]+)\}/g)].map(m => m[1])) if (!params.some(x => x.in === 'path' && x.name === name)) params.push({ name, in: 'path', required: true, schema: { type: 'string' } });
    if (params.length) op.parameters = params;

    const rb = bodyOf(req.body); if (rb) op.requestBody = rb;
    const security = authOf(req.auth || inheritedAuth, components); if (security) op.security = security;

    for (const r of item.response || []) {
      const code = String(r.code || 200), rr = { description: r.status || r.name || `HTTP ${code}` };
      if (r.body) { const parsed = safeJSON(r.body); rr.content = parsed !== null ? { 'application/json': { schema: schema(parsed), example: parsed } } : { 'text/plain': { schema: { type: 'string' }, example: r.body } }; }
      op.responses[code] = rr;
    }
    if (!Object.keys(op.responses).length) op.responses['200'] = { description: 'Successful response' };
    spec.paths[p] ??= {}; spec.paths[p][method] = op;
  });

  rec(collection?.item || []);
  if (servers.size) spec.servers = [...servers].map(url => ({ url }));
  if (!Object.keys(components.securitySchemes).length) delete spec.components;
  return spec;
}

async function domFallback(page) {
  const rows = await page.evaluate(() => {
    const methods = new Set(['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS']), out = [], seen = new Set();
    for (const el of document.querySelectorAll('body *')) {
      const method = (el.textContent || '').trim(); if (!methods.has(method)) continue;
      let p = el.parentElement;
      for (let depth = 0; p && depth < 7; depth++, p = p.parentElement) {
        const lines = (p.innerText || '').split('\n').map(x => x.trim()).filter(Boolean);
        const url = lines.find(x => /^https?:\/\//i.test(x) || /^\/[A-Za-z0-9_:{]/.test(x));
        if (url) { const k = method + ' ' + url; if (!seen.has(k)) { seen.add(k); out.push({ method, url, text: lines.slice(0,80).join('\n') }); } break; }
      }
    }
    return out;
  });
  const spec = { openapi: '3.1.0', info: { title: API_TITLE, version: '1.0.0', description: 'Recovered from rendered Postman Documenter DOM.' }, paths: {} }, servers = new Set();
  for (const r of rows) {
    const m = r.url.match(/^(https?:\/\/[^/]+)(\/.*)?$/i); if (m) servers.add(m[1]);
    const p = normPath((m ? m[2] : r.url).split('?')[0] || '/'), method = r.method.toLowerCase();
    spec.paths[p] ??= {}; spec.paths[p][method] = { summary: `${r.method} ${p}`, description: r.text.slice(0,5000), responses: { '200': { description: 'Response' } } };
  }
  if (servers.size) spec.servers = [...servers].map(url => ({ url }));
  return spec;
}

function scalarHTML(spec) {
  const data = JSON.stringify(spec).replace(/<\/script/gi, '<\\/script');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${spec.info.title} — API</title><style>html,body,#app{margin:0;min-height:100%;width:100%}</style></head><body><div id="app"></div><script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script><script>Scalar.createApiReference('#app',{content:${data},theme:'default',showSidebar:true,hideDownloadButton:false});</script></body></html>`;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
const roots = [], network = [];
page.on('response', async res => {
  try {
    const url = res.url(), ct = (res.headers()['content-type'] || '').toLowerCase();
    if (!/(postman|getpostman)/i.test(url)) return;
    network.push({ url, status: res.status(), contentType: ct });
    if (ct.includes('json') || /\/api\//i.test(url)) { const parsed = safeJSON(await res.text()); if (parsed) roots.push(parsed); }
  } catch {}
});

console.log('Opening', SOURCE_URL);
await page.goto(SOURCE_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
try { await page.waitForLoadState('networkidle', { timeout: 30000 }); } catch {}
for (let i=0;i<12;i++) { await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await page.waitForTimeout(300); }
for (const text of await page.evaluate(() => [...document.scripts].map(s => s.textContent || '').filter(x => x.trim().length > 20))) { const p = safeJSON(text.trim()); if (p) roots.push(p); }
await fs.writeFile(path.join(OUT,'page.txt'), await page.locator('body').innerText().catch(()=>''));
await fs.writeFile(path.join(OUT,'network.json'), JSON.stringify(network,null,2));
await page.screenshot({ path: path.join(OUT,'source-page.png'), fullPage: true }).catch(()=>{});

const collection = findCollection(roots);
const mode = collection ? 'structured-collection' : 'dom-fallback';
if (collection) await fs.writeFile(path.join(OUT,'postman-collection.json'), JSON.stringify(collection,null,2));
const spec = collection ? toOpenAPI(collection) : await domFallback(page);
await browser.close();

await fs.writeFile(path.join(OUT,'openapi.json'), JSON.stringify(spec,null,2));
await fs.writeFile(path.join(OUT,'openapi.yaml'), YAML.stringify(spec));
await fs.writeFile(path.join(OUT,'index.html'), scalarHTML(spec));
const operations = Object.values(spec.paths || {}).reduce((n,p) => n + Object.keys(p).filter(k => ['get','post','put','patch','delete','head','options'].includes(k)).length,0);
const report = { sourceUrl: SOURCE_URL, mode, paths: Object.keys(spec.paths || {}).length, operations, generatedAt: new Date().toISOString() };
await fs.writeFile(path.join(OUT,'report.json'), JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
if (!operations) process.exitCode = 2;
