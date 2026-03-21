#!/usr/bin/env node
// Simple CLI to interact with the deployed API (for OpenClaw group automation)
// Usage:
//   node tools/cli.js list
//   node tools/cli.js add "חלב"
//   node tools/cli.js start

const API = process.env.SHOPPING_API_BASE || 'https://shopping-list-he-api.vercel.app';
const CHAT = process.env.TELEGRAM_SHOPPING_CHAT_ID || '-5284617579';

async function main() {
  const cmd = process.argv[2];
  const arg = process.argv.slice(3).join(' ');

  const headers = { 'Content-Type': 'application/json', 'x-telegram-chat-id': CHAT };

  if (cmd === 'list') {
    const r = await fetch(`${API}/api/items`, { headers });
    const j = await r.json();
    console.log(JSON.stringify(j, null, 2));
    return;
  }

  if (cmd === 'add') {
    const r = await fetch(`${API}/api/items`, { method: 'POST', headers, body: JSON.stringify({ nameHe: arg }) });
    const j = await r.json();
    console.log(JSON.stringify(j, null, 2));
    return;
  }

  if (cmd === 'start') {
    const r = await fetch(`${API}/api/shopping/start`, { method: 'POST', headers, body: '{}' });
    const j = await r.json();
    console.log(JSON.stringify(j, null, 2));
    return;
  }

  console.error('Unknown cmd. Use: list | add <name> | start');
  process.exit(2);
}

main().catch((e) => {
  console.error(String(e?.message || e));
  process.exit(1);
});
