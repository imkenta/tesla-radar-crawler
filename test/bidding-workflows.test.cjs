'use strict';

// 2026-11-10 健檢 O7：bidding-plates-sync / bid-announce-sync 的 WARP 安裝步驟原本是裸的
// `sudo apt-get update && sudo apt-get install -y cloudflare-warp`（無逾時）。11/9 兩輪各卡 7.5 分鐘，
// 被 10 分鐘 job timeout 砍掉，爬完卻沒寫入。改成有上限的 update 重試＋單次 install（240 秒）＋步驟層 timeout。
// 審查修正：Ubuntu 26.04 的 install 要下載 125 MB，綠燈輪次實測 66 秒～2 分 54 秒，所以 90 秒上限會砍掉原本會綠的輪次。
// 2026-11-10 第二版：azure.archive.ubuntu.com 當天變慢，單一 240 秒 install 在下載慢時被砍（甚至砍在 dpkg 解包中）。
// 改成「update → 可續傳的 --download-only（最多 3 輪）→ 本機解包（TERM 落在 dpkg 時先 dpkg --configure -a）」，
// 並以整體 deadline（預設 330 秒）夾住各階段上限。

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('js-yaml');

const WORKFLOWS = [
    ['bidding-plates-sync.yml', 'sync-bidding-plates'],
    ['bid-announce-sync.yml', 'sync-announcements'],
];

function load(file, jobName) {
    const wf = yaml.load(fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', file), 'utf8'));
    const job = wf.jobs[jobName];
    const step = job.steps.find((s) => s.name === 'Install and Configure Cloudflare WARP');
    return { wf, job, step };
}

const functionOf = (step) => {
    // M6：adopt_verified_cached_debs 與 install_warp_bounded 都是 YAML 內的頂層函式（由 warp-apt-lib.sh 產生）
    const adopt = step.run.match(/^adopt_verified_cached_debs\(\) \{[\s\S]*?^\}$/m);
    const fn = step.run.match(/^install_warp_bounded\(\) \{[\s\S]*?^\}$/m);
    assert.ok(adopt, '找不到 adopt_verified_cached_debs');
    assert.ok(fn, '找不到 install_warp_bounded');
    return `${adopt[0]}\n${fn[0]}`;
};

// 在假 sudo／timeout／apt-get／dpkg 下執行安裝函式。
//   updateFailures／downloadFailures／unpackFailures：各階段前 N 次呼叫失敗（模擬卡住被 timeout 砍掉＝124）
//   budget：WARP_APT_BUDGET（秒）；假 timeout 不會真的等，所以只用來驗證「各階段上限被剩餘預算夾住」
//   cacheFiles：放進假 HOME/.warp-apt-cache 的檔案（檔名→內容）；uris：假 apt-get --print-uris 的輸出；aptCache：假 apt-cache show 的輸出
function runInstall(fnText, { updateFailures = 0, downloadFailures = 0, unpackFailures = 0, budget, cache, cacheFiles, uris = '', aptCache = '', downloadExit = 124 } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warp-'));
    try {
        const bin = path.join(dir, 'bin');
        fs.mkdirSync(bin);
        const log = path.join(dir, 'calls.log');
        fs.writeFileSync(log, '');
        const write = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
        write('sudo', 'exec "$@"');
        // timeout --signal=TERM --kill-after=10s <secs>s cmd...  → 記錄上限秒數後直接執行（保留被包的指令結束碼）
        write('timeout', `echo "timeout $3" >> "${log}"; shift 3; exec "$@"`);
        write('sleep', 'exit 0');
        // WARP 審查 M3：函式裡的 curl（鏡像連線探測）不得真的連網路——鏡像卡住時每次探測要等滿 5 秒，
        // 會把 CI 的測試拖到數分鐘。鏡像清單檔也改用假的（真的 /etc/apt/apt-mirrors.txt 只有 Linux runner 才有）。
        write('curl', `echo "curl $*" >> "${log}"; printf '200/0.01s'`);
        // macOS 的 sed -i 語法與 GNU 不同：`sed -i -E <運算式> <檔案>` 交給 perl 就地執行同一個運算式
        write('sed', 'if [ "$1" = "-i" ] && [ "$2" = "-E" ]; then exec perl -pi -e "$3" "$4"; fi; exec /usr/bin/sed "$@"');
        const mirrors = path.join(dir, 'apt-mirrors.txt');
        fs.writeFileSync(mirrors, 'http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\nhttps://archive.ubuntu.com/ubuntu/\tpriority:2\n');
        write('dpkg', `echo "dpkg $*" >> "${log}"; exit 0`);
        const aptCacheFile = path.join(dir, 'apt-cache.txt');
        fs.writeFileSync(aptCacheFile, aptCache);
        write('apt-cache', `echo "apt-cache $*" >> "${log}"; cat "${aptCacheFile}"`);
        // macOS 沒有 sha256sum，用 node 算（輸出格式同 coreutils）
        for (const bits of ['256']) {
            fs.writeFileSync(path.join(bin, `sha${bits}sum`), `#!/usr/bin/env node\nconst c=require('crypto'),fs=require('fs');console.log(c.createHash('sha${bits}').update(fs.readFileSync(process.argv[2])).digest('hex')+'  '+process.argv[2]);\n`, { mode: 0o755 });
        }
        const home = path.join(dir, 'home');
        const archives = path.join(dir, 'archives');
        fs.mkdirSync(path.join(home, '.warp-apt-cache'), { recursive: true });
        fs.mkdirSync(archives);
        for (const [name, content] of Object.entries(cacheFiles || {})) fs.writeFileSync(path.join(home, '.warp-apt-cache', name), content);
        const urisFile = path.join(dir, 'uris.txt');
        fs.writeFileSync(urisFile, uris);
        write('apt-get', `
echo "apt-get $*" >> "${log}"
case " $* " in
  *" --print-uris "*)
    cat "${urisFile}"; exit 0 ;;
  *" update "*)
    n=$(grep -c '^apt-get .* update$' "${log}" || true)
    if [ "$n" -le ${updateFailures} ]; then exit 124; fi ;;
  *" --download-only "*)
    n=$(grep -c -- '--download-only' "${log}" || true)
    if [ "$n" -le ${downloadFailures} ]; then exit ${downloadExit}; fi ;;
  *" install "*)
    n=$(grep -c '^apt-get .* install -y --no-download cloudflare-warp$' "${log}" || true)
    if [ "$n" -le ${unpackFailures} ]; then exit 124; fi ;;
esac
exit 0`);
        const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, WARP_APT_ARCHIVES: archives, WARP_APT_MIRRORS_FILE: mirrors };
        if (budget !== undefined) env.WARP_APT_BUDGET = String(budget);
        if (cache) env.WARP_DEB_CACHE = '1';
        const result = spawnSync('/bin/bash', ['-eo', 'pipefail'], {
            input: `${fnText}\ninstall_warp_bounded && echo OK || echo FAILED`,
            encoding: 'utf8',
            env,
        });
        return { ...result, calls: fs.readFileSync(log, 'utf8'), adopted: fs.readdirSync(archives).sort(), mirrors: fs.readFileSync(mirrors, 'utf8') };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
const count = (text, re) => (text.match(re) || []).length;

test('兩支競標 workflow 的 install_warp_bounded 逐字相同（改一支必須改另一支）', () => {
    const [a, b] = WORKFLOWS.map(([file, jobName]) => functionOf(load(file, jobName).step));
    assert.equal(a, b);
});

for (const [file, jobName] of WORKFLOWS) {
    test(`${file}：WARP 安裝兩段式（update → 可續傳下載 → 本機解包）、有整體 deadline、步驟層上限`, () => {
        const { job, step } = load(file, jobName);
        assert.doesNotMatch(step.run, /sudo apt-get update &&/);
        assert.match(step.run, /--download-only cloudflare-warp/, '下載與解包必須分兩段');
        assert.match(step.run, /for TRY in 1 2 3; do/, '下載最多 3 輪');
        assert.match(step.run, /WARP_APT_BUDGET:-330/);
        assert.match(step.run, /UNPACK_RESERVE=60/);
        assert.match(step.run, /dpkg --configure -a/);
        // 唯讀沿用車牌同步的 .deb 快取：restore 步驟在安裝步驟之前、失敗不擋；安裝前把 .deb 放進 apt archives
        const steps = job.steps.map((x) => x.name || x.uses);
        const restoreIdx = steps.indexOf('Restore cached WARP apt packages (shared with plate-sync)');
        assert.ok(restoreIdx >= 0 && restoreIdx < steps.indexOf('Install and Configure Cloudflare WARP'));
        const restore = job.steps[restoreIdx];
        assert.match(restore.uses, /^actions\/cache\/restore@[0-9a-f]{40}$/, 'action 要釘 commit SHA');
        assert.equal(restore['continue-on-error'], true);
        assert.equal(restore.with.path, '~/.warp-apt-cache');
        // M2：優先同一個 runner 映像版本的快取，沒有才退到任何版本
        assert.deepEqual(restore.with['restore-keys'].trim().split(/\s+/), [
            'warp-apt-${{', 'runner.os', '}}-${{', 'steps.runner-image.outputs.version', '}}-',
            'warp-apt-${{', 'runner.os', '}}-',
        ]);
        const imageIdx = job.steps.findIndex((x) => x.id === 'runner-image');
        assert.ok(imageIdx >= 0 && imageIdx < restoreIdx);
        assert.match(job.steps[imageIdx].run, /ImageVersion/);
        job.steps.filter((x) => x.uses).forEach((x) => assert.match(x.uses, /@[0-9a-f]{40}$/, `${x.uses} 要釘 commit SHA`));
        // M1：不得再整批複製快取檔；只能經 adopt_verified_cached_debs 逐檔比對雜湊後放入
        assert.doesNotMatch(step.run, /cp "\$HOME\/\.warp-apt-cache\/"\*\.deb/);
        assert.match(step.run, /--print-uris cloudflare-warp/);
        assert.match(step.run, /WARP_DEB_CACHE=1/);
        // 鏡像卡住時改用 archive.ubuntu.com（只改 mirror 清單檔內容），update 與下載失敗後都會呼叫
        assert.match(step.run, /use_fallback_ubuntu_mirror\(\) \{[\s\S]*?WARP_APT_MIRRORS_FILE:-\/etc\/apt\/apt-mirrors\.txt[\s\S]*?https:\/\/archive\.ubuntu\.com\/ubuntu\//);
        assert.ok((step.run.match(/^\s*use_fallback_ubuntu_mirror$/gm) || []).length >= 2);
        assert.match(step.run, /Acquire::Retries=2/);
        assert.match(step.run, /Acquire::http::Timeout=15/);
        assert.match(step.run, /curl -fsSL --connect-timeout 10 --max-time 30 --retry 2/);
        assert.match(step.run, /if ! install_warp_bounded; then[\s\S]*?exit 1/);
        // 不得再有「下載＋解包」合一、固定 240 秒的 install
        assert.doesNotMatch(step.run, /kill-after=15s 240s/);
        // 步驟上限 < job 上限；步驟後要留給 Setup Node＋npm ci＋同步（p99 191 秒、max 201 秒）
        const stepMin = step['timeout-minutes'];
        assert.equal(stepMin, 7);
        // M5：還原快取有步驟上限與分段下載逾時；逾時不擋後續
        assert.equal(restore['timeout-minutes'], 1);
        // 分段下載逾時要小於步驟上限，action 才有機會自己放棄（否則永遠是步驟上限先到）
        assert.ok(Number(restore.env.SEGMENT_DOWNLOAD_TIMEOUT_MINS) * 60 < restore['timeout-minutes'] * 60);
        assert.equal(restore.env.SEGMENT_DOWNLOAD_TIMEOUT_MINS, '0.5');
        // M4：job 上限要蓋得住「有上限的步驟（從 YAML 讀）＋其餘步驟的觀測最大值」。
        // 觀測值（競標同步 11/5–11/10 共 767 輪；公告同步借用）：checkout 約 6 秒、Verify IP 最多約 25 秒、Setup Node＋npm ci＋同步最大 201 秒、
        // job 準備／收尾與步驟逾時的終止寬限約 14 秒；
        // 這些步驟沒有 timeout，所以 job 上限才是最後一道，數字變大時要回來調。
        const OBSERVED_UNCAPPED_MAX_S = 6 + 25 + 201 + 14;
        const capped = job.steps.filter((x) => x['timeout-minutes']).map((x) => x['timeout-minutes'] * 60);
        assert.deepEqual(capped, [60, 420], '有上限的步驟：還原快取、WARP 安裝');
        const worst = capped.reduce((a, c) => a + c, 0) + OBSERVED_UNCAPPED_MAX_S;
        assert.ok(worst < job['timeout-minutes'] * 60, `最壞情況 ${worst} 秒要小於 job 上限 ${job['timeout-minutes'] * 60} 秒`);
        assert.equal(job['timeout-minutes'], 13);
        assert.ok(job['timeout-minutes'] * 60 - worst >= 30, '至少留 30 秒餘裕');
        // 步驟內：金鑰 ≥1 秒＋函式預算（從函式讀）＋WARP 註冊／連線確認最多約 60 秒 < 步驟上限
        const budget = Number(step.run.match(/WARP_APT_BUDGET:-(\d+)/)[1]);
        assert.equal(budget, 330);
        // WARP 連線確認最多 6 輪 ×（等 5 秒＋trace 最多 5 秒）＝60 秒；沒連上就失敗（L3）
        assert.match(step.run, /for WARP_WAIT in 1 2 3 4 5 6; do\s+sleep 5\s+WARP_TRACE=\$\(curl -fsS --max-time 5 /);
        assert.match(step.run, /if ! grep -q '\^warp=on\$' <<< "\$WARP_TRACE"; then\s+echo "::error::[^\n]*\s+echo "\$WARP_TRACE"\s+exit 1/);
        assert.doesNotMatch(step.run, /^\s*sleep 15$/m);
        // Supabase IP 只取 IPv4（L4），網址由 env 傳入而不是把 secret 直接展開進腳本
        assert.match(step.run, /getent ahostsv4 "\$SUB_DOMAIN"/);
        assert.doesNotMatch(step.run.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n'), /nslookup|\$\{\{ secrets\./);
        assert.equal(step.env.SUPABASE_URL, '${{ secrets.VITE_SUPABASE_URL }}');
        assert.ok(1 + budget + 60 < stepMin * 60);
    });

    test(`${file}：安裝函式行為——正常路徑各階段上限、可續傳下載重試、解包失敗後 dpkg --configure -a`, () => {
        const { step } = load(file, jobName);
        const fn = functionOf(step);

        const clean = runInstall(fn);
        assert.match(clean.stdout, /OK/, clean.stderr);
        assert.deepEqual(clean.calls.match(/^timeout .*$/gm), ['timeout 30s', 'timeout 100s', 'timeout 120s']);
        assert.equal(count(clean.calls, /--download-only/g), 1);
        assert.equal(count(clean.calls, /^apt-get .* install -y --no-download cloudflare-warp$/gm), 1);
        assert.equal(count(clean.calls, /^dpkg /gm), 0);
        // 順序：update → download-only → 解包
        const order = clean.calls.match(/^apt-get .*$/gm).map((l) => (/update$/.test(l) ? 'update' : /--download-only/.test(l) ? 'download' : 'unpack'));
        assert.deepEqual(order, ['update', 'download', 'unpack']);

        // update 第 1 輪卡住（Ubuntu 鏡像）：換鏡像後再完整更新一次（上限 45 秒）
        const updateRetried = runInstall(fn, { updateFailures: 1 });
        assert.match(updateRetried.stdout, /OK/);
        let updateCalls = updateRetried.calls.match(/^apt-get .* update$/gm);
        assert.equal(updateCalls.length, 2);
        updateCalls.forEach((c) => assert.doesNotMatch(c, /Dir::Etc::sourcelist/));
        assert.deepEqual(updateRetried.calls.match(/^timeout .*$/gm).slice(0, 2), ['timeout 30s', 'timeout 45s']);
        assert.doesNotMatch(updateRetried.stdout, /falling back to Cloudflare-only/);
        // 換鏡像：清單檔內的 azure 鏡像被換成 archive.ubuntu.com，並各量一次 IPv4／IPv6 兩個鏡像的連線（共 4 次 curl，上限 5 秒）
        assert.match(updateRetried.stdout, /mirror switched to archive\.ubuntu\.com/);
        assert.doesNotMatch(updateRetried.mirrors, /azure\.archive/);
        assert.equal(count(updateRetried.mirrors, /https:\/\/archive\.ubuntu\.com\/ubuntu\//g), 2);
        const probes = updateRetried.calls.match(/^curl .*$/gm);
        assert.equal(probes.length, 4);
        probes.forEach((c) => assert.match(c, /^curl -[46] .* -m 5 /));
        assert.match(clean.mirrors, /azure\.archive/, '正常路徑不動鏡像清單');
        assert.equal(count(clean.calls, /^curl /gm), 0);
        // 第 1 輪失敗後，之後所有 apt 呼叫都強制 IPv4；正常路徑不加
        assert.doesNotMatch(updateCalls[0], /ForceIPv4/);
        assert.match(updateCalls[1], /Acquire::ForceIPv4=true/);
        updateRetried.calls.match(/^apt-get .* install .*$/gm).forEach((c) => assert.match(c, /Acquire::ForceIPv4=true/));
        assert.doesNotMatch(clean.calls, /ForceIPv4/);
        // 前兩輪都失敗：第 3 輪只更新 Cloudflare 來源（上限 30 秒，大於 https Timeout 20 秒），Ubuntu 清單沿用既有的，然後照常下載
        const updateFallback = runInstall(fn, { updateFailures: 2 });
        assert.match(updateFallback.stdout, /OK/, updateFallback.stderr);
        updateCalls = updateFallback.calls.match(/^apt-get .* update$/gm);
        assert.equal(updateCalls.length, 3);
        assert.doesNotMatch(updateCalls[1], /Dir::Etc::sourcelist/);
        assert.match(updateCalls[2], /Dir::Etc::sourcelist=sources\.list\.d\/cloudflare-client\.list -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0 update$/);
        assert.deepEqual(updateFallback.calls.match(/^timeout .*$/gm).slice(0, 3), ['timeout 30s', 'timeout 45s', 'timeout 30s']);
        assert.match(updateFallback.stdout, /falling back to Cloudflare-only apt index/);
        assert.equal(count(updateFallback.calls, /--download-only/g), 1);
        assert.doesNotMatch(clean.stdout, /falling back|mirror switched/);
        // 有快取的 .deb：不碰 Ubuntu 鏡像，update 只有一輪且只更新 Cloudflare 來源
        const cached = runInstall(fn, { cache: true });
        assert.match(cached.stdout, /OK/, cached.stderr);
        updateCalls = cached.calls.match(/^apt-get .* update$/gm);
        assert.equal(updateCalls.length, 1);
        assert.match(updateCalls[0], /Dir::Etc::sourcelist=sources\.list\.d\/cloudflare-client\.list/);
        assert.deepEqual(cached.calls.match(/^timeout .*$/gm), ['timeout 30s', 'timeout 20s', 'timeout 100s', 'timeout 120s']);
        assert.match(cached.stdout, /could not list the packages apt expects/);
        assert.deepEqual(cached.adopted, []);
        assert.doesNotMatch(cached.calls, /ForceIPv4/);
        assert.doesNotMatch(cached.calls, /Debug::Acquire/);
        // WARP 審查 H1：快取模式下 Cloudflare 索引更新失敗要再試（11/13 那型失敗），重試輪上限 40 秒並開 apt https 除錯輸出
        const cachedRetried = runInstall(fn, { cache: true, updateFailures: 1 });
        assert.match(cachedRetried.stdout, /OK/, cachedRetried.stderr);
        updateCalls = cachedRetried.calls.match(/^apt-get .* update$/gm);
        assert.equal(updateCalls.length, 2);
        updateCalls.forEach((c) => assert.match(c, /Dir::Etc::sourcelist=sources\.list\.d\/cloudflare-client\.list/));
        assert.doesNotMatch(updateCalls[0], /Debug::Acquire/);
        assert.match(updateCalls[1], /Debug::Acquire::https=true/);
        assert.deepEqual(cachedRetried.calls.match(/^timeout .*$/gm), ['timeout 30s', 'timeout 40s', 'timeout 20s', 'timeout 100s', 'timeout 120s']);
        assert.doesNotMatch(cachedRetried.calls, /ForceIPv4/, '快取模式的重試不換 Ubuntu 鏡像');
        assert.doesNotMatch(cachedRetried.stdout, /mirror switched/);
        const cachedExhausted = runInstall(fn, { cache: true, updateFailures: 99 });
        assert.match(cachedExhausted.stdout, /FAILED/);
        updateCalls = cachedExhausted.calls.match(/^apt-get .* update$/gm);
        assert.equal(updateCalls.length, 3, '快取模式 Cloudflare 索引更新最多 3 輪');
        updateCalls.forEach((c) => assert.match(c, /Dir::Etc::sourcelist/));
        assert.deepEqual(cachedExhausted.calls.match(/^timeout .*$/gm), ['timeout 30s', 'timeout 40s', 'timeout 40s']);
        assert.equal(count(cachedExhausted.calls, /--download-only/g), 0);
        // WARP 審查 M1：快取檔逐檔比對索引裡的 SHA256，相符才放進 archives。
        // apt --print-uris 實際只印 MD5Sum（11/15 在 runner 實測），所以 SHA256 由 apt-cache show「套件=版本」取得、以 MD5 對應紀錄。
        const sha = (alg, text) => crypto.createHash(alg).update(text).digest('hex');
        const record = (pkg, md5Of, shaOf) => `Package: ${pkg}\nSize: 1\nMD5sum: ${sha('md5', md5Of)}\nSHA1: x\nSHA256: ${sha('sha256', shaOf)}\nSHA512: y\nDescription: z\n`;
        const verified = runInstall(fn, {
            cache: true,
            cacheFiles: {
                'good_1%3a2.0-1_amd64v3.deb': 'A', 'direct_1_amd64.deb': 'B', 'tampered_1_amd64.deb': 'EVIL',
                'md5collide_1_amd64.deb': 'FORGED', 'norecord_1_amd64.deb': 'C', 'stale_0.9_amd64.deb': 'D', 'escape_1_amd64.deb': 'E',
            },
            uris: [
                `'http://x/good.deb' good_1%3a2.0-1_amd64v3.deb 1 MD5Sum:${sha('md5', 'A')}`,
                `'http://x/direct.deb' direct_1_amd64.deb 1 SHA256:${sha('sha256', 'B')}`,
                `'http://x/tampered.deb' tampered_1_amd64.deb 4 MD5Sum:${sha('md5', 'ORIGINAL')}`,
                // 假設攻擊者做得出 MD5 相同的檔案：MD5 對得上、SHA256 對不上，必須被拒絕
                `'http://x/md5collide.deb' md5collide_1_amd64.deb 1 MD5Sum:${sha('md5', 'GENUINE')}`,
                `'http://x/norecord.deb' norecord_1_amd64.deb 1 MD5Sum:${sha('md5', 'C')}`,
                `'http://x/missing.deb' missing_1_amd64.deb 1 MD5Sum:${sha('md5', 'Z')}`,
                `'http://x/escape.deb' ../home/.warp-apt-cache/escape_1_amd64.deb 1 MD5Sum:${sha('md5', 'E')}`,
                `'http://x/nohash.deb' nohash_1_amd64.deb 1 `,
                '',
            ].join('\n'),
            aptCache: [record('good', 'A', 'A'), record('tampered', 'ORIGINAL', 'ORIGINAL'), record('md5collide', 'GENUINE', 'GENUINE'), record('escape', 'E', 'E')].join('\n'),
        });
        assert.match(verified.stdout, /OK/, verified.stderr);
        assert.deepEqual(verified.adopted, ['direct_1_amd64.deb', 'good_1%3a2.0-1_amd64v3.deb'], '只有 SHA256 相符的快取檔會被採用；不在清單內的舊版也不會');
        assert.match(verified.stdout, /cached \.deb: 2 verified \(SHA256\) and reused, 2 rejected \(hash mismatch\), 1 unverifiable, 2 not in cache/);
        // 查不到雜湊的檔另外計數、另外警告：不算「內容被換掉」
        assert.match(verified.stdout, /no SHA256 available for cached norecord_1_amd64\.deb \(apt printed MD5Sum\)/);
        assert.match(verified.stdout, /2 cached \.deb file\(s\) failed SHA256 verification/);
        // apt-cache 以「套件=版本」查詢，檔名裡的 %3a 還原成 epoch 的冒號；只查快取裡有的檔
        const specLine = verified.calls.match(/^apt-cache show (.*)$/m)[1].split(' ');
        assert.deepEqual(specLine, ['good=1:2.0-1', 'direct=1', 'tampered=1', 'md5collide=1', 'norecord=1']);
        // 無快取模式完全不碰快取目錄
        const noCacheMode = runInstall(fn, { cacheFiles: { 'direct_1_amd64.deb': 'A' }, uris: `'http://x/direct.deb' direct_1_amd64.deb 1 SHA256:${sha('sha256', 'A')}\n` });
        assert.deepEqual(noCacheMode.adopted, []);
        assert.doesNotMatch(noCacheMode.calls, /--print-uris/);
        // WARP 審查 M2：快取模式下第一次下載被 apt 回報錯誤（例：清單過期 404＝exit 100）→ 補一次完整 update（不限 Cloudflare 來源）並重新比對快取；只做一次
        const cachedDownloadRetry = runInstall(fn, { cache: true, downloadFailures: 2, downloadExit: 100 });
        assert.match(cachedDownloadRetry.stdout, /OK/, cachedDownloadRetry.stderr);
        updateCalls = cachedDownloadRetry.calls.match(/^apt-get .* update$/gm);
        assert.equal(updateCalls.length, 2, 'Cloudflare-only 一次＋完整 update 一次');
        assert.match(updateCalls[0], /Dir::Etc::sourcelist/);
        assert.doesNotMatch(updateCalls[1], /Dir::Etc::sourcelist/);
        assert.equal(count(cachedDownloadRetry.calls, /--print-uris/g), 2);
        assert.deepEqual(cachedDownloadRetry.calls.match(/^timeout .*$/gm), ['timeout 30s', 'timeout 20s', 'timeout 100s', 'timeout 45s', 'timeout 20s', 'timeout 100s', 'timeout 100s', 'timeout 120s']);
        const order2 = cachedDownloadRetry.calls.match(/^apt-get .*$/gm).map((l) => (/update$/.test(l) ? 'update' : /--print-uris/.test(l) ? 'uris' : /--download-only/.test(l) ? 'download' : 'unpack'));
        assert.deepEqual(order2, ['update', 'uris', 'download', 'update', 'uris', 'download', 'download', 'unpack']);
        // 下載是被 timeout 砍掉（124＝連線卡住）時不補完整 update，時間留給下載重試
        const cachedDownloadStalled = runInstall(fn, { cache: true, downloadFailures: 2 });
        assert.match(cachedDownloadStalled.stdout, /OK/, cachedDownloadStalled.stderr);
        assert.equal(count(cachedDownloadStalled.calls, /^apt-get .* update$/gm), 1);
        assert.equal(count(cachedDownloadStalled.calls, /--print-uris/g), 1);
        assert.equal(count(cachedDownloadStalled.calls, /--download-only/g), 3);
        // 無快取模式即使 apt 回報錯誤也不補（前面已做過完整 update）
        const plainDownloadError = runInstall(fn, { downloadFailures: 1, downloadExit: 100 });
        assert.match(plainDownloadError.stdout, /OK/, plainDownloadError.stderr);
        assert.equal(count(plainDownloadError.calls, /^apt-get .* update$/gm), 1);
        // 每輪上限都大於 Acquire::https::Timeout（20 秒），apt 內建重試才有機會生效
        assert.match(step.run, /Acquire::https::Timeout=20/);
        const updateExhausted = runInstall(fn, { updateFailures: 99 });
        assert.match(updateExhausted.stdout, /FAILED/);
        assert.equal(count(updateExhausted.calls, /^apt-get .* update$/gm), 3, '無快取時 update 最多 3 輪（Cloudflare-only 不重試）');
        assert.equal(count(updateExhausted.calls, /--download-only/g), 0);

        // 慢鏡像：下載前兩輪被砍，第三輪成功（半成品續傳由 apt 負責，這裡驗證「會再試」且只解包一次）
        const slowDownload = runInstall(fn, { downloadFailures: 2 });
        assert.match(slowDownload.stdout, /OK/, slowDownload.stderr);
        assert.equal(count(slowDownload.calls, /--download-only/g), 3);
        assert.equal(count(slowDownload.calls, /^apt-get .* install -y --no-download cloudflare-warp$/gm), 1);
        assert.equal(count(slowDownload.calls, /^dpkg /gm), 0, '下載階段被砍不碰 dpkg');
        assert.equal(count(slowDownload.calls, /^apt-get .* update$/gm), 1, '無快取模式下載失敗不補完整 update（前面已做過）');

        const downloadExhausted = runInstall(fn, { downloadFailures: 99 });
        assert.match(downloadExhausted.stdout, /FAILED/);
        assert.equal(count(downloadExhausted.calls, /--download-only/g), 3, '下載最多 3 輪');
        assert.equal(count(downloadExhausted.calls, /^apt-get .* install -y --no-download cloudflare-warp$/gm), 0, '下載沒完成不進解包');

        // 解包被砍在 dpkg 中途：先 dpkg --configure -a 收尾再續一輪（舊版固定死於 dpkg was interrupted）
        const unpackRecovered = runInstall(fn, { unpackFailures: 1 });
        assert.match(unpackRecovered.stdout, /OK/, unpackRecovered.stderr);
        assert.equal(count(unpackRecovered.calls, /^apt-get .* install -y --no-download cloudflare-warp$/gm), 2);
        assert.equal(count(unpackRecovered.calls, /^dpkg --configure -a$/gm), 1);
        assert.equal(count(unpackRecovered.calls, /--download-only/g), 1, '解包重試不重新下載');

        const unpackExhausted = runInstall(fn, { unpackFailures: 99 });
        assert.match(unpackExhausted.stdout, /FAILED/);
        assert.equal(count(unpackExhausted.calls, /^apt-get .* install -y --no-download cloudflare-warp$/gm), 2, '解包最多 2 輪');
    });

    test(`${file}：整體 deadline——各階段上限被剩餘預算夾住，預算不足時不再開下一階段`, () => {
        const { step } = load(file, jobName);
        const fn = functionOf(step);

        // 預算 75 秒：update 上限 = min(30, 75-60) = 15；下載 = min(100, 15) = 15；解包 = min(120, 75) = 75（皆為約數）
        const tight = runInstall(fn, { budget: 75 });
        assert.match(tight.stdout, /OK/, tight.stderr);
        // bash 的 SECONDS 走真實時鐘（假指令啟動也要時間），所以允許最多 3 秒的向下誤差
        const caps = tight.calls.match(/^timeout (\d+)s$/gm).map((l) => Number(l.match(/\d+/)[0]));
        assert.equal(caps.length, 3);
        [15, 15, 75].forEach((expected, i) => assert.ok(caps[i] <= expected && caps[i] >= expected - 3, `階段 ${i + 1} 上限 ${caps[i]}s，預期約 ${expected}s`));

        // 預算 65 秒：update 可用 = 5 < 10 → 直接失敗、不呼叫 apt
        const starved = runInstall(fn, { budget: 65 });
        assert.match(starved.stdout, /FAILED/);
        assert.match(starved.stdout, /time budget \(65s, 60s of it reserved for unpacking\) leaves 5s for apt-get update; giving up/);
        // 剩餘預算不夠比對快取（最多 40 秒）時跳過比對、直接下載：不採用任何快取檔
        const shaOf = (t) => crypto.createHash('sha256').update(t).digest('hex');
        const noTimeToVerify = runInstall(fn, { budget: 100, cache: true, cacheFiles: { 'direct_1_amd64.deb': 'A' }, uris: `'http://x/direct.deb' direct_1_amd64.deb 1 SHA256:${shaOf('A')}\n` });
        assert.match(noTimeToVerify.stdout, /only (3[5-9]|40)s left before the unpack reserve; cached \.deb files are not verified or used/);
        assert.doesNotMatch(noTimeToVerify.calls, /--print-uris/);
        assert.deepEqual(noTimeToVerify.adopted, []);
        assert.match(noTimeToVerify.stdout, /OK/);
        assert.equal(count(starved.calls, /^apt-get /gm), 0);
    });
}
