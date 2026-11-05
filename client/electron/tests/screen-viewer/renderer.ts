import { RemoteScreenViewer, supportedScreenCodecs } from '../../../src/remote-screen-viewer.js';
import { writeScreenFrame } from '../../../../src/client-protocol/screen-wire.js';
const invoke=(command:string,args?:unknown)=>window.tarobotDesktop!.invoke(command,args);
let source:MessagePort, viewer:RemoteScreenViewer, timer:ReturnType<typeof setInterval>, encoder:VideoEncoder, decoded=0, copyPreserved=true, seq=0, done=false;
let canvasResizes=0, stateChanges=0, sharp=false;
let width=640,height=360;
const view=document.querySelector<HTMLCanvasElement>('#view')!;
for(const key of ['width','height'] as const){const descriptor=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,key)!;Object.defineProperty(view,key,{get(){return descriptor.get!.call(this);},set(value:number){canvasResizes++;descriptor.set!.call(this,value);}});}
const pending=new Map<number,number>(), scene=document.createElement('canvas');scene.width=640;scene.height=360;const ctx=scene.getContext('2d')!;
window.addEventListener('message',event=>{if(event.data?.type!=='screen-smoke-source'||event.ports.length!==1)return;source=event.ports[0]!;source.onmessage=({data})=>{
 if(data.type==='start')void start().catch(fail);
 if(data.type==='credit'){pending.delete(data.sequence);decoded++;if(decoded>=40)void finish();}
};source.start();});
const fail=(error:unknown)=>invoke('failure',String(error));
async function start(){
 await supportedScreenCodecs(sharp?'sharp':'balanced');
 const codec=sharp?'h264':'vp8', codecString=sharp?'avc1.640033':'vp8';
 const config:VideoEncoderConfig={codec:codecString,width,height,framerate:15,latencyMode:'realtime',...(sharp?{avc:{format:'annexb'},hardwareAcceleration:'prefer-hardware',bitrateMode:'quantizer'}:{bitrate:1500000})};
 if(!(await VideoEncoder.isConfigSupported(config)).supported)throw new Error('encoder_unavailable');
 source.postMessage({type:'stream',streamGeneration:1,geometryRevision:1,codec,codecString,width,height,contentRect:{x:0,y:0,width,height}});
 encoder=new VideoEncoder({error:fail,output:chunk=>{const captureMs=pending.get(chunk.timestamp);if(captureMs===undefined)throw new Error('unknown_encoded_frame');const data=new Uint8Array(chunk.byteLength);chunk.copyTo(data);const frame=writeScreenFrame({key:chunk.type==='key',codec,sequence:chunk.timestamp,geometryRevision:1,streamGeneration:1,captureMs,width,height},data);const bytes=frame.byteLength;source.postMessage(frame.buffer);copyPreserved&&=frame.byteLength===bytes;}});encoder.configure(config);
 timer=setInterval(()=>{if(done||pending.size>=3)return;const sequence=++seq;ctx.fillStyle='#1234bc';ctx.fillRect(0,0,width,height);ctx.fillStyle='white';ctx.fillRect(100+sequence%100,100,120,100);const frame=new VideoFrame(scene,{timestamp:sequence});pending.set(sequence,Date.now());encoder.encode(frame,{keyFrame:sequence===1,...(sharp?{avc:{quantizer:28}}:{})});frame.close();},66);
}
async function finish(){if(done)return;done=true;clearInterval(timer);await encoder.flush();encoder.close();const canvas=document.querySelector<HTMLCanvasElement>('#view')!, pixel=canvas.getContext('2d')!.getImageData(10,10,1,1).data;
 viewer.dispose();source.close();await invoke('result',{width,height,decoded,copyPreserved,canvasResizes,stateChanges,pixelVerified:canvas.width===width&&canvas.height===height&&pixel[2]!>140&&pixel[0]!<60});}
void(async()=>{let captureError;try{await navigator.mediaDevices.getDisplayMedia({video:true,audio:false});throw new Error('capture_must_be_denied');}catch(error){captureError=String((error as Error).name);}const probe=await invoke('probe-result',{captureError}) as any;if(probe.captureProbeRequests!==1||probe.captureProbeGesture!==false)throw new Error(`capture_probe:${JSON.stringify(probe)}:${captureError}`);const {join,network,quality}=await invoke('setup') as any;sharp=quality==='sharp';if(sharp){width=3072;height=1920;scene.width=width;scene.height=height;}viewer=new RemoteScreenViewer(join,document.querySelector<HTMLCanvasElement>('#view')!,state=>{stateChanges++;if(state.state==='closed'&&!done)void fail(state.reason);});await viewer.open(network);})().catch(fail);
