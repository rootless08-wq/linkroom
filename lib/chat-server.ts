/** Small-trial adapter. D1 is the shared authority across Worker instances.
 * Replace this module with a Redis/DO coordinator when traffic grows. */
export type Guest = { id: string; state: string; partner: string | null; room: string | null; last_partner: string | null; seen: number };
export type Command = { type?: string; room?: string; kind?: string; payload?: unknown; reason?: string };
const lease = 45_000;
const cookieName = "lr_guest";
export const reasons = ["Nudity or sexual content", "Harassment or hate", "Spam or scam", "Underage user", "Other"];

export async function identity(request: Request) {
  const token = request.headers.get("Cookie")?.split(";").map(s => s.trim()).find(s => s.startsWith(cookieName + "="))?.slice(cookieName.length + 1);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  return hash(token);
}
async function hash(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), b => b.toString(16).padStart(2, "0")).join("");
}
export function sameOrigin(request: Request) {
  return request.headers.get("Origin") === new URL(request.url).origin;
}
export async function initialize(request: Request, db: D1Database) {
  let id = await identity(request);
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (!id) {
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("");
    id = await hash(token);
    headers.set("Set-Cookie", `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`);
  }
  await db.prepare("INSERT OR IGNORE INTO chat_guests (id, seen) VALUES (?, ?)").bind(id, Date.now()).run();
  return Response.json({ ready: true }, { headers });
}
export async function guest(db: D1Database, id: string) {
  return db.prepare("SELECT id,state,partner,room,last_partner,seen FROM chat_guests WHERE id=?").bind(id).first<Guest>();
}
async function match(db: D1Database, id: string) {
  const room = crypto.randomUUID();
  const now = Date.now();
  // D1 batch is transactional: only one competing join can claim a waiting guest.
  await db.batch([
    db.prepare(`UPDATE chat_guests SET partner=?, room=?, state='matched' WHERE id=(
      SELECT candidate.id FROM chat_guests candidate JOIN chat_guests me ON me.id=?
      WHERE me.state='waiting' AND candidate.state='waiting' AND candidate.id<>me.id
      AND candidate.seen>? AND candidate.id<>COALESCE(me.last_partner,'')
      AND me.id<>COALESCE(candidate.last_partner,'')
      AND NOT EXISTS(SELECT 1 FROM chat_blocks WHERE (owner=me.id AND target=candidate.id) OR (owner=candidate.id AND target=me.id))
      ORDER BY candidate.queued, candidate.id LIMIT 1
    )`).bind(id, room, id, now - lease),
    db.prepare(`UPDATE chat_guests SET partner=(SELECT id FROM chat_guests WHERE partner=? AND room=?), room=?, state='matched'
      WHERE id=? AND state='waiting' AND EXISTS(SELECT 1 FROM chat_guests WHERE partner=? AND room=?)`).bind(id, room, room, id, id, room),
  ]);
}
export async function leave(db: D1Database, id: string, queueAgain = false) {
  const now = Date.now();
  await db.batch([
    db.prepare("UPDATE chat_guests SET last_partner=?, partner=NULL, room=NULL, state='waiting', queued=? WHERE partner=? AND state='matched'").bind(id, now, id),
    db.prepare("UPDATE chat_guests SET last_partner=COALESCE(partner,last_partner), partner=NULL, room=NULL, state=?, seen=?, queued=? WHERE id=?").bind(queueAgain ? "waiting" : "idle", now, now, id),
  ]);
}
async function limit(db: D1Database, id: string) {
  const now = Date.now();
  const result = await db.prepare(`UPDATE chat_guests SET rate_count=CASE WHEN rate_start<? THEN 1 ELSE rate_count+1 END,
    rate_start=CASE WHEN rate_start<? THEN ? ELSE rate_start END WHERE id=? AND (rate_start<? OR rate_count<180)`).bind(now-60_000, now-60_000, now, id, now-60_000).run();
  if (!result.meta.changes) throw new Error("Too many requests. Please wait a minute.");
}
export async function command(db: D1Database, id: string, body: Command) {
  if (!body || typeof body.type !== "string") throw new Error("Invalid command");
  await limit(db, id);
  if (body.type === "join") { await leave(db, id, true); await match(db, id); return {}; }
  if (body.type === "stop") { await leave(db, id); return {}; }
  const me = await guest(db, id);
  if (!me || me.state !== "matched" || !me.partner || body.room !== me.room) throw new Error("This chat has ended");
  if (body.type === "signal") {
    if (!["offer", "answer", "ice"].includes(body.kind || "")) throw new Error("Invalid signal");
    const payload = JSON.stringify(body.payload);
    if (!payload || payload.length > 24_000) throw new Error("Invalid signal");
    // Membership is rechecked in the write, so a concurrent Next cannot leak to a new room.
    await db.prepare(`INSERT INTO chat_signals(recipient,room,kind,payload,created)
      SELECT partner,room,?,?,? FROM chat_guests WHERE id=? AND room=? AND state='matched'`).bind(body.kind, payload, Date.now(), id, body.room).run();
    return {};
  }
  if (body.type === "block" || body.type === "report") {
    if (body.type === "report" && !reasons.includes(body.reason || "")) throw new Error("Choose a report reason");
    const reportId = crypto.randomUUID();
    const statements = [db.prepare("INSERT OR IGNORE INTO chat_blocks(owner,target,created) VALUES(?,?,?)").bind(id, me.partner, Date.now())];
    if (body.type === "report") statements.push(db.prepare("INSERT INTO chat_reports(id,reporter,target,room,reason,created) VALUES(?,?,?,?,?,?)").bind(reportId,id,me.partner,me.room,body.reason,Date.now()));
    await db.batch(statements);
    await leave(db, id, true);
    await match(db, id);
    return body.type === "report" ? { reportId } : { blocked: true };
  }
  throw new Error("Unknown command");
}
export async function snapshot(db: D1Database, id: string, after = 0) {
  const now = Date.now();
  await db.batch([
    db.prepare("UPDATE chat_guests SET seen=? WHERE id=?").bind(now, id),
    db.prepare(`UPDATE chat_guests SET last_partner=partner,partner=NULL,room=NULL,state='waiting',queued=?
      WHERE id=? AND state='matched' AND NOT EXISTS(SELECT 1 FROM chat_guests p WHERE p.id=chat_guests.partner AND p.seen>?)`).bind(now,id,now-lease),
  ]);
  let me = await guest(db,id);
  if (!me) throw new Error("Start a new chat");
  if (me.state === "waiting") { await match(db,id); me = await guest(db,id); }
  const result = me?.room ? await db.prepare("SELECT id,room,kind,payload FROM chat_signals WHERE recipient=? AND id>? AND room=? ORDER BY id LIMIT 100").bind(id,after,me.room).all<{id:number;room:string;kind:string;payload:string}>() : {results:[]};
  return { type: "state", state: me?.state, room: me?.room, initiator: me?.partner ? id < me.partner : false,
    signals: result.results.map(s => ({...s,payload:JSON.parse(s.payload)})) };
}
export async function cleanup(db: D1Database) {
  await db.batch([
    db.prepare("DELETE FROM chat_signals WHERE created<?").bind(Date.now()-10*60_000),
    db.prepare("DELETE FROM chat_guests WHERE seen<?").bind(Date.now()-24*60*60_000),
  ]);
}
