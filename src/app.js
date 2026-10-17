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

const svg = (body) => `<svg class="ico" viewBox="0 0 24 24">${body}</svg>`;
const ICON = {
  monitor: svg('<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>'),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>'),
  swap: svg('<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>'),
  live: svg('<circle cx="12" cy="12" r="3" fill="currentColor"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19 5a10 10 0 0 1 0 14M5 19A10 10 0 0 1 5 5"/>'),
  volume: svg('<path d="M11 5 6 9H2v6h4l5 4z" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>'),
  fullscreen: svg('<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>'),
  close: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  play: svg('<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>'),
  users: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>'),
};

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
    onJoinError: ({ error }) => console.warn('Erro ao conectar com alguém:', error),
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

// Diagnóstico: só aparece se nenhum servidor de busca conectar (depois de 5 s, pra não piscar ao entrar).
function updateStatus() {
  const sockets = Object.values(getRelaySockets?.() || {});
  const online = sockets.some((s) => s?.readyState === WebSocket.OPEN);
  $('#status').hidden = online || Date.now() - state.joinedAt < 5000;
}

function leaveRoom() {
  stopShare();
  clearInterval(state.statusTimer);
  state.room?.leave();
  state.room = state.hello = state.share = state.watch = null;
  state.peers.clear();
  state.watching.clear();
  document.querySelectorAll('#stage .tile').forEach((t) => t.remove());
  $('#room').hidden = true;
  $('#lobby').hidden = false;
}

window.addEventListener('beforeunload', () => state.room?.leave());

// ---------- Compartilhar ----------
$('#share').onclick = () => (state.localStream ? stopShare() : openPicker());

function updateShareButton() {
  const btn = $('#share');
  btn.innerHTML = state.localStream ? `${ICON.stop} Parar` : `${ICON.monitor} Compartilhar tela`;
  btn.className = state.localStream ? 'danger' : 'primary';
  $('#change').hidden = !state.localStream;
}

$('#change').innerHTML = `${ICON.swap} Alterar`;
$('#change').onclick = openPicker;

let pickerKind = 'screen';
let pickerSources = [];
let pickedId = null;

async function openPicker() {
  pickedId = null;
  const changing = !!state.localStream; // já ao vivo: troca a transmissão sem parar
  $('#picker h3').textContent = changing ? 'Alterar transmissão' : 'Escolha o que compartilhar';
  $('#picker-go').innerHTML = changing ? `${ICON.swap} Aplicar` : `${ICON.live} Entrar ao vivo`;
  renderAudioModes();
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
  const last = load('audioMode'); // lembra o último som escolhido
  if (modes.includes(last) && !(pickerKind === 'window' && last === 'no-discord')) $('#audio-mode').value = last;
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
  const audioMode = $('#audio-mode').value;
  save('quality', quality);
  save('audioMode', audioMode);
  $('#picker').close();
  if (state.localStream) changeShare(pickedId, quality, audioMode);
  else startShare(pickedId, quality, audioMode);
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
      // close: só desliga este player (usado quando outra captura de som já assumiu o auxiliar)
      close: () => ctx.close(),
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

// Captura a tela/janela escolhida com o som pedido. Devolve { stream, appAudio, quality } ou null.
async function captureSource(sourceId, qualityKey, audioMode) {
  const q = QUALITY[qualityKey];

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
    return null;
  }
  if (appAudio) stream.addTrack(appAudio.track);

  const [video] = stream.getVideoTracks();
  video.contentHint = q.fps >= 60 ? 'motion' : 'detail';
  video.onended = stopShare; // janela fechada, etc.
  for (const a of stream.getAudioTracks()) a.contentHint = 'music';
  return { stream, appAudio, quality: q };
}

async function startShare(sourceId, qualityKey, audioMode) {
  const captured = await captureSource(sourceId, qualityKey, audioMode);
  if (!captured) return;
  const { stream } = captured;
  state.quality = captured.quality;
  state.appAudio = captured.appAudio;
  state.localStream = stream;
  state.viewers.clear(); // o vídeo só vai pra quem clicar em "Assistir"
  state.share.send({ sharing: true });
  state.bitrateTimer = setInterval(applyBitrate, 2000);
  showTile(selfId, `${state.myName} (você)`, stream, true);
  updateShareButton();
  renderPeople();
}

// Troca tela/janela, qualidade ou som no meio da live, sem derrubar quem está assistindo:
// as faixas novas entram no lugar das antigas no mesmo MediaStream.
async function changeShare(sourceId, qualityKey, audioMode) {
  const captured = await captureSource(sourceId, qualityKey, audioMode);
  if (!captured) return; // a live continua como estava
  const live = state.localStream;
  if (!live) { // a live acabou enquanto escolhia
    captured.stream.getTracks().forEach((t) => t.stop());
    captured.appAudio?.stop();
    return;
  }
  const room = state.room;
  const viewers = [...state.viewers];
  const opts = { target: viewers };

  for (const kind of ['video', 'audio']) {
    const oldTrack = live.getTracks().find((t) => t.kind === kind);
    const newTrack = captured.stream.getTracks().find((t) => t.kind === kind);
    if (oldTrack) live.removeTrack(oldTrack);
    if (newTrack) live.addTrack(newTrack);
    if (viewers.length) {
      if (oldTrack && newTrack) room.replaceTrack(oldTrack, newTrack, opts);
      else if (oldTrack) room.removeTrack(oldTrack, opts);
      else if (newTrack) room.addTrack(newTrack, live, opts);
    }
    if (oldTrack) {
      oldTrack.onended = null;
      oldTrack.stop();
    }
  }

  // Som separado por programa: se a captura nova também usa o auxiliar, ele já foi reiniciado pra ela.
  if (state.appAudio) {
    if (captured.appAudio) state.appAudio.close();
    else state.appAudio.stop();
  }
  state.appAudio = captured.appAudio;
  state.quality = captured.quality;

  const myVideo = document.querySelector(`#tile-${CSS.escape(selfId)} video`);
  if (myVideo) { myVideo.srcObject = null; myVideo.srcObject = live; }
  applyBitrate();
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
      <div class="tile-top"><span class="pill"><i class="dot"></i><span class="tile-name"></span></span></div>
      <div class="tile-bar">
        <span class="spacer"></span>
        ${isLocal ? '' : `<label class="vol-wrap" title="Volume">${ICON.volume}<input class="vol" type="range" min="0" max="1" step="0.01" value="1"></label>`}
        <button class="icon-btn fs" title="Tela cheia">${ICON.fullscreen}</button>
        ${isLocal ? '' : `<button class="icon-btn unwatch" title="Parar de assistir">${ICON.close}</button>`}
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
    // Tela cheia: mostra a barra ao mexer o mouse e esconde depois de 2,5 s parado.
    let hideTimer = null;
    tile.onmousemove = () => {
      tile.classList.add('show-bar');
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (!tile.querySelector('.tile-bar:hover')) tile.classList.remove('show-bar');
      }, 2500);
    };
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
  renderPeople(); // atualiza "Ao vivo · N assistindo" no meu painel
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
      <div class="glow"></div>
      <span class="avatar big"></span>
      <div class="live-name"><b class="pname"></b><span class="live">AO VIVO</span></div>
      <p class="hint">está compartilhando a tela</p>
      <button class="primary">${ICON.play} Assistir</button>`;
    const avatar = el.querySelector('.avatar');
    avatar.textContent = nameOf(id)[0].toUpperCase();
    avatar.style.background = colorFor(nameOf(id));
    el.style.setProperty('--c', colorFor(nameOf(id)));
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
  const tiles = document.querySelectorAll('#stage .tile').length;
  $('#stage').dataset.count = tiles;
  empty.hidden = tiles > 0;
  empty.innerHTML = ICON.monitor + (state.peers.size
    ? '<p>Ninguém está ao vivo ainda.<br>Clique em <b>Compartilhar tela</b> pra começar.</p>'
    : '<p>Esperando seus amigos entrarem...<br>Você já pode compartilhar enquanto isso.</p>');
}

function personRow(p) {
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
  avatar.classList.toggle('ring', p.sharing);
  li.querySelector('.pname').textContent = p.name;
  li.classList.toggle('is-live', p.sharing);
  if (p.sharing && !isMe) {
    li.classList.add('clickable');
    li.title = watching ? 'Clique pra parar de assistir' : 'Clique pra assistir';
    li.onclick = () => (watching ? unwatch(p.id) : watch(p.id));
  }
  return li;
}

function renderPeople() {
  const box = $('#people');
  box.innerHTML = '';
  const everyone = [
    { id: selfId, name: `${state.myName} (você)`, sharing: !!state.localStream },
    ...[...state.peers.keys()].map((id) => ({ id, name: nameOf(id), sharing: state.peers.get(id).sharing })),
  ];
  // Ao vivo primeiro, depois o resto da sala (como os canais de voz do Discord).
  for (const [title, group] of [['Ao vivo', everyone.filter((p) => p.sharing)], ['Na sala', everyone.filter((p) => !p.sharing)]]) {
    if (!group.length) continue;
    const header = document.createElement('p');
    header.className = 'section';
    header.textContent = `${title} — ${group.length}`;
    const ul = document.createElement('ul');
    group.forEach((p) => ul.append(personRow(p)));
    box.append(header, ul);
  }

  // Meu painel embaixo da barra lateral.
  const me = $('#me-avatar');
  me.textContent = state.myName[0]?.toUpperCase() || '?';
  me.style.background = colorFor(state.myName);
  $('#me-name').textContent = state.myName;
  const meState = $('#me-state');
  meState.textContent = state.localStream ? `Ao vivo${state.viewers.size ? ` · ${state.viewers.size} assistindo` : ''}` : 'Na sala';
  meState.classList.toggle('on', !!state.localStream);

  $('#count').innerHTML = `${ICON.users} ${everyone.length}/${MAX_PEOPLE}`;
  renderLiveCards();
  updateEmpty();
}
