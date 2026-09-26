"use client";
/* Full navigation ends the active media session before leaving the call. */
/* eslint-disable @next/next/no-html-link-for-pages */
import { useEffect, useState } from "react";
import { Video, Lock, Link2, Copy, Check, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CallStage } from "@/components/call-stage";
import { PrivateChat, initialPrivateView, type PrivateView } from "@/lib/private-client";
export default function PrivateRoom() {
  const [view,setView]=useState<PrivateView>(initialPrivateView); const [controller]=useState(()=>new PrivateChat(setView));
  const [invitation,setInvitation]=useState(""),[copied,setCopied]=useState(false),[copyError,setCopyError]=useState("");
  useEffect(()=>{
    const chat=controller;
    const code=new URLSearchParams(location.search).get("room");
    // The URL fragment only exists in the browser after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if(location.hash.includes("invite=")) setInvitation(location.href);
    else if(code) void chat.resume(code).then(resumed=>{if(!resumed)setInvitation(location.href);});
    const hide=()=>chat.suspend(); window.addEventListener("pagehide",hide);
    return()=>{window.removeEventListener("pagehide",hide);chat.suspend();};
  },[controller]);
  async function copy() {
    try {await navigator.clipboard.writeText(view.inviteUrl);setCopied(true);setCopyError("");setTimeout(()=>setCopied(false),2500);}
    catch {setCopyError("Select and copy the invitation below.");}
  }
  const active=!!view.room && !["error","ended","idle"].includes(view.phase);
  const invite=view.inviteUrl&&<div className="invitation-bar"><div><span className="eyebrow"><Lock/>Invitation only</span><strong>{view.room}</strong><small>Invite valid until {new Date(view.inviteExpiresAt).toLocaleString(undefined,{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})}. Active calls can continue.</small></div><Button variant="outline" onClick={()=>void copy()}>{copied?<Check/>:<Copy/>}{copied?"Copied":"Copy invite"}</Button>{copyError&&<label className="copy-fallback">{copyError}<Input readOnly value={view.inviteUrl} onFocus={event=>event.target.select()} aria-label="Invitation link"/></label>}</div>;
  return <main className={`app-shell ${active?"live-active":""}`}>
    <header className="topbar"><a className="brand" href="/"><span className="brand-mark"><Video/></span>LinkRoom</a><div className="top-status"><span className={`status-dot ${view.phase==="connected"?"connected":""}`}/>Your own corner of the internet</div><a className="privacy-pill" href="/"><ArrowRight/>Random chat</a></header>
    {active?<CallStage controller={controller} view={view} mode="private" onStop={()=>void controller?.stop()} busy={view.busy}>{invite}</CallStage>:<section className="home-grid">
      <div className="home-intro"><span className="eyebrow"><Lock/>A little more personal</span><h1>Your people.<br/><em>Your room.</em></h1><p>Make time for a familiar face. Share a private invitation, bring a reaction, and catch up together.</p><div className="trust-row"><span><Video/>Video effects</span><span><Link2/>Private invitations</span><span><Lock/>Two people, one room</span></div></div>
      <div className="join-panel"><div className="private-panel random-start"><div className="panel-heading"><div><span className="eyebrow">Free private calls</span><h2>{view.room?"Your room is saved":"Make yourself at home"}</h2></div></div>
        {view.room?<><p>Your invitation is saved in this tab. Allow camera access to continue.</p>{invite}<Button className="primary-action" disabled={view.busy} onClick={()=>void controller?.retry()}><Video/>Retry camera and connect</Button><Button variant="outline" className="primary-action" disabled={view.busy} onClick={()=>void controller?.stop()}>Close room session</Button></>:<>
        <p>Create a room and send the invitation to someone you know.</p><Button className="primary-action" disabled={view.busy} onClick={()=>void controller?.create()}><Video/>{view.busy?"Opening…":"Create a room"}</Button>
        <div className="divider"><span>Already have an invitation?</span></div><form onSubmit={event=>{event.preventDefault();void controller?.join(invitation);}}><label className="field-label" htmlFor="invite-link">Invitation link</label><Input id="invite-link" type="text" value={invitation} onChange={event=>setInvitation(event.target.value)} placeholder="Paste your complete invitation link" autoComplete="off" spellCheck={false}/><Button className="primary-action" variant="outline" type="submit" disabled={view.busy||!invitation.trim()}><Link2/>Join room</Button></form></>}
        <p className={view.phase==="error"?"error-message":"permission-note"} role="status">{view.status}</p><p className="safety-note">Invitation links admit one guest. Share them privately. You choose which files to receive; calls and shared files aren’t stored by LinkRoom.</p>
      </div></div>
    </section>}
    <footer className="app-footer"><span>Human connections. A little closer.</span><span>Be kind. Stay in control.</span></footer>
  </main>;
}
