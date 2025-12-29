const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const url = process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
    console.error('Error: Missing Supabase credentials.');
    process.exit(1);
}

const supabase = createClient(url, key);

async function run() {
    console.log('🔄 Triggering Final Swap...');
    
    // Safety Check: Ensure Staging is not empty
    const { count, error: countError } = await supabase
        .from('available_plates_staging')
        .select('*', { count: 'exact', head: true });

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

    const { error } = await supabase.rpc('swap_plates_data');
    
    if (error) {
        console.error('❌ Swap Failed:', error.message);
        process.exit(1);
    } else {
        const successMsg = `同步完成，共抓取 ${count} 筆資料`;
        console.log(`✅ ${successMsg}. Production data updated.`);
        
        // Update main metadata status
        await supabase.from('sync_metadata').upsert({
            key: 'plates_full_sync',
            status: 'COMPLETED',
            status_message: successMsg,
            last_run_at: new Date().toISOString()
        }, { onConflict: 'key' });
    }
}

run();
