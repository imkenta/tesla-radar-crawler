'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');

const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'plate-sync.yml');
const setupActionPath = path.join(__dirname, '..', '.github', 'actions', 'setup-plate-runner', 'action.yml');
const crawlerPath = path.join(__dirname, '..', 'gh-plate-sync.cjs');
const workflow = yaml.load(fs.readFileSync(workflowPath, 'utf8'));
const setupAction = yaml.load(fs.readFileSync(setupActionPath, 'utf8'));
const setupSteps = setupAction.runs.steps;

function getStep(name) {
    const step = setupSteps.find((candidate) => candidate.name === name);
    assert.ok(step, `找不到 setup action step: ${name}`);
    return step;
}

function getWorkflowStep(jobName, stepName) {
    const step = workflow.jobs[jobName].steps.find((candidate) => candidate.name === stepName);
    assert.ok(step, `找不到 workflow step: ${jobName}/${stepName}`);
    return step;
}

function parseGithubOutput(outputPath) {
    return Object.fromEntries(fs.readFileSync(outputPath, 'utf8').trim().split('\n').map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
    }));
}

test('維持 20 分鐘外部觸發契約，且 workflow 不新增內建 schedule', () => {
    assert.deepEqual(workflow.on, { workflow_dispatch: {} });
    assert.equal(workflow.concurrency.group, 'plate-sync-workflow');
    assert.equal(workflow.concurrency['cancel-in-progress'], false);
});

test('初始 shard、fresh-runner recovery matrix 與 atomic-swap gate 完整串接', () => {
    const primary = workflow.jobs['sync-plates'];
    const collect = workflow.jobs['collect-results'];
    const recovery = workflow.jobs['recovery-sync'];
    const gate = workflow.jobs['recovery-gate'];
    const finalizer = workflow.jobs['finalize-sync'];

    assert.equal(primary.name, 'primary-attempt (${{ matrix.shard }})');
    assert.equal(collect.name, 'classify-primary-outcomes');
    assert.equal(recovery.name, 'recovery-attempt (${{ matrix.shard }})');
    assert.equal(gate.name, 'verify-all-shards-complete');
    assert.equal(finalizer.name, 'finalize-atomic-swap');
    assert.deepEqual(primary.strategy.matrix.shard, ['NORTH', 'CENTRAL', 'SOUTH', 'SHARD4', 'SHARD5']);
    assert.equal(primary.strategy['fail-fast'], false);
    assert.match(primary.steps.find((step) => step.id === 'crawl').run, /run-plate-shard-with-recovery\.sh/);
    assert.equal(primary.steps.find((step) => step.name === 'Upload shard outcome').uses, 'actions/upload-artifact@v4');
    assert.match(primary.steps.find((step) => step.name === 'Enforce non-retryable crawler failure').if, /HARD_FAILURE/);

    assert.equal(collect.if, 'always()');
    assert.match(collect.outputs.retry_matrix, /retry_matrix/);
    assert.match(recovery.if, /has_retries/);
    assert.equal(recovery['timeout-minutes'], 45);
    assert.match(recovery.strategy.matrix, /fromJSON/);
    const recoveryStep = recovery.steps.find((step) => step.name.includes('Retry Crawler Shard'));
    assert.match(recoveryStep.run, /run-plate-shard-with-recovery\.sh.*fresh/);
    assert.match(recoveryStep.env.INITIAL_DELAY_SECONDS, /matrix\.initial_delay_seconds/);
    assert.match(recoveryStep.env.RETRY_COOLDOWN_SECONDS, /matrix\.retry_cooldown_seconds/);
    assert.equal(recoveryStep.env.MAX_PREFLIGHT_ATTEMPTS, '3');
    assert.equal(gate.if, 'always()');
    assert.deepEqual(gate.needs, ['collect-results', 'recovery-sync']);
    assert.equal(finalizer.needs, 'recovery-gate');
    assert.equal(finalizer.if, 'success()');
});

function runPrimaryOutcomeSummary(status) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-primary-summary-'));
    const summaryPath = path.join(tempDir, 'summary.md');
    const step = getWorkflowStep('sync-plates', 'Summarize primary crawler outcome');
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
    assert.match(retry.summary, /did not complete the crawl/);
    assert.match(`${retry.result.stdout}${retry.result.stderr}`, /requires fresh-runner recovery/);

    assert.equal(success.result.status, 0, `${success.result.stdout}${success.result.stderr}`);
    assert.match(success.summary, /Outcome: `SUCCESS`/);
    assert.match(success.summary, /completed during the primary runner/);
});

function runOutcomeCollector(statuses, primaryResult = 'success') {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-result-collector-'));
    const outputPath = path.join(tempDir, 'github-output.txt');
    for (const [shard, status] of Object.entries(statuses)) {
        fs.writeFileSync(path.join(tempDir, `plate-sync-result-${shard}.json`), JSON.stringify({ shard, status }));
    }

    const step = getWorkflowStep('collect-results', 'Classify primary shard outcomes');
    const result = spawnSync('/bin/bash', ['-e'], {
        input: step.run,
        encoding: 'utf8',
        env: {
            ...process.env,
            RESULT_DIR: tempDir,
            PRIMARY_RESULT: primaryResult,
            GITHUB_OUTPUT: outputPath,
        },
    });

    return {
        result,
        outputs: fs.existsSync(outputPath) ? parseGithubOutput(outputPath) : {},
    };
}

test('collector 只把 RETRY shard 放進帶錯峰欄位的 fresh-runner matrix', () => {
    const scenario = runOutcomeCollector({
        NORTH: 'SUCCESS',
        CENTRAL: 'SUCCESS',
        SOUTH: 'SUCCESS',
        SHARD4: 'RETRY',
        SHARD5: 'SUCCESS',
    });
    const output = `${scenario.result.stdout}${scenario.result.stderr}`;

    assert.equal(scenario.result.status, 0, output);
    assert.equal(scenario.outputs.has_retries, 'true');
    assert.equal(scenario.outputs.hard_failure, 'false');
    assert.deepEqual(JSON.parse(scenario.outputs.retry_matrix), {
        include: [{
            shard: 'SHARD4',
            initial_delay_seconds: 0,
            retry_cooldown_seconds: 90,
        }],
    });
});

test('collector 為多個 recovery shard 配置互斥時間槽與共同冷卻週期', () => {
    const scenario = runOutcomeCollector({
        NORTH: 'SUCCESS',
        CENTRAL: 'RETRY',
        SOUTH: 'SUCCESS',
        SHARD4: 'SUCCESS',
        SHARD5: 'RETRY',
    });
    const output = `${scenario.result.stdout}${scenario.result.stderr}`;

    assert.equal(scenario.result.status, 0, output);
    assert.deepEqual(JSON.parse(scenario.outputs.retry_matrix), {
        include: [
            { shard: 'CENTRAL', initial_delay_seconds: 0, retry_cooldown_seconds: 180 },
            { shard: 'SHARD5', initial_delay_seconds: 90, retry_cooldown_seconds: 180 },
        ],
    });
});

test('collector 遇到缺少 artifact 時 fail-closed，不臆測該 shard 成功', () => {
    const scenario = runOutcomeCollector({
        NORTH: 'SUCCESS',
        CENTRAL: 'SUCCESS',
        SOUTH: 'SUCCESS',
        SHARD4: 'SUCCESS',
    });
    const output = `${scenario.result.stdout}${scenario.result.stderr}`;

    assert.equal(scenario.result.status, 0, output);
    assert.equal(scenario.outputs.hard_failure, 'true');
    assert.match(output, /Missing primary outcome artifact for SHARD5/);
});

test('collector 拒絕檔名與內容 shard 身分不一致的 artifact', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-result-mismatch-'));
    const outputPath = path.join(tempDir, 'github-output.txt');
    for (const shard of ['NORTH', 'CENTRAL', 'SOUTH', 'SHARD4', 'SHARD5']) {
        const artifactShard = shard === 'SHARD5' ? 'NORTH' : shard;
        fs.writeFileSync(path.join(tempDir, `plate-sync-result-${shard}.json`), JSON.stringify({ shard: artifactShard, status: 'SUCCESS' }));
    }
    const step = getWorkflowStep('collect-results', 'Classify primary shard outcomes');
    const result = spawnSync('/bin/bash', ['-e'], {
        input: step.run,
        encoding: 'utf8',
        env: { ...process.env, RESULT_DIR: tempDir, PRIMARY_RESULT: 'success', GITHUB_OUTPUT: outputPath },
    });
    const output = `${result.stdout}${result.stderr}`;
    const outputs = parseGithubOutput(outputPath);

    assert.equal(result.status, 0, output);
    assert.equal(outputs.hard_failure, 'true');
    assert.match(output, /identity mismatch: expected SHARD5, got NORTH/);
});

function runRecoveryGate(env) {
    const step = getWorkflowStep('recovery-gate', 'Enforce complete shard coverage');
    return spawnSync('/bin/bash', ['-e'], {
        input: step.run,
        encoding: 'utf8',
        env: { ...process.env, ...env },
    });
}

test('recovery gate 只有在需要補跑且 fresh-runner 成功時放行', () => {
    const passed = runRecoveryGate({
        COLLECT_RESULT: 'success',
        PRIMARY_RESULT: 'success',
        HARD_FAILURE: 'false',
        HAS_RETRIES: 'true',
        RECOVERY_RESULT: 'success',
    });
    const failed = runRecoveryGate({
        COLLECT_RESULT: 'success',
        PRIMARY_RESULT: 'success',
        HARD_FAILURE: 'false',
        HAS_RETRIES: 'true',
        RECOVERY_RESULT: 'failure',
    });

    assert.equal(passed.status, 0, `${passed.stdout}${passed.stderr}`);
    assert.equal(failed.status, 1, `${failed.stdout}${failed.stderr}`);
    assert.match(`${failed.stdout}${failed.stderr}`, /fresh-runner shard recovery failed/);
});

test('WARP 安裝有獨立上限、HTTPS Ubuntu mirror 與 bounded apt retries', () => {
    const setupStep = workflow.jobs['sync-plates'].steps.find((step) => step.name === 'Setup crawler runner');
    const cacheStep = getStep('Cache Cloudflare WARP apt packages');
    const installStep = getStep('Install and Configure Cloudflare WARP');

    assert.equal(setupStep['timeout-minutes'], 15);
    assert.match(installStep.run, /https:\/\/archive\.ubuntu\.com\/ubuntu/);
    assert.match(installStep.run, /timeout --signal=TERM --kill-after=15s 90s/);
    assert.match(installStep.run, /timeout --signal=TERM --kill-after=15s 240s/);
    assert.match(installStep.run, /Acquire::Retries=2/);
    assert.doesNotMatch(installStep.run, /sudo apt-get update &&/);
    assert.match(cacheStep.with.key, /hashFiles\('\.github\/workflows\/plate-sync\.yml'\)/);
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

test('crawler 將 MVDIS preflight 分類為暫時性 exit 75，並以 90 秒分隔五 shard', () => {
    const source = fs.readFileSync(crawlerPath, 'utf8');

    assert.match(source, /MVDIS_PREFLIGHT_EXIT_CODE\s*=\s*75/);
    assert.match(source, /preflightError\.exitCode\s*=\s*MVDIS_PREFLIGHT_EXIT_CODE/);
    assert.match(source, /'CENTRAL': 90000/);
    assert.match(source, /'SOUTH': 180000/);
    assert.match(source, /'SHARD4': 270000/);
    assert.match(source, /'SHARD5': 360000/);
    assert.match(source, /process\.env\.SKIP_SHARD_JITTER !== '1'/);
    assert.doesNotMatch(source, /Fix: set PROXY_URL secret/);
});
