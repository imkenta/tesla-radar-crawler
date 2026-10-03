'use strict';
/**
 * 驗證碼 OCR 模型比對（唯讀工具，不寫 DB、不動階梯）。
 * 用法：GEMINI_API_KEY=… node tools/ocr-model-bench.cjs <圖片目錄> [模型,模型,…] [--repeat N]
 * 圖片檔名若為「正解.jpg」（4 字元）就算正確率；否則只看模型間一致性。
 * prompt／systemInstruction／generationConfig 與 gh-plate-sync.cjs 的 solveCaptcha 完全相同。
 */
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { extractCaptchaCode } = require('../lib/captcha-parser.cjs');

const dir = process.argv[2];
const models = (process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 'gemma-4-26b-a4b-it,gemma-4-31b-it,gemini-3.5-flash-lite,gemini-3.1-flash-lite').split(',');
const repeat = Number((process.argv.find((a, i) => process.argv[i - 1] === '--repeat')) || 1);
const key = process.env.GEMINI_API_KEY;
if (!dir || !key) { console.error('需要 <圖片目錄> 與環境變數 GEMINI_API_KEY'); process.exit(2); }

const SYS = "You are a specialized CAPTCHA solver. Your ONLY task is to output the 4 characters found in the image. DO NOT explain. DO NOT use thinking process. DO NOT output anything except the 4 characters. 只輸出驗證碼的4個字元，禁止任何其他文字或解釋。";
const files = fs.readdirSync(dir).filter(f => /\.(jpe?g|png)$/i.test(f)).sort();
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const genAI = new GoogleGenerativeAI(key);
  const stat = Object.fromEntries(models.map(m => [m, { ok: 0, parsed: 0, truthN: 0, err: 0, ms: [] }]));
  for (const f of files) {
    const truth = /^[A-Za-z0-9]{4}(?:[_-].*)?\.\w+$/.test(f) ? f.slice(0, 4).toUpperCase() : null;
    const mime = /png$/i.test(f) ? 'image/png' : 'image/jpeg';
    const data = fs.readFileSync(path.join(dir, f)).toString('base64');
    const row = [];
    for (const m of models) {
      for (let i = 0; i < repeat; i++) {
        const t0 = Date.now(); let out;
        try {
          const model = genAI.getGenerativeModel({ model: m, systemInstruction: SYS, generationConfig: { temperature: 0, maxOutputTokens: 16 } });
          const r = await model.generateContent(['Characters in image:', { inlineData: { data, mimeType: mime } }]);
          out = extractCaptchaCode(r.response.text().trim());
        } catch (e) { out = 'ERR:' + String(e.message).slice(0, 40); stat[m].err++; }
        const s = stat[m]; s.ms.push(Date.now() - t0);
        if (out && !out.startsWith('ERR')) { s.parsed++; if (truth) { s.truthN++; if (out.toUpperCase() === truth) s.ok++; } }
        row.push(`${m.split('-').slice(0, 3).join('-')}=${out}`);
        await sleep(2500); // 各模型 RPM ≥15，留餘裕
      }
    }
    console.log(f, truth ? `[正解 ${truth}]` : '', row.join('  '));
  }
  console.log('\n== 摘要 ==');
  for (const m of models) {
    const s = stat[m]; const ms = s.ms.sort((a, b) => a - b);
    console.log(m, `parsed=${s.parsed}/${ms.length} err=${s.err}`, s.truthN ? `對正解=${s.ok}/${s.truthN}` : '', `p50=${ms[ms.length >> 1] || 0}ms`);
  }
})();
