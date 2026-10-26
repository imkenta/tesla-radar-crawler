'use strict';

/**
 * MVDIS 選號表單填寫（lib/mvdis-form.cjs）。
 *
 * 用 jsdom 載入真實頁面表單節錄＋計時器模擬 DWR 非同步串接（test/helpers/fake-mvdis-page.cjs），
 * 重現「晚間 MVDIS 變慢 → 固定 sleep 串 select → 靜默取消選取」的競態，並驗證新流程能在慢速下填齊。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const {
  FormFieldError,
  inspectFormInDoc,
  selectWithEvent,
  fillForm,
  fillAndVerifyForm,
  inspectForm,
} = require('../lib/mvdis-form.cjs');
const { createFakeMvdisPage, FIXTURE } = require('./helpers/fake-mvdis-page.cjs');

const PARAMS = { deptId: '2', stationId: '10', pType: 'g' };
const FAST = { optionTimeout: 1500, rebuildTimeout: 1500, quietMs: 60 };
const withPage = (opts, fn) => async () => {
  const page = createFakeMvdisPage(opts);
  try { await fn(page); } finally { page.stop(); }
};

// ---------------------------------------------------------------------------
// inspectFormInDoc：與頁面 chkForm() 規則對照
// ---------------------------------------------------------------------------

function freshDoc() {
  return new JSDOM(fs.readFileSync(FIXTURE, 'utf8')).window.document;
}
function setSelect(doc, id, value, text = value) {
  const sel = doc.getElementById(id);
  if (!Array.from(sel.options).some((o) => o.value === value)) {
    const o = doc.createElement('option');
    o.value = value; o.textContent = text;
    sel.appendChild(o);
  }
  sel.value = value;
}
function fillAll(doc) {
  setSelect(doc, 'selDeptCode', '2');
  setSelect(doc, 'selStationCode', '10');
  setSelect(doc, 'selWindowNo', '01');
  setSelect(doc, 'selCarType', 'C');
  setSelect(doc, 'selEnergyType', 'E');
  setSelect(doc, 'selPlateType', 'g');
}
const EXPECTED = { deptId: '2', stationId: '10', windowNo: '01', carType: 'C', energyType: 'E', plateType: 'g' };

test('inspectFormInDoc：全部填對 → 空陣列', () => {
  const doc = freshDoc();
  fillAll(doc);
  assert.deepEqual(inspectFormInDoc(EXPECTED, doc), []);
});

test('inspectFormInDoc：空白表單 → 回報 6 個下拉（plateVer 預設已勾）', () => {
  const doc = freshDoc();
  assert.deepEqual(inspectFormInDoc(EXPECTED, doc), [
    'selDeptCode', 'selStationCode', 'selWindowNo', 'selCarType', 'selEnergyType', 'selPlateType',
  ]);
});

test('inspectFormInDoc：逐欄清掉都能被抓到；plateVer 取消勾選也抓得到', () => {
  const ids = ['selDeptCode', 'selStationCode', 'selWindowNo', 'selCarType', 'selEnergyType', 'selPlateType'];
  for (const id of ids) {
    const doc = freshDoc();
    fillAll(doc);
    doc.getElementById(id).value = id === 'selCarType' || id === 'selEnergyType' ? '' : '0';
    assert.deepEqual(inspectFormInDoc(EXPECTED, doc), [id], id);
  }
  const doc = freshDoc();
  fillAll(doc);
  for (const r of doc.getElementsByName('plateVer')) r.checked = false;
  assert.deepEqual(inspectFormInDoc(EXPECTED, doc), ['plateVer']);
});

test('inspectFormInDoc：站別選到別站算不合格', () => {
  const doc = freshDoc();
  fillAll(doc);
  setSelect(doc, 'selStationCode', '11');
  assert.deepEqual(inspectFormInDoc(EXPECTED, doc), ['selStationCode']);
});

test('inspectFormInDoc：dept／車種／能源只要求合法（chkForm 同款），不要求等於預期；station／window／plateType 要求等於預期', () => {
  const doc = freshDoc();
  fillAll(doc);
  setSelect(doc, 'selDeptCode', '5');   // 合法但 ≠ 預期 '2'
  setSelect(doc, 'selCarType', 'M');    // 合法但 ≠ 預期 'C'
  setSelect(doc, 'selEnergyType', 'C'); // 合法但 ≠ 預期 'E'
  assert.deepEqual(inspectFormInDoc(EXPECTED, doc), []);
  setSelect(doc, 'selWindowNo', '02');
  setSelect(doc, 'selPlateType', 'h');
  assert.deepEqual(inspectFormInDoc(EXPECTED, doc), ['selWindowNo', 'selPlateType']);
});

test('inspectFormInDoc：未給預期值時退為「非空且非 0」', () => {
  const doc = freshDoc();
  fillAll(doc);
  assert.deepEqual(inspectFormInDoc({}, doc), []);
  doc.getElementById('selPlateType').value = '0';
  assert.deepEqual(inspectFormInDoc({}, doc), ['selPlateType']);
});

test('與頁面 chkForm() 對照：chkForm 會擋的狀態，inspect 一定也回報不全', () => {
  const src = fs.readFileSync(path.join(__dirname, 'fixtures', 'mvdis-chkform.js.txt'), 'utf8');
  const cases = {
    空白表單: () => {},
    缺窗口: (d) => { fillAll(d); d.getElementById('selWindowNo').value = '0'; },
    缺車種: (d) => { fillAll(d); d.getElementById('selCarType').value = ''; },
    缺車牌別: (d) => { fillAll(d); d.getElementById('selPlateType').value = '0'; },
    缺站別: (d) => { fillAll(d); d.getElementById('selStationCode').value = '0'; },
  };
  for (const [name, setup] of Object.entries(cases)) {
    const dom = new JSDOM(fs.readFileSync(FIXTURE, 'utf8'), { runScripts: 'outside-only' });
    const { window } = dom;
    setup(window.document);
    const alerts = [];
    window.alert = (m) => alerts.push(m);
    window.dwr = { util: { getValue: (id) => (id === 'plateVer' ? '2' : 'ABCD'), setValue() {} } };
    window.eval(src);
    const chkOk = window.eval('chkForm()');
    assert.equal(chkOk, false, `${name}: chkForm 應該擋下`);
    assert.ok(alerts[0].startsWith('請選擇'), `${name}: ${alerts[0]}`);
    assert.ok(inspectFormInDoc(EXPECTED, window.document).length > 0, `${name}: inspect 也要回報不全`);
  }
  // 全填好：chkForm 放行、inspect 也空
  const dom = new JSDOM(fs.readFileSync(FIXTURE, 'utf8'), { runScripts: 'outside-only' });
  const { window } = dom;
  fillAll(window.document);
  window.alert = () => assert.fail('不該 alert');
  window.dwr = { util: { getValue: (id) => (id === 'plateVer' ? '2' : 'ABCD'), setValue() {} } };
  window.document.WebPickNoForm = { action: '', method: {} };
  window.eval(src);
  assert.equal(window.eval('chkForm()'), true);
  assert.deepEqual(inspectFormInDoc(EXPECTED, window.document), []);
});


// ---------------------------------------------------------------------------
// selectWithEvent（M1：不再手動補 dispatch，每次選取只觸發一次 inline onchange）
// ---------------------------------------------------------------------------

test('selectWithEvent：選項稍後才出現（DWR 晚回）→ 等到出現再選，成功回 true', withPage({ stationDelay: 300 }, async (page) => {
  await selectWithEvent(page, '#selDeptCode', '2', { optionTimeout: 1500 });
  const t0 = Date.now();
  const ok = await selectWithEvent(page, '#selStationCode', '10', { optionTimeout: 1500 });
  assert.equal(ok, true);
  assert.equal(page.value('selStationCode'), '10');
  assert.ok(Date.now() - t0 >= 150, '應該真的有等');
}));

test('selectWithEvent：選項始終不出現 → option-timeout（FormFieldError），不是靜默取消', withPage({}, async (page) => {
  await assert.rejects(
    selectWithEvent(page, '#selStationCode', '10', { optionTimeout: 250 }), // 沒選 dept，站別選項不會出現
    (e) => e instanceof FormFieldError && e.code === 'option-timeout' && e.selector === '#selStationCode',
  );
}));

test('selectWithEvent：元素不存在 → selector-timeout', withPage({}, async (page) => {
  await assert.rejects(
    selectWithEvent(page, '#nope', 'x', { optionTimeout: 150 }),
    (e) => e instanceof FormFieldError && e.code === 'selector-timeout',
  );
}));

test('selectWithEvent：選了卻沒生效 → not-selected', withPage({}, async (page) => {
  const realSelect = page.select.bind(page);
  page.select = async (sel, v) => { await realSelect(sel, v); page.doc.querySelector(sel).value = '0'; return []; };
  await assert.rejects(
    selectWithEvent(page, '#selDeptCode', '2', { optionTimeout: 500 }),
    (e) => e instanceof FormFieldError && e.code === 'not-selected',
  );
}));

test('M1：每次選取只觸發一次 inline onchange（getStation／getWindow／getWindowStatus＋getPlateType／refreshFilterPlateType）', withPage({}, async (page) => {
  await selectWithEvent(page, '#selDeptCode', '2', { optionTimeout: 1500 });
  assert.equal(page.calls.getStation, 1);
  await selectWithEvent(page, '#selStationCode', '10', { optionTimeout: 1500 });
  assert.equal(page.calls.getWindow, 1);
  await selectWithEvent(page, '#selWindowNo', '01', { optionTimeout: 1500 });
  assert.equal(page.calls.getWindowStatus, 1);
  assert.equal(page.calls.getPlateType, 1);
}));

test('M1：整個 fillForm 的 DWR 呼叫次數＝1/1/1/1，車種＋能源各一次 refreshFilterPlateType', withPage({ plateTypeDelay: 50 }, async (page) => {
  await fillForm(page, PARAMS, FAST);
  assert.deepEqual({ ...page.calls }, { getStation: 1, getWindow: 1, getWindowStatus: 1, getPlateType: 1, refreshFilterPlateType: 2 });
}));

// ---------------------------------------------------------------------------
// fillForm（逐層等「下一層被重建且安靜」）
// ---------------------------------------------------------------------------

test('對照組：舊做法（固定 sleep、不等 option）在慢速 DWR 下會靜默取消選取', withPage({ stationDelay: 400, windowDelay: 400, plateTypeDelay: 400 }, async (page) => {
  const naive = async (sel, v) => { await page.select(sel, v); };
  await naive('#selDeptCode', '2');
  await new Promise((r) => setTimeout(r, 100)); // 舊版固定 sleep 比 DWR 延遲短
  await naive('#selStationCode', '10');
  await naive('#selWindowNo', '01');
  await naive('#selCarType', 'C');
  await naive('#selEnergyType', 'E');
  await naive('#selPlateType', 'g');
  const missing = await inspectForm(page, PARAMS);
  assert.ok(missing.length > 0, `慢速下舊做法應該填不齊，實際缺：${missing}`);
}));

test('fillForm：快速回應 → 一次填齊', withPage({}, async (page) => {
  await fillForm(page, PARAMS, FAST);
  assert.deepEqual(await inspectForm(page, PARAMS), []);
}));

test('fillForm：慢速 DWR（各段 300–500ms）＋三層都有重複 callback → 仍填齊且不被晚到的重建清掉',
  withPage({ stationDelay: 300, windowDelay: 300, plateTypeDelay: 500, stationDuplicates: 2, windowDuplicates: 2, plateTypeDuplicates: 2, duplicateGap: 150 }, async (page) => {
    await fillForm(page, PARAMS, { ...FAST, quietMs: 250, optionTimeout: 4000, rebuildTimeout: 4000 });
    await new Promise((r) => setTimeout(r, 800)); // 再等，確認沒有遲到的 callback 把欄位清掉
    assert.deepEqual(await inspectForm(page, PARAMS), []);
    assert.equal(page.value('selStationCode'), '10');
    assert.equal(page.value('selWindowNo'), '01');
    assert.equal(page.value('selCarType'), 'C');
    assert.equal(page.value('selPlateType'), 'g');
  }));

test('M2：station／window 重複 callback 間隔 400ms（用預設 quiet 500ms 吸收）→ 填齊且穩定',
  withPage({ stationDelay: 200, windowDelay: 200, plateTypeDelay: 200, stationDuplicates: 2, windowDuplicates: 2, plateTypeDuplicates: 2, duplicateGap: 400 }, async (page) => {
    await fillForm(page, PARAMS, { optionTimeout: 6000, rebuildTimeout: 6000 }); // 預設 quietMs
    await new Promise((r) => setTimeout(r, 1200));
    assert.deepEqual(await inspectForm(page, PARAMS), []);
  }));

test('H1：原頁重填在 DWR 500ms／1000ms 下仍成功（舊 option 還在不能當作「下一層已重建」）', async () => {
  for (const d of [500, 1000]) {
    const page = createFakeMvdisPage({ stationDelay: d, windowDelay: d, plateTypeDelay: d });
    try {
      page.presetFilled();       // 舊的站別／窗口 option 都還在
      page.wipeCarAndEnergy();   // 遲到的 refreshPlateType 清掉車種／能源／車牌別
      const res = await fillAndVerifyForm(page, PARAMS, { optionTimeout: 6000, rebuildTimeout: 6000 }); // 第一次就是完整重填（從 dept）
      assert.equal(res.ok, true, `d=${d}`);
      assert.equal(res.tries, 1, `d=${d}`);
      await new Promise((r) => setTimeout(r, d * 2));
      assert.deepEqual(await inspectForm(page, PARAMS), [], `d=${d} 之後不可被遲到 callback 洗掉`);
    } finally { page.stop(); }
  }
});

test('H1：from=type 只補車種／能源／車牌別，不重打 getStation／getWindow', withPage({ plateTypeDelay: 200 }, async (page) => {
  page.presetFilled();
  page.wipeCarAndEnergy();
  await fillForm(page, PARAMS, { ...FAST, from: 'type' });
  assert.deepEqual(await inspectForm(page, PARAMS), []);
  assert.deepEqual({ s: page.calls.getStation, w: page.calls.getWindow, p: page.calls.getPlateType }, { s: 0, w: 0, p: 0 });
}));

test('H1：from=window 只重選窗口以下，不重打 getStation／getWindow', withPage({ plateTypeDelay: 300 }, async (page) => {
  page.presetFilled();
  await fillForm(page, PARAMS, { ...FAST, from: 'window' });
  assert.deepEqual(await inspectForm(page, PARAMS), []);
  assert.deepEqual({ s: page.calls.getStation, w: page.calls.getWindow, p: page.calls.getPlateType }, { s: 0, w: 0, p: 1 });
}));

test('fillForm：租賃牌（h）同樣可選', withPage({ plateTypeDelay: 100 }, async (page) => {
  await fillForm(page, { ...PARAMS, pType: 'h' }, FAST);
  assert.deepEqual(await inspectForm(page, { ...PARAMS, pType: 'h' }), []);
}));

test('fillForm：refreshPlateType 一直沒回 → 記 log 後往下，最終丟 option-timeout，不卡死',
  withPage({ plateTypeDelay: 60000 }, async (page) => {
    const logs = [];
    await assert.rejects(
      fillForm(page, PARAMS, { ...FAST, rebuildTimeout: 200, optionTimeout: 250, log: (m) => logs.push(m) }),
      (e) => e instanceof FormFieldError && e.code === 'option-timeout',
    );
    assert.ok(logs.some((m) => m.includes('逾時')), '應該記錄重建逾時');
  }));

// ---------------------------------------------------------------------------
// fillAndVerifyForm（重填計畫、預算、quick 還原）
// ---------------------------------------------------------------------------

test('fillAndVerifyForm：第一次填不齊 → 原頁重填，第二次成功', async () => {
  let fills = 0;
  const res = await fillAndVerifyForm({}, PARAMS, {
    fill: async () => { fills++; },
    inspect: async () => (fills < 2 ? ['selCarType'] : []),
  });
  assert.deepEqual({ ok: res.ok, tries: res.tries }, { ok: true, tries: 2 });
});

test('fillAndVerifyForm：重填計畫＝第一次從 dept、之後從第一個錯的欄位、最後一次保底從 dept', async () => {
  const froms = [];
  const missings = [['selStationCode', 'selWindowNo'], ['selCarType'], ['selPlateType']];
  let i = 0;
  const res = await fillAndVerifyForm({}, PARAMS, {
    fill: async (_p, _q, o) => { froms.push(o.from); },
    inspect: async () => missings[i++],
  });
  assert.equal(res.ok, false);
  assert.deepEqual(froms, ['dept', 'station', 'dept']);
});

test('fillAndVerifyForm：3 次都不全 → ok=false，回報缺哪些欄位與實際值，並 log', async () => {
  const logs = [];
  const res = await fillAndVerifyForm({}, PARAMS, {
    fill: async () => {},
    inspect: async () => ({ missing: ['selCarType', 'selPlateType'], values: { selCarType: '', selPlateType: '0' } }),
    log: (m) => logs.push(m),
  });
  assert.deepEqual({ ok: res.ok, tries: res.tries, missing: res.missing }, { ok: false, tries: 3, missing: ['selCarType', 'selPlateType'] });
  assert.ok(logs.some((m) => m.includes('selCarType') && m.includes('"selPlateType":"0"')), '應含各欄位實際值');
});

test('fillAndVerifyForm：FormFieldError 算一次嘗試並重試；其他錯誤照常上拋', async () => {
  let n = 0;
  const res = await fillAndVerifyForm({}, PARAMS, {
    fill: async () => { n++; if (n === 1) throw new FormFieldError('option-timeout', '#selStationCode', '10'); },
    inspect: async () => (n < 2 ? ['selStationCode'] : []),
  });
  assert.deepEqual({ ok: res.ok, tries: res.tries }, { ok: true, tries: 2 });
  await assert.rejects(
    fillAndVerifyForm({}, PARAMS, { fill: async () => { throw new Error('Attempted to use detached Frame'); }, inspect: async () => [] }),
    /detached Frame/,
  );
});

test('H3：單次填表總時間上限——超過預算直接 ok=false（budgetExceeded），不再繼續重填', async () => {
  let fills = 0;
  const res = await fillAndVerifyForm({}, PARAMS, {
    budgetMs: 80,
    fill: async () => { fills++; await new Promise((r) => setTimeout(r, 120)); },
    inspect: async () => ['selWindowNo'],
  });
  assert.equal(res.ok, false);
  assert.equal(res.budgetExceeded, true);
  assert.equal(fills, 1);
});

test('H3：預算會壓縮單步逾時（卡在等 option 的 fill 不會超過總預算太多）', withPage({}, async (page) => {
  const t0 = Date.now();
  const res = await fillAndVerifyForm(page, PARAMS, { budgetMs: 1500, optionTimeout: 12000, rebuildTimeout: 12000 });
  // dept 選得到，之後 station 選項會出現（DWR 0 延遲）→ 正常填齊；改用不存在的站來卡住
  assert.equal(res.ok, true);
  const t1 = Date.now();
  const res2 = await fillAndVerifyForm(page, { ...PARAMS, stationId: '99' }, { budgetMs: 1500, optionTimeout: 12000, rebuildTimeout: 12000 });
  assert.equal(res2.ok, false);
  assert.ok(Date.now() - t1 < 6000, `應在預算附近結束，實際 ${Date.now() - t1}ms`);
  assert.ok(Date.now() - t0 < 9000);
}));

// ---- quick 路徑（H2）----

test('H2 quick：頁面非同步還原（dept／車種／能源 800ms 後才回來）→ 輪詢等到通過，不觸發任何重填', withPage({}, async (page) => {
  page.simulateQuickReturn({ restoreDelay: 800 });
  const t0 = Date.now();
  const res = await fillAndVerifyForm(page, PARAMS, { mode: 'quick', quickRestoreMs: 3000, quickRestorePollMs: 100 });
  assert.equal(res.ok, true);
  assert.equal(res.tries, 1);
  assert.ok(Date.now() - t0 >= 700, '應該等到還原才通過');
  assert.deepEqual({ s: page.calls.getStation, w: page.calls.getWindow, p: page.calls.getPlateType }, { s: 0, w: 0, p: 0 });
}));

test('H2 quick：還原後只剩車牌別不對（h→g 換型）→ 只重選車牌別，不打任何 DWR', withPage({}, async (page) => {
  page.simulateQuickReturn({ restoreDelay: 300 });
  const res = await fillAndVerifyForm(page, { ...PARAMS, pType: 'h' }, { mode: 'quick', quickRestoreMs: 3000, quickRestorePollMs: 100 });
  assert.equal(res.ok, true);
  assert.equal(page.value('selPlateType'), 'h');
  assert.deepEqual({ s: page.calls.getStation, w: page.calls.getWindow, p: page.calls.getPlateType }, { s: 0, w: 0, p: 0 });
}));

test('H2 quick：還原逾時仍缺 dept → log 實際值，從缺的那層往下補（不是盲目重填）', withPage({ stationDelay: 100, windowDelay: 100, plateTypeDelay: 100 }, async (page) => {
  page.simulateQuickReturn({ restoreDelay: 60000 }); // 永遠不還原
  const logs = [];
  const res = await fillAndVerifyForm(page, PARAMS, { mode: 'quick', quickRestoreMs: 400, quickRestorePollMs: 100, optionTimeout: 3000, rebuildTimeout: 3000, quietMs: 60, log: (m) => logs.push(m) });
  assert.equal(res.ok, true);
  const first = logs.find((m) => m.includes('Quick 還原後仍不全'));
  assert.ok(first && first.includes('selDeptCode') && first.includes('"selDeptCode":"0"'), first);
}));

test('H2 quick：評估期間遇到導航競態（Execution context was destroyed）視為還沒好，繼續輪詢', async () => {
  let n = 0;
  const res = await fillAndVerifyForm({}, PARAMS, {
    mode: 'quick',
    quickRestoreMs: 2000,
    quickRestorePollMs: 10,
    inspect: async () => {
      n++;
      if (n <= 2) throw new Error('Execution context was destroyed, most likely because of a navigation.');
      return [];
    },
  });
  assert.equal(res.ok, true);
  assert.ok(n >= 3);
});

test('H2 quick：已通過就不做任何動作；缺車牌別才呼叫 quickFill；其他缺漏退成完整補', async () => {
  const calls = [];
  let state = ['selPlateType'];
  const res = await fillAndVerifyForm({}, PARAMS, {
    mode: 'quick',
    quickRestoreMs: 100, quickRestorePollMs: 10,
    quickFill: async () => { calls.push('quick'); state = []; },
    fill: async () => { calls.push('full'); },
    inspect: async () => state,
  });
  assert.equal(res.ok, true);
  assert.deepEqual(calls, ['quick']);

  const calls2 = [];
  const res2 = await fillAndVerifyForm({}, PARAMS, { mode: 'quick', quickRestoreMs: 100, quickRestorePollMs: 10, quickFill: async () => calls2.push('quick'), fill: async () => calls2.push('full'), inspect: async () => [] });
  assert.equal(res2.ok, true);
  assert.deepEqual(calls2, []);

  const calls3 = [];
  let filled = false;
  const res3 = await fillAndVerifyForm({}, PARAMS, {
    mode: 'quick', quickRestoreMs: 50, quickRestorePollMs: 10,
    quickFill: async () => calls3.push('quick'),
    fill: async (_p, _q, o) => { calls3.push('full:' + o.from); filled = true; },
    inspect: async () => (filled ? [] : ['selStationCode', 'selWindowNo']),
  });
  assert.equal(res3.ok, true);
  assert.deepEqual(calls3, ['full:station']);
});
