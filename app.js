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
let micStream;
let animationFrameId;
let selected = "A4";
let metroTimer = null;
let beat = 0;
let isListening = false;
const recentFreqs = [];

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

function setBpm(value) {
  $("bpm").value = value;
  updateTempoName();
  if (metroTimer) {
    stopMetro();
    startMetro();
  }
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

function nearestToTarget(freq) {
  const target = targetFreq(selected);
  const candidates = [freq, freq / 2, freq * 2].filter((value) => value >= 70 && value <= 1200);
  return candidates.reduce((best, value) => {
    const bestDistance = Math.abs(1200 * Math.log2(best / target));
    const valueDistance = Math.abs(1200 * Math.log2(value / target));
    return valueDistance < bestDistance ? value : best;
  }, candidates[0] ?? freq);
}

function smoothFreq(freq) {
  recentFreqs.push(freq);
  if (recentFreqs.length > 5) recentFreqs.shift();
  return [...recentFreqs].sort((a, b) => a - b)[Math.floor(recentFreqs.length / 2)];
}

function detectPitch(buffer, sampleRate) {
  const minFreq = 70;
  const maxFreq = 1200;
  const tauMax = Math.floor(sampleRate / minFreq);
  const tauMin = Math.floor(sampleRate / maxFreq);
  const size = Math.min(buffer.length, tauMax * 2);
  let rms = 0;

  for (let i = 0; i < size; i += 1) rms += buffer[i] * buffer[i];
  rms = Math.sqrt(rms / size);
  if (rms < Number.parseFloat($("sensitivity").value)) {
    return { freq: null, rms, clarity: 0, reason: "소리가 작아요. 아이폰을 브릿지에서 30-50cm 정도 두고 한 줄만 길게 켜주세요." };
  }

  let bestTau = -1;
  let bestCorrelation = 0;
  for (let tau = tauMin; tau <= tauMax; tau += 1) {
    let correlation = 0;
    let leftEnergy = 0;
    let rightEnergy = 0;
    const limit = size - tau;
    for (let i = 0; i < limit; i += 1) {
      const left = buffer[i];
      const right = buffer[i + tau];
      correlation += left * right;
      leftEnergy += left * left;
      rightEnergy += right * right;
    }
    const normalized = correlation / Math.sqrt(leftEnergy * rightEnergy || 1);
    if (normalized > bestCorrelation) {
      bestCorrelation = normalized;
      bestTau = tau;
    }
  }

  if (bestTau < 0 || bestCorrelation < 0.45) {
    return { freq: null, rms, clarity: bestCorrelation, reason: "음이 흔들리거나 주변 소음이 큽니다. 한 줄만 일정하게 켜주세요." };
  }

  const rawFreq = sampleRate / bestTau;
  const corrected = nearestToTarget(rawFreq);
  return { freq: smoothFreq(corrected), rms, clarity: bestCorrelation, reason: "" };
}

function tick() {
  if (!isListening) return;
  analyser.getFloatTimeDomainData(inputBuffer);
  const result = detectPitch(inputBuffer, audioContext.sampleRate);
  const freq = result.freq;
  if (freq) {
    const target = targetFreq(selected);
    const cents = 1200 * Math.log2(freq / target);
    $("noteName").textContent = noteFromFreq(freq);
    $("freq").textContent = `${freq.toFixed(2)} Hz`;
    $("cents").textContent = `${cents > 0 ? "+" : ""}${cents.toFixed(1)} cents`;
    $("needle").style.transform = `translateX(-50%) translateX(${Math.max(-50, Math.min(50, cents)) * 3}px)`;
    $("micStatus").textContent = `입력 감지됨 · 안정도 ${(result.clarity * 100).toFixed(0)}%`;
    updateTarget();
  } else if (result.reason) {
    $("micStatus").textContent = result.reason;
  }
  animationFrameId = requestAnimationFrame(tick);
}

async function startMic() {
  try {
    if (isListening) return;
    const ctx = ensureAudioContext();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    analyser = ctx.createAnalyser();
    analyser.fftSize = 8192;
    inputBuffer = new Float32Array(analyser.fftSize);
    micStream = stream;
    ctx.createMediaStreamSource(stream).connect(analyser);
    isListening = true;
    tick();
    $("startBtn").textContent = "측정 중";
    $("startBtn").disabled = true;
    $("stopBtn").disabled = false;
    $("micStatus").textContent = "마이크가 켜졌습니다. 선택한 줄을 길게 켜주세요.";
  } catch (error) {
    $("micStatus").textContent = "마이크 권한을 허용해야 조율할 수 있습니다. Safari 주소창 설정에서 마이크 허용을 확인해주세요.";
  }
}

function stopMic() {
  isListening = false;
  if (animationFrameId) cancelAnimationFrame(animationFrameId);
  animationFrameId = undefined;
  if (micStream) {
    micStream.getTracks().forEach((track) => track.stop());
    micStream = undefined;
  }
  analyser = undefined;
  inputBuffer = undefined;
  recentFreqs.length = 0;
  $("startBtn").textContent = "마이크 시작";
  $("startBtn").disabled = false;
  $("stopBtn").disabled = true;
  $("noteName").textContent = "--";
  $("freq").textContent = "0.00 Hz";
  $("cents").textContent = "-- cents";
  $("needle").style.transform = "translateX(-50%)";
  $("micStatus").textContent = "마이크가 꺼졌습니다.";
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
$("stopBtn").addEventListener("click", stopMic);

document.querySelectorAll("[data-string]").forEach((button) => {
  button.addEventListener("click", () => {
    selected = button.dataset.string;
    recentFreqs.length = 0;
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
$("tempoPreset").addEventListener("change", () => setBpm($("tempoPreset").value));
$("metroBtn").addEventListener("click", () => {
  if (metroTimer) stopMetro();
  else startMetro();
});

updateTempoName();
updateTarget();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
