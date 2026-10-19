import { joinRoom, selfId, getRelaySockets } from 'trystero';
import { version as VERSION } from '../package.json'; // o esbuild põe só a versão no app.js

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
  '1080p30': { width: 1920, height: 1080, fps: 30, bitrate: 5_000_000 },
  '1080p60': { width: 1920, height: 1080, fps: 60, bitrate: 8_000_000 },
};
const AUDIO_BITRATE = 128_000;

// Codec da minha live, conforme o "Priorizar" escolhido:
// - Movimento (jogos): H.264, que o Chromium comprime na placa de vídeo (NVENC/AMF/QuickSync),
//   como o Discord; o processador fica livre pro jogo.
// - Nitidez (navegador): VP8, comprimido no processador, com o modo de tela que vai
//   refazendo as partes paradas até o texto ficar limpo.
// Se o PC não tiver o codec, os outros continuam na lista.
const CODEC = { motion: 'video/H264', detail: 'video/VP8' };

function preferCodec(pc) {
  const codecs = RTCRtpReceiver.getCapabilities?.('video')?.codecs;
  const mime = CODEC[state.priority];
  if (!codecs || !codecs.some((c) => c.mimeType === mime)) return;
  const order = [...codecs.filter((c) => c.mimeType === mime), ...codecs.filter((c) => c.mimeType !== mime)];
  for (const t of pc.getTransceivers()) {
    // Só as transceivers que enviam o meu vídeo; quem assiste aceita o codec de quem transmite.
    if (t.sender.track?.kind !== 'video' || t.stopped) continue;
    try { t.setCodecPreferences(order); } catch {}
  }
}

// O WebRTC começa toda conexão mandando ~300 kbps e sobe aos poucos enquanto mede a internet,
// por isso a live começava borrada. Estes valores (em kbps) vão na negociação de cada conexão
// e fazem o vídeo já sair em boa qualidade; se a internet não aguentar, ele ainda desce sozinho.
const START_KBPS = 3000;
const MIN_KBPS = 800;

function boostVideoSdp(sdp) {
  const lines = sdp.split(/\r?\n/);
  let video = false;
  const pts = new Set(); // codecs de vídeo desta parte do SDP
  const hasFmtp = new Set();
  for (const l of lines) {
    if (l.startsWith('m=')) video = l.startsWith('m=video');
    const rtp = video && l.match(/^a=rtpmap:(\d+) (VP8|VP9|H264|AV1)\//i);
    if (rtp) pts.add(rtp[1]);
    const fmtp = l.match(/^a=fmtp:(\d+) /);
    if (fmtp) hasFmtp.add(fmtp[1]);
  }
  const params = `x-google-start-bitrate=${START_KBPS};x-google-min-bitrate=${MIN_KBPS}`;
  return lines.flatMap((l) => {
    const fmtp = l.match(/^a=fmtp:(\d+) /);
    if (fmtp && pts.has(fmtp[1]) && !l.includes('x-google-start-bitrate')) return [`${l};${params}`];
    const rtp = l.match(/^a=rtpmap:(\d+) /);
    if (rtp && pts.has(rtp[1]) && !hasFmtp.has(rtp[1])) return [l, `a=fmtp:${rtp[1]} ${params}`];
    return [l];
  }).join('\r\n');
}

// O Trystero negocia com setLocalDescription() sem SDP; a ordem dos codecs vem das transceivers.
// Quem envia lê o bitrate inicial do SDP que recebe do outro lado; como todo mundo usa o Telinha,
// ajustar o que chega em cada conexão vale pros dois sentidos.
class TelinhaPeerConnection extends RTCPeerConnection {
  setLocalDescription(desc) {
    if (!desc || desc.type === 'offer' || desc.type === 'answer') preferCodec(this);
    return super.setLocalDescription(desc);
  }

  setRemoteDescription(desc) {
    if (desc?.sdp) desc = { type: desc.type, sdp: boostVideoSdp(desc.sdp) };
    return super.setRemoteDescription(desc);
  }
}

const state = {
  room: null,
  hello: null, // ação: { name, joinedAt, sharing }
  share: null, // ação: { sharing }
  watch: null, // ação: { watching } — pede (ou cancela) a transmissão de alguém
  watching: new Set(), // lives que eu escolhi assistir
  viewers: new Set(), // quem está assistindo a minha
  myName: '',
  discord: null, // perfil do Discord de quem logou: { id, username, globalName, avatar, banner, accentColor, decoration }
  joinedAt: 0,
  peers: new Map(), // peerId -> { name, joinedAt, sharing }
  localStream: null,
  quality: QUALITY['1080p30'],
  priority: 'detail', // "Priorizar" da minha live: 'motion' (H.264) ou 'detail' (VP8)
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

// Foto do Discord montada aqui a partir do id + hash (não aceita URL pronta vinda de quem está na sala).
function avatarUrl(d) {
  if (!d || !/^\d{5,20}$/.test(d.id)) return null;
  if (/^(a_)?[0-9a-f]{32}$/.test(d.avatar || '')) { // foto animada ("a_...") vai como GIF
    return `https://cdn.discordapp.com/avatars/${d.id}/${d.avatar}.${d.avatar.startsWith('a_') ? 'gif' : 'png'}?size=128`;
  }
  return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(d.id) >> 22n) % 6n)}.png`; // sem foto: avatar padrão
}

const DISCORD_HASH = /^(a_)?[0-9a-f]{32}$/;

// Mural do perfil (animado se for "a_...").
function bannerUrl(d) {
  if (!d || !/^\d{5,20}$/.test(d.id) || !DISCORD_HASH.test(d.banner || '')) return null;
  return `https://cdn.discordapp.com/banners/${d.id}/${d.banner}.${d.banner.startsWith('a_') ? 'gif' : 'png'}?size=600`;
}

// Enfeite em volta da foto (decoração de avatar).
function decorationUrl(d) {
  if (!DISCORD_HASH.test(d?.decoration || '')) return null;
  return `https://cdn.discordapp.com/avatar-decoration-presets/${d.decoration}.png?size=160&passthrough=true`;
}

// Placa de nome (ex.: "nameplates/nameplates/twilight/"). O endereço não está na documentação do
// Discord: é o mesmo que o app dele usa, então pode mudar um dia (aí a placa só some).
function nameplateUrl(d, file) {
  if (!/^[a-z0-9_]+(\/[a-z0-9_]+)*\/$/.test(d?.nameplate || '')) return null;
  return `https://cdn.discordapp.com/assets/collectibles/${d.nameplate}${file}`;
}

const accentOf = (d) => (Number.isInteger(d?.accentColor) && d.accentColor >= 0 && d.accentColor <= 0xffffff
  ? '#' + d.accentColor.toString(16).padStart(6, '0')
  : null);

// Cartão de perfil no estilo do Discord: mural, foto com enfeite, nome e @usuário.
function renderProfileCard(box, name, d) {
  box.innerHTML = `
    <div class="pc-banner"></div>
    <div class="pc-avatar-wrap"><span class="avatar pc-avatar"></span></div>
    <div class="pc-body"><b class="pc-name"></b><span class="pc-user"></span></div>`;
  const banner = box.querySelector('.pc-banner');
  const color = accentOf(d) || colorFor(name);
  box.style.setProperty('--pc', color);
  const img = bannerUrl(d);
  if (img) banner.style.backgroundImage = `url("${img}")`;
  setAvatar(box.querySelector('.pc-avatar'), name, d);
  box.querySelector('.pc-name').textContent = name;
  box.querySelector('.pc-user').textContent = d?.username ? '@' + d.username : 'Entrou com nick';
}

// Clicar na foto de alguém na sala abre o cartão de perfil ao lado da barra lateral.
function openProfile(anchor, name, d) {
  const pop = $('#profile-pop');
  renderProfileCard(pop, name, d);
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  pop.style.left = $('aside').getBoundingClientRect().right + 8 + 'px';
  pop.style.top = Math.max(8, Math.min(r.top - 20, innerHeight - pop.offsetHeight - 8)) + 'px';
}
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('#profile-pop, .avatar')) $('#profile-pop').hidden = true;
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#profile-pop').hidden = true; });

// Círculo do avatar: foto do Discord (com o enfeite animado por cima) se tiver, senão a inicial colorida.
function setAvatar(el, name, discord) {
  const url = avatarUrl(discord);
  el.textContent = url ? '' : (name[0]?.toUpperCase() || '?');
  el.style.background = url ? 'transparent' : colorFor(name);
  if (url) {
    const img = document.createElement('img');
    img.src = url;
    img.onerror = () => { img.remove(); el.textContent = name[0]?.toUpperCase() || '?'; el.style.background = colorFor(name); };
    el.append(img);
  }
  const deco = decorationUrl(discord);
  if (deco) {
    const img = document.createElement('img');
    img.className = 'deco';
    img.src = deco;
    img.onerror = () => img.remove();
    el.append(img);
  }
}

// ---------- Sons ----------
// No estilo dos avisos do Discord, mas gerados aqui (os do Discord têm direitos autorais).
// Cada som é uma sequência de [frequência em Hz, início em segundos].
const SOUNDS = {
  join: [[1046.5, 0], [1568, 0.09]],
  leave: [[1568, 0], [1046.5, 0.09]],
  liveStart: [[659.3, 0], [880, 0.08], [1318.5, 0.16]],
  liveStop: [[1318.5, 0], [880, 0.08], [659.3, 0.16]],
  viewer: [[1760, 0]],
};
let sfx = null;

function playSound(name) {
  const volume = Number(load('sfxVolume') || 100) / 100; // Configurações > Volume dos avisos
  if (!volume) return;
  try {
    sfx ??= new AudioContext();
    const t0 = sfx.currentTime + 0.01;
    for (const [freq, at] of SOUNDS[name]) {
      const osc = sfx.createOscillator();
      const gain = sfx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t0 + at);
      gain.gain.linearRampToValueAtTime(0.18 * volume, t0 + at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + at + 0.25);
      osc.connect(gain).connect(sfx.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + 0.3);
    }
  } catch (e) {
    console.warn('som:', e);
  }
}

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
  logout: svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>'),
  users: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>'),
  stats: svg('<path d="M3 3v18h18M8 16v-4M13 16V8M18 16v-7"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  eye: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: svg('<path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.7 3.6M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a10 10 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2M2 2l20 20"/>'),
  pip: svg('<rect x="2" y="4" width="20" height="16" rx="2"/><rect x="12" y="11" width="7" height="6" rx="1" fill="currentColor"/>'),
};
$('#my-version').textContent = 'v' + VERSION;

// ---------- Entrada ----------
$('#name').value = load('name');
$('#name').focus();
$('#name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#go').click(); });

$('#go').onclick = () => {
  const name = state.discord ? (state.discord.globalName || state.discord.username) : $('#name').value.trim();
  if (!name) { $('#lobby-error').textContent = 'Digite seu nick.'; return; }
  if (!state.discord) save('name', name);
  $('#lobby-error').textContent = '';
  enterRoom(name);
};

// ---------- Login com Discord ----------
try { state.discord = JSON.parse(load('discord') || 'null'); } catch {}

function renderLobbyProfile() {
  const d = state.discord;
  $('#discord-profile').hidden = !d;
  $('#nick-login').hidden = !!d;
  if (!d) return;
  renderProfileCard($('#dp-card'), d.globalName || d.username, d);
}
renderLobbyProfile();

$('#discord-login').onclick = async () => {
  const btn = $('#discord-login');
  btn.disabled = true;
  btn.textContent = 'Continue no navegador...';
  $('#lobby-error').textContent = '';
  const { ok, user, error } = await api.discordLogin();
  btn.disabled = false;
  btn.textContent = 'Entrar com Discord';
  if (!ok) { $('#lobby-error').textContent = error; return; }
  state.discord = user;
  save('discord', JSON.stringify(user));
  renderLobbyProfile();
  $('#go').click(); // logou: já entra na sala
};

function logoutDiscord() {
  state.discord = null;
  save('discord', '');
  renderLobbyProfile();
  $('#name').focus();
}
$('#discord-logout').onclick = logoutDiscord;

// Botão no meu painel da sala: sai da sala e volta pra tela de entrada (o login do Discord continua).
$('#me-logout').innerHTML = ICON.logout;
$('#me-logout').onclick = () => {
  leaveRoom();
  $('#lobby-error').textContent = '';
  $('#go').focus();
};

function enterRoom(name) {
  state.myName = name;
  state.joinedAt = Date.now();
  playSound('join');

  const config = { appId: APP_ID, password: PASSWORD, relayConfig: { redundancy: 8 }, rtcPolyfill: TelinhaPeerConnection };
  if (TURN_SERVERS.length) config.turnConfig = TURN_SERVERS;
  const room = joinRoom(config, ROOM_ID, {
    onJoinError: ({ error }) => console.warn('Erro ao conectar com alguém:', error),
  });
  state.room = room;
  state.statusTimer = setInterval(updateStatus, 1000);

  state.hello = room.makeAction('hello', {
    onMessage: (data, { peerId }) => {
      const isNew = !state.peers.get(peerId)?.name;
      state.peers.set(peerId, { ...state.peers.get(peerId), ...data, app: data.sharing ? cleanApp(data.app) : null });
      // Só toca pra quem entrou depois de mim (quem já estava na sala chega todo de uma vez).
      if (isNew && data.joinedAt > state.joinedAt) playSound('join');
      checkFull();
      updateTileName(peerId);
      if (state.viewers.has(peerId)) updateMyTileLabel(); // nome/foto de quem assiste chegou
      renderPeople();
    },
  });

  state.share = room.makeAction('share', {
    onMessage: ({ sharing, app }, { peerId }) => {
      const peer = state.peers.get(peerId);
      if (peer && peer.sharing !== sharing) playSound(sharing ? 'liveStart' : 'liveStop');
      if (peer) {
        peer.sharing = sharing;
        peer.app = sharing ? cleanApp(app) : null;
      }
      if (!sharing) {
        state.watching.delete(peerId); // a live acabou
        removeTile(peerId);
      }
      updateTileName(peerId);
      renderPeople();
    },
  });

  // Quem transmite só envia o vídeo pra quem pediu pra assistir.
  state.watch = room.makeAction('watch', {
    onMessage: ({ watching }, { peerId }) => {
      if (!state.localStream) return;
      if (watching && !state.viewers.has(peerId)) {
        state.viewers.add(peerId);
        playSound('viewer');
        room.addStream(state.localStream, { target: peerId });
      } else if (!watching && state.viewers.has(peerId)) {
        state.viewers.delete(peerId);
        room.removeStream(state.localStream, { target: peerId });
      }
      applyBitrate(); // divide o upload de novo entre quem está assistindo
      updateMyTileLabel();
    },
  });

  room.onPeerJoin = (peerId) => {
    if (!state.peers.has(peerId)) state.peers.set(peerId, { sharing: false });
    sendHello(peerId);
    renderPeople();
  };

  room.onPeerLeave = (peerId) => {
    if (state.peers.get(peerId)?.name) playSound('leave');
    state.peers.delete(peerId);
    state.watching.delete(peerId);
    state.viewers.delete(peerId);
    removeTile(peerId);
    updateMyTileLabel();
    renderPeople();
  };

  room.onPeerStream = (stream, peerId) => {
    if (!state.watching.has(peerId)) return; // não pedi essa live
    showTile(peerId, liveLabel(peerId), stream, false);
  };

  $('#lobby').hidden = true;
  $('#room').hidden = false;
  renderPeople();
  updateShareButton();
  updateEmpty();
}

function sendHello(target) {
  state.hello?.send(
    {
      name: state.myName,
      joinedAt: state.joinedAt,
      sharing: !!state.localStream,
      app: state.localStream ? state.shareApp : null,
      version: VERSION,
      discord: state.discord && {
        id: state.discord.id,
        username: state.discord.username,
        avatar: state.discord.avatar,
        banner: state.discord.banner,
        accentColor: state.discord.accentColor,
        decoration: state.discord.decoration,
        nameplate: state.discord.nameplate,
      },
    },
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
// Atalho global (padrão Ctrl+Shift+L, troca nas Configurações): para a live, ou começa de novo com a última tela/janela e opções.
// Se ela não existe mais (janela fechada), traz o Telinha pra frente com o seletor aberto.
let hotkeyBusy = false;
api.onToggleLive?.(async () => {
  if (!state.room || hotkeyBusy || $('#picker').open) return;
  if (state.localStream) return stopShare();
  hotkeyBusy = true;
  try {
    const last = load('source');
    const sources = await api.getSources();
    if (last && sources.some((s) => s.id === last)) {
      await startShare(last, load('quality') || '1080p30', load('audioMode') || 'no-discord', load('priority') || 'detail');
    } else {
      api.showWindow();
      openPicker();
    }
  } finally {
    hotkeyBusy = false;
  }
});

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
  $('#priority').value = load('priority') || 'detail';
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
  const priority = $('#priority').value;
  save('quality', quality);
  save('audioMode', audioMode);
  save('source', pickedId); // o atalho começa a próxima live com esta mesma tela/janela
  save('priority', priority);
  $('#picker').close();
  if (state.localStream) changeShare(pickedId, quality, audioMode, priority);
  else startShare(pickedId, quality, audioMode, priority);
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
async function captureSource(sourceId, qualityKey, audioMode, priority) {
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
  // "motion": quando a internet ou o PC apertam, baixa a resolução e mantém a fluidez (jogos).
  // "detail": mantém o texto nítido e deixa cair os quadros (código, documentos).
  video.contentHint = priority === 'detail' ? 'detail' : 'motion';
  video.onended = stopShare; // janela fechada, etc.
  for (const a of stream.getAudioTracks()) a.contentHint = 'music';
  return { stream, appAudio, quality: q };
}

async function startShare(sourceId, qualityKey, audioMode, priority) {
  const captured = await captureSource(sourceId, qualityKey, audioMode, priority);
  if (!captured) return;
  const { stream } = captured;
  state.quality = captured.quality;
  state.priority = priority;
  state.appAudio = captured.appAudio;
  state.localStream = stream;
  state.viewers.clear(); // o vídeo só vai pra quem clicar em "Assistir"
  state.share.send({ sharing: true });
  playSound('liveStart');
  state.bitrateTimer = setInterval(applyBitrate, 2000);
  watchShareApp(sourceId);
  showTile(selfId, `${state.myName} (você)`, stream, true);
  updateShareButton();
  renderPeople();
}

// Troca tela/janela, qualidade ou som no meio da live, sem derrubar quem está assistindo:
// as faixas novas entram no lugar das antigas no mesmo MediaStream.
async function changeShare(sourceId, qualityKey, audioMode, priority) {
  const captured = await captureSource(sourceId, qualityKey, audioMode, priority);
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
  // O codec só muda numa negociação nova: com troca de "Priorizar", a live é reenviada
  // pra quem assiste (pisca um instante) em vez de só trocar as faixas.
  const resend = viewers.length > 0 && priority !== state.priority;
  state.priority = priority;
  if (resend) room.removeStream(live, opts);

  for (const kind of ['video', 'audio']) {
    const oldTrack = live.getTracks().find((t) => t.kind === kind);
    const newTrack = captured.stream.getTracks().find((t) => t.kind === kind);
    if (oldTrack) live.removeTrack(oldTrack);
    if (newTrack) live.addTrack(newTrack);
    if (viewers.length && !resend) {
      if (oldTrack && newTrack) room.replaceTrack(oldTrack, newTrack, opts);
      else if (oldTrack) room.removeTrack(oldTrack, opts);
      else if (newTrack) room.addTrack(newTrack, live, opts);
    }
    if (oldTrack) {
      oldTrack.onended = null;
      oldTrack.stop();
    }
  }
  if (resend) room.addStream(live, opts);

  // Som separado por programa: se a captura nova também usa o auxiliar, ele já foi reiniciado pra ela.
  if (state.appAudio) {
    if (captured.appAudio) state.appAudio.close();
    else state.appAudio.stop();
  }
  state.appAudio = captured.appAudio;
  state.quality = captured.quality;
  watchShareApp(sourceId);

  const myVideo = document.querySelector(`#tile-${CSS.escape(selfId)} video`);
  if (myVideo) myVideo.srcObject = null;
  applyPreview(); // põe a live de novo na prévia (se ela não estiver escondida)
  applyBitrate();
}

// ---------- O que estou transmitindo ----------
// Nome do programa pros outros verem ("Fulano está compartilhando VALORANT"), como o "Jogando" do Discord.
// Vai só a descrição do .exe, nunca o título da janela (que pode ter assunto de e-mail, nome de arquivo...).
// Janela: o programa dela. Tela inteira: o programa que está na frente, conferido a cada 5 s.
const IGNORED_APPS = new Set(['telinha', 'electron', 'explorer', 'shellexperiencehost', 'searchhost', 'startmenuexperiencehost', 'lockapp']);

function cleanApp(app) {
  return typeof app === 'string' && app.trim() ? app.trim().slice(0, 60) : null;
}

async function updateShareApp() {
  const source = state.shareSource;
  if (!source || !state.localStream) return;
  const info = await api.appName?.(source.startsWith('window:') ? source.split(':')[1] : 'foreground');
  if (source !== state.shareSource || !state.localStream) return; // trocou ou parou enquanto perguntava
  if (!info || IGNORED_APPS.has(info.exe.toLowerCase())) return; // o Telinha ou a área de trabalho: mantém o último
  const app = cleanApp(info.description || info.exe.replace(/-Win64-Shipping$/i, ''));
  if (!app || app === state.shareApp) return;
  state.shareApp = app;
  state.share?.send({ sharing: true, app });
}

function watchShareApp(sourceId) {
  clearInterval(state.appTimer);
  state.shareSource = sourceId;
  state.shareApp = null;
  updateShareApp();
  if (sourceId.startsWith('screen:')) state.appTimer = setInterval(updateShareApp, 5000);
}

function stopShare() {
  if (!state.localStream) return;
  clearInterval(state.bitrateTimer);
  clearInterval(state.appTimer);
  state.shareSource = state.shareApp = null;
  if (state.viewers.size) state.room?.removeStream(state.localStream, { target: [...state.viewers] });
  state.viewers.clear();
  state.localStream.getTracks().forEach((t) => t.stop());
  state.localStream = null;
  state.appAudio?.stop();
  state.appAudio = null;
  state.share?.send({ sharing: false });
  if (state.room) playSound('liveStop');
  removeTile(selfId);
  updateShareButton();
  renderPeople();
}

// Cada pessoa assistindo é uma cópia a mais do vídeo no meu upload. O limite de upload
// (Configurações) é dividido entre elas: com 1–2 pessoas nada muda; com mais, cada cópia fica
// mais leve e o WebRTC baixa resolução ou fps sozinho, conforme o "Priorizar" da live.
const UPLOAD = { low: 6_000_000, normal: 12_000_000, high: 25_000_000, off: Infinity };

function videoBitrate() {
  const budget = UPLOAD[load('upload')] ?? UPLOAD.normal;
  const perViewer = Math.floor(budget / Math.max(1, state.viewers.size));
  return Math.min(state.quality.bitrate, Math.max(MIN_KBPS * 1000, perViewer));
}

// Ajusta a qualidade de envio em cada conexão (inclusive de quem entrou depois).
function applyBitrate() {
  if (!state.localStream || !state.room) return;
  const video = videoBitrate();
  const mine = new Set(state.localStream.getTracks());
  for (const pc of Object.values(state.room.getPeers())) {
    for (const sender of pc.getSenders()) {
      if (!mine.has(sender.track)) continue;
      const params = sender.getParameters();
      const enc = params.encodings?.[0];
      if (!enc) continue;
      const isVideo = sender.track.kind === 'video';
      const bitrate = isVideo ? video : AUDIO_BITRATE;
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
  showTile(id, liveLabel(id), null, false); // "Carregando..." até o vídeo chegar
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
      ${isLocal ? `<div class="preview-off-msg">${ICON.eyeOff}<span>Prévia escondida pra aliviar o PC.<br>Quem assiste continua vendo normal.</span></div>` : ''}
      <div class="tile-top"><span class="pill"><i class="dot"></i><span class="tile-name"></span></span>${isLocal ? '<span class="tile-viewers"></span>' : ''}<div class="tile-stats"></div></div>
      <div class="tile-bar">
        <span class="spacer"></span>
        ${isLocal ? '' : `<label class="vol-wrap" title="Volume">${ICON.volume}<input class="vol" type="range" min="0" max="1" step="0.01" value="1"></label>`}
        <button class="icon-btn stats-btn" title="Estatísticas da live">${ICON.stats}</button>
        ${isLocal ? `<button class="icon-btn preview-btn">${ICON.eyeOff}</button>` : ''}
        ${isLocal ? '' : `<button class="icon-btn pip" title="Janela flutuante (fica por cima de tudo)">${ICON.pip}</button>`}
        <button class="icon-btn fs" title="Tela cheia">${ICON.fullscreen}</button>
        ${isLocal ? '' : `<button class="icon-btn unwatch" title="Parar de assistir">${ICON.close}</button>`}
      </div>`;
    const video = tile.querySelector('video');
    const vol = tile.querySelector('.vol');
    if (vol) vol.oninput = () => { video.volume = Number(vol.value); };
    const toggleFs = () => (document.fullscreenElement ? document.exitFullscreen() : tile.requestFullscreen());
    tile.querySelector('.fs').onclick = toggleFs;
    tile.classList.toggle('show-stats', load('stats') === '1');
    tile.querySelector('.stats-btn').onclick = () => {
      const on = !tile.classList.contains('show-stats');
      save('stats', on ? '1' : '');
      document.querySelectorAll('.tile').forEach((t) => t.classList.toggle('show-stats', on));
      updateStats();
    };
    // Janela flutuante do próprio Chromium: fica por cima do jogo e dá pra mover e redimensionar.
    // O som continua saindo pelo Telinha (o volume da barra vale pra ela também).
    const pip = tile.querySelector('.pip');
    if (pip) {
      pip.onclick = () => {
        if (document.pictureInPictureElement === video) document.exitPictureInPicture().catch(() => {});
        else video.requestPictureInPicture().catch((e) => console.warn('Janela flutuante:', e));
      };
      video.addEventListener('enterpictureinpicture', () => tile.classList.add('in-pip'));
      video.addEventListener('leavepictureinpicture', () => tile.classList.remove('in-pip'));
    }
    const preview = tile.querySelector('.preview-btn');
    if (preview) {
      preview.onclick = () => {
        save('hidePreview', load('hidePreview') === '1' ? '' : '1');
        applyPreview();
      };
    }
    const stop = tile.querySelector('.unwatch');
    if (stop) stop.onclick = () => unwatch(id);
    video.ondblclick = toggleFs;
    video.onclick = () => toggleFocus(tile);
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
  if (isLocal) applyPreview();
  updateEmpty();
}

// Esconder a minha prévia: sem srcObject o vídeo não é desenhado na tela, o que alivia a placa
// de vídeo durante o jogo. A transmissão pra quem assiste não muda.
function applyPreview() {
  const tile = document.getElementById('tile-' + selfId);
  if (!tile) return;
  const hidden = load('hidePreview') === '1';
  const video = tile.querySelector('video');
  const want = hidden ? null : state.localStream;
  if (video.srcObject !== want) video.srcObject = want;
  tile.classList.toggle('preview-off', hidden);
  const btn = tile.querySelector('.preview-btn');
  btn.innerHTML = hidden ? ICON.eye : ICON.eyeOff;
  btn.title = hidden ? 'Mostrar minha prévia' : 'Esconder minha prévia (alivia o PC durante o jogo)';
}

// Modo foco (como no Discord): clicar numa live deixa ela grande e as outras pequenas embaixo.
// Clicar numa pequena troca o foco pra ela; clicar na grande volta pro normal.
function toggleFocus(tile) {
  const on = !tile.classList.contains('focused');
  document.querySelectorAll('#stage .tile.focused').forEach((t) => t.classList.remove('focused'));
  tile.classList.toggle('focused', on);
  updateFocus();
}

function updateFocus() {
  const stage = $('#stage');
  stage.classList.toggle('focus', !!stage.querySelector('.tile.focused') && stage.querySelectorAll('.tile').length > 1);
}

// "Fulano · VALORANT": nome de quem transmite + o programa que está na live.
function liveLabel(id) {
  const app = state.peers.get(id)?.app;
  return nameOf(id) + (app ? ` · ${app}` : '');
}

function updateTileName(id) {
  const el = document.querySelector(`#tile-${CSS.escape(id)} .tile-name`);
  if (el) el.textContent = liveLabel(id);
}

function updateMyTileLabel() {
  const tile = document.getElementById('tile-' + selfId);
  const n = state.viewers.size;
  if (tile) {
    const adjusted = state.localStream && videoBitrate() < state.quality.bitrate;
    tile.querySelector('.tile-name').textContent = `${state.myName} (você)` + (n ? ` · ${n} assistindo` : '')
      + (adjusted ? ' · qualidade ajustada' : '');
    tile.querySelector('.pill').title = adjusted
      ? `Com ${n} pessoas assistindo, cada uma recebe uma versão mais leve pra sua internet aguentar. Dá pra mudar em Configurações > Upload da internet.`
      : '';
    // Fotinhas de quem está assistindo, do lado do meu nome (como no Discord).
    const box = tile.querySelector('.tile-viewers');
    box.innerHTML = '';
    for (const id of state.viewers) {
      const a = document.createElement('span');
      a.className = 'avatar mini';
      setAvatar(a, nameOf(id), state.peers.get(id)?.discord);
      a.title = nameOf(id);
      box.append(a);
    }
  }
  renderPeople(); // atualiza "Ao vivo · N assistindo" no meu painel
}

function removeTile(id) {
  document.getElementById('tile-' + id)?.remove();
  updateEmpty();
}

// ---------- Estatísticas da live ----------
// Números por cima do vídeo (botão de gráfico na barra): mostram se a imagem ruim vem
// da internet (perda, pouco Mbps) ou do PC de quem transmite (limitado pelo processador).
const LIMIT = { bandwidth: 'internet', cpu: 'processador', other: 'outro motivo' };
const lastStats = new Map(); // "peerId:tipo" -> { bytes, lost, packets, t }
const mbps = (bps) => `${(bps / 1e6).toFixed(1).replace('.', ',')} Mbps`;

async function videoStats(peerId, pc, type) {
  const report = await pc.getStats();
  let rtp = null;
  let remote = null; // como quem assiste está recebendo (visto por quem transmite)
  let pair = null;
  report.forEach((s) => {
    if (s.kind === 'video' && s.type === type) rtp = s;
    if (s.kind === 'video' && s.type === 'remote-inbound-rtp') remote = s;
    if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s;
  });
  if (!rtp) return null;

  const key = `${peerId}:${type}`;
  const inbound = type === 'inbound-rtp';
  const now = { bytes: inbound ? rtp.bytesReceived : rtp.bytesSent, lost: rtp.packetsLost || 0, packets: rtp.packetsReceived || 0, t: rtp.timestamp };
  const prev = lastStats.get(key);
  lastStats.set(key, now);

  const parts = [];
  if (rtp.frameWidth) parts.push(`${rtp.frameWidth}×${rtp.frameHeight}`);
  parts.push(`${Math.round(rtp.framesPerSecond || 0)} fps`);
  if (prev && now.t > prev.t) parts.push(mbps(((now.bytes - prev.bytes) * 8 * 1000) / (now.t - prev.t)));
  const codec = report.get(rtp.codecId)?.mimeType?.split('/')[1];
  if (codec) parts.push(codec);
  if (inbound) {
    const got = prev ? now.packets - prev.packets : 0;
    const lost = prev ? now.lost - prev.lost : 0;
    if (got + lost > 0) parts.push(`perda ${((lost / (got + lost)) * 100).toFixed(1).replace('.', ',')}%`);
    if (rtp.freezeCount) parts.push(`${rtp.freezeCount} travada(s)`);
  } else {
    if (remote?.fractionLost != null) parts.push(`perda ${(remote.fractionLost * 100).toFixed(1).replace('.', ',')}%`);
    if (pair?.availableOutgoingBitrate) parts.push(`internet aguenta ~${mbps(pair.availableOutgoingBitrate)}`);
    if (rtp.qualityLimitationReason && rtp.qualityLimitationReason !== 'none') {
      parts.push(`limitado pelo ${LIMIT[rtp.qualityLimitationReason] || rtp.qualityLimitationReason}`);
    }
  }
  return parts.join(' · ');
}

async function updateStats() {
  if (!state.room) return;
  const peers = state.room.getPeers();
  for (const tile of document.querySelectorAll('.tile.show-stats')) {
    const id = tile.id.slice('tile-'.length);
    const lines = [];
    try {
      if (id === selfId) { // minha live: uma linha pra cada pessoa assistindo
        for (const viewer of state.viewers) {
          const text = peers[viewer] && await videoStats(viewer, peers[viewer], 'outbound-rtp');
          if (text) lines.push(`${nameOf(viewer)}: ${text}`);
        }
        if (!lines.length) lines.push('Ninguém assistindo ainda');
      } else {
        const text = peers[id] && await videoStats(id, peers[id], 'inbound-rtp');
        lines.push(text || 'Esperando o vídeo...');
      }
    } catch (e) {
      console.warn('Estatísticas:', e);
    }
    tile.querySelector('.tile-stats').textContent = lines.join('\n');
  }
}
setInterval(updateStats, 1000);

// Cartão "Fulano está ao vivo · Assistir" pra cada live que eu não estou assistindo.
function renderLiveCards() {
  for (const [id, peer] of state.peers) {
    const card = document.getElementById('card-' + id);
    const wanted = peer.sharing && !state.watching.has(id);
    if (!wanted) { card?.remove(); continue; }
    if (card) {
      card.querySelector('.pname').textContent = nameOf(id);
      card.querySelector('.hint').textContent = peer.app ? `está compartilhando ${peer.app}` : 'está compartilhando a tela';
      continue;
    }
    const el = document.createElement('div');
    el.className = 'tile live-card';
    el.id = 'card-' + id;
    el.innerHTML = `
      <div class="glow"></div>
      <span class="avatar big"></span>
      <div class="live-name"><b class="pname"></b><span class="live">AO VIVO</span></div>
      <p class="hint">está compartilhando a tela</p>
      <button class="primary">${ICON.play} Assistir</button>`;
    setAvatar(el.querySelector('.avatar'), nameOf(id), peer.discord);
    el.style.setProperty('--c', colorFor(nameOf(id)));
    el.querySelector('.pname').textContent = nameOf(id);
    if (peer.app) el.querySelector('.hint').textContent = `está compartilhando ${peer.app}`;
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
  updateFocus();
  empty.hidden = tiles > 0;
  empty.innerHTML = ICON.monitor + (state.peers.size
    ? '<p>Ninguém está ao vivo ainda.<br>Clique em <b>Compartilhar tela</b> pra começar.</p>'
    : '<p>Esperando seus amigos entrarem...<br>Você já pode compartilhar enquanto isso.</p>');
}

function olderThan(a, b) {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

function personRow(p) {
  const li = document.createElement('li');
  const isMe = p.id === selfId;
  const watching = state.watching.has(p.id);
  const badge = !p.sharing ? '' : watching
    ? '<span class="live watching">ASSISTINDO</span>'
    : '<span class="live">AO VIVO</span>';
  li.innerHTML = `<span class="avatar"></span><span class="pname"></span><span class="pver"></span>${badge}`;
  // Versão do Telinha de cada um: aparece passando o mouse no nome; quem está atrás da minha
  // ganha um pontinho amarelo. Até a 2.3.0 o app não mandava a versão.
  const known = /^\d+\.\d+\.\d+$/.test(p.version || '');
  const verText = known ? `Telinha v${p.version}` : 'Telinha antigo (2.3.0 ou anterior)';
  const ver = li.querySelector('.pver');
  ver.hidden = isMe || (known && !olderThan(p.version, VERSION));
  ver.title = `${verText} — mais antigo que o seu (v${VERSION}). Atualiza sozinho ao abrir o Telinha de novo.`;
  const avatar = li.querySelector('.avatar');
  setAvatar(avatar, p.name, p.discord);
  avatar.classList.toggle('ring', p.sharing);
  if (!isMe) { // o meu perfil não abre
    avatar.title = 'Ver perfil';
    avatar.classList.add('clickable');
    avatar.onclick = (e) => {
      e.stopPropagation(); // não liga/desliga o "assistir" da linha
      openProfile(avatar, p.name, p.discord);
    };
  }
  li.querySelector('.pname').textContent = p.name;
  li.querySelector('.pname').title = verText;
  if (p.discord?.username) li.title = '@' + p.discord.username;
  const plate = nameplateUrl(p.discord, 'asset.webm');
  if (plate) {
    const video = document.createElement('video');
    video.className = 'nameplate';
    Object.assign(video, { autoplay: true, loop: true, muted: true, playsInline: true });
    video.poster = nameplateUrl(p.discord, 'static.png');
    video.src = plate;
    video.onerror = () => video.remove();
    li.classList.add('has-plate');
    li.prepend(video);
  }
  li.classList.toggle('is-live', p.sharing);
  if (p.sharing && !isMe) {
    li.classList.add('clickable');
    li.title = watching ? 'Clique pra parar de assistir' : 'Clique pra assistir';
    li.onclick = () => (watching ? unwatch(p.id) : watch(p.id));
  } else if (!isMe) {
    li.classList.add('clickable'); // quem não está ao vivo: clicar no nome também abre o perfil
    li.onclick = () => openProfile(avatar, p.name, p.discord);
  }
  return li;
}

function renderPeople() {
  const box = $('#people');
  box.innerHTML = '';
  const everyone = [
    { id: selfId, name: `${state.myName} (você)`, sharing: !!state.localStream, discord: state.discord, version: VERSION },
    ...[...state.peers].map(([id, peer]) => ({ id, name: nameOf(id), sharing: peer.sharing, discord: peer.discord, version: peer.version })),
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
  setAvatar($('#me-avatar'), state.myName, state.discord);
  $('#me-name').textContent = state.myName;
  const meState = $('#me-state');
  meState.textContent = state.localStream ? `Ao vivo${state.viewers.size ? ` · ${state.viewers.size} assistindo` : ''}` : 'Na sala';
  meState.classList.toggle('on', !!state.localStream);
  meState.title = state.viewers.size ? 'Assistindo: ' + [...state.viewers].map(nameOf).join(', ') : '';

  $('#count').innerHTML = `${ICON.users} ${everyone.length}/${MAX_PEOPLE}`;
  renderLiveCards();
  updateEmpty();
}

// ---------- Configurações ----------
// Tudo vale na hora e fica salvo; as mesmas chaves que o seletor e os botões das lives usam.
const SHORTCUTS = {
  'CommandOrControl+Shift+L': 'Ctrl + Shift + L',
  'CommandOrControl+Shift+K': 'Ctrl + Shift + K',
  'CommandOrControl+Alt+L': 'Ctrl + Alt + L',
  'Alt+F9': 'Alt + F9',
  off: 'Desligado',
};
const DEFAULT_SHORTCUT = 'CommandOrControl+Shift+L';
const shortcutKey = () => (load('shortcut') in SHORTCUTS ? load('shortcut') : DEFAULT_SHORTCUT);

async function applyShortcut() {
  const key = shortcutKey();
  const ok = (await api.setShortcut?.(key === 'off' ? '' : key)) ?? true;
  $('#set-shortcut-note').textContent = ok ? '' : 'Outro programa já usa esse atalho. Escolha outro.';
  $('#share').title = key === 'off' ? '' : `Atalho: ${SHORTCUTS[key]} (funciona até dentro do jogo)`;
}
applyShortcut();

$('#set-quality').innerHTML = $('#quality').innerHTML;
$('#set-priority').innerHTML = $('#priority').innerHTML;
$('#set-shortcut').innerHTML = Object.entries(SHORTCUTS).map(([k, label]) => `<option value="${k}">${label}</option>`).join('');
$('#me-settings').innerHTML = ICON.settings;

$('#me-settings').onclick = () => {
  $('#set-quality').value = load('quality') || '1080p30';
  $('#set-priority').value = load('priority') || 'detail';
  $('#set-shortcut').value = shortcutKey();
  $('#set-sfx').value = load('sfxVolume') || 100;
  $('#set-upload').value = load('upload') in UPLOAD ? load('upload') : 'normal';
  $('#set-hide-preview').checked = load('hidePreview') === '1';
  $('#set-stats').checked = load('stats') === '1';
  $('#settings').showModal();
};
$('#settings-close').onclick = () => $('#settings').close();
$('#set-quality').onchange = (e) => save('quality', e.target.value);
$('#set-priority').onchange = (e) => save('priority', e.target.value);
$('#set-shortcut').onchange = (e) => { save('shortcut', e.target.value); applyShortcut(); };
$('#set-sfx').oninput = (e) => save('sfxVolume', e.target.value);
$('#set-sfx').onchange = () => playSound('join'); // amostra do volume escolhido
$('#set-upload').onchange = (e) => {
  save('upload', e.target.value);
  applyBitrate();
  updateMyTileLabel();
};
$('#set-hide-preview').onchange = (e) => { save('hidePreview', e.target.checked ? '1' : ''); applyPreview(); };
$('#set-stats').onchange = (e) => {
  save('stats', e.target.checked ? '1' : '');
  document.querySelectorAll('.tile').forEach((t) => t.classList.toggle('show-stats', e.target.checked));
  updateStats();
};
$('#set-news').onclick = () => { $('#settings').close(); showNews(); };

// ---------- Novidades ----------
// Aparece uma vez depois de atualizar (quem acabou de instalar não vê). Ao publicar uma versão,
// é só pôr as novidades dela aqui.
const CHANGELOG = {
  '2.4.0': [
    ['Janela flutuante', 'botão na barra da live pra assistir numa janelinha por cima do jogo.'],
    ['Modo foco', 'clique numa live pra ela ficar grande e as outras pequenas embaixo.'],
    ['Atalho Ctrl + Shift + L', 'começa ou para a sua live até de dentro do jogo (dá pra trocar nas Configurações).'],
    ['O que está passando', 'o cartão de ao vivo mostra o jogo ou programa que a pessoa está transmitindo.'],
    ['Quem está assistindo', 'as fotos de quem assiste aparecem do lado do seu nome na sua live.'],
    ['Priorizar Movimento ou Nitidez', 'jogos usam a placa de vídeo (H.264) e navegador fica com o texto mais nítido.'],
    ['Live mais bonita', 'já começa nítida e com mais qualidade.'],
    ['Menos travada com muita gente', 'com 3 ou mais pessoas assistindo, a live se ajusta sozinha pra sua internet aguentar.'],
    ['Esconder minha prévia', 'botão do olho na sua live, pra aliviar o PC durante o jogo.'],
    ['Estatísticas da live', 'botão de gráfico mostra resolução, fps, Mbps e perda.'],
    ['Versão de cada um', 'pontinho amarelo em quem está com o Telinha desatualizado.'],
    ['Configurações', 'engrenagem no seu painel, embaixo da lista de pessoas.'],
  ],
};

function showNews() {
  const items = CHANGELOG[VERSION] || [];
  $('#news-version').textContent = 'v' + VERSION;
  $('#news-list').innerHTML = '';
  for (const [title, text] of items) {
    const li = document.createElement('li');
    li.innerHTML = '<b></b> — <span></span>';
    li.querySelector('b').textContent = title;
    li.querySelector('span').textContent = text;
    $('#news-list').append(li);
  }
  if (!items.length) $('#news-list').innerHTML = '<li><span>Correções e melhorias.</span></li>';
  $('#news').showModal();
}
$('#news-close').onclick = () => $('#news').close();

(function maybeShowNews() {
  const seen = load('seenVersion');
  let usedBefore = !!seen;
  try { usedBefore ||= Object.keys(localStorage).some((k) => k.startsWith('telinha.')); } catch {}
  save('seenVersion', VERSION);
  if (seen !== VERSION && usedBefore && CHANGELOG[VERSION]) showNews();
})();

// Quem já está logado com o Discord entra direto na sala ao abrir o Telinha
// (fica aqui no fim pra tudo acima já estar pronto).
if (state.discord) $('#go').click();
