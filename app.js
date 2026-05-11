const $ = (id) => document.getElementById(id);

const strings = {
  G3: { midi: 55, fifthSteps: -14, ko: "솔" },
  D4: { midi: 62, fifthSteps: -7, ko: "레" },
  A4: { midi: 69, fifthSteps: 0, ko: "라" },
  E5: { midi: 76, fifthSteps: 7, ko: "미" },
};

const tempos = [
  { max: 45, name: "Grave · 매우 느리게" },
  { max: 60, name: "Largo · 느리게" },
  { max: 76, name: "Adagio · 조금 느리게" },
  { max: 108, name: "Andante · 걷는 빠르기" },
  { max: 120, name: "Moderato · 보통 빠르기" },
  { max: 156, name: "Allegro · 빠르게" },
  { max: 176, name: "Vivace · 경쾌하게" },
  { max: 220, name: "Presto · 매우 빠르게" },
];

let audioContext;
let analyser;
let inputBuffer;
let selected = "A4";
let metroTimer = null;
let beat = 0;

function ensureAudioContext() {
  if (!audioContext) {
    audioContext = new AudioContext({ latencyHint: "interactive" });
  }
  if (audioContext.state === "suspended") {
    audioContext.resume();
  }
  return audioContext;
}

function a4() {
  return Number.parseFloat($("a4").value) || 440;
}

function targetFreq(name = selected) {
  const base = a4();
  const item = strings[name];
  if ($("temperament").value === "violin" && item) {
    return base * Math.pow(1.5, item.fifthSteps / 7);
  }
  return base * Math.pow(2, ((item?.midi ?? 69) - 69) / 12);
}

function noteFromFreq(freq) {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const midi = Math.round(69 + 12 * Math.log2(freq / a4()));
  return `${names[(midi % 12 + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

function updateTempoName() {
  const bpm = Number.parseInt($("bpm").value, 10) || 72;
  $("bpmText").textContent = bpm;
  $("tempoName").textContent = tempos.find((tempo) => bpm <= tempo.max).name;
}

function updateStringLabels() {
  document.querySelectorAll("[data-string]").forEach((button) => {
    const key = button.dataset.string;
    const small = button.querySelector("small");
    button.classList.toggle("active", key === selected);
    small.textContent = `${key} · ${targetFreq(key).toFixed(2)} Hz`;
  });
}

function updateTarget() {
  updateStringLabels();
  $("target").textContent = `${selected} (${strings[selected].ko}) 기준: ${targetFreq(selected).toFixed(2)} Hz`;
}

function playTone(freq = targetFreq(selected), duration = 1.6) {
  const ctx = ensureAudioContext();
  const now = ctx.currentTime;
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();

  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(freq, now);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.26, now + 0.03);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start(now);
  oscillator.stop(now + duration + 0.04);
}

function yin(buffer, sampleRate) {
  const threshold = 0.12;
  const tauMax = Math.floor(sampleRate / 70);
  const tauMin = Math.floor(sampleRate / 1200);
  let rms = 0;

  for (const value of buffer) rms += value * value;
  rms = Math.sqrt(rms / buffer.length);
  if (rms < Number.parseFloat($("sensitivity").value)) return null;

  const values = new Float32Array(tauMax);
  for (let tau = 1; tau < tauMax; tau += 1) {
    let sum = 0;
    for (let i = 0; i < tauMax; i += 1) {
      const delta = buffer[i] - buffer[i + tau];
      sum += delta * delta;
    }
    values[tau] = sum;
  }

  let running = 0;
  values[0] = 1;
  for (let tau = 1; tau < tauMax; tau += 1) {
    running += values[tau];
    values[tau] *= tau / running;
  }

  let tau;
  for (tau = tauMin; tau < tauMax; tau += 1) {
    if (values[tau] < threshold) {
      while (tau + 1 < tauMax && values[tau + 1] < values[tau]) tau += 1;
      break;
    }
  }
  if (tau === tauMax) return null;

  const betterTau =
    tau > 1 && tau + 1 < tauMax
      ? tau + (values[tau - 1] - values[tau + 1]) / (2 * (2 * values[tau] - values[tau - 1] - values[tau + 1]))
      : tau;
  return sampleRate / betterTau;
}

function tick() {
  analyser.getFloatTimeDomainData(inputBuffer);
  const freq = yin(inputBuffer, audioContext.sampleRate);
  if (freq) {
    const target = targetFreq(selected);
    const cents = 1200 * Math.log2(freq / target);
    $("noteName").textContent = noteFromFreq(freq);
    $("freq").textContent = `${freq.toFixed(2)} Hz`;
    $("cents").textContent = `${cents > 0 ? "+" : ""}${cents.toFixed(1)} cents`;
    $("needle").style.transform = `translateX(-50%) translateX(${Math.max(-50, Math.min(50, cents)) * 3}px)`;
    updateTarget();
  }
  requestAnimationFrame(tick);
}

async function startMic() {
  const ctx = ensureAudioContext();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
  analyser = ctx.createAnalyser();
  analyser.fftSize = 4096;
  inputBuffer = new Float32Array(analyser.fftSize);
  ctx.createMediaStreamSource(stream).connect(analyser);
  tick();
  $("startBtn").textContent = "측정 중";
}

function startMetro() {
  const ctx = ensureAudioContext();
  const interval = 60000 / (Number.parseInt($("bpm").value, 10) || 72);
  metroTimer = setInterval(() => {
    beat += 1;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.frequency.value = beat % 4 === 1 ? 1320 : 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.24, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.08);
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.09);
    $("beatLamp").classList.add("flash");
    setTimeout(() => $("beatLamp").classList.remove("flash"), 90);
  }, interval);
  $("metroBtn").textContent = "정지";
}

function stopMetro() {
  clearInterval(metroTimer);
  metroTimer = null;
  $("metroBtn").textContent = "시작";
}

$("startBtn").addEventListener("click", startMic);
$("toneBtn").addEventListener("click", () => playTone());

document.querySelectorAll("[data-string]").forEach((button) => {
  button.addEventListener("click", () => {
    selected = button.dataset.string;
    updateTarget();
    playTone();
  });
});

$("a4").addEventListener("input", updateTarget);
$("temperament").addEventListener("change", updateTarget);
$("bpm").addEventListener("input", () => {
  updateTempoName();
  if (metroTimer) {
    stopMetro();
    startMetro();
  }
});
$("metroBtn").addEventListener("click", () => {
  if (metroTimer) stopMetro();
  else startMetro();
});

updateTempoName();
updateTarget();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
