"use client";
/* Media uses local blob URLs; an image optimizer would send private files to a server. */
/* eslint-disable @next/next/no-img-element */

import { File, Film, Image, MessageCircle, Music, Paperclip, Send, X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CallChat, type ChatMessage, fileSize, previewKind } from "@/lib/call-chat";
import "./call-chat.css";

export function useCallChat(session: CallChat) {
  return useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
}

export function ChatToggleButton({ session, open, onClick }: { session: CallChat; open: boolean; onClick: () => void }) {
  const state = useCallChat(session), count = open ? 0 : state.messages.filter(message => message.from === "Partner").length;
  return <button type="button" className={`chat-toggle ${open ? "is-active" : ""}`} onClick={onClick} aria-label={open ? "Close side chat" : `Open side chat${count ? `, ${count} messages received` : ""}`} aria-expanded={open} aria-controls="call-chat-panel"><MessageCircle aria-hidden="true" /><span>Chat</span>{count > 0 && <span className="chat-unread">{count > 99 ? "99+" : count}</span>}</button>;
}

function Attachment({ message, session }: { message: Extract<ChatMessage, { kind: "file" }>; session: CallChat }) {
  const kind = previewKind(message.mime), receiving = message.from === "Partner", ready = message.status === "complete" && Boolean(message.url);
  const status = message.status === "offered" ? receiving ? "Wants to send you a file" : "Waiting for them to accept"
    : message.status === "transferring" ? `${receiving ? "Receiving" : "Sending"} · ${Math.round(message.progress * 100)}%`
    : message.status === "complete" ? receiving ? "Received" : "Sent" : message.note || ({ declined: "Declined", cancelled: "Cancelled", failed: "Transfer failed", removed: "Attachment cleared" }[message.status] ?? message.status);
  return <div className="chat-attachment">
    <div className="attachment-heading"><File aria-hidden="true" /><div><strong>{message.name}</strong><span>{fileSize(message.size)} · {kind === "file" ? "Attachment" : message.mime === "image/gif" ? "GIF" : kind}</span></div></div>
    <small className="attachment-status">{status}</small>
    {message.status === "transferring" && <progress aria-label={`${receiving ? "Receiving" : "Sending"} ${message.name}`} max={1} value={message.progress} />}
    {message.status === "offered" && receiving && <><p className="attachment-consent">Receive this file to preview or save it. Open only files you trust.</p><div className="attachment-actions"><button type="button" onClick={() => session.acceptFile(message.id)} disabled={!session.getSnapshot().connected}>Receive file</button><button type="button" className="quiet" onClick={() => session.cancelFile(message.id)}>Decline</button></div></>}
    {((message.status === "offered" && !receiving) || message.status === "transferring") && <button className="attachment-cancel" type="button" onClick={() => session.cancelFile(message.id)}>Cancel transfer</button>}
    {ready && kind === "image" && <img className="attachment-preview" src={message.url} alt={message.name} loading="lazy" />}
    {ready && kind === "video" && <video className="attachment-preview" src={message.url} controls playsInline preload="metadata" />}
    {ready && kind === "audio" && <audio className="attachment-audio" src={message.url} controls preload="metadata" />}
    {ready && <a className="attachment-save" href={message.url} download={message.name}>Save file</a>}
  </div>;
}

const pickerOptions = [
  { label: "Photo", accept: "image/jpeg,image/png,image/webp,image/avif", icon: Image },
  { label: "Video", accept: "video/*", icon: Film },
  { label: "Audio", accept: "audio/*", icon: Music },
  { label: "GIF", accept: "image/gif", icon: Image },
  { label: "File", accept: "", icon: Paperclip },
] as const;

export function CallChatPanel({ session, open, onClose }: { session: CallChat; open: boolean; onClose: () => void }) {
  const state = useCallChat(session), [draft, setDraft] = useState({ generation: state.generation, text: "" }), [attachmentsGeneration, setAttachmentsGeneration] = useState<number | null>(null);
  const text = draft.generation === state.generation ? draft.text : "", showAttachments = attachmentsGeneration === state.generation && state.connected;
  const input = useRef<HTMLInputElement>(null), messages = useRef<HTMLDivElement>(null), close = useRef<HTMLButtonElement>(null), nearBottom = useRef(true);
  useEffect(() => { if (open && nearBottom.current && messages.current) messages.current.scrollTop = messages.current.scrollHeight; }, [state.messages, open]);
  useEffect(() => { if (open) close.current?.focus(); }, [open]);
  const closePanel = () => { setAttachmentsGeneration(null); onClose(); };
  const pick = (accept: string) => { if (input.current) { input.current.accept = accept; input.current.click(); } setAttachmentsGeneration(null); };
  const send = (event: React.FormEvent) => { event.preventDefault(); if (session.sendText(text)) { setDraft({ generation: state.generation, text: "" }); nearBottom.current = true; } };
  return <aside id="call-chat-panel" className="call-chat-panel" hidden={!open} aria-label="Side chat" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); closePanel(); } }}>
    <div className="chat-panel-heading"><div><h2>Side chat</h2><p>{state.connected ? "Just between you two" : "Available when the call connects"}</p></div><button ref={close} type="button" onClick={closePanel} aria-label="Close side chat"><X /></button></div>
    <div className="chat-message-list" ref={messages} role="log" aria-label="Chat messages" aria-live="polite" aria-relevant="additions" onScroll={() => { const el = messages.current; if (el) nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; }}>
      {!state.messages.length && <div className="chat-empty"><MessageCircle /><strong>A little more than hello.</strong><p>Send a message, share a photo or GIF, or pass a file during your call.</p><small>Files need your approval before they arrive. Chat clears when you leave.</small></div>}
      {state.messages.map(message => <article className={`chat-message ${message.from === "You" ? "is-mine" : ""}`} key={message.id}><span className="chat-message-author">{message.from}</span>{message.kind === "text" ? <p>{message.text}</p> : <Attachment message={message} session={session} />}</article>)}
    </div>
    {state.error && <div className="chat-error" role="alert"><span>{state.error}</span><button type="button" aria-label="Dismiss chat message" onClick={session.clearError}><X /></button></div>}
    <div className="chat-composer-wrap">
      {showAttachments && <div className="attachment-picker" role="group" aria-label="Choose attachment type">{pickerOptions.map(option => <button key={option.label} type="button" onClick={() => pick(option.accept)}><option.icon aria-hidden="true" /><span>{option.label}</span></button>)}</div>}
      <form className="chat-composer" onSubmit={send}>
        <button type="button" className="chat-attach" aria-label="Send a photo, video, audio, GIF or file" aria-expanded={showAttachments} onClick={() => setAttachmentsGeneration(showAttachments ? null : state.generation)} disabled={!state.connected}><Paperclip /></button>
        <label className="chat-sr-only" htmlFor="chat-text">Message</label><input id="chat-text" type="text" value={text} onChange={event => setDraft({ generation: state.generation, text: event.target.value })} placeholder={state.connected ? "Say something…" : "Waiting to connect…"} maxLength={2000} autoComplete="off" disabled={!state.connected} />
        <button type="submit" className="chat-send" aria-label="Send message" disabled={!state.connected || !text.trim()}><Send /></button>
      </form>
      <p className="chat-footnote">Up to 20 MB per file · Sent directly during this call</p>
      <input ref={input} className="chat-sr-only" tabIndex={-1} type="file" aria-label="Choose attachment" onChange={event => { const file = event.target.files?.[0]; if (file) session.offerFile(file); event.target.value = ""; nearBottom.current = true; }} />
    </div>
  </aside>;
}
