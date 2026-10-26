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
const FAST = { settleMs: 0, optionTimeout: 1500, rebuildTimeout: 1500, quietMs: 60 };
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

test('inspectFormInDoc：值有填但不等於預期（例如站別選到別站）也算不合格', () => {
  const doc = freshDoc();
  fillAll(doc);
  setSelect(doc, 'selStationCode', '11');
  assert.deepEqual(inspectFormInDoc(EXPECTED, doc), ['selStationCode']);
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
// selectWithEvent
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

test('selectWithEvent：選了卻沒生效（option 在 select 後立刻被重建移除）→ not-selected', withPage({}, async (page) => {
  const realSelect = page.select.bind(page);
  page.select = async (sel, v) => { await realSelect(sel, v); page.doc.querySelector(sel).value = '0'; return []; };
  await assert.rejects(
    selectWithEvent(page, '#selDeptCode', '2', { optionTimeout: 500 }),
    (e) => e instanceof FormFieldError && e.code === 'not-selected',
  );
}));

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

// ---------------------------------------------------------------------------
// fillForm / fillAndVerifyForm
// ---------------------------------------------------------------------------

test('fillForm：快速回應 → 一次填齊', withPage({}, async (page) => {
  await fillForm(page, PARAMS, FAST);
  assert.deepEqual(await inspectForm(page, PARAMS), []);
}));

test('fillForm：慢速 DWR（各段 300–500ms）＋refreshPlateType 重複 callback → 仍填齊且不被晚到的重建清掉',
  withPage({ stationDelay: 300, windowDelay: 300, plateTypeDelay: 500, plateTypeDuplicates: 2, duplicateGap: 150 }, async (page) => {
    await fillForm(page, PARAMS, { ...FAST, quietMs: 250 });
    await new Promise((r) => setTimeout(r, 700)); // 再等一陣子，確認沒有遲到的 callback 把欄位清掉
    assert.deepEqual(await inspectForm(page, PARAMS), []);
    assert.equal(page.value('selCarType'), 'C');
    assert.equal(page.value('selEnergyType'), 'E');
    assert.equal(page.value('selPlateType'), 'g');
  }));

test('fillForm：租賃牌（h）同樣可選', withPage({ plateTypeDelay: 100 }, async (page) => {
  await fillForm(page, { ...PARAMS, pType: 'h' }, FAST);
  assert.deepEqual(await inspectForm(page, { ...PARAMS, pType: 'h' }), []);
}));

test('fillForm：refreshPlateType 一直沒回 → 照常往下填，由後續驗證把關（拋 option-timeout，不卡死）',
  withPage({ plateTypeDelay: 60000 }, async (page) => {
    // 用 clearTimeout 風險小：page.stop() 會清掉計時器
    const logs = [];
    await assert.rejects(
      fillForm(page, PARAMS, { ...FAST, rebuildTimeout: 200, optionTimeout: 250, log: (m) => logs.push(m) }),
      (e) => e instanceof FormFieldError && e.code === 'option-timeout',
    );
    assert.ok(logs.some((m) => m.includes('逾時')), '應該記錄重建逾時');
  }));

test('fillAndVerifyForm：第一次填不齊 → 原頁重填，第二次成功', async () => {
  let fills = 0;
  const res = await fillAndVerifyForm({}, PARAMS, {
    fill: async () => { fills++; },
    inspect: async () => (fills < 2 ? ['selCarType'] : []),
  });
  assert.deepEqual({ ok: res.ok, tries: res.tries }, { ok: true, tries: 2 });
  assert.equal(fills, 2);
});

test('fillAndVerifyForm：3 次都不全 → ok=false（呼叫端走 Full Nav），回報缺哪些欄位', async () => {
  let fills = 0;
  const logs = [];
  const res = await fillAndVerifyForm({}, PARAMS, {
    fill: async () => { fills++; },
    inspect: async () => ['selCarType', 'selPlateType'],
    log: (m) => logs.push(m),
  });
  assert.equal(fills, 3);
  assert.deepEqual({ ok: res.ok, tries: res.tries, missing: res.missing }, { ok: false, tries: 3, missing: ['selCarType', 'selPlateType'] });
  assert.ok(logs.some((m) => m.includes('selCarType')));
});

test('fillAndVerifyForm：FormFieldError 算一次嘗試並重試；其他錯誤照常上拋', async () => {
  let n = 0;
  const res = await fillAndVerifyForm({}, PARAMS, {
    fill: async () => { n++; if (n === 1) throw new FormFieldError('option-timeout', '#selStationCode', '10'); },
    inspect: async () => (n < 2 ? ['selStationCode'] : []),
  });
  assert.deepEqual({ ok: res.ok, tries: res.tries }, { ok: true, tries: 2 });

  await assert.rejects(
    fillAndVerifyForm({}, PARAMS, {
      fill: async () => { throw new Error('Attempted to use detached Frame'); },
      inspect: async () => [],
    }),
    /detached Frame/,
  );
});

test('fillAndVerifyForm quick 模式：第一次只重選車牌別，驗證通過就不做完整重填', async () => {
  const calls = [];
  const res = await fillAndVerifyForm({}, PARAMS, {
    mode: 'quick',
    quickFill: async () => { calls.push('quick'); },
    fill: async () => { calls.push('full'); },
    inspect: async () => [],
  });
  assert.equal(res.ok, true);
  assert.deepEqual(calls, ['quick']);
});

test('fillAndVerifyForm quick 模式：車牌別選了但其他欄位被清空 → 退成完整重填', async () => {
  const calls = [];
  const res = await fillAndVerifyForm({}, PARAMS, {
    mode: 'quick',
    quickFill: async () => { calls.push('quick'); },
    fill: async () => { calls.push('full'); },
    inspect: async () => (calls.includes('full') ? [] : ['selCarType']),
  });
  assert.equal(res.ok, true);
  assert.deepEqual(calls, ['quick', 'full']);
});

test('端到端（假頁面）：quick 模式在表單已被填好的頁面上直接通過；被清掉車種則完整重填',
  withPage({ plateTypeDelay: 50 }, async (page) => {
    await fillForm(page, PARAMS, FAST);
    const ok = await fillAndVerifyForm(page, PARAMS, { ...FAST, mode: 'quick' });
    assert.deepEqual({ ok: ok.ok, tries: ok.tries }, { ok: true, tries: 1 });

    page.wipeCarAndEnergy(); // 模擬遲到的 refreshPlateType 把車種／能源／車牌別清掉
    const healed = await fillAndVerifyForm(page, PARAMS, { ...FAST, mode: 'quick' });
    assert.equal(healed.ok, true);
    assert.equal(healed.tries, 2);
    assert.deepEqual(await inspectForm(page, PARAMS), []);
  }));
