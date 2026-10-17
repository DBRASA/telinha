const { app, BrowserWindow, ipcMain, desktopCapturer, session, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, execFileSync, spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');

let pending = { id: null, audio: true }; // fonte escolhida no seletor

// Abre o Radmin VPN junto com o Telinha (se já não estiver aberto).
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

  execFile('tasklist', ['/FI', 'IMAGENAME eq RvRvpnGui.exe', '/NH'], (err, out) => {
    if (!err && out.includes('RvRvpnGui.exe')) return; // já está aberto
    spawn(exe, ['/show'], { detached: true, stdio: 'ignore' }).unref();
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
  const exe = app.isPackaged
    ? path.join(process.resourcesPath, 'TelinhaAudio.exe')
    : path.join(__dirname, 'native', 'TelinhaAudio.exe');
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

function createWindow() {
  const win = new BrowserWindow({
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

  createWindow();
});

app.on('window-all-closed', () => app.quit());

// Fecha o Radmin VPN (e a captura de som) junto com o Telinha.
app.on('will-quit', () => {
  stopAppAudio();
  try {
    execFileSync('taskkill', ['/F', '/IM', 'RvRvpnGui.exe'], { stdio: 'ignore', windowsHide: true });
  } catch {} // não estava aberto
});
