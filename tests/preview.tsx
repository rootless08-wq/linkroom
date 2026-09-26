import React,{useState} from "react";
import {createRoot} from "react-dom/client";
import Home from "../app/page";
import PrivateRoom from "../app/private/page";
import {PrivateChat,initialPrivateView} from "../lib/private-client";
import {VideoEffectsController} from "../lib/video-effects";
import {CallStage} from "../components/call-stage";
import "../app/globals.css";
class TestChat extends PrivateChat {
  diagnostic() { return [this.state.phase,this.state.status,this.pc?.connectionState,this.pc?.iceConnectionState,this.pc?.signalingState].join(" / "); }
  async outputIsTransmitted() {
    const sender=this.pc?.getSenders().find(sender=>sender.track?.kind==="video");
    if(!sender || sender.track!==this.effects?.stream.getVideoTracks()[0])return false;
    const stats=await sender.getStats();let frames=false;
    stats.forEach(report=>{if(report.type==="outbound-rtp"&&report.framesEncoded>0)frames=true;});return frames;
  }
  protected async acquireMedia(epoch:number) {
    const canvas=document.createElement("canvas");canvas.width=1280;canvas.height=720;
    const ctx=canvas.getContext("2d")!;let timer:ReturnType<typeof setInterval>;
    const draw=()=>{ctx.fillStyle="#145e63";ctx.fillRect(0,0,1280,720);ctx.fillStyle="#a6f5da";ctx.font="70px sans-serif";ctx.fillText("LinkRoom test video",100,320);ctx.fillText(new Date().toLocaleTimeString(),100,420);};draw();
    const stream=canvas.captureStream(24);const track=stream.getVideoTracks()[0];
    const stop=track.stop.bind(track);track.stop=()=>{clearInterval(timer);stop();};timer=setInterval(draw,80);
    const audio=new AudioContext(),oscillator=audio.createOscillator(),gain=audio.createGain(),dest=audio.createMediaStreamDestination();
    gain.gain.value=0;oscillator.connect(gain).connect(dest);oscillator.start();
    const audioTrack=dest.stream.getAudioTracks()[0],stopAudio=audioTrack.stop.bind(audioTrack);audioTrack.stop=()=>{stopAudio();void audio.close();};
    stream.addTrack(audioTrack);
    if(!this.current(epoch)){stream.getTracks().forEach(t=>t.stop());return;}
    this.raw=stream;this.effects=new VideoEffectsController(stream);this.update({local:this.effects.stream,effectsSupported:this.effects.supported});
  }
}
const wait=async(test:()=>boolean,message:string)=>{const end=Date.now()+35000;while(!test()){if(Date.now()>end)throw new Error(message);await new Promise(r=>setTimeout(r,100));}};
function Harness(){
 const [view,setView]=useState(initialPrivateView),[host]=useState(()=>new TestChat(setView)),[guest]=useState(()=>new TestChat(()=>{})),[result,setResult]=useState("Ready"),[running,setRunning]=useState(false);
 async function run(){
  setRunning(true);setResult("Connecting two real browser peers…");
  const originalFetch=window.fetch; let injected=false,creates=0;
  window.fetch=async(input,init)=>{
   if(String(input).includes("/api/rooms")&&typeof init?.body==="string"&&JSON.parse(init.body).action==="create")creates++;
   if(!injected&&String(input).includes("fresh=1")){injected=true;throw new DOMException("Simulated network timeout","TimeoutError");}
   return originalFetch(input,init);
  };
  try{
   await host.create();if(!host.state.inviteUrl||host.state.phase==="error")throw new Error(host.state.status);
   if(!injected||creates!==1)throw new Error("Startup retry repeated a room creation");
   sessionStorage.removeItem("linkroom:"+host.state.room);
   await guest.join(host.state.inviteUrl);
   await wait(()=>host.state.phase==="connected"&&guest.state.phase==="connected"&&host.chat.getSnapshot().connected,"Peers did not connect: "+host.state.status+" / "+guest.state.status);
   host.chat.sendText("Hello from the host");await wait(()=>guest.chat.getSnapshot().messages.some(m=>m.kind==="text"),"Text did not arrive");
   host.chat.react("🎉");await wait(()=>guest.chat.getSnapshot().reactions.length>0,"Reaction did not arrive");
   const bytes=new Uint8Array(80_000).map((_,i)=>i%251);host.chat.offerFile(new File([bytes],"test-bytes.bin"));
   await wait(()=>guest.chat.getSnapshot().messages.some(m=>m.kind==="file"),"File offer missing");
   const offered=guest.chat.getSnapshot().messages.find(m=>m.kind==="file")!;guest.chat.acceptFile(offered.id);
   await wait(()=>guest.chat.getSnapshot().messages.some(m=>m.kind==="file"&&m.status==="complete"),"Transfer incomplete");
   const received=guest.chat.getSnapshot().messages.find(m=>m.kind==="file"&&m.status==="complete");
   if(received?.kind!=="file"||!received.url)throw new Error("Missing file URL");
   const output=new Uint8Array(await (await fetch(received.url)).arrayBuffer());
   if(output.length!==bytes.length||output.some((b,i)=>b!==bytes[i]))throw new Error("File bytes differ");
   await host.setEffect("warm");if(host.state.effect!=="warm"||!await host.outputIsTransmitted())throw new Error("Effect transmission failed");
   host.mute();host.camera();if(host.state.mic||host.state.camera)throw new Error("Media toggles failed");host.mute();host.camera();
   const code=guest.state.room;guest.suspend();await guest.resume(code);
   await wait(()=>host.chat.getSnapshot().connected&&guest.chat.getSnapshot().connected,"Guest refresh did not reconnect");
   guest.chat.sendText("Reconnected");await wait(()=>host.chat.getSnapshot().messages.some(m=>m.kind==="text"&&m.text==="Reconnected"),"Reconnect text failed");
   setResult("PASS: startup timeout recovery, real WebRTC video/audio tracks, text, reaction, consented 80KB byte-perfect file transfer, transmitted effect, media toggles and guest refresh reconnect.");
  }catch(e){setResult("FAIL: "+String(e)+" Host: "+host.diagnostic()+" Guest: "+guest.diagnostic());}finally{window.fetch=originalFetch;setRunning(false);}
 }
 return <main className="app-shell live-active"><header className="topbar"><strong>Local synthetic-media check</strong><button disabled={running} onClick={()=>void run()}>Run integration check</button></header><CallStage controller={host} view={view} mode="private" onStop={()=>{void guest.stop();void host.stop();}}><p role="status">{result}</p></CallStage><footer className="app-footer">Generated media only · no physical camera or microphone</footer></main>;
}
createRoot(document.getElementById("root")!).render(location.pathname==="/__test"?<Harness/>:location.pathname==="/private"?<PrivateRoom/>:<Home/>);
