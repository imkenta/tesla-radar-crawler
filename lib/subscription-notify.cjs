// 車牌號碼訂閱 — 定期掃描通知（爬蟲端共用模組）
//
// 與「我的收藏」通知不同：這是針對使用者登記的「想要號碼」(plate_subscriptions)，
// 每次同步後比對 available_plates / bidding_plates，符合的完整車牌出現即 Email 通知，每張牌一次。
//
// 比對與去重一律委派 SQL RPC `claim_plate_subscription_matches(null)`（與前端 Edge Function 共用同一份真理）：
// RPC 內以 INSERT ... ON CONFLICT DO NOTHING RETURNING 原子認領「這次第一次命中」的列。
//
// 寄信失敗 → 回滾本批已認領的日誌列，下次同步重試（at-least-once，寧可極少數重送也不漏送）。
//
// 用法：
//   const { processPlateSubscriptions } = require('./lib/subscription-notify.cjs')
//   await processPlateSubscriptions({ supabase, sendEmail })   // sendEmail: (to, subject, html) => Promise<boolean>

const SITE_URL = 'https://teslastudio.netlify.app';

function plateNumberPart(plateNo) {
  const parts = String(plateNo).split('-');
  return parts.length > 1 ? parts[1] : String(plateNo);
}

function deepLink(plateNo) {
  return `${SITE_URL}/?mode=plate-picker&pp_n=${encodeURIComponent(plateNumberPart(plateNo))}&pp_mode=end`;
}

function buildHtml(matches) {
  const rows = matches.map((m) => {
    const where = m.station_name || (m.station_id ? `監理站代碼 ${m.station_id}` : '監理站');
    const priceLabel = m.source === 'bidding' ? '目前出價' : '選號價格';
    const price = (m.price !== null && m.price !== undefined) ? `NT$ ${Number(m.price).toLocaleString()}` : '—';
    const tag = m.source === 'bidding'
      ? '<span style="background:#7c3aed;color:#fff;font-size:11px;padding:2px 8px;border-radius:6px;margin-left:8px;">標牌競標</span>'
      : '<span style="background:#16a34a;color:#fff;font-size:11px;padding:2px 8px;border-radius:6px;margin-left:8px;">現貨</span>';
    return `
      <tr>
        <td style="padding:14px 12px;border:1px solid #eee;">
          <a href="${deepLink(m.matched_plate_no)}" style="font-size:1.25em;font-weight:800;color:#111;font-family:monospace;text-decoration:none;">${m.matched_plate_no}</a>${tag}
          <div style="font-size:12px;color:#888;margin-top:4px;">您訂閱的號碼：<strong>${m.number}</strong></div>
        </td>
        <td style="padding:14px 12px;border:1px solid #eee;color:#444;">${where}</td>
        <td style="padding:14px 12px;border:1px solid #eee;white-space:nowrap;color:#444;"><span style="font-size:11px;color:#999;">${priceLabel}</span><br/><strong>${price}</strong></td>
      </tr>`;
  }).join('');

  return `
    <div style="font-family: sans-serif; padding: 20px; max-width: 640px; border: 1px solid #eee; border-radius: 8px;">
      <h2 style="color: #e82127; margin-bottom: 8px;">Tesla Studio - 您訂閱的車號出現了！</h2>
      <p style="color:#555;margin-top:0;">以下符合您訂閱號碼的車牌剛出現在選號／標牌清單中。點擊號碼即可前往選號助手，並可加入「我的收藏」持續追蹤。</p>
      <table style="width:100%;border-collapse:collapse;margin:18px 0;">
        <thead>
          <tr style="background:#f9f9f9;">
            <th style="padding:10px 12px;border:1px solid #eee;text-align:left;font-size:13px;color:#666;">號牌號碼</th>
            <th style="padding:10px 12px;border:1px solid #eee;text-align:left;font-size:13px;color:#666;">所在監理站</th>
            <th style="padding:10px 12px;border:1px solid #eee;text-align:left;font-size:13px;color:#666;">參考價格</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin-top: 16px;">
        <a href="${SITE_URL}/?mode=plate-picker" style="background:#e82127;color:#fff;padding:12px 24px;text-decoration:none;border-radius:99px;font-weight:bold;display:inline-block;">前往選號助手</a>
      </p>
      <hr style="border:0;border-top:1px solid #eee;margin:28px 0;" />
      <p style="font-size: 0.8em; color: #999;">此信件為系統自動發送，請勿直接回覆。每張符合的車牌僅通知一次；若出現不同字軌的同號車牌會再次通知。如需停止訂閱，請至選號助手「號碼訂閱」面板移除。</p>
    </div>`;
}

async function processPlateSubscriptions({ supabase, sendEmail }) {
  console.log('🔔 Checking plate number subscriptions (號碼訂閱)...');
  try {
    const { data: matches, error } = await supabase.rpc('claim_plate_subscription_matches', { p_email: null });
    if (error) {
      console.error('[PlateSub] RPC error:', error.message);
      return;
    }
    if (!matches || matches.length === 0) {
      console.log('ℹ️ No new plate-subscription matches.');
      return;
    }

    // 依 email 聚合：同一人本批多張新命中合併成一封信
    const byEmail = new Map();
    for (const m of matches) {
      if (!byEmail.has(m.email)) byEmail.set(m.email, []);
      byEmail.get(m.email).push(m);
    }

    for (const [email, list] of byEmail.entries()) {
      const subject = `[Tesla Studio] 您訂閱的車號出現了！（${list.length} 張符合）`;
      let ok = false;
      try {
        ok = await sendEmail(email, subject, buildHtml(list));
      } catch (e) {
        console.error(`[PlateSub] sendEmail threw for ${email}:`, e.message);
        ok = false;
      }

      if (ok) {
        console.log(`📨 Notified ${email} of ${list.length} matched plate(s): ${list.map(m => m.matched_plate_no).join(', ')}`);
      } else {
        // 回滾本批已認領的日誌 → 下次同步重試（at-least-once）
        const plateNos = list.map(m => m.matched_plate_no);
        const { error: delErr } = await supabase
          .from('plate_subscription_notifications')
          .delete()
          .eq('email', email)
          .in('matched_plate_no', plateNos);
        if (delErr) {
          console.error(`[PlateSub] rollback failed for ${email}:`, delErr.message);
        } else {
          console.warn(`[PlateSub] Email to ${email} failed; rolled back ${plateNos.length} claim(s) for retry.`);
        }
      }
    }
  } catch (e) {
    console.error('[PlateSub] exception:', e.message);
  }
}

module.exports = { processPlateSubscriptions, buildHtml, deepLink, plateNumberPart };
