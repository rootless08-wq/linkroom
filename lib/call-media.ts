import { changeCamera, getCameraFacing } from "./camera";
import { VideoEffectsController, type VideoEffect } from "./video-effects";
import { CallChat } from "./call-chat";

export type CallView = {
  phase: "idle" | "starting" | "waiting" | "connecting" | "connected" | "error" | "ended";
  status: string; local: MediaStream | null; remote: MediaStream | null;
  mic: boolean; camera: boolean; switching: boolean; mirrored: boolean;
  effect: VideoEffect; effectsSupported: boolean; room: string;
};
export const initialView = (): CallView => ({ phase: "idle", status: "Ready when you are", local: null, remote: null,
  mic: true, camera: true, switching: false, mirrored: true, effect: "none", effectsSupported: false, room: "" });

export function callError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError") return "Allow camera and microphone access in your browser, then try again.";
  if (name === "NotFoundError") return "No camera or microphone was found. Connect them and try again.";
  if (name === "NotReadableError") return "Your camera is busy. Close other apps using it, then try again.";
  if (name === "TimeoutError" || name === "AbortError") return "The connection took too long. Please try again.";
  if (error instanceof TypeError) return "Could not reach LinkRoom. Check your internet connection and try again.";
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

/** Shared media lifecycle; every async operation belongs to one call epoch. */
export class CallMedia {
  state: CallView = initialView();
  readonly chat = new CallChat();
  protected active = false;
  protected epoch = 0;
  protected raw: MediaStream | null = null;
  protected effects: VideoEffectsController | null = null;
  protected pc: RTCPeerConnection | null = null;
  private connectionTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private effectBusy = false;
  constructor(private changed: (view: CallView) => void) {}
  protected update(patch: Partial<CallView>) { this.state = { ...this.state, ...patch }; this.changed(this.state); }
  protected fail(error: unknown) { this.update({ status: callError(error) }); }
  protected current(epoch: number) { return this.active && epoch === this.epoch; }
  protected async acquireMedia(epoch: number) {
    if (this.raw) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera access needs HTTPS or localhost and a supported browser.");
    const media = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }, frameRate: { ideal: 24, max: 30 }, facingMode: "user" },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (!this.current(epoch)) { media.getTracks().forEach(track => track.stop()); return; }
    this.raw = media;
    this.effects = new VideoEffectsController(media);
    this.update({ local: this.effects.stream, effectsSupported: this.effects.supported, mic: true, camera: true,
      mirrored: getCameraFacing(media) !== "environment" });
  }
  protected makePeer(send: (kind: "offer" | "answer" | "ice", payload: unknown) => Promise<unknown>, reconnect?: () => void) {
    this.closePeer();
    const pc = new RTCPeerConnection({ bundlePolicy: "max-bundle", iceCandidatePoolSize: 2,
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }, { urls: "stun:stun.l.google.com:19302" }] });
    this.pc = pc;
    const local = this.effects?.stream || this.raw;
    local?.getTracks().forEach(track => { if (track.kind === "video") track.contentHint = "motion"; pc.addTrack(track, local); });
    pc.onicecandidate = event => {
      if (event.candidate && this.pc === pc) void send("ice", event.candidate.toJSON()).catch(error => { if (this.pc === pc) this.fail(error); });
    };
    pc.ontrack = event => {
      if (this.pc !== pc) return;
      const remote = event.streams[0] || this.state.remote || new MediaStream();
      if (!event.streams[0]) remote.addTrack(event.track);
      this.update({ remote });
    };
    pc.ondatachannel = event => { if (this.pc === pc) this.chat.attach(event.channel); else event.channel.close(); };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      if (pc.connectionState === "connected") {
        clearTimeout(this.connectionTimer); clearTimeout(this.reconnectTimer);
        this.update({ phase: "connected", status: "Connected · Quality adjusts to your connection" });
        // The browser still adapts below this ceiling when bandwidth is limited.
        for (const sender of pc.getSenders().filter(sender => sender.track?.kind === "video")) {
          const parameters = sender.getParameters();
          if (parameters.encodings?.length) { parameters.encodings[0].maxBitrate = 2_000_000; parameters.encodings[0].maxFramerate = 30; void sender.setParameters(parameters).catch(() => {}); }
        }
      } else if (pc.connectionState === "disconnected") {
        this.update({ status: "Connection interrupted. Reconnecting…" });
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => { if (this.pc === pc && pc.connectionState === "disconnected") reconnect?.(); }, 3500);
      } else if (pc.connectionState === "failed") {
        this.update({ status: "Trying to reconnect. Restrictive networks may need a different connection." });
        reconnect?.();
      }
    };
    this.connectionTimer = setTimeout(() => {
      if (this.pc === pc && pc.connectionState !== "connected") this.update({ status: "Still connecting. Try another network if this continues." });
    }, 25000);
    return pc;
  }
  protected openChat(pc: RTCPeerConnection) { this.chat.attach(pc.createDataChannel("linkroom-chat", { ordered: true })); }
  mute() { const mic = !this.state.mic; this.raw?.getAudioTracks().forEach(track => track.enabled = mic); this.update({ mic }); }
  camera() {
    const camera = !this.state.camera;
    this.raw?.getVideoTracks().forEach(track => track.enabled = camera);
    this.effects?.setCameraEnabled(camera); this.update({ camera });
  }
  async setEffect(effect: VideoEffect) {
    const effects = this.effects, epoch = this.epoch;
    if (!effects || this.effectBusy || this.state.switching) return;
    this.effectBusy = true;
    const before = effects.stream.getVideoTracks()[0];
    try {
      if (!effects.setEffect(effect)) throw new Error("This video effect is unavailable in this browser.");
      const next = effects.stream.getVideoTracks()[0];
      if (next !== before) {
        let peer = this.pc;
        while (peer && this.current(epoch)) {
          const sender = peer.getSenders().find(sender => sender.track?.kind === "video");
          if (sender && sender.track !== next) await sender.replaceTrack(next);
          if (this.pc === peer) break;
          peer = this.pc;
        }
      }
      if (this.current(epoch) && this.effects === effects) this.update({ effect, local: new MediaStream(effects.stream.getTracks()) });
    } catch (error) {
      if (this.current(epoch) && this.effects === effects) {
        effects.resetToOriginal();
        const sender = this.pc?.getSenders().find(sender => sender.track?.kind === "video");
        if (sender && this.raw) await sender.replaceTrack(this.raw.getVideoTracks()[0]).catch(() => {});
        this.update({effect:"none",local:this.raw ? new MediaStream(this.raw.getTracks()) : null}); this.fail(error);
      }
    } finally { this.effectBusy = false; }
  }
  async switchCamera() {
    const stream = this.raw, epoch = this.epoch;
    if (!stream || this.state.switching || this.effectBusy) return;
    this.update({ switching: true });
    try {
      await changeCamera(stream, () => this.effects?.processing ? null : this.pc, () => this.current(epoch) && this.raw === stream, () => this.state.camera);
      if (!this.current(epoch)) return;
      this.effects?.refreshSource();
      this.update({ local: new MediaStream((this.effects?.stream || stream).getTracks()),
        mirrored: getCameraFacing(stream) !== "environment", status: "Camera switched" });
    } catch (error) { if (this.current(epoch)) { this.effects?.refreshSource(); this.update({ local: new MediaStream((this.effects?.stream || stream).getTracks()) }); this.fail(error); } }
    finally { if (this.current(epoch)) this.update({ switching: false, mirrored: getCameraFacing(stream) !== "environment" }); }
  }
  protected closePeer() {
    clearTimeout(this.connectionTimer); clearTimeout(this.reconnectTimer);
    const pc = this.pc; this.pc = null;
    if (pc) { pc.onconnectionstatechange = null; pc.onicecandidate = null; pc.ontrack = null; pc.ondatachannel = null; pc.close(); }
    this.chat.reset(); this.update({ remote: null });
  }
  protected releaseMedia() { this.closePeer(); this.effects?.dispose(); this.effects = null; this.raw?.getTracks().forEach(track => track.stop()); this.raw = null; }
}
