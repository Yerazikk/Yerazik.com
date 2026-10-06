const puppeteer = require('puppeteer');
const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html':'text/html', '.css':'text/css', '.js':'application/javascript',
  '.svg':'image/svg+xml', '.webp':'image/webp', '.jpg':'image/jpeg',
  '.png':'image/png', '.woff2':'font/woff2', '.woff':'font/woff'
};

function serve(dir, port) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let urlPath = req.url.split('?')[0];
      if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
      const filePath = path.join(dir, urlPath);
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        const ct = MIME[path.extname(filePath)] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': ct });
        res.end(data);
      });
    });
    server.listen(port, () => {
      console.log(`Server running at http://localhost:${port}`);
      resolve(server);
    });
  });
}

(async () => {
  const dir = path.resolve(__dirname);
  const port = 7788;
  const outDir = path.join(dir, 'screenshots');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

  const server = await serve(dir, port);
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });

  // Load once, reuse the page DOM for all layouts
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle2', timeout: 15000 });
  // Wait for fonts
  await page.evaluate(() => document.fonts.ready);
  // Force all reveal animations to fire immediately
  await page.evaluate(() => {
    document.querySelectorAll('[data-r]').forEach(el => el.classList.add('in'));
    const panel = document.getElementById('copy-panel');
    if (panel) panel.style.display = 'none';
    document.querySelectorAll('.target-cursor').forEach(el => el.remove());
    const noExtras = document.createElement('style');
    // Hide cursor bracket + the cream wipe-reveal block that plays on page load
    noExtras.textContent = [
      '.target-cursor,.tc-dot,.tc-corner{display:none!important}',
      '.wm-fx::after{display:none!important}',
    ].join('\n');
    document.head.appendChild(noExtras);
  });

  const layouts = ['v1','v2','v3','v4','v5','v6','v7','v8','v9','v10'];

  for (const key of layouts) {
    await page.evaluate((k) => {
      const hero = document.querySelector('.hero');
      if (!hero) return;
      hero.removeAttribute('data-layout');
      hero.setAttribute('data-layout', k);
      const greetEl = hero.querySelector('.greeting');
      const ledeEl = hero.querySelector('.lede');
      const showGreeting = ['v6','v7'];
      const ledeCopy = { v2:'IK' };
      if (greetEl) greetEl.textContent = showGreeting.includes(k) ? 'Hi, I\'m' : '';
      if (ledeEl) ledeEl.textContent = ledeCopy[k] || 'Software engineer.';
    }, key);

    // Let paint settle
    await new Promise(r => setTimeout(r, 400));

    const file = path.join(outDir, `layout-${key}.png`);
    await page.screenshot({ path: file, clip: { x: 0, y: 0, width: 1440, height: 900 } });
    console.log(`✓ ${key} → screenshots/layout-${key}.png`);
  }

  await browser.close();
  server.close();
  console.log('\nAll done.');
})();
