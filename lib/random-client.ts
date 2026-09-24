import { changeCamera } from "./camera";
export type ViewState = {
  phase: "idle" | "starting" | "waiting" | "connecting" | "connected" | "error";
  status: string; local: MediaStream | null; remote: MediaStream | null;
  mic: boolean; camera: boolean; switching: boolean; canText: boolean; room: string;
  messages: { from: "You" | "Stranger"; text: string }[];
};
type Signal = { id: number; room: string; kind: string; payload: RTCSessionDescriptionInit | RTCIceCandidateInit };
type Snapshot = { type: string; state: string; room: string | null; initiator: boolean; signals: Signal[] };
const initial = (): ViewState => ({phase:"idle",status:"Ready when you are",local:null,remote:null,mic:true,camera:true,switching:false,canText:false,room:"",messages:[]});

export class RandomChat {
  state = initial();
  private active = false;
  private epoch = 0;
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private socket: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private connectionTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingIce: RTCIceCandidateInit[] = [];
  private after = 0;
  private ignoredRoom = "";
  private serial = Promise.resolve();
  private requests = new Map<string, {resolve:(value:Record<string,unknown>)=>void; reject:(error:Error)=>void; timer:ReturnType<typeof setTimeout>}>();
  constructor(private changed: (state: ViewState) => void) {}
  private update(patch: Partial<ViewState>) { this.state={...this.state,...patch}; this.changed(this.state); }
  private fail(error: unknown) { this.update({status:error instanceof Error ? error.message : "Something went wrong. Please try again."}); }
  async start() {
    if (this.active) return;
    this.active=true; const epoch=++this.epoch;
    this.update({...initial(),phase:"starting",status:"Allow your camera and microphone to start"});
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera access needs HTTPS or localhost and a supported browser.");
      const media=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:960},height:{ideal:540},facingMode:"user"},audio:{echoCancellation:true,noiseSuppression:true}});
      if (!this.active || epoch!==this.epoch) { media.getTracks().forEach(t=>t.stop()); return; }
      this.update({local:media});
      const init=await fetch("/api/chat/init",{method:"POST"});
      if (!init.ok) throw new Error("Could not reach LinkRoom. Please try again.");
      if (!this.active || epoch!==this.epoch) return;
      await this.openTransport(epoch);
      if (!this.active || epoch!==this.epoch) return;
      this.update({phase:"waiting",status:"Looking for someone to chat with…"});
      await this.send({type:"join"});
    } catch(error) {
      if (epoch!==this.epoch) return;
      await this.stop();
      const name=error instanceof DOMException ? error.name : "";
      this.update({phase:"error",status:name==="NotAllowedError" ? "Camera or microphone access was denied. Allow access in your browser, then try again." : name==="NotFoundError" ? "No camera or microphone was found. Connect them and try again." : error instanceof Error ? error.message : "Could not start the call."});
    }
  }
  private async openTransport(epoch: number) {
    const ws=new WebSocket(`${location.protocol==="https:" ? "wss" : "ws"}://${location.host}/api/chat/socket`); this.socket=ws;
    await new Promise<void>(resolve=>{
      let settled=false;
      const done=()=>{if(!settled){settled=true;clearTimeout(timeout);resolve();}};
      const fallback=()=>{if(this.socket===ws)this.socket=null;ws.close();this.poll(epoch);done();};
      const timeout=setTimeout(fallback,4500);
      ws.onopen=done; ws.onerror=()=>{if(!settled)fallback();};
      ws.onclose=()=>{
        if(this.socket===ws)this.socket=null;
        for(const item of this.requests.values()){clearTimeout(item.timer);item.reject(new Error("Connection interrupted. Please retry."));}this.requests.clear();
        if(this.active&&epoch===this.epoch)this.poll(epoch);done();
      };
      ws.onmessage=event=>{
        if(!this.active||epoch!==this.epoch)return;
        const data=JSON.parse(event.data);
        if(data.requestId){const item=this.requests.get(data.requestId);if(item){clearTimeout(item.timer);this.requests.delete(data.requestId);if(data.type==="error")item.reject(new Error(data.error));else item.resolve(data);}}
        else if(data.type==="error")this.fail(new Error(data.error));
        if(data.type==="state")this.accept(data);
      };
    });
  }
  private poll(epoch: number) {
    clearTimeout(this.timer);
    if(!this.active||epoch!==this.epoch||this.socket?.readyState===WebSocket.OPEN)return;
    this.timer=setTimeout(async()=>{
      try{const response=await fetch(`/api/chat?after=${this.after}`,{cache:"no-store"});if(!response.ok)throw new Error("Connection interrupted. Stop and try again.");const data=await response.json() as Snapshot;if(this.active&&epoch===this.epoch)this.accept(data);}
      catch(error){if(this.active&&epoch===this.epoch)this.fail(error);}this.poll(epoch);
    },1500);
  }
  private async send(body: Record<string,unknown>) {
    if(this.socket?.readyState===WebSocket.OPEN){
      const requestId=crypto.randomUUID();
      return new Promise<Record<string,unknown>>((resolve,reject)=>{
        const timer=setTimeout(()=>{this.requests.delete(requestId);reject(new Error("Chat request timed out. Try again."));},10000);
        this.requests.set(requestId,{resolve,reject,timer});this.socket!.send(JSON.stringify({...body,requestId}));
      });
    }
    const response=await fetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    const data=await response.json() as Record<string,unknown>;if(!response.ok)throw new Error(String(data.error||"Chat unavailable"));return data;
  }
  private accept(data: Snapshot) {
    const epoch=this.epoch;
    this.serial=this.serial.then(async()=>{
      if(!this.active||epoch!==this.epoch)return;
      for(const s of data.signals)this.after=Math.max(this.after,s.id);
      if(data.room&&data.room===this.ignoredRoom)return;
      if(data.state==="waiting"){if(this.pc)this.closePeer();if(this.state.phase!=="waiting")this.update({phase:"waiting",room:"",status:"Looking for someone to chat with…"});return;}
      if(data.state!=="matched"||!data.room)return;
      if(this.state.room!==data.room||!this.pc)await this.makePeer(data.room,data.initiator);
      const pc=this.pc;if(!pc)return;
      for(const signal of data.signals){
        if(signal.room!==this.state.room||!this.active||pc!==this.pc)continue;
        if(signal.kind==="ice"){if(pc.remoteDescription)await pc.addIceCandidate(signal.payload as RTCIceCandidateInit);else this.pendingIce.push(signal.payload as RTCIceCandidateInit);}
        else if(!pc.remoteDescription){
          await pc.setRemoteDescription(signal.payload as RTCSessionDescriptionInit);
          for(const ice of this.pendingIce.splice(0))await pc.addIceCandidate(ice);
          if(signal.kind==="offer"){const answer=await pc.createAnswer();await pc.setLocalDescription(answer);await this.send({type:"signal",room:data.room,kind:"answer",payload:answer});}
        }
      }
    }).catch(error=>{if(this.active&&epoch===this.epoch)this.fail(error);});
  }
  private async makePeer(room: string, initiator: boolean) {
    this.closePeer();this.update({phase:"connecting",room,messages:[],status:"Someone is here. Connecting…"});
    // Add short-lived TURN credentials here when a relay is configured.
    const pc=new RTCPeerConnection({iceServers:[{urls:"stun:stun.l.google.com:19302"},{urls:"stun:stun.cloudflare.com:3478"}]});this.pc=pc;
    this.state.local?.getTracks().forEach(track=>pc.addTrack(track,this.state.local!));
    pc.onicecandidate=event=>{if(event.candidate&&this.pc===pc)void this.send({type:"signal",room,kind:"ice",payload:event.candidate.toJSON()}).catch(error=>this.fail(error));};
    pc.ontrack=event=>{if(this.pc===pc)this.update({remote:event.streams[0]||new MediaStream([event.track])});};
    pc.onconnectionstatechange=()=>{
      if(this.pc!==pc)return;
      if(pc.connectionState==="connected"){clearTimeout(this.connectionTimer);this.update({phase:"connected",status:"Connected · Say hello"});}
      if(pc.connectionState==="failed")this.update({status:"This network could not connect directly. Try Next or another network."});
      if(pc.connectionState==="disconnected")this.update({status:"Connection interrupted. Reconnecting…"});
    };
    this.connectionTimer=setTimeout(()=>{if(this.pc===pc&&pc.connectionState!=="connected")this.update({status:"Connection is taking too long. Try Next or a different network."});},25000);
    pc.ondatachannel=event=>this.attachChannel(event.channel,pc);
    if(initiator){this.attachChannel(pc.createDataChannel("chat"),pc);const offer=await pc.createOffer();await pc.setLocalDescription(offer);if(this.pc===pc)await this.send({type:"signal",room,kind:"offer",payload:offer});}
  }
  private attachChannel(channel: RTCDataChannel, pc: RTCPeerConnection) {
    this.channel=channel;
    channel.onopen=()=>{if(this.pc===pc)this.update({canText:true});};channel.onclose=()=>{if(this.pc===pc)this.update({canText:false});};
    channel.onmessage=event=>{if(this.pc!==pc||typeof event.data!=="string"||event.data.length>2000)return;this.update({messages:[...this.state.messages.slice(-199),{from:"Stranger",text:event.data}]});};
  }
  text(message: string) {
    const clean=message.trim().slice(0,2000);if(!clean||this.channel?.readyState!=="open"||this.channel.bufferedAmount>64000)return false;
    this.channel.send(clean);this.update({messages:[...this.state.messages.slice(-199),{from:"You",text:clean}]});return true;
  }
  async next(action: "join" | "block" | "report" = "join", reason?: string) {
    if(!this.active)return false;const room=this.state.room;this.ignoredRoom=room;this.closePeer();
    this.update({phase:"waiting",room:"",status:"Looking for someone new…",messages:[]});
    try{await this.send({type:action,room,reason});return true;}catch(error){this.fail(error);return false;}
  }
  mute(){const mic=!this.state.mic;this.state.local?.getAudioTracks().forEach(t=>t.enabled=mic);this.update({mic});}
  camera(){const camera=!this.state.camera;this.state.local?.getVideoTracks().forEach(t=>t.enabled=camera);this.update({camera});}
  async switchCamera() {
    const stream=this.state.local,epoch=this.epoch;if(!stream||this.state.switching)return;this.update({switching:true});
    try{
      await changeCamera(stream,()=>this.pc,()=>this.active&&epoch===this.epoch,()=>this.state.camera);
      if(!this.active||epoch!==this.epoch)return;
      this.update({local:new MediaStream(stream.getTracks()),status:"Camera switched"});
    }catch(error){if(this.active)this.fail(error);}finally{if(this.active)this.update({switching:false});}
  }
  private closePeer(){clearTimeout(this.connectionTimer);const pc=this.pc;this.pc=null;pc?.close();this.channel?.close();this.channel=null;this.pendingIce=[];this.update({remote:null,canText:false});}
  async stop() {
    const wasActive=this.active;this.active=false;++this.epoch;clearTimeout(this.timer);this.closePeer();this.state.local?.getTracks().forEach(t=>t.stop());
    this.socket?.close();this.socket=null;for(const item of this.requests.values()){clearTimeout(item.timer);item.reject(new Error("Chat stopped"));}this.requests.clear();
    this.after=0;this.ignoredRoom="";this.update({...initial(),status:"Chat stopped. Your camera and microphone are off."});
    if(wasActive){try{await fetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({type:"stop"}),keepalive:true});}catch{/* Lease expiration removes disconnected guests. */}}
  }
}
