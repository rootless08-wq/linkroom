import { CallMedia, callError, initialView, type CallView } from "./call-media";
export type ViewState = CallView;
type Signal = { id: number; room: string; kind: string; payload: RTCSessionDescriptionInit | RTCIceCandidateInit };
type Snapshot = { type: string; state: string; room: string | null; initiator: boolean; signals: Signal[] };

export class RandomChat extends CallMedia {
  private socket: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pendingIce: RTCIceCandidateInit[] = [];
  private after = 0;
  private ignoredRoom = "";
  private serial = Promise.resolve();
  private actionPending = false;
  private requests = new Map<string, { resolve:(value:Record<string,unknown>)=>void; reject:(error:Error)=>void; timer:ReturnType<typeof setTimeout> }>();
  async start() {
    if (this.active) return;
    this.active = true; const epoch = ++this.epoch;
    this.update({ ...initialView(), phase:"starting", status:"Allow your camera and microphone to start" });
    try {
      await this.acquireMedia(epoch);
      if (!this.current(epoch)) return;
      const init = await fetch("/api/chat/init", { method:"POST", signal:AbortSignal.timeout(12000) });
      if (!init.ok) throw new Error("Could not reach LinkRoom. Please try again.");
      if (!this.current(epoch)) return;
      await this.openTransport(epoch);
      if (!this.current(epoch)) return;
      this.update({ phase:"waiting", status:"Looking for someone to chat with…" });
      await this.send({ type:"join" });
    } catch(error) {
      if (!this.current(epoch)) return;
      const stopped = this.stop(), stoppedEpoch = this.epoch;
      await stopped;
      if (this.epoch === stoppedEpoch) this.update({ phase:"error", status:callError(error) });
    }
  }
  private async openTransport(epoch:number) {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/chat/socket`); this.socket = ws;
    await new Promise<void>(resolve => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; clearTimeout(timeout); resolve(); } };
      const fallback = () => { if (this.socket === ws) this.socket = null; ws.close(); this.poll(epoch); done(); };
      const timeout = setTimeout(fallback, 3500);
      ws.onopen = done; ws.onerror = () => { if (!settled) fallback(); };
      ws.onclose = () => {
        if (this.socket === ws) {
          this.socket = null;
          for (const item of this.requests.values()) { clearTimeout(item.timer); item.reject(new Error("Connection interrupted. Please retry.")); }
          this.requests.clear();
        }
        if (this.current(epoch)) this.poll(epoch); done();
      };
      ws.onmessage = event => {
        if (!this.current(epoch)) return;
        let data; try { data = JSON.parse(event.data); } catch { return; }
        if (data.requestId) {
          const item = this.requests.get(data.requestId);
          if (item) { clearTimeout(item.timer); this.requests.delete(data.requestId); if (data.type === "error") item.reject(new Error(data.error)); else item.resolve(data); }
        } else if (data.type === "error") this.fail(new Error(data.error));
        if (data.type === "state") this.accept(data);
      };
    });
  }
  private poll(epoch:number) {
    clearTimeout(this.timer);
    if (!this.current(epoch) || this.socket?.readyState === WebSocket.OPEN) return;
    this.timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/chat?after=${this.after}`, { cache:"no-store", signal:AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error("Connection interrupted. Stop and try again.");
        const data = await response.json() as Snapshot;
        if (this.current(epoch)) this.accept(data);
      } catch(error) { if (this.current(epoch)) this.fail(error); }
      this.poll(epoch);
    }, this.state.phase === "connected" ? 5000 : 900);
  }
  private async send(body:Record<string,unknown>) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      const ws = this.socket, requestId = crypto.randomUUID();
      return new Promise<Record<string,unknown>>((resolve,reject) => {
        const timer = setTimeout(() => { this.requests.delete(requestId); reject(new Error("Chat request timed out. Try again.")); }, 10000);
        this.requests.set(requestId,{resolve,reject,timer});
        try { ws.send(JSON.stringify({...body,requestId})); } catch(error) { clearTimeout(timer); this.requests.delete(requestId); reject(error); }
      });
    }
    const response = await fetch("/api/chat", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body), signal:AbortSignal.timeout(12000) });
    const data = await response.json() as Record<string,unknown>;
    if (!response.ok) throw new Error(String(data.error || "Chat unavailable")); return data;
  }
  private accept(data:Snapshot) {
    const epoch = this.epoch;
    if (!Array.isArray(data.signals)) return;
    this.serial = this.serial.then(async () => {
      if (!this.current(epoch) || (data.room && data.room === this.ignoredRoom)) return;
      if (data.state === "waiting") {
        if (this.pc) this.closePeer();
        this.update({phase:"waiting",room:"",status:"Looking for someone to chat with…"}); return;
      }
      if (data.state !== "matched" || !data.room) return;
      if (this.state.room !== data.room || !this.pc) await this.joinPeer(data.room,data.initiator);
      const pc = this.pc; if (!pc) return;
      for (const signal of data.signals) {
        if (signal.id <= this.after || signal.room !== this.state.room || !this.current(epoch) || pc !== this.pc) continue;
        if (signal.kind === "ice") {
          if (pc.remoteDescription) await pc.addIceCandidate(signal.payload as RTCIceCandidateInit);
          else if (this.pendingIce.length < 100) this.pendingIce.push(signal.payload as RTCIceCandidateInit);
        } else if (signal.kind === "offer" || (signal.kind === "answer" && pc.signalingState === "have-local-offer")) {
          await pc.setRemoteDescription(signal.payload as RTCSessionDescriptionInit);
          for (const ice of this.pendingIce.splice(0)) await pc.addIceCandidate(ice);
          if (signal.kind === "offer") {
            const answer = await pc.createAnswer(); await pc.setLocalDescription(answer);
            if (this.pc === pc) await this.send({type:"signal",room:data.room,kind:"answer",payload:answer});
          }
        }
        this.after = Math.max(this.after,signal.id);
      }
    }).catch(error => { if (this.current(epoch)) this.fail(error); });
  }
  private async joinPeer(room:string,initiator:boolean) {
    this.pendingIce = []; let restarts = 0;
    this.update({phase:"connecting",room,status:"Someone is here. Connecting…"});
    const send = (kind:string,payload:unknown) => this.send({type:"signal",room,kind,payload});
    const pc = this.makePeer(send, () => {
      if (initiator && restarts++ < 2) void offer(true).catch(error => this.fail(error));
      else this.update({status:"Connection interrupted. Try Next or another network."});
    });
    const offer = async (restart = false) => {
      if (this.pc !== pc || pc.signalingState !== "stable") return;
      const description = await pc.createOffer({iceRestart:restart}); await pc.setLocalDescription(description);
      if (this.pc === pc) await send("offer",description);
    };
    if (initiator) { this.openChat(pc); await offer(); }
  }
  async next(action:"join"|"block"|"report" = "join",reason?:string) {
    if (!this.active || this.actionPending) return false;
    this.actionPending = true; const room = this.state.room, epoch = this.epoch;
    this.ignoredRoom = room; this.closePeer();
    this.update({phase:"waiting",room:"",status:"Looking for someone new…"});
    try { await this.send({type:action,room,reason}); return true; }
    catch(error) { if (this.current(epoch)) this.fail(error); return false; }
    finally { this.actionPending = false; }
  }
  async stop() {
    const wasActive = this.active; this.active = false; ++this.epoch; clearTimeout(this.timer); this.releaseMedia();
    const ws = this.socket; this.socket = null; if (ws) { ws.onmessage = null; ws.close(); }
    for (const item of this.requests.values()) { clearTimeout(item.timer); item.reject(new Error("Chat stopped")); } this.requests.clear();
    this.after = 0; this.ignoredRoom = ""; this.pendingIce = []; this.serial = Promise.resolve();
    this.update({...initialView(),status:"Chat stopped. Your camera and microphone are off."});
    if (wasActive) try {
      await fetch("/api/chat", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({type:"stop"}),keepalive:true,signal:AbortSignal.timeout(3000)});
    } catch { /* The server lease removes disconnected guests. */ }
  }
}
