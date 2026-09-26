/** Peer-to-peer chat and opt-in file transfer. No files pass through app storage. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_RETAINED_BYTES = 40 * 1024 * 1024;
export const MAX_MESSAGES = 200;
export const CHUNK_BYTES = 16 * 1024;
export const REACTIONS = ["❤️", "🎉", "👍", "🙌", "😂", "✨"] as const;
export type ReactionEmoji = (typeof REACTIONS)[number];
export type FileStatus = "offered" | "transferring" | "complete" | "declined" | "cancelled" | "failed" | "removed";
export type ChatMessage = { id: string; from: "You" | "Partner"; createdAt: number } & (
  | { kind: "text"; text: string }
  | { kind: "file"; name: string; size: number; mime: string; status: FileStatus; progress: number; url?: string; note?: string }
);
export type ChatReaction = { id: string; emoji: ReactionEmoji; from: "You" | "Partner"; createdAt: number };
export type ChatSnapshot = { generation: number; connected: boolean; messages: ChatMessage[]; reactions: ChatReaction[]; error: string };
type Outgoing = { id: string; file: File; accepted: boolean; sent: number; timer: ReturnType<typeof setTimeout> };
type Incoming = { id: string; name: string; mime: string; size: number; accepted: boolean; received: number; chunks: ArrayBuffer[]; timer: ReturnType<typeof setTimeout> };
type StoredFile = { id: string; url: string; size: number };
const HEADER_BYTES = 40;
const PAYLOAD_BYTES = CHUNK_BYTES - HEADER_BYTES;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OFFER_TIMEOUT = 120_000;
const TRANSFER_TIMEOUT = 30_000;
const initial = (generation = 0): ChatSnapshot => ({ generation, connected: false, messages: [], reactions: [], error: "" });

export function safeFileName(value: string) {
  return (value.split(/[\\/]/).pop() || "Attachment").replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "").trim().slice(0, 120) || "Attachment";
}
export function previewKind(mime: string): "image" | "video" | "audio" | "file" {
  if (["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"].includes(mime)) return "image";
  if (["video/mp4", "video/webm", "video/ogg"].includes(mime)) return "video";
  if (["audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav", "audio/x-wav", "audio/webm", "audio/aac", "audio/flac"].includes(mime)) return "audio";
  return "file";
}
export function fileSize(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export class CallChat {
  private snapshot = initial();
  private listeners = new Set<() => void>();
  private channel: RTCDataChannel | null = null;
  private detach: (() => void) | null = null;
  private outgoing: Outgoing | null = null;
  private incoming: Incoming | null = null;
  private stored: StoredFile[] = [];
  private reactionTimers = new Set<ReturnType<typeof setTimeout>>();
  private lastProgress = 0;
  private rates = new Map<string, number[]>();
  private pauseCancels = new Set<() => void>();

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<ChatSnapshot>) { this.snapshot = { ...this.snapshot, ...patch }; for (const listener of this.listeners) listener(); }
  private error(message: string) { this.update({ error: message }); return false; }
  clearError = () => this.update({ error: "" });
  private allowed(key: string, count: number, windowMs: number) {
    const now = Date.now(), events = (this.rates.get(key) || []).filter(time => now - time < windowMs);
    if (events.length >= count) return false;
    events.push(now); this.rates.set(key, events); return true;
  }
  private append(message: ChatMessage) {
    const messages = [...this.snapshot.messages, message];
    for (const removed of messages.splice(0, Math.max(0, messages.length - MAX_MESSAGES))) {
      this.release(removed.id);
      if (removed.id === this.incoming?.id || removed.id === this.outgoing?.id) this.cancelFile(removed.id);
    }
    this.update({ messages });
  }
  private filePatch(id: string, patch: Partial<Extract<ChatMessage, { kind: "file" }>>) {
    this.update({ messages: this.snapshot.messages.map(message => message.id === id && message.kind === "file" ? { ...message, ...patch } : message) });
  }
  private send(data: Record<string, unknown>) {
    if (this.channel?.readyState !== "open" || this.channel.bufferedAmount > 256 * 1024) return false;
    try { this.channel.send(JSON.stringify({ lr: 1, ...data })); return true; } catch { return false; }
  }

  attach(channel: RTCDataChannel) {
    this.reset();
    // A single reliable, ordered channel keeps file chunks and their consent messages in order.
    if (!channel.ordered || channel.maxRetransmits !== null || channel.maxPacketLifeTime !== null) {
      this.error("Chat needs a reliable connection. Rejoin the call to try again."); return;
    }
    this.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = 64 * 1024;
    const open = () => { if (this.channel === channel) this.update({ connected: true, error: "" }); };
    const close = () => {
      if (this.channel !== channel) return;
      if (this.outgoing) this.finish(this.outgoing.id, "failed", "Connection closed");
      if (this.incoming) this.finish(this.incoming.id, "failed", "Connection closed");
      for (const cancel of this.pauseCancels) cancel();
      this.update({ connected: false });
    };
    const receive = (event: MessageEvent) => { if (this.channel === channel) this.receive(event.data); };
    channel.addEventListener("open", open); channel.addEventListener("close", close); channel.addEventListener("error", close); channel.addEventListener("message", receive);
    this.detach = () => { channel.removeEventListener("open", open); channel.removeEventListener("close", close); channel.removeEventListener("error", close); channel.removeEventListener("message", receive); };
    if (channel.readyState === "open") open();
  }

  sendText(text: string) {
    const clean = text.trim().slice(0, 2000);
    if (!clean || !this.snapshot.connected) return false;
    if (!this.allowed("send-text", 12, 5000)) return this.error("Give the chat a moment before sending more messages.");
    if (!this.send({ t: "text", text: clean })) return this.error("Chat is busy. Try sending again in a moment.");
    this.append({ id: crypto.randomUUID(), kind: "text", from: "You", text: clean, createdAt: Date.now() });
    return true;
  }

  react(emoji: string) {
    if (!(REACTIONS as readonly string[]).includes(emoji) || !this.snapshot.connected) return false;
    if (!this.allowed("send-reaction", 1, 900)) return false;
    if (!this.send({ t: "reaction", emoji })) return false;
    this.showReaction(emoji as ReactionEmoji, "You"); return true;
  }
  private showReaction(emoji: ReactionEmoji, from: "You" | "Partner") {
    const reaction = { id: crypto.randomUUID(), emoji, from, createdAt: Date.now() };
    this.update({ reactions: [...this.snapshot.reactions.slice(-5), reaction] });
    const timer = setTimeout(() => { this.reactionTimers.delete(timer); this.update({ reactions: this.snapshot.reactions.filter(item => item.id !== reaction.id) }); }, 4000);
    this.reactionTimers.add(timer);
  }

  offerFile(file: File) {
    if (!this.snapshot.connected) return this.error("Connect to someone before sending a file.");
    if (this.outgoing) return this.error("Finish or cancel your current file before sending another.");
    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_FILE_BYTES) return this.error("Choose a file between 1 byte and 20 MB.");
    if (!this.allowed("send-offer", 4, 10000)) return this.error("Give the other person a moment before sending more files.");
    const id = crypto.randomUUID(), name = safeFileName(file.name), mime = this.safeMime(file.type);
    if (!this.send({ t: "offer", id, name, mime, size: file.size })) return this.error("Could not send the file offer. Try again.");
    this.outgoing = { id, file, accepted: false, sent: 0, timer: this.timeout(id, OFFER_TIMEOUT) };
    this.append({ id, kind: "file", from: "You", name, mime, size: file.size, status: "offered", progress: 0, createdAt: Date.now() });
    this.clearError(); return true;
  }
  acceptFile(id: string) {
    const transfer = this.incoming;
    if (!transfer || transfer.id !== id || transfer.accepted || !this.snapshot.connected) return false;
    this.reserve(transfer.size);
    if (!this.send({ t: "accept", id })) return this.error("Could not accept this file. Try again.");
    transfer.accepted = true; this.touch(transfer);
    this.filePatch(id, { status: "transferring" }); return true;
  }
  cancelFile(id: string) {
    const transfer = this.incoming?.id === id ? this.incoming : this.outgoing?.id === id ? this.outgoing : null;
    if (!transfer) return;
    const declined = this.incoming === transfer && !transfer.accepted;
    this.send({ t: declined ? "decline" : "cancel", id });
    this.finish(id, declined ? "declined" : "cancelled");
  }
  private safeMime(value: string) { return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(value) && value.length <= 100 ? value.toLowerCase() : "application/octet-stream"; }
  private timeout(id: string, delay: number) { return setTimeout(() => { this.send({ t: "cancel", id }); this.finish(id, "failed", "Timed out — try sending again"); }, delay); }
  private touch(transfer: Incoming | Outgoing) { clearTimeout(transfer.timer); transfer.timer = this.timeout(transfer.id, TRANSFER_TIMEOUT); }
  private finish(id: string, status: FileStatus, note?: string) {
    if (this.incoming?.id === id) { clearTimeout(this.incoming.timer); this.incoming.chunks = []; this.incoming = null; }
    if (this.outgoing?.id === id) { clearTimeout(this.outgoing.timer); this.outgoing = null; for (const cancel of this.pauseCancels) cancel(); }
    this.filePatch(id, { status, note, ...(status === "complete" ? { progress: 1 } : {}) });
  }
  private reserve(size: number) {
    while (this.stored.length && this.stored.reduce((total, item) => total + item.size, 0) + size > MAX_RETAINED_BYTES) {
      const oldest = this.stored[0]; this.release(oldest.id); this.filePatch(oldest.id, { status: "removed", url: undefined, note: "Older attachment cleared to free memory" });
    }
  }
  private release(id: string) { for (const file of this.stored.filter(item => item.id === id)) URL.revokeObjectURL(file.url); this.stored = this.stored.filter(item => item.id !== id); }

  private receive(data: unknown) {
    if (data instanceof ArrayBuffer) { this.receiveChunk(data); return; }
    if (typeof data !== "string" || data.length > 8192) return;
    let packet: Record<string, unknown>;
    try { const value = JSON.parse(data); if (!value || typeof value !== "object" || Array.isArray(value) || value.lr !== 1) return; packet = value; } catch { return; }
    if (packet.t === "text") {
      if (typeof packet.text === "string" && packet.text.trim() && packet.text.length <= 2000 && this.allowed("receive-text", 30, 10000)) this.append({ id: crypto.randomUUID(), kind: "text", from: "Partner", text: packet.text, createdAt: Date.now() });
      return;
    }
    if (packet.t === "reaction") {
      if (typeof packet.emoji === "string" && (REACTIONS as readonly string[]).includes(packet.emoji) && this.allowed("receive-reaction", 2, 1000)) this.showReaction(packet.emoji as ReactionEmoji, "Partner");
      return;
    }
    const id = packet.id;
    if (typeof id !== "string" || !ID.test(id)) return;
    if (packet.t === "offer") {
      if (this.incoming || this.outgoing?.id === id || this.snapshot.messages.some(message => message.id === id) || !this.allowed("receive-offer", 4, 10000)) { this.send({ t: "decline", id }); return; }
      if (typeof packet.name !== "string" || packet.name.length > 240 || typeof packet.mime !== "string" || typeof packet.size !== "number" || !Number.isSafeInteger(packet.size) || packet.size < 1 || packet.size > MAX_FILE_BYTES) { this.send({ t: "decline", id }); return; }
      const name = safeFileName(packet.name), mime = this.safeMime(packet.mime), size = packet.size;
      this.incoming = { id, name, mime, size, accepted: false, received: 0, chunks: [], timer: this.timeout(id, OFFER_TIMEOUT) };
      this.append({ id, kind: "file", from: "Partner", name, mime, size, status: "offered", progress: 0, createdAt: Date.now() }); return;
    }
    if (packet.t === "accept" && this.outgoing?.id === id && !this.outgoing.accepted) {
      this.outgoing.accepted = true; this.touch(this.outgoing); this.filePatch(id, { status: "transferring" }); void this.pump(this.outgoing); return;
    }
    if (packet.t === "decline" && this.outgoing?.id === id) { this.finish(id, "declined"); return; }
    if (packet.t === "cancel" && (this.outgoing?.id === id || this.incoming?.id === id)) { this.finish(id, "cancelled", "Cancelled by the other person"); return; }
    if (packet.t === "done" && this.incoming?.id === id && this.incoming.accepted) {
      const transfer = this.incoming;
      if (transfer.received !== transfer.size) { this.send({ t: "cancel", id }); this.finish(id, "failed", "Incomplete file — ask them to send it again"); return; }
      const blob = new Blob(transfer.chunks, { type: transfer.mime });
      this.reserve(blob.size); const url = URL.createObjectURL(blob); this.stored.push({ id, url, size: blob.size });
      this.filePatch(id, { url }); this.finish(id, "complete"); this.send({ t: "complete", id }); return;
    }
    if (packet.t === "complete" && this.outgoing?.id === id && this.outgoing.accepted && this.outgoing.sent === this.outgoing.file.size) this.finish(id, "complete");
  }

  private receiveChunk(data: ArrayBuffer) {
    const transfer = this.incoming;
    // Unsolicited bytes are discarded before allocating any attachment storage.
    if (!transfer?.accepted || data.byteLength <= HEADER_BYTES || data.byteLength > CHUNK_BYTES) return;
    const bytes = new Uint8Array(data), id = String.fromCharCode(...bytes.subarray(0, 36));
    if (id !== transfer.id) return;
    const offset = new DataView(data).getUint32(36), size = data.byteLength - HEADER_BYTES;
    if (offset !== transfer.received || transfer.received + size > transfer.size) { this.send({ t: "cancel", id }); this.finish(id, "failed", "Invalid file transfer"); return; }
    transfer.chunks.push(data.slice(HEADER_BYTES)); transfer.received += size; this.touch(transfer);
    if (Date.now() - this.lastProgress > 100 || transfer.received === transfer.size) { this.lastProgress = Date.now(); this.filePatch(id, { progress: transfer.received / transfer.size }); }
  }
  private async pump(transfer: Outgoing) {
    const channel = this.channel;
    try {
      while (this.outgoing === transfer && channel === this.channel && channel?.readyState === "open" && transfer.sent < transfer.file.size) {
        if (channel.bufferedAmount > 128 * 1024) await this.drain(channel, transfer);
        if (this.outgoing !== transfer || channel !== this.channel || channel.readyState !== "open") return;
        const chunk = await transfer.file.slice(transfer.sent, transfer.sent + PAYLOAD_BYTES).arrayBuffer();
        if (this.outgoing !== transfer || channel !== this.channel || channel.readyState !== "open") return;
        const bytes = new Uint8Array(HEADER_BYTES + chunk.byteLength);
        for (let i = 0; i < 36; i++) bytes[i] = transfer.id.charCodeAt(i);
        new DataView(bytes.buffer).setUint32(36, transfer.sent); bytes.set(new Uint8Array(chunk), HEADER_BYTES);
        channel.send(bytes.buffer); transfer.sent += chunk.byteLength; this.touch(transfer);
        if (Date.now() - this.lastProgress > 100 || transfer.sent === transfer.file.size) { this.lastProgress = Date.now(); this.filePatch(transfer.id, { progress: transfer.sent / transfer.file.size }); }
      }
      if (this.outgoing === transfer && transfer.sent === transfer.file.size) {
        await this.drain(channel!, transfer);
        if (this.outgoing === transfer && !this.send({ t: "done", id: transfer.id })) throw new Error("Could not finish transfer");
      }
    } catch {
      if (this.outgoing === transfer) { this.send({ t: "cancel", id: transfer.id }); this.finish(transfer.id, "failed", "Transfer interrupted — try again"); }
    }
  }
  private drain(channel: RTCDataChannel, transfer: Outgoing) {
    if (channel.bufferedAmount <= 64 * 1024) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => { clearTimeout(timer); clearInterval(poll); channel.removeEventListener("bufferedamountlow", check); channel.removeEventListener("close", cancel); this.pauseCancels.delete(cancel); };
      const finish = (failure = false) => { if (settled) return; settled = true; cleanup(); if (failure) reject(new Error("Transfer cancelled")); else resolve(); };
      const check = () => { if (channel !== this.channel || this.outgoing !== transfer || channel.readyState !== "open") finish(true); else if (channel.bufferedAmount <= 64 * 1024) finish(); };
      const cancel = () => finish(true);
      const timer = setTimeout(cancel, TRANSFER_TIMEOUT), poll = setInterval(check, 200);
      this.pauseCancels.add(cancel); channel.addEventListener("bufferedamountlow", check); channel.addEventListener("close", cancel); check();
    });
  }

  reset() {
    this.detach?.(); this.detach = null; this.channel = null;
    if (this.outgoing) clearTimeout(this.outgoing.timer);
    if (this.incoming) clearTimeout(this.incoming.timer);
    this.outgoing = null; this.incoming = null;
    for (const cancel of this.pauseCancels) cancel(); this.pauseCancels.clear();
    for (const timer of this.reactionTimers) clearTimeout(timer); this.reactionTimers.clear();
    for (const item of this.stored) URL.revokeObjectURL(item.url); this.stored = [];
    this.rates.clear(); this.lastProgress = 0; this.update(initial(this.snapshot.generation + 1));
  }
}
