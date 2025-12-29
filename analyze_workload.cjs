const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const url = process.env.VITE_SUPABASE_URL;
// Use Anon Key for read-only analysis if Service Role is missing
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;

if (!url || !key) {
    console.error('Error: VITE_SUPABASE_URL or keys not found in .env');
    process.exit(1);
}

const supabase = createClient(url, key);

async function analyze() {
    console.log('📊 Querying available_plates...');
    const { data, error } = await supabase
        .from('available_plates')
        .select('station_name, station_id');

    if (error) {
        console.error('Database Error:', error.message);
        return;
    }

    if (!data || data.length === 0) {
        console.log('No plates found in available_plates table.');
        return;
    }

    const counts = {};
    data.forEach(p => {
        const stationId = p.station_id || 'Unknown';
        const stationName = p.station_name || 'Unknown';
        const key = `${stationId}: ${stationName}`;
        counts[key] = (counts[key] || 0) + 1;
    });

    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    
    console.log('\n--- Station Workload (Plate Count) ---');
    let total = 0;
    sorted.forEach(([name, count]) => {
        console.log(`${name.padEnd(25)} : ${count} plates`);
        total += count;
    });
    console.log('--------------------------------------');
    console.log(`Total Stations: ${Object.keys(counts).length}`);
    console.log(`Total Plates: ${total}`);
}

analyze();
