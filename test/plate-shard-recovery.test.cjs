'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const recoveryScript = path.join(__dirname, '..', 'scripts', 'run-plate-shard-with-recovery.sh');

function executable(filePath, content) {
    fs.writeFileSync(filePath, content, { mode: 0o755 });
}

function runScenario(exitCodes, options = {}) {
    const {
        mode = 'primary',
        warpExit = 0,
        initialDelaySeconds = 0,
        retryCooldownSeconds = 90,
        maxPreflightAttempts = 3,
    } = options;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-shard-recovery-'));
    const fakeBin = path.join(tempDir, 'bin');
    const resultPath = path.join(tempDir, 'result.json');
    const outputPath = path.join(tempDir, 'github-output.txt');
    const nodeCountPath = path.join(tempDir, 'node-count.txt');
    const warpLogPath = path.join(tempDir, 'warp.log');
    const sleepLogPath = path.join(tempDir, 'sleep.log');
    fs.mkdirSync(fakeBin);

    executable(path.join(fakeBin, 'node'), `#!/bin/bash
count=0
if [ -f "$FAKE_NODE_COUNT_FILE" ]; then count=$(cat "$FAKE_NODE_COUNT_FILE"); fi
count=$((count + 1))
printf '%s' "$count" > "$FAKE_NODE_COUNT_FILE"
IFS=',' read -r -a codes <<< "$FAKE_NODE_EXIT_CODES"
index=$((count - 1))
code="\${codes[$index]:-}"
if [ -z "$code" ]; then
    last_index=$((\${#codes[@]} - 1))
    code="\${codes[$last_index]}"
fi
exit "$code"
`);
    executable(path.join(fakeBin, 'sudo'), '#!/bin/bash\n"$@"\n');
    executable(path.join(fakeBin, 'warp-cli'), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$FAKE_WARP_LOG"\nexit "$FAKE_WARP_EXIT"\n');
    executable(path.join(fakeBin, 'curl'), '#!/bin/bash\nprintf "warp=on\\n"\n');
    executable(path.join(fakeBin, 'sleep'), '#!/bin/bash\nprintf "%s\\n" "$1" >> "$FAKE_SLEEP_LOG"\nexit 0\n');

    const result = spawnSync('/bin/bash', [recoveryScript, 'NORTH', mode], {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
        env: {
            ...process.env,
            PATH: `${fakeBin}:${process.env.PATH}`,
            RESULT_PATH: resultPath,
            GITHUB_OUTPUT: outputPath,
            FAKE_NODE_EXIT_CODES: exitCodes.join(','),
            FAKE_NODE_COUNT_FILE: nodeCountPath,
            FAKE_WARP_LOG: warpLogPath,
            FAKE_WARP_EXIT: String(warpExit),
            FAKE_SLEEP_LOG: sleepLogPath,
            INITIAL_DELAY_SECONDS: String(initialDelaySeconds),
            RETRY_COOLDOWN_SECONDS: String(retryCooldownSeconds),
            MAX_PREFLIGHT_ATTEMPTS: String(maxPreflightAttempts),
        },
    });

    return {
        result,
        outcome: fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : null,
        nodeCalls: fs.existsSync(nodeCountPath) ? Number(fs.readFileSync(nodeCountPath, 'utf8')) : 0,
        warpLog: fs.existsSync(warpLogPath) ? fs.readFileSync(warpLogPath, 'utf8') : '',
        sleeps: fs.existsSync(sleepLogPath)
            ? fs.readFileSync(sleepLogPath, 'utf8').trim().split('\n').filter(Boolean).map(Number)
            : [],
    };
}

test('第一次成功時不重建 WARP', () => {
    const scenario = runScenario([0]);
    const output = `${scenario.result.stdout}${scenario.result.stderr}`;

    assert.equal(scenario.result.status, 0, output);
    assert.deepEqual(scenario.outcome, { shard: 'NORTH', status: 'SUCCESS' });
    assert.equal(scenario.nodeCalls, 1);
    assert.equal(scenario.warpLog, '');
});

test('primary exit 75 會冷卻、重連 WARP，並用全新 Node／Chrome process 重試', () => {
    const scenario = runScenario([75, 0]);
    const output = `${scenario.result.stdout}${scenario.result.stderr}`;

    assert.equal(scenario.result.status, 0, output);
    assert.deepEqual(scenario.outcome, { shard: 'NORTH', status: 'SUCCESS' });
    assert.equal(scenario.nodeCalls, 2);
    assert.match(scenario.warpLog, /disconnect/);
    assert.match(scenario.warpLog, /connect/);
    assert.doesNotMatch(scenario.warpLog, /registration (delete|new)/);
    assert.deepEqual(scenario.sleeps, [90]);
});

test('同 runner 冷卻重連後仍 exit 75，交給 fresh-runner recovery matrix', () => {
    const scenario = runScenario([75, 75]);
    const output = `${scenario.result.stdout}${scenario.result.stderr}`;

    assert.equal(scenario.result.status, 0, output);
    assert.deepEqual(scenario.outcome, { shard: 'NORTH', status: 'RETRY' });
    assert.equal(scenario.nodeCalls, 2);
});

test('非 preflight 錯誤不重試，保留 HARD_FAILURE 給 fail-closed gate', () => {
    const scenario = runScenario([1]);
    const output = `${scenario.result.stdout}${scenario.result.stderr}`;

    assert.equal(scenario.result.status, 0, output);
    assert.deepEqual(scenario.outcome, { shard: 'NORTH', status: 'HARD_FAILURE' });
    assert.equal(scenario.nodeCalls, 1);
    assert.equal(scenario.warpLog, '');
});

test('fresh runner 先套用 recovery slot，並對 exit 75 做三次有界冷卻重試', () => {
    const scenario = runScenario([75, 75, 0], {
        mode: 'fresh',
        initialDelaySeconds: 90,
        retryCooldownSeconds: 180,
        maxPreflightAttempts: 3,
    });
    const output = `${scenario.result.stdout}${scenario.result.stderr}`;

    assert.equal(scenario.result.status, 0, output);
    assert.deepEqual(scenario.outcome, { shard: 'NORTH', status: 'SUCCESS' });
    assert.equal(scenario.nodeCalls, 3);
    assert.deepEqual(scenario.sleeps, [90, 180, 180]);
    const warpCommands = scenario.warpLog.trim().split('\n');
    assert.equal(warpCommands.filter((command) => command === 'disconnect').length, 2);
    assert.equal(warpCommands.filter((command) => command === 'connect').length, 2);
});

test('fresh runner 三次 exit 75 後仍失敗，不讓 recovery gate 假綠燈', () => {
    const scenario = runScenario([75, 75, 75], { mode: 'fresh' });
    const output = `${scenario.result.stdout}${scenario.result.stderr}`;

    assert.equal(scenario.result.status, 75, output);
    assert.deepEqual(scenario.outcome, { shard: 'NORTH', status: 'RETRY' });
    assert.equal(scenario.nodeCalls, 3);
});

test('fresh runner 遇到非 preflight 錯誤立即失敗且不重試', () => {
    const scenario = runScenario([1, 0], { mode: 'fresh' });
    const output = `${scenario.result.stdout}${scenario.result.stderr}`;

    assert.equal(scenario.result.status, 1, output);
    assert.deepEqual(scenario.outcome, { shard: 'NORTH', status: 'HARD_FAILURE' });
    assert.equal(scenario.nodeCalls, 1);
});
