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
    }

    addError(station, error) {
        const msg = `${station}: ${error}`;
        this.errors.push(msg);
        console.error(`    [Stats] Error added: ${msg}`);
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

        const imageBuffer = await captchaEl.screenshot({ encoding: 'base64' });

        const prompt = "Output only the 4 characters in this image. No markdown, no spaces.";
        const result = await model.generateContent([
            prompt,
            { inlineData: { data: imageBuffer, mimeType: "image/jpeg" } }
        ]);
        const response = await result.response;
        const text = response.text().trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        console.log(`    [AI] Predicted: ${text}`);
        
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
    return page.evaluate(() => {
        if (typeof window.doSubmit === 'function') {
            window.doSubmit();
        }
    });
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

async function processStation(page, deptId, station) {
    const startTime = Date.now();
    console.log(`\n--- Processing Station: ${station.name} (ID: ${station.id}, Dept: ${deptId}) ---
`);
    
    // Metrics variables
    let platesFound = 0;
    let retries = 0;
    let status = 'SUCCESS';

    // Clean up staging for this station & dept only to prevent accidental overlap deletion
    const { error: delError } = await supabase
        .from('available_plates_staging')
        .delete()
        .eq('station_id', station.id)
        .eq('region_id', deptId);
        
    if (delError) console.error(`    [DB] Failed to clear old staging data: ${delError.message}`);
    
    const plateTypes = ['g'];
    if (!station.no_rental) plateTypes.push('h');

    // Throttling for high risk stations:
    // If station is in high risk list, start with high latency to force slow mode
    // and prevent adaptive speedup from kicking in too early.
    const isHighRisk = HIGH_RISK_STATIONS.includes(station.id);
    let lastLatency = isHighRisk ? 5000 : 2000; 

    if (isHighRisk) console.log(`    ⚠️ High Risk Station detected. Enabling throttling mode.`);

    for (const pType of plateTypes) {
        const typeName = pType === 'g' ? 'Private (g)' : 'Rental (h)';
        console.log(`  > Querying: ${typeName}`);

        // Robust Navigation with Retries & Longer Timeout
        let navSuccess = false;
        let navAttempts = 0;
        while (navAttempts < 3 && !navSuccess) {
            navAttempts++;
            try {
                const navStart = Date.now();
                await page.goto(MVDIS_URL, { waitUntil: 'domcontentloaded', timeout: 180000 });
                lastLatency = Date.now() - navStart;
                if (process.env.NODE_ENV === 'development') console.log(`    [Network] Latency: ${lastLatency}ms`);
                navSuccess = true;
            } catch (e) {
                console.warn(`    [Network] Navigation attempt ${navAttempts} failed: ${e.message}`);
                if (navAttempts < 3) await randomSleep(2000, 5000);
                else throw e; // Fatal after 3 retries
            }
        }
        await adaptiveSleep(800, 1500, lastLatency);

        await page.select('#selDeptCode', deptId);
        await adaptiveSleep(800, 1200, lastLatency);

        await page.select('#selStationCode', station.id);
        await adaptiveSleep(800, 1200, lastLatency);

        try {
            await page.waitForSelector('#selWindowNo option[value="01"]', { timeout: 10000 });
            await page.select('#selWindowNo', '01');
        } catch (e) {
            await page.evaluate(() => {
                const opts = document.querySelectorAll('#selWindowNo option');
                if (opts.length > 1) opts[1].selected = true;
            });
        }
        await adaptiveSleep(600, 1000, lastLatency);

        await page.select('#selCarType', 'C');
        await adaptiveSleep(400, 800, lastLatency);
        await page.select('#selEnergyType', 'E');
        await adaptiveSleep(800, 1500, lastLatency);

        const typeExists = await page.evaluate((val) => {
            return !!document.querySelector(`#selPlateType option[value="${val}"]`);
        }, pType);

        if (!typeExists) {
            console.log(`    [Skip] Plate type ${pType} not available.`);
            continue;
        }
        await page.select('#selPlateType', pType);
        await adaptiveSleep(600, 1000, lastLatency);

        let attempts = 0;
        let success = false;
        let collectedPlates = [];
        
        // Standardized robust settings for ALL stations
        const maxQueryAttempts = 10;
        const resultWaitTimeout = 30000;

        while (attempts < maxQueryAttempts && !success) {
            attempts++;
            if (attempts > 1) retries++; // Count retries
            
            // Step 1: Solve Captcha (Inner Loop)
            // We try to get a valid 4-char code up to 5 times before giving up on this attempt.
            let code = null;
            let captchaAttempts = 0;
            
            while (!code && captchaAttempts < 5) {
                captchaAttempts++;
                
                // Refresh if not first try
                if (captchaAttempts > 1 || attempts > 1) {
                    console.log(`    [Captcha Retry ${captchaAttempts}/5] Refreshing image...`);
                    try {
                        const refreshBtn = await page.$('#pickimg + a');
                        if (refreshBtn) await refreshBtn.click();
                        else await page.click('a[onclick*="pickimg"]');
                    } catch (e) {
                        console.warn('    [Warn] Refresh click failed, continuing...');
                    }
                    await randomSleep(1000, 3000);
                }

                try {
                    const rawCode = await solveCaptcha(page);
                    
                    // Check logic: Must be 4 chars
                    if (rawCode && rawCode.length === 4) {
                        code = rawCode;
                    } else {
                        console.log(`    [AI] Invalid length (${rawCode ? rawCode.length : 0}). Retrying...`);
                    }
                } catch (aiError) {
                    // Handle API Overloaded (503) or other AI errors
                    console.warn(`    [AI] Error: ${aiError.message}`);
                    if (aiError.message.includes('503') || aiError.message.includes('Overloaded')) {
                        console.log('    [AI] Model overloaded. Sleeping 30s...');
                        await sleep(30000); 
                    }
                }
            }

            if (!code) {
                console.error('    [Fail] Failed to get valid CAPTCHA after 5 tries. Restarting station flow...');
                continue; // Consumes 1 main attempt
            }

            // Step 2: Submit Form
            await humanType(page, '#validateStr', code);
            
            let alertMsg = null;
            const dialogHandler = async dialog => {
                alertMsg = dialog.message();
                await dialog.dismiss();
            };
            page.on('dialog', dialogHandler);

            const queryStart = Date.now();
            await doSubmit(page);

            try {
                await page.waitForFunction(
                    () => document.querySelector('.number_cell') || document.body.innerText.includes('查無資料'),
                    { timeout: resultWaitTimeout }
                );
                lastLatency = Date.now() - queryStart;
                
                if (alertMsg) {
                    console.log(`    [Fail] Alert: ${alertMsg}`);
                    // Alert means wrong captcha. This consumes 1 main attempt.
                } else {
                    success = true;
                }
            } catch (e) {
                if (alertMsg) console.log(`    [Fail] Alert: ${alertMsg}`);
                else console.log(`    [Fail] Result timeout after ${resultWaitTimeout}ms.`);
            }
            
            page.off('dialog', dialogHandler);
            
            // If failed, cool down before next main attempt
            if (!success && attempts < maxQueryAttempts) {
                 await randomSleep(5000, 10000);
            }
        }

        if (success) {
                        let hasNext = true;
                        
                        while (hasNext) {
                            // Parse Pagination Info from Text (More robust than checking button existence)
                            const info = await parsePageInfo(page);
            
                            if (info.noData) {
                                console.log(`    [Skip] No plates available at this station.`);
                                hasNext = false;
                                continue;
                            }
            
                            // Wait a bit for table to render
                            await sleep(500);
            
                            // Collect Plates safely
                            const plates = await page.evaluate(() => {
                                const cells = document.querySelectorAll('.number_cell');
                                if (!cells || cells.length === 0) return [];
                                
                                return Array.from(cells).map(el => ({
                                    no: el.querySelector('.number')?.innerText.trim(),
                                    price: el.querySelector('.price')?.innerText.split('元')[0].replace(/,/g, '').trim()
                                })).filter(x => x.no);
                            });
                            
                            if (plates.length > 0) {
                                collectedPlates.push(...plates);
                            }
            
                            console.log(`    [Page ${info.current}/${info.total}] Found ${plates.length} plates (Exp Total: ${info.count})`);
            
                            if (info.current < info.total || info.hasNextButton) {                                let nextBtn = await page.$('input[name="status_next_page"]');
                                if (!nextBtn) nextBtn = await page.$('#next'); // Try alternative selector

                                if (nextBtn) {
                                    await nextBtn.click();
                                    // Pagination is critical. Keep conservative sleep.
                                    await randomSleep(1500, 3000);
                                } else {
                                    hasNext = false; 
                                }
                            } else {
                                hasNext = false;
                            }
                        }
            if (collectedPlates.length > 0) {
                const now = new Date().toISOString();
                const uniquePlatesMap = new Map();
                collectedPlates.forEach(p => {
                    if (p.no) uniquePlatesMap.set(p.no, p);
                });
                const finalPlates = Array.from(uniquePlatesMap.values());

                const { error } = await supabase.from('available_plates_staging').insert(
                    finalPlates.map(p => ({
                        station_id: station.id,
                        station_name: station.name,
                        region_id: deptId,
                        plate_type: pType,
                        window_id: '01',
                        plate_no: p.no,
                        price: parseInt(p.price) || 0,
                        updated_at: now,
                        status: 'AVAILABLE'
                    }))
                );
                
                if (error) {
                    console.error('    [DB] Upsert Error:', error.message);
                    stats.addError(station.name, `DB Staging Error: ${error.message}`);
                } else {
                    console.log(`    [DB] Staged ${finalPlates.length} plates (Total: ${collectedPlates.length}).`);
                    stats.totalPlates += finalPlates.length;
                    platesFound += finalPlates.length;
                }
            }
        } else {
            console.error(`    [Fail] Station ${station.name} abandoned after retries.`);
            stats.stationsFailed++;
            stats.addError(station.name, "Max attempts reached or navigation failed.");
            status = 'FAILED';
        }

        await randomSleep(1000, 2000);
    }
    
    // Calculate and save station metrics
    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000); // Keep as number for JSON
    console.log(`⏱️  Station ${station.name} finished in ${duration.toFixed(2)}s`);
    
    if (status !== 'FAILED') stats.stationsSuccess++;

    stats.addStationStat({
        id: station.id,
        name: station.name,
        region: getRegion(station.id),
        duration_sec: duration,
        plates_found: platesFound,
        retries: retries,
        status: status
    });
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
