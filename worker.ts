import handler from "vinext/server/fetch-handler";
import { identity, sameOrigin, initialize, command, snapshot, cleanup } from "./lib/chat-server";

const worker = {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/chat")) return handler.fetch(request, env, ctx);
    if (!env.DB) return Response.json({ error: "Chat is temporarily unavailable" }, { status: 503 });
    const db = env.DB;
    try {
      if (url.pathname === "/api/chat/init" && request.method === "POST") {
        if (!sameOrigin(request)) return new Response("Forbidden", {status:403});
        ctx.waitUntil(cleanup(db).catch(() => {}));
        return initialize(request, db);
      }
      const id = await identity(request);
      if (!id) return Response.json({error:"Please start a new chat"},{status:401});
      if (url.pathname === "/api/chat/socket" && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
        if (!sameOrigin(request)) return new Response("Forbidden", {status:403});
        const pair = new WebSocketPair();
        const client = pair[0], server = pair[1];
        server.accept();
        let after = 0, closed = false, chain = Promise.resolve(), pending = 0;
        let timer: ReturnType<typeof setTimeout>;
        const send = (data: unknown) => { if (!closed) server.send(JSON.stringify(data)); };
        const enqueue = (task: () => Promise<void>) => {
          if (pending > 30) { server.close(1008, "Slow down"); return; }
          pending++;
          chain = chain.then(task).catch(() => { send({ type:"error", error:"Chat connection interrupted. Stop and try again." }); }).finally(() => { pending--; });
        };
        const poll = async () => {
          if (closed) return;
          const data = await snapshot(db,id,after);
          for (const signal of data.signals) after = Math.max(after,signal.id);
          send(data);
        };
        const tick = () => {
          enqueue(async () => { await poll(); if (!closed) timer = setTimeout(tick,1500); });
        };
        server.addEventListener("message", (event) => {
          if (typeof event.data !== "string" || event.data.length > 26_000) { server.close(1009,"Message too large"); return; }
          enqueue(async () => {
            let data;
            try { data = JSON.parse(event.data as string); } catch { send({type:"error",error:"Invalid message"}); return; }
            try { const result = await command(db,id,data); send({type:"ack", requestId:data.requestId,...result}); await poll(); }
            catch(error) { send({type:"error",requestId:data.requestId,error:error instanceof Error ? error.message : "Chat unavailable"}); }
          });
        });
        const close = () => { closed=true; clearTimeout(timer); };
        server.addEventListener("close",close); server.addEventListener("error",close);
        tick();
        return new Response(null,{status:101,webSocket:client});
      }
      if (url.pathname === "/api/chat" && request.method === "POST") {
        if (!sameOrigin(request)) return new Response("Forbidden", {status:403});
        const raw = await request.text();
        if (raw.length > 26_000) return new Response("Too large",{status:413});
        const result = await command(db,id,JSON.parse(raw));
        return Response.json(result,{headers:{"Cache-Control":"no-store"}});
      }
      if (url.pathname === "/api/chat" && request.method === "GET") {
        const after = Math.max(0,Number(url.searchParams.get("after"))||0);
        return Response.json(await snapshot(db,id,after),{headers:{"Cache-Control":"no-store"}});
      }
      return new Response("Not found",{status:404});
    } catch(error) {
      return Response.json({error:error instanceof Error ? error.message : "Chat temporarily unavailable"},{status:400,headers:{"Cache-Control":"no-store"}});
    }
  },
};
export default worker;
