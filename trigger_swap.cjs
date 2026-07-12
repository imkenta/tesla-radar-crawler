const { createClient } = require('@supabase/supabase-js');
const { processPlateSubscriptions } = require('./lib/subscription-notify.cjs');
const { SHARD_NAMES } = require('./lib/shard-config.cjs');
require('dotenv').config();

// 最低筆數／最大下降比例保護：擋「幾乎全空但非 0」或「相對正式表暴跌」的殘缺批次。
// DB 端 swap_plates_data() 也有 20% 熔斷，這裡在呼叫 RPC 前先擋一層，讓
// trigger_swap.cjs 能明確 exit 非 0，不必等 RPC 側靜默 TRUNCATE 才發現。
const MIN_STAGING_COUNT = 50;
const MAX_DROP_RATIO = 0.2;
// Shard 新鮮度窗口：finalize job 緊接在 5 個 shard 之後跑（各 shard 逾時 45 分鐘），
// 2 小時窗口足夠涵蓋排隊延遲，又能抓到「shard sync_metadata 是很久以前的殘留」。
const SHARD_FRESHNESS_WINDOW_MS = 2 * 60 * 60 * 1000;

const url = process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
    console.error('Error: Missing Supabase credentials.');
    process.exit(1);
}

let supabase = null;
function initSupabase() {
    if (!supabase) {
        const fetch = require('node-fetch');
        supabase = createClient(url, key, {
            auth: { persistSession: false },
            global: {
                fetch: (url, options) => fetch(url, options).catch(err => {
                    console.error(`[FetchError] ${err.name}: ${err.message} (Target: ${url})`);
                    throw err;
                })
            }
        });
    }
    return supabase;
}

async function safeQuery(operation, maxRetries = 5) {
    let retries = maxRetries;
    while (retries > 0) {
        try {
            const result = await operation();
            if (!result.error) return result;
            console.log(`    [Retry] Supabase error: ${result.error.message}. Retries left: ${retries - 1}`);
        } catch (e) {
            console.log(`    [Retry] Fetch exception: ${e.name}: ${e.message}. Retries left: ${retries - 1}`);
        }
        retries--;
        if (retries > 0) {
            const waitTime = (maxRetries + 1 - retries) * 5000;
            console.log(`    [Retry] Waiting ${waitTime/1000}s...`);
            await new Promise(r => setTimeout(r, waitTime));
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
        console.warn(`[Bounce Check] Failed to check bounce list for ${email}:`, e.message);
        return false; // 查不到就不擋，讓寄信繼續
    }
}

async function markEmailBounced(supabase, email, reason) {
    try {
        await supabase
            .from('email_bounce_list')
            .upsert({ email, reason, bounced_at: new Date().toISOString(), bounce_count: 1 }, { onConflict: 'email' });
        console.log(`[Email Bounce] ${email} 已標記為 hard bounce，日後不再寄信。原因：${reason}`);
    } catch (e) {
        console.error(`[Bounce Mark] 無法標記 ${email}:`, e.message);
    }
}

// ---

async function sendEmail(supabase, to, subject, html) {
    // Hard bounce 守衛：已在退信名單則直接跳過
    if (await isEmailBounced(supabase, to)) {
        console.log(`[Email Skip] ${to} 在 hard bounce 名單中，跳過寄信。`);
        return false;
    }

    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;

    if (!smtpUser || !smtpPass) {
        console.log(`[Email Log] (Dry Run - No SMTP Config) to: ${to}, subject: ${subject}\nContent:\n${html}\n`);
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
        console.log(`[SMTP Email] Sent email successfully to ${to} via ${smtpUser}`);
        return true;
    } catch (err) {
        console.error(`[SMTP Email Error] Failed to send email to ${to}:`, err.message);
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

async function processSoldNotifications() {
    console.log('🔔 Checking for sold watchlist plates...');
    const supabase = initSupabase();

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

        for (const item of removed) {
            const { data: watches, error: watchErr } = await supabase
                .from('watchlist')
                .select('*')
                .eq('plate_no', item.plate_no)
                .eq('source', 'available');

            if (watchErr || !watches || watches.length === 0) continue;

            for (const watch of watches) {
                console.log(`🚨 Alert! Watchlist plate ${item.plate_no} has been sold/removed. Notifying ${watch.email}`);
                
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

                const emailSuccess = await sendEmail(
                    supabase,
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
        console.error('[Watchlist] Process sold notifications exception:', e.message);
    }
}

async function run() {
    console.log('🔄 Triggering Final Swap...');
    const supabase = initSupabase();

    // Safety Check 1：確認所有 shard 都真的跑完且狀態新鮮。理論上 workflow 的
    // needs+if:success() 已經擋住任一 shard 失敗，這裡加一層獨立驗證，避免將來
    // 有人繞過 workflow gate 手動跑本檔、或某個 shard 靜默沒寫 sync_metadata。
    for (const shard of SHARD_NAMES) {
        const shardKey = `plates_sync_shard_${shard}`;
        const { data: shardMeta, error: shardMetaError } = await safeQuery(() => supabase
            .from('sync_metadata')
            .select('status, last_run_at')
            .eq('key', shardKey)
            .maybeSingle());

        if (shardMetaError) {
            console.error(`❌ Failed to check sync_metadata for shard ${shard}:`, shardMetaError.message);
            process.exit(1);
        }
        if (!shardMeta) {
            console.error(`❌ Shard ${shard} has no sync_metadata row (${shardKey}). Aborting swap.`);
            process.exit(1);
        }
        if (shardMeta.status !== 'COMPLETED') {
            console.error(`❌ Shard ${shard} status is "${shardMeta.status}" (expected COMPLETED). Aborting swap.`);
            process.exit(1);
        }
        const ageMs = Date.now() - new Date(shardMeta.last_run_at).getTime();
        if (!Number.isFinite(ageMs) || ageMs > SHARD_FRESHNESS_WINDOW_MS) {
            console.error(`❌ Shard ${shard} last_run_at is stale (${shardMeta.last_run_at}). Aborting swap.`);
            process.exit(1);
        }
    }
    console.log(`✅ All ${SHARD_NAMES.length} shards reported COMPLETED and fresh.`);

    // Safety Check 2：最低筆數 + 相對正式表的下降比例。
    const { count, error: countError } = await safeQuery(() => supabase
        .from('available_plates_staging')
        .select('*', { count: 'exact', head: true }));

    if (countError) {
        console.error('❌ Failed to check staging count:', countError.message);
        process.exit(1);
    }

    if (count === 0) {
        console.log('⚠️ Staging table is empty. Skipping swap to prevent data loss.');
        console.log('   (This usually happens when crawlers are in cooldown mode)');
        return; // Exit safely without swapping
    }

    if (count < MIN_STAGING_COUNT) {
        console.error(`❌ Staging has only ${count} records (< floor ${MIN_STAGING_COUNT}). Aborting swap to avoid publishing a partial batch.`);
        process.exit(1);
    }

    const { count: prodCount, error: prodCountError } = await safeQuery(() => supabase
        .from('available_plates')
        .select('*', { count: 'exact', head: true }));

    if (prodCountError) {
        console.error('❌ Failed to check production count:', prodCountError.message);
        process.exit(1);
    }

    if (prodCount > 0) {
        const dropRatio = (prodCount - count) / prodCount;
        if (dropRatio > MAX_DROP_RATIO) {
            console.error(`❌ Staging count dropped ${(dropRatio * 100).toFixed(1)}% vs production (${prodCount} → ${count}), exceeds ${(MAX_DROP_RATIO * 100).toFixed(0)}% floor. Aborting swap.`);
            process.exit(1);
        }
    }

    console.log(`✅ Staging has ${count} records. Proceeding with swap...`);

    const { error } = await safeQuery(() => supabase.rpc('swap_plates_data'));

    if (error) {
        console.error('❌ Swap Failed:', error.message);
        process.exit(1);
    }

    // swap_plates_data() 是 void RPC：熔斷觸發時只把 sync_metadata.status 寫成
    // SKIPPED_CIRCUIT_BREAKER 並清空 staging，不會回傳 error。必須回讀確認，
    // 否則下面會把它覆寫成 COMPLETED（false green）。
    const { data: metaAfterSwap, error: metaAfterSwapError } = await safeQuery(() => supabase
        .from('sync_metadata')
        .select('status, status_message')
        .eq('key', 'plates_full_sync')
        .maybeSingle());

    if (metaAfterSwapError) {
        console.error('❌ Failed to verify swap result:', metaAfterSwapError.message);
        process.exit(1);
    }

    if (metaAfterSwap?.status === 'SKIPPED_CIRCUIT_BREAKER') {
        console.error(`❌ Circuit breaker tripped, swap skipped: ${metaAfterSwap.status_message || ''}`);
        process.exit(1);
    }

    const successMsg = `同步完成，共抓取 ${count} 筆資料`;
    console.log(`✅ ${successMsg}. Production data updated.`);

    // Update main metadata status
    await safeQuery(() => supabase.from('sync_metadata').upsert({
        key: 'plates_full_sync',
        status: 'COMPLETED',
        status_message: successMsg,
        last_run_at: new Date().toISOString()
    }, { onConflict: 'key' }));

    // Process sold notifications for watchlist
    await processSoldNotifications();

    // 號碼訂閱：現貨表已是最新全集，比對使用者登記的想要號碼並通知（每張牌一次）
    await processPlateSubscriptions({
        supabase,
        sendEmail: (to, subject, html) => sendEmail(supabase, to, subject, html),
    });
}

run();
