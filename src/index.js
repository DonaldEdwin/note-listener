import { PitchDetector } from "pitchy";

const WORKLET_CODE = `
class PitchProcessorNode extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = [];
    this._frameSize = 2048;
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;

    for (let i = 0; i < ch.length; i++) this._buf.push(ch[i]);

    while (this._buf.length >= this._frameSize) {
      const frame = new Float32Array(this._buf.splice(0, this._frameSize));
      this.port.postMessage(frame, [frame.buffer]);
    }
    return true;
  }
}
registerProcessor("pitch-processor", PitchProcessorNode);
`;

const A4 = 440;
const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const FRAME_SIZE = 2048;

const BANDS = [
  ["bass", 82, 200],
  ["mid", 200, 500],
  ["treble", 500, 1319],
];

export function listAudioInputs() {
  return navigator.mediaDevices
    .enumerateDevices()
    .then((d) => d.filter((x) => x.kind === "audioinput"));
}

function freqToMidi(freq) {
  return Math.round(12 * Math.log2(freq / A4) + 69);
}

function midiToNote(midi) {
  return NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
}

function freqToNote(freq) {
  return midiToNote(freqToMidi(freq));
}

function centDeviation(freq) {
  const midi = 12 * Math.log2(freq / A4) + 69;
  const nearest = Math.round(midi);
  return Math.round((midi - nearest) * 100);
}

// ← NEW: if the freq jumped exactly an octave vs last frame, correct it
function correctOctave(freq, previousFreq) {
  if (!previousFreq) return freq;
  const ratio = freq / previousFreq;
  if (ratio > 1.8 && ratio < 2.2) return freq / 2;  // jumped up an octave, pull back down
  if (ratio > 0.45 && ratio < 0.55) return freq * 2; // jumped down an octave, push back up
  return freq;
}

function rms(buf) {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / buf.length);
}

function mostCommon(arr) {
  const c = {};
  arr.forEach((n) => (c[n] = (c[n] || 0) + 1));
  let max = 0, winner = null;
  for (const n in c) if (c[n] > max) { max = c[n]; winner = n; }
  return winner;
}

function fftPeakNotes(freqData, sampleRate, {
  minFreq = 82,
  maxFreq = 1319,
  noiseFloor = -60,
  peakDelta = 6,
  harmonics = 3,
  harmonicGain = -18,
} = {}) {
  const binHz = sampleRate / (2 * (freqData.length - 1));
  const results = [];
  const minBin = Math.ceil(minFreq / binHz);
  const maxBin = Math.floor(maxFreq / binHz);

  for (let i = minBin; i <= maxBin; i++) {
    const mag = freqData[i];
    if (mag < noiseFloor) continue;
    if (mag <= freqData[i - 1] || mag <= freqData[i + 1]) continue;
    if (mag - freqData[i - 1] < peakDelta && mag - freqData[i + 1] < peakDelta) continue;

    const freq = i * binHz;
    let harmonicScore = 0;
    for (let h = 2; h <= harmonics + 1; h++) {
      const hBin = Math.round((freq * h) / binHz);
      if (hBin >= freqData.length) break;
      if (freqData[hBin] > noiseFloor && freqData[hBin] >= mag + harmonicGain) harmonicScore++;
    }
    if (harmonicScore < Math.floor(harmonics / 2)) continue;

    results.push({ freq, note: freqToNote(freq), cents: centDeviation(freq) });
  }

  return results;
}

function createBandDetectors(clarityThreshold, bufferSize) {
  return BANDS.map(([label, lo, hi]) => {
    const detector = PitchDetector.forFloat32Array(FRAME_SIZE);
    const noteBuffer = [];
    let lastNote = null;
    let lastEnergy = 0;
    let lastFreq = null; // ← NEW: track previous freq for octave correction

    return { label, lo, hi, detector, noteBuffer, lastNote, lastEnergy, lastFreq, bufferSize, clarityThreshold };
  });
}

function runBandDetector(band, frame, sampleRate, minEnergy, hysteresisRatio) {
  const energy = rms(frame);
  const onThreshold = minEnergy;
  const offThreshold = minEnergy * hysteresisRatio;

  if (energy < offThreshold) {
    band.lastNote = null;
    band.lastEnergy = energy;
    band.lastFreq = null; // ← NEW: reset freq on silence
    return null;
  }

  if (energy < onThreshold && band.lastNote === null) {
    band.lastEnergy = energy;
    return null;
  }

  let [freq, clarity] = band.detector.findPitch(frame, sampleRate); // ← let instead of const
  freq = correctOctave(freq, band.lastFreq); // ← NEW: apply octave correction

  if (clarity < band.clarityThreshold || freq < band.lo || freq > band.hi) {
    band.lastEnergy = energy;
    return null;
  }

  const note = freqToNote(freq);
  band.noteBuffer.push(note);
  if (band.noteBuffer.length > band.bufferSize) band.noteBuffer.shift();

  const smoothed = mostCommon(band.noteBuffer);
  const isOnset = band.lastEnergy < onThreshold && energy >= onThreshold;
  const noteChanged = smoothed !== band.lastNote;

  band.lastNote = smoothed;
  band.lastEnergy = energy;
  band.lastFreq = freq; // ← NEW: store freq for next frame

  if (noteChanged || isOnset) {
    return {
      source: "band:" + band.label,
      note: smoothed,
      freq,
      clarity,
      cents: centDeviation(freq),
      isOnset,
      energy,
    };
  }
  return null;
}

function mergeNotes(bandNotes, fftNotes, activeNotes) {
  const all = [...bandNotes];
  for (const fn of fftNotes) {
    const midi = freqToMidi(fn.freq);
    const dup = all.some((n) => Math.abs(freqToMidi(n.freq) - midi) <= 1);
    if (!dup) all.push({ source: "fft", isOnset: !activeNotes.has(fn.note), ...fn });
  }
  return all;
}

export async function createPitchListener({
  onNotes,
  onOnset,
  deviceId,
  minEnergy = 0.03,
  hysteresisRatio = 0.6,
  clarityThreshold = 0.88,
  minFreq = 82,
  maxFreq = 1319,
  smoothing = 5,
} = {}) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Browser does not support microphone access.");
  const ACtx = window.AudioContext ?? window.webkitAudioContext;
  if (!ACtx) throw new Error("Browser does not support Web Audio API.");

  const context = new ACtx();

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: false,
        autoGainControl: false,
        noiseSuppression: false,
        latency: 0,
      },
    });
  } catch (e) {
    console.warn("Microphone access denied:", e.message);
    return { start() {}, stop() {} };
  }

  if (context.state === "suspended") await context.resume();

  const blob = new Blob([WORKLET_CODE], { type: "application/javascript" });
  const blobUrl = URL.createObjectURL(blob);
  await context.audioWorklet.addModule(blobUrl);
  URL.revokeObjectURL(blobUrl);

  const source = context.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(context, "pitch-processor");

  const analyser = context.createAnalyser();
  analyser.fftSize = 8192;
  analyser.smoothingTimeConstant = 0.5;
  const fftBuf = new Float32Array(analyser.frequencyBinCount);

  const hpf = context.createBiquadFilter();
  hpf.type = "highpass";
  hpf.frequency.value = 70;

  source.connect(hpf);
  hpf.connect(analyser);
  hpf.connect(worklet);

  const bands = createBandDetectors(clarityThreshold, smoothing);
  const activeNotes = new Set();

  worklet.port.onmessage = ({ data: frame }) => {
    const bandNotes = bands
      .map((band) => runBandDetector(band, frame, context.sampleRate, minEnergy, hysteresisRatio))
      .filter(Boolean);

    analyser.getFloatFrequencyData(fftBuf);
    const fftNotes = fftPeakNotes(fftBuf, context.sampleRate, { minFreq, maxFreq });

    const detected = mergeNotes(bandNotes, fftNotes, activeNotes);
    if (detected.length === 0) return;

    detected.forEach(({ note }) => activeNotes.add(note));
    if (onNotes) onNotes(detected);

    const onsets = detected.filter((n) => n.isOnset);
    if (onsets.length && onOnset) onOnset(onsets);
  };

  const silentGain = context.createGain();
  silentGain.gain.value = 0;
  silentGain.connect(context.destination);

  let connected = false;

  return {
    start() {
      if (connected) return;
      connected = true;
      worklet.connect(silentGain);
    },
    stop() {
      connected = false;
      worklet.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      context.close().catch(() => {});
    },
  };
}