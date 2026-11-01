// Builds public/raccoon/share.jpg by setting the title over a wide render, using the
// site's real fonts and headline style. Run with the preview server up:
//   node art/raccoon/share-card.js <wide-render.png>
const fs = require('fs');
const path = require('path');
const { chromium } = require(path.resolve(__dirname, '../../../kwaney-site/node_modules/playwright'));

const render = fs.readFileSync(process.argv[2]).toString('base64');

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
    await page.goto('http://127.0.0.1:4173/about');
    await page.waitForTimeout(800);
    await page.evaluate((img) => {
        document.head.querySelectorAll('script').forEach((s) => s.remove());
        document.body.innerHTML = `
            <div style="position:relative;width:1200px;height:630px;overflow:hidden">
                <img src="data:image/png;base64,${img}" style="position:absolute;inset:0;width:1200px;height:630px">
                <div class="hero" style="position:absolute;display:block;left:640px;top:172px;width:524px;padding:0;margin:0">
                    <div style="font-family:var(--mono);font-size:17px;letter-spacing:.12em;text-transform:uppercase;color:rgba(27,27,27,.7);margin-bottom:18px">Toronto's east end</div>
                    <h1 style="font-size:66px;line-height:1.04;margin:0 0 20px">Leslieville Stink Reporter</h1>
                    <div style="font-family:var(--sans);font-size:25px;line-height:1.3;color:rgba(27,27,27,.82)">Smelled something? Report it in seconds and see the live map.</div>
                </div>
            </div>`;
    }, render);
    await page.addStyleTag({ content: 'html,body{margin:0;background:transparent}' });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.resolve(__dirname, '../../public/raccoon/share.jpg'), type: 'jpeg', quality: 84, clip: { x: 0, y: 0, width: 1200, height: 630 } });
    await browser.close();
})();
