export type CameraFacing = "user" | "environment" | "unknown";

/** A modest HD target lets the browser lower resolution on slower cameras. */
export const initialMediaConstraints: MediaStreamConstraints = {
  video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 }, facingMode: "user" },
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
};

function facing(track?: MediaStreamTrack): CameraFacing {
  const mode = track?.getSettings().facingMode;
  if (mode === "user" || mode === "environment") return mode;
  if (/back|rear|environment/i.test(track?.label ?? "")) return "environment";
  if (/front|facetime|user/i.test(track?.label ?? "")) return "user";
  return "unknown";
}
export function getCameraFacing(stream: MediaStream | null): CameraFacing {
  return facing(stream?.getVideoTracks()[0]);
}

const switching = new WeakSet<MediaStream>();
const stopTracks = (stream?: MediaStream) => stream?.getTracks().forEach(track => track.stop());
const errorName = (error: unknown) => error && typeof error === "object" && "name" in error ? String(error.name) : "";
const busyCamera = (error: unknown) => ["NotReadableError", "AbortError", "TrackStartError"].includes(errorName(error));
const unavailableCamera = (error: unknown) => ["NotFoundError", "OverconstrainedError", "DevicesNotFoundError", "ConstraintNotSatisfiedError"].includes(errorName(error));

function sameCamera(old: MediaStreamTrack | undefined, replacement: MediaStreamTrack) {
  if (!old) return false;
  const before = old.getSettings(), after = replacement.getSettings();
  if (before.deviceId && after.deviceId) return before.deviceId === after.deviceId;
  if (before.facingMode && after.facingMode && before.facingMode !== after.facingMode) return false;
  return !!old.label && !!replacement.label && old.label === replacement.label;
}

/** Replace only video, preserving the microphone, its mute state, and the call. */
export async function changeCamera(
  stream: MediaStream,
  peer: () => RTCPeerConnection | null,
  active: () => boolean,
  enabled: () => boolean,
): Promise<void> {
  if (!active()) return;
  if (switching.has(stream)) throw new Error("A camera switch is already in progress.");
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera switching is unavailable in this browser.");
  switching.add(stream);
  const old = stream.getVideoTracks()[0];
  const oldId = old?.getSettings().deviceId;
  const oldFacing = facing(old);
  let replacement: MediaStream | undefined;
  let released = false;
  const changedSenders = new Set<RTCRtpSender>();
  const acquire = (target: MediaTrackConstraints) => navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 }, ...target }, audio: false,
  });

  // Next/match can replace the connection while replaceTrack is awaiting the browser.
  const updateCurrentPeer = async (track: MediaStreamTrack) => {
    for (let attempt = 0; attempt < 4 && active(); attempt++) {
      const current = peer();
      const sender = current?.getSenders().find(item => item.track?.kind === "video");
      if (sender) {
        await sender.replaceTrack(track);
        changedSenders.add(sender);
      }
      if (!active()) return false;
      if (peer() === current) return true;
    }
    if (!active()) return false;
    throw new Error("The call changed while switching cameras. Please try switching again.");
  };

  try {
    // Safari can expose only the active camera, or no device IDs, before a switch.
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    if (!active()) return;
    const cameras = devices.filter(device => device.kind === "videoinput" && device.deviceId);
    const currentIndex = cameras.findIndex(device => device.deviceId === oldId || (!!old?.label && device.label === old.label));
    const ordered = currentIndex < 0 ? cameras : [...cameras.slice(currentIndex + 1), ...cameras.slice(0, currentIndex)];
    const targets: MediaTrackConstraints[] = ordered.filter(device => device.deviceId !== oldId).map(device => ({ deviceId: { exact: device.deviceId } }));
    targets.push({ facingMode: { exact: oldFacing === "environment" ? "user" : "environment" } });
    let lastError: unknown;
    for (const target of targets) {
      if (!active()) return;
      try {
        try { replacement = await acquire(target); }
        catch (error) {
          // Some phones cannot open the rear camera until the front is released.
          if (!active() || released || !busyCamera(error)) throw error;
          old?.stop(); released = true;
          replacement = await acquire(target);
        }
        if (!active()) return;
        const track = replacement.getVideoTracks()[0];
        if (!track) throw new Error("The selected camera did not provide video.");
        if (sameCamera(old, track)) {
          stopTracks(replacement); replacement = undefined;
          lastError = new Error("Only one camera is available. Connect another camera to switch.");
          continue;
        }
        track.enabled = enabled();
        if (!await updateCurrentPeer(track)) return;
        track.enabled = enabled();
        if (old) { stream.removeTrack(old); old.stop(); }
        stream.addTrack(track);
        replacement.getTracks().filter(item => item !== track).forEach(item => item.stop());
        replacement = undefined;
        return;
      } catch (error) {
        stopTracks(replacement); replacement = undefined;
        lastError = error;
        if (!active()) return;
        if (!unavailableCamera(error) && !busyCamera(error)) throw error;
      }
    }
    if (lastError && busyCamera(lastError)) throw new Error("The other camera is busy. Close other apps using it, then try again.");
    throw new Error("Only one camera is available. Connect another camera to switch.");
  } catch (error) {
    if (!active()) return;
    if (released) {
      let restored: MediaStream | undefined;
      try {
        const target: MediaTrackConstraints = oldId ? { deviceId: { exact: oldId } } : { facingMode: oldFacing === "environment" ? "environment" : "user" };
        restored = await acquire(target);
        if (!active()) return;
        const track = restored.getVideoTracks()[0];
        if (!track) throw new Error("No restored camera track");
        track.enabled = enabled();
        if (!await updateCurrentPeer(track)) return;
        track.enabled = enabled();
        if (old) stream.removeTrack(old);
        stream.addTrack(track);
        restored.getTracks().filter(item => item !== track).forEach(item => item.stop());
        restored = undefined;
      } catch {
        throw new Error("The camera could not restart. Stop the call, check camera access, and try again.");
      } finally { stopTracks(restored); }
    } else if (old) {
      await Promise.allSettled([...changedSenders].map(sender => sender.replaceTrack(old)));
    }
    throw error;
  } finally {
    stopTracks(replacement);
    switching.delete(stream);
  }
}
