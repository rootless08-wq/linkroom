import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleRooms, handleSignals } from '../lib/private-server.ts';

function database() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../drizzle/0003_secure_private_rooms.sql', import.meta.url), 'utf8'));
  const db = { prepare(query) {
    const statement = sql.prepare(query); let args = [];
    return { bind(...values) { args = values; return this; }, async first() { return statement.get(...args) || null; }, async all() { return { results: statement.all(...args) }; }, async run() { const result = statement.run(...args); return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; } };
  }, async batch(statements) { sql.exec('BEGIN'); try { const results = []; for (const statement of statements) results.push(await statement.run()); sql.exec('COMMIT'); return results; } catch (error) { sql.exec('ROLLBACK'); throw error; } } };
  return { db, sql };
}
function req(path, body, credential, origin = 'https://test.local') {
  return new Request('https://test.local' + path, { method: body ? 'POST' : 'GET', headers: { Origin: origin, 'Content-Type': 'application/json', ...(credential ? { Authorization: `Bearer ${credential}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function create(db) {
  const response = await handleRooms(req('/api/rooms', { action: 'create' }), db);
  assert.equal(response.status, 201); return response.json();
}
async function join(db, host) { return handleRooms(req('/api/rooms', { action: 'join', code: host.room.code, invite: host.invite }), db); }
function poll(db, state, after = 0) { return handleSignals(req(`/api/signals?room=${state.room.code}&after=${after}`, null, state.participant.token), db); }
function send(db, state, kind, payload, extras = {}) { return handleSignals(req('/api/signals', { room: state.room.code, kind, payload, ...extras }, state.participant.token), db); }

test('invitation capability, server identities, recipient isolation and one guest seat', async () => {
  const { db, sql } = database(); const host = await create(db);
  assert.match(host.room.code, /^[A-Z2-9]{8}$/); assert.equal(host.invite.length, 43); assert.notEqual(host.invite, host.participant.token);
  const stored = sql.prepare('SELECT * FROM private_rooms').get();
  assert.notEqual(stored.host_hash, host.participant.token); assert.notEqual(stored.invite_hash, host.invite);
  assert.equal((await handleRooms(req('/api/rooms', { action: 'join', code: host.room.code }), db)).status, 403);
  const joins = await Promise.all([join(db, host), join(db, host)]);
  assert.deepEqual(joins.map(r => r.status).sort(), [201, 409]);
  const guest = await joins.find(r => r.status === 201).json();
  assert.equal(guest.room.generation, 1);
  const resume = await handleRooms(req(`/api/rooms?code=${guest.room.code}`, null, guest.participant.token), db);
  assert.equal((await resume.json()).participant.id, guest.participant.id);
  assert.equal((await handleSignals(req(`/api/signals?room=${host.room.code}&exclude=madeup`), db)).status, 401);
  assert.equal((await send(db, host, 'offer', { type: 'offer', sdp: 'v=0' }, { sender: 'forged' })).status, 201);
  const signals = (await (await poll(db, guest)).json()).signals;
  assert.equal(signals.length, 1); assert.equal(signals[0].sender, host.participant.id);
  assert.equal((await (await poll(db, host)).json()).signals.length, 0);
  const stranger = await create(db);
  assert.equal((await handleSignals(req(`/api/signals?room=${host.room.code}`, null, stranger.participant.token), db)).status, 403);
  sql.close();
});

test('leaving revokes credentials; replacement guests cannot receive prior signaling; host closes room', async () => {
  const { db, sql } = database(); const host = await create(db); const guest = await (await join(db, host)).json();
  await send(db, host, 'offer', { type: 'offer', sdp: 'old private session' });
  await send(db, guest, 'answer', { type: 'answer', sdp: 'old guest response' });
  const leave = await handleRooms(req('/api/rooms', { action: 'leave', code: host.room.code }, guest.participant.token), db);
  assert.equal(leave.status, 200); assert.equal((await poll(db, guest)).status, 403);
  assert.equal((await send(db, guest, 'ice', { candidate: 'old candidate' })).status, 403);
  const replacement = await (await join(db, host)).json();
  assert.equal(replacement.room.generation, 2); assert.notEqual(replacement.participant.id, guest.participant.id);
  assert.equal((await (await poll(db, replacement)).json()).signals.length, 0);
  assert.equal((await (await poll(db, host)).json()).signals.length, 0);
  assert.equal((await handleRooms(req('/api/rooms', { action: 'end', code: host.room.code }, replacement.participant.token), db)).status, 403);
  assert.equal((await handleRooms(req('/api/rooms', { action: 'end', code: host.room.code }, host.participant.token), db)).status, 200);
  assert.equal((await join(db, host)).status, 410); assert.equal((await poll(db, host)).status, 410);
  sql.close();
});

test('renewed room lease never extends invite validity and transient failures never claim expiry', async () => {
  const { db, sql } = database(); const host = await create(db); const inviteExpiry = host.room.inviteExpiresAt;
  sql.prepare('UPDATE private_rooms SET expires_at=? WHERE code=?').run(Date.now() + 60_000, host.room.code);
  const renewed = await (await poll(db, host)).json();
  assert.ok(renewed.room.expiresAt > Date.now() + 23 * 60 * 60_000); assert.equal(renewed.room.inviteExpiresAt, inviteExpiry);
  sql.prepare('UPDATE private_rooms SET invite_expires_at=? WHERE code=?').run(Date.now() - 1, host.room.code);
  const expired = await join(db, host); assert.equal(expired.status, 410); assert.equal((await expired.json()).code, 'invite_expired');
  assert.equal((await poll(db, host)).status, 200);
  const legacy = await handleRooms(req('/api/rooms?code=ABC123'), db); assert.equal(legacy.status, 410); assert.equal((await legacy.json()).code, 'legacy_invite');
  const outage = await handleRooms(req(`/api/rooms?code=${host.room.code}`, null, host.participant.token), { prepare() { throw Error('DB offline'); } });
  assert.equal(outage.status, 503); assert.equal((await outage.json()).code, 'temporarily_unavailable');
  sql.close();
});

test('same-origin writes, streaming body limit, malformed signals and request throttling', async () => {
  const { db, sql } = database();
  assert.equal((await handleRooms(req('/api/rooms', { action: 'create' }, null, 'https://evil.local'), db)).status, 403);
  assert.equal((await handleRooms(req('/api/rooms', { action: 'create', junk: 'x'.repeat(33_000) }), db)).status, 413);
  assert.equal((await handleRooms(new Request('https://test.local/api/rooms', { method: 'POST', headers: { Origin: 'https://test.local', 'Content-Type': 'application/json' }, body: '{' }), db)).status, 400);
  const host = await create(db); const guest = await (await join(db, host)).json();
  assert.equal((await send(db, guest, 'offer', { type: 'answer', sdp: 'invalid' })).status, 400);
  assert.equal((await send(db, guest, 'ice', { candidate: 123 })).status, 400);
  assert.equal((await handleSignals(req(`/api/signals?room=${host.room.code}&after=NaN`, null, host.participant.token), db)).status, 400);
  for (let i = 1; i < 8; i++) await create(db);
  const limited = await handleRooms(req('/api/rooms', { action: 'create' }), db);
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('Retry-After'), '60');
  sql.close();
});

test('refresh cursor skips old signaling and requires participant credentials', async () => {
  const { db, sql } = database(); const host = await create(db); const guest = await (await join(db, host)).json();
  const sent = await (await send(db, guest, 'presence', { session: 'old-tab' })).json();
  const fresh = await handleSignals(req(`/api/signals?room=${host.room.code}&fresh=1`, null, host.participant.token), db);
  const state = await fresh.json(); assert.equal(state.after, sent.id); assert.deepEqual(state.signals, []);
  assert.equal((await handleSignals(req(`/api/signals?room=${host.room.code}&fresh=1`), db)).status, 401);
  await send(db, guest, 'presence', { session: 'new-tab' });
  const update = await (await poll(db, host, state.after)).json();
  assert.equal(update.signals.length, 1); assert.equal(update.signals[0].payload.session, 'new-tab');
  sql.close();
});
