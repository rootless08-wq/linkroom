/** Private rooms use separate invitation capabilities and participant credentials.
 * Tokens never appear in request URLs or the database in plain text. */
const day = 24 * 60 * 60_000;
const roomPattern = /^[A-Z2-9]{8}$/;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const kinds = new Set(["presence", "offer", "answer", "ice", "leave"]);
const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

type Room = {
  code: string; invite_hash: string; invite_expires_at: number; expires_at: number;
  host_id: string; host_hash: string; guest_id: string | null; guest_hash: string | null;
  generation: number; closed: number;
};
type Member = { id: string; role: "host" | "guest"; hash: string };
type Json = Record<string, unknown>;

class ApiError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
function fail(status: number, code: string, message: string): never { throw new ApiError(status, code, message); }
function reply(body: unknown, status = 200) { return Response.json(body, { status, headers }); }
function token() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function hash(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), b => b.toString(16).padStart(2, "0")).join("");
}
function roomCode(value: unknown) {
  const code = typeof value === "string" ? value.toUpperCase() : "";
  if (/^[A-Z0-9]{6}$/.test(code)) fail(410, "legacy_invite", "This invitation uses the older room system. Ask the host to create and share a new invitation link.");
  if (!roomPattern.test(code)) fail(400, "invalid_room", "Paste the complete invitation link from the host.");
  return code;
}
function publicRoom(room: Room) {
  return { code: room.code, expiresAt: room.expires_at, inviteExpiresAt: room.invite_expires_at, guestPresent: !!room.guest_id, generation: room.generation };
}
async function readBody(request: Request): Promise<Json> {
  if (request.headers.get("Origin") !== new URL(request.url).origin) fail(403, "wrong_origin", "Open LinkRoom directly to continue.");
  if (!(request.headers.get("Content-Type") || "").toLowerCase().startsWith("application/json")) fail(415, "invalid_content_type", "Send a JSON request.");
  if (Number(request.headers.get("Content-Length") || 0) > 32_768) fail(413, "body_too_large", "This request is too large.");
  const reader = request.body?.getReader();
  if (!reader) fail(400, "invalid_body", "A request body is required.");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > 32_768) { await reader.cancel(); fail(413, "body_too_large", "This request is too large."); }
      chunks.push(next.value);
    }
    const buffer = new Uint8Array(size); let at = 0;
    for (const chunk of chunks) { buffer.set(chunk, at); at += chunk.byteLength; }
    const body: unknown = JSON.parse(new TextDecoder().decode(buffer));
    if (!body || typeof body !== "object" || Array.isArray(body)) fail(400, "invalid_body", "Invalid request.");
    return body as Json;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    fail(400, "invalid_body", "Invalid JSON request.");
  } finally { reader.releaseLock(); }
}
async function rate(db: D1Database, scope: string, identity: string, maximum: number) {
  const now = Date.now(); const bucket = Math.floor(now / 60_000);
  const key = await hash(`${scope}:${identity}:${bucket}`);
  const result = await db.prepare(`INSERT INTO private_rate_limits (bucket, count, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(bucket) DO UPDATE SET count = count + 1 WHERE count < ?`).bind(key, (bucket + 2) * 60_000, maximum).run();
  if (!result.meta.changes) fail(429, "rate_limited", "Too many requests. Please wait a minute and try again.");
}
async function findRoom(db: D1Database, code: string) {
  const room = await db.prepare("SELECT * FROM private_rooms WHERE code=?").bind(code).first<Room>();
  if (!room) fail(404, "room_not_found", "This room could not be found. Check the invitation link with the host.");
  return room;
}
function active(room: Room) {
  if (room.closed) fail(410, "room_closed", "The host has ended this room. Ask for a new invitation.");
  if (room.expires_at <= Date.now()) fail(410, "room_expired", "This room has been inactive for 24 hours. Ask the host for a new invitation.");
}
async function member(request: Request, room: Room): Promise<Member> {
  const raw = request.headers.get("Authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if (!raw) fail(401, "authentication_required", "Reopen your invitation to join this room.");
  const value = await hash(raw);
  if (value === room.host_hash) return { id: room.host_id, role: "host", hash: value };
  if (value === room.guest_hash && room.guest_id) return { id: room.guest_id, role: "guest", hash: value };
  fail(403, "invalid_participant", "Your room session has ended. Reopen your invitation to join again.");
}
async function renew(db: D1Database, room: Room, me: Member) {
  // Coalesce renewals to once an hour; active calls have no fixed duration limit.
  if (room.expires_at >= Date.now() + 23 * 60 * 60_000) return;
  const next = Date.now() + day;
  const result = await db.prepare(`UPDATE private_rooms SET expires_at=? WHERE code=? AND closed=0 AND expires_at>?
    AND (host_hash=? OR guest_hash=?)`).bind(next, room.code, Date.now(), me.hash, me.hash).run();
  if (result.meta.changes) room.expires_at = next;
}
async function api(work: () => Promise<Response>, db?: D1Database) {
  if (!db) return reply({ error: "Rooms are temporarily unavailable. Please try again shortly.", code: "temporarily_unavailable" }, 503);
  try { return await work(); }
  catch (error) {
    if (error instanceof ApiError) {
      const response = reply({ error: error.message, code: error.code }, error.status);
      if (error.status === 429) response.headers.set("Retry-After", "60");
      return response;
    }
    // Database outages and missing migrations must never be reported as expired invitations.
    return reply({ error: "The room service is temporarily unavailable. Your invitation may still be valid; please try again shortly.", code: "temporarily_unavailable" }, 503);
  }
}
export async function handleRooms(request: Request, db?: D1Database) {
  return api(async () => {
    const database = db!;
    if (request.method === "GET") {
      const room = await findRoom(database, roomCode(new URL(request.url).searchParams.get("code")));
      const me = await member(request, room); active(room);
      await rate(database, "read", me.hash, 100);
      await renew(database, room, me);
      return reply({ room: publicRoom(room), participant: { id: me.id, role: me.role } });
    }
    if (request.method !== "POST") return reply({ error: "Method not allowed" }, 405);
    const body = await readBody(request);
    const ip = request.headers.get("CF-Connecting-IP") || "local";
    if (body.action === "create") {
      await rate(database, "create", ip, 8);
      await database.batch([
        database.prepare("DELETE FROM private_rate_limits WHERE expires_at<?").bind(Date.now()),
        database.prepare("DELETE FROM private_signals WHERE created_at<?").bind(Date.now() - 10 * 60_000),
        database.prepare("DELETE FROM private_rooms WHERE expires_at<?").bind(Date.now() - day),
      ]);
      const invite = token(); const credential = token(); const id = crypto.randomUUID();
      const inviteHash = await hash(invite); const credentialHash = await hash(credential); const now = Date.now();
      const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      for (let attempt = 0; attempt < 4; attempt++) {
        const code = Array.from(crypto.getRandomValues(new Uint8Array(8)), value => alphabet[value % alphabet.length]).join("");
        const created = await database.prepare(`INSERT OR IGNORE INTO private_rooms
          (code,invite_hash,invite_expires_at,expires_at,host_id,host_hash,created_at) VALUES(?,?,?,?,?,?,?)`)
          .bind(code, inviteHash, now + day, now + day, id, credentialHash, now).run();
        if (created.meta.changes) {
          const room = await findRoom(database, code);
          return reply({ room: publicRoom(room), invite, participant: { id, token: credential, role: "host" } }, 201);
        }
      }
      fail(503, "temporarily_unavailable", "A room could not be created. Please try again.");
    }
    const code = roomCode(body.code);
    if (body.action === "join") {
      await rate(database, "join", ip, 30);
      if (typeof body.invite !== "string" || !tokenPattern.test(body.invite)) fail(403, "invalid_invite", "Paste the complete invitation link, including its private invitation key.");
      const inviteHash = await hash(body.invite); const room = await findRoom(database, code);
      if (inviteHash !== room.invite_hash) fail(403, "invalid_invite", "This invitation key is incorrect. Ask the host to copy the invitation again.");
      active(room);
      if (room.invite_expires_at <= Date.now()) fail(410, "invite_expired", "This invitation was valid for 24 hours and has expired. Ask the host for a new invitation.");
      const credential = token(); const credentialHash = await hash(credential); const id = crypto.randomUUID();
      // A single conditional update prevents simultaneous joins claiming the guest seat.
      const claimed = await database.prepare(`UPDATE private_rooms SET guest_id=?, guest_hash=?, generation=generation+1
        WHERE code=? AND invite_hash=? AND guest_id IS NULL AND closed=0 AND expires_at>? AND invite_expires_at>?`)
        .bind(id, credentialHash, code, inviteHash, Date.now(), Date.now()).run();
      if (!claimed.meta.changes) fail(409, "room_full", "This private room already has two people. Use your existing room tab or ask the host for a new invitation.");
      const joined = await findRoom(database, code);
      return reply({ room: publicRoom(joined), participant: { id, token: credential, role: "guest" } }, 201);
    }
    const room = await findRoom(database, code); const me = await member(request, room); active(room);
    await rate(database, "write", me.hash, 180);
    if (body.action === "end") {
      if (me.role !== "host") fail(403, "host_required", "Only the host can end this room.");
      await database.prepare("UPDATE private_rooms SET closed=1,guest_hash=NULL,guest_id=NULL WHERE code=? AND host_hash=?")
        .bind(code, me.hash).run();
      return reply({ ended: true });
    }
    if (body.action === "leave") {
      if (me.role !== "guest") fail(400, "host_must_end", "The host can end the room instead.");
      await database.batch([
        database.prepare(`INSERT INTO private_signals (room_code,recipient_id,sender_id,generation,kind,payload,created_at)
          SELECT code,host_id,guest_id,generation,'leave','{}',? FROM private_rooms WHERE code=? AND guest_hash=? AND closed=0`).bind(Date.now(), code, me.hash),
        database.prepare("UPDATE private_rooms SET guest_id=NULL,guest_hash=NULL WHERE code=? AND guest_hash=?").bind(code, me.hash),
      ]);
      return reply({ left: true });
    }
    fail(400, "invalid_action", "Choose a valid room action.");
  }, db);
}
function validateSignal(kind: unknown, value: unknown) {
  if (typeof kind !== "string" || !kinds.has(kind)) fail(400, "invalid_signal", "Invalid signal type.");
  const payload = value ?? {};
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail(400, "invalid_signal", "Invalid signal data.");
  const data = payload as Json;
  if ((kind === "offer" || kind === "answer") && (data.type !== kind || typeof data.sdp !== "string" || data.sdp.length > 24_000)) fail(400, "invalid_signal", "Invalid session description.");
  if (kind === "ice" && (typeof data.candidate !== "string" || data.candidate.length > 4_000)) fail(400, "invalid_signal", "Invalid connection candidate.");
  const serialized = JSON.stringify(payload);
  if (serialized.length > 24_576) fail(413, "signal_too_large", "This signal is too large.");
  return { kind, serialized };
}
export async function handleSignals(request: Request, db?: D1Database) {
  return api(async () => {
    const database = db!; const params = new URL(request.url).searchParams;
    const body = request.method === "POST" ? await readBody(request) : null;
    if (request.method !== "GET" && request.method !== "POST") return reply({ error: "Method not allowed" }, 405);
    const room = await findRoom(database, roomCode(body?.room ?? params.get("room")));
    const me = await member(request, room); active(room);
    await rate(database, request.method === "GET" ? "read" : "write", me.hash, request.method === "GET" ? 100 : 180);
    await renew(database, room, me);
    if (body) {
      const signal = validateSignal(body.kind, body.payload);
      const recipient = me.role === "host" ? room.guest_id : room.host_id;
      if (!recipient) return reply({ queued: false, room: publicRoom(room) });
      // Membership AND exact recipient are rechecked to prevent a concurrent leave/rejoin leak.
      const result = await database.prepare(`INSERT INTO private_signals (room_code,recipient_id,sender_id,generation,kind,payload,created_at)
        SELECT code,?,?,generation,?,?,? FROM private_rooms WHERE code=? AND closed=0 AND expires_at>?
        AND ((host_hash=? AND host_id=? AND guest_id=?) OR (guest_hash=? AND guest_id=? AND host_id=?))`)
        .bind(recipient, me.id, signal.kind, signal.serialized, Date.now(), room.code, Date.now(), me.hash, me.id, recipient, me.hash, me.id, recipient).run();
      if (!result.meta.changes) fail(409, "peer_changed", "The other person left this room. Reconnect to continue.");
      return reply({ id: result.meta.last_row_id, queued: true, room: publicRoom(room) }, 201);
    }
    if (params.get("fresh") === "1") {
      const cursor = await database.prepare("SELECT COALESCE(MAX(id),0) AS last FROM private_signals WHERE room_code=? AND recipient_id=?").bind(room.code, me.id).first<{last:number}>();
      return reply({ signals: [], after: cursor?.last || 0, room: publicRoom(room) });
    }
    const after = Number(params.get("after") || 0);
    if (!Number.isSafeInteger(after) || after < 0) fail(400, "invalid_cursor", "Invalid signaling cursor.");
    const result = await database.prepare(`SELECT s.id,s.sender_id AS sender,s.kind,s.payload,s.generation FROM private_signals s
      JOIN private_rooms r ON r.code=s.room_code WHERE s.room_code=? AND s.recipient_id=? AND s.id>?
      AND s.generation=r.generation AND r.closed=0 AND r.expires_at>? AND ((r.host_hash=? AND r.host_id=?) OR (r.guest_hash=? AND r.guest_id=?))
      ORDER BY s.id ASC LIMIT 100`).bind(room.code, me.id, after, Date.now(), me.hash, me.id, me.hash, me.id)
      .all<{ id: number; sender: string; kind: string; payload: string; generation: number }>();
    return reply({ signals: result.results.map(row => ({ ...row, payload: JSON.parse(row.payload) })), room: publicRoom(room) });
  }, db);
}
