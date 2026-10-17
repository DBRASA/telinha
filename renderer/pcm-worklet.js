// Toca o PCM (48 kHz, estéreo, 16 bits) que chega do TelinhaAudio.exe,
// pra virar uma faixa de áudio do WebRTC.
const RING = 48000 * 2; // 1 s de amostras estéreo
const MAX_BUFFERED = 48000 * 2 * 0.15; // acima de 150 ms de atraso...
const TARGET_BUFFERED = 48000 * 2 * 0.05; // ...pula pra 50 ms

class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = new Float32Array(RING);
    this.read = 0;
    this.write = 0;
    this.size = 0;
    this.port.onmessage = (e) => this.push(new Int16Array(e.data.slice().buffer));
  }

  push(samples) {
    for (let i = 0; i < samples.length; i++) {
      this.ring[this.write] = samples[i] / 32768;
      this.write = (this.write + 1) % RING;
      if (this.size < RING) this.size++;
      else this.read = (this.read + 1) % RING;
    }
    if (this.size > MAX_BUFFERED) {
      const drop = (this.size - TARGET_BUFFERED) & ~1; // par, pra não trocar esquerdo/direito
      this.read = (this.read + drop) % RING;
      this.size -= drop;
    }
  }

  process(_inputs, outputs) {
    const [left, right] = outputs[0];
    for (let i = 0; i < left.length; i++) {
      if (this.size >= 2) {
        left[i] = this.ring[this.read];
        right[i] = this.ring[(this.read + 1) % RING];
        this.read = (this.read + 2) % RING;
        this.size -= 2;
      } else {
        left[i] = right[i] = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-player', PcmPlayer);
