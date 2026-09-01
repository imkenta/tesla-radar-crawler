'use strict';

/**
 * 出口偵察（2026-09-01，手動觸發）：回答「WARP 以外有沒有乾淨出口」。
 *
 * 背景：CI log 實測 135 次 WARP 出口 × MVDIS，可達率僅 49.6%，且每個 /24 都
 * 命中/被擋混合＝MVDIS 逐個 IP 拉黑，已黑掉 WARP consumer 池（104.28.192.0/18）
 * 約半數。重抽是從同一個中毒池再抽，故需要脫離該池的出口。
 *
 * 本腳本零 DB 寫入、零 staging 變更，只做連線事實回報：
 *   1. 本 runner 原生出口 IPv4 / ASN（GitHub Actions = Azure 池）
 *   2. runner 是否具備全球 IPv6（GitHub-hosted runner 官方未提供，需實測確認）
 *   3. curl 對 MVDIS 的 IPv4 / IPv6 結果
 *   4. Chromium 對 MVDIS 的實際導航結果（專案鐵律：curl 可達不等於瀏覽器可達，
 *      Chromium 才是權威判定）
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const MVDIS_URL = 'https://www.mvdis.gov.tw/m3-emv-plate/webpickno/queryPickNo';

async function chromiumProbe() {
    const browser = await puppeteer.launch({
        headless: 'new',
        protocolTimeout: 60000,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-features=NetworkServiceSandbox',
            '--window-size=1920,1080',
            '--disable-blink-features=AutomationControlled',
            '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        ],
    });
    try {
        const page = await browser.newPage();
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
            'Referer': 'https://www.mvdis.gov.tw/',
        });
        await page.setViewport({ width: 1920, height: 1080 });

        try {
            await page.goto('http://example.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
            console.log('CHROMIUM_NETWORK=OK');
        } catch (e) {
            console.log(`CHROMIUM_NETWORK=BROKEN (${e.message})`);
            return;
        }

        const start = Date.now();
        try {
            const res = await page.goto(MVDIS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
            const ms = Date.now() - start;
            console.log(`CHROMIUM_MVDIS=HTTP_${res ? res.status() : 'NORESP'} elapsed=${ms}ms`);
            const title = await page.title().catch(() => '');
            console.log(`CHROMIUM_MVDIS_TITLE=${title}`);
        } catch (e) {
            console.log(`CHROMIUM_MVDIS=FAILED elapsed=${Date.now() - start}ms (${e.message})`);
        }
    } finally {
        await browser.close();
    }
}

chromiumProbe().catch((e) => {
    console.log(`CHROMIUM_FATAL=${e.message}`);
    process.exit(0); // 偵察腳本永不讓 job 變紅，事實回報即可
});
