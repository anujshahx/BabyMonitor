// app.js

// STUN only; add TURN for internet NAT traversal if needed
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// State
let pc = null;
let localStream = null;            // camera device
let cameraAudioTrack = null;       // camera mic (optional use)
let monitorMicStream = null;       // monitor talk-back
let monitorMicTrack = null;        // monitor talk-back track
let dataChannel = null;            // ctrl channel
let pingTimer = null;              // monitor handshake pinger

// Web Audio (camera phone)
let audioCtx = null;
let gain = null;
let currentOsc = null;
let currentSrc = null;
let melodyTimer = null;
let melodyActive = false;

const log = (...a) => console.log('[BM]', ...a);

// UI helpers
const showPanel = id => {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById(id).classList.add('active');
};
const showInfo = (id,msg) => { const el = document.getElementById(id); el.className='status info'; el.style.display='block'; el.textContent = msg; };
const showOk   = (id,msg)   => { const el = document.getElementById(id); el.className='status success'; el.style.display='block'; el.textContent = msg; };
const showErr  = (id,msg)   => { const el = document.getElementById(id); el.className='status error'; el.style.display='block'; el.textContent = msg; };

function showMonitor(){ showPanel('monitor'); }

// Reset
function goHome(){
  try { if (pingTimer) clearInterval(pingTimer); } catch{}
  try { if (pc) pc.close(); } catch{}
  try { if (localStream) localStream.getTracks().forEach(t=>t.stop()); } catch{}
  try { if (monitorMicStream) monitorMicStream.getTracks().forEach(t=>t.stop()); } catch{}
  try { stopSoundOnCamera(); } catch{}
  location.reload();
}

// Clipboard
function copyOffer(){ const t=document.getElementById('offerText'); t.select(); document.execCommand('copy'); showOk('cameraStatus','Copied offer. Send to Monitor.'); }
function copyAnswer(){ const t=document.getElementById('answerText'); t.select(); document.execCommand('copy'); showOk('monitorStatus','Copied answer. Send back to Camera.'); }

// Web Share helpers (files)
async function shareOfferFile(){
  try{
    const txt = document.getElementById('offerText').value.trim();
    if (!txt){ showErr('cameraStatus','Generate the offer first.'); return; }
    const file = new File([txt], 'offer.json', { type: 'application/json' }); // create a shareable File [web:448][web:451]
    if (navigator.canShare && navigator.canShare({ files: [file] })){
      await navigator.share({ files: [file], title: 'Baby Monitor Offer', text: 'Offer SDP+ICE' }); // user-gesture share [web:445][web:424]
      showOk('cameraStatus','Shared offer file via system share.');
    } else {
      downloadTextFile('offer.json', txt, 'application/json'); // fallback: download locally [web:452][web:450]
      showInfo('cameraStatus','This device cannot share files; downloaded offer.json instead.');
    }
  }catch(e){
    showErr('cameraStatus','Share canceled or failed: ' + (e.message||e));
  }
}

async function shareAnswerFile(){
  try{
    const txt = document.getElementById('answerText').value.trim();
    if (!txt){ showErr('monitorStatus','Create the answer first.'); return; }
    const file = new File([txt], 'answer.json', { type: 'application/json' }); // JSON file payload [web:448][web:451]
    if (navigator.canShare && navigator.canShare({ files: [file] })){
      await navigator.share({ files: [file], title: 'Baby Monitor Answer', text: 'Answer SDP+ICE' }); // share to OS sheet [web:445][web:424]
      showOk('monitorStatus','Shared answer file via system share.');
    } else {
      downloadTextFile('answer.json', txt, 'application/json'); // fallback download [web:452][web:450]
      showInfo('monitorStatus','This device cannot share files; downloaded answer.json instead.');
    }
  }catch(e){
    showErr('monitorStatus','Share canceled or failed: ' + (e.message||e));
  }
}

// Local download fallback
function downloadTextFile(filename, content, mime){
  const blob = new Blob([content], { type: mime || 'text/plain' }); // build Blob for file data [web:452][web:454]
  const url = URL.createObjectURL(blob); // object URL for download [web:452][web:450]
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url); // trigger and cleanup [web:450][web:452]
}

// CAMERA side
async function initCamera(){
  showPanel('camera');
  showInfo('cameraStatus','Starting camera…');
  await startCamera();
}

async function startCamera(){
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: {ideal:1920}, height: {ideal:1080} },
      audio: { echoCancellation:true, noiseSuppression:true, autoGainControl:true }
    });
    document.getElementById('cameraVideo').srcObject = localStream;

    cameraAudioTrack = localStream.getAudioTracks()[0] || null;

    pc = new RTCPeerConnection(rtcConfig);

    // Offerer creates DC
    dataChannel = pc.createDataChannel('ctrl');
    dataChannel.onopen = () => log('Camera DC open');
    dataChannel.onclose = () => log('Camera DC close');
    dataChannel.onerror = (e) => log('Camera DC error', e);
    dataChannel.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        log('Camera got', msg);
        if (msg.action === 'play') playSoundOnCamera(msg.sound);
        if (msg.action === 'stop') stopSoundOnCamera();
        if (msg.action === 'ping') dataChannel.send(JSON.stringify({action:'ready'}));
      } catch(e){ log('Camera msg parse error', e); }
    };

    // Tracks
    localStream.getTracks().forEach(tr => pc.addTrack(tr, localStream));

    // Monitor talk-back to camera
    pc.ontrack = (e) => {
      if (e.track.kind === 'audio' && e.streams[0]) {
        const ra = document.getElementById('remoteAudio');
        ra.srcObject = e.streams[0];
        ra.play().catch(()=>{});
      }
    };

    // ICE → offer pkg
    const gathered = [];
    pc.onicecandidate = (ev)=>{ if (ev.candidate) gathered.push(ev.candidate); };
    pc.onicegatheringstatechange = ()=>{
      if (pc.iceGatheringState === 'complete') {
        const offerPkg = { sdp: pc.localDescription, candidates: gathered };
        document.getElementById('offerText').value = JSON.stringify(offerPkg);
        showOk('cameraStatus','Camera ready. Copy/share the offer.');
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

  } catch(err){
    showErr('cameraStatus','Error: '+ err.message);
  }
}

async function connectCamera(){
  try {
    const val = document.getElementById('answerInput').value.trim();
    if (!val) return showErr('cameraStatus','Paste the answer first.');
    const answer = JSON.parse(val);
    await pc.setRemoteDescription(answer.sdp);
    if (answer.candidates) for (const c of answer.candidates){ await pc.addIceCandidate(c); }
    showOk('cameraStatus','Connected. Monitor can now control sounds.');
  } catch(err){
    showErr('cameraStatus','Error: '+ err.message);
  }
}

// MONITOR side
async function createAnswer(){
  try {
    const val = document.getElementById('offerInput').value.trim();
    if (!val) return showErr('monitorStatus','Paste the camera offer first.');
    showInfo('monitorStatus','Creating connection…');

    const offer = JSON.parse(val);
    pc = new RTCPeerConnection(rtcConfig);

    // Receive DC
    pc.ondatachannel = (ev)=>{
      dataChannel = ev.channel;
      log('Monitor received DC', dataChannel.label);
      dataChannel.onopen = ()=> { log('Monitor DC open'); startPinging(); };
      dataChannel.onmessage = (e)=>{
        try {
          const msg = JSON.parse(e.data);
          log('Monitor got', msg);
          if (msg.action === 'ready') {
            enableSoundButtons();
            showOk('monitorStatus','Handshake complete. Sounds ready.');
          }
        } catch(err){ log('Monitor msg parse err', err); }
      };
      dataChannel.onclose = ()=> log('Monitor DC close');
      dataChannel.onerror = (e)=> log('Monitor DC error', e);
    };

    // Fallback enable on full connect
    pc.onconnectionstatechange = ()=>{
      log('PC state', pc.connectionState);
      if ((pc.connectionState === 'connected' || pc.connectionState === 'completed') && dataChannel && dataChannel.readyState === 'open'){
        enableSoundButtons();
        showOk('monitorStatus','Connected. Sounds enabled.');
        stopPinging();
      }
    };

    // Show camera media on monitor
    pc.ontrack = (e)=>{
      if (e.track.kind === 'video') {
        document.getElementById('monitorVideo').srcObject = e.streams[0];
        document.getElementById('micBtn').style.display = 'flex';
      }
    };

    // Add monitor mic (muted)
    try {
      monitorMicStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation:true, noiseSuppression:true, autoGainControl:true } });
      monitorMicTrack = monitorMicStream.getAudioTracks()[0];
      monitorMicTrack.enabled = false;
      pc.addTrack(monitorMicTrack, monitorMicStream);
    } catch(e){
      log('Monitor mic denied', e);
    }

    // ICE → answer pkg
    const gathered = [];
    pc.onicecandidate = (ev)=>{ if (ev.candidate) gathered.push(ev.candidate); };
    pc.onicegatheringstatechange = ()=>{
      if (pc.iceGatheringState === 'complete') {
        const answerPkg = { sdp: pc.localDescription, candidates: gathered };
        document.getElementById('answerText').value = JSON.stringify(answerPkg);
        document.getElementById('monitorStep2').style.display = 'block';
        showOk('monitorStatus','Answer ready. Copy/share back to Camera.');
      }
    };

    await pc.setRemoteDescription(offer.sdp);
    if (offer.candidates) for (const c of offer.candidates){ await pc.addIceCandidate(c); }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

  } catch(err){
    showErr('monitorStatus','Error: '+ err.message);
  }
}

// Handshake pinger
function startPinging(){
  stopPinging();
  const hint = document.getElementById('soundHint');
  let dots = 0;
  pingTimer = setInterval(()=>{
    if (!dataChannel || dataChannel.readyState !== 'open') return;
    try { dataChannel.send(JSON.stringify({action:'ping'})); } catch {}
    dots = (dots+1)%4;
    hint.textContent = 'Waiting for Camera handshake' + '.'.repeat(dots);
  }, 800);
}
function stopPinging(){ if (pingTimer){ clearInterval(pingTimer); pingTimer = null; } }

// Sounds UI
function enableSoundButtons(){
  document.querySelectorAll('.sound-btn').forEach(b=> b.disabled = false);
  const hint = document.getElementById('soundHint');
  hint.textContent = '🎵 Sounds ready';
  hint.style.opacity = '1';
  stopPinging();
}

// Push-to-talk
function startTalking(){
  const btn = document.getElementById('micBtn');
  btn.classList.add('active'); btn.textContent = '🔴';
  if (monitorMicTrack) monitorMicTrack.enabled = true;
}
function stopTalking(){
  const btn = document.getElementById('micBtn');
  btn.classList.remove('active'); btn.textContent = '🎤';
  if (monitorMicTrack) monitorMicTrack.enabled = false;
}

// Monitor → Camera sound commands
function playSound(el, kind){
  if (!dataChannel || dataChannel.readyState !== 'open') {
    showErr('monitorStatus','Connection not ready yet.');
    return;
  }
  document.querySelectorAll('.sound-btn:not(.stop)').forEach(b=> b.classList.remove('active'));
  el.classList.add('active');
  try { dataChannel.send(JSON.stringify({ action:'play', sound: kind })); } catch {}
  showOk('monitorStatus','Playing '+ el.textContent.replaceAll('\n',' ').trim());
}
function stopSound(){
  if (dataChannel && dataChannel.readyState === 'open') {
    try { dataChannel.send(JSON.stringify({ action:'stop' })); } catch {}
  }
  document.querySelectorAll('.sound-btn').forEach(b=> b.classList.remove('active'));
  showInfo('monitorStatus','Sound stopped.');
}

// Camera audio engine
async function ensureAudioRunning() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    gain = audioCtx.createGain();
    gain.gain.value = 0.28;
    gain.connect(audioCtx.destination);
  }
  if (audioCtx.state === 'suspended') {
    try { await audioCtx.resume(); } catch {}
  }
}

function stopSoundOnCamera() {
  melodyActive = false;
  if (melodyTimer) { try { clearTimeout(melodyTimer); } catch{} melodyTimer = null; }

  try { if (currentOsc) { currentOsc.onended = null; currentOsc.stop(0); } } catch{}
  try { if (currentOsc) currentOsc.disconnect(); } catch{}
  currentOsc = null;

  try { if (currentSrc) { currentSrc.onended = null; currentSrc.stop(0); } } catch{}
  try { if (currentSrc) currentSrc.disconnect(); } catch{}
  currentSrc = null;
}

async function playSoundOnCamera(kind) {
  await ensureAudioRunning();
  stopSoundOnCamera();

  if (kind === 'whitenoise') return playWhiteNoise();
  if (kind === 'rain') return playRain();
  if (kind === 'lullaby1') return playMelody([261.63,261.63,392.00,392.00,440.00,440.00,392.00,349.23,349.23,329.63,329.63,293.66,293.66,261.63], 0.52, 620);
  if (kind === 'lullaby2') return playMelody([329.63,293.66,293.66,329.63,293.66,261.63,293.66,329.63,329.63,293.66], 0.52, 620);
}

function playMelody(notes, noteDur = 0.5, gapMs = 620) {
  melodyActive = true;
  let i = 0;

  const step = () => {
    if (!melodyActive) return;

    const osc = audioCtx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = notes[i];
    osc.connect(gain);
    currentOsc = osc;

    const stopAt = audioCtx.currentTime + noteDur;
    osc.start();
    osc.stop(stopAt);

    osc.onended = () => {
      if (!melodyActive) return;
      i = (i + 1) % notes.length;
      melodyTimer = setTimeout(step, gapMs);
    };
  };

  step();
}

function playWhiteNoise() {
  const frames = audioCtx.sampleRate * 2;
  const buf = audioCtx.createBuffer(1, frames, audioCtx.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) ch[i] = Math.random() * 2 - 1;

  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.connect(gain);
  src.start(0);
  currentSrc = src;
}

function playRain() {
  const frames = audioCtx.sampleRate * 2;
  const buf = audioCtx.createBuffer(1, frames, audioCtx.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) ch[i] = (Math.random() * 2 - 1) * 0.5;

  const lp = audioCtx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 900;

  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.connect(lp);
  lp.connect(gain);
  src.start(0);
  currentSrc = src;
}
