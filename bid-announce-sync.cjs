/**
 * Standalone Crawler for MVDIS Bidding Announcements (標牌公告)
 * 
 * Target: https://www.mvdis.gov.tw/m3-emv-plate/bid/announce
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

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[AnnounceSync] Missing required env vars.');
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

async function loadStationData() {
  console.log('📥 Loading station configurations from DB...');
  const { data, error } = await supabase
    .from('system_configs')
    .select('value')
    .eq('key', 'mvdis_stations')
    .single();

  if (error || !data) {
    throw new Error(`Failed to load station config: ${error?.message || 'Data empty'}`);
  }
  return data.value;
}

function findStationCodes(name, stationData) {
  const cleanName = name.trim();
  // Exact match
  for (const dept of stationData) {
    for (const st of dept.stations) {
      if (st.name.trim() === cleanName) {
        return { sectionCode: dept.id, stationCode: st.id };
      }
    }
  }
  // Substring match fallback
  for (const dept of stationData) {
    for (const st of dept.stations) {
      const stClean = st.name.trim();
      if (cleanName.includes(stClean) || stClean.includes(cleanName)) {
        return { sectionCode: dept.id, stationCode: st.id };
      }
    }
  }
  return null;
}

async function run() {
  const startTime = Date.now();
  console.log('🚀 Starting Bidding Announcements Sync...');

  // 1. Clean up expired announcements (older than 30 days)
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    console.log(`🧹 Cleaning up announcements older than: ${cutoff}`);
    const { error: deleteErr } = await supabase
      .from('bid_announcements')
      .delete()
      .lt('end_time', cutoff);
    if (deleteErr) console.error('[AnnounceSync] Delete expired error:', deleteErr.message);

    // Clean up any other non-electric car types in DB
    const { error: typeDeleteErr } = await supabase
      .from('bid_announcements')
      .delete()
      .neq('plate_type', '電動自小客')
      .neq('plate_type', '電動租賃車');
    if (typeDeleteErr) console.error('[AnnounceSync] Cleanup plate types error:', typeDeleteErr.message);
  } catch (e) {
    console.error('[AnnounceSync] Cleanup exception:', e);
  }

  // 2. Load station data
  let stationData;
  try {
    stationData = await loadStationData();
  } catch (err) {
    console.error('[AnnounceSync] Setup failed:', err.message);
    process.exit(1);
  }

  // 3. Launch Puppeteer
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  
  const url = 'https://www.mvdis.gov.tw/m3-emv-plate/bid/announce#anchor';
  
  const scrapedRecords = [];

  try {
    // We scrape both "未決標" (0) and "已決標" (1)
    for (const announceType of ['0', '1']) {
      const typeLabel = announceType === '0' ? '未決標 (Active/Upcoming)' : '已決標 (Closed)';
      console.log(`🌐 Scraping announcements: ${typeLabel}...`);

      let navSuccess = false;
      for (let tryCount = 1; tryCount <= 3; tryCount++) {
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
          navSuccess = true;
          break;
        } catch (e) {
          console.warn(`[Nav] Attempt ${tryCount} failed: ${e.message}`);
          if (tryCount < 3) await new Promise(r => setTimeout(r, 5000));
        }
      }

      if (!navSuccess) {
        console.error(`[Fatal] Could not load announce page after 3 attempts.`);
        continue;
      }

      // Close modal popup if present
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('a, button, input')).find(el => el.innerText?.includes('關閉') || el.value?.includes('關閉'));
        if (btn) btn.click();
      });
      await new Promise(r => setTimeout(r, 1000));

      // Select announceSelected type
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {}),
        page.select('#announceSelected', announceType)
      ]);

      // Click Query Button
      console.log('  Submitting form query...');
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(err => console.log('  Navigation wait warning:', err.message)),
        page.evaluate(() => {
          const qBtn = Array.from(document.querySelectorAll('a, button, input')).find(b => {
            const t = (b.innerText || b.value || '').trim();
            return t === '查詢' || (b.getAttribute('onclick') && b.getAttribute('onclick').includes('query'));
          });
          if (qBtn) qBtn.click();
        })
      ]);

      // Wait for table to render
      await new Promise(r => setTimeout(r, 4000));

      // Parse the announcements table
      const rowsData = await page.evaluate(() => {
        const table = Array.from(document.querySelectorAll('table')).find(t => {
          const text = t.innerText;
          return text.includes('監理單位') && text.includes('號牌起號') && text.includes('起標時間');
        });

        if (!table) return [];

        const rows = Array.from(table.querySelectorAll('tr')).slice(1); // skip header
        return rows.map(r => {
          const cols = Array.from(r.querySelectorAll('td')).map(td => td.innerText.trim().replace(/\s+/g, ' '));
          return cols;
        }).filter(cols => cols.length >= 7);
      });

      console.log(`  Found ${rowsData.length} announcement rows.`);

      // Convert rows into database records
      for (const row of rowsData) {
        const deptName = row[0];
        const plateType = row[1];
        const startPlate = row[2];
        const endPlate = row[3];
        const startTimeStr = row[4];
        const endTimeStr = row[5];
        const deadlineStr = row[6];

        // Only keep electric passenger cars (電動自小客) and electric rental/lease cars (電動租賃車)
        const cleanPlateType = (plateType || '').trim();
        if (cleanPlateType !== '電動自小客' && cleanPlateType !== '電動租賃車') {
          continue;
        }

        const codes = findStationCodes(deptName, stationData);
        if (!codes) {
          console.warn(`⚠️  Cannot resolve station codes for name: "${deptName}"`);
          continue;
        }

        const startTimestamp = parseMinguoDate(startTimeStr);
        const endTimestamp = parseMinguoDate(endTimeStr);
        const deadlineTimestamp = parseMinguoDate(deadlineStr);

        if (!startTimestamp || !endTimestamp || !deadlineTimestamp) {
          console.warn(`⚠️  Cannot parse dates for row: ${JSON.stringify(row)}`);
          continue;
        }

        scrapedRecords.push({
          dept_name: deptName,
          section_code: codes.sectionCode,
          station_code: codes.stationCode,
          plate_type: plateType,
          start_plate: startPlate,
          end_plate: endPlate,
          start_time: startTimestamp,
          end_time: endTimestamp,
          payment_deadline: deadlineTimestamp,
          updated_at: new Date().toISOString()
        });
      }
    }

    if (scrapedRecords.length > 0) {
      console.log(`📥 Upserting ${scrapedRecords.length} announcements to database...`);
      
      // Perform upsert in chunks to prevent large payload errors
      const chunkSize = 100;
      for (let i = 0; i < scrapedRecords.length; i += chunkSize) {
        const chunk = scrapedRecords.slice(i, i + chunkSize);
        const { error: upsertErr } = await supabase
          .from('bid_announcements')
          .upsert(chunk, { onConflict: 'dept_name,plate_type,start_plate,end_plate,start_time,end_time' });

        if (upsertErr) {
          console.error('[AnnounceSync] Upsert error in chunk:', upsertErr.message);
        }
      }
      console.log('✅ Announcements synced successfully.');
    } else {
      console.log('ℹ️ No announcements found to sync.');
    }

  } catch (err) {
    console.error('[AnnounceSync] Scrape failed:', err);
  } finally {
    await browser.close();
    console.log(`🏁 Finished. Total Runtime: ${((Date.now() - startTime) / 1000).toFixed(2)}s`);
  }
}

run();
