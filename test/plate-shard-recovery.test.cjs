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

function withoutKeys(obj, keys) {
    const copy = { ...obj };
    for (const key of keys) delete copy[key];
    return copy;
}

function runScenario(exitCodes, options = {}) {
    const {
        mode = 'primary',
        warpExit = 0,
        initialDelaySeconds = 0,
        retryCooldownSeconds = 15,
        maxPreflightAttempts = 2,
        deadlineEpoch = 0,
        ghArtifactId = '',
        ghPrimaryConclusion = '',
        primaryResultJson = '',
        warmTicketMaxTries = 1,
        spareStartEpoch = 0,
        completedJson = '',
        primaryHandoffReserveSeconds = 0,
        omitCompletedEnv = false,
    } = options;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-shard-recovery-'));
    const fakeBin = path.join(tempDir, 'bin');
    const resultPath = path.join(tempDir, 'result.json');
    const outputPath = path.join(tempDir, 'github-output.txt');
    const nodeCountPath = path.join(tempDir, 'node-count.txt');
    const warpLogPath = path.join(tempDir, 'warp.log');
    const sleepLogPath = path.join(tempDir, 'sleep.log');
    const completedStationsPath = path.join(tempDir, 'completed-stations.json');
    const nodeEnvLogPath = path.join(tempDir, 'node-env.log');
    fs.mkdirSync(fakeBin);

    executable(path.join(fakeBin, 'node'), `#!/bin/bash
echo "\${COMPLETED_STATIONS_FILE:-<unset>}" >> "$FAKE_NODE_ENV_LOG"
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
    // spare 模式用：假 gh 依 API 路徑回覆 artifact id / primary conclusion / zip 位元組
    executable(path.join(fakeBin, 'gh'), `#!/bin/bash
args="$*"
if [[ "$args" == *"/zip"* ]]; then printf 'FAKEZIP'; exit 0; fi
if [[ "$args" == *"/artifacts"* ]]; then printf '%s' "$FAKE_GH_ARTIFACT_ID"; exit 0; fi
if [[ "$args" == *"/jobs"* ]]; then printf '%s' "$FAKE_GH_PRIMARY_CONCLUSION"; exit 0; fi
exit 1
`);
    // unzip -p <zip> <member>：依成員檔名回應，才測得到「result 與進度檔分別取出」
    executable(path.join(fakeBin, 'unzip'), `#!/bin/bash
member="$3"
case "$member" in
  *result*) printf '%s' "$FAKE_PRIMARY_RESULT_JSON" ;;
  *completed*) [ -n "$FAKE_COMPLETED_JSON" ] || exit 1; printf '%s' "$FAKE_COMPLETED_JSON" ;;
  *) exit 1 ;;
esac
`);

    const result = spawnSync('/bin/bash', [recoveryScript, 'NORTH', mode], {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
        env: withoutKeys({
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
            DEADLINE_EPOCH: String(deadlineEpoch),
            RUNNER_TEMP: tempDir,
            GITHUB_REPOSITORY: 'imkenta/tesla-radar-crawler',
            GITHUB_RUN_ID: '99999',
            WARM_TICKET_MAX_TRIES: String(warmTicketMaxTries),
            SPARE_POLL_INTERVAL_SECONDS: '1',
            SPARE_MAX_WAIT_SECONDS: '3',
            FAKE_GH_ARTIFACT_ID: String(ghArtifactId),
            FAKE_GH_PRIMARY_CONCLUSION: String(ghPrimaryConclusion),
            FAKE_PRIMARY_RESULT_JSON: String(primaryResultJson),
            SPARE_START_EPOCH: String(spareStartEpoch),
            LANE_BUDGET_SECONDS: '1140',
            FAKE_COMPLETED_JSON: String(completedJson),
            COMPLETED_STATIONS_FILE: completedStationsPath,
            PRIMARY_HANDOFF_RESERVE_SECONDS: String(primaryHandoffReserveSeconds),
            FAKE_NODE_ENV_LOG: nodeEnvLogPath,
        }, omitCompletedEnv ? ['COMPLETED_STATIONS_FILE'] : []),
    });

    return {
        result,
        outcome: fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : null,
        nodeCalls: fs.existsSync(nodeCountPath) ? Number(fs.readFileSync(nodeCountPath, 'utf8')) : 0,
        warpLog: fs.existsSync(warpLogPath) ? fs.readFileSync(warpLogPath, 'utf8') : '',
        completedStations: fs.existsSync(completedStationsPath)
            ? fs.readFileSync(completedStationsPath, 'utf8')
            : null,
        nodeEnvSeen: fs.existsSync(nodeEnvLogPath)
            ? fs.readFileSync(nodeEnvLogPath, 'utf8').trim().split('\n').filter(Boolean)
            : [],
        sleeps: fs.existsSync(sleepLogPath)
            ? fs.readFileSync(sleepLogPath, 'utf8').trim().split('\n').filter(Boolean).map(Number)
            : [],
    };
}

test('第一次成功時不重建 WARP', () => {
    const scenario = runScenario([0]);
    const output = `${scenario.result.stdout}${scenario.result.stderr}`;

    assert.equal(scenario.result.status, 0, output);
    assert.equal(scenario.outcome && scenario.outcome.shard, 'NORTH');
    assert.equal(scenario.outcome && scenario.outcome.status, 'SUCCESS');
    assert.equal(scenario.nodeCalls, 1);
    assert.equal(scenario.warpLog, '');
});

test('primary exit 75 且無 deadline 資訊 → 立即交給 fresh runner，不原地重抽', () => {
    const scenario = runScenario([75, 0]);
    const output = `${scenario.result.stdout}${scenario.result.stderr}`;

    assert.equal(scenario.result.status, 0, output);
    assert.equal(scenario.outcome && scenario.outcome.shard, 'NORTH');
    assert.equal(scenario.outcome && scenario.outcome.status, 'RETRY');
    assert.equal(scenario.nodeCalls, 1);
    assert.equal(scenario.warpLog, '');
    assert.deepEqual(scenario.sleeps, []);
});

test('primary exit 75 且預算充足 → 原地重抽 WARP 身分後再試一次，成功則 SUCCESS', () => {
    const deadlineEpoch = Math.floor(Date.now() / 1000) + 1000; // 剩 1000s ≥ 720s 門檻
    const scenario = runScenario([75, 0], { deadlineEpoch });
    const output = `${scenario.result.stdout}${scenario.result.stderr}`;

    assert.equal(scenario.result.status, 0, output);
    assert.equal(scenario.outcome && scenario.outcome.shard, 'NORTH');
    assert.equal(scenario.outcome && scenario.outcome.status, 'SUCCESS');
    assert.equal(scenario.nodeCalls, 2);
    const warpCommands = scenario.warpLog.trim().split('\n');
    assert.equal(warpCommands.filter((c) => c === 'registration delete').length, 1);
    assert.equal(warpCommands.filter((c) => c === 'registration new').length, 1);
    assert.equal(warpCommands.filter((c) => c.startsWith('tunnel host add')).length, 2);
});

test('primary exit 75 且預算充足但重抽後 preflight 仍失敗 → 交出 RETRY', () => {
    const deadlineEpoch = Math.floor(Date.now() / 1000) + 1000;
    const scenario = runScenario([75, 75], { deadlineEpoch });
    const output = `${scenario.result.stdout}${scenario.result.stderr}`;

    assert.equal(scenario.result.status, 0, output);
    assert.equal(scenario.outcome && scenario.outcome.shard, 'NORTH');
    assert.equal(scenario.outcome && scenario.outcome.status, 'RETRY');
    assert.equal(scenario.nodeCalls, 2);
});

test('primary exit 75 但預算不足 720s → 不重抽、立即交棒（守住 recovery gate 480s 門檻）', () => {
    const deadlineEpoch = Math.floor(Date.now() / 1000) + 700; // 剩 ~700s < 720s
    const scenario = runScenario([75, 0], { deadlineEpoch });
    const output = `${scenario.result.stdout}${scenario.result.stderr}`;

    assert.equal(scenario.result.status, 0, output);
    assert.equal(scenario.outcome && scenario.outcome.shard, 'NORTH');
    assert.equal(scenario.outcome && scenario.outcome.status, 'RETRY');
    assert.equal(scenario.nodeCalls, 1);
    assert.equal(scenario.warpLog, '');
});

test('primary 重抽失敗（WARP 註冊拿不到）→ 不再試第二次 crawl，直接交棒', () => {
    const deadlineEpoch = Math.floor(Date.now() / 1000) + 1000;
    const scenario = runScenario([75, 0], { deadlineEpoch, warpExit: 1 });
    const output = `${scenario.result.stdout}${scenario.result.stderr}`;

    assert.equal(scenario.result.status, 0, output);
    assert.equal(scenario.outcome && scenario.outcome.shard, 'NORTH');
    assert.equal(scenario.outcome && scenario.outcome.status, 'RETRY');
    assert.equal(scenario.nodeCalls, 1);
});

test('非 preflight 錯誤不重試，保留 HARD_FAILURE 給 fail-closed gate', () => {
    const scenario = runScenario([1]);
    const output = `${scenario.result.stdout}${scenario.result.stderr}`;

    assert.equal(scenario.result.status, 0, output);
    assert.equal(scenario.outcome && scenario.outcome.shard, 'NORTH');
    assert.equal(scenario.outcome && scenario.outcome.status, 'HARD_FAILURE');
    assert.equal(scenario.nodeCalls, 1);
    assert.equal(scenario.warpLog, '');
});

test('primary 在 lane deadline 耗盡後不再啟動 crawler，並 fail-closed 交出 RETRY', () => {
    const scenario = runScenario([0], { deadlineEpoch: 1 });
    const output = `${scenario.result.stdout}${scenario.result.stderr}`;

    assert.equal(scenario.result.status, 0, output);
    assert.equal(scenario.outcome && scenario.outcome.shard, 'NORTH');
    assert.equal(scenario.outcome && scenario.outcome.status, 'RETRY');
    assert.equal(scenario.nodeCalls, 0);
    assert.match(output, /exhausted its end-to-end lane budget/);
});

test('fresh runner 短冷卻嘗試之間重抽 WARP 身分（重註冊，非單純重連）', () => {
    const scenario = runScenario([75, 0], {
        mode: 'fresh',
        initialDelaySeconds: 20,
        retryCooldownSeconds: 15,
        maxPreflightAttempts: 2,
    });
    const output = `${scenario.result.stdout}${scenario.result.stderr}`;

    assert.equal(scenario.result.status, 0, output);
    assert.equal(scenario.outcome && scenario.outcome.shard, 'NORTH');
    assert.equal(scenario.outcome && scenario.outcome.status, 'SUCCESS');
    assert.equal(scenario.nodeCalls, 2);
    assert.deepEqual(scenario.sleeps, [20, 15]);
    const warpCommands = scenario.warpLog.trim().split('\n');
    assert.equal(warpCommands.filter((command) => command === 'disconnect').length, 1);
    assert.equal(warpCommands.filter((command) => command === 'connect').length, 1);
    assert.equal(warpCommands.filter((command) => command === 'registration delete').length, 1);
    assert.equal(warpCommands.filter((command) => command === 'registration new').length, 1);
});

test('fresh runner 兩次 exit 75 後仍失敗，不讓 recovery gate 假綠燈', () => {
    const scenario = runScenario([75, 75], { mode: 'fresh' });
    const output = `${scenario.result.stdout}${scenario.result.stderr}`;

    assert.equal(scenario.result.status, 75, output);
    assert.equal(scenario.outcome && scenario.outcome.shard, 'NORTH');
    assert.equal(scenario.outcome && scenario.outcome.status, 'RETRY');
    assert.equal(scenario.nodeCalls, 2);
});

test('fresh runner 遇到非 preflight 錯誤立即失敗且不重試', () => {
    const scenario = runScenario([1, 0], { mode: 'fresh' });
    const output = `${scenario.result.stdout}${scenario.result.stderr}`;

    assert.equal(scenario.result.status, 1, output);
    assert.equal(scenario.outcome && scenario.outcome.shard, 'NORTH');
    assert.equal(scenario.outcome && scenario.outcome.status, 'HARD_FAILURE');
    assert.equal(scenario.nodeCalls, 1);
});

// --- 熱備援（spare）模式（2026-09-01）---

function spareResult(status, deadlineOffsetSeconds) {
    const deadline = Math.floor(Date.now() / 1000) + deadlineOffsetSeconds;
    return `{"shard":"NORTH","status":"${status}","deadline_epoch":${deadline}}`;
}

test('spare：primary RETRY → 接棒開爬並成功（暖身 1 探測＋接棒 1 爬行）', () => {
    const scenario = runScenario([0, 0], {
        mode: 'spare',
        ghArtifactId: '123',
        primaryResultJson: spareResult('RETRY', 600),
    });
    const output = `${scenario.result.stdout}${scenario.result.stderr}`;

    assert.equal(scenario.result.status, 0, output);
    assert.equal(scenario.outcome && scenario.outcome.status, 'SUCCESS');
    assert.equal(scenario.nodeCalls, 2); // 暖身 preflight-only + 接棒 crawl
    assert.match(output, /taking over shard NORTH/);
});

test('spare：primary SUCCESS → 收工不爬（SPARE_IDLE）', () => {
    const scenario = runScenario([0], {
        mode: 'spare',
        ghArtifactId: '123',
        primaryResultJson: spareResult('SUCCESS', 600),
    });
    const output = `${scenario.result.stdout}${scenario.result.stderr}`;

    assert.equal(scenario.result.status, 0, output);
    assert.equal(scenario.outcome && scenario.outcome.status, 'SPARE_IDLE');
    assert.equal(scenario.nodeCalls, 1); // 只有暖身探測
});

test('spare：primary HARD_FAILURE → 收工不爬、不遮蔽 fail-closed', () => {
    const scenario = runScenario([0], {
        mode: 'spare',
        ghArtifactId: '123',
        primaryResultJson: spareResult('HARD_FAILURE', 600),
    });
    const output = `${scenario.result.stdout}${scenario.result.stderr}`;

    assert.equal(scenario.result.status, 0, output);
    assert.equal(scenario.outcome && scenario.outcome.status, 'SPARE_IDLE');
    assert.equal(scenario.nodeCalls, 1);
});

test('spare：primary 結束但沒有 artifact → 收工（lane-gate 會處理 primary 失敗）', () => {
    const scenario = runScenario([0], {
        mode: 'spare',
        ghArtifactId: '',
        ghPrimaryConclusion: 'failure',
    });
    const output = `${scenario.result.stdout}${scenario.result.stderr}`;

    assert.equal(scenario.result.status, 0, output);
    assert.equal(scenario.outcome && scenario.outcome.status, 'SPARE_IDLE');
    assert.match(output, /without publishing a result artifact/);
});

test('spare：接棒時剩餘預算 <240s → 拒絕無望的爬行、交出 RETRY', () => {
    const scenario = runScenario([0], {
        mode: 'spare',
        ghArtifactId: '123',
        primaryResultJson: spareResult('RETRY', 100),
    });
    const output = `${scenario.result.stdout}${scenario.result.stderr}`;

    assert.equal(scenario.result.status, 75, output);
    assert.equal(scenario.outcome && scenario.outcome.status, 'RETRY');
    assert.equal(scenario.nodeCalls, 1); // 只有暖身，沒有接棒爬行
});

test('spare：暖身探測失敗會重抽再驗，直到拿到好票', () => {
    const scenario = runScenario([75, 0, 0], {
        mode: 'spare',
        ghArtifactId: '123',
        primaryResultJson: spareResult('RETRY', 600),
        warmTicketMaxTries: 3,
    });
    const output = `${scenario.result.stdout}${scenario.result.stderr}`;

    assert.equal(scenario.result.status, 0, output);
    assert.equal(scenario.outcome && scenario.outcome.status, 'SUCCESS');
    assert.equal(scenario.nodeCalls, 3); // 暖身×2（敗+成）＋接棒 crawl
    const warpCommands = scenario.warpLog.trim().split('\n');
    assert.equal(warpCommands.filter((c) => c === 'registration new').length, 1);
});

test('spare：primary 失敗且無 artifact（開爬前死於 setup）→ 以自身起跑時間推算預算、整個接手', () => {
    const scenario = runScenario([0, 0], {
        mode: 'spare',
        ghArtifactId: '',
        ghPrimaryConclusion: 'failure',
        spareStartEpoch: Math.floor(Date.now() / 1000) - 300, // 已跑 5 分鐘，仍餘 840s
    });
    const output = `${scenario.result.stdout}${scenario.result.stderr}`;

    assert.equal(scenario.result.status, 0, output);
    assert.equal(scenario.outcome && scenario.outcome.status, 'SUCCESS');
    assert.equal(scenario.nodeCalls, 2); // 暖身 + 接手 crawl
    assert.match(output, /Primary died before crawling/);
});

test('spare：primary 失敗且無 artifact 但預算已耗盡 → 拒絕接手、交出 RETRY（fail-closed）', () => {
    const scenario = runScenario([0], {
        mode: 'spare',
        ghArtifactId: '',
        ghPrimaryConclusion: 'cancelled',
        spareStartEpoch: Math.floor(Date.now() / 1000) - 2000, // 早已超過 1140s
    });
    const output = `${scenario.result.stdout}${scenario.result.stderr}`;

    assert.equal(scenario.result.status, 75, output);
    assert.equal(scenario.outcome && scenario.outcome.status, 'RETRY');
    assert.equal(scenario.nodeCalls, 1); // 只有暖身，沒有接手爬行
});

test('spare：primary 成功但無 artifact（異常）→ 仍收工，不擅自重爬', () => {
    const scenario = runScenario([0], {
        mode: 'spare',
        ghArtifactId: '',
        ghPrimaryConclusion: 'success',
        spareStartEpoch: Math.floor(Date.now() / 1000) - 300,
    });
    assert.equal(scenario.result.status, 0);
    assert.equal(scenario.outcome && scenario.outcome.status, 'SPARE_IDLE');
    assert.equal(scenario.nodeCalls, 1);
});

// --- 交棒窗保留與進度傳承（2026-09-10）---

test('primary 保留交棒窗：爬行 deadline = lane deadline 減保留秒數，不再獨佔整個預算', () => {
    const scenario = runScenario([0], {
        deadlineEpoch: Math.floor(Date.now() / 1000) + 1000,
        primaryHandoffReserveSeconds: 330,
    });
    const output = `${scenario.result.stdout}${scenario.result.stderr}`;

    assert.equal(scenario.result.status, 0, output);
    assert.match(output, /reserves the last 330s of the lane budget/);
    // 實際交給 crawler 的剩餘時間應為 ~670s（1000-330），而非 ~1000s
    const remaining = Number(output.match(/has (\d+)s remaining in its end-to-end lane budget/)[1]);
    assert.ok(remaining > 640 && remaining <= 670, `expected ~670s, got ${remaining}`);
});

test('primary 保留窗設為 0 時行為不變（沿用整個 lane 預算）', () => {
    const scenario = runScenario([0], {
        deadlineEpoch: Math.floor(Date.now() / 1000) + 1000,
        primaryHandoffReserveSeconds: 0,
    });
    const output = `${scenario.result.stdout}${scenario.result.stderr}`;
    const remaining = Number(output.match(/has (\d+)s remaining in its end-to-end lane budget/)[1]);
    assert.ok(remaining > 970, `expected ~1000s, got ${remaining}`);
    assert.doesNotMatch(output, /reserves the last/);
});

test('spare 接手時繼承 primary 的完成站清單（續爬而非從第一站重來）', () => {
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const scenario = runScenario([0, 0], {
        mode: 'spare',
        ghArtifactId: '123',
        primaryResultJson: `{"shard":"NORTH","status":"RETRY","deadline_epoch":${deadline}}`,
        completedJson: '["20","21","25"]',
    });
    const output = `${scenario.result.stdout}${scenario.result.stderr}`;

    assert.equal(scenario.result.status, 0, output);
    assert.equal(scenario.outcome && scenario.outcome.status, 'SUCCESS');
    assert.match(output, /inherited primary progress for NORTH/);
    assert.equal(scenario.completedStations, '["20","21","25"]');
});

test('spare：artifact 內沒有進度檔時不建立空的續爬記錄（整個 shard 重爬）', () => {
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const scenario = runScenario([0, 0], {
        mode: 'spare',
        ghArtifactId: '123',
        primaryResultJson: `{"shard":"NORTH","status":"RETRY","deadline_epoch":${deadline}}`,
        completedJson: '',
    });
    const output = `${scenario.result.stdout}${scenario.result.stderr}`;

    assert.equal(scenario.result.status, 0, output);
    assert.doesNotMatch(output, /inherited primary progress/);
    assert.equal(scenario.completedStations, null, '不得留下空的 .inherited 或空檔');
});

// --- 回歸：CI 情境（env 未帶 COMPLETED_STATIONS_FILE）子程序必須收到路徑（2026-09-10）---
// 舊版對 readonly 變數做前綴賦值，CI 裡子程序收不到值，續爬從 8/31 起全死；
// 舊測試全都在 env 帶了該變數，剛好把 bug 遮住。

test('CI 情境：primary 啟動的 crawler 收到預設進度檔路徑，且無 readonly 錯誤', () => {
    const scenario = runScenario([0], {
        deadlineEpoch: Math.floor(Date.now() / 1000) + 1000,
        omitCompletedEnv: true,
    });
    const output = `${scenario.result.stdout}${scenario.result.stderr}`;

    assert.equal(scenario.result.status, 0, output);
    assert.doesNotMatch(output, /readonly variable|唯讀/);
    assert.equal(scenario.nodeEnvSeen.length, 1);
    assert.match(scenario.nodeEnvSeen[0], /plate-completed-stations-NORTH\.json$/);
});

test('CI 情境：spare 的暖身探測與接手爬行都收到同一份進度檔路徑', () => {
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const scenario = runScenario([0, 0], {
        mode: 'spare',
        ghArtifactId: '123',
        primaryResultJson: `{"shard":"NORTH","status":"RETRY","deadline_epoch":${deadline}}`,
        omitCompletedEnv: true,
    });
    const output = `${scenario.result.stdout}${scenario.result.stderr}`;

    assert.equal(scenario.result.status, 0, output);
    assert.doesNotMatch(output, /readonly variable|唯讀/);
    assert.equal(scenario.nodeEnvSeen.length, 2);
    for (const seen of scenario.nodeEnvSeen) {
        assert.match(seen, /plate-completed-stations-NORTH\.json$/);
    }
});
