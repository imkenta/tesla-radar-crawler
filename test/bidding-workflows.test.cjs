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
    const fn = step.run.match(/^install_warp_bounded\(\) \{[\s\S]*?^\}$/m);
    assert.ok(fn, '找不到 install_warp_bounded');
    return fn[0];
};

// 在假 sudo／timeout／apt-get／dpkg 下執行安裝函式。
//   updateFailures／downloadFailures／unpackFailures：各階段前 N 次呼叫失敗（模擬卡住被 timeout 砍掉＝124）
//   budget：WARP_APT_BUDGET（秒）；假 timeout 不會真的等，所以只用來驗證「各階段上限被剩餘預算夾住」
function runInstall(fnText, { updateFailures = 0, downloadFailures = 0, unpackFailures = 0, budget } = {}) {
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
        write('dpkg', `echo "dpkg $*" >> "${log}"; exit 0`);
        write('apt-get', `
echo "apt-get $*" >> "${log}"
case " $* " in
  *" update "*)
    n=$(grep -c '^apt-get .* update$' "${log}" || true)
    if [ "$n" -le ${updateFailures} ]; then exit 124; fi ;;
  *" --download-only "*)
    n=$(grep -c -- '--download-only' "${log}" || true)
    if [ "$n" -le ${downloadFailures} ]; then exit 124; fi ;;
  *" install "*)
    n=$(grep -c '^apt-get .* install -y cloudflare-warp$' "${log}" || true)
    if [ "$n" -le ${unpackFailures} ]; then exit 124; fi ;;
esac
exit 0`);
        const env = { PATH: `${bin}:${process.env.PATH}` };
        if (budget !== undefined) env.WARP_APT_BUDGET = String(budget);
        const result = spawnSync('/bin/bash', ['-e'], {
            input: `${fnText}\ninstall_warp_bounded && echo OK || echo FAILED`,
            encoding: 'utf8',
            env,
        });
        return { ...result, calls: fs.readFileSync(log, 'utf8') };
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
        // 鏡像卡住時改用 archive.ubuntu.com（只改 mirror 清單檔內容），update 與下載失敗後都會呼叫
        assert.match(step.run, /use_fallback_ubuntu_mirror\(\) \{[\s\S]*?\/etc\/apt\/apt-mirrors\.txt[\s\S]*?https:\/\/archive\.ubuntu\.com\/ubuntu\//);
        assert.ok((step.run.match(/^\s*use_fallback_ubuntu_mirror$/gm) || []).length >= 2);
        assert.match(step.run, /Acquire::Retries=2/);
        assert.match(step.run, /Acquire::http::Timeout=15/);
        assert.match(step.run, /curl -fsSL --connect-timeout 10 --max-time 30 --retry 2/);
        assert.match(step.run, /if ! install_warp_bounded; then[\s\S]*?exit 1/);
        // 不得再有「下載＋解包」合一、固定 240 秒的 install
        assert.doesNotMatch(step.run, /kill-after=15s 240s/);
        // 步驟上限 < job 上限，job 上限不動；步驟後要留給 Setup Node＋npm ci＋同步（p99 191 秒、max 201 秒）
        const stepMin = step['timeout-minutes'];
        assert.equal(stepMin, 7);
        assert.equal(job['timeout-minutes'], 10);
        assert.ok(job['timeout-minutes'] - stepMin >= 3);
        // 預算帳：函式 330 秒＋WARP 設定 ~25 秒＋後續最大 201 秒 < job 600 秒；函式 330 秒＋金鑰 ≥1 秒＋設定 25 秒 < 步驟 420 秒
        assert.ok(330 + 5 + 30 + 25 + 201 < job['timeout-minutes'] * 60);
        assert.ok(1 + 330 + 25 < stepMin * 60);
    });

    test(`${file}：安裝函式行為——正常路徑各階段上限、可續傳下載重試、解包失敗後 dpkg --configure -a`, () => {
        const { step } = load(file, jobName);
        const fn = functionOf(step);

        const clean = runInstall(fn);
        assert.match(clean.stdout, /OK/, clean.stderr);
        assert.deepEqual(clean.calls.match(/^timeout .*$/gm), ['timeout 30s', 'timeout 100s', 'timeout 120s']);
        assert.equal(count(clean.calls, /--download-only/g), 1);
        assert.equal(count(clean.calls, /^apt-get .* install -y cloudflare-warp$/gm), 1);
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
        // 前兩輪都失敗：第 3 輪只更新 Cloudflare 來源（上限 20 秒），Ubuntu 清單沿用既有的，然後照常下載
        const updateFallback = runInstall(fn, { updateFailures: 2 });
        assert.match(updateFallback.stdout, /OK/, updateFallback.stderr);
        updateCalls = updateFallback.calls.match(/^apt-get .* update$/gm);
        assert.equal(updateCalls.length, 3);
        assert.doesNotMatch(updateCalls[1], /Dir::Etc::sourcelist/);
        assert.match(updateCalls[2], /Dir::Etc::sourcelist=sources\.list\.d\/cloudflare-client\.list -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0 update$/);
        assert.deepEqual(updateFallback.calls.match(/^timeout .*$/gm).slice(0, 3), ['timeout 30s', 'timeout 45s', 'timeout 20s']);
        assert.match(updateFallback.stdout, /falling back to Cloudflare-only apt index/);
        assert.equal(count(updateFallback.calls, /--download-only/g), 1);
        assert.doesNotMatch(clean.stdout, /falling back|mirror switched/);
        const updateExhausted = runInstall(fn, { updateFailures: 99 });
        assert.match(updateExhausted.stdout, /FAILED/);
        assert.equal(count(updateExhausted.calls, /^apt-get .* update$/gm), 3, 'update 最多 3 輪');
        assert.equal(count(updateExhausted.calls, /--download-only/g), 0);

        // 慢鏡像：下載前兩輪被砍，第三輪成功（半成品續傳由 apt 負責，這裡驗證「會再試」且只解包一次）
        const slowDownload = runInstall(fn, { downloadFailures: 2 });
        assert.match(slowDownload.stdout, /OK/, slowDownload.stderr);
        assert.equal(count(slowDownload.calls, /--download-only/g), 3);
        assert.equal(count(slowDownload.calls, /^apt-get .* install -y cloudflare-warp$/gm), 1);
        assert.equal(count(slowDownload.calls, /^dpkg /gm), 0, '下載階段被砍不碰 dpkg');

        const downloadExhausted = runInstall(fn, { downloadFailures: 99 });
        assert.match(downloadExhausted.stdout, /FAILED/);
        assert.equal(count(downloadExhausted.calls, /--download-only/g), 3, '下載最多 3 輪');
        assert.equal(count(downloadExhausted.calls, /^apt-get .* install -y cloudflare-warp$/gm), 0, '下載沒完成不進解包');

        // 解包被砍在 dpkg 中途：先 dpkg --configure -a 收尾再續一輪（舊版固定死於 dpkg was interrupted）
        const unpackRecovered = runInstall(fn, { unpackFailures: 1 });
        assert.match(unpackRecovered.stdout, /OK/, unpackRecovered.stderr);
        assert.equal(count(unpackRecovered.calls, /^apt-get .* install -y cloudflare-warp$/gm), 2);
        assert.equal(count(unpackRecovered.calls, /^dpkg --configure -a$/gm), 1);
        assert.equal(count(unpackRecovered.calls, /--download-only/g), 1, '解包重試不重新下載');

        const unpackExhausted = runInstall(fn, { unpackFailures: 99 });
        assert.match(unpackExhausted.stdout, /FAILED/);
        assert.equal(count(unpackExhausted.calls, /^apt-get .* install -y cloudflare-warp$/gm), 2, '解包最多 2 輪');
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
        assert.match(starved.stdout, /budget exhausted before apt-get update/);
        assert.equal(count(starved.calls, /^apt-get /gm), 0);
    });
}
