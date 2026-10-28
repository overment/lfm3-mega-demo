// Shared pieces: API calls, the streaming speech player, the microphone recorder.

export const $ = (selector, root = document) => root.querySelector(selector);

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? "" : value);
  }
  el.append(...children.flat().filter((c) => c != null));
  return el;
}

export function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

export function clock(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

let toastTimer;
export function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4500);
}

// API

async function failure(response) {
  try {
    const body = await response.json();
    return new Error(typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail));
  } catch {
    return new Error(`${response.status} ${response.statusText}`);
  }
}

export async function upload(blob, name, purpose = "") {
  const form = new FormData();
  form.append("file", blob, name);
  const response = await fetch(`/api/upload?purpose=${purpose}`, { method: "POST", body: form });
  if (!response.ok) throw await failure(response);
  return response.json();
}

export async function post(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await failure(response);
  return response.json();
}

/** POST and call onEvent for every NDJSON event of the stream. */
export async function run(path, body, onEvent, signal) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw await failure(response);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const event = JSON.parse(line);
      if (event.type === "error") throw new Error(event.message);
      onEvent(event);
    }
  }
}

/** Text of one run. Long inputs come in parts; "replace" rewrites the current part. */
export class TextParts {
  constructor(separator = " ") {
    this.parts = [""];
    this.separator = separator;
  }
  add(event) {
    if (event.type === "part" && event.index > 0) this.parts.push("");
    if (event.type !== "text") return false;
    const last = this.parts.length - 1;
    if (event.replace != null) this.parts[last] = event.replace;
    else this.parts[last] += event.delta;
    return true;
  }
  get text() {
    return this.parts.map((p) => p.trim()).filter(Boolean).join(this.separator);
  }
}

// Speech output: 24 kHz int16 PCM chunks scheduled back to back with Web Audio.

export class StreamPlayer extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.sources = new Set();
    this.endAt = 0;
    this.owner = null;
    this.open = false; // more chunks may come
  }
  /** Call inside a click or key handler, so the browser allows sound. */
  unlock() {
    this.ctx ??= new AudioContext({ sampleRate: 24000, latencyHint: "interactive" });
    if (this.ctx.state === "suspended") this.ctx.resume();
  }
  begin(owner) {
    this.stop();
    this.owner = owner;
    this.open = true;
    this.changed();
  }
  push(base64) {
    if (!this.ctx) return;
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const ints = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
    if (!ints.length) return;
    const floats = new Float32Array(ints.length);
    for (let i = 0; i < ints.length; i++) floats[i] = ints[i] / 32768;
    const buffer = this.ctx.createBuffer(1, floats.length, 24000);
    buffer.copyToChannel(floats, 0);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);
    const at = Math.max(this.endAt, this.ctx.currentTime + 0.05);
    source.start(at);
    this.endAt = at + buffer.duration;
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      this.changed();
    };
    this.changed();
  }
  finish() {
    this.open = false;
    this.changed();
  }
  stop() {
    for (const source of this.sources) {
      source.onended = null;
      try { source.stop(); } catch {}
    }
    this.sources.clear();
    this.endAt = 0;
    this.open = false;
    this.changed();
  }
  get playing() {
    return this.sources.size > 0;
  }
  changed() {
    this.dispatchEvent(new Event("change"));
  }
}

// Microphone

export class Recorder {
  constructor() {
    this.media = null;
  }
  get active() {
    return this.media?.state === "recording";
  }
  get seconds() {
    return this.active ? (performance.now() - this.startedAt) / 1000 : 0;
  }
  async start(onLevel) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const type = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((t) => MediaRecorder.isTypeSupported(t));
    this.media = new MediaRecorder(this.stream, type ? { mimeType: type } : undefined);
    this.chunks = [];
    this.media.ondataavailable = (event) => event.data.size && this.chunks.push(event.data);
    this.media.start(250);
    this.startedAt = performance.now();
    this.meter = new AudioContext();
    const analyser = this.meter.createAnalyser();
    analyser.fftSize = 1024;
    this.meter.createMediaStreamSource(this.stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let smooth = 0;
    const tick = () => {
      if (!this.active) return onLevel?.(0);
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const s of samples) sum += s * s;
      const level = Math.min(1, Math.sqrt(sum / samples.length) * 6);
      smooth = level > smooth ? level : smooth * 0.85 + level * 0.15;
      onLevel?.(smooth, this.seconds);
      requestAnimationFrame(tick);
    };
    tick();
  }
  stop() {
    return new Promise((resolve) => {
      if (!this.media || this.media.state === "inactive") return resolve(null);
      this.media.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.media.mimeType || "audio/webm" });
        this.release();
        resolve(blob);
      };
      this.media.stop();
    });
  }
  cancel() {
    if (this.media && this.media.state !== "inactive") {
      this.media.onstop = () => this.release();
      this.media.stop();
    }
  }
  release() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.meter?.close();
    this.media = null;
  }
}

export function extension(blob) {
  return blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm";
}

/** Peaks of a WAV URL for a small waveform. */
export async function peaks(url, count = 40) {
  const data = await (await fetch(url)).arrayBuffer();
  const context = new OfflineAudioContext(1, 1, 16000);
  const buffer = await context.decodeAudioData(data);
  const samples = buffer.getChannelData(0);
  const size = Math.max(1, Math.floor(samples.length / count));
  const values = [];
  for (let i = 0; i < count; i++) {
    let max = 0;
    for (let j = i * size; j < (i + 1) * size && j < samples.length; j++) max = Math.max(max, Math.abs(samples[j]));
    values.push(max);
  }
  const top = Math.max(...values, 1e-3);
  return values.map((v) => Math.max(0.08, Math.sqrt(v / top)));
}

// Small markdown: paragraphs, lists, **bold**, *italic*, `code`. Escapes HTML first.

const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const inline = (s) =>
  escape(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>");

export function markdown(text) {
  return text
    .trim()
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split("\n");
      const bullet = /^\s*[-*•]\s+/;
      const number = /^\s*\d+[.)]\s+/;
      if (lines.every((l) => bullet.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(bullet, ""))}</li>`).join("")}</ul>`;
      if (lines.every((l) => number.test(l))) return `<ol>${lines.map((l) => `<li>${inline(l.replace(number, ""))}</li>`).join("")}</ol>`;
      return `<p>${lines.map(inline).join("<br>")}</p>`;
    })
    .join("");
}

export function statsLine(stats) {
  if (!stats) return "";
  const out = [];
  if (stats.first_audio != null) out.push(`first audio ${stats.first_audio.toFixed(2)} s`);
  else if (stats.first_text != null) out.push(`first token ${stats.first_text.toFixed(2)} s`);
  if (stats.speech_seconds) out.push(`${stats.speech_seconds.toFixed(1)} s of speech in ${stats.seconds.toFixed(1)} s`);
  else if (stats.audio_seconds) out.push(`${stats.audio_seconds.toFixed(1)} s of audio in ${stats.seconds.toFixed(2)} s`);
  else if (stats.seconds != null) out.push(`${stats.seconds.toFixed(2)} s`);
  if (stats.realtime_factor) out.push(`${stats.realtime_factor}× real time`);
  if (stats.speed) out.push(`${stats.speed}× real time`);
  if (stats.parts > 1) out.push(`${stats.parts} parts`);
  if (stats.prompt_tokens) out.push(`${stats.prompt_tokens} prompt tokens`);
  return out.join(" · ");
}
