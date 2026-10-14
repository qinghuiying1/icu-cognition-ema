import type { Word } from './model';

class MemoryAudio {
  private context: AudioContext|null=null;
  private buffers=new Map<string,AudioBuffer>();
  private preparing: Promise<void>|null=null;
  private sources: AudioBufferSourceNode[]=[];
  private cancel: ((e:Error)=>void)|null=null;
  private playing: Promise<void>|null=null;
  async prepare(): Promise<void> {
    if(this.preparing) return this.preparing;
    this.preparing=(async()=>{
      this.context??=new AudioContext();
      const response=await fetch(new URL('material-manifest.json',document.baseURI));
      if(!response.ok) throw new Error('固定语音清单加载失败。');
      const manifest=await response.json() as {audio:{id:string,url:string,sha256:string}[]};
      await Promise.all(manifest.audio.map(async a=>{
        const res=await fetch(new URL(a.url,document.baseURI));if(!res.ok) throw new Error('语音加载失败：'+a.id);
        const bytes=await res.arrayBuffer();
        const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
        if(hash!==a.sha256) throw new Error('固定语音校验失败：'+a.id);
        this.buffers.set(a.id,await this.context!.decodeAudioData(bytes));
      }));
    })().catch(e=>{this.preparing=null;throw e;});
    return this.preparing;
  }
  private async play(ids:string[], onStart?:()=>void,onEnd?:()=>void):Promise<void> {
    // Capture user activation before resource loading (required on Android browsers).
    this.context??=new AudioContext();
    await this.context.resume(); await this.prepare();
    if(this.context.state!=='running') throw new Error('音频尚未启用，请点击播放并检查平板音量。');
    // Serialize cues when paper scoring is quicker than the previous stop audio.
    if(this.playing) await this.playing;
    const buffers=ids.map(id=>{const b=this.buffers.get(id);if(!b) throw new Error('缺少固定语音：'+id);return b;});
    const playback=new Promise<void>((resolve,reject)=>{
      this.cancel=reject;
      const start=this.context!.currentTime;
      this.sources=buffers.map((buffer,i)=>{
        const source=this.context!.createBufferSource();source.buffer=buffer;source.connect(this.context!.destination);
        if(i===buffers.length-1) source.onended=()=>{this.sources=[];this.cancel=null;try{onEnd?.();resolve();}catch(e){reject(e);}};
        source.start(start+i);return source;
      });
      onStart?.();
    });
    this.playing=playback;
    try { await playback; } finally {if(this.playing===playback)this.playing=null;}
  }
  playWords(words:Word[],onStart?:()=>void,onEnd?:()=>void):Promise<void> {return this.play(words.map(w=>w.id),onStart,onEnd);}
  playCue(id:string,onStart?:()=>void):Promise<void> {return this.play([id==='delayed'?'delay-cue':id],onStart);}
  stop():void {
    const reject=this.cancel;this.cancel=null;
    for(const s of this.sources){s.onended=null;try{s.stop();}catch{/* already ended */}}
    this.sources=[];reject?.(new Error('语音播放已中断。'));
  }
}
export const memoryAudio=new MemoryAudio();
