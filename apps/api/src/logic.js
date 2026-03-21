import { nanoid } from 'nanoid';
import { db } from './db.js';

export const DEFAULT_CATEGORIES = [
  { name: 'ירקות ופירות', keywords: ['עגבנ', 'מלפפ', 'בננ', 'תפוח', 'אגס', 'ענב', 'חסה', 'גזר', 'בצל', 'שום', 'פלפל'] },
  { name: 'מוצרי חלב', keywords: ['חלב', 'קוטג', 'גבינ', 'יוגורט', 'שמנת', 'חמאה'] },
  { name: 'מאפיה ולחם', keywords: ['לחם', 'לחמני', 'פיתה', 'בגט', 'עוגה', 'עוגיות'] },
  { name: 'בשר/עוף/דגים', keywords: ['עוף', 'בשר', 'דג', 'טונה', 'שניצל'] },
  { name: 'שתייה', keywords: ['מים', 'קולה', 'ספרייט', 'מיץ', 'סודה', 'בירה', 'יין'] },
  { name: 'ניקיון', keywords: ['אקונומיקה', 'נייר', 'סבון', 'שמפו', 'מרכך', 'ספוג', 'ניקוי'] },
  { name: 'פארם וטואלטיקה', keywords: ['משחה', 'דאודורנט', 'קרם', 'תרופה', 'ויטמין', 'קונדום'] },
  { name: 'מזווה', keywords: ['אורז', 'פסטה', 'קמח', 'שמן', 'סוכר', 'מלח', 'קפה', 'תה', 'קורנפלקס'] }
];

export function normalizeName(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/["'“”׳״]/g, '')
    .replace(/\s+/g, ' ');
}

export function guessCategory(nameHe) {
  const n = normalizeName(nameHe);
  for (const c of DEFAULT_CATEGORIES) {
    if (c.keywords.some((k) => n.includes(normalizeName(k)))) return c.name;
  }
  return 'כללי';
}

export function ensureHouseholdByChatId(telegramChatId, name = null) {
  const now = Date.now();
  const existing = db.prepare('SELECT * FROM households WHERE telegram_chat_id = ?').get(String(telegramChatId));
  if (existing) return existing;
  const id = nanoid();
  db.prepare('INSERT INTO households (id, telegram_chat_id, name, created_at) VALUES (?,?,?,?)')
    .run(id, String(telegramChatId), name, now);
  return db.prepare('SELECT * FROM households WHERE id = ?').get(id);
}

export function listActiveItems(householdId) {
  return db.prepare('SELECT * FROM items WHERE household_id = ? AND active = 1 ORDER BY category, name_he').all(householdId);
}

export function upsertItem({ householdId, nameHe, qty = null, unit = null }) {
  const now = Date.now();
  const norm = normalizeName(nameHe);
  const existing = db.prepare('SELECT * FROM items WHERE household_id = ? AND normalized_name = ? AND active = 1').get(householdId, norm);
  if (existing) {
    const nextQty = (typeof qty === 'number' && !Number.isNaN(qty))
      ? ((typeof existing.qty === 'number' ? existing.qty : Number(existing.qty) || 0) + qty)
      : existing.qty;
    db.prepare('UPDATE items SET qty = ?, unit = COALESCE(?, unit), updated_at = ? WHERE id = ?')
      .run(nextQty, unit, now, existing.id);
    return db.prepare('SELECT * FROM items WHERE id = ?').get(existing.id);
  }

  const id = nanoid();
  const category = guessCategory(nameHe);
  db.prepare(`INSERT INTO items (id, household_id, name_he, normalized_name, category, qty, unit, active, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, householdId, nameHe.trim(), norm, category, qty, unit, 1, now, now);
  return db.prepare('SELECT * FROM items WHERE id = ?').get(id);
}

export function startShopping({ householdId, expiresHours = 12 }) {
  const now = Date.now();
  const tripId = nanoid();
  db.prepare('INSERT INTO shopping_trips (id, household_id, status, started_at) VALUES (?,?,?,?)')
    .run(tripId, householdId, 'ACTIVE', now);

  const token = nanoid(32);
  const expiresAt = now + expiresHours * 3600 * 1000;
  db.prepare('INSERT INTO shopping_sessions (token, household_id, trip_id, expires_at, created_at) VALUES (?,?,?,?,?)')
    .run(token, householdId, tripId, expiresAt, now);

  return { token, tripId, expiresAt };
}

export function getSession(token) {
  const now = Date.now();
  const s = db.prepare('SELECT * FROM shopping_sessions WHERE token = ? AND revoked_at IS NULL').get(token);
  if (!s) return null;
  if (Number(s.expires_at) < now) return null;
  return s;
}

export function setStore({ tripId, store_name, store_branch = null, city = null }) {
  db.prepare('UPDATE shopping_trips SET store_name=?, store_branch=?, city=? WHERE id=?')
    .run(store_name || null, store_branch || null, city || null, tripId);
  return db.prepare('SELECT * FROM shopping_trips WHERE id=?').get(tripId);
}

export function setCartEntry({ tripId, itemId, in_cart, price = null, qty_bought = null, note = null }) {
  const now = Date.now();
  const existing = db.prepare('SELECT * FROM cart_entries WHERE trip_id=? AND item_id=?').get(tripId, itemId);
  if (existing) {
    db.prepare('UPDATE cart_entries SET in_cart=?, price=?, qty_bought=?, note=?, updated_at=? WHERE id=?')
      .run(in_cart ? 1 : 0, price, qty_bought, note, now, existing.id);
  } else {
    db.prepare('INSERT INTO cart_entries (id, trip_id, item_id, in_cart, price, qty_bought, note, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(nanoid(), tripId, itemId, in_cart ? 1 : 0, price, qty_bought, note, now);
  }
}

export function finishTrip({ tripId }) {
  const now = Date.now();
  const trip = db.prepare('SELECT * FROM shopping_trips WHERE id=?').get(tripId);
  if (!trip || trip.status !== 'ACTIVE') {
    return { ok: false, error: 'trip_not_active' };
  }

  const inCart = db.prepare('SELECT ce.*, i.name_he, i.category FROM cart_entries ce JOIN items i ON i.id = ce.item_id WHERE ce.trip_id=? AND ce.in_cart=1').all(tripId);

  const insertPurchase = db.prepare('INSERT INTO purchases (id, trip_id, item_name_he, category, price, qty_bought, created_at) VALUES (?,?,?,?,?,?,?)');
  const deactivateItem = db.prepare('UPDATE items SET active=0, updated_at=? WHERE id=?');

  const tx = db.transaction(() => {
    for (const row of inCart) {
      insertPurchase.run(nanoid(), tripId, row.name_he, row.category, row.price ?? null, row.qty_bought ?? null, now);
      deactivateItem.run(now, row.item_id);
    }
    db.prepare('UPDATE shopping_trips SET status=?, finished_at=? WHERE id=?').run('FINISHED', now, tripId);
  });
  tx();

  return { ok: true, purchasedCount: inCart.length };
}
