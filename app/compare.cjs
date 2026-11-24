const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport:{width:390,height:240}, deviceScaleFactor:2, isMobile:true, hasTouch:true });
  const page = await ctx.newPage();
  const base='http://127.0.0.1:4173';
  await page.goto(base+'/?demo=1#/home');
  // wait for app to finish loading (splash gone) by polling for header on /settings
  let ok=false;
  for(let i=0;i<50;i++){
    if(await page.evaluate(()=>!!document.querySelector('header'))){ok=true;break;}
    await page.goto(base+'/#/settings'); await page.waitForTimeout(600);
  }
  if(!ok){console.log('NO_HEADER');await browser.close();return;}
  // ensure we're on settings and settled, no splash
  if(!page.url().includes('settings')){ await page.goto(base+'/#/settings'); }
  await page.waitForFunction(()=>!!document.querySelector('header'));
  await page.waitForTimeout(1200);
  await page.evaluate(()=>{ document.documentElement.style.setProperty('--safe-t','44px'); window.scrollTo(0,0); });
  await page.waitForTimeout(400);
  await page.screenshot({path:'/tmp/cmp_left_fixed.png'});   // 现状=已删=贴顶
  await page.evaluate(()=>{ document.querySelector('header').style.paddingTop='44px'; });
  await page.waitForTimeout(400);
  await page.screenshot({path:'/tmp/cmp_right_gapped.png'}); // 加回=复现空白
  await browser.close();
  console.log('CMP_OK');
})().catch(e=>{console.error('FAIL',e.message);process.exit(1);});
