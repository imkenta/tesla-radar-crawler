"use strict";

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const runnerSource = fs.readFileSync(path.join(__dirname, '../scripts/run-speed-camera-local.sh'), 'utf8');
const shellQuote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";

for (const exitCode of [0, 17]) {
  // launchd 專用 runner（macOS）：腳本用 BSD `stat -f%z`、`/usr/bin/osascript`，測試以 /bin/zsh 執行。
  // Linux CI（ubuntu runner 不保證預裝 zsh、stat 語意不同）不跑，避免間歇紅燈；本機 macOS 照跑。
  test(`local runner：離線替身退出 ${exitCode}，記錄完成時間並保留退出碼`, {
    skip: process.platform === 'darwin' ? false : 'macOS 專用（launchd runner：zsh／BSD stat／osascript）',
  }, (t) => {
    // 絕不執行正式 runner：複製到 temp，替換 repo、Node 與通知程式；僅讀假 .env。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speed-camera-runner-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const fakeNode = path.join(dir, 'fake-node');
    const fakeNotify = path.join(dir, 'fake-notify');
    fs.writeFileSync(path.join(dir, '.env'), 'VITE_SUPABASE_URL=http://invalid.test\nSUPABASE_SERVICE_ROLE_KEY=test-only\n');
    fs.writeFileSync(fakeNode, `#!/bin/sh\n[ "$1" = speed-camera-sync.cjs ] && [ "$2" = --write ] || exit 99\nprintf '%s\\n' 'offline crawler stub'\nexit ${exitCode}\n`, { mode: 0o755 });
    // 故意讓通知失敗，確保不能蓋掉爬蟲失敗碼。
    fs.writeFileSync(fakeNotify, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
    const copy = runnerSource
      .replace(/^REPO=.*$/m, () => `REPO=${shellQuote(dir)}`)
      .replace(/^NODE=.*$/m, () => `NODE=${shellQuote(fakeNode)}`)
      .replace('/usr/bin/osascript', shellQuote(fakeNotify));
    assert.ok(!copy.includes('/Users/juishuchang/Projects/Tesla/tesla-radar-crawler'));
    assert.ok(!copy.includes('/usr/bin/osascript'));
    const runner = path.join(dir, 'runner.sh');
    fs.writeFileSync(runner, copy);
    const result = spawnSync('/bin/zsh', [runner], {
      cwd: dir,
      env: { PATH: '/usr/bin:/bin', TZ: 'Asia/Taipei' },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, exitCode, result.stderr);
    const log = fs.readFileSync(path.join(dir, 'logs/speed-camera-local.log'), 'utf8');
    assert.match(log, /speed-camera-sync 開始/);
    assert.match(log, /offline crawler stub/);
    assert.match(log, /===== \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+0800 speed-camera-sync 完成 =====/);
    assert.ok(log.trimEnd().endsWith(`===== exit=${exitCode} =====`));
  });
}
