// Records the live site's React Server Component payloads so client-side
// navigation works in the mirror exactly as it does online.
//
// Next.js fetches these as `<path>?_rsc=<hash>` with RSC headers: segment
// prefetches (`Next-Router-Segment-Prefetch: /_tree`, `/…/__PAGE__`, …) while
// links are on screen, and a full payload when a navigation has no prefetch.
// We visit every sitemap page in real Chrome, scroll so every link prefetches,
// keep each response under the key serve-mirror.js looks up, then fetch the full
// payload for every route seen.
//
//   cd tools && npm install && npm run record-rsc
//   CHROME_PATH=/path/to/chrome npm run record-rsc   (if Chrome is elsewhere)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const puppeteer = require('puppeteer-core');
const { rscKey } = require('../rsc-key');

const BASE = 'https://puppy.instabizweb.com';
const OUT = path.join(__dirname, '..', 'mirror', '_rsc');
const CHROME = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].find((p) => fs.existsSync(p));

const index = {};
const routes = new Set();

function store(key, body) {
  const file = crypto.createHash('sha1').update(key).digest('hex').slice(0, 16) + '.rsc';
  fs.writeFileSync(path.join(OUT, file), body);
  index[key] = file;
}

async function recordPage(browser, pagePath) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const pending = [];
  page.on('response', (res) => {
    const url = new URL(res.url());
    if (url.origin !== BASE || !url.searchParams.has('_rsc') || res.status() !== 200) return;
    const headers = res.request().headers();
    const key = rscKey(url, headers);
    routes.add(key.split('|')[0]);
    pending.push(res.buffer().then((body) => store(key, body)).catch(() => {}));
  });
  await page.goto(BASE + pagePath, { waitUntil: 'networkidle2', timeout: 90000 });
  // walk down the page so every link enters the viewport and prefetches
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y <= height; y += 500) {
    await page.evaluate((t) => scrollTo(0, t), y);
    await new Promise((r) => setTimeout(r, 150));
  }
  await new Promise((r) => setTimeout(r, 2500));
  await Promise.all(pending);
  await page.close();
}

// Fetch one payload directly, for routes whose links were never prefetched on screen
async function recordDirect(route, kind, extraHeaders) {
  const key = `${route}|${kind}`;
  if (index[key]) return;
  const res = await fetch(`${BASE}${route}${route.includes('?') ? '&' : '?'}_rsc=mirror`, {
    headers: { RSC: '1', 'User-Agent': 'Mozilla/5.0', ...extraHeaders },
  });
  if (res.ok && (res.headers.get('content-type') || '').includes('x-component')) {
    store(key, Buffer.from(await res.arrayBuffer()));
  } else {
    console.warn(`  no ${kind} payload for ${route} (${res.status})`);
  }
}

(async () => {
  if (!CHROME) throw new Error('Chrome not found; set CHROME_PATH');
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const sitemap = await (await fetch(`${BASE}/sitemap.xml`)).text();
  const pages = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
  pages.forEach((p) => routes.add(p));

  const browser = await puppeteer.launch({ executablePath: CHROME });
  for (const [i, p] of pages.entries()) {
    process.stdout.write(`\r  recording ${i + 1}/${pages.length} ${p.padEnd(50)}`);
    await recordPage(browser, p);
  }
  await browser.close();
  console.log();

  for (const route of routes) {
    await recordDirect(route, 'full', {});
    await recordDirect(route, 'segment:/_tree', { 'Next-Router-Prefetch': '1', 'Next-Router-Segment-Prefetch': '/_tree' });
  }

  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1));
  console.log(`saved ${Object.keys(index).length} payloads for ${routes.size} routes -> ${OUT}`);
})();
