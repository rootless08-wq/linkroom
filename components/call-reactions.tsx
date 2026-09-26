"use client";

import { useState } from "react";
import { Smile, X } from "lucide-react";
import { CallChat, REACTIONS, type ReactionEmoji } from "@/lib/call-chat";
import { useCallChat } from "./call-chat";

const labels: Record<ReactionEmoji, string> = { "❤️": "Love", "🎉": "Celebrate", "👍": "Thumbs up", "🙌": "Cheers", "😂": "Laugh", "✨": "Sparkles" };

export function ReactionControls({ session }: { session: CallChat }) {
  const state = useCallChat(session), [openGeneration, setOpenGeneration] = useState<number | null>(null), open = openGeneration === state.generation && state.connected;
  return <div className="reaction-controls" onKeyDown={event => { if (event.key === "Escape") { setOpenGeneration(null); event.stopPropagation(); } }}>
    <button type="button" className={`chat-toggle ${open ? "is-active" : ""}`} aria-label="Call reactions" aria-expanded={open} disabled={!state.connected} onClick={() => setOpenGeneration(open ? null : state.generation)}><Smile aria-hidden="true" /><span>React</span></button>
    {open && <div className="reaction-picker" role="group" aria-label="Send a reaction">{REACTIONS.map(emoji => <button key={emoji} type="button" aria-label={`Send ${labels[emoji]} reaction`} onClick={() => { session.react(emoji); setOpenGeneration(null); }}><span aria-hidden="true">{emoji}</span></button>)}<button className="reaction-picker-close" type="button" aria-label="Close reactions" onClick={() => setOpenGeneration(null)}><X /></button></div>}
  </div>;
}

export function ReactionOverlay({ session }: { session: CallChat }) {
  const state = useCallChat(session);
  return <div className="reaction-overlay" role="status" aria-live="polite" aria-atomic="false">{state.reactions.map((reaction, index) => <div className={`call-reaction ${reaction.from === "You" ? "from-you" : "from-partner"}`} key={reaction.id} style={{ "--reaction-offset": `${((index % 3) - 1) * 90}px` } as React.CSSProperties}><span className="reaction-emoji" aria-hidden="true">{reaction.emoji}</span><span className="reaction-caption">{reaction.from} · {labels[reaction.emoji]}</span><i aria-hidden="true">{reaction.emoji}</i><b aria-hidden="true">{reaction.emoji}</b></div>)}</div>;
}
