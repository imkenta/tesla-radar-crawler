/**
 * GitHub Actions Plate Sync Script - Stealth Version 2.0
 * 
 * Target: MVDIS (Motor Vehicle Driver Information Service)
 * Strategy: Human Emulation, Randomized Delays, Quota Protection
 * AI Model: Gemma 3 27B-IT
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const util = require('util');

// --- Global Error Handlers ---
process.on('unhandledRejection', (reason, p) => {
    console.error('[FATAL] Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught Exception:', err);
});

puppeteer.use(StealthPlugin());

// --- Logging Setup ---
const logDir = 'logs';
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);
const logFile = fs.createWriteStream(path.join(logDir, `crawler_${Date.now()}.log`), { flags: 'a' });
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

// --- Rate Limiter ---
class RateLimiter {
    constructor(limit, interval) {
        this.limit = limit;
        this.interval = interval;
        this.tokens = limit;
        this.lastRefill = Date.now();
    }

    async wait() {
        const now = Date.now();
        if (now - this.lastRefill > this.interval) {
            this.tokens = this.limit;
            this.lastRefill = now;
        }

        if (this.tokens <= 0) {
            const waitTime = this.interval - (now - this.lastRefill) + 1000;
            console.log(`    [RateLimit] Quota exhausted. Waiting ${Math.ceil(waitTime/1000)}s...`);
            await new Promise(r => setTimeout(r, waitTime));
            this.tokens = this.limit;
            this.lastRefill = Date.now();
        }
        this.tokens--;
    }
}

const geminiLimiter = new RateLimiter(25, 60000);

// --- Config ---
const envPath = fs.existsSync('.env.development') ? '.env.development' : '.env';
require('dotenv').config({ path: envPath });

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PROXY_URL = process.env.PROXY_URL;
const MODEL_NAME = "gemma-3-27b-it";

if (!SUPABASE_URL || !SUPABASE_KEY || !GEMINI_API_KEY) {
    console.error("Missing required env vars.");
    process.exit(1);
}

const MVDIS_URL = 'https://www.mvdis.gov.tw/m3-emv-plate/webpickno/queryPickNo';
// STATION_DATA removed, loaded dynamically

// Parse Arguments
const args = process.argv.slice(2);
const shardArg = args.find(arg => arg.startsWith('--shard='));
const TARGET_SHARD = shardArg ? shardArg.split('=')[1] : null;

// Global state for stations (populated later)
let TARGET_DEPTS = {};
let totalStations = 0;

// --- Clients ---
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: MODEL_NAME });

async function loadStationData() {
    console.log('📥 Loading station configuration from DB...');
    const { data, error } = await supabase
        .from('system_configs')
        .select('value')
        .eq('key', 'mvdis_stations')
        .single();

    if (error) throw new Error(`Failed to load station config: ${error.message}`);
    if (!data) throw new Error('Station config not found in DB');

    const stationData = data.value;
    
    stationData.forEach(dept => {
        const stations = dept.stations.filter(s => !TARGET_SHARD || s.shard === TARGET_SHARD);
        if (stations.length > 0) {
            TARGET_DEPTS[dept.id] = stations;
            totalStations += stations.length;
        }
    });

    console.log(`🎯 Target Shard: ${TARGET_SHARD || 'ALL'}`);
    console.log(`📊 Stations to process: ${totalStations}`);
}

// --- Helper: Region Classifier ---
function getRegion(stationId) {
    const id = parseInt(stationId);
    if ((id >= 20 && id <= 49) && id !== 44 && id !== 45 && id !== 46 && id !== 25 && id !== 26) return 'North';
    if ([20, 21, 30, 31, 33, 40, 41, 42, 43, 25].includes(id)) return 'North';
    if ([50, 51, 52, 53, 54, 60, 61, 62, 63, 64, 65].includes(id)) return 'Central';
    if ([70, 71, 72, 73, 74, 75, 76, 80, 81, 82, 83, 84, 85].includes(id)) return 'South';
    if ([44, 45, 46].includes(id)) return 'East';
    if ([26, 84].includes(id)) return 'Island';
    return 'Other';
}

// --- Stats Collector ---
class SyncStats {
    constructor(runId) {
        this.runId = runId;
        this.startTime = new Date();
        this.endTime = null;
        this.status = 'RUNNING';
        this.totalPlates = 0;
        this.stationsSuccess = 0;
        this.stationsFailed = 0;
        this.captchaAttempts = 0;
        this.captchaSuccess = 0;
        this.errors = [];
        this.stationDetails = []; // Store detailed stats per station
    }

    addError(station, error) {
        const msg = `${station}: ${error}`;
        this.errors.push(msg);
        console.error(`    [Stats] Error added: ${msg}`);
    }

    addStationStat(stat) {
        this.stationDetails.push(stat);
    }

    async save() {
        this.endTime = new Date();
        const runtime = (this.endTime - this.startTime) / 1000;
        
        console.log(`\n📊 Final Sync Statistics:`);
        console.log(`   - Total Plates: ${this.totalPlates}`);
        console.log(`   - Stations: ${this.stationsSuccess} Success / ${this.stationsFailed} Failed`);
        const captchaRate = this.captchaAttempts > 0 ? Math.round(this.captchaSuccess/this.captchaAttempts*100) : 0;
        console.log(`   - CAPTCHA: ${this.captchaSuccess}/${this.captchaAttempts} (${captchaRate}%)`);
        console.log(`   - Runtime: ${runtime.toFixed(2)}s`);

        const { error } = await supabase.from('sync_logs').upsert({
            run_id: this.runId,
            start_time: this.startTime.toISOString(),
            end_time: this.endTime.toISOString(),
            status: this.status,
            total_plates: this.totalPlates,
            stations_success: this.stationsSuccess,
            stations_failed: this.stationsFailed,
            captcha_attempts: this.captchaAttempts,
            captcha_success: this.captchaSuccess,
            error_summary: this.errors.join('\n').substring(0, 2000),
            station_stats: this.stationDetails, // Save detailed stats
            runtime_sec: runtime
        }, { onConflict: 'run_id' });

        if (error) console.error('    [DB] Save Stats Error:', error.message);
    }
}

const stats = new SyncStats(`run_${Date.now()}`);

// Stations known to be slow or high traffic, requiring slower interaction
const HIGH_RISK_STATIONS = [
    '20', '21', // Taipei City, Shilin
    '25', '26', '28', // Keelung, Kinmen, Lienchiang
    '40', '43', '44', // New Taipei, Yilan, Hualien
    '52', '54', // Taoyuan, Miaoli
    '60', '63', '64', '65', // Taichung area
    '70', '72', '73', '74', '75', '76', // Chiayi/Tainan/Yunlin
    '80', '81', '82', '83', '84' // Kaohsiung/Pingtung/Taitung/Penghu
];

/**
 * 模型選擇策略：優先抓取自用 (g)，若車站支援租賃則也抓取 (h)。
 */

// --- Human Helper Functions ---

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const randomSleep = async (min, max) => {
    const ms = Math.floor(Math.random() * (max - min + 1) + min);
    await sleep(ms);
};

const adaptiveSleep = async (min, max, latency) => {
    let multiplier = 1.0;
    // Fast response (< 1.5s) -> Speed up (0.75x delay) - More conservative than 0.6
    if (latency < 1500) multiplier = 0.75;
    // Slow response (> 4s) -> Slow down (1.5x delay)
    else if (latency > 4000) multiplier = 1.5;
    
    // Normal response (1.5s - 4s) -> 1.0x delay

    const finalMin = Math.floor(min * multiplier);
    const finalMax = Math.floor(max * multiplier);
    
    // Only log if variance is significant or for debug
    // console.log(`    [Sleep] Adaptive (${latency}ms latency): ${finalMin}-${finalMax}ms`);
    await randomSleep(finalMin, finalMax);
};

const humanType = async (page, selector, text) => {
    await page.waitForSelector(selector);
    const element = await page.$(selector);
    await element.click();
    await randomSleep(100, 300);
    
    for (const char of text) {
        await page.keyboard.type(char, { delay: Math.floor(Math.random() * 100) + 30 });
    }
    await randomSleep(200, 500);
};

async function solveCaptcha(page) {
    await geminiLimiter.wait(); 
    stats.captchaAttempts++;
    
    console.log(`    [AI] Solving CAPTCHA (${MODEL_NAME})...`);
    try {
        const captchaEl = await page.$('#pickimg');
        if (!captchaEl) throw new Error('CAPTCHA image not found');

        // Quality optimization: Double the scale for better OCR accuracy
        const imageBuffer = await captchaEl.screenshot({ 
            encoding: 'base64',
            type: 'jpeg',
            quality: 100,
            omitBackground: true
        });

        // Refined prompt for better character isolation
        const prompt = "This image contains a 4-character CAPTCHA with Latin letters (A-Z) and numbers (0-9). IDENTIFY and OUTPUT ONLY the 4 characters. DO NOT include any spaces, punctuation, Chinese characters, or explanation.";
        
        const result = await model.generateContent([
            prompt,
            { inlineData: { data: imageBuffer, mimeType: "image/jpeg" } }
        ]);
        const response = await result.response;
        const rawText = response.text();
        const text = rawText.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        
        console.log(`    [AI] Predicted: ${text} (Raw: ${rawText.substring(0, 50).replace(/\n/g, ' ')})`);
        
        if (text && text.length === 4) {
            stats.captchaSuccess++;
        }
        return text;
    } catch (e) {
        console.error('    [AI] Error:', e.message);
        return null;
    }
}

async function doSubmit(page) {
    const buttonData = await page.evaluate(() => {
        const selectors = [
            'a[onclick*="doSubmit"]',
            'input[onclick*="doSubmit"]',
            'button[onclick*="doSubmit"]',
            'input[type="button"][value*="確"]',
            '.std_btn'
        ];
        
        for (const sel of selectors) {
            const el = Array.from(document.querySelectorAll(sel)).find(e => {
                const r = e.getBoundingClientRect();
                return r.width > 0 && r.height > 0 && window.getComputedStyle(e).display !== 'none';
            });
            
            if (el) {
                el.scrollIntoView();
                const rect = el.getBoundingClientRect();
                return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, tag: el.tagName, sel: sel };
            }
        }
        return null;
    });

    if (buttonData) {
        await page.mouse.move(buttonData.x, buttonData.y, { steps: 5 });
        await sleep(200);
        await page.mouse.click(buttonData.x, buttonData.y);
        return `PHYSICAL_CLICK_${buttonData.tag}`;
    } else if (typeof window.doSubmit === 'function') {
        await page.evaluate(() => window.doSubmit());
        return "CALLED_SCRIPT_FALLBACK";
    }
    return "NOT_FOUND";
}

async function parsePageInfo(page) {
    return page.evaluate(() => {
        const text = document.body.innerText;
        
        // 1. Check for 'No Data' messages first
        if (text.includes('查無資料') || text.includes('尚無可供選號') || text.includes('對不起')) {
            return { current: 1, total: 1, count: 0, noData: true };
        }

        // 2. Match total count (more robust)
        const countMatch = text.match(/共\s*(\d+)\s*筆/) || text.match(/總數[:：]\s*(\d+)\s*面/);
        const count = countMatch ? parseInt(countMatch[1]) : 0;

        // 3. Match pagination (specific to MVDIS "頁次：1 / 2")
        let current = 1;
        let total = 1;
        
        // Try various common patterns
        const pageMatch = text.match(/(\d+)\s*\/\s*(\d+)\s*頁/) || text.match(/第\s*(\d+)\s*頁[，,]\s*共\s*(\d+)\s*頁/);
        
        if (pageMatch) {
            current = parseInt(pageMatch[1]);
            total = parseInt(pageMatch[2]);
        }

        // 4. Safety Check: If total is 1 but count looks like there should be more,
        // or if we can see the "status_next_page" or "#next" button
        const hasNextButton = !!document.querySelector('input[name="status_next_page"]') || !!document.querySelector('#next');
        if (total === 1 && hasNextButton) {
            total = 2; // Force at least one more loop if button exists
        }

        return {
            current: current,
            total: total,
            count: count,
            noData: false,
            hasNextButton: hasNextButton
        };
    });
}

// --- Main Process Logic ---

async function clearStaging() {
    console.log('🧹 Clearing staging table...');
    const { error } = await supabase.from('available_plates_staging').delete().neq('plate_no', 'FORCE_DELETE_ALL');
    if (error) console.error('    [DB] Clear Staging Error:', error.message);
}

async function reportStatus(status, message = null, key = 'plates_full_sync') {
    const { error } = await supabase
        .from('sync_metadata')
        .upsert({ // Changed to upsert to create key if missing
            key: key,
            status: status,
            status_message: message,
            last_run_at: new Date().toISOString()
        }, { onConflict: 'key' });
    if (error) console.error('    [DB] Report Status Error:', error.message);
}

async function performSwap() {
    console.log('🔄 Performing Atomic Swap...');
    const { error } = await supabase.rpc('swap_plates_data');
    if (error) {
        console.error('    [DB] Swap Error:', error.message);
        await reportStatus('FAILED', 'Atomic Swap Failed: ' + error.message);
    } else {
        console.log('✅ Production data updated successfully.');
    }
}

// Helper to select and dispatch events
const selectWithEvent = async (page, selector, value) => {
    await page.waitForSelector(selector);
    await page.select(selector, value);
    await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) {
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('input', { bubbles: true }));
            if (el.onchange) el.onchange();
        }
    }, selector);
};

async function processStation(page, deptId, station) {
    const startTime = Date.now();
    console.log(`\n--- Processing Station: ${station.name} (ID: ${station.id}, Dept: ${deptId}) ---\n`);
    
    let platesFound = 0;
    let retries = 0;
    let status = 'SUCCESS';

    const { error: delError } = await supabase
        .from('available_plates_staging')
        .delete()
        .eq('station_id', station.id)
        .eq('region_id', deptId);
        
    if (delError) console.error(`    [DB] Failed to clear old staging data: ${delError.message}`);
    
    const plateTypes = ['g'];
    if (!station.no_rental) plateTypes.push('h');

    const isHighRisk = HIGH_RISK_STATIONS.includes(station.id);
    let lastLatency = isHighRisk ? 5000 : 2000; 
    if (isHighRisk) console.log(`    ⚠️ High Risk Station detected. Enabling throttling mode.`);

    for (const pType of plateTypes) {
        const typeName = pType === 'g' ? 'Private (g)' : 'Rental (h)';
        console.log(`  > Querying: ${typeName}`);

        let attempts = 0;
        let success = false;
        let collectedPlates = [];
        const maxQueryAttempts = 10;
        const resultWaitTimeout = 30000;

        while (attempts < maxQueryAttempts && !success) {
            attempts++;
            if (attempts > 1) retries++;

            console.log(`    [Attempt ${attempts}/${maxQueryAttempts}] Navigating and filling form...`);
            let navSuccess = false;
            let navAttempts = 0;
            while (navAttempts < 3 && !navSuccess) {
                navAttempts++;
                try {
                    const navStart = Date.now();
                    await page.goto(MVDIS_URL, { waitUntil: 'networkidle2', timeout: 60000 });
                    lastLatency = Date.now() - navStart;
                    
                    await page.evaluate(() => {
                        if (typeof $ !== 'undefined' && $.unblockUI) $.unblockUI();
                        const closeBtn = Array.from(document.querySelectorAll('a, button, input'))
                            .find(el => el.innerText?.includes('關閉') || el.value?.includes('關閉'));
                        if (closeBtn) closeBtn.click();
                    });
                    await sleep(1000);
                    navSuccess = true;
                } catch (e) {
                    console.warn(`    [Network] Navigation attempt ${navAttempts} failed: ${e.message}`);
                    await randomSleep(2000, 5000);
                }
            }

            if (!navSuccess) throw new Error("Critical navigation failure");
            await adaptiveSleep(1000, 2000, lastLatency);

            // Fill Form
            console.log('    [Form] Selecting Fields Strictly...');
            await selectWithEvent(page, '#selDeptCode', deptId);
            await sleep(1500);
            await selectWithEvent(page, '#selStationCode', station.id);
            await sleep(1500);
            await selectWithEvent(page, '#selWindowNo', '01');
            await sleep(1000);
            await selectWithEvent(page, '#selCarType', 'C');
            await selectWithEvent(page, '#selEnergyType', 'E');
            await sleep(1500);
            await selectWithEvent(page, '#selPlateType', pType);
            await sleep(1000);

            // Radio Plate Style
            await page.evaluate(() => {
                const radios = document.getElementsByName('plateVer');
                if (radios.length > 0) {
                    const target = Array.from(radios).find(r => r.value === '2') || radios[0];
                    target.click();
                }
            });
            await sleep(1000);

            // Solve Captcha
            let code = null;
            let captchaAttempts = 0;
            while (!code && captchaAttempts < 5) {
                captchaAttempts++;
                try {
                    const rawCode = await solveCaptcha(page);
                    if (rawCode && rawCode.length === 4) code = rawCode;
                    else {
                        const refreshBtn = document.querySelector('#pickimg + a') || document.querySelector('a[onclick*="pickimg"]');
                        if (refreshBtn) await refreshBtn.click();
                        await waitForImage(page, '#pickimg');
                        await sleep(1000);
                    }
                } catch (e) {}
            }

            if (!code) continue;

            // Submit with Sync
            await page.focus('#validateStr');
            await page.type('#validateStr', code, { delay: 100 });
            await page.evaluate((c) => {
                if (typeof dwr !== 'undefined' && dwr.util) dwr.util.setValue('validateStr', c);
                const win = document.querySelector('#selWindowNo');
                const loc = document.querySelector('#location');
                const meth = document.querySelector('#method');
                if (win && loc) loc.value = win.options[win.selectedIndex]?.text || '';
                if (meth) meth.value = 'qryPickNo';
            }, code);
            await sleep(1500);

            let alertMsg = null;
            const dialogHandler = async d => { alertMsg = d.message(); await d.dismiss(); };
            page.on('dialog', dialogHandler);

            const queryStart = Date.now();
            const submitResult = await doSubmit(page);
            console.log(`    [Form] Submit triggered via: ${submitResult}`);

            try {
                await page.waitForFunction(
                    () => {
                        const h1 = document.querySelector('h1')?.innerText || '';
                        return h1.includes('--') || document.querySelector('.number_cell') || document.body.innerText.includes('查無資料');
                    },
                    { timeout: resultWaitTimeout }
                );
                success = true;
            } catch (e) {
                console.log(`    [Fail] Result wait timeout, final check...`);
                const finalCheck = await page.evaluate(() => document.querySelector('.number_cell') !== null);
                if (finalCheck) success = true;
                else {
                    const timestamp = Date.now();
                    const fullHtml = await page.content();
                    fs.writeFileSync(`logs/debug_fail_${timestamp}.html`, fullHtml);
                    await page.screenshot({ path: `logs/debug_fail_${timestamp}.png` });
                }
            }
            page.off('dialog', dialogHandler);
            if (!success && attempts < maxQueryAttempts) await randomSleep(5000, 10000);
        }

        if (success) {
            let hasNext = true;
            while (hasNext) {
                const info = await parsePageInfo(page);
                if (info.noData) { hasNext = false; continue; }
                await sleep(500);
                const plates = await page.evaluate(() => {
                    const cells = document.querySelectorAll('.number_cell');
                    return Array.from(cells).map(el => ({
                        no: el.querySelector('.number')?.innerText.trim(),
                        price: el.querySelector('.price')?.innerText.split('元')[0].replace(/,/g, '').trim()
                    })).filter(x => x.no);
                });
                if (plates.length > 0) collectedPlates.push(...plates);
                if (info.current < info.total) {
                    let nextBtn = await page.$('input[name="status_next_page"]') || await page.$('#next');
                    if (nextBtn) { await nextBtn.click(); await randomSleep(1500, 3000); }
                    else hasNext = false;
                } else hasNext = false;
            }
            if (collectedPlates.length > 0) {
                const uniquePlates = Array.from(new Map(collectedPlates.map(p => [p.no, p])).values());
                await supabase.from('available_plates_staging').insert(
                    uniquePlates.map(p => ({
                        station_id: station.id, station_name: station.name, region_id: deptId,
                        plate_type: pType, window_id: '01', plate_no: p.no, price: parseInt(p.price) || 0,
                        updated_at: new Date().toISOString(), status: 'AVAILABLE'
                    }))
                );
                console.log(`    [DB] Staged ${uniquePlates.length} plates.`);
                stats.totalPlates += uniquePlates.length;
                platesFound += uniquePlates.length;
            }
        } else {
            console.error(`    [Fail] Station ${station.name} failed.`);
            stats.stationsFailed++;
            status = 'FAILED';
        }
    }
    const duration = ((Date.now() - startTime) / 1000);
    console.log(`⏱️  Station ${station.name} finished in ${duration.toFixed(2)}s`);
    if (status !== 'FAILED') stats.stationsSuccess++;
    stats.addStationStat({ id: station.id, name: station.name, region: getRegion(station.id), duration_sec: duration, plates_found: platesFound, retries: retries, status: status });
}


// --- Execution Entry ---

(async () => {
    const totalStartTime = Date.now();
    try {
        await loadStationData();
    } catch (err) {
        console.error('Fatal: Failed to initialize station data', err);
        process.exit(1);
    }

    console.log(`🚀 Starting Stealth Plate Sync v2 (${MODEL_NAME})...`);
    if (PROXY_URL) console.log(`🌐 Using Proxy: ${PROXY_URL.split('@').pop()}`);

    const launchArgs = [
        '--no-sandbox', 
        '--disable-setuid-sandbox', 
        '--window-size=1920,1080',
        '--disable-blink-features=AutomationControlled',
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        '--disable-dev-shm-usage', // Critical for Docker/VM with limited /dev/shm
        '--disable-gpu',           // Save resources
        '--no-zygote',             // Save resources
        '--single-process'         // Experimental: might save memory, try if unstable
    ];

    if (PROXY_URL) {
        // Only extract the host:port for the --proxy-server flag
        const proxyHost = PROXY_URL.includes('@') ? PROXY_URL.split('@')[1] : PROXY_URL.replace('http://', '').replace('https://', '');
        launchArgs.push(`--proxy-server=${proxyHost}`);
    }

    const browser = await puppeteer.launch({
        headless: "new",
        args: launchArgs
    });

    try {
        const page = await browser.newPage();
        
        // Handle Proxy Auth if provided
        if (PROXY_URL && PROXY_URL.includes('@')) {
            const authPart = PROXY_URL.split('://')[1].split('@')[0];
            const [username, password] = authPart.split(':');
            await page.authenticate({ username, password });
        }
        
        // Extra Stealth Headers
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
            'Referer': 'https://www.mvdis.gov.tw/'
        });

        await page.setViewport({ width: 1920, height: 1080 });

        const syncKey = TARGET_SHARD ? `plates_sync_shard_${TARGET_SHARD}` : 'plates_full_sync';
        await reportStatus('RUNNING', null, syncKey);
        
        // ONLY clear if explicitly NOT in shard mode
        if (TARGET_SHARD === null) {
            await clearStaging();
        }

        for (const deptId of Object.keys(TARGET_DEPTS)) {
            const stations = TARGET_DEPTS[deptId];
            console.log(`\n=== Dept ${deptId} (${stations.length} stations) ===`);

            for (const station of stations) {
                await processStation(page, deptId, station);
                console.log('☕ Quota protection break (2-4s)...');
                await randomSleep(1000, 2000);
            }
            console.log('☕☕ Dept finished. Short break...');
            await randomSleep(1500, 2500);
        }

        // Only perform swap if running in full mode (legacy). 
        // In Shard mode, swap is handled by a separate Finalizer Job.
        if (TARGET_SHARD === null) {
            await performSwap();
        } else {
            console.log('✨ Shard sync complete. Waiting for Finalizer to swap.');
        }

        const { count } = await supabase.from('available_plates_staging').select('*', { count: 'exact', head: true });
        if (count === 0 && !TARGET_SHARD) {
            stats.status = 'WARNING';
            await reportStatus('WARNING', 'Sync completed but 0 plates found.', syncKey);
        } else {
            stats.status = 'COMPLETED';
            await reportStatus('COMPLETED', null, syncKey);
        }

    } catch (e) {
        console.error('Fatal Error:', e);
        stats.status = 'FAILED';
        stats.addError('GLOBAL', e.message);
        const syncKey = TARGET_SHARD ? `plates_sync_shard_${TARGET_SHARD}` : 'plates_full_sync';
        await reportStatus('FAILED', e.message, syncKey);
    } finally {
        if (browser) {
            try {
                await browser.close();
            } catch (err) {
                console.error('Error closing browser gracefully:', err.message);
            }
        }
        await stats.save();
        const totalDuration = ((Date.now() - totalStartTime) / 1000).toFixed(2);
        console.log(`🏁 Sync Complete. Total duration: ${totalDuration}s`);
        
        // Force kill any remaining chrome processes to prevent memory leaks on e2-micro
        try {
            const { exec } = require('child_process');
            if (process.platform === 'linux') {
                exec('pkill -f chrome');
            }
        } catch (e) {
            // Ignore kill errors
        }
        
        process.exit(0);
    }
})();
