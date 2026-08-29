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

function runScenario(exitCodes, warpExit = 0) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-shard-recovery-'));
    const fakeBin = path.join(tempDir, 'bin');
    const resultPath = path.join(tempDir, 'result.json');
    const outputPath = path.join(tempDir, 'github-output.txt');
    const nodeCountPath = path.join(tempDir, 'node-count.txt');
    const warpLogPath = path.join(tempDir, 'warp.log');
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
    executable(path.join(fakeBin, 'sleep'), '#!/bin/bash\nexit 0\n');

    const result = spawnSync('/bin/bash', [recoveryScript, 'NORTH'], {
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
        },
    });

    return {
        result,
        outcome: fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : null,
        nodeCalls: fs.existsSync(nodeCountPath) ? Number(fs.readFileSync(nodeCountPath, 'utf8')) : 0,
        warpLog: fs.existsSync(warpLogPath) ? fs.readFileSync(warpLogPath, 'utf8') : '',
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

test('exit 75 會關閉舊 session、重建 WARP，並用全新 Node／Chrome process 重試', () => {
    const scenario = runScenario([75, 0]);
    const output = `${scenario.result.stdout}${scenario.result.stderr}`;

    assert.equal(scenario.result.status, 0, output);
    assert.deepEqual(scenario.outcome, { shard: 'NORTH', status: 'SUCCESS' });
    assert.equal(scenario.nodeCalls, 2);
    assert.match(scenario.warpLog, /disconnect/);
    assert.match(scenario.warpLog, /registration delete/);
    assert.match(scenario.warpLog, /registration new/);
    assert.match(scenario.warpLog, /connect/);
});

test('同 runner 重建後仍 exit 75，交給 fresh-runner recovery matrix', () => {
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
