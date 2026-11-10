'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { maskEmail, redactEmails, safeErrorMessage } = require('../lib/mask-email.cjs');
const { processPlateSubscriptions } = require('../lib/subscription-notify.cjs');
const { createFakeSupabase } = require('./helpers/fake-supabase.cjs');

test('maskEmail：保留首字元與網域，其餘遮罩', () => {
    assert.equal(maskEmail('alice@example.com'), 'a***@example.com');
    assert.equal(maskEmail('x@y.tw'), 'x***@y.tw');
    assert.equal(maskEmail('  Bob.Smith+tag@Mail.Example.COM '), 'B***@Mail.Example.COM');
});

test('maskEmail：空值／不像 email 的值不原樣輸出', () => {
    assert.equal(maskEmail(null), '(no-email)');
    assert.equal(maskEmail(undefined), '(no-email)');
    assert.equal(maskEmail('not-an-email'), '***');
    assert.equal(maskEmail(''), '***');
});

test('maskEmail：不會洩漏原本的 local part', () => {
    const masked = maskEmail('very.secret.name@example.com');
    assert.ok(!masked.includes('secret'));
    assert.ok(!masked.includes('very'));
});

test('redactEmails：字串內所有 email 與 URL 編碼（%40）的 email 都被遮罩', () => {
    const text = 'rejected: <alice@example.com>, cc bob@mail.example.org; url=/watchlist?email=eq.carol%40example.com&x=1';
    const out = redactEmails(text);
    assert.ok(!/alice|bob|carol/.test(out), out);
    assert.match(out, /a\*\*\*@example\.com/);
    assert.match(out, /b\*\*\*@mail\.example\.org/);
    assert.match(out, /e\*\*\*%40example\.com/); // `eq.carol` 整段視為 local part，一併遮掉
    assert.match(out, /x=1/); // 其餘內容不動
});

test('redactEmails：沒有 email 的字串原樣返回；null 返回空字串', () => {
    assert.equal(redactEmails('Max retries reached'), 'Max retries reached');
    assert.equal(redactEmails(null), '');
});

test('safeErrorMessage：吃 Error、字串與 undefined，並遮罩 message 內的 email', () => {
    assert.equal(safeErrorMessage(new Error('550 5.1.1 <dave@example.com> does not exist')), '550 5.1.1 <d***@example.com> does not exist');
    assert.equal(safeErrorMessage('plain dave@example.com'), 'plain d***@example.com');
    assert.equal(safeErrorMessage(undefined), '');
});

// ---------- subscription-notify：寄信行為不變，log 不含 email ----------

async function captureConsole(fn) {
    const orig = { log: console.log, error: console.error, warn: console.warn };
    const lines = [];
    const push = (...a) => lines.push(a.map(String).join(' '));
    console.log = push;
    console.error = push;
    console.warn = push;
    try {
        await fn();
    } finally {
        Object.assign(console, orig);
    }
    return lines;
}

const MATCH = (email, plate) => ({ email, matched_plate_no: plate, number: '8888', source: 'available', station_name: '測試站', price: 2000 });

test('processPlateSubscriptions：寄信成功 → 收件人原值傳給 sendEmail，log 只有遮罩', async () => {
    const sent = [];
    const sb = createFakeSupabase((call) => {
        if (call.rpc === 'claim_plate_subscription_matches') return { data: [MATCH('alice@example.com', 'ABC-8888')] };
        return { data: null };
    });
    const lines = await captureConsole(() => processPlateSubscriptions({
        supabase: sb,
        sendEmail: async (to, subject, html) => { sent.push({ to, subject, html }); return true; },
    }));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'alice@example.com'); // 行為不變：實際收件人是原值
    assert.ok(lines.every((l) => !l.includes('alice@example.com')), lines.join('\n'));
    assert.ok(lines.some((l) => l.includes('a***@example.com') && l.includes('ABC-8888')));
});

test('processPlateSubscriptions：寄信失敗 → 回滾認領（用原值 email 刪除），log 只有遮罩', async () => {
    const sb = createFakeSupabase((call) => {
        if (call.rpc === 'claim_plate_subscription_matches') return { data: [MATCH('alice@example.com', 'ABC-8888')] };
        return { data: null };
    });
    const lines = await captureConsole(() => processPlateSubscriptions({ supabase: sb, sendEmail: async () => false }));
    const del = sb.calls.find((c) => c.table === 'plate_subscription_notifications' && c.has('delete'));
    assert.ok(del, '應回滾已認領的通知列');
    assert.equal(del.eq('email'), 'alice@example.com');
    assert.ok(lines.every((l) => !l.includes('alice@example.com')), lines.join('\n'));
    assert.ok(lines.some((l) => /rolled back 1 claim/.test(l)));
});

test('processPlateSubscriptions：sendEmail 丟例外且訊息夾帶收件人 → 例外訊息被遮罩', async () => {
    const sb = createFakeSupabase((call) => {
        if (call.rpc === 'claim_plate_subscription_matches') return { data: [MATCH('alice@example.com', 'ABC-8888')] };
        return { data: null };
    });
    const lines = await captureConsole(() => processPlateSubscriptions({
        supabase: sb,
        sendEmail: async () => { throw new Error('Recipient address rejected: alice@example.com'); },
    }));
    assert.ok(lines.every((l) => !l.includes('alice@example.com')), lines.join('\n'));
});

// ---------- 靜態護欄：入口檔不得再把裸 email 變數放進 console.* ----------

test('入口檔與 lib 的 console.* 不得再出現未遮罩的收件人變數', () => {
    const root = path.join(__dirname, '..');
    const files = ['bidding-plates-sync.cjs', 'trigger_swap.cjs', 'lib/subscription-notify.cjs'];
    const bare = /\$\{(to|email|watch\.email|sub\.email|smtpUser)\}/;
    for (const f of files) {
        const lines = fs.readFileSync(path.join(root, f), 'utf8').split('\n');
        lines.forEach((line, i) => {
            if (/console\.(log|error|warn|info)/.test(line) && bare.test(line)) {
                assert.fail(`${f}:${i + 1} console 輸出含未遮罩 email：${line.trim()}`);
            }
        });
    }
});
