import { kv } from '@vercel/kv';
import { unzipSync } from 'fflate';

const BOT = process.env.TELEGRAM_BOT_TOKEN;
const API = 'https://api.vercel.com';

/* ============================================================
   TELEGRAM
   ============================================================ */
async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${BOT}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}
const reply = (chatId, text, opts = {}) =>
  tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...opts });
const editMsg = (chatId, msgId, text, opts = {}) =>
  tg('editMessageText', { chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...opts });
const answerCb = (id, text = '') => tg('answerCallbackQuery', { callback_query_id: id, text });

/* ============================================================
   VERCEL API
   ============================================================ */
async function vercelUser(token) {
  const r = await fetch(API + '/v2/user', { headers: { Authorization: 'Bearer ' + token } });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || 'Token tidak valid');
  return d.user;
}

async function uploadFile(token, name, buffer) {
  const shaBuf = await crypto.subtle.digest('SHA-1', buffer);
  const sha = Array.from(new Uint8Array(shaBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
  const r = await fetch(API + '/v2/files', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/octet-stream',
      'x-vercel-digest': sha,
    },
    body: buffer,
  });
  if (!r.ok) throw new Error('Upload gagal (' + name + '): ' + (await r.text()).slice(0, 200));
  return { file: name, sha, size: buffer.length };
}

async function deployFiles(token, projectName, files, onProgress) {
  const uploaded = [];
  for (let i = 0; i < files.length; i++) {
    uploaded.push(await uploadFile(token, files[i].name, files[i].buffer));
    onProgress?.(i + 1, files.length);
  }
  const r = await fetch(API + '/v13/deployments', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: projectName,
      target: 'production',
      files: uploaded,
      projectSettings: { framework: null },
    }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || JSON.stringify(d));
  return d;
}

async function deleteDeployment(token, id) {
  const r = await fetch(`${API}/v13/deployments/${id}`, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.error?.message || 'Gagal hapus');
  }
  return true;
}

/* ============================================================
   ZIP EXTRACT
   ============================================================ */
function extractZip(buffer) {
  const u8 = new Uint8Array(buffer);
  const entries = unzipSync(u8, {
    filter: (f) => {
      if (f.name.endsWith('/')) return false;
      if (f.name.includes('__MACOSX/')) return false;
      if (f.name.startsWith('.')) return false;
      if (f.name.includes('/._')) return false;
      return true;
    },
  });
  let files = Object.entries(entries).map(([name, data]) => ({
    name, buffer: Buffer.from(data),
  }));
  // strip common root folder
  if (files.length) {
    const names = files.map(f => f.name);
    const firsts = new Set(names.map(n => n.split('/')[0]));
    if (firsts.size === 1 && names.every(n => n.includes('/'))) {
      const root = [...firsts][0] + '/';
      files = files.map(f => ({ name: f.name.slice(root.length), buffer: f.buffer }));
    }
  }
  if (!files.length) throw new Error('ZIP kosong');
  return files;
}
const isZip = (name) => (name || '').toLowerCase().endsWith('.zip');

/* ============================================================
   MAIL.TM
   ============================================================ */
async function mailCreate() {
  const doms = await (await fetch('https://api.mail.tm/domains?page=1')).json();
  const dom = doms['hydra:member']?.[0]?.domain;
  if (!dom) throw new Error('Tidak ada domain mail');
  const addr = 'tg' + Math.random().toString(36).slice(2, 9) + '@' + dom;
  const pass = Math.random().toString(36).slice(2, 14);
  let r = await fetch('https://api.mail.tm/accounts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: addr, password: pass }),
  });
  if (!r.ok) throw new Error('Gagal buat akun: ' + (await r.text()).slice(0, 150));
  r = await fetch('https://api.mail.tm/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: addr, password: pass }),
  });
  const t = await r.json();
  if (!t.token) throw new Error('Gagal ambil token mail');
  return { addr, token: t.token };
}
async function mailInbox(token) {
  const r = await fetch('https://api.mail.tm/messages?page=1', { headers: { Authorization: 'Bearer ' + token } });
  const d = await r.json();
  return d['hydra:member'] || [];
}
async function mailRead(token, id) {
  const r = await fetch('https://api.mail.tm/messages/' + id, { headers: { Authorization: 'Bearer ' + token } });
  const m = await r.json();
  fetch('https://api.mail.tm/messages/' + id, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ seen: true }),
  }).catch(() => {});
  return m;
}

/* ============================================================
   KV HELPERS
   ============================================================ */
const KEY = {
  activeToken: (c) => `tg:${c}:activeToken`,
  accounts: (c) => `tg:${c}:accounts`,
  pending: (c) => `tg:${c}:pending`,
  history: (c) => `tg:${c}:history`,
  mailbox: (c) => `tg:${c}:mailbox`,
};
const TTL_PENDING = 600;
const TTL_MAIL = 86400;

async function getAccounts(chatId) { return (await kv.get(KEY.accounts(chatId))) || {}; }
async function saveAccount(chatId, label, token, username) {
  const acc = await getAccounts(chatId);
  acc[label] = { label, token, username };
  await kv.set(KEY.accounts(chatId), acc);
  return acc;
}
async function removeAccount(chatId, label) {
  const acc = await getAccounts(chatId);
  delete acc[label];
  await kv.set(KEY.accounts(chatId), acc);
  return acc;
}
async function getActiveToken(chatId) { return kv.get(KEY.activeToken(chatId)); }
async function setActiveToken(chatId, token) { return kv.set(KEY.activeToken(chatId), token); }
async function clearActiveToken(chatId) { return kv.del(KEY.activeToken(chatId)); }

async function getPending(chatId) { return kv.get(KEY.pending(chatId)); }
async function setPending(chatId, data) { return kv.set(KEY.pending(chatId), data, { ex: TTL_PENDING }); }
async function clearPending(chatId) { return kv.del(KEY.pending(chatId)); }

async function addHistory(chatId, item) {
  const list = (await kv.get(KEY.history(chatId))) || [];
  list.unshift(item);
  await kv.set(KEY.history(chatId), list.slice(0, 30));
}
async function getHistory(chatId) { return (await kv.get(KEY.history(chatId))) || []; }
async function clearHistory(chatId) { return kv.del(KEY.history(chatId)); }

async function getMailbox(chatId) { return kv.get(KEY.mailbox(chatId)); }
async function saveMailbox(chatId, box) { return kv.set(KEY.mailbox(chatId), box, { ex: TTL_MAIL }); }
async function clearMailbox(chatId) { return kv.del(KEY.mailbox(chatId)); }

/* ============================================================
   KEYBOARD
   ============================================================ */
const kbMain = () => ({ inline_keyboard: [
  [{ text: '🚀 Deploy', callback_data: 'menu:deploy' }, { text: '👤 Akun', callback_data: 'menu:acc' }],
  [{ text: '🗂️ Riwayat', callback_data: 'menu:hist' }, { text: '📬 Temp Mail', callback_data: 'menu:mail' }],
]});
const kbBack = () => ({ inline_keyboard: [[{ text: '⬅️ Menu', callback_data: 'menu:home' }]] });
const kbAccounts = (list, active) => {
  const rows = list.map(a => [
    { text: (a.token === active ? '✅ ' : '') + a.label + ' — ' + a.username, callback_data: `acc:use:${a.label}` },
    { text: '🗑️', callback_data: `acc:del:${a.label}` },
  ]);
  rows.push([{ text: '➕ Tambah Akun', callback_data: 'acc:add' }]);
  rows.push([{ text: '⬅️ Menu', callback_data: 'menu:home' }]);
  return { inline_keyboard: rows };
};

/* ============================================================
   HANDLER
   ============================================================ */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('ok');
  if (!BOT) return res.status(500).send('BOT token belum diset');

  const update = req.body || {};

  try {
    /* ==================== CALLBACK ==================== */
    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = cb.message.chat.id;
      const msgId = cb.message.message_id;
      const data = cb.data;
      await answerCb(cb.id);

      if (data === 'menu:home') {
        await editMsg(chatId, msgId, `<b>🤖 Bot Deploy Pro</b>\n\nPilih menu:`, { reply_markup: kbMain() });
        return res.status(200).send('ok');
      }

      if (data === 'menu:acc') {
        const acc = await getAccounts(chatId);
        const active = await getActiveToken(chatId);
        const list = Object.values(acc);
        if (!list.length) {
          await editMsg(chatId, msgId, `<b>👤 Akun Vercel</b>\n\nBelum ada.\nTambah: <code>/addacc label token</code>`, {
            reply_markup: { inline_keyboard: [[{ text: '➕ Tambah Akun', callback_data: 'acc:add' }], [{ text: '⬅️ Menu', callback_data: 'menu:home' }]] },
          });
        } else {
          await editMsg(chatId, msgId, `<b>👤 Akun Vercel</b>\nKlik untuk aktifkan:`, { reply_markup: kbAccounts(list, active) });
        }
        return res.status(200).send('ok');
      }

      if (data.startsWith('acc:use:')) {
        const label = data.slice(8);
        const acc = await getAccounts(chatId);
        if (!acc[label]) return res.status(200).send(await reply(chatId, '❌ Akun tidak ditemukan', { reply_markup: kbBack() }));
        await setActiveToken(chatId, acc[label].token);
        await editMsg(chatId, msgId, `✅ Akun aktif: <b>${label}</b>`, { reply_markup: kbAccounts(Object.values(acc), acc[label].token) });
        return res.status(200).send('ok');
      }

      if (data.startsWith('acc:del:')) {
        const label = data.slice(8);
        await removeAccount(chatId, label);
        const acc = await getAccounts(chatId);
        const active = await getActiveToken(chatId);
        const list = Object.values(acc);
        if (!list.find(a => a.token === active)) await clearActiveToken(chatId);
        await editMsg(chatId, msgId, `🗑️ Akun <b>${label}</b> dihapus.`, {
          reply_markup: list.length ? kbAccounts(list, active) : kbBack(),
        });
        return res.status(200).send('ok');
      }

      if (data === 'acc:add') {
        await reply(chatId, `➕ Kirim:\n<code>/addacc label token_vercel</code>\n\nContoh:\n<code>/addacc utama vc_xxxxx</code>`, { reply_markup: kbBack() });
        return res.status(200).send('ok');
      }

      if (data === 'menu:deploy') {
        const active = await getActiveToken(chatId);
        if (!active) {
          await editMsg(chatId, msgId, `🚀 Belum ada akun aktif.\nTambah: <code>/addacc label token</code>`, { reply_markup: kbBack() });
        } else {
          await editMsg(chatId, msgId,
            `🚀 <b>Deploy</b>\n\n` +
            `Kirim: <code>/deploy nama-project</code>\n` +
            `Lalu kirim file (dokumen biasa / .zip)`,
            { reply_markup: kbBack() });
        }
        return res.status(200).send('ok');
      }

      if (data === 'menu:hist') {
        const list = await getHistory(chatId);
        if (!list.length) {
          await editMsg(chatId, msgId, `🗂️ Belum ada riwayat.`, { reply_markup: kbBack() });
        } else {
          const lines = list.slice(0, 8).map(h => {
            const badge = h.status === 'ok' ? '✅' : '❌';
            const url = h.status === 'ok' ? `\n   https://${h.url}` : `\n   <i>${(h.error || '').slice(0, 60)}</i>`;
            const del = h.status === 'ok' ? `\n   <code>/rmdeploy ${h.id}</code>` : '';
            return `${badge} <b>${h.name}</b> (${h.files} file)\n   ${new Date(h.at).toLocaleString('id-ID')}${url}${del}`;
          }).join('\n\n');
          await editMsg(chatId, msgId, `🗂️ <b>Riwayat</b>\n\n${lines}`, {
            reply_markup: { inline_keyboard: [[{ text: '🗑️ Hapus Riwayat', callback_data: 'hist:clear' }], [{ text: '⬅️ Menu', callback_data: 'menu:home' }]] },
          });
        }
        return res.status(200).send('ok');
      }

      if (data === 'hist:clear') {
        await clearHistory(chatId);
        await editMsg(chatId, msgId, `🗑️ Riwayat dihapus.`, { reply_markup: kbBack() });
        return res.status(200).send('ok');
      }

      if (data === 'menu:mail') {
        const box = await getMailbox(chatId);
        await editMsg(chatId, msgId,
          box
            ? `📬 <b>Temp Mail</b>\n\n<code>${box.addr}</code>\n\n<code>/inbox</code> untuk cek`
            : `📬 <b>Temp Mail</b>\n\nBelum ada. Kirim <code>/mail</code>`,
          { reply_markup: { inline_keyboard: [[{ text: '⬅️ Menu', callback_data: 'menu:home' }]] } });
        return res.status(200).send('ok');
      }

      return res.status(200).send('ok');
    }

    /* ==================== MESSAGE ==================== */
    const msg = update.message;
    if (!msg) return res.status(200).send('ok');
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();

    /* /start */
    if (text === '/start' || text === '/help') {
      await reply(chatId,
        `<b>🤖 Bot Deploy Vercel + Temp Mail</b>\n\n` +
        `<b>Akun:</b>\n` +
        `<code>/addacc label token</code>\n` +
        `<code>/accounts</code> · <code>/use label</code> · <code>/delacc label</code>\n` +
        `<code>/whoami</code> · <code>/cleartoken</code>\n\n` +
        `<b>Deploy:</b>\n` +
        `<code>/deploy nama</code> → kirim file / ZIP\n` +
        `<code>/history</code> · <code>/rmdeploy id</code>\n\n` +
        `<b>Temp Mail:</b>\n` +
        `<code>/mail</code> · <code>/inbox</code> · <code>/read id</code> · <code>/delmail</code>`,
        { reply_markup: kbMain() });
      return res.status(200).send('ok');
    }

    /* /addacc */
    if (text.startsWith('/addacc')) {
      const p = text.split(/\s+/);
      const label = p[1], token = p[2];
      if (!label || !token) return res.status(200).send(await reply(chatId, 'Format: <code>/addacc label token</code>', { reply_markup: kbBack() }));
      try {
        const u = await vercelUser(token);
        await saveAccount(chatId, label, token, u.username || u.email);
        await setActiveToken(chatId, token);
        await reply(chatId, `✅ Akun <b>${label}</b> aktif\n👤 ${u.username || u.email}`, { reply_markup: kbMain() });
      } catch (e) {
        await reply(chatId, '❌ ' + e.message, { reply_markup: kbBack() });
      }
      return res.status(200).send('ok');
    }

    /* /accounts */
    if (text === '/accounts') {
      const acc = await getAccounts(chatId);
      const active = await getActiveToken(chatId);
      const list = Object.values(acc);
      if (!list.length) return res.status(200).send(await reply(chatId, 'Belum ada akun.', { reply_markup: kbBack() }));
      return res.status(200).send(await reply(chatId, '👤 <b>Akun</b>\nKlik untuk aktifkan:', { reply_markup: kbAccounts(list, active) }));
    }

    /* /use */
    if (text.startsWith('/use')) {
      const label = text.split(/\s+/)[1];
      if (!label) return res.status(200).send(await reply(chatId, 'Format: <code>/use label</code>', { reply_markup: kbBack() }));
      const acc = await getAccounts(chatId);
      if (!acc[label]) return res.status(200).send(await reply(chatId, '❌ Akun tidak ditemukan', { reply_markup: kbBack() }));
      await setActiveToken(chatId, acc[label].token);
      await reply(chatId, `✅ Aktif: <b>${label}</b>`, { reply_markup: kbMain() });
      return res.status(200).send('ok');
    }

    /* /delacc */
    if (text.startsWith('/delacc')) {
      const label = text.split(/\s+/)[1];
      if (!label) return res.status(200).send(await reply(chatId, 'Format: <code>/delacc label</code>', { reply_markup: kbBack() }));
      await removeAccount(chatId, label);
      const acc = await getAccounts(chatId);
      const active = await getActiveToken(chatId);
      if (!Object.values(acc).find(a => a.token === active)) await clearActiveToken(chatId);
      await reply(chatId, `🗑️ Akun <b>${label}</b> dihapus`, { reply_markup: kbMain() });
      return res.status(200).send('ok');
    }

    /* /whoami */
    if (text === '/whoami') {
      const token = await getActiveToken(chatId);
      if (!token) return res.status(200).send(await reply(chatId, 'Belum ada akun aktif.', { reply_markup: kbBack() }));
      try {
        const u = await vercelUser(token);
        await reply(chatId, `👤 <b>${u.username || u.email}</b>`, { reply_markup: kbMain() });
      } catch (e) {
        await reply(chatId, '❌ ' + e.message, { reply_markup: kbBack() });
      }
      return res.status(200).send('ok');
    }

    /* /cleartoken */
    if (text === '/cleartoken') {
      await clearActiveToken(chatId);
      await reply(chatId, '🧹 Token aktif dihapus.', { reply_markup: kbMain() });
      return res.status(200).send('ok');
    }

    /* /deploy */
    if (text.startsWith('/deploy')) {
      const token = await getActiveToken(chatId);
      if (!token) return res.status(200).send(await reply(chatId, '❌ Belum ada akun aktif.', { reply_markup: kbBack() }));
      const name = text.split(/\s+/)[1];
      if (!name) return res.status(200).send(await reply(chatId, 'Format: <code>/deploy nama-project</code>', { reply_markup: kbBack() }));
      const safe = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 90);
      await setPending(chatId, { name: safe });
      await reply(chatId, `📦 Siap deploy <b>${safe}</b>\n\nKirim file:\n• Dokumen (1 file)\n• <b>.zip</b> (multi-file)`, { reply_markup: kbBack() });
      return res.status(200).send('ok');
    }

    /* /rmdeploy */
    if (text.startsWith('/rmdeploy')) {
      const id = text.split(/\s+/)[1];
      if (!id) return res.status(200).send(await reply(chatId, 'Format: <code>/rmdeploy id</code>', { reply_markup: kbBack() }));
      const token = await getActiveToken(chatId);
      if (!token) return res.status(200).send(await reply(chatId, '❌ Akun tidak aktif.', { reply_markup: kbBack() }));
      try {
        await deleteDeployment(token, id);
        await reply(chatId, `🗑️ Deployment <code>${id.slice(0, 12)}…</code> dihapus.`, { reply_markup: kbMain() });
      } catch (e) {
        await reply(chatId, '❌ ' + e.message, { reply_markup: kbBack() });
      }
      return res.status(200).send('ok');
    }

    /* ==================== FILE ==================== */
    if (msg.document) {
      const token = await getActiveToken(chatId);
      if (!token) return res.status(200).send(await reply(chatId, '❌ Belum ada akun aktif.', { reply_markup: kbBack() }));
      const pending = await getPending(chatId);
      if (!pending) return res.status(200).send(await reply(chatId, '❌ Kirim <code>/deploy nama</code> dulu.', { reply_markup: kbBack() }));

      const fname = msg.document.file_name || '';
      try {
        await reply(chatId, '⏳ Mengunduh...');
        const gf = await fetch(`https://api.telegram.org/bot${BOT}/getFile?file_id=${msg.document.file_id}`);
        const gd
