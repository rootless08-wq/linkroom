import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Browser bundlers resolve this extensionless import; Node's TS loader needs it.
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier === './camera' && context.parentURL?.endsWith('/lib/video-effects.ts') ? './camera.ts' : specifier, context);
} });
const { VideoEffectsController, effectDimensions } = await import('../lib/video-effects.ts');

function track(kind = 'video', facingMode = 'user') {
  return { kind, enabled: true, stopped: false, getSettings: () => ({ width: 1920, height: 1080, facingMode }), stop() { this.stopped = true; } };
}
class Stream {
  constructor(tracks) { this.tracks = tracks; }
  getTracks() { return [...this.tracks]; }
  getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
  getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
}
function browser({ supported = true, cores = 8 } = {}) {
  const generated = track(); let callback, capturedFps, cancelled;
  const context = { filter: 'none', fillRect() {}, drawImage() { this.drawnFilter = this.filter; }, fillText() {}, drawnFilter: '' };
  const canvas = { width: 0, height: 0, getContext: () => context, captureStream: supported ? fps => { capturedFps = fps; return new Stream([generated]); } : undefined };
  const video = { readyState: 2, videoWidth: 1920, videoHeight: 1080, srcObject: null, play: async () => {}, pause() { this.paused = true; }, requestVideoFrameCallback(fn) { callback = fn; return 1; }, cancelVideoFrameCallback(id) { cancelled = id; } };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { hardwareConcurrency: cores } });
  globalThis.document = { createElement: tag => tag === 'canvas' ? canvas : video };
  globalThis.MediaStream = Stream;
  return { generated, context, canvas, video, tick: now => callback(now), get fps() { return capturedFps; }, get cancelled() { return cancelled; } };
}

test('effect output is bounded and portrait video keeps its shape', () => {
  assert.deepEqual(effectDimensions(3840, 2160), { width: 1280, height: 720 });
  assert.deepEqual(effectDimensions(1080, 1920), { width: 404, height: 720 });
  assert.deepEqual(effectDimensions(640, 360), { width: 640, height: 360 });
  assert.deepEqual(effectDimensions(0, NaN), { width: 960, height: 540 });
});

test('filters are drawn into the outgoing track and camera switches preserve that track', () => {
  const env = browser(), camera = track(), audio = track('audio'), raw = new Stream([camera, audio]);
  audio.enabled = false;
  const effects = new VideoEffectsController(raw);
  assert.equal(effects.supported, true); assert.equal(effects.processing, false); assert.equal(effects.stream, raw);
  assert.equal(effects.stream.getAudioTracks()[0], audio); assert.equal(audio.enabled, false);
  effects.setEffect('warm'); env.tick(1000);
  assert.equal(effects.processing, true); assert.equal(effects.stream.getVideoTracks()[0], env.generated);
  assert.match(env.context.drawnFilter, /sepia/);
  assert.equal(env.canvas.width, 1280); assert.equal(env.canvas.height, 720); assert.equal(env.fps, 30);
  const back = track('video', 'environment'); raw.tracks = [back, audio]; effects.refreshSource();
  assert.equal(effects.mirrored, false); assert.equal(env.video.srcObject.getVideoTracks()[0], back);
  assert.equal(effects.stream.getVideoTracks()[0], env.generated);
  effects.setEffect('mono'); env.tick(1100); assert.equal(env.context.drawnFilter, 'grayscale(1)');
  effects.dispose(); assert.equal(env.generated.stopped, true); assert.equal(back.stopped, false); assert.equal(audio.stopped, false);
  assert.equal(env.video.srcObject, null); assert.equal(env.cancelled, 1);
});

test('camera off disables both camera and outgoing video while microphone stays independent', () => {
  const env = browser({ cores: 4 }), camera = track(), audio = track('audio'), raw = new Stream([camera, audio]);
  const effects = new VideoEffectsController(raw);
  effects.setEffect('soft');
  assert.equal(env.fps, 24); assert.equal(env.canvas.width, 960); assert.equal(env.canvas.height, 540);
  effects.setCameraEnabled(false);
  assert.equal(camera.enabled, false); assert.equal(env.generated.enabled, false); assert.equal(audio.enabled, true);
  assert.equal(effects.react('👍'), false);
  effects.setCameraEnabled(true); assert.equal(effects.react('👍'), true); assert.equal(effects.react('unsafe'), false);
  effects.dispose(); assert.equal(effects.setEffect('warm'), false);
});

test('browsers without canvas capture fall back to the original camera stream', () => {
  browser({ supported: false });
  const camera = track(), raw = new Stream([camera]);
  const effects = new VideoEffectsController(raw);
  assert.equal(effects.supported, false); assert.equal(effects.stream, raw);
  assert.equal(effects.setEffect('warm'), false); assert.equal(effects.setEffect('none'), true);
  effects.setCameraEnabled(false); assert.equal(camera.enabled, false);
  effects.dispose(); assert.equal(camera.stopped, false);
});
