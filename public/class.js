(() => {
'use strict';
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const roomId = location.pathname.split('/').pop().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
const hostKey = params.get('host') || (() => { try { return localStorage.getItem('fr_host_' + roomId) || ''; } catch { return ''; } })();
const title = params.get('t') || 'Live class';

let ws = null, left = false, t0 = 0, timerH = null;
let ice = [{ urls: 'stun:stun.l.google.com:19302' }];
const me = { id: null, name: '', role: 'student' };
const peers = new Map(); // id -> {id,name,role,state,pc,streams:Map,senders:Map,audioEl,...}
let audioTrack = null, audioStream = null, camStream = null, screenStream = null;
const myState = { mic: false, cam: false, screen: false, hand: false, audioId: null, camId: null, screenId: null };
let opts = { cam: false, mic: false };

document.title = title + ' · Future Ready';
$('classTitle').textContent = title;
$('pjTitle').textContent = title;
if (hostKey) {
  $('pjRole').textContent = "You're the teacher of this class.";
  $('wantCam').checked = true; $('wantMic').checked = true;
  try { $('name').value = localStorage.getItem('fr_name') || ''; } catch {}
}
if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
  showPrejoinErr('Camera and mic need a secure page. Open this site over https (or localhost).');
}

/* ---------- helpers ---------- */
function toast(m) { const t = $('toast'); t.textContent = m; t.classList.remove('hide'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.add('hide'), 3500); }
function showPrejoinErr(m) { const e = $('pjErr'); e.textContent = m; e.classList.remove('hide'); $('pjBtn').disabled = false; }
function banner(m) { const b = $('banner'); b.textContent = m; b.classList.remove('hide'); }
function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function mediaErr(e) {
  const n = e && e.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') toast('Permission blocked. Allow camera, mic or screen access in your browser and try again.');
  else if (n === 'NotFoundError') toast('No camera or microphone found on this device.');
  else if (n === 'NotReadableError') toast('Camera or mic is in use by another app.');
  else toast('Could not start media: ' + (e && e.message || 'unknown error'));
}

/* ---------- join ---------- */
$('pjForm').onsubmit = async (e) => {
  e.preventDefault();
  me.name = $('name').value.trim();
  if (!me.name) return;
  try { if (hostKey) localStorage.setItem('fr_name', me.name); } catch {}
  opts = { cam: $('wantCam').checked, mic: $('wantMic').checked };
  $('pjBtn').disabled = true;
  try { const r = await fetch('/api/config'); ice = (await r.json()).iceServers || ice; } catch {}
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = () => send({ t: 'join', room: roomId, name: me.name, hostKey });
  ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } handle(m); };
  ws.onclose = () => { if (!left) { if (!me.id) showPrejoinErr('Could not connect to the class server.'); else banner('Disconnected from the class. Reload the page to rejoin.'); } };
};

function handle(m) {
  switch (m.t) {
    case 'welcome':
      me.id = m.id; me.role = m.role;
      m.peers.forEach(addPeer);
      enterRoom();
      break;
    case 'error': showPrejoinErr(m.message); try { ws.close(); } catch {} break;
    case 'peer-joined': addPeer(m.peer); sys(m.peer.name + ' joined'); render(); break;
    case 'peer-left': removePeer(m.id); render(); break;
    case 'signal': onSignal(m.from, m.data); break;
    case 'state': {
      const p = peers.get(m.from); if (!p) break;
      const wasHand = p.state.hand;
      p.state = m.state;
      if (m.state.hand && !wasHand) { toast(p.name + ' raised a hand ✋'); sys(p.name + ' raised a hand'); }
      render();
      break;
    }
    case 'chat': addMsg(m); break;
    case 'mute-all':
      if (audioTrack && audioTrack.enabled) { audioTrack.enabled = false; myState.mic = false; pushState(); toast('The teacher muted everyone'); }
      break;
    case 'end': toast('The teacher ended the class'); setTimeout(leave, 1800); break;
  }
}

function enterRoom() {
  $('prejoin').classList.add('hide'); $('room').classList.remove('hide');
  $('avLetter').textContent = me.name[0].toUpperCase();
  if (me.role === 'student') $('shareBtn').classList.add('hide');
  if (!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)) $('shareBtn').classList.add('hide');
  if (me.role === 'teacher') $('handBtn').classList.add('hide');
  t0 = Date.now();
  timerH = setInterval(() => { const s = Math.floor((Date.now() - t0) / 1000); $('timer').textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }, 1000);
  sys('You joined as ' + me.role);
  render();
  if (opts.cam) toggleCam();
  if (opts.mic) toggleMic();
}

/* ---------- WebRTC (perfect negotiation, mesh) ---------- */
function localStreams() { return [audioStream, camStream, screenStream].filter(Boolean); }

function addPeer(info) {
  if (peers.has(info.id)) return;
  const pc = new RTCPeerConnection({ iceServers: ice });
  const p = { ...info, state: info.state || {}, pc, streams: new Map(), senders: new Map(), makingOffer: false, ignoreOffer: false, polite: me.id > info.id, audioEl: null };
  peers.set(info.id, p);
  pc.onicecandidate = (e) => { if (e.candidate) send({ t: 'signal', to: info.id, data: { candidate: e.candidate } }); };
  pc.onnegotiationneeded = async () => {
    try { p.makingOffer = true; await pc.setLocalDescription(); send({ t: 'signal', to: info.id, data: { description: pc.localDescription } }); }
    catch (err) { console.error(err); } finally { p.makingOffer = false; }
  };
  pc.ontrack = (e) => { const s = e.streams[0]; if (s) { p.streams.set(s.id, s); render(); } };
  pc.oniceconnectionstatechange = () => { if (pc.iceConnectionState === 'failed') pc.restartIce(); };
  localStreams().forEach((s) => s.getTracks().forEach((t) => p.senders.set(t.id, pc.addTrack(t, s))));
}

function removePeer(id) {
  const p = peers.get(id); if (!p) return;
  sys(p.name + ' left');
  try { p.pc.close(); } catch {}
  if (p.audioEl) p.audioEl.remove();
  peers.delete(id);
}

async function onSignal(from, data) {
  const p = peers.get(from); if (!p) return;
  const pc = p.pc;
  try {
    if (data.description) {
      const collision = data.description.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
      p.ignoreOffer = !p.polite && collision;
      if (p.ignoreOffer) return;
      await pc.setRemoteDescription(data.description);
      if (data.description.type === 'offer') { await pc.setLocalDescription(); send({ t: 'signal', to: from, data: { description: pc.localDescription } }); }
    } else if (data.candidate) {
      try { await pc.addIceCandidate(data.candidate); } catch (err) { if (!p.ignoreOffer) console.warn(err); }
    }
  } catch (err) { console.error('signal error', err); }
}

function addToPeers(stream) { peers.forEach((p) => stream.getTracks().forEach((t) => p.senders.set(t.id, p.pc.addTrack(t, stream)))); }
function removeFromPeers(stream) {
  peers.forEach((p) => stream.getTracks().forEach((t) => {
    const s = p.senders.get(t.id);
    if (s) { try { p.pc.removeTrack(s); } catch {} p.senders.delete(t.id); }
  }));
}

/* ---------- my media controls ---------- */
function pushState() { send({ t: 'state', state: myState }); updateButtons(); render(); }
function updateButtons() {
  const set = (b, on, onT, offT, ic) => { b.className = 'cb ' + (on ? 'on' : 'off'); b.innerHTML = '<span>' + ic + '</span>' + (on ? onT : offT); };
  set($('micBtn'), myState.mic, 'Mic on', 'Mic off', myState.mic ? '🎤' : '🔇');
  set($('camBtn'), myState.cam, 'Camera on', 'Camera off', '📷');
  const keep = (b, cls) => { const h = b.classList.contains('hide'); b.className = 'cb' + cls + (h ? ' hide' : ''); };
  keep($('shareBtn'), myState.screen ? ' on' : '');
  $('shareBtn').innerHTML = '<span>🖥️</span>' + (myState.screen ? 'Stop sharing' : 'Share screen');
  keep($('handBtn'), myState.hand ? ' hand-on' : '');
  $('handBtn').innerHTML = '<span>✋</span>' + (myState.hand ? 'Lower hand' : 'Raise hand');
}

async function toggleMic() {
  try {
    if (!audioTrack) {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      audioTrack = s.getAudioTracks()[0];
      audioStream = new MediaStream([audioTrack]);
      addToPeers(audioStream);
      myState.audioId = audioStream.id;
      audioTrack.enabled = true;
    } else audioTrack.enabled = !audioTrack.enabled;
    myState.mic = audioTrack.enabled;
    pushState();
  } catch (e) { mediaErr(e); }
}

async function toggleCam() {
  try {
    if (!camStream) {
      const s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
      camStream = new MediaStream(s.getVideoTracks());
      addToPeers(camStream);
      myState.cam = true; myState.camId = camStream.id;
    } else {
      removeFromPeers(camStream);
      camStream.getTracks().forEach((t) => t.stop());
      camStream = null; myState.cam = false; myState.camId = null;
    }
    pushState();
  } catch (e) { mediaErr(e); }
}

async function toggleShare() {
  if (screenStream) return stopShare();
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 20 }, audio: true });
    screenStream = s;
    s.getVideoTracks()[0].addEventListener('ended', stopShare);
    addToPeers(s);
    myState.screen = true; myState.screenId = s.id;
    pushState();
    sys('You started sharing your screen');
  } catch (e) { if (e && e.name !== 'NotAllowedError') mediaErr(e); else toast('Screen sharing was cancelled or blocked.'); }
}
function stopShare() {
  if (!screenStream) return;
  removeFromPeers(screenStream);
  screenStream.getTracks().forEach((t) => t.stop());
  screenStream = null; myState.screen = false; myState.screenId = null;
  pushState();
}

$('micBtn').onclick = toggleMic;
$('camBtn').onclick = toggleCam;
$('shareBtn').onclick = toggleShare;
$('handBtn').onclick = () => { myState.hand = !myState.hand; pushState(); };
$('leaveBtn').onclick = () => { if (me.role === 'teacher' && peers.size && confirm('End the class for everyone?')) send({ t: 'end' }); leave(); };
$('copyBtn').onclick = () => {
  const url = location.origin + '/class/' + roomId + '?t=' + encodeURIComponent(title);
  (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(() => toast('Student link copied'), () => prompt('Copy this student link:', url));
};
function leave() {
  left = true;
  clearInterval(timerH);
  [audioStream, camStream, screenStream].forEach((s) => s && s.getTracks().forEach((t) => t.stop()));
  peers.forEach((p) => { try { p.pc.close(); } catch {} });
  try { ws.close(); } catch {}
  location.href = '/';
}
window.addEventListener('beforeunload', () => { try { ws && ws.close(); } catch {} });

/* ---------- chat + people ---------- */
function sys(t) { const d = document.createElement('div'); d.className = 'msg sys'; d.textContent = t; $('chat').appendChild(d); $('chat').scrollTop = 1e9; }
function addMsg(m) {
  const d = document.createElement('div'); d.className = 'msg' + (m.from === me.id ? ' me' : '');
  d.innerHTML = '<b>' + esc(m.from === me.id ? 'You' : m.name) + '</b>' + (m.role === 'teacher' ? '<span class="r">Teacher</span>' : '') + '<div>' + esc(m.text) + '</div>';
  $('chat').appendChild(d); $('chat').scrollTop = 1e9;
}
$('chatForm').onsubmit = (e) => { e.preventDefault(); const v = $('msg').value.trim(); if (!v) return; $('msg').value = ''; send({ t: 'chat', text: v }); };
$('tChat').onclick = () => { $('tChat').classList.add('on'); $('tPeople').classList.remove('on'); $('chat').classList.remove('hide'); $('people').classList.add('hide'); $('chatForm').classList.remove('hide'); };
$('tPeople').onclick = () => { $('tPeople').classList.add('on'); $('tChat').classList.remove('on'); $('people').classList.remove('hide'); $('chat').classList.add('hide'); $('chatForm').classList.add('hide'); };

function allPeople() {
  const list = [{ id: me.id, name: me.name + ' (You)', role: me.role, state: myState, isMe: true }];
  peers.forEach((p) => list.push({ id: p.id, name: p.name, role: p.role, state: p.state, isMe: false, p }));
  return list.sort((a, b) => (a.role === 'teacher' ? -1 : b.role === 'teacher' ? 1 : 0));
}

function renderPeople() {
  const all = allPeople();
  const hands = all.filter((x) => x.state.hand).length;
  $('count').textContent = all.length + ' in class';
  $('tPeople').textContent = 'People' + (hands ? ' ✋' + hands : '');
  let html = '';
  if (me.role === 'teacher') html += '<div class="toolrow"><button class="ghost" id="muteAll">Mute all students</button></div>';
  html += all.map((x) => '<div class="person"><i>' + esc(x.name[0].toUpperCase()) + '</i><span>' + esc(x.name) + (x.role === 'teacher' ? ' <span class="r" style="background:var(--brand);color:#fff;border-radius:6px;padding:1px 6px;font-size:10px">Teacher</span>' : '') + '</span><span class="ic">' + (x.state.hand ? '✋ ' : '') + (x.state.mic ? '🎤' : '🔇') + ' ' + (x.state.cam ? '📷' : '') + '</span></div>').join('');
  $('people').innerHTML = html;
  const mb = $('muteAll'); if (mb) mb.onclick = () => { send({ t: 'mute-all' }); toast('Asked all students to mute'); };
}

/* ---------- stage rendering ---------- */
function presenter() {
  if (me.role === 'teacher') return { name: me.name, state: myState, isMe: true };
  for (const p of peers.values()) if (p.role === 'teacher') return { name: p.name, state: p.state, isMe: false, p };
  return null;
}
function streamOf(pr, id) {
  if (!id) return null;
  if (pr.isMe) return camStream && camStream.id === id ? camStream : screenStream && screenStream.id === id ? screenStream : null;
  return pr.p.streams.get(id) || null;
}
function setVideo(el, stream, muted) {
  el.muted = muted;
  if ((el.srcObject || null) !== stream) el.srcObject = stream;
  if (stream) el.play().catch(() => {});
}
function renderStage() {
  const pr = presenter();
  let main = null, pip = null, muteMain = true, label = '', text = '';
  if (!pr) { label = 'Waiting for the teacher'; text = 'Waiting for the teacher to join…'; $('avLetter').textContent = '⏳'; }
  else {
    const st = pr.state, scr = st.screen ? streamOf(pr, st.screenId) : null, cam = st.cam ? streamOf(pr, st.camId) : null;
    $('avLetter').textContent = pr.name[0].toUpperCase();
    if (scr) { main = scr; muteMain = pr.isMe; pip = cam; label = pr.isMe ? 'You are presenting' : pr.name + ' is presenting'; }
    else if (cam) { main = cam; label = pr.name + (pr.isMe ? ' (You)' : ''); }
    else { label = pr.name + (pr.isMe ? ' (You)' : ''); text = pr.isMe ? 'Your camera is off' : pr.name + "'s camera is off"; }
  }
  setVideo($('mainVid'), main, muteMain);
  $('mainVid').classList.toggle('hide', !main);
  setVideo($('pipVid'), pip, true);
  $('pip').classList.toggle('hide', !pip);
  $('avatar').classList.toggle('hide', !!main);
  $('avText').textContent = text;
  $('badge').textContent = label;
}

const tiles = new Map();
function renderStrip() {
  const list = allPeople().filter((x) => x.role !== 'teacher');
  const ids = new Set(list.map((x) => x.id));
  tiles.forEach((t, id) => { if (!ids.has(id)) { t.el.remove(); tiles.delete(id); } });
  list.forEach((x) => {
    let t = tiles.get(x.id);
    if (!t) {
      const el = document.createElement('div'); el.className = 'tile';
      el.innerHTML = '<video autoplay playsinline muted></video><div class="ph"></div><div class="nm"></div>';
      $('strip').appendChild(el);
      t = { el, v: el.querySelector('video'), ph: el.querySelector('.ph'), nm: el.querySelector('.nm') };
      tiles.set(x.id, t);
    }
    const s = x.isMe ? camStream : x.state.cam ? x.p.streams.get(x.state.camId) : null;
    const show = !!(x.state.cam && s);
    setVideo(t.v, show ? s : null, true);
    t.v.classList.toggle('hide', !show);
    t.ph.textContent = x.name[0].toUpperCase(); t.ph.classList.toggle('hide', show);
    t.nm.textContent = (x.state.hand ? '✋ ' : '') + (x.state.mic ? '' : '🔇 ') + x.name;
  });
  $('strip').classList.toggle('hide', list.length === 0);
}

function renderAudio() {
  peers.forEach((p) => {
    const s = p.state.audioId && p.streams.get(p.state.audioId);
    if (!s) return;
    if (!p.audioEl) { p.audioEl = document.createElement('audio'); p.audioEl.autoplay = true; $('audios').appendChild(p.audioEl); }
    if (p.audioEl.srcObject !== s) { p.audioEl.srcObject = s; p.audioEl.play().catch(() => {}); }
  });
}

function render() { if (!me.id) return; renderStage(); renderStrip(); renderPeople(); renderAudio(); updateButtons(); }
})();
