const puppeteer = require('puppeteer');

const MVDIS_URL = 'https://www.mvdis.gov.tw/m3-emv-plate/webpickno/queryPickNo';
// Full scan Dept 2-8
const DEPT_CODES = ['2', '3', '4', '5', '6', '7', '8'];

(async () => {
    console.log('Starting MVDIS Options Investigation (Part 2)...');
    const browser = await puppeteer.launch({
        headless: "new",
        protocolTimeout: 60000, // Increase protocol timeout to 60s
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const results = [];

    try {
        const page = await browser.newPage();
        await page.goto(MVDIS_URL, { waitUntil: 'networkidle2' });

        for (const dept of DEPT_CODES) {
            // Select Dept
            await page.select('#selDeptCode', dept);
            // Wait for stations to load - check for changes in the dropdown
            await new Promise(r => setTimeout(r, 1500)); 
            
            // Get all stations in this Dept
            const stations = await page.evaluate(() => {
                const opts = Array.from(document.querySelectorAll('#selStationCode option'));
                return opts.filter(o => o.value !== '0').map(o => ({ id: o.value, name: o.innerText }));
            });

            console.log(`Dept ${dept}: Found ${stations.length} stations.`);

            for (const station of stations) {
                try {
                    // Select Station
                    await page.select('#selStationCode', station.id);
                    
                    // Wait for Windows - Critical step
                    await new Promise(r => setTimeout(r, 2000));
                    
                    // Check ALL available windows for this station
                    const windows = await page.evaluate(() => {
                        return Array.from(document.querySelectorAll('#selWindowNo option'))
                            .filter(o => o.value !== '0')
                            .map(o => o.value);
                    });

                    console.log(`  [Station ${station.id}] Found ${windows.length} windows. Checking options for each...`);

                    for (const windowId of windows) {
                        try {
                            await page.select('#selWindowNo', windowId);
                            await new Promise(r => setTimeout(r, 1000));
                            
                            await page.select('#selCarType', 'C');
                            await page.select('#selEnergyType', 'E');
                            await new Promise(r => setTimeout(r, 1500));

                            const options = await page.evaluate(() => {
                                const opts = Array.from(document.querySelectorAll('#selPlateType option'));
                                return opts.filter(o => o.value !== '0').map(o => o.value);
                            });

                            if (options.length > 0) {
                                results.push({
                                    dept: dept,
                                    station_id: station.id,
                                    station_name_encoded: encodeURIComponent(station.name),
                                    window: windowId,
                                    options: { g: options.includes('g'), h: options.includes('h') }
                                });
                                console.log(`    - Window ${windowId}: g=${options.includes('g')}, h=${options.includes('h')}`);
                            }
                        } catch (e) {
                            console.log(`    - Window ${windowId}: Error checking options.`);
                        }
                    }

                } catch (err) {
                    console.error(`  Error checking station ${station.id}:`, err.message);
                }
            }
        }

    } catch (e) {
        console.error('Fatal Error:', e);
    } finally {
        await browser.close();
        console.log('Investigation Complete.');
        console.log('JSON_RESULT_START');
        console.log(JSON.stringify(results, null, 2));
        console.log('JSON_RESULT_END');
    }
})();
