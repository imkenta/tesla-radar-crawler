/**
 * SMTP 寄信測試腳本（一次性驗證）
 *
 * 用途：確認 GitHub Actions / 本機環境的 SMTP 設定真的能把信寄出去。
 * 與 trigger_swap.cjs / bidding-plates-sync.cjs 使用完全相同的 SMTP 設定。
 *
 * 用法：
 *   node test-email.cjs you@example.com
 *   （未帶收件人時，預設寄給 SMTP_USER 自己）
 *
 * 需要的環境變數（與通知爬蟲相同）：
 *   SMTP_USER (必填)  SMTP_PASS (必填)
 *   SMTP_HOST (預設 smtp.gmail.com)  SMTP_PORT (預設 465)
 *   SMTP_SECURE (預設 true；設 'false' 改用 STARTTLS)
 *   EMAIL_FROM_NAME (預設 'Tesla Studio')
 */

const fs = require('fs');
const dotenv = require('dotenv');

const envPath = fs.existsSync('.env.development') ? '.env.development' : '.env';
dotenv.config({ path: envPath });

async function main() {
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;

  if (!smtpUser || !smtpPass) {
    console.error('❌ 缺少 SMTP_USER / SMTP_PASS，無法測試寄信。');
    console.error('   請在 .env / .env.development 或環境變數設定後再試。');
    process.exit(1);
  }

  const to = process.argv[2] || smtpUser;
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = parseInt(process.env.SMTP_PORT || '465');
  const secure = process.env.SMTP_SECURE !== 'false';
  const fromName = process.env.EMAIL_FROM_NAME || 'Tesla Studio';

  console.log('📮 SMTP 設定：');
  console.log(`   host=${host} port=${port} secure=${secure}`);
  console.log(`   user=${smtpUser}`);
  console.log(`   收件人=${to}`);

  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user: smtpUser, pass: smtpPass }
  });

  try {
    console.log('🔌 驗證 SMTP 連線中...');
    await transporter.verify();
    console.log('✅ SMTP 連線/認證成功。');

    const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    const info = await transporter.sendMail({
      from: `"${fromName}" <${smtpUser}>`,
      to,
      subject: '[Tesla Studio] SMTP 寄信測試',
      html: `
        <div style="font-family: sans-serif; padding: 20px; max-width: 600px; border: 1px solid #eee; border-radius: 8px;">
          <h2 style="color: #e82127;">Tesla Studio - SMTP 測試成功 ✅</h2>
          <p>這是一封測試信。如果你收到它，代表選號助手的 Email 通知設定正常運作。</p>
          <p style="color: #666;">寄出時間：${now}（台灣時間）</p>
          <p style="color: #666;">寄件主機：${host}:${port}（secure=${secure}）</p>
        </div>
      `
    });

    console.log(`✅ 測試信已寄出。messageId=${info.messageId}`);
    console.log(`   請至 ${to} 收件匣（含垃圾信匣）確認。`);
    process.exit(0);
  } catch (err) {
    console.error('❌ 寄信失敗：', err.message);
    console.error('   常見原因：Gmail 需使用「應用程式密碼」而非帳號密碼；或 port/secure 設定不符。');
    process.exit(1);
  }
}

main();
