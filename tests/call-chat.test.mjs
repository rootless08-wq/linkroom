import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CallChat, CHUNK_BYTES, MAX_FILE_BYTES, MAX_MESSAGES, previewKind, safeFileName } from '../lib/call-chat.ts';

class Channel extends EventTarget {
  readyState = 'open'; ordered = true; maxRetransmits = null; maxPacketLifeTime = null;
  binaryType = 'arraybuffer'; bufferedAmount = 0; bufferedAmountLowThreshold = 0;
  sent = []; peer;
  send(data) {
    if (this.readyState !== 'open') throw new Error('Closed');
    this.sent.push(data);
    queueMicrotask(() => { if (this.peer?.readyState === 'open') this.peer.dispatchEvent(new MessageEvent('message', { data })); });
  }
  receive(data) { this.dispatchEvent(new MessageEvent('message', { data: typeof data === 'string' || data instanceof ArrayBuffer ? data : JSON.stringify({ lr: 1, ...data }) })); }
  close() { this.readyState = 'closed'; this.dispatchEvent(new Event('close')); }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); } assert.ok(predicate(), 'Expected transfer to settle'); }
function pair(t) {
  const left = new Channel(), right = new Channel(); left.peer = right; right.peer = left;
  const sender = new CallChat(), receiver = new CallChat(); sender.attach(left); receiver.attach(right);
  t.after(() => { sender.reset(); receiver.reset(); });
  return { sender, receiver, left, right };
}
function offer(channel, overrides = {}) {
  const id = crypto.randomUUID(); channel.receive({ t: 'offer', id, name: 'example.txt', mime: 'text/plain', size: 3, ...overrides }); return overrides.id || id;
}
function chunk(id, offset, content) {
  const payload = new TextEncoder().encode(content), bytes = new Uint8Array(40 + payload.byteLength);
  for (let i = 0; i < 36; i++) bytes[i] = id.charCodeAt(i);
  new DataView(bytes.buffer).setUint32(36, offset); bytes.set(payload, 40); return bytes.buffer;
}

test('file bytes are withheld until acceptance, chunked, and reassembled without corruption', async t => {
  const { sender, receiver, left } = pair(t), content = new Uint8Array(180_000).map((_, index) => index % 251);
  assert.equal(sender.offerFile(new File([content], 'trip.webm', { type: 'video/webm' })), true);
  await tick(); assert.equal(left.sent.filter(item => item instanceof ArrayBuffer).length, 0);
  const message = receiver.getSnapshot().messages[0]; assert.equal(message.status, 'offered'); assert.equal(message.url, undefined);
  assert.equal(receiver.acceptFile(message.id), true);
  await until(() => sender.getSnapshot().messages[0].status === 'complete');
  const received = receiver.getSnapshot().messages[0]; assert.equal(received.status, 'complete'); assert.equal(received.progress, 1);
  const packets = left.sent.filter(item => item instanceof ArrayBuffer); assert.ok(packets.length > 1); assert.ok(packets.every(item => item.byteLength <= CHUNK_BYTES));
  assert.deepEqual(new Uint8Array(await (await fetch(received.url)).arrayBuffer()), content);
});

test('sender pauses at the buffer limit and resumes after bufferedamountlow', async t => {
  const { sender, receiver, left } = pair(t);
  sender.offerFile(new File(['a'.repeat(40_000)], 'notes.txt')); await tick();
  left.bufferedAmount = 200 * 1024; receiver.acceptFile(receiver.getSnapshot().messages[0].id); await tick();
  assert.equal(left.sent.filter(item => item instanceof ArrayBuffer).length, 0);
  left.bufferedAmount = 0; left.dispatchEvent(new Event('bufferedamountlow'));
  await until(() => sender.getSnapshot().messages[0].status === 'complete');
});

test('file decline sends no payload, and active transfers are bounded', async t => {
  const { sender, receiver, left, right } = pair(t);
  sender.offerFile(new File(['hello'], 'hello.txt')); await tick();
  assert.equal(sender.offerFile(new File(['other'], 'other.txt')), false);
  const first = receiver.getSnapshot().messages[0];
  offer(right, { name: 'extra.txt' }); assert.equal(receiver.getSnapshot().messages.length, 1);
  receiver.cancelFile(first.id); await tick();
  assert.equal(sender.getSnapshot().messages[0].status, 'declined'); assert.equal(left.sent.filter(item => item instanceof ArrayBuffer).length, 0);
});

test('unsolicited chunks are ignored and invalid offsets cancel an accepted file', t => {
  const { receiver, right } = pair(t), id = offer(right);
  right.receive(chunk(id, 0, 'abc')); right.receive({ t: 'done', id });
  assert.equal(receiver.getSnapshot().messages[0].status, 'offered'); assert.equal(receiver.getSnapshot().messages[0].progress, 0);
  receiver.acceptFile(id); right.receive(chunk(id, 1, 'ab'));
  assert.equal(receiver.getSnapshot().messages[0].status, 'failed'); assert.equal(receiver.getSnapshot().messages[0].url, undefined);
});

test('malformed and oversize offers, unsafe previews, and forged completion are rejected', t => {
  const { receiver, right, sender } = pair(t);
  offer(right, { size: MAX_FILE_BYTES + 1 }); offer(right, { size: -1 }); offer(right, { size: '123' });
  assert.equal(receiver.getSnapshot().messages.length, 0);
  assert.equal(sender.offerFile(new File([], 'empty')), false);
  assert.equal(previewKind('image/svg+xml'), 'file'); assert.equal(previewKind('text/html'), 'file'); assert.equal(previewKind('image/gif'), 'image');
  assert.equal(safeFileName('../../photo\u202Efdp.exe'), 'photofdp.exe');
  sender.offerFile(new File(['abc'], 'normal.txt')); const message = sender.getSnapshot().messages[0];
  // An acknowledgement cannot claim success before the sender has sent all bytes.
  const channel = new Channel(); const isolated = new CallChat(); isolated.attach(channel); t.after(() => isolated.reset());
  isolated.offerFile(new File(['abc'], 'normal.txt')); const local = isolated.getSnapshot().messages[0];
  channel.receive({ t: 'complete', id: local.id }); assert.equal(isolated.getSnapshot().messages[0].status, 'offered');
  assert.ok(message);
});

test('reset cancels pending work, revokes received object URLs, and ignores stale messages', async t => {
  const { sender, receiver, right } = pair(t);
  sender.offerFile(new File(['GIF89a'], 'wave.gif', { type: 'image/gif' })); await tick(); receiver.acceptFile(receiver.getSnapshot().messages[0].id);
  await until(() => receiver.getSnapshot().messages[0].status === 'complete');
  const url = receiver.getSnapshot().messages[0].url, generation = receiver.getSnapshot().generation;
  receiver.reset(); await assert.rejects(fetch(url));
  right.receive({ t: 'text', text: 'stale partner message' });
  assert.equal(receiver.getSnapshot().messages.length, 0); assert.equal(receiver.getSnapshot().connected, false); assert.ok(receiver.getSnapshot().generation > generation);
});

test('disconnect interrupts buffered file transfer and leaves a useful status', async t => {
  const { sender, receiver, left } = pair(t);
  sender.offerFile(new File(['a'.repeat(20000)], 'notes.txt')); await tick(); left.bufferedAmount = 200 * 1024;
  receiver.acceptFile(receiver.getSnapshot().messages[0].id); await tick(); left.close(); await tick();
  assert.equal(sender.getSnapshot().connected, false); assert.equal(sender.getSnapshot().messages[0].status, 'failed');
  assert.equal(left.sent.filter(item => item instanceof ArrayBuffer).length, 0);
});

test('chat validates packets, limits reaction bursts, and retains at most 200 messages', t => {
  const { receiver, right } = pair(t);
  right.receive('not json'); right.receive({ t: 'text', text: 'x'.repeat(2001) }); right.receive({ t: 'reaction', emoji: '<script>' });
  assert.equal(receiver.getSnapshot().messages.length, 0); assert.equal(receiver.getSnapshot().reactions.length, 0);
  for (let i = 0; i < 30; i++) right.receive({ t: 'reaction', emoji: '🎉' });
  assert.equal(receiver.getSnapshot().reactions.length, 2);
  const originalNow = Date.now; let now = originalNow();
  try {
    Date.now = () => now;
    for (let i = 0; i < 215; i++) { now += 1000; right.receive({ t: 'text', text: `message ${i}` }); }
  } finally { Date.now = originalNow; }
  assert.equal(receiver.getSnapshot().messages.length, MAX_MESSAGES); assert.equal(receiver.getSnapshot().messages[0].text, 'message 15');
});

test('unreliable data channels do not enable file transfer', t => {
  const channel = new Channel(), session = new CallChat(); channel.ordered = false; session.attach(channel); t.after(() => session.reset());
  assert.equal(session.getSnapshot().connected, false); assert.match(session.getSnapshot().error, /reliable/);
});
