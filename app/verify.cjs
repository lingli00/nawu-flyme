const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport:{width:390,height:844}, deviceScaleFactor:2, isMobile:true, hasTouch:true });
  const page = await ctx.newPage();
  const base='http://127.0.0.1:4173';
  await page.goto(base+'/?demo=1#/home');
  let found=false;
  for(let i=0;i<40;i++){
    await page.goto(base+'/#/settings'); await page.waitForTimeout(500);
    if(await page.evaluate(()=>!!document.querySelector('header'))){found=true;break;}
  }
  if(!found){console.log('NO_HEADER');await browser.close();return;}
  await page.waitForTimeout(800);
  await page.evaluate(()=>document.documentElement.style.setProperty('--safe-t','44px'));
  await page.waitForTimeout(300);
  // measure the title TEXT y-position inside header + header height
  const m=()=>page.evaluate(()=>{
    const h=document.querySelector('header');
    const r=h.getBoundingClientRect();
    // first text-bearing descendant (the title)
    const walker=document.createTreeWalker(h,NodeFilter.SHOW_TEXT);
    let n,txt=null;
    while(n=walker.nextNode()){ if(n.textContent.trim()){txt=n; break;} }
    const tr=txt?txt.parentElement.getBoundingClientRect():null;
    return { headerH:Math.round(r.height), titleTextY: tr?Math.round(tr.top):null, titleText: txt?txt.textContent.trim().slice(0,10):null };
  });
  const a=await m();
  await page.screenshot({path:'/tmp/ctrl_A_deleted.png'});
  await page.evaluate(()=>{document.querySelector('header').style.paddingTop='44px';});
  await page.waitForTimeout(300);
  const b=await m();
  await page.screenshot({path:'/tmp/ctrl_B_padded.png'});
  console.log('A)已删 paddingTop + safe-t=44px模拟状态栏:');
  console.log('   header高度='+a.headerH+' 标题文字y='+a.titleTextY+' ("'+a.titleText+'")');
  console.log('B)加回 44px paddingTop:');
  console.log('   header高度='+b.headerH+' 标题文字y='+b.titleTextY+' ("'+b.titleText+'")');
  const pushed=(a.titleTextY!==null&&b.titleTextY!==null&&b.titleTextY-a.titleTextY>=40);
  console.log(pushed?'VERDICT_PASS: 加回paddingTop→标题下移'+(b.titleTextY-a.titleTextY)+'px(=APP那道空白);现在(已删)→贴顶。方法+修复双确认':'VERDICT: 位移不足 a='+a.titleTextY+' b='+b.titleTextY);
  await browser.close();
})().catch(e=>{console.error('FAIL',e.message);process.exit(1);});
