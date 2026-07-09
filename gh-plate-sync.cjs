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
// 純解析邏輯抽到 lib，與回歸測試共用單一真理（test/plate-parser.test.cjs）
const { extractPlates, parsePageInfoFromDoc } = require('./lib/plate-parser.cjs');
// Gemini/Gemma 備援階梯純函式，與回歸測試共用單一真理（test/ai-model-ladder.test.cjs）
const { MODEL_LADDER, EXHAUSTED, LadderState, classifyQuotaError, isServerError, QUOTA_PER_DAY, resolveShardKeys } = require('./lib/ai-model-ladder.cjs');
// CAPTCHA 回應嚴格 4 字元截取純函式，與回歸測試共用單一真理（test/captcha-parser.test.cjs）
const { extractCaptchaCode } = require('./lib/captcha-parser.cjs');

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

// One log file per day per shard; auto-delete files older than 7 days
const shardSuffix = (process.argv.find(a => a.startsWith('--shard=')) || '').replace('--shard=', '') || 'ALL';
const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
const logFile = fs.createWriteStream(path.join(logDir, `crawler_${shardSuffix}_${todayStr}.log`), { flags: 'a' });
try {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    fs.readdirSync(logDir).forEach(f => {
        if (!f.startsWith('crawler_')) return;
        const fp = path.join(logDir, f);
        if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
    });
} catch {}
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

// 2026-07-05：25 req/min 超過 Gemma 系列 RPM 上限 15，持續自撞 429。降至 12/min 留 buffer。
// AI_RATE_LIMIT_PER_MIN 可覆蓋（測試/緊急調整用）。
const AI_RATE_LIMIT_PER_MIN = parseInt(process.env.AI_RATE_LIMIT_PER_MIN, 10) || 12;
const geminiLimiter = new RateLimiter(AI_RATE_LIMIT_PER_MIN, 60000);

// --- Config ---
const envPath = fs.existsSync('.env.development') ? '.env.development' : '.env';
require('dotenv').config({ path: envPath });

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PROXY_URL = process.env.PROXY_URL;
const MODEL_NAME = MODEL_LADDER[0].model; // 僅供啟動 log 顯示用，實際模型由 AIManager 階梯狀態決定

if (!SUPABASE_URL || !SUPABASE_KEY || !GEMINI_API_KEY) {
    console.error("Missing required env vars.");
    process.exit(1);
}

const MVDIS_URL = 'https://www.mvdis.gov.tw/m3-emv-plate/webpickno/queryPickNo';
// 監理服務網首頁：施工/維護期間會顯示「今日施工中」公告頁。
// 重點：首頁「不」封鎖非台灣 IP（只有選號功能頁 m3-emv-plate 才擋 IP），
// 因此即使 WARP 出口跑到美國、選號頁全 timeout，仍可靠首頁判斷是否為官方施工。
const MVDIS_HOME_URL = 'https://www.mvdis.gov.tw/';

// Parse Arguments
const args = process.argv.slice(2);
const shardArg = args.find(arg => arg.startsWith('--shard='));
const TARGET_SHARD = shardArg ? shardArg.split('=')[1] : null;

// --- AI Manager (Failover Support) ---
//
// 狀態機純邏輯在 lib/ai-model-ladder.cjs 的 LadderState（可測）；此處只做 I/O（API 呼叫、
// 退避 sleep、log、SDK 重建）。2026-07-05 三次修正，依三 shard 實戰 log：
// - 階梯（sticky 只升不降）：gemma-4-26b-a4b-it(敗3) → gemma-4-31b-it(敗2)
//   → gemini-3.1-flash-lite(敗2) → gemini-3-flash-preview(敗1) → EXHAUSTED。
// - 連續失敗才升級：成功呼叫重置當前層失敗計數（v1 累計語義讓中區在多次成功之間
//   累積零星 500 也升級到已死的 31B——已修）。
// - key 協同：同一層先試 shard key（GEMINI_API_KEY_{SHARD}），該 (key, model) 被日配額
//   標死才試 DEFAULT key（GEMINI_API_KEY），兩者皆死才升層。取代 v1 的 sticky
//   switchToFallback——v1 任何 429（含分鐘級）都永久切到 DEFAULT key，會把三個 shard
//   的分鐘級突發全壓到同一把共用 key 上，反而害它也被限流。
// - 429 分流：quotaId 含 PerDay → 該 (key, model) 本輪標死、立即跳選，絕不退避重試；
//   PerMinute 或無 PerDay 字樣 → 退避（RetryInfo.retryDelay 或 20s）同 combo 重試 1 次，
//   成功不計數。
// - 5xx → 退避 5-10 秒同 combo 重試 1 次，成功不計數，再失敗才計入升級門檻。
// 狀態 per-instance/per-process：三個 shard 各自獨立，不共用不寫檔。
class AIManager {
    constructor(shard) {
        this.shard = shard;

        // key 解析純函式（lib/ai-model-ladder.cjs 的 resolveShardKeys，與回歸測試共用
        // 單一真理）：shard 模式下缺該 shard 專屬 key 直接 throw，快速失敗、絕不
        // 靜默落回只用 DEFAULT key 硬跑（見 test/shard-key-resolve.test.cjs）。
        try {
            this.keysByName = resolveShardKeys(shard, process.env);
        } catch (e) {
            console.error(`[AI] Fatal: ${e.message}`);
            process.exit(1);
        }

        this.ladder = new LadderState(Array.from(this.keysByName.keys()));
        this.instance = null;
        this.model = null;
        this.init();
    }

    // 「本次實際使用」的模型／key——所有 log 標籤讀這裡，不讀基礎常數 MODEL_NAME
    // （v1 bug：solveCaptcha 標籤印基礎模型、實際打的是升級後模型，除錯被誤導）。
    get modelName() { return this.ladder.model; }
    get currentKeyName() { return this.ladder.keyName; }

    init() {
        this.instance = new GoogleGenerativeAI(this.keysByName.get(this.currentKeyName));
        this.model = this.instance.getGenerativeModel({
            model: this.modelName,
            // 2026-07-05：26B 實戰會把整段思考碎念吐進回應（例："M8L_ (Wait, let me
            // look closer)... Let's try: MN8L.MN8L"）。補一句更直白的硬約束；
            // 解析端另有 lib/captcha-parser.cjs 做嚴格截取兜底，兩層防禦。
            systemInstruction: "You are a specialized CAPTCHA solver. Your ONLY task is to output the 4 characters found in the image. DO NOT explain. DO NOT use thinking process. DO NOT output anything except the 4 characters. 只輸出驗證碼的4個字元，禁止任何其他文字或解釋。",
            // temperature:0 壓制隨機性、減少模型「碎碎念」的空間；maxOutputTokens 壓到
            // 剛好夠放 4 字元的量（留一點餘裕給模型可能加的前綴），物理上斬斷長篇思考過程。
            generationConfig: {
                temperature: 0,
                maxOutputTokens: 16,
            },
        });
        console.log(`[AI] Initialized using: ${this.currentKeyName} / model: ${this.modelName}`);
    }

    async generateContent(payload) {
        // 迴圈有界：日配額死亡矩陣單調成長（≤ keys×tiers 個組合）、分鐘級/5xx 退避
        // 各限重試 1 次（per-call 旗標）、一般失敗要嘛升級（≤ 層數次）要嘛 throw。
        let minuteRetried = false;
        let serverRetried = false;
        for (;;) {
            // EXHAUSTED 之後 ladder 仍指向最後一個（已死）combo：快速失敗，絕不再打已標死組合。
            if (this.ladder.isCurrentComboDead()) {
                throw new Error(`[AI] 階梯耗盡：所有 (key, model) 組合本輪已標死（最後停在 ${this.currentKeyName}/${this.modelName}）`);
            }
            try {
                const result = await this.model.generateContent(payload);
                this.ladder.recordSuccess(); // 連續失敗語義：任何成功都重置當前層失敗計數
                return result;
            } catch (e) {
                const quota = classifyQuotaError(e);

                // 日配額耗盡（quotaId 含 PerDay）→ 該 (key, model) 本輪標死、立即跳選。
                // RetryInfo.retryDelay 對日配額無意義，絕不退避重試。
                if (quota.isQuotaError && quota.quotaWindow === QUOTA_PER_DAY) {
                    const deadCombo = `${this.currentKeyName}/${this.modelName}`;
                    const prevTier = this.ladder.tierIndex;
                    const next = this.ladder.markCurrentComboDead();
                    console.log(`💀 [AI] 日配額耗盡，標死 ${deadCombo}（本輪不再嘗試）`);
                    if (next === EXHAUSTED) {
                        console.log('🛑 [AI] 所有 (key, model) 組合皆已標死，交回既有失敗處理。');
                        throw e;
                    }
                    const kind = next.tierIndex === prevTier ? '同層換 key' : '跳層';
                    console.log(`🔀 [AI] ${kind} → ${this.currentKeyName}/${this.modelName}`);
                    this.init();
                    continue;
                }

                // 分鐘級限流（PerMinute 或 429 但無 PerDay 字樣）→ 退避後同 combo 重試
                // 1 次，成功不計入升級門檻；再失敗落入下方一般計數。
                if (quota.isQuotaError && !minuteRetried) {
                    minuteRetried = true;
                    const waitMs = quota.retryAfterMs || 20000;
                    console.log(`⏳ [AI] ${this.currentKeyName}/${this.modelName} 分鐘級限流，退避 ${Math.ceil(waitMs / 1000)}s 後同層重試（不計入升級門檻）...`);
                    await new Promise((resolve) => setTimeout(resolve, waitMs));
                    continue;
                }

                // 5xx 暫時性錯誤 → 退避 5-10 秒同 combo 重試 1 次；重試成功不計數
                // （26B 間歇性 500 不該讓它被踢下主力層），再失敗落入下方一般計數。
                if (isServerError(e) && !serverRetried) {
                    serverRetried = true;
                    const waitMs = 5000 + Math.floor(Math.random() * 5000); // 5-10 秒
                    console.log(`⏳ [AI] ${this.currentKeyName}/${this.modelName} 5xx 暫時性錯誤，退避 ${Math.round(waitMs / 1000)}s 後同層重試 1 次（不計入升級門檻）...`);
                    await new Promise((resolve) => setTimeout(resolve, waitMs));
                    continue;
                }

                // 一般 API 層失敗：連續失敗計數 +1，達門檻升級（自動跳過已標死 combo）。
                const before = `${this.currentKeyName}/${this.modelName}`;
                const outcome = this.ladder.recordFailure();
                if (!outcome.escalated) {
                    // 未達門檻（計數保留待下次）或已無層可升——丟回呼叫端既有失敗處理。
                    throw e;
                }
                console.log(`⚠️  [AI] ${before} 連續失敗達門檻，升級 → ${this.currentKeyName}/${this.modelName}`);
                this.init();
                continue;
            }
        }
    }
}

// Multi-Key Sharding Setup
const aiManager = new AIManager(TARGET_SHARD);

// --- Clients ---
let supabase = null;

function initSupabase() {
    if (!supabase) {
        // Use node-fetch for better stability in GitHub Actions + WARP
        const fetch = require('node-fetch');
        supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
            auth: { persistSession: false },
            global: {
                fetch: (url, options) => {
                    return fetch(url, options).catch(err => {
                        console.error(`[FetchError] ${err.name}: ${err.message} (Target: ${url})`);
                        throw err;
                    });
                }
            }
        });
    }
    return supabase;
}

// Global state for stations (populated later)
let TARGET_DEPTS = {};
let totalStations = 0;

async function loadStationData() {
    initSupabase();
    console.log('📥 Loading station configuration from DB...');
    let data = null;
    let error = null;
    let retries = 5;
    
    while (retries > 0) {
        try {
            const result = await supabase
                .from('system_configs')
                .select('value')
                .eq('key', 'mvdis_stations')
                .single();
            data = result.data;
            error = result.error;
            
            if (!error && data) break;
            
            if (error) {
                console.log(`    [Retry] Supabase error: ${error.message}. Retries left: ${retries - 1}`);
            }
        } catch (e) {
            console.log(`    [Retry] Fetch exception: ${e.name}: ${e.message}. Retries left: ${retries - 1}`);
        }
        
        retries--;
        if (retries > 0) {
            const waitTime = (6 - retries) * 10000; // Increased to 10s, 20s, 30s, 40s
            console.log(`    [Retry] Waiting ${waitTime/1000}s before next attempt...`);
            await new Promise(r => setTimeout(r, waitTime));
        }
    }

    if (error) {
        console.error('Failed to load station config. SUPABASE_URL:', SUPABASE_URL ? 'PRESENT' : 'MISSING');
        throw new Error(`Failed to load station config: ${error.message}`);
    }
    if (!data) throw new Error('Station config not found in DB');

    const stationData = data.value;
    
    stationData.forEach(dept => {
        const stations = dept.stations.filter(s => {
            if (!TARGET_SHARD) return true;
            return s.shard && s.shard.toUpperCase() === TARGET_SHARD.toUpperCase();
        });
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
    
    // 標籤必印「本次實際呼叫的模型/key」（讀 aiManager 即時狀態），不可印基礎常數
    // MODEL_NAME——v1 曾印基礎模型、實際打升級後模型，實戰除錯被誤導。
    console.log(`    [AI] Solving CAPTCHA (${aiManager.modelName} @ ${aiManager.currentKeyName})...`);
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

        // Minimal prompt since systemInstruction handles the constraints
        const prompt = "Characters in image:";
        
        const result = await aiManager.generateContent([
            prompt,
            { inlineData: { data: imageBuffer, mimeType: "image/jpeg" } }
        ]);
        const response = await result.response;
        const rawText = response.text().trim();

        // 嚴格截取（lib/captcha-parser.cjs）：抓不到合格 4 字元候選一律回傳 null，
        // 絕不再用 slice(-4) 從碎念裡硬湊出「看起來像答案」的垃圾字串——那種字串
        // 送進表單必壞，還會觸發最貴的完整重導航循環。null 由呼叫端視為本地失敗、
        // 重打 AI（不消耗 API 層失敗計數，因為這是解析失敗不是 API 失敗）。
        const text = extractCaptchaCode(rawText);

        if (text) {
            console.log(`    [AI] Predicted: ${text} (Raw: ${rawText.replace(/\n/g, ' ')})`);
            stats.captchaSuccess++;
        } else {
            console.log(`    [AI] 本地解析失敗，抓不到合格 4 字元候選，拒絕提交 (Raw: ${rawText.replace(/\n/g, ' ')})`);
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
    // 解析邏輯見 lib/plate-parser.cjs（與回歸測試共用，page.evaluate 序列化後在 browser 執行）
    return page.evaluate(parsePageInfoFromDoc);
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

// 將監理站施工/維護狀態寫入單一 row（key='mvdis_service_status'），供前端車牌選號助手讀取顯示橫幅。
// 三個 shard 並行皆會寫此 row：施工時內容相同（無衝突）；無施工時各 shard 都寫 NORMAL，
// 施工結束後最多一輪（30 分鐘）即收斂為 NORMAL，前端橫幅自動消失。
async function reportServiceStatus(isMaintenance, message = null) {
    const { error } = await supabase
        .from('sync_metadata')
        .upsert({
            key: 'mvdis_service_status',
            status: isMaintenance ? 'MAINTENANCE' : 'NORMAL',
            status_message: isMaintenance ? message : null,
            last_run_at: new Date().toISOString()
        }, { onConflict: 'key' });
    if (error) console.error('    [DB] Service Status Error:', error.message);
}

// 偵測監理服務網首頁是否為「今日施工中」官方施工頁。
// 自包 try/catch：任何失敗都回傳 isMaintenance=false（degrade 回原 preflight 流程），
// 絕不因偵測失敗而讓爬蟲整體崩潰。
async function checkMaintenanceNotice(page) {
    try {
        await page.goto(MVDIS_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const result = await page.evaluate(() => {
            const bodyText = (document.body && document.body.innerText) || '';
            // 「今日施工中」為監理站施工頁的官方即時標題（mobile 為 h1、桌面為 h2，故以文字判斷不依賴標籤）
            const isMaintenance = bodyText.includes('今日施工中');
            if (!isMaintenance) return { isMaintenance: false, message: null };

            // 抽出公告全文：優先取含日期/時段關鍵字的那一段，退而取「施工」鄰近文字
            const lines = bodyText.split('\n').map(s => s.trim()).filter(Boolean);
            const noticeLine = lines.find(l =>
                /\d+年\d+月\d+日/.test(l) || l.includes('時止') || l.includes('維護作業')
            );
            return {
                isMaintenance: true,
                message: noticeLine || '監理服務網系統施工維護中，選號服務暫停。'
            };
        });
        return result;
    } catch (e) {
        console.log(`[Maintenance Check] 無法判斷施工狀態（${e.message}），改走正常 preflight。`);
        return { isMaintenance: false, message: null };
    }
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

const waitForImage = async (page, selector, timeout = 10000) => {
    try {
        await page.waitForFunction(
            (sel) => {
                const img = document.querySelector(sel);
                return img && img.complete && img.naturalWidth > 0;
            },
            { timeout },
            selector
        );
        return true;
    } catch (e) {
        return false;
    }
};

async function preflightCheck(page) {
    // Stage 1: Verify Chrome's network service is working at all
    console.log('🔍 Pre-flight [1/2]: Testing Chrome network (example.com)...');
    try {
        await page.goto('http://example.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
        console.log('✅ Chrome network OK');
    } catch (e) {
        console.error(`❌ Chrome cannot navigate to example.com: ${e.message}`);
        console.error('   → Chrome network service broken. Check: --disable-features=NetworkServiceSandbox');
        return false;
    }

    // Show Chrome's actual outbound IP (what MVDIS sees)
    try {
        await page.goto('https://ipinfo.io/json', { waitUntil: 'domcontentloaded', timeout: 15000 });
        const ipData = await page.evaluate(() => {
            try { return JSON.parse(document.body.innerText); } catch { return null; }
        });
        if (ipData) {
            console.log(`🌐 Chrome outbound IP: ${ipData.ip} (${ipData.country || '?'} / ${ipData.org || '?'})`);
            if (ipData.country !== 'TW') {
                console.warn(`⚠️  Chrome IP is ${ipData.country}, NOT TW — MVDIS may block browser connections.`);
                console.warn('   → Fix: set PROXY_URL secret to a Taiwan HTTP/SOCKS5 proxy.');
                console.warn('   → e.g. PROXY_URL=http://user:pass@tw-proxy-host:port');
            }
        }
    } catch (e) {
        console.log(`[IP Check] Could not determine Chrome IP: ${e.message}`);
    }

    // Stage 2: Verify MVDIS is reachable
    console.log('🔍 Pre-flight [2/2]: Testing MVDIS connectivity...');
    for (let i = 0; i < 3; i++) {
        try {
            const response = await page.goto(MVDIS_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
            if (response) {
                console.log(`✅ MVDIS reachable (HTTP ${response.status()})`);
                return true;
            }
        } catch (e) {
            console.log(`❌ MVDIS attempt ${i + 1}/3 failed: ${e.message}`);
            if (i < 2) await sleep(8000);
        }
    }
    console.error('   → Chrome reached example.com but NOT MVDIS.');
    console.error('   → MVDIS requires Taiwan IP for browser connections. Set PROXY_URL secret.');
    return false;
}

async function processStation(page, deptId, station) {
    const startTime = Date.now();
    console.log(`\n--- Processing Station: ${station.name} (ID: ${station.id}, Dept: ${deptId}) ---\n`);
    
    let platesFound = 0;
    let retries = 0;
    let status = 'SUCCESS';

    // 清理舊資料
    await supabase.from('available_plates_staging').delete().eq('station_id', station.id).eq('region_id', deptId);
    
    const plateTypes = ['g'];
    if (!station.no_rental) plateTypes.push('h');

    let isFirstQueryInStation = true;
    let stationAborted = false;

    for (const pType of plateTypes) {
        if (stationAborted) break;
        const typeName = pType === 'g' ? 'Private (g)' : 'Rental (h)';
        console.log(`  > Querying: ${typeName}`);

        let attempts = 0;
        let success = false;
        let collectedPlates = [];
        const maxQueryAttempts = 10;

        while (attempts < maxQueryAttempts && !success) {
            attempts++;
            if (attempts > 1) retries++;

            // 1. 導覽與填表
            if (isFirstQueryInStation || attempts > 1) {
                console.log(`    [Attempt ${attempts}] Full Nav...`);
                let navOk = false;
                for (let navTry = 0; navTry < 3; navTry++) {
                    try {
                        await page.goto(MVDIS_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
                        navOk = true;
                        break;
                    } catch (navErr) {
                        console.log(`    [Nav] Attempt ${navTry + 1}/3 failed: ${navErr.message}`);
                        if (navTry < 2) await sleep(8000);
                    }
                }
                if (!navOk) {
                    console.log('    [Nav] All navigation attempts failed, skipping station.');
                    status = 'FAILED';
                    stationAborted = true;
                    break;
                }
                await page.evaluate(() => {
                    if (typeof $ !== 'undefined' && $.unblockUI) $.unblockUI();
                    const btn = Array.from(document.querySelectorAll('a, button, input')).find(el => el.innerText?.includes('關閉') || el.value?.includes('關閉'));
                    if (btn) btn.click();
                });
                await sleep(1000);
                await selectWithEvent(page, '#selDeptCode', deptId); await sleep(1200);
                await selectWithEvent(page, '#selStationCode', station.id); await sleep(1200);
                await selectWithEvent(page, '#selWindowNo', '01'); await sleep(800);
                await selectWithEvent(page, '#selCarType', 'C');
                await selectWithEvent(page, '#selEnergyType', 'E'); await sleep(1200);
                await selectWithEvent(page, '#selPlateType', pType); await sleep(800);
                await page.evaluate(() => {
                    const radios = document.getElementsByName('plateVer');
                    if (radios.length > 0) (Array.from(radios).find(r => r.value === '2') || radios[0]).click();
                });
            } else {
                console.log('    [Action] Quick Re-query...');
                await page.evaluate(() => {
                    const btn = document.querySelector('a[onclick*="doReturnWithData"]');
                    if (btn) btn.click();
                });
                await page.waitForSelector('#selPlateType', { timeout: 10000 });
                await selectWithEvent(page, '#selPlateType', pType);
                await sleep(1000);
            }

            // 2. 驗證碼辨識
            let code = null;
            let captchaAttempts = 0;
            while (!code && captchaAttempts < 5) {
                captchaAttempts++;
                await page.evaluate(() => {
                    const btn = document.querySelector('#pickimg + a') || document.querySelector('a[onclick*="pickimg"]');
                    if (btn) btn.click();
                });
                await waitForImage(page, '#pickimg');
                await sleep(1000);
                const rawCode = await solveCaptcha(page);
                if (rawCode && rawCode.length === 4) code = rawCode;
            }

            if (!code) continue;

            // 3. 提交表單
            await page.focus('#validateStr');
            await page.type('#validateStr', code, { delay: 50 });
            await page.evaluate((c) => {
                const win = document.querySelector('#selWindowNo');
                const loc = document.querySelector('#location');
                const meth = document.querySelector('#method');
                if (win && loc) loc.value = win.options[win.selectedIndex]?.text || '';
                if (meth) meth.value = 'qryPickNo';
                if (typeof dwr !== 'undefined' && dwr.util) dwr.util.setValue('validateStr', c);
            }, code);
            await sleep(1000);

            let alertMsg = null;
            const dialogHandler = async d => { alertMsg = d.message(); await d.dismiss(); };
            page.on('dialog', dialogHandler);
            
            const trigger = await doSubmit(page);
            console.log(`    [Form] Submit triggered (${trigger}), waiting for results...`);

            // 4. 暴力偵測結果 (每 2 秒檢查一次，最多 15 次 = 30秒)
            for (let i = 0; i < 15; i++) {
                await sleep(2000);
                const pageInfo = await page.evaluate(() => {
                    const h1 = document.querySelector('h1')?.innerText || '';
                    const body = document.body?.innerText || "";
                    return {
                        isResult: h1.includes('--') || document.querySelector('.number_cell') !== null,
                        isNoData: body.includes('截至目前為止') || body.includes('查無資料'),
                        isError: body.includes('驗證數字輸入錯誤') || body.includes('請輸入驗證數字')
                    };
                });

                if (alertMsg || pageInfo.isError) {
                    console.log(`    [Fail] Captcha Error detected.`);
                    break; 
                }
                if (pageInfo.isResult || pageInfo.isNoData) {
                    console.log(`    [Success] Results rendered (IsResult: ${pageInfo.isResult}, NoData: ${pageInfo.isNoData})`);
                    success = true;
                    break;
                }
                process.stdout.write('.'); // 打印進度點
            }

            page.off('dialog', dialogHandler);
            if (!success) console.log('\n    [Wait] No confirmed state found, retrying...');
        }

        if (success) {
            isFirstQueryInStation = false;
            let hasNext = true;
            while (hasNext) {
                const info = await parsePageInfo(page);
                if (info.noData) { hasNext = false; continue; }
                // 抽號邏輯見 lib/plate-parser.cjs（與回歸測試共用）
                const plates = await page.evaluate(extractPlates);
                if (plates.length > 0) collectedPlates.push(...plates);
                if (info.current < info.total) {
                    const nextBtn = await page.$('input[name="status_next_page"]') || await page.$('#next');
                    if (nextBtn) { await nextBtn.click(); await sleep(3000); }
                    else hasNext = false;
                } else hasNext = false;
            }
            if (collectedPlates.length > 0) {
                const uniquePlates = Array.from(new Map(collectedPlates.map(p => [p.no, p])).values());
                
                let insertRetries = 3;
                while (insertRetries > 0) {
                    try {
                        const { error } = await supabase.from('available_plates_staging').insert(uniquePlates.map(p => ({
                            station_id: station.id, station_name: station.name, region_id: deptId,
                            plate_type: pType, window_id: '01', plate_no: p.no, price: parseInt(p.price) || 0,
                            updated_at: new Date().toISOString(), status: 'AVAILABLE'
                        })));
                        if (!error) break;
                        console.log(`    [Retry] DB Insert error: ${error.message}. Retries left: ${insertRetries - 1}`);
                    } catch (e) {
                        console.log(`    [Retry] DB Insert fetch exception: ${e.message}. Retries left: ${insertRetries - 1}`);
                    }
                    insertRetries--;
                    if (insertRetries > 0) await new Promise(r => setTimeout(r, 3000));
                }
                
                console.log(`    [DB] Staged ${uniquePlates.length} plates.`);
                stats.totalPlates += uniquePlates.length;
                platesFound += uniquePlates.length;
            }
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
    console.log('⏳ Waiting 5s for network to stabilize...');
    await new Promise(r => setTimeout(r, 5000));

    // Add wider jitter based on shard to avoid simultaneous hits to Supabase
    if (TARGET_SHARD) {
        // 2026-07-05：3→5 分片，5 個 shard 錯開 20s 間隔避免同時打 Supabase。
        const jitterMap = { 'NORTH': 0, 'CENTRAL': 20000, 'SOUTH': 40000, 'SHARD4': 60000, 'SHARD5': 80000 };
        const shardJitter = jitterMap[TARGET_SHARD.toUpperCase()] || 0;
        if (shardJitter > 0) {
            console.log(`⏳ Adding ${shardJitter/1000}s jitter for shard ${TARGET_SHARD} to prevent parallel collision...`);
            await new Promise(r => setTimeout(r, shardJitter));
        }
    }
    
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
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-features=NetworkServiceSandbox',  // Chrome 120+: allow network service in container
        '--window-size=1920,1080',
        '--disable-blink-features=AutomationControlled',
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
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

        // 施工偵測（先於選號 preflight）：首頁不擋非台灣 IP，可在 WARP 異常時仍區分
        // 「官方施工」與「純 IP/WARP 連線問題」。偵測到施工→寫狀態給前端橫幅、正常結束（不噴 FAILED）。
        const maintenance = await checkMaintenanceNotice(page);
        if (maintenance.isMaintenance) {
            console.log(`🚧 偵測到監理站施工公告，跳過本次選號：${maintenance.message}`);
            await reportServiceStatus(true, maintenance.message);
            stats.status = 'MAINTENANCE';
            await reportStatus('MAINTENANCE', `監理站施工中：${maintenance.message}`, syncKey);
            return; // 跳過選號，交由 finally 正常關閉瀏覽器並結束（非錯誤路徑）
        }
        // 無施工：清除施工狀態，讓前端橫幅消失
        await reportServiceStatus(false, null);

        // Pre-flight: verify MVDIS is reachable before processing any station
        const preflight = await preflightCheck(page);
        if (!preflight) {
            const errMsg = 'Pre-flight failed: MVDIS unreachable after 3 attempts. WARP may not be routing Taiwan traffic.';
            console.error(`❌ ${errMsg}`);
            stats.status = 'FAILED';
            stats.addError('PREFLIGHT', errMsg);
            await reportStatus('FAILED', errMsg, syncKey);
            throw new Error(errMsg);
        }

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
        
        process.exit(stats.status === 'FAILED' ? 1 : 0);
    }
})();
