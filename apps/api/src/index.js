import express from 'express';
import cors from 'cors';
import {
  ensureHouseholdByChatId,
  listActiveItems,
  upsertItem,
  startShopping,
  getSession,
  setStore,
  setCartEntry,
  finishTrip,
} from './logic.js';
import { handleTelegramUpdate } from './telegram.js';
import { db } from './db.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = Number(process.env.PORT || 8787);
const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || 'http://127.0.0.1:8788').trim();

// Hard lock to one Telegram group for v1
const ALLOWED_CHAT_ID = String(process.env.TELEGRAM_SHOPPING_CHAT_ID || '').trim();

function requireAllowedChatId(req, res, next) {
  const chatId = String(req.headers['x-telegram-chat-id'] || '').trim();
  if (!ALLOWED_CHAT_ID) return res.status(500).json({ error: 'missing TELEGRAM_SHOPPING_CHAT_ID' });
  if (!chatId || chatId !== ALLOWED_CHAT_ID) return res.status(403).json({ error: 'forbidden_chat', chatId });
  next();
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/integrations/telegram/webhook', async (req, res) => {
  try {
    if (!TELEGRAM_BOT_TOKEN) return res.status(500).json({ error: 'missing TELEGRAM_BOT_TOKEN' });
    const update = req.body;
    const out = await handleTelegramUpdate({
      update,
      botToken: TELEGRAM_BOT_TOKEN,
      allowedChatId: ALLOWED_CHAT_ID,
      publicBaseUrl: PUBLIC_BASE_URL,
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// API for bot/bridge
app.post('/api/items', requireAllowedChatId, (req, res) => {
  const { nameHe, qty, unit } = req.body || {};
  if (!nameHe || typeof nameHe !== 'string') return res.status(400).json({ error: 'nameHe_required' });

  const household = ensureHouseholdByChatId(ALLOWED_CHAT_ID, 'רשימת קניות');
  const item = upsertItem({ householdId: household.id, nameHe, qty: typeof qty === 'number' ? qty : null, unit: unit || null });
  res.json({ ok: true, item, items: listActiveItems(household.id) });
});

app.get('/api/items', requireAllowedChatId, (req, res) => {
  const household = ensureHouseholdByChatId(ALLOWED_CHAT_ID, 'רשימת קניות');
  res.json({ ok: true, items: listActiveItems(household.id) });
});

app.post('/api/shopping/start', requireAllowedChatId, (req, res) => {
  const household = ensureHouseholdByChatId(ALLOWED_CHAT_ID, 'רשימת קניות');
  const sess = startShopping({ householdId: household.id, expiresHours: 12 });
  res.json({ ok: true, ...sess });
});

app.get('/api/shopping/session/:token', (req, res) => {
  const token = String(req.params.token || '');
  const s = getSession(token);
  if (!s) return res.status(404).json({ error: 'invalid_session' });

  const trip = db.prepare('SELECT * FROM shopping_trips WHERE id=?').get(s.trip_id);
  const items = listActiveItems(s.household_id);
  const cart = db.prepare('SELECT * FROM cart_entries WHERE trip_id=?').all(s.trip_id);

  res.json({ ok: true, session: s, trip, items, cart });
});

app.post('/api/shopping/trip/:tripId/store', (req, res) => {
  const tripId = String(req.params.tripId);
  const { store_name, store_branch, city } = req.body || {};
  if (!store_name) return res.status(400).json({ error: 'store_name_required' });
  const trip = setStore({ tripId, store_name, store_branch, city });
  res.json({ ok: true, trip });
});

app.post('/api/shopping/trip/:tripId/cart/:itemId', (req, res) => {
  const tripId = String(req.params.tripId);
  const itemId = String(req.params.itemId);
  const { in_cart, price, qty_bought, note } = req.body || {};
  setCartEntry({ tripId, itemId, in_cart: Boolean(in_cart), price: price ?? null, qty_bought: qty_bought ?? null, note: note ?? null });
  res.json({ ok: true });
});

app.post('/api/shopping/trip/:tripId/finish', (req, res) => {
  const tripId = String(req.params.tripId);
  const out = finishTrip({ tripId });
  res.json(out);
});

app.listen(PORT, () => {
  console.log(`[api] listening on http://127.0.0.1:${PORT}`);
});
