import { startShopping, ensureHouseholdByChatId, upsertItem, listActiveItems, removeItemByName, removeItemById } from './logic-supa.js';

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

async function telegramApi(token, method, payload) {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Telegram ${method} failed: ${res.status} ${t}`);
  }
  return res.json();
}

export async function telegramSendMessage({ token, chatId, text, replyMarkup = null }) {
  const payload = { chat_id: chatId, text, disable_web_page_preview: true };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return telegramApi(token, 'sendMessage', payload);
}

function isExplicitAddIntent(text) {
  const t = String(text || '').trim();
  return (
    t.startsWith('להוסיף ') ||
    t.startsWith('/הוסף ') ||
    t.startsWith('+') ||
    /\n|,/.test(t) ||
    /^([0-9]+(?:\.[0-9]+)?)\s+.+$/.test(t) ||
    /^.+\s+([0-9]+(?:\.[0-9]+)?)$/.test(t)
  );
}

function normalizeAddText(text) {
  let t = String(text || '').trim();
  if (t.startsWith('להוסיף ')) t = t.replace(/^להוסיף\s+/, '');
  if (t.startsWith('/הוסף ')) t = t.replace(/^\/הוסף\s+/, '');
  if (t.startsWith('+')) t = t.slice(1).trim();
  return t;
}

function parseRemoveIntent(text) {
  const t = String(text || '').trim();
  const patterns = [/^מחק\s+(.+)$/u, /^להוריד\s+(.+)$/u, /^הסר\s+(.+)$/u, /^\/מחק\s+(.+)$/u, /^-\s*(.+)$/u];
  for (const p of patterns) {
    const m = t.match(p);
    if (m) return m[1].trim();
  }
  return '';
}

export async function handleTelegramUpdate({ update, botToken, allowedChatId, publicBaseUrl }) {
  // Inline button callback: remove by item id
  if (update?.callback_query) {
    const cq = update.callback_query;
    const chatId = String(cq.message?.chat?.id || '');
    if (String(allowedChatId) !== chatId) return { ok: true, ignored: true };

    const data = String(cq.data || '');
    if (data.startsWith('remove_item:')) {
      const itemId = data.split(':')[1];
      const household = await ensureHouseholdByChatId(chatId, 'רשימת קניות');
      const out = await removeItemById({ householdId: household.id, itemId });

      await telegramApi(botToken, 'answerCallbackQuery', {
        callback_query_id: cq.id,
        text: out.removed ? 'הוסר מהרשימה ✅' : 'לא נמצא ברשימה',
        show_alert: false,
      });

      if (out.removed) {
        await telegramSendMessage({ token: botToken, chatId, text: `הסרתי מהרשימה: ${out.item.name_he} ✅` });
      }
      return { ok: true, action: 'remove_callback', removed: out.removed };
    }

    await telegramApi(botToken, 'answerCallbackQuery', {
      callback_query_id: cq.id,
      text: 'פעולה לא נתמכת',
      show_alert: false,
    });
    return { ok: true, ignored: true };
  }

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

  if (text === 'עזרה' || text === '/עזרה') {
    await telegramSendMessage({
      token: botToken,
      chatId,
      text:
`פקודות זמינות:
- רשימה
- התחל קניות
- להוסיף <פריט>
- מחק <פריט>

דוגמאות:
- להוסיף חלב
- להוסיף חלב, ביצים
- 2 חלב
- מחק חלב`,
    });
    return { ok: true, action: 'help' };
  }

  if (text === 'מחק' || text === '/מחק' || text === 'להוריד' || text === 'הסר') {
    const items = await listActiveItems(household.id);
    if (!items.length) {
      await telegramSendMessage({ token: botToken, chatId, text: 'הרשימה ריקה כרגע.' });
      return { ok: true, action: 'remove_menu_empty' };
    }

    const buttons = items.slice(0, 20).map((it) => [{ text: `🗑️ ${it.name_he}`, callback_data: `remove_item:${it.id}` }]);
    await telegramSendMessage({
      token: botToken,
      chatId,
      text: 'מה להסיר מהרשימה?',
      replyMarkup: { inline_keyboard: buttons },
    });
    return { ok: true, action: 'remove_menu' };
  }

  const removeName = parseRemoveIntent(text);
  if (removeName) {
    const out = await removeItemByName({ householdId: household.id, nameHe: removeName });
    if (out.removed) {
      await telegramSendMessage({ token: botToken, chatId, text: `הסרתי מהרשימה: ${removeName} ✅` });
      return { ok: true, action: 'remove', removed: true };
    }
    await telegramSendMessage({ token: botToken, chatId, text: `לא מצאתי ברשימה: ${removeName}` });
    return { ok: true, action: 'remove', removed: false };
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

  if (!isExplicitAddIntent(text)) {
    await telegramSendMessage({
      token: botToken,
      chatId,
      text: 'כדי להוסיף לרשימה כתבו: "להוסיף <פריט>" (לדוגמה: להוסיף חלב)\nלעזרה: עזרה',
    });
    return { ok: true, action: 'ignored_non_add' };
  }

  const toAdd = parseItemsFromText(normalizeAddText(text));
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
