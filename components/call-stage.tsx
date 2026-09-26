"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Camera, CameraOff, SwitchCamera, Mic, MicOff, PhoneOff, Shuffle, Flag, Ban, Sparkles, Video } from "lucide-react";
import { CallMedia, type CallView } from "@/lib/call-media";
import { type VideoEffect } from "@/lib/video-effects";
import { CallChatPanel, ChatToggleButton } from "./call-chat";
import { ReactionControls, ReactionOverlay } from "./call-reactions";
import { Button } from "./ui/button";

function Feed({stream,local=false,mirrored=false}:{stream:MediaStream|null;local?:boolean;mirrored?:boolean}) {
  const ref=useRef<HTMLVideoElement>(null), [needsPlay,setNeedsPlay]=useState(false);
  useEffect(()=>{
    const video=ref.current; if (!video) return;
    video.srcObject=stream;
    let valid=true;
    if(stream) void video.play().then(()=>{if(valid)setNeedsPlay(false);}).catch(()=>{if(valid)setNeedsPlay(true);});
    return()=>{valid=false;video.srcObject=null;};
  },[stream]);
  return <><video ref={ref} autoPlay playsInline muted={local} style={{transform:mirrored?"scaleX(-1)":"none"}} aria-label={local?"Your camera":"Other person’s camera"}/>{needsPlay&&stream&&<button className="play-video" onClick={()=>void ref.current?.play().then(()=>setNeedsPlay(false))}>Tap to play {local?"preview":"video and audio"}</button>}</>;
}
export function CallStage({controller,view,mode,onStop,onNext,onReport,onBlock,busy=false,children}:{controller:CallMedia;view:CallView;mode:"random"|"private";onStop:()=>void;onNext?:()=>void;onReport?:()=>void;onBlock?:()=>void;busy?:boolean;children?:ReactNode}) {
  const [chatOpen,setChatOpen]=useState(false),[effectsOpen,setEffectsOpen]=useState(false);
  const connected=view.phase==="connected";
  const effects:[VideoEffect,string][]=[["none","Original"],["warm","Warm"],["cool","Cool"],["mono","Mono"],["soft","Soft"]];
  return <section className="live-stage" aria-label={mode==="random"?"Random video chat":"Private video call"}>
    <div className="session-heading"><div><span className="eyebrow">{mode==="random"?"Meet someone new":"Just the two of you"}</span><p role="status" aria-live="polite">{view.status}</p></div><span className="session-badge"><span className={connected?"status-dot connected":"status-dot"}/>{connected?"Connected":view.phase==="waiting"?"Waiting":"Connecting"}</span></div>
    {children}
    <div className={`live-conversation ${chatOpen?"chat-is-open":""}`}>
      <div className="video-arena">
        <div className="stranger-video"><Feed stream={view.remote}/>{!view.remote&&<div className="video-empty"><span className="signal-orbit">{mode==="random"?<Shuffle/>:<Video/>}</span><strong>{view.phase==="waiting"?(mode==="random"?"Finding your next conversation":"Your room is ready"):"Getting connected"}</strong><small>{mode==="random"?"We’ll connect you when another person joins.":"Keep this tab open and share your invitation."}</small></div>}<span className="video-label">{connected?(mode==="random"?"Stranger":"Your guest"):"Waiting for someone"}</span></div>
        <div className="local-preview"><Feed stream={view.local} local mirrored={view.mirrored}/>{!view.camera&&<div className="camera-off"><CameraOff/><span>Camera off</span></div>}<span className="video-label">You{view.mic?"":" · Muted"}</span></div>
        <ReactionOverlay session={controller.chat}/>
        {effectsOpen&&<div className="effect-picker" role="group" aria-label="Video effects">{effects.map(([effect,label])=><button key={effect} aria-pressed={view.effect===effect} onClick={()=>void controller.setEffect(effect)}>{label}</button>)}<p>Shared with the other person</p></div>}
      </div>
      <CallChatPanel session={controller.chat} open={chatOpen} onClose={()=>setChatOpen(false)}/>
    </div>
    <div className="live-toolbar">
      <div className="media-tools">
        <button className={`call-tool ${view.mic?"":"is-off"}`} disabled={!view.local} aria-label={view.mic?"Mute microphone":"Unmute microphone"} aria-pressed={!view.mic} onClick={()=>controller.mute()}>{view.mic?<Mic/>:<MicOff/>}<span>{view.mic?"Mute":"Unmute"}</span></button>
        <button className={`call-tool ${view.camera?"":"is-off"}`} disabled={!view.local} aria-label={view.camera?"Turn camera off":"Turn camera on"} aria-pressed={!view.camera} onClick={()=>controller.camera()}>{view.camera?<Camera/>:<CameraOff/>}<span>Camera</span></button>
        <button className="call-tool" disabled={!view.local||view.switching} aria-label="Switch camera" onClick={()=>void controller.switchCamera()}><SwitchCamera/><span>{view.switching?"Switching…":"Flip"}</span></button>
        <button className="call-tool" disabled={!view.effectsSupported||!view.local} aria-expanded={effectsOpen} aria-label="Video effects" onClick={()=>setEffectsOpen(!effectsOpen)}><Sparkles/><span>Effects</span></button>
      </div>
      <div className="social-tools"><ReactionControls session={controller.chat}/><ChatToggleButton session={controller.chat} open={chatOpen} onClick={()=>setChatOpen(!chatOpen)}/></div>
      <div className="session-tools">{onReport&&<Button variant="ghost" size="icon" aria-label="Report this person" disabled={!view.room||busy} onClick={onReport}><Flag/></Button>}{onBlock&&<Button variant="ghost" size="icon" aria-label="Block this person" disabled={!view.room||busy} onClick={onBlock}><Ban/></Button>}{onNext&&<Button disabled={busy||!view.local} onClick={onNext}><Shuffle/>Next</Button>}<Button variant="destructive" onClick={onStop}><PhoneOff/><span>{mode==="random"?"Stop":"Leave"}</span></Button></div>
    </div>
  </section>;
}
