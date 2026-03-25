import { nanoid } from 'nanoid';
import { supabase } from './supabase.js';

const DEFAULT_CATEGORIES = [
  { name: 'ירקות ופירות', keywords: ['עגבנ', 'מלפפ', 'בננ', 'תפוח', 'אגס', 'ענב', 'חסה', 'גזר', 'בצל', 'שום', 'פלפל'] },
  { name: 'מוצרי חלב', keywords: ['חלב', 'קוטג', 'גבינ', 'יוגורט', 'שמנת', 'חמאה'] },
  { name: 'מאפיה ולחם', keywords: ['לחם', 'לחמני', 'פיתה', 'בגט', 'עוגה', 'עוגיות'] },
  { name: 'בשר/עוף/דגים', keywords: ['עוף', 'בשר', 'דג', 'טונה', 'שניצל'] },
  { name: 'שתייה', keywords: ['מים', 'קולה', 'ספרייט', 'מיץ', 'סודה', 'בירה', 'יין'] },
  { name: 'ניקיון', keywords: ['אקונומיקה', 'נייר', 'סבון', 'שמפו', 'מרכך', 'ספוג', 'ניקוי'] },
  { name: 'פארם וטואלטיקה', keywords: ['משחה', 'דאודורנט', 'קרם', 'תרופה', 'ויטמין'] },
  { name: 'מזווה', keywords: ['אורז', 'פסטה', 'קמח', 'שמן', 'סוכר', 'מלח', 'קפה', 'תה', 'קורנפלקס'] },
];

function normalizeName(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/["'“”׳״]/g, '')
    .replace(/\s+/g, ' ');
}

function guessCategory(nameHe) {
  const n = normalizeName(nameHe);
  for (const c of DEFAULT_CATEGORIES) {
    if (c.keywords.some((k) => n.includes(normalizeName(k)))) return c.name;
  }
  return 'כללי';
}

export async function ensureHouseholdByChatId(telegramChatId, name = null) {
  const { data: existing, error } = await supabase
    .from('households')
    .select('*')
    .eq('telegram_chat_id', String(telegramChatId))
    .maybeSingle();

  if (error) throw error;
  if (existing) return existing;

  const { data, error: insErr } = await supabase
    .from('households')
    .insert({ telegram_chat_id: String(telegramChatId), name })
    .select('*')
    .single();

  if (insErr) throw insErr;
  return data;
}

export async function listActiveItems(householdId) {
  const { data, error } = await supabase
    .from('items')
    .select('*')
    .eq('household_id', householdId)
    .eq('active', true)
    .order('created_at', { ascending: true })
    .order('category', { ascending: true })
    .order('name_he', { ascending: true });
  if (error) throw error;
  return data;
}

export async function removeItemByName({ householdId, nameHe }) {
  const norm = normalizeName(nameHe);

  const { data: row, error: selErr } = await supabase
    .from('items')
    .select('*')
    .eq('household_id', householdId)
    .eq('normalized_name', norm)
    .eq('active', true)
    .maybeSingle();
  if (selErr) throw selErr;
  if (!row) return { removed: false };

  const { error: updErr } = await supabase
    .from('items')
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq('id', row.id);
  if (updErr) throw updErr;

  return { removed: true, item: row };
}

export async function removeItemById({ householdId, itemId }) {
  const { data: row, error: selErr } = await supabase
    .from('items')
    .select('*')
    .eq('household_id', householdId)
    .eq('id', itemId)
    .eq('active', true)
    .maybeSingle();
  if (selErr) throw selErr;
  if (!row) return { removed: false };

  const { error: updErr } = await supabase
    .from('items')
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq('id', row.id);
  if (updErr) throw updErr;

  return { removed: true, item: row };
}

export async function upsertItem({ householdId, nameHe, qty = null, unit = null }) {
  const norm = normalizeName(nameHe);

  const { data: existing, error: selErr } = await supabase
    .from('items')
    .select('*')
    .eq('household_id', householdId)
    .eq('normalized_name', norm)
    .eq('active', true)
    .maybeSingle();
  if (selErr) throw selErr;

  if (existing) {
    const existingQty = existing.qty == null ? null : Number(existing.qty);
    const nextQty =
      typeof qty === 'number' && Number.isFinite(qty)
        ? Number.isFinite(existingQty)
          ? existingQty + qty
          : qty
        : existing.qty;

    const { data: upd, error: updErr } = await supabase
      .from('items')
      .update({ qty: nextQty, unit: unit ?? existing.unit, updated_at: new Date().toISOString() })
      .eq('id', existing.id)
      .select('*')
      .single();
    if (updErr) throw updErr;
    return upd;
  }

  const category = guessCategory(nameHe);
  const { data, error } = await supabase
    .from('items')
    .insert({
      household_id: householdId,
      name_he: nameHe.trim(),
      normalized_name: norm,
      category,
      qty,
      unit,
      active: true,
      updated_at: new Date().toISOString(),
    })
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

export async function startShopping({ householdId, expiresHours = 12 }) {
  const { data: trip, error: tripErr } = await supabase
    .from('shopping_trips')
    .insert({ household_id: householdId, status: 'ACTIVE' })
    .select('*')
    .single();
  if (tripErr) throw tripErr;

  const token = nanoid(32);
  const expiresAt = new Date(Date.now() + expiresHours * 3600 * 1000).toISOString();

  const { error: sessErr } = await supabase
    .from('shopping_sessions')
    .insert({ token, household_id: householdId, trip_id: trip.id, expires_at: expiresAt });
  if (sessErr) throw sessErr;

  return { token, tripId: trip.id, expiresAt };
}

export async function updateItemQty({ householdId, itemId, qty }) {
  const { data, error } = await supabase
    .from('items')
    .update({ qty, updated_at: new Date().toISOString() })
    .eq('household_id', householdId)
    .eq('id', itemId)
    .eq('active', true)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function getSession(token) {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from('shopping_sessions')
    .select('*')
    .eq('token', token)
    .is('revoked_at', null)
    .gt('expires_at', nowIso)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function getTrip(tripId) {
  const { data, error } = await supabase.from('shopping_trips').select('*').eq('id', tripId).single();
  if (error) throw error;
  return data;
}

export async function listCart(tripId) {
  const { data, error } = await supabase.from('cart_entries').select('*').eq('trip_id', tripId);
  if (error) throw error;
  return data;
}

export async function setStore({ tripId, store_name, store_branch = null, city = null }) {
  const { data, error } = await supabase
    .from('shopping_trips')
    .update({ store_name, store_branch, city })
    .eq('id', tripId)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function setCartEntry({ tripId, itemId, in_cart, price = null, qty_bought = null, note = null }) {
  const payload = {
    trip_id: tripId,
    item_id: itemId,
    in_cart: Boolean(in_cart),
    price,
    qty_bought,
    note,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase.from('cart_entries').upsert(payload, { onConflict: 'trip_id,item_id' });
  if (error) throw error;
}

export async function resetHouseholdFull({ householdId }) {
  // Deletes everything for a household (items, trips, cart entries, purchases, sessions)
  // NOTE: tables have FK cascade for household->items/trips/sessions, and trip->cart/purchases.
  const { error } = await supabase.from('households').delete().eq('id', householdId);
  if (error) throw error;
}

export async function finishTrip({ tripId }) {
  const trip = await getTrip(tripId);
  if (trip.status !== 'ACTIVE') return { ok: false, error: 'trip_not_active' };

  const { data: rows, error } = await supabase
    .from('cart_entries')
    .select('item_id, price, qty_bought, note, items(name_he, category)')
    .eq('trip_id', tripId)
    .eq('in_cart', true);
  if (error) throw error;

  const purchased = rows || [];

  for (const r of purchased) {
    const snap = r.items || {};
    await supabase.from('purchases').insert({
      trip_id: tripId,
      item_name_he: snap.name_he || 'פריט',
      category: snap.category || 'כללי',
      price: r.price ?? null,
      qty_bought: r.qty_bought ?? null,
    });

    await supabase.from('items').update({ active: false, updated_at: new Date().toISOString() }).eq('id', r.item_id);
  }

  await supabase
    .from('shopping_trips')
    .update({ status: 'FINISHED', finished_at: new Date().toISOString() })
    .eq('id', tripId);

  return { ok: true, purchasedCount: purchased.length };
}
