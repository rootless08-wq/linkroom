import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changeCamera, getCameraFacing } from '../lib/camera.ts';
function track(id, kind = 'video', facingMode) {
  return { kind, enabled: true, stopped: false, label: id, getSettings() { return { deviceId: id, facingMode }; }, stop() { this.stopped = true; } };
}
function stream(tracks) {
  return { getTracks: () => [...tracks], getVideoTracks: () => tracks.filter(t => t.kind === 'video'), getAudioTracks: () => tracks.filter(t => t.kind === 'audio'), removeTrack(t) { const at = tracks.indexOf(t); if (at >= 0) tracks.splice(at, 1); }, addTrack(t) { tracks.push(t); } };
}
function devices(acquire, ids = ['front', 'back']) {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: {
    enumerateDevices: async () => ids.map(deviceId => ({ kind: 'videoinput', deviceId })), getUserMedia: acquire,
  } } });
}
function peer(original, replace = async () => {}) {
  const sender = { track: original, async replaceTrack(next) { await replace(next); this.track = next; } };
  return { getSenders: () => [sender], sender };
}

test('switch keeps microphone mute and honors camera changes during replaceTrack', async () => {
  const old = track('front'), audio = track('mic', 'audio'), next = track('back'), local = stream([old, audio]);
  audio.enabled = false;
  let cameraEnabled = true;
  const pc = peer(old, async () => { cameraEnabled = false; });
  devices(async options => { assert.equal(options.audio, false); return stream([next]); });
  await changeCamera(local, () => pc, () => true, () => cameraEnabled);
  assert.equal(pc.sender.track, next); assert.equal(next.enabled, false); assert.equal(old.stopped, true);
  assert.equal(audio.stopped, false); assert.equal(audio.enabled, false); assert.deepEqual(local.getTracks(), [audio, next]);
});

test('exclusive mobile camera retries after releasing the original device', async () => {
  const old = track('front'), next = track('back'), local = stream([old]); let attempts = 0;
  devices(async () => { if (++attempts === 1) throw new DOMException('busy', 'NotReadableError'); assert.equal(old.stopped, true); return stream([next]); });
  await changeCamera(local, () => null, () => true, () => true);
  assert.equal(attempts, 2); assert.equal(local.getVideoTracks()[0], next);
});

test('hidden device lists use exact facingMode and rear cameras are not mirrored', async () => {
  const old = track('front', 'video', 'user'), next = track('back', 'video', 'environment'), local = stream([old]);
  devices(async options => { assert.deepEqual(options.video.facingMode, { exact: 'environment' }); return stream([next]); }, []);
  await changeCamera(local, () => null, () => true, () => true);
  assert.equal(getCameraFacing(local), 'environment');
});

test('outdated device ID falls back to facingMode', async () => {
  const local = stream([track('front', 'video', 'user')]), next = track('back'); let attempts = 0;
  devices(async options => { attempts++; if (options.video.deviceId) throw new DOMException('stale ID', 'OverconstrainedError'); return stream([next]); });
  await changeCamera(local, () => null, () => true, () => true);
  assert.equal(attempts, 2); assert.equal(local.getVideoTracks()[0], next);
});

test('browser returning the same camera does not report a successful switch', async () => {
  const old = track('front'), returned = track('front'), local = stream([old]);
  devices(async () => stream([returned]), ['front']);
  await assert.rejects(changeCamera(local, () => null, () => true, () => true), /Only one camera/);
  assert.equal(returned.stopped, true); assert.equal(old.stopped, false); assert.equal(local.getVideoTracks()[0], old);
});

test('stop during acquisition disposes the new camera without changing the stream', async () => {
  const old = track('front'), next = track('back'), local = stream([old]); let active = true;
  devices(async () => { active = false; return stream([next]); });
  await changeCamera(local, () => null, () => active, () => true);
  assert.equal(next.stopped, true); assert.equal(local.getVideoTracks()[0], old);
});

test('stop while sender replacement awaits cannot attach the new track to a stopped call', async () => {
  const old = track('front'), next = track('back'), local = stream([old]); let active = true;
  const pc = peer(old, async () => { active = false; });
  devices(async () => stream([next]));
  await changeCamera(local, () => pc, () => active, () => true);
  assert.equal(next.stopped, true); assert.equal(local.getVideoTracks()[0], old);
});

test('a new match during replaceTrack receives the selected camera', async () => {
  const old = track('front'), next = track('back'), local = stream([old]);
  const second = peer(old); let current;
  const first = peer(old, async () => { current = second; }); current = first;
  devices(async () => stream([next]));
  await changeCamera(local, () => current, () => true, () => true);
  assert.equal(second.sender.track, next); assert.equal(local.getVideoTracks()[0], next);
});

test('failed sender replacement leaves the old camera alive', async () => {
  const old = track('front'), next = track('back'), local = stream([old]);
  const pc = peer(old, async () => { throw new DOMException('cannot replace', 'InvalidModificationError'); });
  devices(async () => stream([next]));
  await assert.rejects(changeCamera(local, () => pc, () => true, () => true), /cannot replace/);
  assert.equal(next.stopped, true); assert.equal(old.stopped, false); assert.equal(pc.sender.track, old);
});

test('failed exclusive switch restores the original camera and disabled state', async () => {
  const old = track('front'), restored = track('front'), audio = track('mic', 'audio'), local = stream([old, audio]);
  const pc = peer(old); let attempts = 0;
  devices(async options => {
    attempts++;
    if (options.video.deviceId?.exact === 'front') return stream([restored]);
    if (attempts === 1) throw new DOMException('busy', 'NotReadableError');
    throw new DOMException('unavailable', 'NotFoundError');
  });
  await assert.rejects(changeCamera(local, () => pc, () => true, () => false), /Only one camera/);
  assert.equal(old.stopped, true); assert.equal(restored.stopped, false); assert.equal(restored.enabled, false);
  assert.equal(pc.sender.track, restored); assert.equal(audio.stopped, false); assert.deepEqual(local.getTracks(), [audio, restored]);
});

test('permission denial does not release the working camera', async () => {
  const old = track('front'), local = stream([old]);
  devices(async () => { throw new DOMException('denied', 'NotAllowedError'); });
  await assert.rejects(changeCamera(local, () => null, () => true, () => true), /denied/);
  assert.equal(old.stopped, false);
});
