#!/usr/bin/env node
'use strict';

// 把 .github/scripts/warp-apt-lib.sh 的函式同步進三支 YAML 的產生區段（WARP 審查 M6）。
//   node scripts/sync-warp-lib.cjs          寫入
//   node scripts/sync-warp-lib.cjs --check  只檢查，有差異時 exit 1（npm test 內的測試也會呼叫 check()）
// 區段標記：「# >>> warp-apt-lib: <函式名>…」到「# <<< warp-apt-lib: <函式名>」，縮排跟著起始標記。

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, '.github', 'scripts', 'warp-apt-lib.sh');
const TARGETS = {
    '.github/workflows/bidding-plates-sync.yml': ['adopt_verified_cached_debs', 'install_warp_bounded'],
    '.github/workflows/bid-announce-sync.yml': ['adopt_verified_cached_debs', 'install_warp_bounded'],
    '.github/actions/setup-plate-runner/action.yml': ['adopt_verified_cached_debs', 'install_warp_verified'],
};

function libFunctions(libText = fs.readFileSync(LIB, 'utf8')) {
    const out = {};
    for (const m of libText.matchAll(/^([a-z_]+)\(\) \{\n[\s\S]*?^\}$/gm)) out[m[1]] = m[0];
    return out;
}

function render(yamlText, names, fns, file) {
    let text = yamlText;
    for (const name of names) {
        if (!fns[name]) throw new Error(`lib 內找不到函式 ${name}`);
        const re = new RegExp(`^( *)(# >>> warp-apt-lib: ${name}（[^\\n]*)\\n[\\s\\S]*?\\n\\1# <<< warp-apt-lib: ${name}$`, 'm');
        const found = text.match(re);
        if (!found) throw new Error(`${file} 內找不到 ${name} 的產生區段`);
        if (text.split(`# >>> warp-apt-lib: ${name}（`).length !== 2) throw new Error(`${file} 內 ${name} 的產生區段不只一個`);
        const ends = text.match(new RegExp(`^ *# <<< warp-apt-lib: ${name}$`, 'gm')) || [];
        if (ends.length !== 1) throw new Error(`${file} 內 ${name} 的結束標記要剛好一個（找到 ${ends.length} 個）`);
        const indent = found[1];
        const body = fns[name].split('\n').map((l) => (l ? indent + l : l)).join('\n');
        text = text.replace(re, () => `${indent}${found[2]}\n${body}\n${indent}# <<< warp-apt-lib: ${name}`);
    }
    return text;
}

// 回傳與 lib 不同步的檔案清單；write=true 時順便寫回
function sync({ write = false } = {}) {
    const fns = libFunctions();
    // 先全部算完（任何一支出錯就整個中止），再寫入，避免只寫了一部分
    const pending = [];
    for (const [file, names] of Object.entries(TARGETS)) {
        const full = path.join(ROOT, file);
        const before = fs.readFileSync(full, 'utf8');
        const after = render(before, names, fns, file);
        if (after !== before) pending.push({ file, full, after });
    }
    if (write) pending.forEach(({ full, after }) => fs.writeFileSync(full, after));
    return pending.map((x) => x.file);
}

module.exports = { sync, libFunctions, TARGETS, LIB };

if (require.main === module) {
    const check = process.argv.includes('--check');
    const stale = sync({ write: !check });
    if (check && stale.length) {
        console.error(`與 .github/scripts/warp-apt-lib.sh 不同步：\n  ${stale.join('\n  ')}\n請跑 npm run sync:warp-lib`);
        process.exit(1);
    }
    console.log(stale.length ? `已更新：${stale.join(', ')}` : '三支 YAML 與 warp-apt-lib.sh 已同步。');
}
