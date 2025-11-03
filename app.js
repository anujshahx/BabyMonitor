// ===== Configure your Firebase RTDB REST base =====
// Replace with: const SIGNAL_BASE = '<your databaseURL>/signals';
// Example: 'https://your-project-default-rtdb.us-central1.firebasedatabase.app/signals'
const SIGNAL_BASE = '<PASTE_DATABASE_URL>/signals'; // no trailing slash

// ===== WebRTC config (STUN only) =====
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// ===== State =====
let pc=null, localStream=null, monitorMicStream=null, monitorMicTrack=null, dataChannel=null, pollTimer=null;
let audioCtx=null, gain=null, currentOsc=null, currentSrc=null, melodyTimer=null, melodyActive=false;

const log = (...a)=>console.log('[BM]',...a);

// ===== UI helpers =====
const showPanel = id => { document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active')); document.getElementById(id).classList.add('active'); };
const showInfo = (id,msg)=>{ const el=document.getElementById(id); el.className='status info'; el.style.display='block'; el.textContent=msg; };
const showOk = (id,msg)=>{ const el=document.getElementById(id); el.className='status success'; el.style.display='block'; el.textContent=msg; };
const showErr = (id,msg)=>{ const el=document.getElementById(id); el.className='status error'; el.style.display='block'; el.textContent=msg; };

function showMonitor(){ showPanel('monitor'); }
function goHome(){ try{ clearInterval(pollTimer); }catch{} try{ if(pc) pc.close(); }catch{} try{ if(localStream) localStream.getTracks().forEach(t=>t.stop()); }catch{} try{ if(monitorMicStream) monitorMicStream.getTracks().forEach(t=>t.stop()); }catch{} try{ stopSoundOnCamera(); }catch{} location.reload(); }

// ===== Pair code helpers =====
function genCode(len=8){ const a='23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; let s=''; for(let i=0;i<len;i++) s+=a[Math.floor(Math.random()*a.length)]; return s; }
function regenCode(){ const c=genCode(); document.getElementById('pairCodeCam').value=c; localStorage.setItem('bm_code',c); showOk('cameraStatus','New code generated.'); }
function currentCode(){ return document.getElementById('pairCodeCam').value || localStorage.getItem('bm_code') || ''; }

// ===== REST helpers (Firebase RTDB .json endpoints) =====
async function putSignal(code, payload){
  const url = `${SIGNAL_BASE}/${encodeURIComponent(code)}.json`;
  const res = await fetch(url, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`PUT ${res.status}`); return res.json();
}
async function patchSignal(code, partial){
  const url = `${SIGNAL_BASE}/${encodeURIComponent(code)}.json`;
  const res = await fetch(url, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify(partial) });
  if (!res.ok) throw new Error(`PATCH ${res.status}`); return res.json();
}
async function getSignal(code, path=''){
  const url = `${SIGNAL_BASE}/${encodeURIComponent(code)}${path}.json?ts=${Date.now()}`;
  const res = await fetch(url); if (!res.ok) throw new Error(`GET ${res.status}`); return res.json();
}

// ===== CAMERA =====
async function initCamera(){
  showPanel('camera');
  let code = localStorage.getItem('bm_code'); if (!code){ code = genCode(); localStorage.setItem('bm_code', code); }
  document.getElementById('pairCodeCam').value = code;
  showInfo('cameraStatus','Starting camera…');
  await startCameraAndOffer(code);
  startAnswerPolling(code);
}

async function startCameraAndOffer(code){
  try{
    const stream = await navigator.mediaDevices.getUserMedia({
      video:{ facingMode:'environment', width:{ideal:1920}, height:{ideal:1080} },
      audio:{ echoCancellation:true, noiseSuppression:true, autoGainControl:true }
    });
    localStream = stream;
    document.getElementById('cameraVideo').srcObject = localStream;

    pc = new RTCPeerConnection(rtcConfig);

    dataChannel = pc.createDataChannel('ctrl');
    dataChannel.onmessage = ev => {
      try{
        const msg = JSON.parse(ev.data);
        if (msg.action==='play') playSoundOnCamera(msg.sound);
        if (msg.action==='stop') stopSoundOnCamera();
        if (msg.action==='ping') dataChannel.send(JSON.stringify({action:'ready'}));
      }catch{}
    };

    localStream.getTracks().forEach(t=>pc.addTrack(t, localStream));

    pc.ontrack = e=>{
      if (e.track.kind==='audio' && e.streams[0]){
        const ra = document.getElementById('remoteAudio');
        ra.srcObject = e.streams[0];
        ra.play().catch(()=>{});
      }
    };

    const gathered=[];
    pc.onicecandidate = e=>{ if (e.candidate) gathered.push(e.candidate); };
    pc.onicegatheringstatechange = async ()=>{
      if (pc.iceGatheringState==='complete'){
        const offerPkg = { sdp: pc.localDescription, candidates: gathered };
        document.getElementById('offerText').value = JSON.stringify(offerPkg);
        // Write server timestamp then offer under this code
        try{
          await patchSignal(code, { "ts": { ".sv": "timestamp" } });
          await patchSignal(code, { offer: offerPkg });
          showOk('cameraStatus','Offer stored under code.');
        }catch(e){
          showErr('cameraStatus','Store error: ' + e.message);
        }
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
  }catch(err){
    showErr('cameraStatus','Error: ' + err.message);
  }
}

function startAnswerPolling(code){
  try{ clearInterval(pollTimer); }catch{}
  pollTimer = setInterval(async ()=>{
    try{
      const ans = await getSignal(code, '/answer');
      if (!ans) return;
      document.getElementById('answerInput').value = JSON.stringify(ans);
      await pc.setRemoteDescription(ans.sdp);
      if (ans.candidates) for (const c of ans.candidates){ await pc.addIceCandidate(c); }
      showOk('cameraStatus','Connected. Monitor can control sounds.');
      clearInterval(pollTimer);
    }catch(e){
      // ignore transient GET/SDP errors during race
    }
  }, 1200);
}

// ===== MONITOR =====
async function monitorConnectByCode(){
  const code = (document.getElementById('pairCodeMon').value||'').trim();
  if (!code) return showErr('monitorStatus','Enter the code.');
  try{
    showInfo('monitorStatus','Fetching offer by code…');
    const offer = await getSignal(code, '/offer');
    if (!offer) return showErr('monitorStatus','No offer found for this code.');
    document.getElementById('offerInput').value = JSON.stringify(offer);
    await createAnswerFromOffer(code, offer);
  }catch(e){
    showErr('monitorStatus','Connect error: ' + e.message);
  }
}

async function createAnswerFromOffer(code, offer){
  try{
    pc = new RTCPeerConnection(rtcConfig);

    pc.ondatachannel = ev=>{
      dataChannel = ev.channel;
      dataChannel.onopen = ()=> startPinging();
      dataChannel.onmessage = e=>{
        try{
          const msg = JSON.parse(e.data);
          if (msg.action==='ready'){
            enableSoundButtons();
            showOk('monitorStatus','Handshake complete. Sounds ready.');
          }
        }catch{}
      };
    };

    pc.onconnectionstatechange = ()=>{
      if ((pc.connectionState==='connected'||pc.connectionState==='completed') && dataChannel?.readyState==='open'){
        enableSoundButtons();
        showOk('monitorStatus','Connected. Sounds enabled.');
        stopPinging();
      }
    };

    pc.ontrack = e=>{
      if (e.track.kind==='video'){
        document.getElementById('monitorVideo').srcObject = e.streams[0];
        document.getElementById('micBtn').style.display='flex';
      }
    };

    try{
      monitorMicStream = await navigator.mediaDevices.getUserMedia({ audio:{ echoCancellation:true, noiseSuppression:true, autoGainControl:true } });
      monitorMicTrack = monitorMicStream.getAudioTracks()[0];
      monitorMicTrack.enabled = false;
      pc.addTrack(monitorMicTrack, monitorMicStream);
    }catch{}

    await pc.setRemoteDescription(offer.sdp);
    if (offer.candidates) for (const c of offer.candidates){ await pc.addIceCandidate(c); }

    const gathered=[];
    pc.onicecandidate = e=>{ if (e.candidate) gathered.push(e.candidate); };
    pc.onicegatheringstatechange = async ()=>{
      if (pc.iceGatheringState==='complete'){
        const answerPkg = { sdp: pc.localDescription, candidates: gathered };
        document.getElementById('answerText').value = JSON.stringify(answerPkg);
        document.getElementById('monitorStep2').style.display='block';
        try{
          await patchSignal(code, { answer: answerPkg });
          showOk('monitorStatus','Answer stored. Camera will auto‑connect.');
        }catch(e){
          showErr('monitorStatus','Store error: ' + e.message);
        }
      }
    };

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
  }catch(e){
    showErr('monitorStatus','Answer error: ' + e.message);
  }
}

// ===== Ping (monitor -> camera) =====
let pingTimer=null;
function startPinging(){ stopPinging(); const hint=document.getElementById('soundHint'); let dots=0; pingTimer=setInterval(()=>{ if (dataChannel?.readyState!=='open') return; try{ dataChannel.send(JSON.stringify({action:'ping'})); }catch{} dots=(dots+1)%4; hint.textContent='Waiting for Camera handshake' + '.'.repeat(dots); }, 800); }
function stopPinging(){ if (pingTimer){ clearInterval(pingTimer); pingTimer=null; } }

// ===== Sounds control =====
function enableSoundButtons(){ document.querySelectorAll('.sound-btn').forEach(b=> b.disabled=false); const hint=document.getElementById('soundHint'); hint.textContent='🎵 Sounds ready'; hint.style.opacity='1'; stopPinging(); }
function playSound(el, kind){ if (!dataChannel || dataChannel.readyState!=='open'){ showErr('monitorStatus','Connection not ready yet.'); return; } document.querySelectorAll('.sound-btn:not(.stop)').forEach(b=> b.classList.remove('active')); el.classList.add('active'); try{ dataChannel.send(JSON.stringify({ action:'play', sound: kind })); }catch{} showOk('monitorStatus','Playing '+ el.textContent.replaceAll('\n',' ').trim()); }
function stopSound(){ if (dataChannel && dataChannel.readyState==='open'){ try{ dataChannel.send(JSON.stringify({ action:'stop' })); }catch{} } document.querySelectorAll('.sound-btn').forEach(b=> b.classList.remove('active')); showInfo('monitorStatus','Sound stopped.'); }

// ===== Push-to-talk =====
function startTalking(){ const b=document.getElementById('micBtn'); b.classList.add('active'); b.textContent='🔴'; if (monitorMicTrack) monitorMicTrack.enabled=true; }
function stopTalking(){ const b=document.getElementById('micBtn'); b.classList.remove('active'); b.textContent='🎤'; if (monitorMicTrack) monitorMicTrack.enabled=false; }

// ===== Camera audio engine =====
async function ensureAudioRunning(){ if (!audioCtx){ audioCtx = new (window.AudioContext||window.webkitAudioContext)(); gain = audioCtx.createGain(); gain.gain.value=.28; gain.connect(audioCtx.destination); } if (audioCtx.state==='suspended'){ try{ await audioCtx.resume(); }catch{} } }
function stopSoundOnCamera(){ melodyActive=false; if (melodyTimer){ try{ clearTimeout(melodyTimer); }catch{} melodyTimer=null; try{ if (currentOsc){ currentOsc.onended=null; currentOsc.stop(0); currentOsc.disconnect(); } }catch{} currentOsc=null; try{ if (currentSrc){ currentSrc.onended=null; currentSrc.stop(0); currentSrc.disconnect(); } }catch{} currentSrc=null; }
async function playSoundOnCamera(kind){ await ensureAudioRunning(); stopSoundOnCamera(); if (kind==='whitenoise') return playWhiteNoise(); if (kind==='rain') return playRain(); if (kind==='lullaby1') return playMelody([261.63,261.63,392.00,392.00,440.00,440.00,392.00,349.23,349.23,329.63,329.63,293.66,293.66,261.63], .52, 620); if (kind==='lullaby2') return playMelody([329.63,293.66,293.66,329.63,293.66,261.63,293.66,329.63,329.63,293.66], .52, 620); }
function playMelody(notes, noteDur=.5, gapMs=620){ melodyActive=true; let i=0; const step=()=>{ if (!melodyActive) return; const osc=audioCtx.createOscillator(); osc.type='sine'; osc.frequency.value=notes[i]; osc.connect(gain); currentOsc=osc; const stopAt=audioCtx.currentTime+noteDur; osc.start(); osc.stop(stopAt); osc.onended=()=>{ if (!melodyActive) return; i=(i+1)%notes.length; melodyTimer=setTimeout(step,gapMs); }; }; step(); }
function playWhiteNoise(){ const n=audioCtx.sampleRate*2, buf=audioCtx.createBuffer(1,n,audioCtx.sampleRate), ch=buf.getChannelData(0); for(let i=0;i<n;i++) ch[i]=Math.random()*2-1; const src=audioCtx.createBufferSource(); src.buffer=buf; src.loop=true; src.connect(gain); src.start(0); currentSrc=src; }
function playRain(){ const n=audioCtx.sampleRate*2, buf=audioCtx.createBuffer(1,n,audioCtx.sampleRate), ch=buf.getChannelData(0); for(let i=0;i<n;i++) ch[i]=(Math.random()*2-1)*0.5; const lp=audioCtx.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=900; const src=audioCtx.createBufferSource(); src.buffer=buf; src.loop=true; src.connect(lp); lp.connect(gain); src.start(0); currentSrc=src; }
