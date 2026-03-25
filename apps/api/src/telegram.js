import { startShopping, ensureHouseholdByChatId, upsertItem, listActiveItems, removeItemByName, removeItemById, updateItemQty } from './logic-supa.js';

const SUSPICIOUS_NAMES = new Set(['להוסיף', 'רשימה', 'פריט', 'עזרה', 'התחל', 'מחק', 'הסר', 'לשנות']);
const SUGGESTED_ITEMS = ['חלב', 'לחם', 'ביצים', 'מים', 'קפה'];

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

function normalizeCandidateName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/["'“”׳״]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function shouldConfirmItem(nameHe) {
  const normalized = normalizeCandidateName(nameHe);
  if (!normalized) return true;
  if (normalized.length <= 2) return true;
  if (/^\d+$/.test(normalized)) return true;
  if (SUSPICIOUS_NAMES.has(normalized)) return true;
  return false;
}

function groupItemsByCategory(items) {
  const map = new Map();
  for (const it of items) {
    const cat = it.category || 'כללי';
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat).push(it);
  }
  return map;
}

function buildDisplayList(items) {
  const grouped = groupItemsByCategory(items);
  const sortedCats = [...grouped.keys()].sort((a, b) => a.localeCompare(b, 'he'));
  const list = [];
  for (const cat of sortedCats) {
    const entries = grouped.get(cat) || [];
    entries.sort((a, b) => a.name_he.localeCompare(b.name_he, 'he'));
    for (const entry of entries) {
      list.push({ item: entry, category: cat });
    }
  }
  return list;
}

function buildListMessage(items) {
  if (!items.length) return 'הרשימה ריקה כרגע.';
  const display = buildDisplayList(items);
  let out = `ברשימה יש ${items.length} פריטים:\n`;
  display.forEach(({ item }, idx) => {
    const qty = item.qty != null ? ` (${item.qty}${item.unit ? ` ${item.unit}` : ''})` : '';
    out += `${idx + 1}. ${item.name_he}${qty} • ${item.category || 'כללי'}\n`;
  });
  return { text: out, display };
}

function formatQty(it) {
  if (!it.qty) return '';
  return `${it.qty}${it.unit ? ` ${it.unit}` : ''}`;
}

function parseItemIndex(text) {
  const m = String(text || '').match(/פריט\s+(\d+)/im);
  if (!m) return null;
  return Number(m[1]);
}

function parseEditIntent(text) {
  const m = text.match(/^(?:\u05dc\u05e9\u05a0\u05ea|\u05e9\u05e0\u05d4|\u05e2\u05d3\u05df)\s+פריט\s+(\d+)\s+ל\s+([0-9]+(?:[.,][0-9]+)?)/i);
  if (!m) return null;
  const qty = Number(m[2].replace(',', '.'));
  return { index: Number(m[1]), qty: Number.isNaN(qty) ? null : qty };
}

function parseIndexedRemoveIntent(text) {
  const m = text.match(/^(?:\u05de\u05d7\u05e7|\u05dc\u05de\u05d7\u05e7)\s+פריט\s+(\d+)/i);
  if (!m) return null;
  return Number(m[1]);
}

function createSuggestionKeyboard(nameHe) {
  const buttons = SUGGESTED_ITEMS.map((item) => [
    { text: item, callback_data: `add_suggest:${encodeURIComponent(item)}` },
  ]);
  buttons.push([
    { text: `הוסף את "${nameHe}" בכל זאת`, callback_data: `confirm_item:${encodeURIComponent(nameHe)}` },
  ]);
  return buttons;
}

async function addItemByName({ householdId, nameHe, qty, token, chatId }) {
  const row = await upsertItem({ householdId, nameHe, qty: typeof qty === 'number' ? qty : null });
  const summary = `הוספתי: ${row.name_he}${formatQty(row) ? ` (${formatQty(row)})` : ''} ✅`;
  await telegramSendMessage({ token, chatId, text: summary });
  return row;
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
  try {
    return await telegramApi(token, 'sendMessage', payload);
  } catch (error) {
    console.error('telegram send failed', error);
    return { ok: false, error: String(error) };
  }
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
  try {
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

    if (data.startsWith('add_suggest:') || data.startsWith('confirm_item:')) {
      const [cmd, payload] = data.split(':');
      const nameHe = decodeURIComponent(payload);
      const household = await ensureHouseholdByChatId(chatId, 'רשימת קניות');
      await addItemByName({ householdId: household.id, nameHe, qty: null, token: botToken, chatId });
      await telegramApi(botToken, 'answerCallbackQuery', {
        callback_query_id: cq.id,
        text: 'הוספתי את הפריט.',
        show_alert: false,
      });
      return { ok: true, action: 'suggested_add' };
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
- לשנות פריט 1 ל3 יחידות

דוגמאות:
- להוסיף חלב
- להוסיף חלב, ביצים
- 2 חלב
- מחק פריט 1`,
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

  const removeIndex = parseIndexedRemoveIntent(text);
  if (removeIndex) {
    const items = await listActiveItems(household.id);
    const display = buildDisplayList(items);
    const target = display[removeIndex - 1]?.item;
    if (!target) {
      await telegramSendMessage({ token: botToken, chatId, text: `לא מצאתי פריט מספר ${removeIndex}.` });
      return { ok: true, action: 'remove_index_failed' };
    }
    await removeItemById({ householdId: household.id, itemId: target.id });
    await telegramSendMessage({ token: botToken, chatId, text: `הסרתי פריט ${removeIndex}: ${target.name_he} ✅` });
    return { ok: true, action: 'remove_index' };
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
    const { text: listText } = buildListMessage(items);
    await telegramSendMessage({ token: botToken, chatId, text: listText });
    return { ok: true, action: 'list' };
  }

  const editIntent = parseEditIntent(text);
  if (editIntent) {
    const items = await listActiveItems(household.id);
    const display = buildDisplayList(items);
    const target = display[editIntent.index - 1]?.item;
    if (!target) {
      await telegramSendMessage({ token: botToken, chatId, text: `לא מצאתי פריט מספר ${editIntent.index}.` });
      return { ok: true, action: 'edit_failed' };
    }
    if (editIntent.qty === null) {
      await telegramSendMessage({ token: botToken, chatId, text: 'לא הבנתי את הכמות החדשה.' });
      return { ok: true, action: 'edit_failed' };
    }
    const row = await updateItemQty({ householdId: household.id, itemId: target.id, qty: editIntent.qty });
    await telegramSendMessage({
      token: botToken,
      chatId,
      text: `עדכנתי את פריט ${editIntent.index} (${row.name_he}) לכמות ${formatQty(row)}.`,
    });
    return { ok: true, action: 'edit', itemId: target.id };
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
  if (!toAdd.length) {
    await telegramSendMessage({ token: botToken, chatId, text: 'לא זיהיתי פריט מוסכם. נסה שוב.' });
    return { ok: true, action: 'add_failed' };
  }

  const suspicious = toAdd.find((it) => shouldConfirmItem(it.nameHe));
  if (suspicious) {
    await telegramSendMessage({
      token: botToken,
      chatId,
      text: `הפריט "${suspicious.nameHe}" לא נראה כמו מוצר של ממש. רוצה להוסיף אחד מההצעות או לאשר את השם הזה?`,
      replyMarkup: { inline_keyboard: createSuggestionKeyboard(suspicious.nameHe) },
    });
    return { ok: true, action: 'confirm_add' };
  }

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
      ? `הוספתי: ${added[0].name_he}${formatQty(added[0]) ? ` (${formatQty(added[0])})` : ''} ✅`
      : `הוספתי ${added.length} פריטים ✅`;

  await telegramSendMessage({ token: botToken, chatId, text: summary });
  return { ok: true, action: 'add', count: added.length };
  } catch (error) {
    console.error('handleTelegramUpdate error', error);
    return { ok: false, error: String(error) };
  }
}
