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

async function sendEmail(to, subject, html) {
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

async function run() {
  const startTime = Date.now();
  console.log('🚀 Starting Bidding Plates Sync...');

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

        // Parse plates
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

        console.log(`  Parsed ${parsed.length} plates.`);

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
