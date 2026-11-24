const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true, hasTouch: true,
  });
  const page = await ctx.newPage();
  const base = 'http://127.0.0.1:4173';
  const routes = [['wall','/wall'],['backup','/backup'],['settings','/settings'],['categories','/categories'],['rules','/rules']];
  // seed demo data once
  await page.goto(base + '/?demo=1#/home');
  await page.waitForTimeout(3500);
  const pages = [];
  for (const [name, path] of routes) {
    await page.goto(base + '/#' + path);
    await page.waitForTimeout(1600);
    // force the safe-area var to 44px to simulate APP status-bar height
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--safe-t', '44px');
    });
    await page.waitForTimeout(400);
    const f = '/tmp/sub_' + name + '.png';
    await page.screenshot({ path: f });
    pages.push(f);
  }
  await browser.close();
  console.log('SHOT_OK');
  console.log(pages.join('\n'));
})().catch(e => { console.error('SHOT_FAIL', e.message); process.exit(1); });
