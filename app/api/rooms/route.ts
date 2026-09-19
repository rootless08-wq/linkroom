import { env } from "cloudflare:workers";

const roomPattern = /^[A-Z0-9]{6}$/;
const lifetimeMs = 2 * 60 * 60 * 1000;

export async function GET(request: Request) {
  const code = new URL(request.url).searchParams.get("code")?.toUpperCase() ?? "";
  if (!roomPattern.test(code)) return Response.json({ error: "Invalid room code" }, { status: 400 });
  if (!env.DB) return Response.json({ error: "Rooms are temporarily unavailable" }, { status: 503 });
  const room = await env.DB.prepare("SELECT code, expires_at AS expiresAt FROM rooms WHERE code = ? AND expires_at > ?")
    .bind(code, Date.now()).first<{ code: string; expiresAt: number }>();
  if (!room) return Response.json({ error: "Room not found or expired" }, { status: 404 });
  return Response.json({ room });
}

export async function POST(request: Request) {
  if (!env.DB) return Response.json({ error: "Rooms are temporarily unavailable" }, { status: 503 });
  const body = (await request.json()) as { code?: string };
  const code = body.code?.toUpperCase() ?? "";
  if (!roomPattern.test(code)) return Response.json({ error: "Invalid room code" }, { status: 400 });
  const now = Date.now();
  const expiresAt = now + lifetimeMs;
  await env.DB.prepare("DELETE FROM signals WHERE created_at < ?").bind(now - lifetimeMs).run();
  await env.DB.prepare("DELETE FROM rooms WHERE expires_at <= ?").bind(now).run();
  const result = await env.DB.prepare("INSERT OR IGNORE INTO rooms (code, created_at, expires_at) VALUES (?, ?, ?)")
    .bind(code, now, expiresAt).run();
  if (!result.meta.changes) return Response.json({ error: "Room code already exists" }, { status: 409 });
  return Response.json({ room: { code, expiresAt } }, { status: 201 });
}
