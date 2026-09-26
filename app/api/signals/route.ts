import { env } from "cloudflare:workers";
import { handleSignals } from "@/lib/private-server";

export function GET(request: Request) { return handleSignals(request, env.DB); }
export function POST(request: Request) { return handleSignals(request, env.DB); }
