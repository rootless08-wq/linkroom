"use client";

import {
  Camera, CameraOff, Check, Copy, Link2, Lock, Mic, MicOff,
  PhoneOff, Radio, Sparkles, Video, SwitchCamera,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { changeCamera } from "@/lib/camera";

type RoomRole = "host" | "guest";
type CallState = "idle" | "starting" | "waiting" | "connecting" | "connected" | "ended" | "error";
type SignalRow = { id: number; sender: string; kind: "presence" | "offer" | "answer" | "ice" | "leave"; payload: unknown };

const rtcConfig: RTCConfiguration = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

function createRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function createClientId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function VideoTile({ videoRef, muted = false, label, empty }: { videoRef: React.RefObject<HTMLVideoElement | null>; muted?: boolean; label: string; empty?: boolean }) {
  return (
    <div className="video-tile">
      <video ref={videoRef} autoPlay playsInline muted={muted} className={empty ? "opacity-0" : "opacity-100"} />
      {empty && (
        <div className="video-empty" aria-live="polite">
          <span className="signal-orbit"><Radio /></span>
          <strong>Waiting for someone to join</strong>
          <small>Keep this tab open after sharing the room link.</small>
        </div>
      )}
      <span className="video-label">{label}</span>
    </div>
  );
}

export default function Home() {
  const [displayName, setDisplayName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [role, setRole] = useState<RoomRole>("guest");
  const [callState, setCallState] = useState<CallState>("idle");
  const [statusText, setStatusText] = useState("Ready when you are");
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(true);
  const [copied, setCopied] = useState(false);
  const [remoteReady, setRemoteReady] = useState(false);
  const [switchingCamera, setSwitchingCamera] = useState(false);

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const pollingRef = useRef<number | null>(null);
  const lastSignalRef = useRef(0);
  const offerSentRef = useRef(false);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const clientIdRef = useRef("");
  const activeRoomRef = useRef("");
  const roleRef = useRef<RoomRole>("guest");
  const nameRef = useRef("");

  const inviteUrl = useMemo(() => {
    if (!roomCode || typeof window === "undefined") return "";
    return `${window.location.origin}${window.location.pathname}?room=${roomCode}`;
  }, [roomCode]);

  useEffect(() => {
    clientIdRef.current = createClientId();
    const params = new URLSearchParams(window.location.search);
    const code = params.get("room")?.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6) ?? "";
    if (!code) return;
    const timer = window.setTimeout(() => {
      setJoinCode(code);
      setStatusText(`You were invited to room ${code}`);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const sendSignal = useCallback(async (kind: SignalRow["kind"], payload: unknown = {}) => {
    const response = await fetch("/api/signals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room: activeRoomRef.current, sender: clientIdRef.current, kind, payload }),
    });
    if (!response.ok) throw new Error("Could not reach the room");
  }, []);

  const flushPendingIce = useCallback(async () => {
    const peer = peerRef.current;
    if (!peer?.remoteDescription) return;
    const candidates = pendingIceRef.current.splice(0);
    for (const candidate of candidates) await peer.addIceCandidate(candidate);
  }, []);

  const makeOffer = useCallback(async () => {
    const peer = peerRef.current;
    if (!peer || offerSentRef.current) return;
    offerSentRef.current = true;
    setCallState("connecting");
    setStatusText("Connecting securely…");
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await sendSignal("offer", offer);
  }, [sendSignal]);

  const handleSignals = useCallback(async (signals: SignalRow[]) => {
    const peer = peerRef.current;
    if (!peer) return;
    for (const signal of signals) {
      lastSignalRef.current = Math.max(lastSignalRef.current, signal.id);
      if (signal.kind === "presence" && roleRef.current === "host") await makeOffer();
      if (signal.kind === "offer" && roleRef.current === "guest" && !peer.remoteDescription) {
        setCallState("connecting");
        setStatusText("Joining the call…");
        await peer.setRemoteDescription(signal.payload as RTCSessionDescriptionInit);
        await flushPendingIce();
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        await sendSignal("answer", answer);
      }
      if (signal.kind === "answer" && roleRef.current === "host" && !peer.remoteDescription) {
        await peer.setRemoteDescription(signal.payload as RTCSessionDescriptionInit);
        await flushPendingIce();
      }
      if (signal.kind === "ice") {
        const candidate = signal.payload as RTCIceCandidateInit;
        if (peer.remoteDescription) await peer.addIceCandidate(candidate);
        else pendingIceRef.current.push(candidate);
      }
      if (signal.kind === "leave") {
        setRemoteReady(false);
        setCallState("waiting");
        setStatusText("The other person left the room");
      }
    }
  }, [flushPendingIce, makeOffer, sendSignal]);

  const startPolling = useCallback(() => {
    if (pollingRef.current) window.clearInterval(pollingRef.current);
    const poll = async () => {
      try {
        const query = new URLSearchParams({ room: activeRoomRef.current, after: String(lastSignalRef.current), exclude: clientIdRef.current });
        const response = await fetch(`/api/signals?${query}`, { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as { signals: SignalRow[] };
        if (data.signals.length) await handleSignals(data.signals);
      } catch { /* The next poll retries automatically. */ }
    };
    void poll();
    pollingRef.current = window.setInterval(() => void poll(), 900);
  }, [handleSignals]);

  const preparePeer = useCallback((stream: MediaStream) => {
    const peer = new RTCPeerConnection(rtcConfig);
    peerRef.current = peer;
    stream.getTracks().forEach((track) => peer.addTrack(track, stream));
    peer.onicecandidate = (event) => { if (event.candidate) void sendSignal("ice", event.candidate.toJSON()); };
    peer.ontrack = (event) => {
      const [remoteStream] = event.streams;
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream;
      setRemoteReady(true);
      setCallState("connected");
      setStatusText("Connected");
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "connected") { setRemoteReady(true); setCallState("connected"); setStatusText("Connected"); }
      if (["failed", "disconnected"].includes(peer.connectionState)) { setRemoteReady(false); setStatusText("Connection interrupted"); }
    };
  }, [sendSignal]);

  const enterRoom = useCallback(async (code: string, nextRole: RoomRole, name = displayName) => {
    const cleanCode = code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    if (cleanCode.length !== 6) { setStatusText("Enter a valid 6-character room code"); setCallState("error"); return; }
    setCallState("starting");
    setStatusText("Requesting camera and microphone…");
    try {
      const roomCheck = await fetch(`/api/rooms?code=${cleanCode}`, { cache: "no-store" });
      if (!roomCheck.ok) throw new Error("This room is unavailable or expired");
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      activeRoomRef.current = cleanCode;
      roleRef.current = nextRole;
      nameRef.current = name.trim() || "Guest";
      setRoomCode(cleanCode); setRole(nextRole); setMicOn(true); setCameraOn(true); setRemoteReady(false);
      lastSignalRef.current = 0; offerSentRef.current = false; pendingIceRef.current = [];
      window.history.replaceState({}, "", `${window.location.pathname}?room=${cleanCode}${nextRole === "host" ? "&host=1" : ""}`);
      preparePeer(stream);
      await sendSignal("presence", { name: nameRef.current, role: nextRole });
      setCallState("waiting");
      setStatusText(nextRole === "host" ? "Room ready — share the link" : "Waiting for the host…");
      startPolling();
    } catch (error) {
      setCallState("error");
      setStatusText(error instanceof Error ? error.message : "Could not start the call");
    }
  }, [displayName, preparePeer, sendSignal, startPolling]);

  const createRoom = useCallback(async (name = displayName) => {
    setCallState("starting"); setStatusText("Creating your room…");
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const code = createRoomCode();
        const response = await fetch("/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }), signal: AbortSignal.timeout(15000) });
        if (response.ok) {
          setRoomCode(code);
          setRole("host");
          window.history.replaceState({}, "", `${window.location.pathname}?room=${code}&host=1`);
          await enterRoom(code, "host", name);
          return { room: code };
        }
        if (response.status !== 409) {
          const result = await response.json().catch(() => ({})) as { error?: string };
          throw new Error(result.error || "Could not create a room. Please try again.");
        }
      }
      throw new Error("Could not create a unique room. Please try again.");
    } catch (error) {
      setCallState("error");
      setStatusText(error instanceof Error && error.name === "TimeoutError"
        ? "The room service took too long. Please try again."
        : error instanceof TypeError
          ? "Could not reach the room service. Check your connection or browser blocking settings, then try again."
          : error instanceof Error ? error.message : "Could not create a room. Please try again.");
    }
  }, [displayName, enterRoom]);

  const endCall = useCallback(async () => {
    if (activeRoomRef.current) { try { await sendSignal("leave"); } catch { /* best effort */ } }
    if (pollingRef.current) window.clearInterval(pollingRef.current);
    pollingRef.current = null;
    peerRef.current?.close(); peerRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop()); localStreamRef.current = null;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    activeRoomRef.current = ""; setRoomCode(""); setRemoteReady(false); setCallState("ended"); setStatusText("Call ended");
    window.history.replaceState({}, "", window.location.pathname);
  }, [sendSignal]);

  useEffect(() => () => {
    if (pollingRef.current) window.clearInterval(pollingRef.current);
    peerRef.current?.close(); localStreamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  const toggleMic = () => { const next = !micOn; localStreamRef.current?.getAudioTracks().forEach((track) => { track.enabled = next; }); setMicOn(next); };
  const toggleCamera = () => { const next = !cameraOn; localStreamRef.current?.getVideoTracks().forEach((track) => { track.enabled = next; }); setCameraOn(next); };
  const switchCamera = async () => {
    if (switchingCamera || !localStreamRef.current) return;
    setSwitchingCamera(true);
    const stream = localStreamRef.current;
    try {
      await changeCamera(stream, () => peerRef.current, () => localStreamRef.current === stream, () => stream.getVideoTracks()[0]?.enabled ?? cameraOn);
      if (localStreamRef.current !== stream) return;
      if (localVideoRef.current) localVideoRef.current.srcObject = new MediaStream(stream.getTracks());
      setStatusText("Camera switched");
    } catch (error) { setStatusText(error instanceof Error ? error.message : "Could not switch cameras."); }
    finally { setSwitchingCamera(false); }
  };
  const copyInvite = async () => { if (!inviteUrl) return; await navigator.clipboard.writeText(inviteUrl); setCopied(true); window.setTimeout(() => setCopied(false), 1800); };
  const inCall = Boolean(roomCode && ["starting", "waiting", "connecting", "connected", "error"].includes(callState));
  useEffect(() => {
    if (inCall && localVideoRef.current) localVideoRef.current.srcObject = localStreamRef.current;
  }, [inCall]);

  return (
    <TooltipProvider>
      <main className="app-shell">
        <header className="topbar">
          <a className="brand" href="/" aria-label="LinkRoom home"><span className="brand-mark"><Video /></span><span>LinkRoom</span></a>
          <div className="top-status" aria-live="polite"><span className={`status-dot ${callState === "connected" ? "connected" : ""}`} />{statusText}</div>
          <span className="privacy-pill"><Lock /> Peer-to-peer</span>
        </header>

        {inCall ? (
          <section className="call-stage" aria-label="Video call room">
            <div className="room-strip">
              <div><span className="eyebrow">Private room</span><strong>{roomCode}</strong></div>
              <Button variant="outline" className="copy-room" onClick={copyInvite}>{copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy invite"}</Button>
            </div>
            <div className="video-grid">
              <VideoTile videoRef={remoteVideoRef} label={remoteReady ? "Connected guest" : "Open seat"} empty={!remoteReady} />
              <div className="self-view">
                <VideoTile videoRef={localVideoRef} muted label={`${displayName.trim() || "You"} · ${role}`} />
                {!cameraOn && <div className="camera-off"><CameraOff /><span>Camera off</span></div>}
              </div>
            </div>
            <div className="call-controls" aria-label="Call controls">
              {callState === "error" && <Button variant="secondary" onClick={() => void enterRoom(roomCode, role)}><Camera /> Try camera again</Button>}
              {callState === "starting" && <span role="status">Allow camera and microphone access to join the call.</span>}
              <Tooltip><TooltipTrigger asChild><Button size="icon-lg" variant={micOn ? "secondary" : "destructive"} onClick={toggleMic} disabled={!localStreamRef.current} aria-label={micOn ? "Mute microphone" : "Unmute microphone"}>{micOn ? <Mic /> : <MicOff />}</Button></TooltipTrigger><TooltipContent>{micOn ? "Mute" : "Unmute"}</TooltipContent></Tooltip>
              <Tooltip><TooltipTrigger asChild><Button size="icon-lg" variant={cameraOn ? "secondary" : "destructive"} onClick={toggleCamera} disabled={!localStreamRef.current} aria-label={cameraOn ? "Turn camera off" : "Turn camera on"}>{cameraOn ? <Camera /> : <CameraOff />}</Button></TooltipTrigger><TooltipContent>{cameraOn ? "Camera off" : "Camera on"}</TooltipContent></Tooltip>
              <Button variant="secondary" onClick={() => void switchCamera()} disabled={switchingCamera || !localStreamRef.current}><SwitchCamera />{switchingCamera ? "Switching…" : "Switch camera"}</Button>
              <Button className="end-call" onClick={endCall}><PhoneOff /> End call</Button>
            </div>
          </section>
        ) : (
          <section className="home-grid">
            <div className="home-intro">
              <span className="eyebrow"><Sparkles /> Simple video chat</span>
              <h1>Meet face to face.<br /><em>No account needed.</em></h1>
              <p>Create a private room, share one link, and start talking. Your audio and video travel directly between callers.</p>
              <div className="trust-row"><span><Lock /> Private room codes</span><span><Link2 /> One link to join</span><span><Radio /> Live connection status</span></div>
            </div>

            <div className="join-panel">
                <div className="private-panel">
                  <div className="panel-heading"><div><span className="eyebrow">Private video call</span><h2>Create or join a room</h2></div></div>
                  <label className="field-label" htmlFor="display-name">Your name</label>
                  <Input id="display-name" value={displayName} maxLength={40} onChange={(event) => setDisplayName(event.target.value)} placeholder="What should people call you?" />
                  {joinCode.length === 6 && (
                    <div className="invite-card">
                      <span><Link2 /> Invitation detected</span><strong>Join room {joinCode}</strong>
                      <Button size="lg" onClick={() => void enterRoom(joinCode, "guest")} disabled={callState === "starting"}><Video /> {callState === "starting" ? "Opening camera…" : "Join this call"}</Button>
                    </div>
                  )}
                  <Button size="lg" className="primary-action" onClick={() => void createRoom()} disabled={callState === "starting"}><Video /> {callState === "starting" ? "Creating room…" : "Create a private room"}</Button>
                  <div className="divider"><span>or join with a code</span></div>
                  <div className="code-row"><Input aria-label="Room code" className="code-input" value={joinCode} onChange={(event) => setJoinCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6))} placeholder="ABC123" /><Button variant="outline" size="lg" onClick={() => void enterRoom(joinCode, "guest")} disabled={joinCode.length !== 6 || callState === "starting"}>Join</Button></div>
                  {callState === "error" && <p className="error-message" role="alert">{statusText}</p>}
                  <p className="permission-note"><Camera /> You choose when to allow camera and microphone access.</p>
                </div>
            </div>
          </section>
        )}
        <footer className="app-footer"><span>© 2026 Jayant Adhikary</span><span>Calls are not recorded</span></footer>
      </main>
    </TooltipProvider>
  );
}

