const { createClient } = require('@supabase/supabase-js');
const { processPlateSubscriptions } = require('./lib/subscription-notify.cjs');
const { SHARD_NAMES } = require('./lib/shard-config.cjs');
const { fetchWatchesByPlate } = require('./lib/watchlist-lookup.cjs');
const { findDuplicateKeys, fetchAllStagingKeys } = require('./lib/staging-duplicates.cjs');
const { maskEmail, redactEmails, safeErrorMessage } = require('./lib/mask-email.cjs');

// 最低筆數／最大下降比例保護：擋「幾乎全空但非 0」或「相對正式表暴跌」的殘缺批次。
// 這是唯一的一道防線：線上 swap_plates_data() 沒有熔斷（2026-10-14 以
// pg_get_functiondef 實查；tesla-studio 的 20251229_add_circuit_breaker*.sql 被同日
// 較晚套用的 20251229_fix_swap_logic.sql 覆寫），staging 非空就直接 TRUNCATE 正式表換上。
const MIN_STAGING_COUNT = 50;
const MAX_DROP_RATIO = 0.2;
// Shard 新鮮度窗口：finalize job 緊接在 5 個 shard 之後跑（各 shard 逾時 45 分鐘），
// 2 小時窗口足夠涵蓋排隊延遲，又能抓到「shard sync_metadata 是很久以前的殘留」。
const SHARD_FRESHNESS_WINDOW_MS = 2 * 60 * 60 * 1000;

// 2026-11-10：本檔改成 `require.main === module` 才執行（可被測試 import）。
// ⛔ dotenv／env 檢查／建立 Supabase client 一律留在 main()：被 require 時絕不能連線上庫。
let supabase = null;
function initSupabase() {
    if (!supabase) {
        const url = process.env.VITE_SUPABASE_URL;
        const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!url || !key) {
            console.error('Error: Missing Supabase credentials.');
            process.exit(1);
        }
        const fetch = require('node-fetch');
        supabase = createClient(url, key, {
            auth: { persistSession: false },
            global: {
                // 查詢 URL 可能帶 `email=eq.xxx`（.eq('email', …)），node-fetch 的錯誤訊息也會夾整條 URL → 一律遮罩
                fetch: (reqUrl, options) => fetch(reqUrl, options).catch(err => {
                    console.error(`[FetchError] ${err.name}: ${redactEmails(err.message)} (Target: ${redactEmails(String(reqUrl))})`);
                    throw err;
                })
            }
        });
    }
    return supabase;
}

const defaultSleep = (ms) => new Promise(r => setTimeout(r, ms));

async function safeQuery(operation, maxRetries = 5, sleep = defaultSleep) {
    let retries = maxRetries;
    while (retries > 0) {
        try {
            const result = await operation();
            if (!result.error) return result;
            console.log(`    [Retry] Supabase error: ${redactEmails(result.error.message)}. Retries left: ${retries - 1}`);
        } catch (e) {
            console.log(`    [Retry] Fetch exception: ${e.name}: ${safeErrorMessage(e)}. Retries left: ${retries - 1}`);
        }
        retries--;
        if (retries > 0) {
            const waitTime = (maxRetries + 1 - retries) * 5000;
            console.log(`    [Retry] Waiting ${waitTime/1000}s...`);
            await sleep(waitTime);
        }
    }
    return { error: { message: 'Max retries reached' } };
}

// --- Hard bounce helpers ---

async function isEmailBounced(supabase, email) {
    try {
        const { data } = await supabase
            .from('email_bounce_list')
            .select('id')
            .eq('email', email)
            .maybeSingle();
        return !!data;
    } catch (e) {
        console.warn(`[Bounce Check] Failed to check bounce list for ${maskEmail(email)}:`, safeErrorMessage(e));
        return false; // 查不到就不擋，讓寄信繼續
    }
}

async function markEmailBounced(supabase, email, reason) {
    try {
        await supabase
            .from('email_bounce_list')
            .upsert({ email, reason, bounced_at: new Date().toISOString(), bounce_count: 1 }, { onConflict: 'email' });
        console.log(`[Email Bounce] ${maskEmail(email)} 已標記為 hard bounce，日後不再寄信。原因：${redactEmails(reason)}`);
    } catch (e) {
        console.error(`[Bounce Mark] 無法標記 ${maskEmail(email)}:`, safeErrorMessage(e));
    }
}

// ---

async function sendEmail(supabase, to, subject, html) {
    // Hard bounce 守衛：已在退信名單則直接跳過
    if (await isEmailBounced(supabase, to)) {
        console.log(`[Email Skip] ${maskEmail(to)} 在 hard bounce 名單中，跳過寄信。`);
        return false;
    }

    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;

    if (!smtpUser || !smtpPass) {
        // 公開 log：只印遮罩後的收件人與主旨，不印整封信內容
        console.log(`[Email Log] (Dry Run - No SMTP Config) to: ${maskEmail(to)}, subject: ${redactEmails(subject)}`);
        return true;
    }

    try {
        const nodemailer = require('nodemailer');
        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST || 'smtp.gmail.com',
            port: parseInt(process.env.SMTP_PORT || '465'),
            secure: process.env.SMTP_SECURE !== 'false',
            auth: {
                user: smtpUser,
                pass: smtpPass
            }
        });

        const fromName = process.env.EMAIL_FROM_NAME || 'Tesla Studio';
        await transporter.sendMail({
            from: `"${fromName}" <${smtpUser}>`,
            to: to,
            subject: subject,
            html: html
        });
        console.log(`[SMTP Email] Sent email successfully to ${maskEmail(to)}`);
        return true;
    } catch (err) {
        // err.message 可能夾帶收件人（如 "Recipient address rejected: <addr>"）→ 遮罩後再印
        console.error(`[SMTP Email Error] Failed to send email to ${maskEmail(to)}:`, safeErrorMessage(err));
        // 550 = mailbox not found（hard bounce），寫入退信名單
        const isHardBounce =
            err.responseCode === 550 ||
            (err.response && err.response.startsWith('550')) ||
            (err.message && err.message.includes('5.1.1'));
        if (isHardBounce) {
            await markEmailBounced(supabase, to, err.message);
        }
        return false;
    }
}

async function processSoldNotifications(supabase, send) {
    console.log('🔔 Checking for sold watchlist plates...');

    try {
        // 1. Get the latest change batch time
        const { data: latestChange, error: changeErr } = await supabase
            .from('plate_changes')
            .select('detected_at')
            .order('detected_at', { ascending: false })
            .limit(1)
            .single();

        if (changeErr || !latestChange) {
            console.log('ℹ️ No change records found.');
            return;
        }

        // 2. Fetch all REMOVED plates in this batch
        const { data: removed, error: removedErr } = await supabase
            .from('plate_changes')
            .select('plate_no, price, station_name')
            .eq('detected_at', latestChange.detected_at)
            .eq('change_type', 'REMOVED');

        if (removedErr || !removed || removed.length === 0) {
            console.log('ℹ️ No removed plates in the latest batch.');
            return;
        }

        console.log(`📊 Processing ${removed.length} removed plates...`);

        const watchesByPlate = await fetchWatchesByPlate(supabase, 'available', removed.map((r) => r.plate_no));

        for (const item of removed) {
            const watches = watchesByPlate.get(item.plate_no);
            if (!watches || watches.length === 0) continue;

            for (const watch of watches) {
                console.log(`🚨 Alert! Watchlist plate ${item.plate_no} has been sold/removed. Notifying ${maskEmail(watch.email)}`);
                
                const mailHtml = `
                    <div style="font-family: sans-serif; padding: 20px; max-width: 600px; border: 1px solid #eee; border-radius: 8px;">
                        <h2 style="color: #e82127; margin-bottom: 20px;">Tesla Studio - 收藏車牌售出通知</h2>
                        <p>您所收藏的現貨車牌 <strong style="font-size: 1.2em; color: #111;">${item.plate_no}</strong> 已被選走（售出）！</p>
                        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                            <tr style="background: #f9f9f9;"><td style="padding: 10px; border: 1px solid #ddd; font-weight: bold;">號牌號碼</td><td style="padding: 10px; border: 1px solid #ddd; font-weight: bold;">${item.plate_no}</td></tr>
                            <tr><td style="padding: 10px; border: 1px solid #ddd; font-weight: bold;">原掛轄監理站</td><td style="padding: 10px; border: 1px solid #ddd;">${item.station_name || '監理站'}</td></tr>
                            <tr style="background: #f9f9f9;"><td style="padding: 10px; border: 1px solid #ddd; font-weight: bold;">選號價格</td><td style="padding: 10px; border: 1px solid #ddd;">NT$ ${parseFloat(item.price || 2000).toLocaleString()} 元</td></tr>
                        </table>
                        <p style="color: #666; margin-top: 30px;">該車牌已從監理站選號清單中移除，若您尚未完成領牌手續，表示該號牌已被他人選購。</p>
                        <p style="margin-top: 20px;">
                            <a href="https://teslastudio.netlify.app" style="background: #e82127; color: white; padding: 12px 24px; text-decoration: none; border-radius: 99px; font-weight: bold; display: inline-block;">前往選號助手尋找其他號牌</a>
                        </p>
                        <hr style="border: 0; border-top: 1px solid #eee; margin: 30px 0;" />
                        <p style="font-size: 0.8em; color: #999;">此信件為系統自動發送，請勿直接回覆。該車牌已售出，系統已自動將其自您的收藏清單中清除。</p>
                    </div>
                `;

                const emailSuccess = await send(
                    watch.email,
                    `[Tesla Studio] 收藏車牌 ${item.plate_no} 已被選走（售出）！`,
                    mailHtml
                );

                if (emailSuccess) {
                    // Delete watchlist record
                    await supabase
                        .from('watchlist')
                        .delete()
                        .eq('id', watch.id);
                }
            }
        }
    } catch (e) {
        console.error('[Watchlist] Process sold notifications exception:', safeErrorMessage(e));
    }
}

// ============================================================
// swap 守門：純函式（回傳 null＝通過；物件＝不通過，message 為要印的錯誤訊息）。
// run() 只負責取資料與依結果結束，判斷邏輯集中在這裡以便單元測試。
// ============================================================

/**
 * Safety Check 1：單一 shard 的 sync_metadata 必須存在、COMPLETED、且在新鮮度窗口內。
 * @param {string} shard
 * @param {{meta: object|null, error: object|null, now?: number}} input
 */
function checkShardMeta(shard, { meta, error, now = Date.now() }) {
    const shardKey = `plates_sync_shard_${shard}`;
    if (error) {
        return { message: `❌ Failed to check sync_metadata for shard ${shard}: ${redactEmails(error.message)}` };
    }
    if (!meta) {
        return { message: `❌ Shard ${shard} has no sync_metadata row (${shardKey}). Aborting swap.` };
    }
    if (meta.status !== 'COMPLETED') {
        return { message: `❌ Shard ${shard} status is "${meta.status}" (expected COMPLETED). Aborting swap.` };
    }
    const ageMs = now - new Date(meta.last_run_at).getTime();
    if (!Number.isFinite(ageMs) || ageMs > SHARD_FRESHNESS_WINDOW_MS) {
        return { message: `❌ Shard ${shard} last_run_at is stale (${meta.last_run_at}). Aborting swap.` };
    }
    return null;
}

/**
 * Safety Check 2a：staging 筆數。count===0 → skip（安全略過，不算失敗）；< 下限 → abort。
 * @returns {null | {skip: true, message: string} | {message: string}}
 */
function checkStagingCount(count) {
    if (count === 0) {
        return { skip: true, message: '⚠️ Staging table is empty. Skipping swap to prevent data loss.' };
    }
    if (count < MIN_STAGING_COUNT) {
        return { message: `❌ Staging has only ${count} records (< floor ${MIN_STAGING_COUNT}). Aborting swap to avoid publishing a partial batch.` };
    }
    return null;
}

/** Safety Check 3：staging 重複鍵（雙 writer 重複寫入只會「變多」，下降閘擋不到）。 */
function checkDuplicateKeys(stagingKeys) {
    const duplicateKeys = findDuplicateKeys(stagingKeys);
    if (duplicateKeys.length > 0) {
        return { message: `❌ Staging has ${duplicateKeys.length} duplicated plate keys (e.g. ${duplicateKeys.slice(0, 3).map(d => `${d.key}×${d.count}`).join(', ')}). Aborting swap.` };
    }
    return null;
}

/** Safety Check 2b：相對正式表的下降比例。 */
function checkDropRatio(prodCount, count) {
    if (prodCount > 0) {
        const dropRatio = (prodCount - count) / prodCount;
        if (dropRatio > MAX_DROP_RATIO) {
            return { message: `❌ Staging count dropped ${(dropRatio * 100).toFixed(1)}% vs production (${prodCount} → ${count}), exceeds ${(MAX_DROP_RATIO * 100).toFixed(0)}% floor. Aborting swap.` };
        }
    }
    return null;
}

/**
 * swap 後回讀 plates_full_sync：若日後重新套用熔斷版，它是 void RPC，觸發時只把
 * status 寫成 SKIPPED_CIRCUIT_BREAKER、不回傳 error（見 run() 內說明）。
 */
function checkCircuitBreaker(meta) {
    if (meta?.status === 'SKIPPED_CIRCUIT_BREAKER') {
        return { message: `❌ Circuit breaker tripped, swap skipped: ${meta.status_message || ''}` };
    }
    return null;
}

/**
 * 執行 swap 流程，回傳 exit code（0＝成功或安全略過，1＝失敗）。
 * 不直接呼叫 process.exit，方便測試；main 依回傳值設定 process.exitCode。
 *
 * @param {object} [ctx]
 * @param {object} [ctx.supabase]    注入的 client（測試用；預設 initSupabase()）
 * @param {Function} [ctx.safeQuery] 注入的查詢包裝（測試用；預設含重試退避）
 * @param {Function} [ctx.sendEmail] (to, subject, html) => Promise<boolean>
 * @param {Function} [ctx.now]       () => ms
 */
async function run(ctx = {}) {
    console.log('🔄 Triggering Final Swap...');
    const supabase = ctx.supabase || initSupabase();
    const query = ctx.safeQuery || safeQuery;
    const send = ctx.sendEmail || ((to, subject, html) => sendEmail(supabase, to, subject, html));
    const now = ctx.now || Date.now;

    // Safety Check 1：確認所有 shard 都真的跑完且狀態新鮮。理論上 workflow 的
    // needs+if:success() 已經擋住任一 shard 失敗，這裡加一層獨立驗證，避免將來
    // 有人繞過 workflow gate 手動跑本檔、或某個 shard 靜默沒寫 sync_metadata。
    for (const shard of SHARD_NAMES) {
        const shardKey = `plates_sync_shard_${shard}`;
        const { data: shardMeta, error: shardMetaError } = await query(() => supabase
            .from('sync_metadata')
            .select('status, last_run_at')
            .eq('key', shardKey)
            .maybeSingle());

        const verdict = checkShardMeta(shard, { meta: shardMeta, error: shardMetaError, now: now() });
        if (verdict) {
            console.error(verdict.message);
            return 1;
        }
    }
    console.log(`✅ All ${SHARD_NAMES.length} shards reported COMPLETED and fresh.`);

    // Safety Check 2：最低筆數 + 相對正式表的下降比例。
    const { count, error: countError } = await query(() => supabase
        .from('available_plates_staging')
        .select('*', { count: 'exact', head: true }));

    if (countError) {
        console.error('❌ Failed to check staging count:', countError.message);
        return 1;
    }

    const countVerdict = checkStagingCount(count);
    if (countVerdict && countVerdict.skip) {
        console.log(countVerdict.message);
        console.log('   (This usually happens when crawlers are in cooldown mode)');
        return 0; // Exit safely without swapping
    }
    if (countVerdict) {
        console.error(countVerdict.message);
        return 1;
    }

    // Safety Check 3：重複鍵。下降閘只擋「變少」，雙 writer 重複寫入只會「變多」。
    const { rows: stagingKeys, error: stagingKeysError } = await fetchAllStagingKeys(supabase, query);
    if (stagingKeysError) {
        console.error('❌ Failed to read staging keys for duplicate check:', stagingKeysError.message);
        return 1;
    }
    const dupVerdict = checkDuplicateKeys(stagingKeys);
    if (dupVerdict) {
        console.error(dupVerdict.message);
        return 1;
    }

    const { count: prodCount, error: prodCountError } = await query(() => supabase
        .from('available_plates')
        .select('*', { count: 'exact', head: true }));

    if (prodCountError) {
        console.error('❌ Failed to check production count:', prodCountError.message);
        return 1;
    }

    const dropVerdict = checkDropRatio(prodCount, count);
    if (dropVerdict) {
        console.error(dropVerdict.message);
        return 1;
    }

    console.log(`✅ Staging has ${count} records. Proceeding with swap...`);

    const { error } = await query(() => supabase.rpc('swap_plates_data'));

    if (error) {
        console.error('❌ Swap Failed:', error.message);
        return 1;
    }

    // 防禦性回讀：線上 swap_plates_data() 目前沒有熔斷（見檔頭）。若日後重新套用
    // 熔斷版，它是 void RPC，觸發時只把 sync_metadata.status 寫成
    // SKIPPED_CIRCUIT_BREAKER、不回傳 error；不回讀的話下面會把它覆寫成
    // COMPLETED（false green）。
    const { data: metaAfterSwap, error: metaAfterSwapError } = await query(() => supabase
        .from('sync_metadata')
        .select('status, status_message')
        .eq('key', 'plates_full_sync')
        .maybeSingle());

    if (metaAfterSwapError) {
        console.error('❌ Failed to verify swap result:', metaAfterSwapError.message);
        return 1;
    }

    const breakerVerdict = checkCircuitBreaker(metaAfterSwap);
    if (breakerVerdict) {
        console.error(breakerVerdict.message);
        return 1;
    }

    const successMsg = `同步完成，共抓取 ${count} 筆資料`;
    console.log(`✅ ${successMsg}. Production data updated.`);

    // Update main metadata status
    // 2026-11-10：此時 swap 已上線，upsert 失敗只會讓 last_run_at 不更新（前端選號助手顯示「過時」）。
    // 必須印出明確錯誤並以非 0 結束；但不能中途退出——資料已換上，售出通知又是 at-most-once
    // （只處理最新一批 REMOVED），這輪不寄就永遠不會寄。
    let exitCode = 0;
    const { error: metaUpsertError } = await query(() => supabase.from('sync_metadata').upsert({
        key: 'plates_full_sync',
        status: 'COMPLETED',
        status_message: successMsg,
        last_run_at: new Date(now()).toISOString()
    }, { onConflict: 'key' }));
    if (metaUpsertError) {
        console.error(`❌ Swap succeeded but failed to update sync_metadata plates_full_sync: ${metaUpsertError.message}. Front-end "last updated" will be stale.`);
        exitCode = 1;
    }

    // Process sold notifications for watchlist
    await processSoldNotifications(supabase, send);

    // 號碼訂閱：現貨表已是最新全集，比對使用者登記的想要號碼並通知（每張牌一次）
    await processPlateSubscriptions({ supabase, sendEmail: send });

    return exitCode;
}

async function main() {
    require('dotenv').config();
    try {
        const code = await run();
        if (code) process.exitCode = code;
    } catch (e) {
        console.error('❌ trigger_swap fatal:', safeErrorMessage(e));
        process.exitCode = 1;
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    MIN_STAGING_COUNT,
    MAX_DROP_RATIO,
    SHARD_FRESHNESS_WINDOW_MS,
    safeQuery,
    sendEmail,
    checkShardMeta,
    checkStagingCount,
    checkDuplicateKeys,
    checkDropRatio,
    checkCircuitBreaker,
    run,
};
