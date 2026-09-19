import { env } from "cloudflare:workers";

const roomPattern = /^[A-Z0-9]{6}$/;
const clientPattern = /^[a-zA-Z0-9-]{8,64}$/;
const kinds = new Set(["presence", "offer", "answer", "ice", "leave"]);

export async function GET(request: Request) {
  if (!env.DB) return Response.json({ error: "Signaling is unavailable" }, { status: 503 });
  const params = new URL(request.url).searchParams;
  const room = params.get("room")?.toUpperCase() ?? "";
  const exclude = params.get("exclude") ?? "";
  const after = Math.max(0, Number(params.get("after") ?? 0) || 0);
  if (!roomPattern.test(room) || !clientPattern.test(exclude)) return Response.json({ error: "Invalid request" }, { status: 400 });
  const result = await env.DB.prepare(
    "SELECT id, sender_id AS sender, kind, payload FROM signals WHERE room_code = ? AND id > ? AND sender_id != ? ORDER BY id ASC LIMIT 100"
  ).bind(room, after, exclude).all<{ id: number; sender: string; kind: string; payload: string }>();
  const signals = result.results.map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
  return Response.json({ signals }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  if (!env.DB) return Response.json({ error: "Signaling is unavailable" }, { status: 503 });
  const body = (await request.json()) as { room?: string; sender?: string; kind?: string; payload?: unknown };
  const room = body.room?.toUpperCase() ?? "";
  const sender = body.sender ?? "";
  const kind = body.kind ?? "";
  const payload = JSON.stringify(body.payload ?? {});
  if (!roomPattern.test(room) || !clientPattern.test(sender) || !kinds.has(kind) || payload.length > 20_000) {
    return Response.json({ error: "Invalid signal" }, { status: 400 });
  }
  const active = await env.DB.prepare("SELECT code FROM rooms WHERE code = ? AND expires_at > ?").bind(room, Date.now()).first();
  if (!active) return Response.json({ error: "Room not found or expired" }, { status: 404 });
  const result = await env.DB.prepare(
    "INSERT INTO signals (room_code, sender_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(room, sender, kind, payload, Date.now()).run();
  return Response.json({ id: result.meta.last_row_id }, { status: 201 });
}
