import { PitchDetector } from "pitchy";

//  AUDIO WORKLET PROCESSOR (inlined as a Blob)
//  Runs on the audio thread, posts raw PCM frames

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

/* ─────────────────────────────────────────────
   CONSTANTS
   ───────────────────────────────────────────── */
const A4 = 440;
const NOTE_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
];
const FRAME_SIZE = 2048;

// Guitar band splits: [label, lowHz, highHz]
const BANDS = [
  ["bass", 82, 200],
  ["mid", 200, 500],
  ["treble", 500, 1319],
];

/* ─────────────────────────────────────────────
   UTILITIES
   ───────────────────────────────────────────── */
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

/** Cents sharp (+) or flat (-) relative to the nearest equal-tempered pitch */
function centDeviation(freq) {
  const midi = 12 * Math.log2(freq / A4) + 69;
  const nearest = Math.round(midi);
  return Math.round((midi - nearest) * 100);
}

function rms(buf) {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / buf.length);
}

function mostCommon(arr) {
  const c = {};
  arr.forEach((n) => (c[n] = (c[n] || 0) + 1));
  let max = 0,
    winner = null;
  for (const n in c)
    if (c[n] > max) {
      max = c[n];
      winner = n;
    }
  return winner;
}

/* ─────────────────────────────────────────────
   FFT PEAK PICKING WITH HARMONIC VALIDATION
   ───────────────────────────────────────────── */

/**
 * Finds candidate fundamental frequencies in a magnitude spectrum
 * by locating spectral peaks and validating that their harmonics
 * (2f, 3f, 4f) also carry significant energy.
 *
 * @param {Float32Array} freqData   - getFloatFrequencyData() output (dBFS)
 * @param {number}       sampleRate
 * @param {object}       opts
 * @returns {Array<{freq, note, cents}>}
 */
function fftPeakNotes(
  freqData,
  sampleRate,
  {
    minFreq = 82,
    maxFreq = 1319,
    noiseFloor = -60, // dBFS below which we ignore bins
    peakDelta = 6, // dB above neighbours to count as peak
    harmonics = 3, // how many harmonics to validate
    harmonicGain = -18, // harmonic must be within XdB of fundamental
  } = {},
) {
  const binHz = sampleRate / (2 * (freqData.length - 1));
  const results = [];

  const minBin = Math.ceil(minFreq / binHz);
  const maxBin = Math.floor(maxFreq / binHz);

  for (let i = minBin; i <= maxBin; i++) {
    const mag = freqData[i];
    if (mag < noiseFloor) continue;
    // local peak check
    if (mag <= freqData[i - 1] || mag <= freqData[i + 1]) continue;
    if (mag - freqData[i - 1] < peakDelta && mag - freqData[i + 1] < peakDelta)
      continue;

    const freq = i * binHz;

    // harmonic validation
    let harmonicScore = 0;
    for (let h = 2; h <= harmonics + 1; h++) {
      const hBin = Math.round((freq * h) / binHz);
      if (hBin >= freqData.length) break;
      if (freqData[hBin] > noiseFloor && freqData[hBin] >= mag + harmonicGain) {
        harmonicScore++;
      }
    }
    // require at least half of the harmonics to be present
    if (harmonicScore < Math.floor(harmonics / 2)) continue;

    results.push({
      freq,
      note: freqToNote(freq),
      cents: centDeviation(freq),
    });
  }

  return results;
}

/* ─────────────────────────────────────────────
   BAND-SPLIT + PARALLEL PITCHY DETECTORS
   ───────────────────────────────────────────── */

/**
 * Runs the McLeod (pitchy) detector on each frequency band independently.
 * Each band has its own smoothing buffer and lastNote for hysteresis.
 */
function createBandDetectors(clarityThreshold, bufferSize) {
  return BANDS.map(([label, lo, hi]) => {
    const detector = PitchDetector.forFloat32Array(FRAME_SIZE);
    const noteBuffer = [];
    let lastNote = null;
    let lastEnergy = 0;

    return {
      label,
      lo,
      hi,
      detector,
      noteBuffer,
      lastNote,
      lastEnergy,
      bufferSize,
      clarityThreshold,
    };
  });
}

/**
 * Applies a simple software bandpass via frequency masking on a copy of
 * the time-domain buffer before running pitchy.  (A proper approach would
 * use biquad-filtered streams, but this avoids extra Web Audio nodes and
 * works well enough given pitchy's built-in autocorrelation windowing.)
 *
 * We apply a rectangular window in the frequency domain then IFFT via
 * the AnalyserNode — but since we only have time-domain data here, we do
 * the simpler thing: trust that pitchy's autocorrelation naturally weights
 * the dominant frequency, and use the [lo, hi] range to gate the result.
 */
function runBandDetector(band, frame, sampleRate, minEnergy, hysteresisRatio) {
  const energy = rms(frame);

  // Silence hysteresis: note-on at minEnergy, note-off at minEnergy * hysteresisRatio
  const onThreshold = minEnergy;
  const offThreshold = minEnergy * hysteresisRatio;

  if (energy < offThreshold) {
    band.lastNote = null;
    band.lastEnergy = energy;
    return null;
  }

  if (energy < onThreshold && band.lastNote === null) {
    band.lastEnergy = energy;
    return null;
  }

  const [freq, clarity] = band.detector.findPitch(frame, sampleRate);

  if (clarity < band.clarityThreshold || freq < band.lo || freq > band.hi) {
    band.lastEnergy = energy;
    return null;
  }

  const note = freqToNote(freq);
  band.noteBuffer.push(note);
  if (band.noteBuffer.length > band.bufferSize) band.noteBuffer.shift();

  const smoothed = mostCommon(band.noteBuffer);

  // Onset detection: did we just cross the energy threshold from below?
  const isOnset = band.lastEnergy < onThreshold && energy >= onThreshold;
  const noteChanged = smoothed !== band.lastNote;

  band.lastNote = smoothed;
  band.lastEnergy = energy;

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

/* ─────────────────────────────────────────────
   MERGE & DEDUPLICATE DETECTIONS
   ───────────────────────────────────────────── */

/**
 * Merges notes from band detectors and FFT peak picker.
 * Deduplicates by MIDI pitch (within ±1 semitone).
 */
function mergeNotes(bandNotes, fftNotes, activeNotes, minEnergy) {
  const all = [...bandNotes];

  for (const fn of fftNotes) {
    const midi = freqToMidi(fn.freq);
    const dup = all.some((n) => Math.abs(freqToMidi(n.freq) - midi) <= 1);
    if (!dup)
      all.push({ source: "fft", isOnset: !activeNotes.has(fn.note), ...fn });
  }

  return all;
}

/* ─────────────────────────────────────────────
   PUBLIC API
   ───────────────────────────────────────────── */

/**
 * Creates a polyphonic pitch listener.
 *
 * @param {object} opts
 * @param {function} opts.onNotes          - Called with an array of detected note objects
 * @param {function} [opts.onOnset]        - Called when a new note onset is detected
 * @param {string}  [opts.deviceId]        - Specific audio input device
 * @param {number}  [opts.minEnergy]       - RMS energy threshold for note-on  (default 0.03)
 * @param {number}  [opts.hysteresisRatio] - note-off = minEnergy * ratio       (default 0.6)
 * @param {number}  [opts.clarityThreshold]- pitchy clarity gate               (default 0.88)
 * @param {number}  [opts.minFreq]         - lowest frequency to track Hz       (default 82)
 * @param {number}  [opts.maxFreq]         - highest frequency to track Hz      (default 1319)
 * @param {number}  [opts.smoothing]       - band detector smoothing buffer len (default 5)
 *
 * Each note object passed to onNotes:
 * {
 *   note:    string,   // e.g. "E2"
 *   freq:    number,   // Hz
 *   cents:   number,   // deviation from equal temperament (-50..+50)
 *   clarity: number,   // pitchy confidence 0-1 (band notes only)
 *   isOnset: boolean,  // true on first frame of a new note
 *   source:  string,   // "band:bass" | "band:mid" | "band:treble" | "fft"
 *   energy:  number,   // RMS energy of this frame
 * }
 *
 * @returns {Promise<{start, stop}>}
 */
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
  if (!navigator.mediaDevices?.getUserMedia)
    throw new Error("Browser does not support microphone access.");
  const ACtx = window.AudioContext ?? window.webkitAudioContext;
  if (!ACtx) throw new Error("Browser does not support Web Audio API.");

  /* -- AudioContext --------------------------------------------------- */
  const context = new ACtx();

  /* -- Microphone stream --------------------------------------------- */
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

  /* -- AudioWorklet --------------------------------------------------- */
  const blob = new Blob([WORKLET_CODE], { type: "application/javascript" });
  const blobUrl = URL.createObjectURL(blob);
  await context.audioWorklet.addModule(blobUrl);
  URL.revokeObjectURL(blobUrl);

  const source = context.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(context, "pitch-processor");

  /* -- AnalyserNode for FFT ------------------------------------------ */
  const analyser = context.createAnalyser();
  analyser.fftSize = 8192; // high resolution for FFT peak picker
  analyser.smoothingTimeConstant = 0.5;
  const fftBuf = new Float32Array(analyser.frequencyBinCount);

  /* -- Highpass filter ------------------------------------------------ */
  const hpf = context.createBiquadFilter();
  hpf.type = "highpass";
  hpf.frequency.value = 70;

  source.connect(hpf);
  hpf.connect(analyser);
  hpf.connect(worklet); // worklet gets filtered signal too

  /* -- Band detectors ------------------------------------------------- */
  const bands = createBandDetectors(clarityThreshold, smoothing);
  const activeNotes = new Set(); // currently sounding notes (for onset tracking)

  /* -- Main processing handler --------------------------------------- */
  worklet.port.onmessage = ({ data: frame }) => {
    // --- Band-split detections ---
    const bandNotes = bands
      .map((band) =>
        runBandDetector(
          band,
          frame,
          context.sampleRate,
          minEnergy,
          hysteresisRatio,
        ),
      )
      .filter(Boolean);

    // --- FFT peak detections ---
    analyser.getFloatFrequencyData(fftBuf);
    const fftNotes = fftPeakNotes(fftBuf, context.sampleRate, {
      minFreq,
      maxFreq,
    });

    // --- Merge & deduplicate ---
    const detected = mergeNotes(bandNotes, fftNotes, activeNotes);

    if (detected.length === 0) return;

    // Update active note set
    detected.forEach(({ note }) => activeNotes.add(note));

    // Fire callbacks
    if (onNotes) onNotes(detected);

    const onsets = detected.filter((n) => n.isOnset);
    if (onsets.length && onOnset) onOnset(onsets);
  };

  // a gain node with volume 0 — silent, but keeps the worklet alive
  const silentGain = context.createGain();
  silentGain.gain.value = 0;
  silentGain.connect(context.destination);

  let connected = false;

  return {
    start() {
      if (connected) return;
      connected = true;
      worklet.connect(silentGain); // ← routes to silence instead of speakers
    },

    stop() {
      connected = false;
      worklet.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      context.close().catch(() => {});
    },
  };
}
