import { CallMedia, callError, initialView, type CallView } from "./call-media";
type Participant = { id:string; token:string; role:"host"|"guest" };
type Room = { code:string; expiresAt:number; inviteExpiresAt:number; guestPresent:boolean; generation:number };
type Membership = { room:Room; participant:Participant; invite?:string };
export type PrivateView = CallView & { role:"host"|"guest"|null; inviteUrl:string; inviteExpiresAt:number; busy:boolean };
export const initialPrivateView = ():PrivateView => ({...initialView(),role:null,inviteUrl:"",inviteExpiresAt:0,busy:false});
class RoomError extends Error { constructor(message:string,readonly status:number) { super(message); } }
export function parseInvitation(value:string,origin:string) {
  const url = new URL(value,origin);
  const code = (url.searchParams.get("room") || "").toUpperCase();
  const invite = new URLSearchParams(url.hash.slice(1)).get("invite") || "";
  if (/^[A-Z0-9]{6}$/.test(code)) throw new Error("This is an older invitation. Ask the host for a new link.");
  if (!/^[A-Z2-9]{8}$/.test(code) || !/^[A-Za-z0-9_-]{43}$/.test(invite)) throw new Error("Paste the complete invitation link from your host.");
  return {code,invite};
}
export class PrivateChat extends CallMedia {
  declare state:PrivateView;
  private membership:Membership|null = null;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private after = 0;
  private session = "";
  private peerSession = "";
  private ice:RTCIceCandidateInit[] = [];
  private restarts = 0;
  private generation = 0;
  private closing = false;
  constructor(changed:(view:PrivateView)=>void) { super(view=>changed(view as PrivateView)); this.state=initialPrivateView(); }
  private publish(patch:Partial<PrivateView>) { this.state={...this.state,...patch}; this.update({}); }
  private async request(path:string,body?:unknown,credentials=this.membership,keepalive=false) {
    const response = await fetch(path,{method:body?"POST":"GET",cache:"no-store",
      headers:{...(body?{"Content-Type":"application/json"}:{}),...(credentials?{Authorization:`Bearer ${credentials.participant.token}`}:{})},
      ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(12000),keepalive});
    const data = await response.json() as Membership & { error?:string; after:number; signals:{ id:number; kind:string; payload:RTCSessionDescriptionInit & RTCIceCandidateInit & {session?:string;to?:string;reconnect?:boolean} }[] };
    if (!response.ok) throw new RoomError(data.error || "Room service unavailable. Try again shortly.",response.status);
    return data;
  }
  private remember() {
    if (!this.membership) return;
    try { sessionStorage.setItem(`linkroom:${this.membership.room.code}`,JSON.stringify(this.membership)); } catch { /* Calls still work with browser storage disabled. */ }
  }
  private adopt(data:Membership) {
    this.membership=data; this.generation=data.room.generation; this.remember();
    const inviteUrl=data.invite?`${location.origin}/private?room=${data.room.code}#invite=${data.invite}`:"";
    this.publish({room:data.room.code,role:data.participant.role,inviteUrl,inviteExpiresAt:data.room.inviteExpiresAt});
    history.replaceState(null,"",`/private?room=${data.room.code}`);
  }
  async create() { await this.enter(async()=>this.request("/api/rooms",{action:"create"},null)); }
  async join(value:string) {
    await this.enter(async()=>{
      const {code,invite}=parseInvitation(value,location.origin);
      const saved=this.saved(code);
      if (saved) {
        try { const result=await this.request(`/api/rooms?code=${code}`,undefined,saved); return {...saved,...result,participant:{...saved.participant,...result.participant}}; }
        catch(error) { if (!(error instanceof RoomError) || ![401,403,404,410].includes(error.status)) throw error; }
      }
      const data=await this.request("/api/rooms",{action:"join",code,invite},null);
      return {...data,invite};
    });
  }
  private saved(code:string):Membership|null {
    try { const data=JSON.parse(sessionStorage.getItem(`linkroom:${code}`)||"null"); return data?.room?.code===code && typeof data?.participant?.token==="string"?data:null; } catch { return null; }
  }
  async resume(code:string) {
    const saved=this.saved(code); if (!saved) return false;
    await this.enter(async()=>{
      const result=await this.request(`/api/rooms?code=${encodeURIComponent(code)}`,undefined,saved);
      return {...saved,...result,participant:{...saved.participant,...result.participant}};
    }); return true;
  }
  private async enter(getMembership:()=>Promise<Membership>) {
    if (this.state.busy || this.active) return;
    this.active=true; const epoch=++this.epoch;
    this.publish({busy:true,phase:"starting",status:"Opening your room…"});
    try {
      const data=await getMembership();
      if (!this.current(epoch)) return;
      this.adopt(data);
      await this.connect(epoch);
    } catch(error) {
      if (this.current(epoch)) { this.active=false; this.releaseMedia(); this.publish({phase:"error",local:null,status:callError(error)}); }
    } finally { if (epoch===this.epoch) this.publish({busy:false}); }
  }
  async retry() {
    if (!this.membership || this.state.busy || this.active) return;
    this.active=true; const epoch=++this.epoch; this.publish({busy:true,phase:"starting",status:"Starting camera…"});
    try { await this.connect(epoch); }
    catch(error) { if (this.current(epoch)) { this.active=false; this.releaseMedia(); this.publish({phase:"error",local:null,status:callError(error)}); } }
    finally { if (epoch===this.epoch) this.publish({busy:false}); }
  }
  private async connect(epoch:number) {
    await this.acquireMedia(epoch); if (!this.current(epoch)) return;
    this.session=crypto.randomUUID(); this.peerSession=""; this.ice=[]; this.restarts=0;
    const fresh=await this.request(`/api/signals?room=${this.state.room}&fresh=1`);
    if (!this.current(epoch)) return;
    this.after=fresh.after; this.generation=fresh.room.generation;
    await this.signal("presence",{});
    if (!this.current(epoch)) return;
    this.publish({phase:"waiting",status:this.state.role==="host"?"Your room is ready. Share the invitation below.":"Waiting for your host’s camera…"});
    this.poll(epoch,0);
  }
  private signal(kind:string,payload:Record<string,unknown>) {
    return this.request("/api/signals",{room:this.state.room,kind,payload:{...payload,session:this.session,...(this.peerSession?{to:this.peerSession}:{})}});
  }
  private preparePeer(session:string) {
    this.peerSession=session; this.ice=[]; this.restarts=0;
    this.publish({phase:"connecting",status:"Connecting your private call…"});
    return this.makePeer((kind,payload)=>this.signal(kind,payload as Record<string,unknown>),()=>{
      if (this.state.role==="host" && this.restarts++<2) void this.offer(true).catch(error=>this.fail(error));
      else if (this.state.role==="guest" && this.restarts++<2) void this.signal("presence",{reconnect:true}).catch(error=>this.fail(error));
      else this.publish({status:"Could not reconnect. Stop and reopen your invitation, or try another network."});
    });
  }
  private async offer(restart=false) {
    const pc=this.pc; if (!pc || pc.signalingState!=="stable") return;
    const description=await pc.createOffer({iceRestart:restart}); await pc.setLocalDescription(description);
    if (this.pc===pc) await this.signal("offer",{type:description.type,sdp:description.sdp});
  }
  private poll(epoch:number,delay?:number) {
    clearTimeout(this.timer); if (!this.current(epoch)) return;
    this.timer=setTimeout(async()=>{
      let next:number|undefined;
      try {
        const data=await this.request(`/api/signals?room=${this.state.room}&after=${this.after}`);
        if (!this.current(epoch)) return;
        if (data.room.generation!==this.generation) { this.closePeer(); this.peerSession=""; this.generation=data.room.generation; }
        for (const row of data.signals) {
          if (!this.current(epoch)) return;
          const payload=row.payload || {};
          if (row.kind==="leave") { this.closePeer(); this.peerSession=""; this.publish({phase:"waiting",status:"Your guest left. You can share your invitation again."}); }
          else if (typeof payload.session==="string" && (!payload.to || payload.to===this.session)) {
            if (row.kind==="presence") {
              const changed=payload.session!==this.peerSession || !this.pc;
              if (changed) this.preparePeer(payload.session);
              if (this.state.role==="host" && (changed || payload.reconnect)) { if (changed) this.openChat(this.pc!); await this.offer(!changed); }
              else if (this.state.role==="guest" && changed) await this.signal("presence",{});
            } else if (row.kind==="offer" && this.state.role==="guest") {
              const pc=payload.session!==this.peerSession || !this.pc?this.preparePeer(payload.session):this.pc;
              await pc.setRemoteDescription({type:"offer",sdp:payload.sdp});
              for (const candidate of this.ice.splice(0)) await pc.addIceCandidate(candidate);
              const answer=await pc.createAnswer(); await pc.setLocalDescription(answer);
              if (this.pc===pc) await this.signal("answer",{type:answer.type,sdp:answer.sdp});
            } else if (row.kind==="ice" && this.state.role==="guest" && !this.peerSession) {
              this.preparePeer(payload.session); this.ice.push(payload);
            } else if (payload.session===this.peerSession && this.pc) {
              if (row.kind==="answer" && this.pc.signalingState==="have-local-offer") {
                await this.pc.setRemoteDescription({type:"answer",sdp:payload.sdp});
                for (const candidate of this.ice.splice(0)) await this.pc.addIceCandidate(candidate);
              } else if (row.kind==="ice") {
                if (this.pc.remoteDescription) await this.pc.addIceCandidate(payload);
                else if (this.ice.length<100) this.ice.push(payload);
              }
            }
          }
          this.after=Math.max(this.after,row.id);
        }
      } catch(error) {
        if (!this.current(epoch)) return;
        if (error instanceof RoomError && [401,403,404,410].includes(error.status)) {
          this.active=false; this.releaseMedia(); this.publish({phase:"error",local:null,status:error.message}); return;
        }
        this.fail(error); next=5000;
      }
      this.poll(epoch,next);
    },delay ?? (this.pc?.connectionState==="connected"?12000:900));
  }
  /** Page navigation keeps the room credentials valid, so refresh can reconnect. */
  suspend() { this.active=false; ++this.epoch; clearTimeout(this.timer); this.releaseMedia(); }
  async stop() {
    if (this.closing) return;
    this.closing=true;
    const membership=this.membership; this.suspend(); this.publish({busy:true,status:"Closing your room session…"});
    try {
      if (membership) await this.request("/api/rooms",{action:membership.participant.role==="host"?"end":"leave",code:membership.room.code},membership,true);
      if (membership) try { sessionStorage.removeItem(`linkroom:${membership.room.code}`); } catch {}
      this.membership=null; history.replaceState(null,"","/private");
      this.publish({...initialPrivateView(),phase:"ended",status:"You left. Your camera and microphone are off."});
    } catch(error) { this.publish({phase:"error",local:null,status:`Camera and microphone are off. ${callError(error)} Retry Stop to close the room.`}); }
    finally { this.closing=false; this.publish({busy:false}); }
  }
}
