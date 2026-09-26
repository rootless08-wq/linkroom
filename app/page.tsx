"use client";
/* Full navigation ends the active media session before leaving the call. */
/* eslint-disable @next/next/no-html-link-for-pages */
import { useEffect, useState } from "react";
import { Video, Shuffle, Lock, MessageSquare, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { CallStage } from "@/components/call-stage";
import { RandomChat, type ViewState } from "@/lib/random-client";
import { initialView } from "@/lib/call-media";

export default function Home() {
  const [view,setView]=useState<ViewState>(initialView); const [controller]=useState(()=>new RandomChat(setView));
  const [agreed,setAgreed]=useState(false),[busy,setBusy]=useState(false);
  const [report,setReport]=useState(false),[reason,setReason]=useState("Harassment or hate"),[notice,setNotice]=useState("");
  useEffect(()=>{
    if(new URLSearchParams(location.search).has("room")) { location.replace(`/private${location.search}${location.hash}`); return; }
    const chat=controller;
    const leave=()=>void chat.stop();window.addEventListener("pagehide",leave);
    return()=>{window.removeEventListener("pagehide",leave);void chat.stop();};
  },[controller]);
  const active=!["idle","error","ended"].includes(view.phase);
  async function next(action:"join"|"block"|"report"="join") {
    setBusy(true);
    try {const ok=await controller?.next(action,reason);if(ok&&action!=="join"){setReport(false);setNotice(action==="report"?"Report saved. This person is blocked for this browser.":"This person is blocked for this browser.");}}
    finally {setBusy(false);}
  }
  return <main className={`app-shell ${active?"live-active":""}`}>
    <header className="topbar"><a className="brand" href="/" aria-label="LinkRoom home"><span className="brand-mark"><Video/></span>LinkRoom</a><div className="top-status"><span className={`status-dot ${view.phase==="connected"?"connected":""}`}/>{active?"Random video chat":"A new conversation starts here"}</div><a className="privacy-pill" href="/private"><Lock/>Private room</a></header>
    {!active?<section className="home-grid">
      <div className="home-intro"><span className="eyebrow"><Shuffle/>Meet someone new</span><h1>One click.<br/><em>A new connection.</em></h1><p>A face, a hello, a little spark. Meet someone new through a one-to-one video chat, and move on whenever you like.</p><div className="trust-row"><span><Video/>Video + reactions</span><span><MessageSquare/>Chat + sharing</span><span><Lock/>No account needed</span></div></div>
      <div className="join-panel"><div className="private-panel random-start"><div className="panel-heading"><div><span className="eyebrow">Free to try</span><h2>Ready to say hello?</h2></div></div><p>Allow your camera and microphone. We’ll find someone who’s ready to chat.</p>
        <div className="consent"><Checkbox id="age-consent" checked={agreed} onCheckedChange={value=>setAgreed(value===true)}/><label htmlFor="age-consent">I’m 18 or older. I’ll be respectful and won’t share sexual content, harassment, or spam.</label></div>
        <Button size="lg" className="primary-action" disabled={!agreed||busy} onClick={()=>{setNotice("");void controller?.start();}}><Video/>Start Chat</Button>
        <p className={view.phase==="error"?"error-message":"permission-note"} role="status">{view.status}</p>
        <div className="divider"><span>Have someone in mind?</span></div><a className="private-link" href="/private"><Link2/>Create or join a private room</a>
        <p className="safety-note">Stop, report, or block at any time. LinkRoom doesn’t record calls. Other people can still capture your screen or see connection details.</p>
      </div></div>
    </section>:<CallStage controller={controller} view={view} mode="random" onStop={()=>void controller?.stop()} onNext={()=>void next()} onReport={()=>setReport(true)} onBlock={()=>void next("block")} busy={busy}>{notice&&<p className="inline-notice" role="status">{notice}</p>}</CallStage>}
    <footer className="app-footer"><span>Human connections. A little closer.</span><span>Be kind. Stay in control.</span></footer>
    <Dialog open={report} onOpenChange={setReport}><DialogContent><DialogHeader><DialogTitle>Report this person</DialogTitle><DialogDescription>The report will be saved and this person blocked for this browser. LinkRoom does not provide live moderation.</DialogDescription></DialogHeader><label className="field-label" htmlFor="report-reason">Reason</label><NativeSelect id="report-reason" value={reason} onChange={event=>setReason(event.target.value)}>{["Harassment or hate","Nudity or sexual content","Underage user","Spam or scam","Other"].map(value=><NativeSelectOption key={value}>{value}</NativeSelectOption>)}</NativeSelect><DialogFooter><Button variant="outline" onClick={()=>setReport(false)}>Cancel</Button><Button disabled={busy} onClick={()=>void next("report")}>Report and Next</Button></DialogFooter></DialogContent></Dialog>
  </main>;
}
