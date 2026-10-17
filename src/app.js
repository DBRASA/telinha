import { joinRoom, selfId, getRelaySockets } from 'trystero';

// Sala fixa: todo mundo que tem este app cai na mesma sala.
// Trocar estes valores cria uma sala nova (e só quem tiver o .exe novo entra).
const APP_ID = 'telinha-64ab709c95af';
const ROOM_ID = 'sala-principal';
const PASSWORD = '-7LbRl1LR8jX4Zb6nmaJJANn';
const MAX_PEOPLE = 5;

// Servidor TURN: retransmite quando o roteador/operadora bloqueia a conexão direta (CGNAT, 4G...).
// Ex.: [{ urls: ['turn:servidor:3478', 'turns:servidor:5349'], username: 'usuario', credential: 'senha' }]
const TURN_SERVERS = [];

const api = window.telinha;
const $ = (s) => document.querySelector(s);

const QUALITY = {
  '720p30': { width: 1280, height: 720, fps: 30, bitrate: 2_500_000 },
  '1080p30': { width: 1920, height: 1080, fps: 30, bitrate: 4_000_000 },
  '1080p60': { width: 1920, height: 1080, fps: 60, bitrate: 6_000_000 },
};
const AUDIO_BITRATE = 128_000;

const state = {
  room: null,
  hello: null, // ação: { name, joinedAt, sharing }
  share: null, // ação: { sharing }
  watch: null, // ação: { watching } — pede (ou cancela) a transmissão de alguém
  watching: new Set(), // lives que eu escolhi assistir
  viewers: new Set(), // quem está assistindo a minha
  myName: '',
  joinedAt: 0,
  peers: new Map(), // peerId -> { name, joinedAt, sharing }
  localStream: null,
  quality: QUALITY['1080p30'],
  bitrateTimer: null,
  statusTimer: null,
  failed: new Set(), // pessoas encontradas, mas sem conexão
};

// ---------- Utilidades ----------
function load(key) { try { return localStorage.getItem('telinha.' + key) || ''; } catch { return ''; } }
function save(key, v) { try { localStorage.setItem('telinha.' + key, v); } catch {} }
function colorFor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 55% 45%)`;
}
const nameOf = (id) => state.peers.get(id)?.name || 'Conectando...';

// ---------- Entrada ----------
$('#name').value = load('name');
$('#name').focus();
$('#name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#go').click(); });

$('#go').onclick = () => {
  const name = $('#name').value.trim();
  if (!name) { $('#lobby-error').textContent = 'Digite seu nick.'; return; }
  save('name', name);
  $('#lobby-error').textContent = '';
  enterRoom(name);
};

function enterRoom(name) {
  state.myName = name;
  state.joinedAt = Date.now();

  const config = { appId: APP_ID, password: PASSWORD, relayConfig: { redundancy: 8 } };
  if (TURN_SERVERS.length) config.turnConfig = TURN_SERVERS;
  const room = joinRoom(config, ROOM_ID, {
    onJoinError: ({ error, peerId }) => {
      console.warn('Erro ao conectar com alguém:', error);
      state.failed.add(peerId);
      updateStatus();
    },
  });
  state.room = room;
  state.statusTimer = setInterval(updateStatus, 1000);

  state.hello = room.makeAction('hello', {
    onMessage: (data, { peerId }) => {
      state.peers.set(peerId, { ...state.peers.get(peerId), ...data });
      checkFull();
      updateTileName(peerId);
      renderPeople();
    },
  });

  state.share = room.makeAction('share', {
    onMessage: ({ sharing }, { peerId }) => {
      const peer = state.peers.get(peerId);
      if (peer) peer.sharing = sharing;
      if (!sharing) {
        state.watching.delete(peerId); // a live acabou
        removeTile(peerId);
      }
      renderPeople();
    },
  });

  // Quem transmite só envia o vídeo pra quem pediu pra assistir.
  state.watch = room.makeAction('watch', {
    onMessage: ({ watching }, { peerId }) => {
      if (!state.localStream) return;
      if (watching && !state.viewers.has(peerId)) {
        state.viewers.add(peerId);
        room.addStream(state.localStream, { target: peerId });
      } else if (!watching && state.viewers.has(peerId)) {
        state.viewers.delete(peerId);
        room.removeStream(state.localStream, { target: peerId });
      }
      updateMyTileLabel();
    },
  });

  room.onPeerJoin = (peerId) => {
    state.failed.delete(peerId);
    if (!state.peers.has(peerId)) state.peers.set(peerId, { sharing: false });
    sendHello(peerId);
    renderPeople();
  };

  room.onPeerLeave = (peerId) => {
    state.peers.delete(peerId);
    state.watching.delete(peerId);
    state.viewers.delete(peerId);
    removeTile(peerId);
    updateMyTileLabel();
    renderPeople();
  };

  room.onPeerStream = (stream, peerId) => {
    if (!state.watching.has(peerId)) return; // não pedi essa live
    showTile(peerId, nameOf(peerId), stream, false);
  };

  $('#lobby').hidden = true;
  $('#room').hidden = false;
  renderPeople();
  updateShareButton();
  updateEmpty();
}

function sendHello(target) {
  state.hello?.send(
    { name: state.myName, joinedAt: state.joinedAt, sharing: !!state.localStream },
    target ? { target } : undefined,
  );
}

// Se já tem 5 pessoas que entraram antes de mim, eu saio.
function checkFull() {
  const earlier = [...state.peers.values()].filter((p) => p.joinedAt && p.joinedAt < state.joinedAt);
  if (earlier.length >= MAX_PEOPLE) {
    leaveRoom();
    $('#lobby-error').textContent = `A sala está cheia (máximo ${MAX_PEOPLE} pessoas).`;
  }
}

// Diagnóstico: servidores de busca conectados e pessoas que não conseguimos alcançar.
function updateStatus() {
  const el = $('#status');
  const sockets = Object.values(getRelaySockets?.() || {});
  const online = sockets.filter((s) => s?.readyState === WebSocket.OPEN).length;
  const failed = state.failed.size;
  if (!online) {
    el.className = 'status bad';
    el.textContent = 'Sem conexão com os servidores de busca. Confira a internet, o firewall ou o antivírus.';
  } else if (failed) {
    el.className = 'status bad';
    el.textContent = `Achei ${failed} pessoa(s), mas a rede bloqueou a conexão. É preciso configurar um servidor TURN.`;
  } else {
    el.className = 'status ok';
    el.textContent = `Online · ${online}/${sockets.length} servidores de busca`;
  }
}

function leaveRoom() {
  stopShare();
  clearInterval(state.statusTimer);
  state.room?.leave();
  state.room = state.hello = state.share = state.watch = null;
  state.peers.clear();
  state.failed.clear();
  state.watching.clear();
  document.querySelectorAll('#stage .tile').forEach((t) => t.remove());
  $('#room').hidden = true;
  $('#lobby').hidden = false;
}

$('#leave').onclick = leaveRoom;
window.addEventListener('beforeunload', () => state.room?.leave());

// ---------- Compartilhar ----------
$('#share').onclick = () => (state.localStream ? stopShare() : openPicker());

function updateShareButton() {
  const btn = $('#share');
  btn.textContent = state.localStream ? 'Parar de compartilhar' : 'Compartilhar tela';
  btn.className = state.localStream ? 'danger' : 'primary';
}

let pickerKind = 'screen';
let pickerSources = [];
let pickedId = null;

async function openPicker() {
  pickedId = null;
  $('#picker-go').disabled = true;
  $('#quality').value = load('quality') || '1080p30';
  $('#sources').innerHTML = '<p class="hint">Carregando...</p>';
  $('#picker').showModal();
  pickerSources = await api.getSources();
  renderSources();
}

document.querySelectorAll('#kind-tabs .tab').forEach((tab) => {
  tab.onclick = () => {
    pickerKind = tab.dataset.kind;
    document.querySelectorAll('#kind-tabs .tab').forEach((t) => t.classList.toggle('active', t === tab));
    renderSources();
    renderAudioModes();
  };
});

const AUDIO_MODES = {
  window: 'Só o som desta janela',
  'no-discord': 'Som do PC, sem o Discord',
  all: 'Todo o som do PC',
  none: 'Sem som',
};

function renderAudioModes() {
  const modes = pickerKind === 'window' ? ['window', 'no-discord', 'all', 'none'] : ['no-discord', 'all', 'none'];
  $('#audio-mode').innerHTML = modes.map((m) => `<option value="${m}">${AUDIO_MODES[m]}</option>`).join('');
}
renderAudioModes();

function renderSources() {
  const box = $('#sources');
  box.innerHTML = '';
  const list = pickerSources.filter((s) => s.id.startsWith(pickerKind));
  if (!list.length) box.innerHTML = '<p class="hint">Nada encontrado.</p>';
  list.forEach((s, i) => {
    const el = document.createElement('div');
    el.className = 'source' + (s.id === pickedId ? ' selected' : '');
    el.innerHTML = '<img class="thumb"><div class="sname"><span></span></div>';
    el.querySelector('.thumb').src = s.thumbnail;
    el.querySelector('.sname span').textContent = pickerKind === 'screen' ? `Tela ${i + 1}` : s.name;
    if (s.icon) {
      const icon = document.createElement('img');
      icon.src = s.icon;
      el.querySelector('.sname').prepend(icon);
    }
    el.onclick = () => {
      pickedId = s.id;
      $('#picker-go').disabled = false;
      box.querySelectorAll('.source').forEach((x) => x.classList.toggle('selected', x === el));
    };
    el.ondblclick = () => $('#picker-go').click();
    box.append(el);
  });
}

$('#picker-cancel').onclick = () => $('#picker').close();
$('#picker-go').onclick = () => {
  const quality = $('#quality').value;
  save('quality', quality);
  $('#picker').close();
  startShare(pickedId, quality, $('#audio-mode').value);
};

// Som separado por programa (via TelinhaAudio.exe), transformado numa faixa de áudio.
async function startAppAudio(args) {
  const { ok } = await api.audioStart(args);
  if (!ok) return null;
  try {
    const ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.audioWorklet.addModule('pcm-worklet.js');
    const node = new AudioWorkletNode(ctx, 'pcm-player', { numberOfInputs: 0, outputChannelCount: [2] });
    const dest = ctx.createMediaStreamDestination();
    node.connect(dest);
    api.onAudioData((chunk) => node.port.postMessage(chunk));
    const [track] = dest.stream.getAudioTracks();
    return {
      track,
      stop: () => {
        api.onAudioData(null);
        api.audioStop();
        ctx.close();
      },
    };
  } catch (e) {
    console.error(e);
    api.audioStop();
    return null;
  }
}

async function startShare(sourceId, qualityKey, audioMode) {
  const q = (state.quality = QUALITY[qualityKey]);

  let appAudio = null;
  if (audioMode === 'no-discord' || audioMode === 'window') {
    const hwnd = sourceId.split(':')[1]; // "window:<hwnd>:0"
    appAudio = await startAppAudio(audioMode === 'window' ? ['window', hwnd] : ['exclude-discord']);
    if (!appAudio) alert('Não deu pra separar o som por programa neste PC. Vou compartilhar todo o som do PC.');
  }
  const loopback = audioMode !== 'none' && !appAudio; // todo o som do PC

  await api.selectSource(sourceId, loopback);
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { max: q.width }, height: { max: q.height }, frameRate: { ideal: q.fps, max: q.fps } },
      audio: loopback,
    });
  } catch (e) {
    appAudio?.stop();
    alert('Não foi possível capturar a tela: ' + e.message);
    return;
  }
  if (appAudio) stream.addTrack(appAudio.track);
  state.appAudio = appAudio;

  const [video] = stream.getVideoTracks();
  video.contentHint = q.fps >= 60 ? 'motion' : 'detail';
  video.onended = stopShare; // janela fechada, etc.
  for (const a of stream.getAudioTracks()) a.contentHint = 'music';

  state.localStream = stream;
  state.viewers.clear(); // o vídeo só vai pra quem clicar em "Assistir"
  state.share.send({ sharing: true });
  state.bitrateTimer = setInterval(applyBitrate, 2000);
  showTile(selfId, `${state.myName} (você)`, stream, true);
  updateShareButton();
  renderPeople();
}

function stopShare() {
  if (!state.localStream) return;
  clearInterval(state.bitrateTimer);
  if (state.viewers.size) state.room?.removeStream(state.localStream, { target: [...state.viewers] });
  state.viewers.clear();
  state.localStream.getTracks().forEach((t) => t.stop());
  state.localStream = null;
  state.appAudio?.stop();
  state.appAudio = null;
  state.share?.send({ sharing: false });
  removeTile(selfId);
  updateShareButton();
  renderPeople();
}

// Ajusta a qualidade de envio em cada conexão (inclusive de quem entrou depois).
function applyBitrate() {
  if (!state.localStream || !state.room) return;
  const mine = new Set(state.localStream.getTracks());
  for (const pc of Object.values(state.room.getPeers())) {
    for (const sender of pc.getSenders()) {
      if (!mine.has(sender.track)) continue;
      const params = sender.getParameters();
      const enc = params.encodings?.[0];
      if (!enc) continue;
      const isVideo = sender.track.kind === 'video';
      const bitrate = isVideo ? state.quality.bitrate : AUDIO_BITRATE;
      if (enc.maxBitrate === bitrate) continue;
      enc.maxBitrate = bitrate;
      if (isVideo) enc.maxFramerate = state.quality.fps;
      sender.setParameters(params).catch(() => {});
    }
  }
}

// ---------- Assistir ----------
function watch(id) {
  if (state.watching.has(id) || !state.peers.get(id)?.sharing) return;
  state.watching.add(id);
  state.watch.send({ watching: true }, { target: id });
  showTile(id, nameOf(id), null, false); // "Carregando..." até o vídeo chegar
  renderPeople();
}

function unwatch(id) {
  if (!state.watching.delete(id)) return;
  state.watch?.send({ watching: false }, { target: id });
  removeTile(id);
  renderPeople();
}

// ---------- Interface ----------
function showTile(id, label, stream, isLocal) {
  let tile = document.getElementById('tile-' + id);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'tile';
    tile.id = 'tile-' + id;
    tile.innerHTML = `
      <video autoplay playsinline></video>
      <div class="tile-bar">
        <span class="tile-name"></span><span class="live">AO VIVO</span>
        <span class="spacer"></span>
        ${isLocal ? '' : '<input class="vol" type="range" min="0" max="1" step="0.01" value="1" title="Volume">'}
        <button class="fs" title="Tela cheia">⛶</button>
        ${isLocal ? '' : '<button class="unwatch" title="Parar de assistir">✕</button>'}
      </div>`;
    const video = tile.querySelector('video');
    const vol = tile.querySelector('.vol');
    if (vol) vol.oninput = () => { video.volume = Number(vol.value); };
    const toggleFs = () => (document.fullscreenElement ? document.exitFullscreen() : tile.requestFullscreen());
    tile.querySelector('.fs').onclick = toggleFs;
    const stop = tile.querySelector('.unwatch');
    if (stop) stop.onclick = () => unwatch(id);
    video.ondblclick = toggleFs;
    video.onclick = () => tile.classList.toggle('focused');
    const card = document.getElementById('card-' + id);
    if (card) card.replaceWith(tile); // o vídeo entra no lugar do cartão
    else $('#stage').append(tile);
  }
  tile.querySelector('.tile-name').textContent = label;
  const video = tile.querySelector('video');
  video.muted = isLocal; // não tocar o próprio som de volta
  tile.classList.toggle('loading', !stream);
  if (stream && video.srcObject !== stream) video.srcObject = stream;
  updateEmpty();
}

function updateTileName(id) {
  const el = document.querySelector(`#tile-${CSS.escape(id)} .tile-name`);
  if (el) el.textContent = nameOf(id);
}

function updateMyTileLabel() {
  const el = document.querySelector(`#tile-${CSS.escape(selfId)} .tile-name`);
  const n = state.viewers.size;
  if (el) el.textContent = `${state.myName} (você)` + (n ? ` · ${n} assistindo` : '');
}

function removeTile(id) {
  document.getElementById('tile-' + id)?.remove();
  updateEmpty();
}

// Cartão "Fulano está ao vivo · Assistir" pra cada live que eu não estou assistindo.
function renderLiveCards() {
  for (const [id, peer] of state.peers) {
    const card = document.getElementById('card-' + id);
    const wanted = peer.sharing && !state.watching.has(id);
    if (!wanted) { card?.remove(); continue; }
    if (card) { card.querySelector('.pname').textContent = nameOf(id); continue; }
    const el = document.createElement('div');
    el.className = 'tile live-card';
    el.id = 'card-' + id;
    el.innerHTML = `
      <span class="avatar big"></span>
      <p><b class="pname"></b> está <span class="live">AO VIVO</span></p>
      <button class="primary">Assistir</button>`;
    const avatar = el.querySelector('.avatar');
    avatar.textContent = nameOf(id)[0].toUpperCase();
    avatar.style.background = colorFor(nameOf(id));
    el.querySelector('.pname').textContent = nameOf(id);
    el.querySelector('button').onclick = () => watch(id);
    $('#stage').append(el);
  }
  document.querySelectorAll('#stage .live-card').forEach((c) => {
    if (!state.peers.has(c.id.slice(5))) c.remove();
  });
}

function updateEmpty() {
  const empty = $('#empty');
  empty.hidden = !!document.querySelector('#stage .tile');
  empty.innerHTML = state.peers.size
    ? 'Ninguém está compartilhando ainda.<br>Clique em <b>Compartilhar tela</b> pra começar.'
    : 'Esperando seus amigos entrarem...<br>Você já pode compartilhar enquanto isso.';
}

function renderPeople() {
  const list = $('#people');
  list.innerHTML = '';
  const everyone = [
    { id: selfId, name: `${state.myName} (você)`, sharing: !!state.localStream },
    ...[...state.peers.keys()].map((id) => ({ id, name: nameOf(id), sharing: state.peers.get(id).sharing })),
  ];
  for (const p of everyone) {
    const li = document.createElement('li');
    const isMe = p.id === selfId;
    const watching = state.watching.has(p.id);
    const badge = !p.sharing ? '' : watching
      ? '<span class="live watching">ASSISTINDO</span>'
      : '<span class="live">AO VIVO</span>';
    li.innerHTML = `<span class="avatar"></span><span class="pname"></span>${badge}`;
    const avatar = li.querySelector('.avatar');
    avatar.textContent = p.name[0].toUpperCase();
    avatar.style.background = colorFor(p.name);
    li.querySelector('.pname').textContent = p.name;
    if (p.sharing && !isMe) {
      li.classList.add('clickable');
      li.title = watching ? 'Clique pra parar de assistir' : 'Clique pra assistir';
      li.onclick = () => (watching ? unwatch(p.id) : watch(p.id));
    }
    list.append(li);
  }
  $('#count').textContent = `${everyone.length}/${MAX_PEOPLE}`;
  renderLiveCards();
  updateEmpty();
}
