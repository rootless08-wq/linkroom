import { getCameraFacing } from "./camera";

export type VideoEffect = "none" | "warm" | "cool" | "mono" | "soft";
export const videoEffects: ReadonlyArray<{ id: VideoEffect; label: string }> = [
  { id: "none", label: "Original" }, { id: "warm", label: "Warm" }, { id: "cool", label: "Cool" },
  { id: "mono", label: "Mono" }, { id: "soft", label: "Soft" },
];
const filters: Record<VideoEffect, string> = {
  none: "none", warm: "sepia(0.22) saturate(1.15) brightness(1.04)",
  cool: "saturate(0.82) hue-rotate(12deg) contrast(1.03)", mono: "grayscale(1)",
  soft: "contrast(0.91) brightness(1.08) saturate(0.92)",
};
const reactionEmoji = new Set(["❤️", "👏", "🎉", "👍", "😂", "🙌"]);

/** Fit the source within a budget without upscaling or changing its aspect ratio. */
export function effectDimensions(width: number, height: number, maxWidth = 1280, maxHeight = 720) {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 960;
  const safeHeight = Number.isFinite(height) && height > 0 ? height : 540;
  const scale = Math.min(1, maxWidth / safeWidth, maxHeight / safeHeight);
  return { width: Math.max(2, Math.floor(safeWidth * scale / 2) * 2), height: Math.max(2, Math.floor(safeHeight * scale / 2) * 2) };
}

/** A bounded canvas compositor. The same generated track survives camera switches. */
export class VideoEffectsController {
  private output: MediaStream;
  private available = false;
  private raw: MediaStream;
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private generated: MediaStreamTrack | null = null;
  private effect: VideoEffect = "none";
  private frameId = 0;
  private videoFrame = false;
  private lastFrame = -Infinity;
  private disposed = false;
  private enabled = true;
  private particles: { emoji: string; started: number; x: number }[] = [];
  private readonly fps: number;
  private readonly maxWidth: number;
  private readonly maxHeight: number;

  constructor(raw: MediaStream) {
    this.raw = raw;
    this.output = raw;
    this.enabled = raw.getVideoTracks()[0]?.enabled ?? true;
    const slower = typeof navigator !== "undefined" && navigator.hardwareConcurrency > 0 && navigator.hardwareConcurrency <= 4;
    this.fps = slower ? 24 : 30;
    this.maxWidth = slower ? 960 : 1280;
    this.maxHeight = slower ? 540 : 720;
    if (typeof document === "undefined") return;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { alpha: false });
    if (!context || !("filter" in context) || typeof canvas.captureStream !== "function") return;
    this.canvas = canvas; this.context = context; this.available = true;
  }

  get stream() { return this.output; }
  get supported() { return this.available; }
  get processing() { return this.generated !== null; }
  private activate() {
    const canvas = this.canvas, context = this.context;
    if (!canvas || !context || !this.available || this.disposed) return false;
    try {
      const source = this.raw.getVideoTracks()[0];
      const settings = source?.getSettings() ?? {};
      const dimensions = effectDimensions(settings.width ?? 960, settings.height ?? 540, this.maxWidth, this.maxHeight);
      canvas.width = dimensions.width; canvas.height = dimensions.height;
      context.fillStyle = "#101116"; context.fillRect(0, 0, canvas.width, canvas.height);
      const generated = canvas.captureStream(this.fps).getVideoTracks()[0];
      if (!generated) return false;
      generated.enabled = this.enabled;
      generated.contentHint = "motion";
      this.generated = generated;
      this.output = new MediaStream([...this.raw.getAudioTracks(), generated]);
      this.video = document.createElement("video");
      this.video.muted = true; this.video.autoplay = true; this.video.playsInline = true;
      this.refreshSource();
      this.schedule();
      return true;
    } catch {
      this.generated?.stop(); this.generated = null;
      if (this.video) { this.video.pause(); this.video.srcObject = null; }
      this.video = null; this.output = this.raw; this.available = false;
      return false;
    }
  }

  get mirrored() { return getCameraFacing(this.raw) !== "environment"; }
  setEffect(effect: VideoEffect): boolean {
    if (!(effect in filters) || this.disposed || (!this.supported && effect !== "none")) return false;
    // Original video costs no canvas work until an effect is actually selected.
    if (effect !== "none" && !this.generated && !this.activate()) return false;
    this.effect = effect;
    return true;
  }
  setCameraEnabled(enabled: boolean) {
    this.enabled = enabled;
    this.raw.getVideoTracks().forEach(track => { track.enabled = enabled; });
    if (this.generated) this.generated.enabled = enabled;
  }
  /** Call after changeCamera mutates the raw stream. The outgoing track is stable. */
  refreshSource() {
    if (!this.video || this.disposed) return;
    this.raw.getVideoTracks().forEach(track => { track.enabled = this.enabled; });
    this.video.srcObject = new MediaStream(this.raw.getVideoTracks());
    void this.video.play().catch(() => { /* Playback resumes when camera frames become available. */ });
  }
  /** Optional transmitted overlay. Signaling can also provide separate UI reactions. */
  react(emoji: string): boolean {
    if (!this.processing || !this.enabled || this.disposed || !reactionEmoji.has(emoji)) return false;
    const started = performance.now();
    this.particles = [...this.particles.filter(particle => started - particle.started < 2200).slice(-18),
      ...Array.from({ length: 6 }, (_, index) => ({ emoji, started: started + index * 70, x: 0.15 + Math.random() * 0.7 }))];
    return true;
  }
  /** Used when attaching the first processed track fails; resumes direct camera video. */
  resetToOriginal() {
    if (this.videoFrame) this.video?.cancelVideoFrameCallback(this.frameId);
    else if (this.frameId) cancelAnimationFrame(this.frameId);
    this.frameId = 0;
    this.generated?.stop(); this.generated = null;
    if (this.video) { this.video.pause(); this.video.srcObject = null; }
    this.video = null; this.output = this.raw; this.effect = "none"; this.particles = [];
  }
  private schedule() {
    if (!this.video || this.disposed) return;
    if (typeof this.video.requestVideoFrameCallback === "function") {
      this.videoFrame = true;
      this.frameId = this.video.requestVideoFrameCallback(now => this.draw(now));
    } else {
      this.videoFrame = false;
      this.frameId = requestAnimationFrame(now => this.draw(now));
    }
  }
  private draw(now: number) {
    if (this.disposed || !this.canvas || !this.context || !this.video) return;
    if (this.video.readyState >= 2 && now - this.lastFrame >= 1000 / this.fps - 2) {
      this.lastFrame = now;
      const { width, height } = effectDimensions(this.video.videoWidth, this.video.videoHeight, this.maxWidth, this.maxHeight);
      if (this.canvas.width !== width) this.canvas.width = width;
      if (this.canvas.height !== height) this.canvas.height = height;
      const context = this.context;
      context.filter = filters[this.effect];
      context.drawImage(this.video, 0, 0, width, height);
      context.filter = "none";
      this.particles = this.particles.filter(particle => now - particle.started < 2200);
      context.font = `${Math.round(width * 0.065)}px sans-serif`;
      context.textAlign = "center";
      for (const particle of this.particles) {
        const progress = (now - particle.started) / 2200;
        if (progress < 0) continue;
        context.globalAlpha = Math.min(1, (1 - progress) * 3);
        context.fillText(particle.emoji, width * particle.x, height * (0.9 - progress * 0.75));
      }
      context.globalAlpha = 1;
    }
    this.schedule();
  }
  /** Raw camera/microphone tracks remain owned by the caller. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.resetToOriginal();
    this.video = null; this.canvas = null; this.context = null; this.particles = [];
  }
}
