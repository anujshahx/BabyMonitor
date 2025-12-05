// Firebase config & init (replace with your own project values)
const firebaseConfig = {
  apiKey: "AIzaSyBjtdeKEtw_FpcMC6Ab4uE2V9pZLAxr0dQ",
  authDomain: "baby-monitor-b862d.firebaseapp.com",
  databaseURL: "https://baby-monitor-b862d-default-rtdb.firebaseio.com",
  projectId: "baby-monitor-b862d",
  storageBucket: "baby-monitor-b862d.firebasestorage.app",
  messagingSenderId: "802534707567",
  appId: "1:802534707567:web:36d267b573f903bf25d89a"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();
const auth = firebase.auth();

// Sign in anonymously so rules can require auth != null
auth.signInAnonymously().catch(err => {
  console.error('Auth error', err);
});

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
let currentRoomCode = null;        // shared between camera & monitor for this session

// Web Audio state (camera phone)
let audioCtx = null;
let gain = null;
let currentOsc = null;   // active OscillatorNode (melody note)
let currentSrc = null;   // active AudioBufferSourceNode (noise/rain)
let melodyTimer = null;  // timeout id for next note
let melodyActive = false;

const log = (...a) => console.log('[BM]', ...a);

// UI helpers
function showPanel(id) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
const showInfo = (id,msg) => {
  const el = document.getElementById(id);
  el.className='status info';
  el.style.display='block';
  el.textContent = msg;
};
const showOk   = (id,msg) => {
  const el = document.getElementById(id);
  el.className='status success';
  el.style.display='block';
  el.textContent = msg;
};
const showErr  = (id,msg) => {
  const el = document.getElementById(id);
  el.className='status error';
  el.style.display='block';
  el.textContent = msg;
};

function showMonitor(){ showPanel('monitor'); }

function goHome(){
  try { if (pingTimer) clearInterval(pingTimer); } catch{}
  try { if (pc) pc.close(); } catch{}
  try { if (localStream) localStream.getTracks().forEach(t=>t.stop()); } catch{}
  try { if (monitorMicStream) monitorMicStream.getTracks().forEach(t=>t.stop()); } catch{}
  try { stopSoundOnCamera(); } catch{}
  if (currentRoomCode) {
    try { db.ref('rooms/' + currentRoomCode).remove(); } catch {}
  }
  location.reload();
}

// Small OTP / room code
function generateRoomCode() {
  return Math.floor(1000 + Math.random() * 9000).toString(); // 4-digit code
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

    const camVideo = document.getElementById('cameraVideo');
    camVideo.srcObject = localStream;

    cameraAudioTrack = localStream.getAudioTracks()[0] || null;

    pc = new RTCPeerConnection(rtcConfig);

    // Create DataChannel on OFFERER before createOffer
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

    // Add camera tracks
    localStream.getTracks().forEach(tr => pc.addTrack(tr, localStream));

    // Remote audio from monitor (talk-back)
    pc.ontrack = (e) => {
      if (e.track.kind === 'audio' && e.streams[0]) {
        const ra = document.getElementById('remoteAudio');
        ra.srcObject = e.streams[0];
        ra.play().catch(()=>{});
      }
    };

    // ICE gather → export offer pkg via Firebase
    const gathered = [];
    pc.onicecandidate = (ev)=>{ if (ev.candidate) gathered.push(ev.candidate); };
    pc.onicegatheringstatechange = ()=>{
      if (pc.iceGatheringState === 'complete') {
        const offerPkg = { sdp: pc.localDescription, candidates: gathered };
        const roomCode = generateRoomCode();
        currentRoomCode = roomCode;

        db.ref('rooms/' + roomCode + '/offer').set(offerPkg)
          .then(() => {
            document.getElementById('roomCodeDisplay').textContent = roomCode;
            showOk('cameraStatus','Camera ready. Share code: ' + roomCode);

            // Listen for answer
            db.ref('rooms/' + roomCode + '/answer').on('value', async snap => {
              const answer = snap.val();
              if (!answer || !pc || pc.signalingState === 'stable') return;
              try {
                await pc.setRemoteDescription(answer.sdp);
                if (answer.candidates)
                  for (const c of answer.candidates){ await pc.addIceCandidate(c); }
                showOk('cameraStatus','Connected to Monitor via room ' + roomCode);
              } catch(err){
                showErr('cameraStatus','Error applying answer: '+ err.message);
              }
            });
          })
          .catch(err => {
            showErr('cameraStatus','Firebase error: ' + err.message);
          });
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

  } catch(err){
    showErr('cameraStatus','Error: '+ err.message);
  }
}

// MONITOR side
async function joinRoom() {
  const code = document.getElementById('roomCodeInput').value.trim();
  if (!code) {
    showErr('monitorStatus','Enter the room code first.');
    return;
  }
  showInfo('monitorStatus','Looking up room ' + code + '…');
  currentRoomCode = code;

  try {
    const snap = await db.ref('rooms/' + code + '/offer').get();
    if (!snap.exists()) {
      showErr('monitorStatus','No offer found for this code.');
      return;
    }
    const offer = snap.val();
    await createAnswerFromOffer(offer, code);
  } catch (err) {
    showErr('monitorStatus','Firebase error: ' + err.message);
  }
}

async function createAnswerFromOffer(offer, roomCode){
  try {
    pc = new RTCPeerConnection(rtcConfig);

    // Receive camera-created DC
    pc.ondatachannel = (ev)=>{
      dataChannel = ev.channel;
      log('Monitor received DC', dataChannel.label);
      dataChannel.onopen = ()=> {
        log('Monitor DC open');
        startPinging();
      };
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

    // Fallback: enable if connected and DC open
    pc.onconnectionstatechange = ()=>{
      log('PC state', pc.connectionState);
      if ((pc.connectionState === 'connected' || pc.connectionState === 'completed') &&
          dataChannel && dataChannel.readyState === 'open'){
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

    // Add monitor mic (muted by default)
    try {
      monitorMicStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation:true, noiseSuppression:true, autoGainControl:true }
      });
      monitorMicTrack = monitorMicStream.getAudioTracks()[0];
      monitorMicTrack.enabled = false;
      pc.addTrack(monitorMicTrack, monitorMicStream);
    } catch(e){
      log('Monitor mic denied', e);
    }

    // ICE gather → export answer pkg via Firebase
    const gathered = [];
    pc.onicecandidate = (ev)=>{ if (ev.candidate) gathered.push(ev.candidate); };
    pc.onicegatheringstatechange = ()=>{
      if (pc.iceGatheringState === 'complete') {
        const answerPkg = { sdp: pc.localDescription, candidates: gathered };
        db.ref('rooms/' + roomCode + '/answer').set(answerPkg)
          .then(() => {
            document.getElementById('monitorStep2').style.display = 'block';
            showOk('monitorStatus','Connected. Watch and control sounds.');
          })
          .catch(err => {
            showErr('monitorStatus','Firebase error: ' + err.message);
          });
      }
    };

    await pc.setRemoteDescription(offer.sdp);
    if (offer.candidates)
      for (const c of offer.candidates){ await pc.addIceCandidate(c); }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

  } catch(err){
    showErr('monitorStatus','Error: '+ err.message);
  }
}

// Persistent ping loop from monitor to camera until we get "ready"
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

// Enable sound buttons (monitor UI)
function enableSoundButtons(){
  document.querySelectorAll('.sound-btn').forEach(b=> b.disabled = false);
  const hint = document.getElementById('soundHint');
  hint.textContent = '🎵 Sounds ready';
  hint.style.opacity = '1';
  stopPinging();
}

// Push-to-talk (monitor → camera)
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

// Monitor commands → Camera sound engine
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

// CAMERA: Web Audio helpers (exclusive playback + reliable stop)
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
  stopSoundOnCamera(); // guarantee exclusivity

  if (kind === 'whitenoise') return playWhiteNoise();
  if (kind === 'rain') return playRain();
  if (kind === 'lullaby1') return playMelody(
    [261.63,261.63,392.00,392.00,440.00,440.00,392.00,349.23,349.23,329.63,329.63,293.66,293.66,261.63],
    0.52, 620
  );
  if (kind === 'lullaby2') return playMelody(
    [329.63,293.66,293.66,329.63,293.66,261.63,293.66,329.63,329.63,293.66],
    0.52, 620
  );
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
