import { startShopping, ensureHouseholdByChatId, upsertItem, listActiveItems } from './logic-supa.js';

export function parseItemsFromText(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];

  const parts = raw
    .split(/\n|,/g)
    .map((s) => s.trim())
    .filter(Boolean);

  return parts.map((p) => {
    const m1 = p.match(/^([0-9]+(?:\.[0-9]+)?)\s+(.+)$/);
    if (m1) return { nameHe: m1[2].trim(), qty: Number(m1[1]) };
    const m2 = p.match(/^(.+?)\s+([0-9]+(?:\.[0-9]+)?)$/);
    if (m2) return { nameHe: m2[1].trim(), qty: Number(m2[2]) };
    return { nameHe: p, qty: null };
  });
}

export async function telegramSendMessage({ token, chatId, text }) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Telegram send failed: ${res.status} ${t}`);
  }
  return res.json();
}

export async function handleTelegramUpdate({ update, botToken, allowedChatId, publicBaseUrl }) {
  const msg = update?.message;
  if (!msg) return { ok: true, ignored: true };

  const chatId = String(msg.chat?.id || '');
  if (String(allowedChatId) !== chatId) return { ok: true, ignored: true };

  const text = String(msg.text || '').trim();
  if (!text) return { ok: true, ignored: true };

  const household = await ensureHouseholdByChatId(chatId, 'רשימת קניות');

  if (text === 'התחל קניות' || text === '/קניות') {
    const sess = await startShopping({ householdId: household.id, expiresHours: 12 });
    const link = `${publicBaseUrl.replace(/\/$/, '')}/shop/${sess.token}?v=live`;
    await telegramSendMessage({
      token: botToken,
      chatId,
      text: `מצב קניות הופעל ✅\n\nלינק: ${link}`,
    });
    return { ok: true, action: 'start_shopping', token: sess.token };
  }

  if (text === 'רשימה' || text === '/רשימה') {
    const items = await listActiveItems(household.id);
    const grouped = new Map();
    for (const it of items) {
      const cat = it.category || 'כללי';
      if (!grouped.has(cat)) grouped.set(cat, []);
      grouped.get(cat).push(it);
    }

    let out = `ברשימה יש ${items.length} פריטים:\n`;
    for (const [cat, its] of [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0], 'he'))) {
      out += `\n* ${cat}:\n`;
      for (const it of its.slice(0, 15)) {
        out += `- ${it.name_he}${it.qty ? ` (כמות: ${it.qty})` : ''}\n`;
      }
      if (its.length > 15) out += `- ... (+${its.length - 15})\n`;
    }

    await telegramSendMessage({ token: botToken, chatId, text: out });
    return { ok: true, action: 'list' };
  }

  const toAdd = parseItemsFromText(text);
  const added = [];
  for (const it of toAdd) {
    const row = await upsertItem({
      householdId: household.id,
      nameHe: it.nameHe,
      qty: typeof it.qty === 'number' ? it.qty : null,
    });
    added.push(row);
  }

  const summary =
    added.length === 1
      ? `הוספתי: ${added[0].name_he}${added[0].qty ? ` (כמות: ${added[0].qty})` : ''} ✅`
      : `הוספתי ${added.length} פריטים ✅`;

  await telegramSendMessage({ token: botToken, chatId, text: summary });
  return { ok: true, action: 'add', count: added.length };
}
