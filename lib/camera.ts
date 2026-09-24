/** Replace just video; preserve the microphone, mute state, and existing call. */
export async function changeCamera(stream: MediaStream, peer: () => RTCPeerConnection | null, active: () => boolean, enabled: () => boolean) {
  const old = stream.getVideoTracks()[0];
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === "videoinput");
  if (devices.length < 2) throw new Error("Only one camera is available. Connect another camera to switch.");
  const oldId = old?.getSettings().deviceId;
  const index = devices.findIndex(device => device.deviceId === oldId);
  const nextId = devices[(index + 1) % devices.length].deviceId;
  let replacement: MediaStream | undefined;
  let released = false;
  const acquire = (deviceId: string) => navigator.mediaDevices.getUserMedia({video:{deviceId:{exact:deviceId},width:{ideal:960},height:{ideal:540}},audio:false});
  try {
    try { replacement = await acquire(nextId); }
    catch (error) {
      // Some phones allow only one camera to be open at a time.
      if (!active() || !(error instanceof DOMException) || !["NotReadableError", "AbortError"].includes(error.name)) throw error;
      old?.stop(); released = true; replacement = await acquire(nextId);
    }
    if (!active()) return;
    const track = replacement.getVideoTracks()[0];
    track.enabled = enabled();
    const sender = peer()?.getSenders().find(item => item.track?.kind === "video");
    if (sender) await sender.replaceTrack(track);
    if (!active()) return;
    if (old) { stream.removeTrack(old); old.stop(); }
    stream.addTrack(track); replacement = undefined;
  } catch (error) {
    if (released && oldId && active()) {
      try {
        const restored = await acquire(oldId);
        if (!active()) { restored.getTracks().forEach(track => track.stop()); return; }
        const track = restored.getVideoTracks()[0]; track.enabled = enabled();
        try { await peer()?.getSenders().find(sender => sender.track?.kind === "video")?.replaceTrack(track); }
        catch (restoreError) { track.stop(); throw restoreError; }
        if (!active()) { track.stop(); return; }
        if (old) stream.removeTrack(old); stream.addTrack(track);
      } catch { throw new Error("The camera could not restart. Stop the call, check camera access, and try again."); }
    }
    throw error;
  } finally { replacement?.getTracks().forEach(track => track.stop()); }
}
