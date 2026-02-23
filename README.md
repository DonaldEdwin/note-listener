# note-listener

A lightweight JavaScript/TypeScript library for real-time musical note detection from microphone audio in the browser.
Ideal for guitar practice, tuners, music apps, and live pitch visualization.

`note-listener` listens to audio input, detects the dominant pitch, and continuously emits the corresponding musical note.

## Features

-  Real-time musical note detection (C0–B8)
-  Works with any microphone or sound card
-  Smooths jitter using internal buffering
-  Configurable frequency range and clarity threshold
-  Pure browser-based (Web Audio API)
-  Minimal dependencies ([pitchy](https://github.com/ianprime0509/pitchy))

## Installation

```bash
npm install note-listener
# or
yarn add note-listener
```

## How it works

This library is **event-based**, not return-based.

1. You start listening to the microphone
2. The library continuously detects notes
3. Each detected note is sent to you via a callback
4. Listening continues until you explicitly stop it

There is no "single return value" — notes are streamed over time.

## Usage

### 1. List available audio inputs (optional)

```js
import { listAudioInputs } from "note-listener"

const inputs = await listAudioInputs()
console.log(inputs)
// [{ deviceId: "...", label: "Built-in Microphone" }, ...]
```

> **Note:** Browsers require microphone permission before device labels appear:
> ```js
> await navigator.mediaDevices.getUserMedia({ audio: true })
> ```

### 2. Create a pitch listener

```js
import { createPitchListener } from "note-listener"

const listener = await createPitchListener({
  deviceId: inputs[0].deviceId,
  minEnergy: 0.03,
  onNote: (note, frequency, clarity) => {
    console.log(
      `${note} (${frequency.toFixed(2)} Hz, clarity ${clarity.toFixed(2)})`
    )
  },
})
```

At this point, the microphone is **not yet active** and no audio is being analyzed. You are just configuring the listener.

### 3. Start listening

```js
listener.start()
```

When `start()` is called, the browser activates the selected microphone, audio is analyzed in real time, and detected notes are emitted via `onNote`.

### 4. Stop listening

```js
listener.stop()
```

This stops the microphone stream, disconnects audio nodes, and frees system resources. You should always call `stop()` when done.

## Examples

### Plain JavaScript

```js
import { listAudioInputs, createPitchListener } from "note-listener"

await navigator.mediaDevices.getUserMedia({ audio: true })

const inputs = await listAudioInputs()

const listener = await createPitchListener({
  deviceId: inputs[0].deviceId,
  onNote(note, freq) {
    console.log(`Current note: ${note} (${freq.toFixed(1)} Hz)`)
  },
})

listener.start()

// Later...
// listener.stop()
```

### Vue 3

```vue
<template>
  <div>
    <h3>Select audio input</h3>

    <select v-model="selectedId">
      <option disabled value="">-- choose input --</option>
      <option v-for="d in inputs" :key="d.deviceId" :value="d.deviceId">
        {{ d.label }}
      </option>
    </select>

    <button @click="start" :disabled="!selectedId">Start</button>
    <button @click="stop">Stop</button>

    <p>Last note: {{ lastNote || "—" }}</p>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from "vue"
import { listAudioInputs, createPitchListener } from "note-listener"

const inputs = ref([])
const selectedId = ref("")
const lastNote = ref(null)
let listener = null

onMounted(async () => {
  await navigator.mediaDevices.getUserMedia({ audio: true })
  inputs.value = await listAudioInputs()
})

async function start() {
  if (listener) listener.stop()

  listener = await createPitchListener({
    deviceId: selectedId.value,
    onNote(note) {
      lastNote.value = note
    },
  })

  listener.start()
}

function stop() {
  if (listener) listener.stop()
}

onBeforeUnmount(stop)
</script>
```

## API

### `createPitchListener(options)`

| Option             | Type       | Default     | Description                              |
| ------------------ | ---------- | ----------- | ---------------------------------------- |
| `deviceId`         | `string`   | `undefined` | Audio input device ID                    |
| `minEnergy`        | `number`   | `0.03`      | Minimum RMS energy required              |
| `clarityThreshold` | `number`   | `0.88`      | Minimum pitch clarity                    |
| `minFreq`          | `number`   | `82`        | Minimum frequency (Hz)                   |
| `maxFreq`          | `number`   | `1319`      | Maximum frequency (Hz)                   |
| `onNote`           | `function` | required    | Called when a note is detected           |

### `onNote` callback

```ts
(note: string, frequency: number, clarity: number) => void
```

Called continuously while audio is being analyzed. `note` is a string like `"A4"`, `frequency` is in Hz, and `clarity` is a value between 0 and 1 indicating pitch confidence.

### `listAudioInputs()`

Returns a promise resolving to an array of available audio input devices:

```ts
[{ deviceId: string, label: string }]
```

## Browser support

- Works in modern Chromium, Firefox, and Safari
- Requires user interaction to initiate microphone access
- Not supported in Node.js or server-side environments

## License

MIT © Donald Edwin