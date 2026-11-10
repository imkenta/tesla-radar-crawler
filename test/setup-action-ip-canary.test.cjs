'use strict';

// 2026-11-10 健檢 O2：setup action 的「直連出口 IP 金絲雀」原本是單次 `curl api.ipify.org`。
// 11/8 15:23 ipify 一次逾時，7 個 job 在 80 秒內死在 setup。改成有上限的重試＋備援端點，
// 但「確實不是預期出口就中止」的語意不能變。這裡把 action.yml 內的 fetch_direct_ipv4 抽出來，
// 用假 curl 在真實 bash 裡跑。

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');

const actionPath = path.join(__dirname, '..', '.github', 'actions', 'setup-plate-runner', 'action.yml');
const steps = yaml.load(fs.readFileSync(actionPath, 'utf8')).runs.steps;
const step = (name) => steps.find((s) => s.name === name);

const warpStep = step('Install and Configure Cloudflare WARP');
const geminiStep = step('Verify Gemini API Direct Egress');
const FUNC_RE = /^fetch_direct_ipv4\(\) \{[\s\S]*?^\}$/m;

test('兩個使用 IP 查詢的步驟都定義了 fetch_direct_ipv4，且不再有裸的單次 ipify curl', () => {
    assert.match(warpStep.run, FUNC_RE);
    assert.match(geminiStep.run, FUNC_RE);
    for (const s of [warpStep, geminiStep]) {
        // 去掉函式本體與註解行後，不得再有直接 curl ipify 的指令
        const code = s.run.replace(FUNC_RE, '').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
        assert.doesNotMatch(code, /curl[^\n]*api\.ipify\.org/, '函式外不得再有直接 curl ipify');
    }
    assert.match(warpStep.run, /BEFORE_RESULT=\$\(fetch_direct_ipv4\)/, 'BEFORE 走重試函式');
    assert.match(warpStep.run, /AFTER_RESULT=\$\(fetch_direct_ipv4 "\$BEFORE_ENDPOINT"\)/, 'AFTER 優先問 BEFORE 回答的端點');
});

test('重試函式不得使用 ATTEMPT 變數（Gemini 預檢與其測試的假 curl 靠它分辨呼叫）', () => {
    const fn = warpStep.run.match(FUNC_RE)[0];
    assert.doesNotMatch(fn, /\bATTEMPT\b/);
});

// 假 curl：依 URL 回不同的結果。FAKE_IPIFY／FAKE_AMAZON 為該端點的回應（空字串＝失敗 exit 28），
// FAKE_IPIFY_FAIL_FIRST=1 代表 ipify 第一次呼叫逾時。
function runWithFakeCurl(script, env = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-'));
    const counter = path.join(dir, 'calls');
    fs.writeFileSync(counter, '');
    const fake = `
curl() {
    local url="\${*: -1}"
    echo "$url" >> "${counter}"
    local value
    case "$url" in
        *ipify*) value="$FAKE_IPIFY"
                 if [ -n "\${FAKE_IPIFY_FAIL_FIRST:-}" ] && [ "$(grep -c ipify "${counter}")" -eq 1 ]; then return 28; fi ;;
        *amazonaws*) value="$FAKE_AMAZON" ;;
        *) return 28 ;;
    esac
    [ -n "$value" ] || return 28
    printf '%s\\n' "$value"
}
sleep() { :; }
`;
    try {
        const result = spawnSync('/bin/bash', ['-e'], {
            input: `${fake}\n${script}`,
            encoding: 'utf8',
            env: { ...process.env, FAKE_IPIFY: '', FAKE_AMAZON: '', ...env },
        });
        const calls = fs.readFileSync(counter, 'utf8').split('\n').filter(Boolean);
        return { ...result, calls };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

const fn = warpStep.run.match(FUNC_RE)[0];
const IPIFY = 'https://api.ipify.org';
const AMAZON = 'https://checkip.amazonaws.com';

test('curl 單次上限恢復為原本的 15 秒', () => {
    assert.match(fn, /curl -4 -fsS --max-time 15 "\$ENDPOINT"/);
});

test('主端點偶發逾時一次 → 重試後取得 IP（輸出「端點 IP」）', () => {
    const r = runWithFakeCurl(`${fn}\nfetch_direct_ipv4`, { FAKE_IPIFY: '203.0.113.7', FAKE_AMAZON: '203.0.113.7', FAKE_IPIFY_FAIL_FIRST: '1' });
    assert.equal(r.status, 0, r.stderr);
    // ipify 第一次逾時 → 同一輪改問備援，備援成功
    assert.equal(r.stdout.trim(), `${AMAZON} 203.0.113.7`);
    assert.ok(r.calls.length >= 2);
});

test('主端點持續不通 → 改用備援端點取得 IP', () => {
    const r = runWithFakeCurl(`${fn}\nfetch_direct_ipv4`, { FAKE_AMAZON: '198.51.100.9' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), `${AMAZON} 198.51.100.9`);
});

test('指定偏好端點時先問該端點；偏好端點失敗才退到另一個', () => {
    const ok = runWithFakeCurl(`${fn}\nfetch_direct_ipv4 ${AMAZON}`, { FAKE_IPIFY: '203.0.113.7', FAKE_AMAZON: '203.0.113.7' });
    assert.equal(ok.stdout.trim(), `${AMAZON} 203.0.113.7`);
    assert.deepEqual(ok.calls, [AMAZON]);

    const fallback = runWithFakeCurl(`${fn}\nfetch_direct_ipv4 ${AMAZON}`, { FAKE_IPIFY: '203.0.113.7' });
    assert.equal(fallback.stdout.trim(), `${IPIFY} 203.0.113.7`);
    assert.equal(fallback.calls[0], AMAZON);
});

test('全部端點、全部輪次都失敗 → 非 0、不輸出任何 IP；總嘗試次數有上限（3 輪 × 2 端點）', () => {
    const r = runWithFakeCurl(`${fn}\nfetch_direct_ipv4 || echo "rc=$?"`);
    assert.equal(r.stdout.trim(), 'rc=1');
    assert.equal(r.calls.length, 6);
});

test('端點回 200 但內容不是 IPv4（HTML 錯誤頁）→ 視為失敗，不會把垃圾當 IP', () => {
    const r = runWithFakeCurl(`${fn}\nfetch_direct_ipv4 || echo "rc=$?"`, { FAKE_IPIFY: '<html>error</html>', FAKE_AMAZON: '<html>x</html>' });
    assert.equal(r.stdout.trim(), 'rc=1');
});

// ---- 金絲雀整段（BEFORE 區塊 ＋ AFTER 區塊）----

const beforeBlock = warpStep.run.match(/^if ! BEFORE_RESULT=\$\(fetch_direct_ipv4\); then[\s\S]*?^DIRECT_IP_BEFORE=.*$/m);
const afterStart = warpStep.run.indexOf('if ! AFTER_RESULT=');
const afterBlock = warpStep.run.slice(afterStart);

test('金絲雀語意不變：BEFORE 取不到 → 中止（exit 1），不會以空字串 == 空字串 放行', () => {
    assert.ok(beforeBlock, '找不到 BEFORE 區塊');
    const r = runWithFakeCurl(`${fn}\n${beforeBlock[0]}\necho "SHOULD-NOT-REACH"`);
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stdout, /SHOULD-NOT-REACH/);
    assert.match(r.stdout, /::error::Unable to determine the GitHub direct IPv4 before WARP/);
});

test('金絲雀語意不變：AFTER 取不到 → 中止（exit 1）', () => {
    assert.ok(afterStart > 0);
    const r = runWithFakeCurl(`${fn}\nBEFORE_ENDPOINT=${IPIFY}\nDIRECT_IP_BEFORE=203.0.113.7\n${afterBlock}\necho "SHOULD-NOT-REACH"`);
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stdout, /SHOULD-NOT-REACH/);
    assert.match(r.stdout, /::error::Unable to determine the GitHub direct IPv4 after WARP exclusion/);
});

test('金絲雀語意不變：IP 變了 → 中止（exit 1）；IP 相同 → 通過', () => {
    const base = `${fn}\nBEFORE_ENDPOINT=${IPIFY}\nDIRECT_IP_BEFORE=203.0.113.7\n${afterBlock}\necho "PASSED"`;
    const changed = runWithFakeCurl(base, { FAKE_IPIFY: '104.28.201.160', FAKE_AMAZON: '104.28.201.160' });
    assert.equal(changed.status, 1);
    assert.match(changed.stdout, /::error::Split-tunnel canary changed IP/);
    assert.doesNotMatch(changed.stdout, /PASSED/);

    const same = runWithFakeCurl(base, { FAKE_IPIFY: '203.0.113.7', FAKE_AMAZON: '203.0.113.7' });
    assert.equal(same.status, 0, same.stdout + same.stderr);
    assert.match(same.stdout, /PASSED/);
    assert.doesNotMatch(same.stdout, /across endpoints/, '同端點比對不該有警告');
});

test('BEFORE 由備援端點回答時，AFTER 優先問同一個備援端點，不跨端點', () => {
    const script = `${fn}\nBEFORE_ENDPOINT=${AMAZON}\nDIRECT_IP_BEFORE=203.0.113.7\n${afterBlock}\necho "PASSED"`;
    const r = runWithFakeCurl(script, { FAKE_IPIFY: '203.0.113.7', FAKE_AMAZON: '203.0.113.7' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(r.calls, [AMAZON]);
    assert.doesNotMatch(r.stdout, /across endpoints/);
});

test('同端點失敗才跨端點比對，並在 log 註明；跨端點下 IP 不同仍中止', () => {
    const script = `${fn}\nBEFORE_ENDPOINT=${IPIFY}\nDIRECT_IP_BEFORE=203.0.113.7\n${afterBlock}\necho "PASSED"`;
    const crossOk = runWithFakeCurl(script, { FAKE_AMAZON: '203.0.113.7' }); // ipify 掛了
    assert.equal(crossOk.status, 0, crossOk.stdout + crossOk.stderr);
    assert.match(crossOk.stdout, /::warning::Canary compares across endpoints \(before: https:\/\/api\.ipify\.org, after: https:\/\/checkip\.amazonaws\.com\)/);

    const crossChanged = runWithFakeCurl(script, { FAKE_AMAZON: '104.28.201.160' });
    assert.equal(crossChanged.status, 1);
    assert.match(crossChanged.stdout, /Split-tunnel canary changed IP/);
});

test('金絲雀語意不變：原本兩個必排除 host 仍是致命；備援端點排除只警告', () => {
    assert.match(warpStep.run, /if \[ "\$DIRECT_IP_AFTER" != "\$DIRECT_IP_BEFORE" \]; then\s+echo "::error::Split-tunnel canary changed IP; Gemini bypass is not proven\."\s+exit 1\s+fi/);
    assert.match(warpStep.run, /for HOST in generativelanguage\.googleapis\.com api\.ipify\.org; do[\s\S]*?Failed to exclude \$HOST from WARP; refusing an unverified Gemini route\."\s+exit 1/);
    assert.match(warpStep.run, /tunnel host add checkip\.amazonaws\.com/);
    assert.match(warpStep.run, /::warning::Failed to exclude backup canary endpoint/);
});

test('Gemini 預檢步驟的 IP 診斷查不到時不致命（僅顯示 UNKNOWN），查到時只顯示 IP', () => {
    assert.match(geminiStep.run, /DIRECT_RESULT=\$\(fetch_direct_ipv4\); then DIRECT_IP=\$\{DIRECT_RESULT#\* \}; else DIRECT_IP="UNKNOWN"; fi/);
    const diag = geminiStep.run.match(/^ *if DIRECT_RESULT=.*fi$/m)[0];
    const down = runWithFakeCurl(`${fn}\n${diag}\necho "IP=$DIRECT_IP"`);
    assert.equal(down.status, 0);
    assert.match(down.stdout, /IP=UNKNOWN/);
    const up = runWithFakeCurl(`${fn}\n${diag}\necho "IP=$DIRECT_IP"`, { FAKE_IPIFY: '203.0.113.7' });
    assert.match(up.stdout, /IP=203\.0\.113\.7$/m);
});
