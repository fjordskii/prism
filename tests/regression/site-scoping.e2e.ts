import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { chromium } from 'playwright';

const ADMIN = 'scope-admin-token';
const DEMO = 'scope-demo-token';
const SESSION = 'scope-session-secret';
const EDITOR = 'ada@shop.test';
const VIEWER = 'view@shop.test';
const OWNER = 'own@shop.test';
const SCOPED_RO = 'scoped-ro';

describe('regression: site scoping', { tags: ['regression'] }, () => {
  test('a site-A member is refused on site B, and the B row stays put', async () => {
    const server = await startServer({
      ADMIN_TOKEN: ADMIN,
      DEMO_TOKEN: DEMO,
      SESSION_SECRET: SESSION,
      HOLDOUT_PCT: '0',
      PRISM_PLAN: 'selfhost',
      GOOGLE_ALLOWED_EMAILS: `${EDITOR}:editor@sitea,${VIEWER}:viewer@sitea,${OWNER}:owner@sitea|sitez`,
      READONLY_TOKENS: `wide-ro,${SCOPED_RO}@sitea`,
    });
    try {
      const createdA = await call(server.url, '/api/variants', {
        method: 'POST',
        token: ADMIN,
        json: { site: 'sitea', name: 'Site A hero', selector: '#a', ops: '[]', audience: '[]' },
      });
      expect(createdA.status).toBe(201);
      const createdB = await call(server.url, '/api/variants', {
        method: 'POST',
        token: ADMIN,
        json: { site: 'siteb', name: 'Site B secret', selector: '#b', ops: '[]', audience: '[]' },
      });
      expect(createdB.status).toBe(201);
      const aId = idOf(createdA.body);
      const bId = idOf(createdB.body);
      const before = await readVariant(server.dbPath, bId);

      const editor = await mint(EDITOR);
      const viewer = await mint(VIEWER);
      const owner = await mint(OWNER);

      await expectDenied(server.url, editor, bId, 'cookie');
      await expectDenied(server.url, viewer, bId, 'cookie');
      await expectDenied(server.url, SCOPED_RO, bId, 'token');

      for (const cred of [
        { cookie: viewer },
        { token: SCOPED_RO },
      ]) {
        expect((await call(server.url, '/api/variants?site=sitea', cred)).status).toBe(200);
        expect((await call(server.url, '/api/stats?site=sitea', cred)).status).toBe(200);
        expect((await call(server.url, '/api/export?site=sitea', cred)).status).toBe(200);
        expect((await call(server.url, '/api/visitors/someone?site=sitea', cred)).status).toBe(200);
        expect((await call(server.url, '/api/variants', { method: 'POST', json: { site: 'sitea', name: 'nope', selector: '#n' }, ...cred })).status).toBe(403);
        expect((await call(server.url, `/api/variants/${aId}/toggle`, { method: 'POST', ...cred })).status).toBe(403);
        expect((await call(server.url, `/api/variants/${aId}`, { method: 'DELETE', ...cred })).status).toBe(403);
        expect((await call(server.url, '/api/visitors/someone?site=sitea', { method: 'DELETE', ...cred })).status).toBe(403);
        expect((await call(server.url, '/api/sites/sitea/holdout', { method: 'POST', json: { holdoutPct: 10 }, ...cred })).status).toBe(403);
      }

      const holdout = await call(server.url, '/api/sites/sitea/holdout', {
        method: 'POST', cookie: owner, json: { holdoutPct: 25 },
      });
      expect(holdout.status).toBe(200);
      expect(holdout.body).toEqual({ ok: true, site: 'sitea', holdoutPct: 25, holdoutPctSource: 'site' });
      const lift = await call(server.url, '/api/sites/sitea/lift-report', { cookie: owner });
      expect(lift.status).toBe(200);
      expect((lift.body as { site?: string }).site).toBe('sitea');
      const html = await call(server.url, '/api/sites/sitea/lift-report?format=html', { cookie: owner });
      expect(html.status).toBe(200);
      expect(html.text).toContain('Lift report: sitea');
      const csv = await call(server.url, '/api/sites/sitea/lift-report?format=csv', { cookie: owner });
      expect(csv.status).toBe(200);
      expect(csv.text.startsWith('site,selector')).toBe(true);
      expect((await call(server.url, '/api/sites/siteb/holdout', { method: 'POST', cookie: owner, json: { holdoutPct: 10 } })).status).toBe(403);
      expect((await call(server.url, '/api/sites/siteb/lift-report', { cookie: owner })).status).toBe(403);
      expect((await call(server.url, '/api/sites/siteb/lift-report?format=html', { cookie: owner })).status).toBe(403);
      expect((await call(server.url, '/api/sites/siteb/lift-report?format=csv', { cookie: owner })).status).toBe(403);

      expect((await call(server.url, '/api/sites', { cookie: editor })).body).toEqual(['sitea']);
      expect((await call(server.url, '/api/sites', { cookie: owner })).body).toEqual(['sitea', 'sitez']);

      const fresh = await call(server.url, '/api/variants', {
        method: 'POST', cookie: editor, json: { site: 'newsite', name: 'New', selector: '#n' },
      });
      expect(fresh.status).toBe(403);
      expect(fresh.body).toEqual({ error: 'forbidden' });
      expect(await readSite(server.dbPath, 'newsite')).toBeNull();

      expect((await call(server.url, '/api/growth', { cookie: owner })).status).toBe(403);
      expect((await call(server.url, '/api/pilot/inquiries', { cookie: owner })).status).toBe(403);
      expect((await call(server.url, '/api/sites/sitea/plan', { method: 'POST', cookie: owner, json: { plan: 'growth' } })).status).toBe(403);
      expect((await call(server.url, '/api/growth', { token: ADMIN })).status).toBe(200);

      expect(before).toEqual({ id: bId, site: 'siteb', name: 'Site B secret', active: 1 });
      expect(await readVariant(server.dbPath, bId)).toEqual(before);

      await expectNoAccessPage(server.url, editor);
    } finally {
      await server.stop();
    }
  });

  test('open mode still serves a variants read', async () => {
    const server = await startServer({
      DEMO_TOKEN: DEMO,
      SESSION_SECRET: SESSION,
      HOLDOUT_PCT: '0',
      PRISM_PLAN: 'selfhost',
      READONLY_TOKENS: '',
      GOOGLE_ALLOWED_EMAILS: '',
    }, { admin: false });
    try {
      const res = await call(server.url, '/api/variants?site=demo');
      expect(res.status).toBe(200);
      const hero = (res.body as { site?: string; name?: string }[]).find((row) => row.name === 'Gift-buyer hero');
      expect(hero?.site).toBe('demo');
      expect(hero?.name).toBe('Gift-buyer hero');
    } finally {
      await server.stop();
    }
  });
});

async function expectDenied(url: string, secret: string, bId: number, via: 'cookie' | 'token') {
  const cred = via === 'cookie' ? { cookie: secret } : { token: secret };
  const cases: { method?: string; path: string; json?: unknown; status: number }[] = [
    { path: '/api/variants?site=siteb', status: 403 },
    { method: 'POST', path: '/api/variants', json: { site: 'siteb', name: 'x', selector: '#x' }, status: 403 },
    { method: 'POST', path: `/api/variants/${bId}/toggle`, status: 404 },
    { method: 'DELETE', path: `/api/variants/${bId}`, status: 404 },
    { path: '/api/stats?site=siteb', status: 403 },
    { path: '/api/export?site=siteb', status: 403 },
    { path: '/api/visitors/someone?site=siteb', status: 403 },
    { method: 'DELETE', path: '/api/visitors/someone?site=siteb', status: 403 },
    { method: 'POST', path: '/api/sites/siteb/holdout', json: { holdoutPct: 10 }, status: 403 },
    { path: '/api/sites/siteb/lift-report', status: 403 },
    { path: '/api/sites/siteb/lift-report?format=html', status: 403 },
    { path: '/api/sites/siteb/lift-report?format=csv', status: 403 },
  ];
  for (const item of cases) {
    const res = await call(url, item.path, { method: item.method, json: item.json, ...cred });
    expect(res.status, `${item.method ?? 'GET'} ${item.path}`).toBe(item.status);
  }
}

async function expectNoAccessPage(url: string, jwt: string) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const hits: string[] = [];
    page.on('request', (req) => {
      const target = req.url();
      if (target.includes('/api/variants') || target.includes('/api/stats')) hits.push(target);
    });
    await page.context().addCookies([{ name: 'prism_session', value: jwt, url }]);
    await page.goto(`${url}/admin?site=siteb`);
    await page.getByText('No access to this site.', { exact: true }).waitFor();
    await page.waitForTimeout(500);
    expect(hits).toEqual([]);
    expect(await page.locator('body').innerText()).not.toContain('Site B secret');
  } finally {
    await browser.close();
  }
}

type Cred = { token?: string; cookie?: string };

async function call(url: string, path: string, opts: Cred & { method?: string; json?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.cookie) headers.cookie = `prism_session=${opts.cookie}`;
  if (opts.json !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(new URL(path, url), {
    method: opts.method ?? 'GET',
    headers,
    body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
  });
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, text };
}

function idOf(body: unknown): number {
  const id = (body as { id?: number }).id;
  if (typeof id !== 'number') throw new Error(`missing variant id in ${JSON.stringify(body)}`);
  return id;
}

async function mint(email: string): Promise<string> {
  const out = await bunOut(['tests/support/mint-session.ts', email], {
    SESSION_SECRET: SESSION,
    DB_PATH: join(mkdtempSync(join(tmpdir(), 'prism-mint-')), 'prism.db'),
  });
  return out.trim();
}

async function readVariant(dbPath: string, id: number): Promise<unknown> {
  const out = await bunOut(['-e', `
    import { Database } from "bun:sqlite";
    const db = new Database(process.env.DB_PATH);
    const row = db.prepare("SELECT id, site, name, active FROM variants WHERE id = ?").get(Number(process.env.VARIANT_ID));
    console.log(JSON.stringify(row));
  `], { DB_PATH: dbPath, VARIANT_ID: String(id) });
  return JSON.parse(out);
}

async function readSite(dbPath: string, site: string): Promise<unknown> {
  const out = await bunOut(['-e', `
    import { Database } from "bun:sqlite";
    const db = new Database(process.env.DB_PATH);
    const row = db.prepare("SELECT site FROM sites WHERE site = ?").get(process.env.SITE);
    console.log(JSON.stringify(row ?? null));
  `], { DB_PATH: dbPath, SITE: site });
  return JSON.parse(out);
}

function bunOut(args: string[], env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', args, {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error(`bun ${args[0]} exited ${code}\n${stderr}`));
      else resolve(stdout);
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      socket.close(() => resolve(port));
    });
  });
}

async function startServer(
  extra: Record<string, string>,
  opts: { admin?: boolean } = {},
): Promise<{ url: string; dbPath: string; stop: () => Promise<void> }> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), ...extra };
  delete env.GOOGLE_CLIENT_ID;
  delete env.GOOGLE_CLIENT_SECRET;
  delete env.DEV_AUTH_EMAIL;
  delete env.BASE_URL;
  if (opts.admin === false) delete env.ADMIN_TOKEN;
  const child: ChildProcess = spawn('bun', ['tests/support/serve.ts'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout?.on('data', (chunk) => { log += String(chunk); });
  child.stderr?.on('data', (chunk) => { log += String(chunk); });
  const url = `http://127.0.0.1:${port}`;
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    if (child.exitCode !== null) throw new Error(`scoping server exited\n${log}`);
    try {
      const res = await fetch(url + '/snippet.js');
      if (res.ok && log.includes('db=')) {
        const dbPath = log.match(/db=(\S+)/)?.[1];
        if (!dbPath) throw new Error(`no db path in\n${log}`);
        return {
          url,
          dbPath,
          stop: () => new Promise((resolve) => {
            if (child.exitCode !== null) return resolve();
            child.once('exit', () => resolve());
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), 2_000);
          }),
        };
      }
    } catch {
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill('SIGKILL');
  throw new Error(`scoping server did not start\n${log}`);
}
