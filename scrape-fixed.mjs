import { chromium } from 'playwright';
import YAML from 'yaml';
import fs from 'node:fs/promises';
import path from 'node:path';

const SOURCE_URL = process.env.SOURCE_URL || 'https://documenter.getpostman.com/view/3616447/SVn2PvjX';
const API_TITLE = process.env.API_TITLE || 'RocketLink API v1';
const OUT = path.resolve('generated');
await fs.mkdir(OUT, { recursive: true });

const parseJSON = s => { try { return JSON.parse(s); } catch { return null; } };
const desc = v => typeof v === 'string' ? v : (v?.content || v?.description || '');

function walk(o, fn, seen = new WeakSet()) {
  if (!o || typeof o !== 'object' || seen.has(o)) return;
  seen.add(o); fn(o);
  for (const v of Array.isArray(o) ? o : Object.values(o)) walk(v, fn, seen);
}

function countRequests(items) {
  let n = 0;
  const rec = xs => (xs || []).forEach(x => { if (x?.request?.method) n++; rec(x?.item); });
  rec(items); return n;
}

function bestCollection(roots) {
  let best = null, bestScore = 0;
  for (const root of roots) walk(root, o => {
    const n = countRequests(o?.item);
    const score = n ? n * 100 + (o?.info?.name ? 20 : 0) : 0;
    if (score > bestScore) { best = o; bestScore = score; }
  });
  return best;
}

function infer(v) {
  if (v === null) return { type: ['null'] };
  if (Array.isArray(v)) return { type: 'array', ...(v.length ? { items: infer(v[0]) } : {}) };
  if (typeof v === 'object') return { type: 'object', properties: Object.fromEntries(Object.entries(v).map(([k,x]) => [k, infer(x)])) };
  if (typeof v === 'number') return { type: Number.isInteger(v) ? 'integer' : 'number' };
  if (typeof v === 'boolean') return { type: 'boolean' };
  return { type: 'string' };
}

function varsOf(c) {
  return Object.fromEntries((c?.variable || []).filter(v => v?.key).map(v => [v.key, v.value ?? v.initial ?? '']));
}

function substitute(s, vars, pathMode = false) {
  return String(s || '').replace(/\{\{([^}]+)\}\}/g, (_, k) => {
    const key = k.trim();
    return pathMode ? `{${key}}` : (vars[key] || `{${key}}`);
  });
}

function rawUrl(req, vars) {
  const u = req?.url;
  if (typeof u === 'string') return substitute(u, vars);
  if (u?.raw) return substitute(u.raw, vars);
  if (!u) return '';
  const host = Array.isArray(u.host) ? u.host.join('.') : (u.host || '');
  const p = Array.isArray(u.path) ? '/' + u.path.join('/') : (u.path || '');
  return substitute(`${u.protocol ? u.protocol + '://' : ''}${host}${p}`, vars);
}

function normalizePath(p) {
  let x = String(p || '/').replace(/\{\{([^}]+)\}\}/g, '{$1}').replace(/\/:([\w.-]+)/g, '/{$1}');
  if (!x.startsWith('/')) x = '/' + x;
  return x.replace(/\/+/g, '/') || '/';
}

function requestPath(req, vars) {
  if (Array.isArray(req?.url?.path)) return normalizePath('/' + req.url.path.map(x => substitute(x, vars, true)).join('/'));
  return normalizePath(rawUrl(req, vars).replace(/^https?:\/\/[^/]+/i, '').split('?')[0].split('#')[0] || '/');
}

function requestBody(body) {
  if (!body) return undefined;
  if (body.mode === 'raw' && typeof body.raw === 'string') {
    const parsed = parseJSON(body.raw);
    const json = parsed !== null || body?.options?.raw?.language === 'json';
    const media = json ? 'application/json' : 'text/plain';
    const example = parsed !== null ? parsed : body.raw;
    return { content: { [media]: { schema: parsed !== null ? infer(parsed) : { type: 'string' }, example } } };
  }
  if (body.mode === 'urlencoded') {
    const properties = {};
    for (const x of body.urlencoded || []) if (!x.disabled && x.key) properties[x.key] = { type: 'string' };
    return { content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', properties } } } };
  }
  if (body.mode === 'formdata') {
    const properties = {};
    for (const x of body.formdata || []) if (!x.disabled && x.key) properties[x.key] = x.type === 'file' ? { type: 'string', format: 'binary' } : { type: 'string' };
    return { content: { 'multipart/form-data': { schema: { type: 'object', properties } } } };
  }
  return undefined;
}

function security(auth, components) {
  if (!auth?.type) return undefined;
  if (auth.type === 'bearer') {
    components.securitySchemes.bearerAuth ??= { type: 'http', scheme: 'bearer' };
    return [{ bearerAuth: [] }];
  }
  if (auth.type === 'basic') {
    components.securitySchemes.basicAuth ??= { type: 'http', scheme: 'basic' };
    return [{ basicAuth: [] }];
  }
  if (auth.type === 'apikey') {
    const a = auth.apikey || [];
    const get = k => a.find(x => x?.key === k)?.value;
    components.securitySchemes.apiKeyAuth ??= { type: 'apiKey', in: get('in') === 'query' ? 'query' : 'header', name: get('key') || 'X-API-Key' };
    return [{ apiKeyAuth: [] }];
  }
  return undefined;
}

function collectionToOpenAPI(c) {
  const vars = varsOf(c), servers = new Set(), components = { securitySchemes: {} };
  const spec = { openapi: '3.1.0', info: { title: c?.info?.name || API_TITLE, version: '1.0.0' }, paths: {}, components };
  if (desc(c?.info?.description)) spec.info.description = desc(c.info.description);

  const rec = (items, tags = [], inheritedAuth = c?.auth) => (items || []).forEach(item => {
    if (item?.item) return rec(item.item, [...tags, item.name || 'Other'], item.auth || inheritedAuth);
    const req = item?.request;
    if (!req?.method) return;
    const method = req.method.toLowerCase();
    if (!['get','post','put','patch','delete','head','options'].includes(method)) return;

    const p = requestPath(req, vars);
    const raw = rawUrl(req, vars);
    const origin = raw.match(/^(https?:\/\/[^/]+)/i)?.[1];
    if (origin) servers.add(origin);

    const op = { summary: item.name || `${req.method} ${p}`, responses: {} };
    const d = desc(req.description) || desc(item.description); if (d) op.description = d;
    if (tags.length) op.tags = [tags[0]];

    const params = [];
    for (const q of req?.url?.query || []) if (!q.disabled && q.key) params.push({ name: q.key, in: 'query', required: false, schema: { type: 'string' }, ...(q.value ? { example: q.value } : {}) });
    for (const h of req?.header || []) if (!h.disabled && h.key && !/^(authorization|content-type|accept)$/i.test(h.key)) params.push({ name: h.key, in: 'header', required: false, schema: { type: 'string' }, ...(h.value ? { example: h.value } : {}) });
    for (const name of [...p.matchAll(/\{([^}]+)\}/g)].map(m => m[1])) if (!params.some(x => x.in === 'path' && x.name === name)) params.push({ name, in: 'path', required: true, schema: { type: 'string' } });
    if (params.length) op.parameters = params;

    const rb = requestBody(req.body); if (rb) op.requestBody = rb;
    const sec = security(req.auth || inheritedAuth, components); if (sec) op.security = sec;

    for (const r of item.response || []) {
      const code = String(r.code || 200);
      const rr = { description: r.status || r.name || `HTTP ${code}` };
      if (r.body) {
        const parsed = parseJSON(r.body);
        rr.content = parsed !== null
          ? { 'application/json': { schema: infer(parsed), example: parsed } }
          : { 'text/plain': { schema: { type: 'string' }, example: r.body } };
      }
      op.responses[code] = rr;
    }
    if (!Object.keys(op.responses).length) op.responses['200'] = { description: 'Successful response' };
    spec.paths[p] ??= {};
    spec.paths[p][method] = op;
  });

  rec(c?.item || []);
  if (servers.size) spec.servers = [...servers].map(url => ({ url }));
  if (!Object.keys(components.securitySchemes).length) delete spec.components;
  return spec;
}

async function domToOpenAPI(page) {
  const endpoints = await page.evaluate(() => {
    const methods = new Set(['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS']);
    const out = [], seen = new Set();
    for (const el of document.querySelectorAll('body *')) {
      const method = (el.textContent || '').trim();
      if (!methods.has(method)) continue;
      let p = el.parentElement;
      for (let i = 0; p && i < 7; i++, p = p.parentElement) {
        const lines = (p.innerText || '').split('\n').map(x => x.trim()).filter(Boolean);
        const url = lines.find(x => /^https?:\/\//i.test(x) || /^\/[\w:{]/.test(x));
        if (!url) continue;
        const key = `${method} ${url}`;
        if (!seen.has(key)) { seen.add(key); out.push({ method, url, text: lines.slice(0, 100).join('\n') }); }
        break;
      }
    }
    return out;
  });

  const servers = new Set();
  const spec = { openapi: '3.1.0', info: { title: API_TITLE, version: '1.0.0', description: 'Recovered automatically from rendered Postman Documenter.' }, paths: {} };
  for (const e of endpoints) {
    const m = e.url.match(/^(https?:\/\/[^/]+)(\/.*)?$/i);
    if (m) servers.add(m[1]);
    const p = normalizePath((m ? m[2] : e.url).split('?')[0] || '/');
    spec.paths[p] ??= {};
    spec.paths[p][e.method.toLowerCase()] = { summary: `${e.method} ${p}`, description: e.text.slice(0, 6000), responses: { '200': { description: 'Response' } } };
  }
  if (servers.size) spec.servers = [...servers].map(url => ({ url }));
  return spec;
}

function scalarHTML(spec) {
  const embedded = JSON.stringify(spec).replace(/<\/script/gi, '<\\/script');
  const title = String(spec.info.title || API_TITLE).replace(/[<>&"]/g, '');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — API Reference</title><style>html,body,#app{margin:0;width:100%;min-height:100%}</style></head><body><div id="app"></div><script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script><script>Scalar.createApiReference('#app',{content:${embedded},theme:'default',showSidebar:true,hideDownloadButton:false});</script></body></html>`;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
const roots = [], network = [];
page.on('response', async r => {
  try {
    const url = r.url(), ct = (r.headers()['content-type'] || '').toLowerCase();
    if (!/(postman|getpostman)/i.test(url)) return;
    network.push({ url, status: r.status(), contentType: ct });
    if (ct.includes('json') || /\/api\//i.test(url)) { const v = parseJSON(await r.text()); if (v) roots.push(v); }
  } catch {}
});

console.log('Opening', SOURCE_URL);
await page.goto(SOURCE_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
try { await page.waitForLoadState('networkidle', { timeout: 30000 }); } catch {}
for (let i = 0; i < 12; i++) { await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await page.waitForTimeout(250); }
for (const t of await page.evaluate(() => [...document.scripts].map(s => s.textContent || ''))) { const v = parseJSON(t.trim()); if (v) roots.push(v); }

await fs.writeFile(path.join(OUT, 'page.txt'), await page.locator('body').innerText().catch(() => ''));
await fs.writeFile(path.join(OUT, 'network.json'), JSON.stringify(network, null, 2));
await page.screenshot({ path: path.join(OUT, 'source-page.png'), fullPage: true }).catch(() => {});

const collection = bestCollection(roots);
if (collection) await fs.writeFile(path.join(OUT, 'postman-collection.json'), JSON.stringify(collection, null, 2));
const spec = collection ? collectionToOpenAPI(collection) : await domToOpenAPI(page);
const mode = collection ? 'structured-collection' : 'dom-fallback';
await browser.close();

await fs.writeFile(path.join(OUT, 'openapi.json'), JSON.stringify(spec, null, 2));
await fs.writeFile(path.join(OUT, 'openapi.yaml'), YAML.stringify(spec));
await fs.writeFile(path.join(OUT, 'index.html'), scalarHTML(spec));
const operations = Object.values(spec.paths || {}).reduce((n, p) => n + Object.keys(p).filter(k => ['get','post','put','patch','delete','head','options'].includes(k)).length, 0);
const report = { sourceUrl: SOURCE_URL, mode, paths: Object.keys(spec.paths || {}).length, operations, generatedAt: new Date().toISOString() };
await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!operations) process.exitCode = 2;
