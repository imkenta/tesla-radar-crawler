'use strict';

// 2026-11-10 健檢 O7：bidding-plates-sync / bid-announce-sync 的 WARP 安裝步驟原本是裸的
// `sudo apt-get update && sudo apt-get install -y cloudflare-warp`（無逾時）。11/9 兩輪各卡 7.5 分鐘，
// 被 10 分鐘 job timeout 砍掉，爬完卻沒寫入。改成有上限的 update 重試＋單次 install（240 秒）＋步驟層 timeout。
// 審查修正：Ubuntu 26.04 的 install 要下載 125 MB，綠燈輪次實測 66 秒～2 分 54 秒，所以 90 秒上限會砍掉原本會綠的輪次。

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

for (const [file, jobName] of WORKFLOWS) {
    test(`${file}：WARP 安裝有 timeout 包裝、有限重試、步驟層上限，且不再有裸的 apt-get update &&`, () => {
        const { job, step } = load(file, jobName);
        assert.doesNotMatch(step.run, /sudo apt-get update &&/);
        // 上限與 setup-plate-runner/action.yml 的 refresh_all_indexes(90s)／install_warp(240s) 一致
        assert.match(step.run, /timeout --signal=TERM --kill-after=15s 90s/);
        assert.match(step.run, /timeout --signal=TERM --kill-after=15s 240s/);
        assert.match(step.run, /kill-after=15s 240s \\\n\s+env DEBIAN_FRONTEND=noninteractive/, 'install 的上限必須是 240 秒');
        assert.match(step.run, /for TRY in 1 2; do/);
        assert.match(step.run, /single attempt/);
        assert.match(step.run, /Acquire::Retries=2/);
        assert.match(step.run, /curl -fsSL --connect-timeout 10 --max-time 30 --retry 2/);
        assert.match(step.run, /if ! install_warp_bounded; then[\s\S]*?exit 1/);
        // 步驟上限必須小於 job 上限（才能「在 job timeout 之前失敗」），且要容得下慢速輪次：
        // 金鑰 ~1s ＋ update ~20s ＋ install 最多 180s ≈ 3.5 分；update 卡一次再成功 ≈ 5.1 分。
        const stepMin = step['timeout-minutes'];
        assert.ok(stepMin >= 6 && stepMin < job['timeout-minutes'], `step ${stepMin} < job ${job['timeout-minutes']}`);
        assert.ok(job['timeout-minutes'] - stepMin >= 3, '步驟上限後要留 ≥3 分鐘給 npm ci＋爬取');
        // 不動既有的 job 上限（本批不改）
        assert.equal(job['timeout-minutes'], 10);
    });

    test(`${file}：安裝函式在 bash 中的行為——update 可重試、install 只跑一次`, () => {
        const { step } = load(file, jobName);
        const fn = step.run.match(/^install_warp_bounded\(\) \{[\s\S]*?^\}$/m);
        assert.ok(fn, '找不到 install_warp_bounded');

        // updateFailures：前 N 次 update 失敗（模擬卡住被 timeout 砍掉＝124）；installExit：install 的結束碼
        const run = (updateFailures, installExit = 0) => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warp-'));
            try {
                const bin = path.join(dir, 'bin');
                fs.mkdirSync(bin);
                const log = path.join(dir, 'calls.log');
                const write = (name, body) => {
                    fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
                };
                write('sudo', 'exec "$@"');
                // timeout --signal=TERM --kill-after=15s <secs> cmd...  → 記錄上限秒數後直接執行
                write('timeout', `echo "timeout $3" >> "${log}"; shift 3; exec "$@"`);
                write('sleep', 'exit 0');
                write('apt-get', `
echo "apt-get $*" >> "${log}"
case " $* " in
  *" update "*)
    n=$(grep -c ' update$' "${log}" || true)
    if [ "$n" -le ${updateFailures} ]; then exit 124; fi ;;
  *" install "*) exit ${installExit} ;;
esac
exit 0`);
                const result = spawnSync('/bin/bash', ['-e'], {
                    input: `${fn[0]}\ninstall_warp_bounded && echo OK || echo FAILED`,
                    encoding: 'utf8',
                    env: { PATH: `${bin}:${process.env.PATH}` },
                });
                return { ...result, calls: fs.readFileSync(log, 'utf8') };
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        };
        const count = (text, re) => (text.match(re) || []).length;

        const clean = run(0);
        assert.match(clean.stdout, /OK/, clean.stderr);
        assert.match(clean.calls, /timeout 90s/);
        assert.match(clean.calls, /timeout 240s/);
        assert.equal(count(clean.calls, /install -y cloudflare-warp/g), 1);

        const recovered = run(1);
        assert.match(recovered.stdout, /OK/, recovered.stderr);
        assert.match(recovered.stdout, /attempt 1\/2/);
        assert.match(recovered.stdout, /attempt 2\/2/);
        assert.equal(count(recovered.calls, /^apt-get .* update$/gm), 2);
        assert.equal(count(recovered.calls, /install -y cloudflare-warp/g), 1, '只有 update 成功後才跑 install，且只一次');

        const updateExhausted = run(99);
        assert.match(updateExhausted.stdout, /FAILED/);
        assert.equal(count(updateExhausted.calls, /^apt-get .* update$/gm), 2, 'update 最多 2 輪');
        assert.equal(count(updateExhausted.calls, /install -y/g), 0);

        const installFails = run(0, 100);
        assert.match(installFails.stdout, /FAILED/);
        assert.equal(count(installFails.calls, /install -y cloudflare-warp/g), 1, 'install 失敗不重跑（避免 dpkg was interrupted 的第二輪）');
    });
}
