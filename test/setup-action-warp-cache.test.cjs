'use strict';

// 2026-11-16（WARP 審查 M1b）：車牌同步的 setup action 原本把還原的快取 .deb 整批複製進 apt archives，
// 並用本地路徑安裝 cloudflare-warp（apt 對本地檔不驗雜湊）。這個 job 握有 Gemini／Supabase 金鑰，
// 而 main 上任何 job 都寫得進同一份快取。改成：只還原 → 更新 Cloudflare 索引 → 逐檔比對 SHA256 才採用 →
// 按名稱安裝 → 只把這一輪 archives 內的檔另存。
// 要守住的不變量：沒通過比對的快取檔，沒有任何路徑會進 apt archives 或被安裝、也不會被存回快取。

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('js-yaml');

const root = path.join(__dirname, '..');
const action = yaml.load(fs.readFileSync(path.join(root, '.github', 'actions', 'setup-plate-runner', 'action.yml'), 'utf8'));
const steps = action.runs.steps;
const step = (name) => steps.find((s) => s.name === name);
const installStep = step('Install and Configure Cloudflare WARP');
const restoreStep = step('Restore cached Cloudflare WARP apt packages');
const saveStep = step('Save verified Cloudflare WARP apt packages');

const ADOPT_RE = /^adopt_verified_cached_debs\(\) \{[\s\S]*?^\}$/m;
const fnMatch = installStep.run.match(/^install_warp_verified\(\) \{[\s\S]*?^\}$/m);
const adoptMatch = installStep.run.match(ADOPT_RE);
assert.ok(fnMatch, '找不到 install_warp_verified');
assert.ok(adoptMatch, '找不到 adopt_verified_cached_debs');
const FN = `${adoptMatch[0]}\n${fnMatch[0]}`;
const { sync, libFunctions, TARGETS } = require('../scripts/sync-warp-lib.cjs');
const sha = (alg, text) => crypto.createHash(alg).update(text).digest('hex');
const record = (pkg, content) => `Package: ${pkg}\nMD5sum: ${sha('md5', content)}\nSHA256: ${sha('sha256', content)}\nDescription: z\n`;
const uri = (name, content) => `'http://x/${name}' ${name} 1 MD5Sum:${sha('md5', content)}`;

// 在假 sudo／timeout／apt-get／apt-cache 下執行 install_warp_verified。
//   cacheFiles：還原進來的快取檔（檔名→內容）；index：apt 索引預期的檔（檔名→正版內容）
//   cfUpdateFailures：Cloudflare-only update 前 N 次失敗；installFailures：install 前 N 次失敗（不下載）
//   假 apt-get install 成功時，會把 index 內、archives 還沒有的檔以正版內容「下載」進 archives（模擬 apt 自行下載）
function run({ cacheFiles = {}, index = {}, cfUpdateFailures = 0, fullUpdateFailures = 0, installFailures = 0, matchedKey = '', junk = false, dirNamed = '', aptCacheBroken = false } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-warp-'));
    try {
        const bin = path.join(dir, 'bin');
        const home = path.join(dir, 'home');
        const archives = path.join(dir, 'archives');
        const idx = path.join(dir, 'index');
        const cacheDir = path.join(home, '.warp-apt-cache');
        for (const d of [bin, archives, idx, cacheDir]) fs.mkdirSync(d, { recursive: true });
        const log = path.join(dir, 'calls.log');
        fs.writeFileSync(log, '');
        for (const [name, content] of Object.entries(cacheFiles)) fs.writeFileSync(path.join(cacheDir, name), content);
        for (const [name, content] of Object.entries(index)) fs.writeFileSync(path.join(idx, name), content);
        if (junk) {
            fs.writeFileSync(path.join(cacheDir, '.x.deb'), 'J');
            fs.writeFileSync(path.join(cacheDir, 'notes.txt'), 'J');
            fs.mkdirSync(path.join(cacheDir, 'z.deb'));
            fs.writeFileSync(path.join(cacheDir, 'z.deb', 'inner.deb'), 'J');
            fs.symlinkSync('/etc/hosts', path.join(cacheDir, 'lnk.deb'));
        }
        if (dirNamed) fs.mkdirSync(path.join(cacheDir, dirNamed));
        const pkgOf = (name) => name.split('_')[0];
        fs.writeFileSync(path.join(dir, 'uris.txt'), Object.entries(index).map(([n, c]) => uri(n, c)).join('\n') + '\n');
        fs.writeFileSync(path.join(dir, 'apt-cache.txt'), aptCacheBroken ? '' : Object.entries(index).map(([n, c]) => record(pkgOf(n), c)).join('\n'));
        const write = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
        write('sudo', 'exec "$@"');
        write('timeout', `echo "timeout $3" >> "${log}"; shift 3; exec "$@"`);
        write('sleep', 'exit 0');
        write('env', 'while [[ "$1" == *=* ]]; do shift; done; exec "$@"');
        write('apt-cache', `echo "apt-cache $*" >> "${log}"; cat "${dir}/apt-cache.txt"`);
        // macOS 沒有 sha256sum：用 node 算；無參數時讀 stdin
        fs.writeFileSync(path.join(bin, 'sha256sum'), `#!/usr/bin/env node\nconst c=require('crypto'),fs=require('fs');const f=process.argv[2];console.log(c.createHash('sha256').update(fs.readFileSync(f||0)).digest('hex')+'  '+(f||'-'));\n`, { mode: 0o755 });
        write('apt-get', `
echo "apt-get $*" >> "${log}"
case " $* " in
  *" --print-uris "*) cat "${dir}/uris.txt"; exit 0 ;;
  *" update "*)
    if [[ " $* " == *"Dir::Etc::sourcelist"* ]]; then
      n=$(grep -c '^apt-get .*Dir::Etc::sourcelist.* update$' "${log}" || true)
      if [ "$n" -le ${cfUpdateFailures} ]; then exit 124; fi
    else
      n=$(grep '^apt-get .* update$' "${log}" | grep -vc 'Dir::Etc::sourcelist' || true)
      if [ "$n" -le ${fullUpdateFailures} ]; then exit 124; fi
    fi ;;
  *" install -y cloudflare-warp "*)
    n=$(grep -c '^apt-get .* install -y cloudflare-warp$' "${log}" || true)
    if [ "$n" -le ${installFailures} ]; then exit 100; fi
    for f in "${idx}"/*; do
      [ -e "$f" ] || continue
      b=$(basename "$f")
      if [ -e "${archives}/$b" ]; then echo "installed-from-archives $b" >> "${log}"; else cp "$f" "${archives}/$b"; echo "downloaded $b" >> "${log}"; fi
    done ;;
  *" install "*) echo "UNEXPECTED-INSTALL $*" >> "${log}"; exit 1 ;;
esac
exit 0`);
        const result = spawnSync('/bin/bash', ['-eo', 'pipefail'], {
            input: `${FN}\nif install_warp_verified; then echo "RESULT=OK key=$WARP_CACHE_KEY"; else echo RESULT=FAILED; fi`,
            encoding: 'utf8',
            env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, WARP_APT_ARCHIVES: archives, RUNNER_OS: 'Linux', ImageVersion: '20261111.196.1', GITHUB_RUN_ID: '777', GITHUB_RUN_ATTEMPT: '2', RUNNER_TEMP: dir, WARP_CACHE_MATCHED_KEY: matchedKey },
        });
        const read = (d) => Object.fromEntries(fs.readdirSync(d).sort().map((n) => [n, fs.readFileSync(path.join(d, n), 'utf8')]));
        return { ...result, calls: fs.readFileSync(log, 'utf8'), archives: read(archives), cacheAfter: read(cacheDir) };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
const count = (text, re) => (text.match(re) || []).length;
const INDEX = { 'cloudflare-warp_2026.8.2115.0_amd64.deb': 'WARP-NEW', 'libdep_1%3a2.0-1_amd64v3.deb': 'DEP' };

test('結構：只還原快取、安裝後另存；action 釘 commit SHA；沒有本地路徑安裝與整批複製', () => {
    assert.match(restoreStep.uses, /^actions\/cache\/restore@[0-9a-f]{40}$/);
    assert.match(saveStep.uses, /^actions\/cache\/save@[0-9a-f]{40}$/);
    steps.filter((s) => s.uses).forEach((s) => assert.match(s.uses, /@[0-9a-f]{40}$/, `${s.uses} 要釘 commit SHA`));
    // 帶金鑰的 job 不得再用「還原＋job 結束原樣存回」的整合版 actions/cache 處理 warp-apt 快取
    assert.ok(!steps.some((s) => /^actions\/cache@/.test(s.uses || '') && /warp-apt/.test(s.with.key)));
    assert.equal(restoreStep.with.path, '~/.warp-apt-cache');
    assert.equal(saveStep.with.path, '~/.warp-apt-cache');
    // 主鍵每輪唯一（不會命中）；restore-keys 先同映像版本、再任何版本
    assert.match(restoreStep.with.key, /lookup-\$\{\{ github\.run_id \}\}/);
    assert.deepEqual(restoreStep.with['restore-keys'].trim().split('\n').map((l) => l.trim()), [
        'warp-apt-${{ runner.os }}-${{ steps.runner-image.outputs.version }}-',
        'warp-apt-${{ runner.os }}-',
    ]);
    // 另存：鍵由安裝步驟算出（空字串＝不存，判斷邏輯見下方行為測試）；存檔失敗不擋
    assert.equal(saveStep.with.key, '${{ steps.install-warp.outputs.cache-key }}');
    assert.equal(saveStep.if, "steps.install-warp.outputs.cache-key != ''");
    assert.equal(installStep.env.WARP_CACHE_MATCHED_KEY, '${{ steps.cache-warp-apt.outputs.cache-matched-key }}');
    assert.equal(saveStep['continue-on-error'], true);
    assert.equal(installStep.id, 'install-warp');
    assert.equal(restoreStep.id, 'cache-warp-apt');
    const order = steps.map((s) => s.name);
    assert.ok(order.indexOf(restoreStep.name) < order.indexOf(installStep.name));
    assert.equal(order.indexOf(saveStep.name), order.indexOf(installStep.name) + 1);
    assert.match(installStep.run, /if ! install_warp_verified; then exit 1; fi\necho "cache-key=\$WARP_CACHE_KEY" >> "\$GITHUB_OUTPUT"/);

    const code = installStep.run.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    assert.doesNotMatch(code, /cp "\$HOME\/\.warp-apt-cache\/"/, '不得整批複製快取檔');
    assert.doesNotMatch(code, /WARP_DEB/, '不得用本地路徑安裝快取裡的 .deb');
    const installs = code.match(/install -y[^\n]*/g);
    assert.deepEqual(installs.map((l) => l.replace(/ 2>\/dev\/null.*$/, '')), ['install -y --print-uris cloudflare-warp', 'install -y cloudflare-warp'], 'install 只能按套件名稱');
    // 快取檔進 archives 的唯一入口是 adopt 內那一行逐檔 cp
    assert.equal(count(code, /cp [^\n]*"\$ARCHIVES\/"/g), 1);
    assert.equal(count(code, /\$CACHE_DIR[^\n]*\$ARCHIVES|\$ARCHIVES[^\n]*\$CACHE_DIR/g), 1, 'adopt 的逐檔 cp 是唯一一行');
    // 存回：整個重建快取目錄，只複製 archives 內的一般檔（非 symlink）
    assert.match(code, /rm -rf -- "\$HOME\/\.warp-apt-cache"\n\s*mkdir -p "\$CACHE_DIR"/);
    assert.match(code, /if \[ -f "\$DEB" \] && \[ ! -L "\$DEB" \]; then sudo cp "\$DEB" "\$CACHE_DIR\/"/);
});

test('M6：三支 YAML 內的安裝函式都由 warp-apt-lib.sh 產生且逐字同步；不在 runner 上載入外部檔', () => {
    assert.deepEqual(sync({ write: false }), [], '有 YAML 與 lib 不同步：請跑 npm run sync:warp-lib');
    const fns = libFunctions();
    assert.deepEqual(Object.keys(fns).sort(), ['adopt_verified_cached_debs', 'install_warp_bounded', 'install_warp_verified']);
    const runOf = (file) => {
        const doc = yaml.load(fs.readFileSync(path.join(root, file), 'utf8'));
        const all = doc.runs ? doc.runs.steps : Object.values(doc.jobs)[0].steps;
        return all.find((s) => s.name === 'Install and Configure Cloudflare WARP').run;
    };
    for (const [file, names] of Object.entries(TARGETS)) {
        const run = runOf(file);
        for (const name of names) {
            // 區段外不得另有同名定義；區段內容＝lib 的函式本文
            assert.equal(count(run, new RegExp(`^\\s*${name}\\(\\) \\{`, 'gm')), 1, `${file} 的 ${name} 只能有一份`);
            assert.ok(run.includes(fns[name]), `${file} 的 ${name} 與 lib 不同`);
        }
        // 驗證邏輯必須是 inline：還原快取可寫到工作區任何位置（M1c），不得 source／執行 repo 內的 .sh
        assert.doesNotMatch(run, /(^|[;&|]\s*|\s)(source|\.)\s+\S*\.sh|warp-apt-lib\.sh"?\s*$/m, `${file} 不得載入外部腳本`);
    }
    // adopt 依賴呼叫端的 APT_OPTS 與 ARCHIVES
    for (const name of ['install_warp_bounded', 'install_warp_verified']) {
        assert.match(fns[name], /local APT_OPTS=\(/);
        assert.match(fns[name], /local ARCHIVES="\$\{WARP_APT_ARCHIVES:-\/var\/cache\/apt\/archives\}"/);
    }
});

test('M6：快取的生產端與消費端約定——path 字串相同、另存的鍵落在消費端 restore-keys 的前綴內', () => {
    const consumers = [['bidding-plates-sync.yml', 'sync-bidding-plates'], ['bid-announce-sync.yml', 'sync-announcements']].map(([file, job]) => {
        const wf = yaml.load(fs.readFileSync(path.join(root, '.github', 'workflows', file), 'utf8'));
        return wf.jobs[job].steps.find((s) => /^actions\/cache\/restore@/.test(s.uses || ''));
    });
    // actions/cache 的 cache version 由 path 字串決定：寫法不同（例如 $HOME 與 ~）就互相看不到
    for (const s of [restoreStep, saveStep, ...consumers]) assert.equal(s.with.path, '~/.warp-apt-cache');
    const key = run({ index: INDEX }).stdout.match(/key=(\S+)/)[1];
    const resolve = (t) => t.replace('${{ runner.os }}', 'Linux').replace('${{ steps.runner-image.outputs.version }}', '20261111.196.1');
    for (const s of [restoreStep, ...consumers]) {
        const prefixes = s.with['restore-keys'].trim().split('\n').map((l) => resolve(l.trim()));
        assert.equal(prefixes.length, 2);
        prefixes.forEach((p) => {
            assert.doesNotMatch(p, /\$\{\{/, `未預期的 expression：${p}`);
            assert.ok(key.startsWith(p), `${key} 不在前綴 ${p} 內`);
        });
        // 主鍵不得與另存的鍵同形（否則會變成精確命中而跳過 restore-keys 的「取最新」）
        assert.ok(!resolve(s.with.key).includes('-debs-'));
    }
});

test('快取齊全且正確：全部採用、不下載、不碰 Ubuntu 鏡像；快取鍵由檔名清單決定', () => {
    const r = run({ cacheFiles: { ...INDEX }, index: INDEX });
    assert.match(r.stdout, /RESULT=OK key=warp-apt-Linux-20261111\.196\.1-debs-[0-9a-f]{32}-r777-2\n/, r.stderr);
    // 向 apt-cache 查的是「套件=版本」，檔名裡的 %3a 要還原成 epoch 的冒號
    assert.match(r.calls, /^apt-cache show cloudflare-warp=2026\.8\.2115\.0 libdep=1:2\.0-1$/m);
    assert.match(r.stdout, /cached \.deb: 2 verified \(SHA256\) and reused, 0 rejected, 0 not in cache/);
    assert.equal(count(r.calls, /^downloaded /gm), 0);
    assert.equal(count(r.calls, /^installed-from-archives /gm), 2);
    const updates = r.calls.match(/^apt-get .* update$/gm);
    assert.equal(updates.length, 1);
    assert.match(updates[0], /Dir::Etc::sourcelist=\/etc\/apt\/sources\.list\.d\/cloudflare-client\.list/);
    assert.deepEqual(r.calls.match(/^timeout .*$/gm), ['timeout 30s', 'timeout 20s', 'timeout 20s', 'timeout 240s']);
    assert.doesNotMatch(r.calls, /UNEXPECTED-INSTALL/);
    // 還原命中的鍵屬於同一組檔名、內容清單也沒變 → 不另存
    const key = r.stdout.match(/key=(\S+)/)[1];
    const base = key.replace(/-r777-2$/, '');
    for (const matchedKey of [key, `${base}-r1-1`]) {
        const again = run({ cacheFiles: { ...INDEX }, index: INDEX, matchedKey });
        assert.match(again.stdout, /RESULT=OK key=\n/, `命中 ${matchedKey} 時不該另存`);
    }
    // 鍵名對得上但內容少一個檔（鍵名是寫入者自己取的，不可信）→ 補下載後另存
    const partial = run({ cacheFiles: { 'libdep_1%3a2.0-1_amd64v3.deb': 'DEP' }, index: INDEX, matchedKey: key });
    assert.equal(partial.stdout.match(/key=(\S*)/)[1], key);
    assert.deepEqual(partial.cacheAfter, INDEX);
});

test('WARP 主套件被同名竄改：拒絕、由 apt 重新下載正版，竄改檔不會存回快取', () => {
    const r = run({ cacheFiles: { ...INDEX, 'cloudflare-warp_2026.8.2115.0_amd64.deb': 'EVIL-NEW' }, index: INDEX });
    assert.match(r.stdout, /RESULT=OK/, r.stderr);
    assert.match(r.stdout, /cached \.deb: 1 verified \(SHA256\) and reused, 1 rejected/);
    assert.match(r.calls, /^downloaded cloudflare-warp_2026\.8\.2115\.0_amd64\.deb$/m);
    assert.deepEqual(r.archives, INDEX);
    assert.deepEqual(r.cacheAfter, INDEX, '存回快取的只有 archives 內的正版');
    // 檔名清單沒變、鍵名也對得上，但有檔雜湊不符 → 仍要另存一份乾淨的蓋過它
    const clean = run({ cacheFiles: { ...INDEX }, index: INDEX }).stdout.match(/key=(\S+)/)[1];
    const disguised = run({ cacheFiles: { ...INDEX, 'libdep_1%3a2.0-1_amd64v3.deb': 'EVIL-DEP' }, index: INDEX, matchedKey: clean });
    assert.equal(disguised.stdout.match(/key=(\S*)/)[1], clean);
    assert.deepEqual(disguised.cacheAfter, INDEX);
    // 全部都驗不過（索引查不到雜湊）：不採用任何快取檔，但也不因此每輪另存
    const blind = run({ cacheFiles: { ...INDEX }, index: INDEX, matchedKey: clean, aptCacheBroken: true });
    assert.match(blind.stdout, /cached \.deb: 0 verified \(SHA256\) and reused, 2 rejected/);
    assert.equal(count(blind.calls, /^downloaded /gm), 2);
    assert.match(blind.stdout, /RESULT=OK key=\n/);
});

test('快取的 WARP 版本不是索引現行版（上線第一輪的實況）：舊檔不採用也不存回，鍵跟著改變', () => {
    const old = { 'cloudflare-warp_2026.6.836.0_amd64.deb': 'WARP-OLD', 'libdep_1%3a2.0-1_amd64v3.deb': 'DEP', 'stale_1_amd64.deb': 'STALE' };
    const r = run({ cacheFiles: old, index: INDEX });
    assert.match(r.stdout, /RESULT=OK/, r.stderr);
    assert.match(r.stdout, /cached \.deb: 1 verified \(SHA256\) and reused, 0 rejected, 1 not in cache/);
    assert.deepEqual(r.archives, INDEX);
    assert.deepEqual(r.cacheAfter, INDEX, '舊版 WARP 與不在清單內的檔都被清掉');
    const clean = run({ cacheFiles: { ...INDEX }, index: INDEX });
    assert.equal(r.stdout.match(/key=(\S+)/)[1], clean.stdout.match(/key=(\S+)/)[1], '內容相同 → 鍵相同');
    const other = run({ cacheFiles: {}, index: { ...INDEX, 'extra_1_amd64.deb': 'X' } });
    assert.notEqual(other.stdout.match(/key=(\S+)/)[1], clean.stdout.match(/key=(\S+)/)[1]);
});

test('快取裡的雜物（dotfile、非 .deb、目錄、symlink、與所需檔同名的目錄）不會存回去，且會觸發另存', () => {
    const clean = run({ cacheFiles: { ...INDEX }, index: INDEX }).stdout.match(/key=(\S+)/)[1];
    const r = run({ cacheFiles: { ...INDEX }, index: INDEX, junk: true, matchedKey: clean });
    assert.match(r.stdout, /RESULT=OK/, r.stderr);
    assert.deepEqual(r.cacheAfter, INDEX);
    assert.equal(r.stdout.match(/key=(\S*)/)[1], clean);
    const dir = run({ cacheFiles: { 'cloudflare-warp_2026.8.2115.0_amd64.deb': 'WARP-NEW' }, index: INDEX, dirNamed: 'libdep_1%3a2.0-1_amd64v3.deb', matchedKey: clean });
    assert.match(dir.stdout, /RESULT=OK/, dir.stderr);
    assert.deepEqual(dir.cacheAfter, INDEX, '同名目錄被換成 apt 下載的正版檔');
    assert.deepEqual(dir.archives, INDEX);
});

test('沒有快取：不呼叫比對，直接按名稱安裝並存下', () => {
    const r = run({ index: INDEX });
    assert.match(r.stdout, /RESULT=OK/, r.stderr);
    assert.doesNotMatch(r.calls, /--print-uris/);
    assert.equal(count(r.calls, /^downloaded /gm), 2);
    assert.deepEqual(r.cacheAfter, INDEX);
});

test('Cloudflare 索引更新 3 輪全失敗：archives 在完整 update 前是空的，之後仍要先比對才採用', () => {
    const r = run({ cacheFiles: { ...INDEX, 'cloudflare-warp_2026.8.2115.0_amd64.deb': 'EVIL-NEW' }, index: INDEX, cfUpdateFailures: 3 });
    assert.match(r.stdout, /RESULT=OK/, r.stderr);
    const lines = r.calls.split('\n').filter((l) => /^apt-get /.test(l));
    const kinds = lines.map((l) => (/Dir::Etc::sourcelist.* update$/.test(l) ? 'cf-update' : / update$/.test(l) ? 'full-update' : /--print-uris/.test(l) ? 'uris' : 'install'));
    assert.deepEqual(kinds, ['cf-update', 'cf-update', 'cf-update', 'full-update', 'uris', 'install']);
    assert.deepEqual(r.calls.match(/^timeout .*$/gm).slice(0, 4), ['timeout 30s', 'timeout 40s', 'timeout 40s', 'timeout 90s']);
    assert.match(lines[1], /Debug::Acquire::https=true/);
    assert.match(r.stdout, /1 verified \(SHA256\) and reused, 1 rejected/);
    assert.deepEqual(r.archives, INDEX);

    // 連完整 update 也失敗：整個失敗，且沒有任何快取檔進過 archives、沒有任何 install
    const dead = run({ cacheFiles: { ...INDEX }, index: INDEX, cfUpdateFailures: 3, fullUpdateFailures: 2 });
    assert.match(dead.stdout, /RESULT=FAILED/);
    assert.deepEqual(dead.archives, {});
    assert.doesNotMatch(dead.calls, / install /);
});

test('按名稱安裝失敗（例：映像內建清單指向已下架版本）：完整 update 後重新比對、重裝一次；再失敗就失敗', () => {
    const r = run({ cacheFiles: { ...INDEX }, index: INDEX, installFailures: 1 });
    assert.match(r.stdout, /RESULT=OK/, r.stderr);
    const kinds = r.calls.split('\n').filter((l) => /^apt-get /.test(l))
        .map((l) => (/Dir::Etc::sourcelist.* update$/.test(l) ? 'cf-update' : / update$/.test(l) ? 'full-update' : /--print-uris/.test(l) ? 'uris' : 'install'));
    assert.deepEqual(kinds, ['cf-update', 'uris', 'install', 'full-update', 'uris', 'install']);
    const dead = run({ cacheFiles: { ...INDEX }, index: INDEX, installFailures: 2 });
    assert.match(dead.stdout, /RESULT=FAILED/);
    assert.match(dead.stdout, /::error::Cloudflare WARP package installation failed/);
});
