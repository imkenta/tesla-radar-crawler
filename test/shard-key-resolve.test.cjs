'use strict';

/**
 * resolveShardKeys（lib/ai-model-ladder.cjs）純函式測試。
 *
 * 2026-07-05：3→5 分片重構新增的防呆——shard 模式下缺該 shard 專屬 key 必須
 * 快速失敗（throw），絕不靜默落回只用 DEFAULT key 硬跑。全 mock 環境變數物件，
 * 不動 process.env、不打真實 API。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resolveShardKeys } = require('../lib/ai-model-ladder.cjs');

test('shard 模式：專屬 key 存在 → 回傳 Map 含 shard key + DEFAULT key（優先序 shard 在前）', () => {
    const env = { GEMINI_API_KEY_NORTH: 'key-north', GEMINI_API_KEY: 'key-default' };
    const keys = resolveShardKeys('NORTH', env);
    assert.deepEqual([...keys.keys()], ['GEMINI_API_KEY_NORTH', 'GEMINI_API_KEY']);
    assert.equal(keys.get('GEMINI_API_KEY_NORTH'), 'key-north');
});

test('shard 模式：專屬 key 缺失（undefined）→ throw，不靜默 fallback 到 DEFAULT', () => {
    const env = { GEMINI_API_KEY: 'key-default' }; // 沒有 GEMINI_API_KEY_SHARD4
    assert.throws(
        () => resolveShardKeys('SHARD4', env),
        /缺 GEMINI_API_KEY_SHARD4/,
        '應丟出明確指名缺哪個 shard key 的錯誤'
    );
});

test('shard 模式：專屬 key 為空字串 → 視同缺失，throw', () => {
    const env = { GEMINI_API_KEY_SHARD5: '', GEMINI_API_KEY: 'key-default' };
    assert.throws(() => resolveShardKeys('SHARD5', env), /缺 GEMINI_API_KEY_SHARD5/);
});

test('shard 模式：新分片 SHARD4/SHARD5 比照舊分片同一套規則（不因新命名而不同）', () => {
    const envMissing4 = { GEMINI_API_KEY: 'key-default', GEMINI_API_KEY_SHARD5: 'key-5' };
    assert.throws(() => resolveShardKeys('SHARD4', envMissing4), /缺 GEMINI_API_KEY_SHARD4/);

    const envOk5 = { GEMINI_API_KEY_SHARD5: 'key-5', GEMINI_API_KEY: 'key-default' };
    const keys = resolveShardKeys('SHARD5', envOk5);
    assert.deepEqual([...keys.keys()], ['GEMINI_API_KEY_SHARD5', 'GEMINI_API_KEY']);
});

test('shard 模式：shard key 與 DEFAULT key 值相同 → 去重成一把（避免死亡標記失真）', () => {
    const env = { GEMINI_API_KEY_SOUTH: 'same-key', GEMINI_API_KEY: 'same-key' };
    const keys = resolveShardKeys('SOUTH', env);
    assert.equal(keys.size, 1, '值相同應視為同一把 key，去重');
    assert.deepEqual([...keys.keys()], ['GEMINI_API_KEY_SOUTH']);
});

test('shard 模式：只有 shard key、沒有 DEFAULT key → 仍可運作（Map 只含 shard key）', () => {
    const env = { GEMINI_API_KEY_CENTRAL: 'key-central' };
    const keys = resolveShardKeys('CENTRAL', env);
    assert.deepEqual([...keys.keys()], ['GEMINI_API_KEY_CENTRAL']);
});

test('非 shard 模式（legacy 全量跑，shard=null）：不要求 shard key，只需 DEFAULT key', () => {
    const env = { GEMINI_API_KEY: 'key-default' };
    const keys = resolveShardKeys(null, env);
    assert.deepEqual([...keys.keys()], ['GEMINI_API_KEY']);
});

test('完全無任何可用 key（shard 與 DEFAULT 皆缺）→ throw', () => {
    assert.throws(() => resolveShardKeys('SHARD4', {}), /缺 GEMINI_API_KEY_SHARD4/);
    assert.throws(() => resolveShardKeys(null, {}), /No API key available/);
});

test('shard 名稱大小寫不拘：小寫輸入仍能正確組出對應的大寫 key 名稱', () => {
    const env = { GEMINI_API_KEY_SHARD4: 'key-4', GEMINI_API_KEY: 'key-default' };
    const keys = resolveShardKeys('shard4', env);
    assert.deepEqual([...keys.keys()], ['GEMINI_API_KEY_SHARD4', 'GEMINI_API_KEY']);
});
