/**
 * GitHub Actions Plate Sync Script - Tesseract OCR Version
 * 
 * Strategy: Traditional OCR with Image Pre-processing
 * Engine: Tesseract.js (v5)
 * Pre-processing: Jimp (Grayscale, Contrast, Threshold)
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createClient } = require('@supabase/supabase-js');
const Tesseract = require('tesseract.js');
const { Jimp } = require('jimp');
const fs = require('fs');
const path = require('path');
const util = require('util');

puppeteer.use(StealthPlugin());

// --- Logging Setup ---
const logDir = 'logs';
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);
const logFile = fs.createWriteStream(path.join(logDir, `ocr_test_${Date.now()}.log`), { flags: 'a' });
const logStdout = process.stdout;

console.log = function() {
  const timestamp = new Date().toISOString();
  const msg = util.format.apply(util, arguments) + '\n';
  logFile.write(`[${timestamp}] ${msg}`);
  logStdout.write(msg);
};

console.error = function() {
  const timestamp = new Date().toISOString();
  const msg = util.format.apply(util, arguments) + '\n';
  logFile.write(`[${timestamp}] [ERROR] ${msg}`);
  logStdout.write(`[ERROR] ${msg}`);
};

// --- Config ---
const envPath = fs.existsSync('.env.development') ? '.env.development' : '.env';
require('dotenv').config({ path: envPath });

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("Missing required env vars.");
    process.exit(1);
}

const MVDIS_URL = 'https://www.mvdis.gov.tw/m3-emv-plate/webpickno/queryPickNo';

// Targets (Testing with Taipei City first)
const TARGET_DEPTS = {
    '2': [
        { id: '20', name: '臺北市區監理所' }
    ]
};

// --- Clients ---
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// --- Human Helper Functions ---
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const randomSleep = async (min, max) => {
    const ms = Math.floor(Math.random() * (max - min + 1) + min);
    await sleep(ms);
};

const humanType = async (page, selector, text) => {
    await page.waitForSelector(selector);
    const element = await page.$(selector);
    await element.click();
    await randomSleep(100, 300); // OCR is fast, but we still simulate typing
    for (const char of text) {
        await page.keyboard.type(char, { delay: Math.floor(Math.random() * 100) + 30 });
    }
    await randomSleep(200, 500);
};

async function doSubmit(page) {
    return page.evaluate(() => {
        if (typeof window.doSubmit === 'function') {
            window.doSubmit();
        }
    });
}

// --- OCR Logic ---
async function solveCaptcha(page) {
    const start = Date.now();
    console.log('    [OCR] Capturing and Processing image...');
    
    try {
        const captchaEl = await page.$('#pickimg');
        if (!captchaEl) throw new Error('CAPTCHA image not found');

        const imageBuffer = await captchaEl.screenshot();

        // 1. Image Pre-processing with Jimp
        // 監理站驗證碼通常有干擾線，這裡做基礎的強化
        const image = await Jimp.read(imageBuffer);
        
        image
            .greyscale()        // 轉灰階
            .contrast(1)        // 提高對比度 (最大)
            .brightness(0.1)    // 稍微調亮
            //.invert()         // 有時候反轉有效，視情況而定
            .threshold({ max: 200 }); // 二值化 (黑白分明)

        const processedBuffer = await image.getBuffer("image/png");

        // 2. Tesseract Recognition
        const { data: { text } } = await Tesseract.recognize(
            processedBuffer,
            'eng',
            {
                logger: m => {} // Quiet mode
            }
        );

        // Clean result (Keep only A-Z and 0-9)
        const cleanText = text.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        
        const duration = (Date.now() - start);
        console.log(`    [OCR] Predicted: ${cleanText} (Time: ${duration}ms)`);
        
        return cleanText;

    } catch (e) {
        console.error('    [OCR] Error:', e.message);
        return null;
    }
}

// --- Main Process Logic ---

async function processStation(page, deptId, station) {
    const startTime = Date.now();
    console.log(`
--- Processing Station: ${station.name} (${station.id}) ---
`);
    
    const plateTypes = ['g', 'h'];
    if (station.no_rental) plateTypes.pop(); // Remove 'h' if no rental

    for (const pType of plateTypes) {
        const typeName = pType === 'g' ? 'Private (g)' : 'Rental (h)';
        console.log(`  > Querying: ${typeName}`);

        await page.goto(MVDIS_URL, { waitUntil: 'networkidle2' });
        await randomSleep(1000, 1500);

        // Selectors
        await page.select('#selDeptCode', deptId);
        await randomSleep(500, 1000);
        await page.select('#selStationCode', station.id);
        await randomSleep(500, 1000);

        try {
            await page.waitForSelector('#selWindowNo option[value="01"]', { timeout: 3000 });
            await page.select('#selWindowNo', '01');
        } catch (e) {
            await page.evaluate(() => {
                const opts = document.querySelectorAll('#selWindowNo option');
                if (opts.length > 1) opts[1].selected = true;
            });
        }
        await randomSleep(500, 800);

        await page.select('#selCarType', 'C');
        await randomSleep(300, 600);
        await page.select('#selEnergyType', 'E');
        await randomSleep(500, 1000);

        const typeExists = await page.evaluate((val) => {
            return !!document.querySelector(`#selPlateType option[value="${val}"]`);
        }, pType);

        if (!typeExists) {
            console.log(`    [Skip] Plate type ${pType} not available.`);
            continue;
        }
        await page.select('#selPlateType', pType);
        await randomSleep(500, 1000);

        // CAPTCHA Loop
        let attempts = 0;
        let success = false;
        let collectedPlates = [];

        // Increase attempts for OCR because it's free and fast
        while (attempts < 5 && !success) {
            attempts++;
            
            if (attempts > 1) {
                console.log('    [Retry] Refreshing CAPTCHA...');
                const refreshBtn = await page.$('#pickimg + a');
                if (refreshBtn) await refreshBtn.click();
                else await page.click('a[onclick*="pickimg"]');
                await randomSleep(2000, 3000); 
            }

            const code = await solveCaptcha(page);
            // OCR often returns empty or garbage, skip quick check
            if (!code || code.length < 4) { 
                console.log(`    [OCR] Invalid length (${code ? code.length : 0}), skipping...`);
                continue; 
            }

            await humanType(page, '#validateStr', code);
            
            let alertMsg = null;
            const dialogHandler = async dialog => {
                alertMsg = dialog.message();
                await dialog.dismiss();
            };
            page.on('dialog', dialogHandler);

            await doSubmit(page);

            try {
                await page.waitForFunction(
                    () => document.querySelector('.number_cell') || document.body.innerText.includes('查無資料'),
                    { timeout: 5000 }
                );
                
                if (alertMsg) {
                    console.log(`    [Fail] Alert: ${alertMsg}`);
                } else {
                    success = true;
                }
            } catch (e) {
                if (alertMsg) console.log(`    [Fail] Alert: ${alertMsg}`);
                else console.log('    [Fail] Result timeout (Validation failed).');
            }
            
            page.off('dialog', dialogHandler);
        }

        if (success) {
            console.log('    [Success] Captcha solved!');
            // 7. Scrape & Pagination (Simplified logic for test)
            const plates = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('.number_cell')).map(el => ({
                    no: el.querySelector('.number')?.innerText.trim(),
                    price: el.querySelector('.price')?.innerText.split('元')[0].replace(/,/g, '').trim()
                })).filter(x => x.no);
            });
            console.log(`    [Scrape] Found ${plates.length} plates on page 1.`);
            // Skipping detailed DB sync for OCR test to focus on recognition rate
        } else {
             console.log('    [GiveUp] Failed after 5 attempts.');
        }

        await randomSleep(2000, 3000);
    }

    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);
    console.log(`⏱️  Station ${station.name} finished in ${duration}s`);
}

// --- Execution Entry ---
(async () => {
    console.log('🚀 Starting OCR Test (Tesseract.js + Jimp)...');
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1920,1080']
    });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });

        for (const deptId of Object.keys(TARGET_DEPTS)) {
            const stations = TARGET_DEPTS[deptId];
            for (const station of stations) {
                await processStation(page, deptId, station);
            }
        }
    } catch (e) {
        console.error('Fatal Error:', e);
    } finally {
        await browser.close();
        console.log('🏁 OCR Test Complete.');
    }
})();
