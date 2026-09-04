'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');

const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'plate-sync.yml');
const laneWorkflowPath = path.join(__dirname, '..', '.github', 'workflows', 'plate-shard-lane.yml');
const setupActionPath = path.join(__dirname, '..', '.github', 'actions', 'setup-plate-runner', 'action.yml');
const crawlerPath = path.join(__dirname, '..', 'gh-plate-sync.cjs');
const workflow = yaml.load(fs.readFileSync(workflowPath, 'utf8'));
const laneWorkflow = yaml.load(fs.readFileSync(laneWorkflowPath, 'utf8'));
const setupAction = yaml.load(fs.readFileSync(setupActionPath, 'utf8'));
const setupSteps = setupAction.runs.steps;

function getStep(name) {
    const step = setupSteps.find((candidate) => candidate.name === name);
    assert.ok(step, `找不到 setup action step: ${name}`);
    return step;
}

function getLaneStep(jobName, stepName) {
    const step = laneWorkflow.jobs[jobName].steps.find((candidate) => candidate.name === stepName);
    assert.ok(step, `找不到 shard lane step: ${jobName}/${stepName}`);
    return step;
}

test('維持 20 分鐘外部觸發契約，且 workflow 不新增內建 schedule', () => {
    assert.deepEqual(workflow.on, { workflow_dispatch: {} });
    assert.equal(workflow.concurrency.group, 'plate-sync-workflow');
    assert.equal(workflow.concurrency['cancel-in-progress'], false);
});

test('每個 shard 使用獨立 recovery lane，不再等待全部 primary 完成後才補跑', () => {
    const lane = workflow.jobs['shard-lane'];

    assert.ok(lane, '缺少 shard-lane reusable workflow matrix');
    assert.equal(workflow.jobs['collect-results'], undefined);
    assert.equal(workflow.jobs['recovery-sync'], undefined);
    assert.match(lane.uses, /plate-shard-lane\.yml/);
    assert.deepEqual(lane.strategy.matrix.shard, ['NORTH', 'CENTRAL', 'SOUTH', 'SHARD4', 'SHARD5']);
    assert.equal(lane.strategy['fail-fast'], false);
});

test('shard lane 共用 19 分鐘 deadline，recovery 直接依賴自己的 primary', () => {
    const primary = laneWorkflow.jobs.primary;
    const recovery = laneWorkflow.jobs.recovery;
    const gate = laneWorkflow.jobs['lane-gate'];

    assert.equal(primary.name, 'primary-attempt (${{ inputs.shard }})');
    assert.equal(primary['timeout-minutes'], 20);
    assert.match(primary.outputs.deadline_epoch, /steps\.budget\.outputs\.deadline_epoch/);
    const budgetStep = getLaneStep('primary', 'Start 19-minute shard lane budget');
    assert.equal(laneWorkflow.env.LANE_BUDGET_SECONDS, '1140', 'lane 預算單一來源');
    assert.match(budgetStep.run, /\+ LANE_BUDGET_SECONDS/);
    assert.equal(getLaneStep('primary', 'Setup primary crawler runner')['timeout-minutes'], 10);
    const primaryCrawl = getLaneStep('primary', 'Run primary crawler once');
    assert.match(primaryCrawl.run, /run-plate-shard-with-recovery\.sh/);
    assert.doesNotMatch(primaryCrawl.run, /fresh/);
    assert.match(primaryCrawl.env.DEADLINE_EPOCH, /steps\.budget\.outputs\.deadline_epoch/);

    // 2026-09-01 熱備援：recovery 與 primary 平行啟動（無 needs/if），deadline
    // 與 primary 結局改由 result artifact 傳遞。
    assert.equal(recovery.needs, undefined);
    assert.equal(recovery.if, undefined);
    assert.equal(recovery['timeout-minutes'], 21);
    assert.equal(recovery['continue-on-error'], true, '備援機失敗不得染紅 reusable workflow');
    assert.equal(getLaneStep('recovery', 'Setup fresh recovery runner')['timeout-minutes'], 8);
    const recoveryCrawl = getLaneStep('recovery', 'Stand by warm and take over within lane budget');
    assert.match(recoveryCrawl.run, /run-plate-shard-with-recovery\.sh.*spare/);
    assert.equal(recoveryCrawl.env.RETRY_COOLDOWN_SECONDS, '8');
    assert.equal(recoveryCrawl.env.MAX_PREFLIGHT_ATTEMPTS, '6');
    assert.ok(recoveryCrawl.env.GH_TOKEN, 'spare 需要 GH_TOKEN 輪詢同 run 的 jobs/artifacts API');
    assert.match(recoveryCrawl.env.SPARE_START_EPOCH, /steps\.spare_budget\.outputs\.spare_start_epoch/);
    assert.ok(getLaneStep('recovery', 'Record spare start for standalone takeover budget'));
    assert.equal(recoveryCrawl.env.DEADLINE_EPOCH, undefined);
    const uploadStep = getLaneStep('primary', 'Publish primary outcome for the hot spare');
    assert.equal(uploadStep.if, 'always()');
    assert.match(uploadStep.with.name, /plate-sync-result-/);
    assert.equal(laneWorkflow.permissions.actions, 'read');
    assert.equal(workflow.permissions.actions, 'read');
    assert.deepEqual(gate.needs, ['primary', 'recovery']);
    assert.equal(gate.if, 'always()');
    assert.equal(workflow.jobs['finalize-sync'].needs, 'recovery-gate');
    assert.equal(workflow.jobs['finalize-sync'].if, 'success()');
});

function runPrimaryOutcomeSummary(status) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-primary-summary-'));
    const summaryPath = path.join(tempDir, 'summary.md');
    const step = getLaneStep('primary', 'Summarize primary crawler outcome');
    const result = spawnSync('/bin/bash', ['-e'], {
        input: step.run,
        encoding: 'utf8',
        env: {
            ...process.env,
            SHARD: 'CENTRAL',
            CRAWL_STATUS: status,
            GITHUB_STEP_SUMMARY: summaryPath,
        },
    });

    return {
        result,
        summary: fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, 'utf8') : '',
    };
}

test('primary job summary 明確區分資料成功與等待 recovery', () => {
    const retry = runPrimaryOutcomeSummary('RETRY');
    const success = runPrimaryOutcomeSummary('SUCCESS');

    assert.equal(retry.result.status, 0, `${retry.result.stdout}${retry.result.stderr}`);
    assert.match(retry.summary, /Primary attempt: CENTRAL/);
    assert.match(retry.summary, /Outcome: `RETRY`/);
    assert.match(retry.summary, /immediately moved to its isolated recovery runner/);

    assert.equal(success.result.status, 0, `${success.result.stdout}${success.result.stderr}`);
    assert.match(success.summary, /Outcome: `SUCCESS`/);
    assert.match(success.summary, /completed during the primary runner/);
});

function runLaneGate(env) {
    const step = getLaneStep('lane-gate', 'Verify shard lane outcome');
    return spawnSync('/bin/bash', ['-e'], {
        input: step.run,
        encoding: 'utf8',
        env: { ...process.env, ...env },
    });
}

test('shard lane gate 只有在 primary 成功或 bounded recovery 完成時放行', () => {
    const primaryPassed = runLaneGate({
        SHARD: 'CENTRAL',
        PRIMARY_RESULT: 'success',
        PRIMARY_STATUS: 'SUCCESS',
        RECOVERY_RESULT: 'skipped',
        RECOVERY_STATUS: '',
    });
    const recoveryPassed = runLaneGate({
        SHARD: 'CENTRAL',
        PRIMARY_RESULT: 'success',
        PRIMARY_STATUS: 'RETRY',
        RECOVERY_RESULT: 'success',
        RECOVERY_STATUS: 'SUCCESS',
    });
    const recoveryFailed = runLaneGate({
        SHARD: 'CENTRAL',
        PRIMARY_RESULT: 'success',
        PRIMARY_STATUS: 'RETRY',
        RECOVERY_RESULT: 'success',
        RECOVERY_STATUS: 'RETRY',
    });

    // continue-on-error 下備援機 setup 崩潰：result 仍是 success 但 status 為空，
    // primary RETRY 時必須 fail-closed（9/3 22:23 案例的反向保護）
    const spareCrashed = runLaneGate({
        SHARD: 'CENTRAL',
        PRIMARY_RESULT: 'success',
        PRIMARY_STATUS: 'RETRY',
        RECOVERY_RESULT: 'success',
        RECOVERY_STATUS: '',
    });
    // primary 自己成功時，備援機崩潰不得影響放行
    const spareCrashedPrimaryOk = runLaneGate({
        SHARD: 'CENTRAL',
        PRIMARY_RESULT: 'success',
        PRIMARY_STATUS: 'SUCCESS',
        RECOVERY_RESULT: 'success',
        RECOVERY_STATUS: '',
    });

    assert.equal(primaryPassed.status, 0, `${primaryPassed.stdout}${primaryPassed.stderr}`);
    assert.equal(recoveryPassed.status, 0, `${recoveryPassed.stdout}${recoveryPassed.stderr}`);
    assert.equal(recoveryFailed.status, 1, `${recoveryFailed.stdout}${recoveryFailed.stderr}`);
    assert.match(`${recoveryFailed.stdout}${recoveryFailed.stderr}`, /did not complete CENTRAL/);
    assert.equal(spareCrashed.status, 1, `${spareCrashed.stdout}${spareCrashed.stderr}`);
    assert.equal(spareCrashedPrimaryOk.status, 0, `${spareCrashedPrimaryOk.stdout}${spareCrashedPrimaryOk.stderr}`);

    // 2026-09-04：primary 死於 setup（無 status）＋備援機整個接手成功 → 放行
    const primaryDiedSpareDone = runLaneGate({
        SHARD: 'CENTRAL', PRIMARY_RESULT: 'failure', PRIMARY_STATUS: '',
        RECOVERY_RESULT: 'success', RECOVERY_STATUS: 'SUCCESS',
    });
    // primary 曾開爬並 HARD_FAILURE → 備援機收工，仍判死
    const primaryHardFailure = runLaneGate({
        SHARD: 'CENTRAL', PRIMARY_RESULT: 'failure', PRIMARY_STATUS: 'HARD_FAILURE',
        RECOVERY_RESULT: 'success', RECOVERY_STATUS: 'SPARE_IDLE',
    });
    // primary 死於 setup 但備援機沒完成 → 判死
    const primaryDiedSpareIdle = runLaneGate({
        SHARD: 'CENTRAL', PRIMARY_RESULT: 'failure', PRIMARY_STATUS: '',
        RECOVERY_RESULT: 'success', RECOVERY_STATUS: 'SPARE_IDLE',
    });
    assert.equal(primaryDiedSpareDone.status, 0, `${primaryDiedSpareDone.stdout}${primaryDiedSpareDone.stderr}`);
    assert.match(`${primaryDiedSpareDone.stdout}`, /hot spare completed the whole shard/);
    assert.equal(primaryHardFailure.status, 1);
    assert.equal(primaryDiedSpareIdle.status, 1);
});

test('WARP 安裝有獨立上限、HTTPS Ubuntu mirror 與 bounded apt retries', () => {
    const setupStep = getLaneStep('primary', 'Setup primary crawler runner');
    const cacheStep = getStep('Cache Cloudflare WARP apt packages');
    const installStep = getStep('Install and Configure Cloudflare WARP');

    assert.equal(setupStep['timeout-minutes'], 10);
    assert.match(installStep.run, /https:\/\/archive\.ubuntu\.com\/ubuntu/);
    assert.match(installStep.run, /timeout --signal=TERM --kill-after=15s 90s/);
    assert.match(installStep.run, /timeout --signal=TERM --kill-after=15s 240s/);
    assert.match(installStep.run, /Acquire::Retries=2/);
    assert.doesNotMatch(installStep.run, /sudo apt-get update &&/);
    // 2026-09-04：快取命中直裝本地 .deb（零 apt-get update）；未命中只更新 Cloudflare 單一來源
    assert.match(installStep.run, /install -y "\$WARP_DEB"/);
    assert.match(installStep.run, /Dir::Etc::sourcelist=\/etc\/apt\/sources\.list\.d\/cloudflare-client\.list/);
    assert.match(installStep.run, /APT::Get::List-Cleanup=0/);
    assert.match(cacheStep.with.key, /plate-shard-lane\.yml/);
});

function runMvdisShellPreflightScenario(scenario) {
    const preflightStep = getStep('Verify IP and MVDIS Connectivity');
    const fakeCommands = `
curl() {
    local args="$*"
    if [[ "$args" == *"cdn-cgi/trace"* ]]; then
        printf 'ip=104.28.201.160\\nloc=US\\nwarp=on\\n'
        return 0
    fi

    if [[ "$args" == *"mvdis.gov.tw"* ]]; then
        if [ "$FAKE_SCENARIO" = "timeout" ]; then
            printf '000 remote_ip= connect=0.000s first_byte=0.000s total=30.000s'
            return 28
        fi
        printf '200 remote_ip=203.0.113.20 connect=0.010s first_byte=0.100s total=0.100s'
        return 0
    fi

    return 0
}
`;

    return spawnSync('/bin/bash', ['-e'], {
        input: `${fakeCommands}\n${preflightStep.run}`,
        encoding: 'utf8',
        env: { ...process.env, FAKE_SCENARIO: scenario },
    });
}

test('MVDIS shell preflight 固定 IPv4，curl timeout 不再形成 0000 假綠燈', () => {
    const preflightStep = getStep('Verify IP and MVDIS Connectivity');
    const result = runMvdisShellPreflightScenario('timeout');
    const output = `${result.stdout}${result.stderr}`;

    assert.match(preflightStep.run, /curl -4/);
    assert.match(preflightStep.run, /CURL_EXIT/);
    assert.doesNotMatch(preflightStep.run, /\|\| echo "0"/);
    assert.equal(result.status, 0, output);
    assert.match(output, /MVDIS shell preflight inconclusive: curl=28 HTTP=000/);
    assert.doesNotMatch(output, /MVDIS is reachable/);
});

function runGeminiPreflightScenario(scenario) {
    const preflightStep = getStep('Verify Gemini API Direct Egress');
    const stepScript = preflightStep.run.replaceAll('${{ inputs.shards }}', 'NORTH');
    const fakeCommands = `
curl() {
    local output_file=""
    local previous=""

    while [ "$#" -gt 0 ]; do
        if [ "$previous" = "-o" ]; then
            output_file="$1"
        fi
        previous="$1"
        shift
    done

    if [ -z "\${ATTEMPT:-}" ]; then
        printf '203.0.113.10'
        return 0
    fi

    if [ -n "$output_file" ]; then
        printf '{"error":{"message":"fixture"}}' > "$output_file"
    fi

    case "\${FAKE_SCENARIO}:\${ATTEMPT}" in
        transport-then-success:1|transport-always:*)
            printf '000 remote_ip= connect=0.000s tls=0.000s first_byte=0.000s total=30.000s'
            return 28
            ;;
        http500-then-success:1)
            printf '500 remote_ip=203.0.113.20 connect=0.010s tls=0.020s first_byte=0.100s total=0.100s'
            return 0
            ;;
        permanent400:1)
            printf '400 remote_ip=203.0.113.20 connect=0.010s tls=0.020s first_byte=0.100s total=0.100s'
            return 0
            ;;
        quota429:1)
            printf '429 remote_ip=203.0.113.20 connect=0.010s tls=0.020s first_byte=0.100s total=0.100s'
            return 0
            ;;
        *)
            printf '200 remote_ip=203.0.113.20 connect=0.010s tls=0.020s first_byte=0.100s total=0.100s'
            return 0
            ;;
    esac
}

sleep() {
    return 0
}
`;

    return spawnSync('/bin/bash', ['-e'], {
        input: `${fakeCommands}\n${stepScript}`,
        encoding: 'utf8',
        env: {
            ...process.env,
            FAKE_SCENARIO: scenario,
            GEMINI_API_KEY: 'fixture-key',
            GEMINI_API_KEY_NORTH: 'fixture-key',
            GEMINI_API_KEY_CENTRAL: 'fixture-key',
            GEMINI_API_KEY_SOUTH: 'fixture-key',
            GEMINI_API_KEY_SHARD4: 'fixture-key',
            GEMINI_API_KEY_SHARD5: 'fixture-key',
        },
    });
}

test('Gemini transport timeout 會重試，第二次成功後通過', () => {
    const result = runGeminiPreflightScenario('transport-then-success');
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 0, output);
    assert.match(output, /Transient Gemini transport error \(curl 28\); retrying in 5s/);
    assert.match(output, /Gemini generateContent preflight passed/);
});

test('Gemini HTTP 500 會重試，第二次成功後通過', () => {
    const result = runGeminiPreflightScenario('http500-then-success');
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 0, output);
    assert.match(output, /Transient Gemini HTTP 500; retrying in 5s/);
    assert.match(output, /Gemini generateContent preflight passed/);
});

test('Gemini 永久 HTTP 400 仍 fail-closed', () => {
    const result = runGeminiPreflightScenario('permanent400');
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 1, output);
    assert.match(output, /Gemini preflight failed with permanent HTTP 400/);
});

test('Gemini HTTP 429 交給 crawler key/model ladder，不在預檢誤殺 shard', () => {
    const result = runGeminiPreflightScenario('quota429');
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 0, output);
    assert.match(output, /deferring quota handling to the crawler key\/model ladder/);
});

test('Gemini transport error 三次後降為 warning，由 crawler 安全機制裁決', () => {
    const result = runGeminiPreflightScenario('transport-always');
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 0, output);
    assert.match(output, /attempt 3\/3/);
    assert.match(output, /transient failure after 3 attempts/);
});

test('crawler 將 MVDIS preflight 分類為暫時性 exit 75，正常路徑最多只錯峰 80 秒', () => {
    const source = fs.readFileSync(crawlerPath, 'utf8');

    assert.match(source, /MVDIS_PREFLIGHT_EXIT_CODE\s*=\s*75/);
    assert.match(source, /preflightError\.exitCode\s*=\s*MVDIS_PREFLIGHT_EXIT_CODE/);
    assert.match(source, /'CENTRAL': 20000/);
    assert.match(source, /'SOUTH': 40000/);
    assert.match(source, /'SHARD4': 60000/);
    assert.match(source, /'SHARD5': 80000/);
    assert.match(source, /process\.env\.SKIP_SHARD_JITTER !== '1'/);
    assert.doesNotMatch(source, /Fix: set PROXY_URL secret/);
});

test('crawler 將連環驗證碼被拒分類為出口 IP 軟封鎖，丟 exit 75 交回 workflow 重抽身分', () => {
    const source = fs.readFileSync(crawlerPath, 'utf8');

    // 門檻常數存在且為跨站累計、成功歸零的語義
    assert.match(source, /CAPTCHA_REJECT_BAILOUT_THRESHOLD\s*=\s*4/);
    assert.match(source, /consecutiveCaptchaRejects\s*=\s*0/);
    // bail 錯誤必須帶 MVDIS_PREFLIGHT_EXIT_CODE 才會被 wrapper 視為可重抽
    assert.match(source, /bailErr\.exitCode\s*=\s*MVDIS_PREFLIGHT_EXIT_CODE/);
    // 站點層 catch 必須把 exit 75 類錯誤往上拋，不得吞掉降級成「跳過本站」
    assert.match(source, /stationErr\.exitCode\s*===\s*MVDIS_PREFLIGHT_EXIT_CODE/);
    // 站中導航連續逾時同樣屬可重抽類（2026-08-31 恆春案例），不得再走
    // 跳站→單站失敗→HARD_FAILURE 的死刑路徑
    assert.match(source, /navAbortErr\.exitCode\s*=\s*MVDIS_PREFLIGHT_EXIT_CODE/);
    assert.doesNotMatch(source, /All navigation attempts failed, skipping station/);
});

test('crawler 支援同 run 站點續爬：完成站記錄檔＋跳站，wrapper 傳入檔案路徑', () => {
    const source = fs.readFileSync(crawlerPath, 'utf8');
    const wrapper = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'run-plate-shard-with-recovery.sh'), 'utf8');

    // 只在 shard 模式啟用；成功站寫檔、重啟時跳過
    assert.match(source, /TARGET_SHARD && process\.env\.COMPLETED_STATIONS_FILE/);
    assert.match(source, /recordCompletedStation\(COMPLETED_STATIONS_FILE, completedStations, station\.id\)/);
    assert.match(source, /completedStations\.has\(String\(station\.id\)\)/);
    // wrapper 對三種 node 呼叫（有/無 deadline 的 crawl＋spare 暖身探測）
    // 都要傳入同一份記錄檔
    const passCount = (wrapper.match(/COMPLETED_STATIONS_FILE="\$COMPLETED_STATIONS_FILE"/g) || []).length;
    assert.equal(passCount, 3);
});
