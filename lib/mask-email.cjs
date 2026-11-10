'use strict';

/**
 * Email 遮罩（2026-11-10 健檢 R1）。
 *
 * 本 repo 是 PUBLIC，GitHub Actions log 任何登入者都讀得到；收件人（使用者）email 不會被
 * secret 遮罩機制處理，所以所有 console 輸出都必須先過本模組。
 *
 * - maskEmail('alice@example.com')      → 'a***@example.com'
 * - redactEmails(text)                  → 把字串內所有 email（含 URL 編碼的 %40）換成遮罩形式
 * - safeErrorMessage(err)               → 取 err.message 後 redactEmails，專給 console 用
 *
 * 只影響「印出去的字串」；寫進 DB（如 email_bounce_list.reason）或寄信本身一律用原值。
 */

// local@domain；domain 至少含一個點。刻意寬鬆（寧可多遮），不追求 RFC 完整性。
const EMAIL_RE = /[A-Za-z0-9._%+'-]+(?:@|%40)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/gi;

function maskEmail(email) {
  if (email === null || email === undefined) return '(no-email)';
  const s = String(email).trim();
  const m = /^(.*?)(@|%40)(.+)$/i.exec(s);
  if (!m) return '***'; // 不像 email 的值也不要原樣印出
  const [, local, at, domain] = m;
  const head = local ? Array.from(local)[0] : '';
  return `${head}***${at}${domain}`;
}

function redactEmails(text) {
  if (text === null || text === undefined) return '';
  return String(text).replace(EMAIL_RE, (match) => maskEmail(match));
}

function safeErrorMessage(err) {
  if (err && typeof err === 'object' && 'message' in err) return redactEmails(err.message);
  return redactEmails(err);
}

module.exports = { maskEmail, redactEmails, safeErrorMessage, EMAIL_RE };
