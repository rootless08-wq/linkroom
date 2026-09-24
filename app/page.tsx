"use client";
import { useEffect, useRef, useState } from "react";
import { Video, Shuffle, Mic, MicOff, Camera, CameraOff, SwitchCamera, PhoneOff, Flag, Ban, Send, Lock, MessageSquare, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { RandomChat, type ViewState } from "@/lib/random-client";

function Feed({stream,muted=false}: {stream:MediaStream|null;muted?:boolean}) {
  const ref=useRef<HTMLVideoElement>(null);
  useEffect(()=>{if(ref.current){ref.current.srcObject=stream;if(stream)void ref.current.play().catch(()=>{});}},[stream]);
  return <video ref={ref} autoPlay playsInline muted={muted} aria-label={muted ? "Your camera" : "Stranger's camera"}/>;
}
export default function Home() {
  const controller=useRef<RandomChat|null>(null);
  const [view,setView]=useState<ViewState>({phase:"idle",status:"Ready when you are",local:null,remote:null,mic:true,camera:true,switching:false,canText:false,room:"",messages:[]});
  const [agreed,setAgreed]=useState(false), [draft,setDraft]=useState(""), [busy,setBusy]=useState(false);
  const [report,setReport]=useState(false), [reason,setReason]=useState("Harassment or hate"), [notice,setNotice]=useState("");
  const messageEnd=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    if(new URLSearchParams(location.search).has("room")){location.replace(`/private${location.search}`);return;}
    const chat=new RandomChat(setView);controller.current=chat;
    const leave=()=>void chat.stop();window.addEventListener("pagehide",leave);
    return()=>{window.removeEventListener("pagehide",leave);void chat.stop();controller.current=null;};
  },[]);
  useEffect(()=>{messageEnd.current?.scrollIntoView({block:"nearest"});},[view.messages]);
  const active=!["idle","error"].includes(view.phase);
  async function next(action:"join"|"block"|"report"="join") {
    setBusy(true);setDraft("");
    try {const ok=await controller.current?.next(action,reason);if(ok&&action!=="join"){setReport(false);setNotice(action==="report"?"Report saved for review. This person is blocked for this browser.":"This person is blocked for this browser.");}}
    finally{setBusy(false);}
  }
  return <main className={`app-shell ${active?"random-active":""}`}>
    <header className="topbar">
      <a className="brand" href="/" aria-label="LinkRoom home"><span className="brand-mark"><Video/></span>LinkRoom</a>
      <div className="top-status"><span className={`status-dot ${view.phase==="connected"?"connected":""}`}/>{active ? "Random video chat" : "A new conversation starts here"}</div>
      <span className="privacy-pill"><Lock/> Peer-to-peer</span>
    </header>
    {!active ? <section className="home-grid">
      <div className="home-intro"><span className="eyebrow"><Shuffle/> Meet someone new</span><h1>One click.<br/><em>A new connection.</em></h1><p>Meet someone at random for a one-to-one video chat. Say hello, share a moment, or move on whenever you like.</p><div className="trust-row"><span><Video/> Video + audio</span><span><MessageSquare/> Text chat</span><span><Lock/> No account needed</span></div></div>
      <div className="join-panel"><div className="private-panel random-start">
        <div className="panel-heading"><div><span className="eyebrow">Free to try</span><h2>Ready to say hello?</h2></div></div>
        <p>Allow your camera and microphone, and we’ll find someone who’s ready to chat.</p>
        <div className="consent"><Checkbox id="age-consent" checked={agreed} onCheckedChange={v=>setAgreed(v===true)}/><label htmlFor="age-consent">I’m 18 or older. I’ll be respectful and won’t share sexual content, harassment, or spam.</label></div>
        <Button size="lg" className="primary-action" disabled={!agreed||busy} onClick={()=>{setNotice("");void controller.current?.start();}}><Video/> Start Chat</Button>
        <p className={view.phase==="error"?"error-message":"permission-note"} role="status">{view.status}</p>
        <div className="divider"><span>Know who you want to call?</span></div>
        <a className="private-link" href="/private"><Link2/> Create or join a private room</a>
        <p className="safety-note">You can stop, report, or block at any time. Calls aren’t recorded by LinkRoom. Other people can still capture your screen or see connection details.</p>
      </div></div>
    </section> : <section className="random-stage" aria-label="Random video chat">
      <div className="session-heading"><div><span className="eyebrow">Random chat</span><p role="status" aria-live="polite">{view.status}</p></div><span className="session-badge">{view.phase==="connected"?"In conversation":view.phase==="waiting"?"In the queue":"Connecting"}</span></div>
      <div className="conversation-grid">
        <div className="video-arena">
          <div className="stranger-video"><Feed stream={view.remote}/>{!view.remote&&<div className="video-empty"><span className="signal-orbit"><Shuffle/></span><strong>{view.phase==="waiting"?"Finding your next conversation":"Getting things ready"}</strong><small>{view.phase==="waiting"?"You’ll connect when another person joins. Keep this tab open.":"Your camera stays in the small preview below."}</small></div>}<span className="video-label">{view.phase==="connected"?"Stranger":"Waiting for a match"}</span></div>
          <div className="local-preview"><Feed stream={view.local} muted/>{!view.camera&&<div className="camera-off"><CameraOff/><span>Camera off</span></div>}<span className="video-label">You{view.mic?"":" · Muted"}</span></div>
        </div>
        <aside className="text-chat" aria-label="Text chat"><div className="chat-heading"><MessageSquare/><h2>Chat</h2><span>Just this call</span></div>
          <div className="chat-messages" role="log" aria-live="polite">{!view.messages.length&&<p className="chat-empty">{view.canText?"Break the ice. Say hello!":"Messages will be available when you’re connected."}</p>}{view.messages.map((message,i)=><div className={`message ${message.from==="You"?"mine":""}`} key={i}><span>{message.from}</span><p>{message.text}</p></div>)}<div ref={messageEnd}/></div>
          <form className="message-form" onSubmit={event=>{event.preventDefault();if(controller.current?.text(draft))setDraft("");}}><Input aria-label="Message" placeholder="Say something…" maxLength={2000} value={draft} onChange={event=>setDraft(event.target.value)} disabled={!view.canText}/><Button type="submit" size="icon" aria-label="Send message" disabled={!view.canText||!draft.trim()}><Send/></Button></form>
        </aside>
      </div>
      <div className="random-toolbar" aria-label="Call controls">
        <div className="main-controls"><Button size="lg" onClick={()=>void next()} disabled={busy||view.phase==="starting"}><Shuffle/> Next</Button><Button variant="destructive" size="lg" onClick={()=>{setBusy(true);void controller.current?.stop().finally(()=>setBusy(false));}}><PhoneOff/> Stop</Button></div>
        <div className="media-controls"><Button variant="secondary" aria-pressed={!view.mic} onClick={()=>controller.current?.mute()} disabled={!view.local}>{view.mic?<Mic/>:<MicOff/>}{view.mic?"Mute":"Unmute"}</Button><Button variant="secondary" aria-pressed={!view.camera} onClick={()=>controller.current?.camera()} disabled={!view.local}>{view.camera?<Camera/>:<CameraOff/>}{view.camera?"Camera off":"Camera on"}</Button><Button variant="secondary" onClick={()=>void controller.current?.switchCamera()} disabled={!view.local||view.switching}><SwitchCamera/>{view.switching?"Switching…":"Switch camera"}</Button></div>
        <div className="safety-controls"><Button variant="ghost" onClick={()=>setReport(true)} disabled={!view.room||busy}><Flag/> Report</Button><Button variant="ghost" onClick={()=>void next("block")} disabled={!view.room||busy}><Ban/> Block</Button></div>
      </div>
      {notice&&<p className="action-notice" role="status">{notice}</p>}
    </section>}
    <footer className="app-footer"><span>© 2026 Jayant Adhikary</span><span>18+ · Be kind. Stay curious.</span></footer>
    <Dialog open={report} onOpenChange={setReport}><DialogContent><DialogHeader><DialogTitle>Report this conversation</DialogTitle><DialogDescription>Your report is saved for review. Submitting also blocks this person and moves you to the next chat. No video or chat transcript is attached.</DialogDescription></DialogHeader><label htmlFor="report-reason">What happened?</label><NativeSelect id="report-reason" value={reason} onChange={event=>setReason(event.target.value)}>{["Nudity or sexual content","Harassment or hate","Spam or scam","Underage user","Other"].map(value=><NativeSelectOption key={value}>{value}</NativeSelectOption>)}</NativeSelect><p className="safety-note">This is an early version; reports aren’t monitored live. Blocking applies while this browser keeps its guest cookie.</p><DialogFooter><Button variant="outline" onClick={()=>setReport(false)}>Cancel</Button><Button onClick={()=>void next("report")} disabled={busy||!view.room}>{busy?"Saving…":"Report and next"}</Button></DialogFooter></DialogContent></Dialog>
  </main>;
}

