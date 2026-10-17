# Telinha

Compartilhamento de tela com som para até 5 amigos (Electron + WebRTC). A sala é fixa e a conexão passa pelo Radmin VPN.

## Desenvolvimento

```
npm install
npm start
```

## Publicar uma versão nova (atualiza os amigos sozinho)

1. Faça as mudanças e teste com `npm start`.
2. Aumente o `version` no `package.json` (ex.: `2.1.0` → `2.2.0`).
3. Publique:

   ```powershell
   $env:GH_TOKEN = gh auth token; npm run release
   ```

   Isso gera `dist/Telinha-Setup-<versão>.exe` e cria uma release no repositório público
   [DBRASA/telinha-releases](https://github.com/DBRASA/telinha-releases).
4. Na próxima vez que os amigos abrirem o Telinha, ele baixa a versão nova e pergunta se quer reiniciar.

Para gerar o instalador sem publicar: `npm run dist`.

## Primeira instalação dos amigos

Baixar o `Telinha-Setup-<versão>.exe` mais recente em
https://github.com/DBRASA/telinha-releases/releases/latest e instalar. Depois disso as atualizações são automáticas.

## Trocar a sala

Mude `APP_ID` e `PASSWORD` no topo de `src/app.js` e publique uma versão nova.
