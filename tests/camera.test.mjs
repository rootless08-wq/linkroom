import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changeCamera } from '../lib/camera.ts';
function track(id,kind='video'){return {kind,enabled:true,stopped:false,getSettings(){return {deviceId:id}},stop(){this.stopped=true}}}
function stream(tracks){return {getTracks:()=>tracks,getVideoTracks:()=>tracks.filter(t=>t.kind==='video'),removeTrack(t){tracks.splice(tracks.indexOf(t),1)},addTrack(t){tracks.push(t)}}}
function devices(acquire,count=2){Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{enumerateDevices:async()=>['front','back'].slice(0,count).map(deviceId=>({kind:'videoinput',deviceId})),getUserMedia:acquire}}})}
test('camera replacement keeps microphone and disabled camera state',async()=>{
 const old=track('front'),audio=track('mic','audio'),next=track('back'),local=stream([old,audio]);let sent;
 devices(async()=>stream([next]));await changeCamera(local,()=>({getSenders:()=>[{track:old,replaceTrack:async t=>{sent=t}}]}),()=>true,()=>false);
 assert.equal(sent,next);assert.equal(next.enabled,false);assert.equal(old.stopped,true);assert.equal(audio.stopped,false);assert.deepEqual(local.getTracks(),[audio,next]);
});
test('exclusive mobile camera is retried after releasing old device',async()=>{
 const old=track('front'),next=track('back'),local=stream([old]);let attempts=0;
 devices(async()=>{if(++attempts===1)throw new DOMException('busy','NotReadableError');return stream([next])});
 await changeCamera(local,()=>null,()=>true,()=>true);assert.equal(attempts,2);assert.equal(old.stopped,true);assert.equal(local.getVideoTracks()[0],next);
});
test('stop during acquisition disposes new camera and single camera is explained',async()=>{
 const old=track('front'),next=track('back'),local=stream([old]);let active=true;
 devices(async()=>{active=false;return stream([next])});await changeCamera(local,()=>null,()=>active,()=>true);assert.equal(next.stopped,true);
 devices(async()=>stream([next]),1);await assert.rejects(changeCamera(local,()=>null,()=>true,()=>true),/Only one camera/);
});
