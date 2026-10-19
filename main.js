const { app, BrowserWindow, ipcMain, desktopCapturer, session, dialog, shell, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { execFile, execFileSync, spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');

// A captura de janela pelo Windows Graphics Capture falha ("Could not start video source");
// desligando só ela, o Chromium usa o capturador clássico de janelas, que funciona.
// A captura da tela inteira continua igual.
app.commandLine.appendSwitch('disable-features', 'AllowWgcWindowCapturer');

let win = null;

// Um Telinha só: abrir de novo traz pra frente a janela que já está aberta.
// No npm start não trava, pra dar pra testar junto com o Telinha instalado.
// A segunda cópia sai com app.exit (não roda o will-quit, que desligaria o Radmin da primeira).
const primary = !app.isPackaged || app.requestSingleInstanceLock();
if (!primary) app.exit(0);
app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

// Atalho global da live: funciona mesmo com o jogo em tela cheia na frente.
// Quem escolhe é o renderer (Configurações); só aceita as combinações desta lista.
const SHORTCUTS = ['CommandOrControl+Shift+L', 'CommandOrControl+Shift+K', 'CommandOrControl+Alt+L', 'Alt+F9'];
let liveShortcut = null;

function setLiveShortcut(accel) {
  if (liveShortcut) globalShortcut.unregister(liveShortcut);
  liveShortcut = null;
  if (!accel) return true; // desligado
  // Se outro programa já usa a mesma combinação, o atalho só não funciona.
  if (!globalShortcut.register(accel, () => win?.webContents.send('toggle-live'))) {
    console.warn(`Atalho ${accel} já está em uso por outro programa.`);
    return false;
  }
  liveShortcut = accel;
  return true;
}
let pending = { id: null, audio: true }; // fonte escolhida no seletor

// Serviço do Radmin que mantém a VPN ligada. O Telinha liga ao abrir e desliga ao fechar
// (por isso o app roda como administrador: requestedExecutionLevel no package.json).
const RADMIN_SERVICE = 'RvControlSvc';

// Auxiliar nativo (native/TelinhaAudio.cs): som por programa e esconder a janela do Radmin.
const helperExe = () => (app.isPackaged
  ? path.join(process.resourcesPath, 'TelinhaAudio.exe')
  : path.join(__dirname, 'native', 'TelinhaAudio.exe'));

// Liga a VPN e abre o Radmin VPN junto com o Telinha (se já não estiver aberto), só no ícone do relógio.
function openRadmin(win) {
  const exe = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]
    .filter(Boolean)
    .map((dir) => path.join(dir, 'Radmin VPN', 'RvRvpnGui.exe'))
    .find((p) => fs.existsSync(p));

  if (!exe) {
    dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Radmin VPN não encontrado',
      message: 'O Radmin VPN não está instalado.',
      detail: 'Ele é necessário pra conectar com seus amigos. Instale, entre na rede do grupo e abra o Telinha de novo.',
      buttons: ['Baixar Radmin VPN', 'Agora não'],
    }).then(({ response }) => {
      if (response === 0) shell.openExternal('https://www.radmin-vpn.com/br/');
    });
    return;
  }

  // "sc start" falha sem problema se o serviço já estiver rodando.
  execFile('sc', ['start', RADMIN_SERVICE], { windowsHide: true }, () => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq RvRvpnGui.exe', '/NH'], (err, out) => {
      if (!err && out.includes('RvRvpnGui.exe')) return; // já está aberto
      spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
      // O Radmin sempre abre a janela na frente; o auxiliar esconde ela (fica o ícone perto do relógio).
      if (fs.existsSync(helperExe())) {
        spawn(helperExe(), ['hide', 'RvRvpnGui'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      }
    });
  });
}

// Procura versão nova no GitHub, baixa em segundo plano e pergunta se quer reiniciar.
// Se a pessoa escolher "Depois", instala sozinho quando o app for fechado.
function checkUpdates(win) {
  if (!app.isPackaged) return;
  autoUpdater.on('update-downloaded', ({ version }) => {
    dialog.showMessageBox(win, {
      type: 'info',
      title: 'Atualização pronta',
      message: `A versão ${version} do Telinha foi baixada.`,
      detail: 'Reinicie pra usar a versão nova.',
      buttons: ['Reiniciar agora', 'Depois'],
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    });
  });
  autoUpdater.on('error', (e) => console.error('Erro na atualização:', e));
  autoUpdater.checkForUpdates().catch(() => {});
}

// Captura de som por programa (sem o Discord / só a janela) via TelinhaAudio.exe.
// O PCM sai no stdout do auxiliar e vai pro renderer por IPC.
let audioProc = null;

function stopAppAudio() {
  audioProc?.kill();
  audioProc = null;
}

function startAppAudio(args) {
  stopAppAudio();
  const exe = helperExe();
  if (!fs.existsSync(exe)) return Promise.resolve({ ok: false });

  return new Promise((resolve) => {
    const proc = spawn(exe, args, { windowsHide: true });
    audioProc = proc;
    let settled = false;
    const done = (ok) => {
      if (!settled) { settled = true; resolve({ ok }); }
    };
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (text) => {
      if (text.includes('READY')) done(true);
      else console.error('[TelinhaAudio]', text.trim());
    });
    proc.stdout.on('data', (chunk) => win?.webContents.send('audio-data', chunk));
    proc.on('error', () => done(false));
    proc.on('exit', () => {
      if (audioProc === proc) audioProc = null;
      done(false);
    });
    setTimeout(() => {
      if (!settled) { proc.kill(); done(false); }
    }, 4000);
  });
}

// Login com Discord (OAuth2 "implicit grant": só precisa do Client ID, nenhum segredo vai no app).
// Crie o aplicativo em https://discord.com/developers/applications e, em OAuth2 > Redirects,
// adicione exatamente o DISCORD_REDIRECT abaixo.
const DISCORD_CLIENT_ID = '1561147847427104799';
const DISCORD_PORT = 53134;
const DISCORD_REDIRECT = `http://127.0.0.1:${DISCORD_PORT}/callback`;

// O Discord devolve o token depois do "#" da URL, que não chega no servidor;
// esta página lê ele no navegador e repassa pro Telinha.
const CALLBACK_PAGE = `<!doctype html><meta charset="utf-8"><title>Telinha</title>
<body style="background:#313338;color:#dbdee1;font:16px 'Segoe UI',sans-serif;display:grid;place-items:center;height:90vh">
<p id="m">Conectando...</p>
<script>
  const p = new URLSearchParams(location.hash.slice(1) || location.search.slice(1));
  fetch('/token?' + p).then((r) => r.text()).then((t) => { m.textContent = t; });
</script>`;

let discordLogin = null; // login em andamento: { server, timer, resolve }

function endDiscordLogin(result) {
  if (!discordLogin) return;
  const { server, timer, resolve } = discordLogin;
  discordLogin = null;
  clearTimeout(timer);
  server.close();
  resolve(result);
}

// Abre a autorização do Discord no navegador e espera ele voltar pro 127.0.0.1 com o token.
// Só o perfil (id, nome, foto) volta pro renderer; o token é descartado.
function loginDiscord() {
  if (!DISCORD_CLIENT_ID) return Promise.resolve({ ok: false, error: 'Login com Discord ainda não configurado.' });
  endDiscordLogin({ ok: false, error: 'Login cancelado.' }); // clicou de novo

  const state = crypto.randomBytes(16).toString('hex');
  const url = 'https://discord.com/oauth2/authorize?' + new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    response_type: 'token',
    redirect_uri: DISCORD_REDIRECT,
    scope: 'identify',
    state,
  });

  return new Promise((resolve) => {
    const reply = (res, text) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(text);
    };
    const server = http.createServer(async (req, res) => {
      const { pathname, searchParams: p } = new URL(req.url, DISCORD_REDIRECT);
      if (pathname === '/callback') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(CALLBACK_PAGE);
      }
      if (pathname !== '/token' || p.get('state') !== state) {
        res.writeHead(404);
        return res.end();
      }
      const token = p.get('access_token');
      if (!token) {
        reply(res, 'Login cancelado. Pode fechar esta aba.');
        return endDiscordLogin({ ok: false, error: 'Login cancelado.' });
      }
      try {
        const r = await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) throw new Error(`Discord respondeu ${r.status}`);
        const u = await r.json();
        reply(res, 'Pronto! Pode fechar esta aba e voltar pro Telinha.');
        endDiscordLogin({
          ok: true,
          user: {
            id: u.id,
            username: u.username,
            globalName: u.global_name,
            avatar: u.avatar,
            banner: u.banner, // mural do perfil
            accentColor: u.accent_color, // cor do mural quando não tem imagem
            decoration: u.avatar_decoration_data?.asset, // enfeite em volta da foto
            nameplate: u.collectibles?.nameplate?.asset, // placa de nome (fundo atrás do nome na lista)
          },
        });
        if (win) { win.show(); win.focus(); }
      } catch (e) {
        console.error('Login Discord:', e);
        reply(res, 'Não deu pra pegar seu perfil do Discord. Tente de novo.');
        endDiscordLogin({ ok: false, error: 'Não deu pra pegar seu perfil do Discord.' });
      }
    });
    server.on('error', () => endDiscordLogin({ ok: false, error: `A porta ${DISCORD_PORT} está ocupada por outro programa.` }));
    const timer = setTimeout(() => endDiscordLogin({ ok: false, error: 'Tempo esgotado. Tente de novo.' }), 5 * 60_000);
    discordLogin = { server, timer, resolve };
    server.listen(DISCORD_PORT, '127.0.0.1', () => shell.openExternal(url));
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1e1f22',
    autoHideMenuBar: true,
    title: 'Telinha',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    openRadmin(win);
    checkUpdates(win);
  });
}

app.whenReady().then(() => {
  if (!primary) return;
  // getDisplayMedia no renderer cai aqui; entregamos a fonte escolhida + som do sistema.
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const source = sources.find((s) => s.id === pending.id);
      if (!source) return callback({});
      const audio = pending.audio && request.audioRequested ? { audio: 'loopback' } : {};
      callback({ video: source, ...audio });
    } catch (e) {
      console.error(e);
      try { callback({}); } catch {}
    }
  });

  ipcMain.handle('get-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true,
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      thumbnail: s.thumbnail.toDataURL(),
      icon: s.appIcon ? s.appIcon.toDataURL() : null,
    }));
  });

  ipcMain.handle('select-source', (_e, id, audio) => {
    pending = { id, audio: !!audio };
  });

  ipcMain.handle('audio-start', (_e, args) => startAppAudio(args));
  ipcMain.handle('audio-stop', stopAppAudio);
  ipcMain.handle('discord-login', loginDiscord);
  // Nome do programa que está sendo transmitido ("VALORANT", "Google Chrome"), pra aparecer pros outros.
  ipcMain.handle('app-name', (_e, target) => new Promise((resolve) => {
    if (!fs.existsSync(helperExe()) || !/^(\d+|foreground)$/.test(String(target))) return resolve(null);
    execFile(helperExe(), ['appname', String(target)], { windowsHide: true, timeout: 3000, encoding: 'utf8' }, (err, out) => {
      if (err || !out.includes('\t')) return resolve(null);
      const [exe, description] = out.trim().split('\t');
      resolve({ exe, description });
    });
  }));
  ipcMain.handle('show-window', () => {
    if (win?.isMinimized()) win.restore();
    win?.show();
    win?.focus();
  });

  ipcMain.handle('set-shortcut', (_e, accel) => (accel === '' || SHORTCUTS.includes(accel) ? setLiveShortcut(accel) : false));

  createWindow();
});

app.on('window-all-closed', () => app.quit());

// Fecha o Radmin VPN por completo (janela + VPN) e a captura de som junto com o Telinha.
app.on('will-quit', () => {
  if (!primary) return;
  globalShortcut.unregisterAll();
  stopAppAudio();
  try {
    execFileSync('taskkill', ['/F', '/IM', 'RvRvpnGui.exe'], { stdio: 'ignore', windowsHide: true });
  } catch {} // não estava aberto
  try {
    execFileSync('sc', ['stop', RADMIN_SERVICE], { stdio: 'ignore', windowsHide: true });
  } catch {} // já parado (ou sem permissão de administrador)
});
