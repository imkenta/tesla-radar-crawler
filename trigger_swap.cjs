const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const url = process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
    console.error('Error: Missing Supabase credentials.');
    process.exit(1);
}

let supabase = null;
function initSupabase() {
    if (!supabase) {
        supabase = createClient(url, key, {
            auth: { persistSession: false },
            global: {
                fetch: (...args) => fetch(...args).catch(err => {
                    console.error(`[FetchError] ${err.name}: ${err.message}`);
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

async function run() {
    console.log('🔄 Triggering Final Swap...');
    const supabase = initSupabase();
    
    // Safety Check: Ensure Staging is not empty
    const { data, count, error: countError } = await safeQuery(() => supabase
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

    console.log(`✅ Staging has ${count} records. Proceeding with swap...`);

    const { error } = await safeQuery(() => supabase.rpc('swap_plates_data'));
    
    if (error) {
        console.error('❌ Swap Failed:', error.message);
        process.exit(1);
    } else {
        const successMsg = `同步完成，共抓取 ${count} 筆資料`;
        console.log(`✅ ${successMsg}. Production data updated.`);
        
        // Update main metadata status
        await safeQuery(() => supabase.from('sync_metadata').upsert({
            key: 'plates_full_sync',
            status: 'COMPLETED',
            status_message: successMsg,
            last_run_at: new Date().toISOString()
        }, { onConflict: 'key' }));
    }
}

run();
