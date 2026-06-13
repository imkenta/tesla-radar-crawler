/**
 * Standalone Crawler for MVDIS Bidding Plates (競標中號牌)
 * 
 * Target: https://www.mvdis.gov.tw/m3-emv-plate/bid/queryBiding
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const dotenv = require('dotenv');
const { processPlateSubscriptions } = require('./lib/subscription-notify.cjs');

puppeteer.use(StealthPlugin());

// --- Config ---
const envPath = fs.existsSync('.env.development') ? '.env.development' : '.env';
dotenv.config({ path: envPath });

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[BiddingPlatesSync] Missing required env vars.');
  process.exit(1);
}

// Initialize Supabase using node-fetch for stability
const fetch = require('node-fetch');
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
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

function parseMinguoDate(dateStr) {
  if (!dateStr) return null;
  const cleanStr = dateStr.trim().replace(/\s+/g, ' ');
  const match = cleanStr.match(/^(\d{3})(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const year = parseInt(match[1]) + 1911;
  const month = match[2];
  const day = match[3];
  const time = `${match[4]}:${match[5]}:${match[6]}`;
  return `${year}-${month}-${day}T${time}+08:00`;
}

// --- Hard bounce helpers ---

async function isEmailBounced(email) {
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

async function markEmailBounced(email, reason) {
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

async function sendEmail(to, subject, html) {
  // Hard bounce 守衛：已在退信名單則直接跳過
  if (await isEmailBounced(to)) {
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
      await markEmailBounced(to, err.message);
    }
    return false;
  }
}

async function loadActiveStations() {
  console.log('🔍 Querying active bidding stations from announcements...');
  const { data, error } = await supabase
    .from('bid_announcements')
    .select('section_code, station_code')
    .lte('start_time', new Date().toISOString())
    .gte('end_time', new Date().toISOString());

  if (error) {
    throw new Error(`Failed to load active announcements: ${error.message}`);
  }

  // Deduplicate
  const seen = new Set();
  const stations = [];
  for (const item of data || []) {
    const key = `${item.section_code}-${item.station_code}`;
    if (!seen.has(key)) {
      seen.add(key);
      stations.push({
        sectionCode: item.section_code,
        stationCode: item.station_code
      });
    }
  }

  return stations;
}

async function processWatchlistAlerts(plates) {
  console.log('🔔 Checking watchlist alerts for updated bids...');
  for (const plate of plates) {
    try {
      // Find watch records for this plate
      const { data: watches, error } = await supabase
        .from('watchlist')
        .select('*')
        .eq('plate_no', plate.plate_no)
        .eq('source', 'bidding');

      if (error) {
        console.error(`[Watchlist] Fetch watch error for ${plate.plate_no}:`, error.message);
        continue;
      }

      for (const watch of watches || []) {
        // Trigger alert if it's the first known bid or the bid has increased
        const lastBid = watch.last_known_bid ? parseFloat(watch.last_known_bid) : 0;
        const currentBid = parseFloat(plate.current_bid);

        if (!watch.last_known_bid || currentBid > lastBid) {
          console.log(`🚨 Alert! Bid price changed for ${plate.plate_no} (User: ${watch.email}, Price: ${lastBid} -> ${currentBid})`);
          
          const formattedEnd = new Date(plate.end_time).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
          const mailHtml = `
            <div style="font-family: sans-serif; padding: 20px; max-width: 600px; border: 1px solid #eee; border-radius: 8px;">
              <h2 style="color: #3b82f6; margin-bottom: 20px;">Tesla Studio - 收藏車牌出價變動通知</h2>
              <p>您所收藏的競標中車牌 <strong style="font-size: 1.2em; color: #111;">${plate.plate_no}</strong> 出價已更新！</p>
              <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                <tr style="background: #f9f9f9;"><td style="padding: 10px; border: 1px solid #ddd; font-weight: bold;">號牌類別</td><td style="padding: 10px; border: 1px solid #ddd;">${plate.plate_type}</td></tr>
                <tr><td style="padding: 10px; border: 1px solid #ddd; font-weight: bold;">目前出價</td><td style="padding: 10px; border: 1px solid #ddd; color: #e82127; font-weight: bold;">NT$ ${currentBid.toLocaleString()} 元</td></tr>
                <tr style="background: #f9f9f9;"><td style="padding: 10px; border: 1px solid #ddd; font-weight: bold;">出價次數</td><td style="padding: 10px; border: 1px solid #ddd;">${plate.bid_count} 次</td></tr>
                <tr><td style="padding: 10px; border: 1px solid #ddd; font-weight: bold;">決標時間</td><td style="padding: 10px; border: 1px solid #ddd;">${formattedEnd} (台灣時間)</td></tr>
              </table>
              <p style="margin-top: 30px;">
                <a href="https://www.mvdis.gov.tw/m3-emv-plate/bid/queryBiding" target="_blank" style="background: #3b82f6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 99px; font-weight: bold; display: inline-block;">前往監理所參與競標</a>
              </p>
              <hr style="border: 0; border-top: 1px solid #eee; margin: 30px 0;" />
              <p style="font-size: 0.8em; color: #999;">此信件為系統自動發送，請勿直接回覆。若想取消訂閱，請至 Tesla Studio 選號助手將該車牌自收藏清單中移除。</p>
            </div>
          `;

          const emailSuccess = await sendEmail(
            watch.email,
            `[Tesla Studio] 收藏車牌 ${plate.plate_no} 有新的出價！`,
            mailHtml
          );

          if (emailSuccess) {
            // Update last_known_bid in watchlist
            const { error: updateErr } = await supabase
              .from('watchlist')
              .update({ last_known_bid: currentBid })
              .eq('id', watch.id);
            if (updateErr) console.error('[Watchlist] Update watchlist bid error:', updateErr.message);
          }
        }
      }
    } catch (err) {
      console.error(`[Watchlist Error] Processing ${plate.plate_no}:`, err.message);
    }
  }
}

// (a) 結標結果通知：偵測已過 end_time（即將被清除）的競標牌，
// 通知 source='bidding' 的收藏者最終出價結果後，刪除其收藏（一次性）。
async function processEndedAuctions() {
  console.log('🔔 Checking for ended bidding auctions (結標通知)...');
  try {
    const nowIso = new Date().toISOString();
    const { data: expired, error } = await supabase
      .from('bidding_plates')
      .select('*')
      .lt('end_time', nowIso);

    if (error) {
      console.error('[EndedAuctions] Fetch expired error:', error.message);
      return;
    }
    if (!expired || expired.length === 0) {
      console.log('ℹ️ No ended auctions to notify.');
      return;
    }

    for (const plate of expired) {
      const { data: watches, error: watchErr } = await supabase
        .from('watchlist')
        .select('*')
        .eq('plate_no', plate.plate_no)
        .eq('source', 'bidding');

      if (watchErr || !watches || watches.length === 0) continue;

      const finalBid = parseFloat(plate.current_bid || 0);
      const formattedEnd = new Date(plate.end_time).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });

      for (const watch of watches) {
        console.log(`🏁 Auction ended for ${plate.plate_no}. Notifying ${watch.email} (final bid: ${finalBid})`);
        const mailHtml = `
          <div style="font-family: sans-serif; padding: 20px; max-width: 600px; border: 1px solid #eee; border-radius: 8px;">
            <h2 style="color: #16a34a; margin-bottom: 20px;">Tesla Studio - 收藏車牌結標通知</h2>
            <p>您所收藏的競標車牌 <strong style="font-size: 1.2em; color: #111;">${plate.plate_no}</strong> 競標已結束（結標）！</p>
            <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
              <tr style="background: #f9f9f9;"><td style="padding: 10px; border: 1px solid #ddd; font-weight: bold;">號牌類別</td><td style="padding: 10px; border: 1px solid #ddd;">${plate.plate_type || ''}</td></tr>
              <tr><td style="padding: 10px; border: 1px solid #ddd; font-weight: bold;">最終出價</td><td style="padding: 10px; border: 1px solid #ddd; color: #e82127; font-weight: bold;">NT$ ${finalBid.toLocaleString()} 元</td></tr>
              <tr style="background: #f9f9f9;"><td style="padding: 10px; border: 1px solid #ddd; font-weight: bold;">總出價次數</td><td style="padding: 10px; border: 1px solid #ddd;">${plate.bid_count || 0} 次</td></tr>
              <tr><td style="padding: 10px; border: 1px solid #ddd; font-weight: bold;">結標時間</td><td style="padding: 10px; border: 1px solid #ddd;">${formattedEnd} (台灣時間)</td></tr>
            </table>
            <p style="color: #666; margin-top: 30px;">競標已結束，最終得標結果以監理所公告為準。若您為最高出價者，請留意監理所領牌通知。</p>
            <p style="margin-top: 20px;">
              <a href="https://www.mvdis.gov.tw/m3-emv-plate/bid/queryBiding" target="_blank" style="background: #16a34a; color: white; padding: 12px 24px; text-decoration: none; border-radius: 99px; font-weight: bold; display: inline-block;">查詢得標結果</a>
            </p>
            <hr style="border: 0; border-top: 1px solid #eee; margin: 30px 0;" />
            <p style="font-size: 0.8em; color: #999;">此信件為系統自動發送，請勿直接回覆。該競標已結束，系統已自動將其自您的收藏清單中清除。</p>
          </div>
        `;
        const emailSuccess = await sendEmail(
          watch.email,
          `[Tesla Studio] 收藏車牌 ${plate.plate_no} 競標已結標！`,
          mailHtml
        );
        if (emailSuccess) {
          await supabase.from('watchlist').delete().eq('id', watch.id);
        }
      }
    }
  } catch (e) {
    console.error('[EndedAuctions] Process exception:', e.message);
  }
}

// (c) 開標通知：偵測已到開標時間 (start_time <= now) 且仍有訂閱者的公告，
// 通知後刪除訂閱（一次性提醒）。
async function processAnnouncementOpenAlerts() {
  console.log('🔔 Checking for opened bid announcements (開標通知)...');
  try {
    const { data: subs, error: subErr } = await supabase
      .from('bid_announcement_watchlist')
      .select('*');

    if (subErr) {
      console.error('[OpenAlerts] Fetch subscriptions error:', subErr.message);
      return;
    }
    if (!subs || subs.length === 0) {
      console.log('ℹ️ No announcement subscriptions.');
      return;
    }

    const nowIso = new Date().toISOString();
    const annIds = [...new Set(subs.map(s => s.announcement_id))];

    const { data: openedAnns, error: annErr } = await supabase
      .from('bid_announcements')
      .select('*')
      .in('id', annIds)
      .lte('start_time', nowIso);

    if (annErr) {
      console.error('[OpenAlerts] Fetch announcements error:', annErr.message);
      return;
    }
    if (!openedAnns || openedAnns.length === 0) {
      console.log('ℹ️ No subscribed announcements have opened yet.');
      return;
    }

    for (const ann of openedAnns) {
      const annSubs = subs.filter(s => s.announcement_id === ann.id);
      const formattedStart = new Date(ann.start_time).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
      const formattedEnd = new Date(ann.end_time).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });

      for (const sub of annSubs) {
        console.log(`📣 Announcement opened (${ann.start_plate}~${ann.end_plate}). Notifying ${sub.email}`);
        const mailHtml = `
          <div style="font-family: sans-serif; padding: 20px; max-width: 600px; border: 1px solid #eee; border-radius: 8px;">
            <h2 style="color: #7c3aed; margin-bottom: 20px;">Tesla Studio - 競標開標通知</h2>
            <p>您所訂閱的競標公告 <strong style="font-size: 1.1em; color: #111;">${ann.start_plate} ~ ${ann.end_plate}</strong> 已開始競標（開標）！</p>
            <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
              <tr style="background: #f9f9f9;"><td style="padding: 10px; border: 1px solid #ddd; font-weight: bold;">主辦單位</td><td style="padding: 10px; border: 1px solid #ddd;">${ann.dept_name || ''}</td></tr>
              <tr><td style="padding: 10px; border: 1px solid #ddd; font-weight: bold;">號牌類別</td><td style="padding: 10px; border: 1px solid #ddd;">${ann.plate_type || ''}</td></tr>
              <tr style="background: #f9f9f9;"><td style="padding: 10px; border: 1px solid #ddd; font-weight: bold;">號牌區間</td><td style="padding: 10px; border: 1px solid #ddd; font-weight: bold;">${ann.start_plate} ~ ${ann.end_plate}</td></tr>
              <tr><td style="padding: 10px; border: 1px solid #ddd; font-weight: bold;">開標時間</td><td style="padding: 10px; border: 1px solid #ddd;">${formattedStart} (台灣時間)</td></tr>
              <tr style="background: #f9f9f9;"><td style="padding: 10px; border: 1px solid #ddd; font-weight: bold;">決標時間</td><td style="padding: 10px; border: 1px solid #ddd;">${formattedEnd} (台灣時間)</td></tr>
            </table>
            <p style="margin-top: 30px;">
              <a href="https://www.mvdis.gov.tw/m3-emv-plate/bid/queryBiding" target="_blank" style="background: #7c3aed; color: white; padding: 12px 24px; text-decoration: none; border-radius: 99px; font-weight: bold; display: inline-block;">前往監理所參與競標</a>
            </p>
            <hr style="border: 0; border-top: 1px solid #eee; margin: 30px 0;" />
            <p style="font-size: 0.8em; color: #999;">此信件為系統自動發送，請勿直接回覆。此為一次性開標提醒，系統已自動取消此訂閱。</p>
          </div>
        `;
        const emailSuccess = await sendEmail(
          sub.email,
          `[Tesla Studio] 競標公告 ${ann.start_plate}~${ann.end_plate} 已開標！`,
          mailHtml
        );
        if (emailSuccess) {
          await supabase.from('bid_announcement_watchlist').delete().eq('id', sub.id);
        }
      }
    }
  } catch (e) {
    console.error('[OpenAlerts] Process exception:', e.message);
  }
}

async function run() {
  const startTime = Date.now();
  console.log('🚀 Starting Bidding Plates Sync...');

  // 0. Watchlist 通知（不論是否有 active 競標站台都先執行；結標需在清除過期牌之前撈取）
  await processEndedAuctions();
  await processAnnouncementOpenAlerts();

  // 1. Clean up expired bidding plates (resolution time passed)
  try {
    console.log('🧹 Cleaning up expired bidding plates...');
    const { error: deleteErr } = await supabase
      .from('bidding_plates')
      .delete()
      .lt('end_time', new Date().toISOString());
    if (deleteErr) console.error('[BiddingPlatesSync] Delete expired error:', deleteErr.message);
  } catch (e) {
    console.error('[BiddingPlatesSync] Cleanup exception:', e);
  }

  // 2. Load active stations
  let stations;
  try {
    stations = await loadActiveStations();
  } catch (err) {
    console.error('[BiddingPlatesSync] Failed to load active stations:', err.message);
    process.exit(1);
  }

  if (stations.length === 0) {
    console.log('ℹ️ No active bidding sessions at the moment. Exiting.');
    process.exit(0);
  }

  console.log(`📊 Found ${stations.length} active stations to crawl.`);

  // 3. Launch Puppeteer
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  
  const url = 'https://www.mvdis.gov.tw/m3-emv-plate/bid/queryBiding';
  const allScrapedPlates = [];

  try {
    // 4. Initial Navigation and Terms Agreement
    console.log('🌐 Opening query page...');
    let navSuccess = false;
    for (let tryCount = 1; tryCount <= 3; tryCount++) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
        navSuccess = true;
        break;
      } catch (e) {
        console.warn(`[Nav] Attempt ${tryCount} failed: ${e.message}`);
        if (tryCount < 3) await new Promise(r => setTimeout(r, 5000));
      }
    }

    if (!navSuccess) {
      throw new Error('Could not load queryBiding page.');
    }

    // Agree to terms
    await page.evaluate(() => {
      const agreeLink = Array.from(document.querySelectorAll('a')).find(l => l.innerText.includes('我已充分知悉') || l.getAttribute('onclick')?.includes('doConfirm'));
      if (agreeLink) agreeLink.click();
    });
    await new Promise(r => setTimeout(r, 3000));

    // 5. Loop through active stations
    for (const station of stations) {
      console.log(`\nCrawl Station: ${station.stationCode} (Section: ${station.sectionCode})...`);

      try {
        // Select sectionCode
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
          page.select('#sectionCode', station.sectionCode)
        ]);

        // Select stationCode
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
          page.select('#stationCode', station.stationCode)
        ]);

        // Parse plates with pagination support
        let hasNext = true;
        let pageCount = 0;

        while (hasNext) {
          pageCount++;
          const parsed = await page.evaluate(() => {
            const table = Array.from(document.querySelectorAll('table')).find(t => {
              const text = t.innerText;
              return text.includes('號牌') && text.includes('號牌類別') && text.includes('底價') && text.includes('目前出價');
            });

            if (!table) return [];

            const rows = Array.from(table.querySelectorAll('tr')).slice(1); // skip header
            return rows.map(r => {
              const cols = Array.from(r.querySelectorAll('td')).map(td => td.innerText.trim());
              return {
                plateNo: cols[0],
                plateType: cols[1],
                basePrice: cols[2],
                currentBid: cols[3],
                bidCount: cols[4],
                endTimeStr: cols[5]
              };
            }).filter(x => x.plateNo && /^[A-Z0-9]{2,4}-[A-Z0-9]{2,4}$/i.test(x.plateNo.trim()));
          });

          console.log(`  Page ${pageCount}: Parsed ${parsed.length} plates.`);

          for (const item of parsed) {
            const basePriceNum = parseInt((item.basePrice || '').replace(/,/g, '')) || 0;
            const currentBidNum = parseInt((item.currentBid || '').replace(/,/g, '')) || 0;
            const bidCountNum = parseInt(item.bidCount || '0') || 0;
            const endTimestamp = parseMinguoDate(item.endTimeStr);

            if (!endTimestamp) continue;

            allScrapedPlates.push({
              station_id: station.stationCode,
              plate_no: item.plateNo,
              plate_type: item.plateType,
              base_price: basePriceNum,
              current_bid: currentBidNum,
              bid_count: bidCountNum,
              end_time: endTimestamp,
              updated_at: new Date().toISOString()
            });
          }

          // Check if there is a next page
          const pageInfo = await page.evaluate(() => {
            const pageInput = document.querySelector('input[name="txtPage"]');
            const totalInput = document.querySelector('input[name="total"]');
            return {
              current: pageInput ? parseInt(pageInput.value) : 1,
              total: totalInput ? parseInt(totalInput.value) : 1,
              hasNextButton: !!document.querySelector('#next')
            };
          });

          if (pageInfo.current < pageInfo.total && pageInfo.hasNextButton) {
            console.log(`  Navigating from Page ${pageInfo.current} to ${pageInfo.current + 1}...`);
            await Promise.all([
              page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
              page.click('#next')
            ]);
            await new Promise(r => setTimeout(r, 3000));
          } else {
            hasNext = false;
          }
        }

      } catch (stErr) {
        console.error(`❌ Error crawling station ${station.stationCode}:`, stErr.message);
        // Recover navigation by re-visiting the URL if crashed
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await page.evaluate(() => {
            const agreeLink = Array.from(document.querySelectorAll('a')).find(l => l.innerText.includes('我已充分知悉') || l.getAttribute('onclick')?.includes('doConfirm'));
            if (agreeLink) agreeLink.click();
          });
          await new Promise(r => setTimeout(r, 3000));
        } catch {}
      }
    }

    // 6. Sync to DB & Process Alerts
    if (allScrapedPlates.length > 0) {
      console.log(`📥 Upserting ${allScrapedPlates.length} plates to public.bidding_plates...`);
      
      const chunkSize = 100;
      for (let i = 0; i < allScrapedPlates.length; i += chunkSize) {
        const chunk = allScrapedPlates.slice(i, i + chunkSize);
        const { error: upsertErr } = await supabase
          .from('bidding_plates')
          .upsert(chunk, { onConflict: 'station_id,plate_no,end_time' });

        if (upsertErr) {
          console.error('[BiddingPlatesSync] Upsert error in chunk:', upsertErr.message);
        }
      }
      
      // Process notifications for changed prices
      await processWatchlistAlerts(allScrapedPlates);

      // 號碼訂閱：標牌表已更新，比對使用者登記的想要號碼並通知（每張牌一次）
      await processPlateSubscriptions({ supabase, sendEmail });

    } else {
      console.log('ℹ️ No bidding plates found.');
    }

  } catch (err) {
    console.error('[BiddingPlatesSync] Crawler run failed:', err);
  } finally {
    await browser.close();
    console.log(`🏁 Finished. Total Runtime: ${((Date.now() - startTime) / 1000).toFixed(2)}s`);
  }
}

run();
