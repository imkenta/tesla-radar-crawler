'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'plate-sync.yml');
const workflow = yaml.load(fs.readFileSync(workflowPath, 'utf8'));
const steps = workflow.jobs['sync-plates'].steps;

function getStep(name) {
    const step = steps.find((candidate) => candidate.name === name);
    assert.ok(step, `找不到 workflow step: ${name}`);
    return step;
}

test('WARP 安裝有獨立上限、HTTPS Ubuntu mirror 與 bounded apt retries', () => {
    const cacheStep = getStep('Cache Cloudflare WARP apt packages');
    const installStep = getStep('Install and Configure Cloudflare WARP');

    assert.equal(installStep['timeout-minutes'], 10);
    assert.match(installStep.run, /https:\/\/archive\.ubuntu\.com\/ubuntu/);
    assert.match(installStep.run, /timeout --signal=TERM --kill-after=15s 90s/);
    assert.match(installStep.run, /timeout --signal=TERM --kill-after=15s 240s/);
    assert.match(installStep.run, /Acquire::Retries=2/);
    assert.doesNotMatch(installStep.run, /sudo apt-get update &&/);
    assert.match(cacheStep.with.key, /hashFiles\('\.github\/workflows\/plate-sync\.yml'\)/);
});

function runGeminiPreflightScenario(scenario) {
    const preflightStep = getStep('Verify Gemini API Direct Egress');
    const stepScript = preflightStep.run.replaceAll('${{ matrix.shard }}', 'NORTH');
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
