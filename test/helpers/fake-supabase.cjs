'use strict';

/**
 * 測試用假 Supabase client（2026-11-10）。
 *
 * ⛔ 測試絕不可連線上庫：所有需要 supabase 的測試一律注入這個假物件。
 *
 * from(table) 與 rpc(name, args) 都回傳「可鏈接 + thenable」的物件：任何方法呼叫都會記錄 (name, args)
 * 並回傳自己，await 時才呼叫 handler 取得 { data, error, count }。
 *
 *   const sb = createFakeSupabase((call) => {
 *     if (call.table === 'sync_metadata' && call.has('maybeSingle')) return { data: {...}, error: null };
 *     return { data: [], error: null };
 *   });
 *   sb.calls  // 所有已解析的呼叫（供斷言：例如確認 swap rpc 從未被呼叫）
 */
function createFakeSupabase(handler) {
  const calls = [];

  function makeChain(base) {
    const ops = [];
    const chain = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve, reject) => {
            const call = {
              ...base,
              ops,
              has: (name) => ops.some((o) => o.name === name),
              arg: (name, idx = 0) => ops.find((o) => o.name === name)?.args[idx],
              eq: (col) => ops.find((o) => o.name === 'eq' && o.args[0] === col)?.args[1],
            };
            calls.push(call);
            try {
              resolve(Promise.resolve(handler(call)).then((r) => ({ error: null, ...r })));
            } catch (e) {
              reject(e);
            }
          };
        }
        if (typeof prop === 'symbol') return undefined;
        return (...args) => {
          ops.push({ name: prop, args });
          return chain;
        };
      },
    });
    return chain;
  }

  return {
    calls,
    from: (table) => makeChain({ kind: 'from', table }),
    rpc: (name, args) => makeChain({ kind: 'rpc', rpc: name, rpcArgs: args }),
  };
}

module.exports = { createFakeSupabase };
