import { env } from "cloudflare:workers";
import { handleRooms } from "@/lib/private-server";

export function GET(request: Request) { return handleRooms(request, env.DB); }
export function POST(request: Request) { return handleRooms(request, env.DB); }
