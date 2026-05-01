import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const output = resolve("public/soundtrack.wav");
if (existsSync(output)) {
  process.exit(0);
}

mkdirSync(dirname(output), { recursive: true });

const sampleRate = 48000;
const seconds = 18;
const sampleCount = sampleRate * seconds;
const channels = 2;
const bytesPerSample = 2;
const dataSize = sampleCount * channels * bytesPerSample;
const buffer = Buffer.alloc(44 + dataSize);

const writeString = (offset, value) => buffer.write(value, offset, "ascii");
writeString(0, "RIFF");
buffer.writeUInt32LE(36 + dataSize, 4);
writeString(8, "WAVE");
writeString(12, "fmt ");
buffer.writeUInt32LE(16, 16);
buffer.writeUInt16LE(1, 20);
buffer.writeUInt16LE(channels, 22);
buffer.writeUInt32LE(sampleRate, 24);
buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
buffer.writeUInt16LE(channels * bytesPerSample, 32);
buffer.writeUInt16LE(bytesPerSample * 8, 34);
writeString(36, "data");
buffer.writeUInt32LE(dataSize, 40);

const clamp = (value) => Math.max(-1, Math.min(1, value));
const tone = (freq, t) => Math.sin(2 * Math.PI * freq * t);
const envelope = (t) => {
  const attack = Math.min(1, t / 1.2);
  const release = Math.min(1, (seconds - t) / 1.4);
  return Math.max(0, Math.min(attack, release));
};

const chordAt = (t) => {
  const step = Math.floor(t / 4.5) % 4;
  return [
    [110, 164.81, 220, 329.63],
    [98, 146.83, 196, 293.66],
    [130.81, 196, 261.63, 392],
    [87.31, 130.81, 174.61, 261.63],
  ][step];
};

for (let i = 0; i < sampleCount; i += 1) {
  const t = i / sampleRate;
  const chord = chordAt(t);
  const pad =
    chord.reduce((sum, freq, index) => {
      const detune = index % 2 === 0 ? 0.997 : 1.003;
      return sum + tone(freq * detune, t) * (0.12 / (index + 1));
    }, 0) * envelope(t);
  const pulse = Math.pow(Math.max(0, tone(1.333, t)), 10) * tone(chord[0] / 2, t) * 0.18;
  const tick = Math.pow(Math.max(0, tone(2.666, t + 0.08)), 20) * tone(1800, t) * 0.035;
  const shimmer = tone(880, t) * Math.pow(Math.max(0, tone(0.33, t)), 6) * 0.018;
  const value = clamp((pad + pulse + tick + shimmer) * 0.55);
  const left = Math.round(value * 32767);
  const right = Math.round((value * 0.92 + tone(0.08, t) * 0.012) * 32767);
  const offset = 44 + i * channels * bytesPerSample;
  buffer.writeInt16LE(left, offset);
  buffer.writeInt16LE(right, offset + 2);
}

writeFileSync(output, buffer);
