import {
  $, h, icon, clock, toast, upload, post, run, TextParts, StreamPlayer, Recorder,
  extension, peaks, markdown, statsLine,
} from "./lib.js";

const player = new StreamPlayer();
const recorder = new Recorder();
const clip = new Audio(); // replays of finished answers and voice messages
let clipOwner = null;
let recordingFor = null; // "talk" | "look" | "transcribe"
const running = new Set(); // panels with a request in flight

const saved = JSON.parse(localStorage.getItem("lfm3") || "{}");
const remember = (key, value) => {
  saved[key] = value;
  localStorage.setItem("lfm3", JSON.stringify(saved));
};

// Tabs

const TABS = ["talk", "look", "transcribe", "speak"];
let tab = "talk";

function show(name) {
  tab = TABS.includes(name) ? name : "talk";
  for (const button of document.querySelectorAll("[data-tab]")) {
    button.setAttribute("aria-selected", String(button.dataset.tab === tab));
  }
  for (const id of TABS) $(`#${id}`).hidden = id !== tab;
  if (location.hash !== `#${tab}`) history.replaceState(null, "", `#${tab}`);
}
for (const button of document.querySelectorAll("[data-tab]")) {
  button.addEventListener("click", () => show(button.dataset.tab));
}
addEventListener("hashchange", () => show(location.hash.slice(1)));
show(location.hash.slice(1));

const editable = (el) => el?.closest?.("input, textarea, select, [contenteditable]");

// Model status

const statusEl = $("#status");
let model = { state: "loading" };

function paintStatus() {
  const text = $(".status-text", statusEl);
  if (model.state === "error") {
    statusEl.dataset.state = "error";
    text.textContent = "Model failed to load";
    statusEl.title = model.error || "";
  } else if (model.state !== "ready") {
    statusEl.dataset.state = "loading";
    text.textContent = "Loading model…";
  } else if (running.size) {
    statusEl.dataset.state = "busy";
    text.textContent = "Generating…";
  } else {
    statusEl.dataset.state = "ready";
    const chip = (model.chip || "").replace(/^Apple /, "");
    text.textContent = ["Ready", model.memory_gb && `${model.memory_gb} GB`, chip].filter(Boolean).join(" · ");
    statusEl.title = `${model.model}\nMLX ${model.mlx} · loaded in ${model.load_seconds} s`;
  }
}

async function poll() {
  try {
    const response = await fetch("/api/status");
    const first = !model.speech_locales;
    model = await response.json();
    if (first) fillLanguages();
  } catch {
    model = { state: "loading" };
  }
  paintStatus();
  setTimeout(poll, model.state === "ready" ? 15000 : 1500);
}
poll();

function busy(panel, on) {
  if (on) running.add(panel);
  else running.delete(panel);
  paintStatus();
}

// Sound

function stopSound() {
  player.stop();
  if (!clip.paused) clip.pause();
}

function playClip(url, owner) {
  if (clipOwner === owner && !clip.paused) {
    clip.pause();
    return;
  }
  stopSound();
  clipOwner?.onStop?.();
  clipOwner = owner;
  clip.src = url;
  clip.play().catch(() => {});
  owner.onPlay?.();
}
clip.addEventListener("timeupdate", () => clipOwner?.onProgress?.(clip.currentTime / (clip.duration || 1)));
// a pause queued by switching clips arrives after the next clip started; ignore it
clip.addEventListener("pause", () => clip.paused && clipOwner?.onStop?.());
clip.addEventListener("ended", () => {
  clipOwner?.onProgress?.(0);
  clipOwner?.onStop?.();
});

player.addEventListener("change", () => {
  for (const el of document.querySelectorAll("[data-speaking]")) {
    if (el !== player.owner || !player.playing) delete el.dataset.speaking;
  }
  if (player.owner instanceof Element && player.playing) player.owner.dataset.speaking = "";
  updateTalkAction();
  updateLookAction();
  updateSpeak();
});

// Messages

function voiceWidget(media) {
  const play = h("button", { class: "play", type: "button", "aria-label": "Play voice message" }, icon("play"));
  const wave = h("span", { class: "wave", "aria-hidden": "true" });
  const el = h("div", { class: "voice" }, play, wave, h("span", { class: "time" }, clock(media?.duration)));
  const bars = [];
  const paint = (values) => {
    wave.replaceChildren(...values.map((v) => {
      const bar = h("i");
      bar.style.blockSize = `${Math.round(v * 100)}%`;
      bars.push(bar);
      return bar;
    }));
  };
  paint(Array.from({ length: 40 }, () => 0.12));
  bars.length = 40;
  const owner = {
    onPlay: () => play.replaceChildren(icon("pause")),
    onStop: () => play.replaceChildren(icon("play")),
    onProgress: (p) => bars.forEach((bar, i) => bar.classList.toggle("on", i / bars.length < p)),
  };
  const set = (m) => {
    media = m;
    el.querySelector(".time").textContent = clock(m.duration);
    peaks(m.url).then((values) => {
      bars.length = 0;
      paint(values);
    }).catch(() => {});
  };
  play.addEventListener("click", () => media?.url && playClip(media.url, owner));
  if (media?.url) set(media);
  return { el, set };
}

function userMessage({ text, imageUrl, voice }) {
  const bubble = h("div", { class: "bubble" });
  if (imageUrl) bubble.append(h("img", { src: imageUrl, alt: "Attached image" }));
  let widget = null;
  if (voice) {
    widget = voiceWidget(null);
    bubble.append(widget.el);
  }
  if (text) bubble.append(h("span", {}, text));
  return { el: h("div", { class: "msg user" }, bubble), setVoice: (media) => widget?.set(media) };
}

function assistantMessage() {
  const body = h("div", { class: "reply", "data-pending": "" });
  const foot = h("div", { class: "msg-foot" });
  const bars = h("span", { class: "bars", "aria-hidden": "true" }, h("i"), h("i"), h("i"), h("i"));
  const el = h("div", { class: "msg assistant" },
    h("div", { class: "who" }, h("span", { class: "mark", "aria-hidden": "true" }), "LFM3", bars),
    body, foot);
  let text = "";
  const paint = (extra = "") => (body.innerHTML = markdown(text) + extra);
  return {
    el,
    setText(value) {
      text = value;
      paint();
    },
    note(message) {
      if (!text) body.innerHTML = `<p class="note">${message}</p>`;
    },
    error(message) {
      delete body.dataset.pending;
      paint(`<p class="error">${message.replace(/</g, "&lt;")}</p>`);
    },
    stopped() {
      delete body.dataset.pending;
      if (!text) body.innerHTML = '<p class="note">Stopped.</p>';
    },
    done(event) {
      delete body.dataset.pending;
      if (event.text) text = event.text;
      paint(event.cancelled ? ' <span class="note">(stopped)</span>' : "");
      if (!text && !event.audio_url) body.innerHTML = '<p class="note">No answer.</p>';
      foot.replaceChildren();
      if (event.audio_url) {
        const replay = h("button", { class: "icon-button small", type: "button", "aria-label": "Play answer" }, icon("play"));
        const owner = {
          onPlay: () => {
            replay.replaceChildren(icon("pause"));
            el.dataset.speaking = "";
          },
          onStop: () => {
            replay.replaceChildren(icon("play"));
            delete el.dataset.speaking;
          },
        };
        replay.addEventListener("click", () => playClip(event.audio_url, owner));
        foot.append(
          replay,
          h("a", { class: "icon-button small", href: event.audio_url, download: "lfm3-answer.wav", "aria-label": "Download answer" }, icon("download")),
        );
      }
      foot.append(h("span", { class: "stats" }, statsLine(event.stats)));
    },
  };
}

function nearBottom(scroller) {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
}

// Recording shared by Talk, Look and Transcribe

async function startRecording(panel, { onLevel } = {}) {
  if (recorder.active) return false;
  player.unlock();
  try {
    recordingFor = panel;
    await recorder.start((level, seconds) => {
      onLevel?.(level, seconds);
    });
    return true;
  } catch (error) {
    recordingFor = null;
    toast(error.name === "NotAllowedError" ? "Microphone access was denied." : `Microphone: ${error.message}`);
    return false;
  }
}

async function finishRecording() {
  const seconds = recorder.seconds;
  const blob = await recorder.stop();
  recordingFor = null;
  if (!blob) return null;
  if (seconds < 0.4) {
    toast("Too short. Hold the button or Space while you speak.");
    return null;
  }
  return blob;
}

function cancelRecording() {
  recorder.cancel();
  recordingFor = null;
}

// Talk

const talk = { cid: null, controller: null, image: null };
const chat = $("#chat");
const chatInner = $("#chat-inner");
const talkText = $("#talk-text");
const talkAction = $("#talk-action");
const talkSpeak = $("#talk-speak");
talkSpeak.checked = saved.talkSpeak ?? true;
talkSpeak.addEventListener("change", () => remember("talkSpeak", talkSpeak.checked));

function talkBusy() {
  return Boolean(talk.controller) || (player.playing && chatInner.contains(player.owner));
}

function setAction(button, mode) {
  button.dataset.mode = mode;
  const name = { mic: "mic", send: "send", recording: "send", busy: "stop" }[mode];
  button.querySelector("svg").replaceWith(icon(name));
  button.setAttribute("aria-label", { mic: "Start talking", send: "Send", recording: "Send recording", busy: "Stop" }[mode]);
}

function updateTalkAction() {
  const recording = recordingFor === "talk";
  $("#talk-recording").hidden = !recording;
  talkText.hidden = recording;
  // typed text always sends (and interrupts); an empty box stops a running answer
  const mode = recording ? "recording" : talkText.value.trim() || talk.image ? "send" : talkBusy() ? "busy" : "mic";
  setAction(talkAction, mode);
}

function interruptTalk() {
  talk.controller?.abort();
  if (chatInner.contains(player.owner)) player.stop();
  if (clipOwner && !clip.paused) clip.pause();
}

async function talkRecord() {
  interruptTalk();
  const started = await startRecording("talk", {
    onLevel: (level, seconds) => {
      talkAction.style.setProperty("--level", level.toFixed(3));
      $("#talk-recording .rec-time").textContent = clock(seconds);
    },
  });
  updateTalkAction();
  return started;
}

async function talkFinish() {
  const blob = await finishRecording();
  talkAction.style.setProperty("--level", 0);
  updateTalkAction();
  if (blob) sendTalk({ blob });
}

async function sendTalk({ text = "", blob = null }) {
  player.unlock();
  interruptTalk();
  const image = talk.image;
  setTalkImage(null);
  $("#talk-empty")?.remove();
  const user = userMessage({ text, imageUrl: image?.url, voice: Boolean(blob) });
  const reply = assistantMessage();
  chatInner.append(user.el, reply.el);
  chat.scrollTop = chat.scrollHeight;
  const controller = new AbortController();
  talk.controller = controller;
  busy("talk", true);
  updateTalkAction();
  try {
    let voice = null;
    if (blob) {
      voice = await upload(blob, `voice.${extension(blob)}`);
      user.setVoice(voice);
    }
    player.begin(reply.el);
    const parts = new TextParts();
    await run("/api/talk", {
      conversation_id: talk.cid,
      text,
      audio_id: voice?.id,
      image_id: image?.id,
      speak: talkSpeak.checked,
    }, (event) => {
      const stick = nearBottom(chat);
      if (event.type === "start") talk.cid = event.conversation_id;
      else if (event.type === "queued") reply.note(event.loading ? "Waiting for the model to load…" : "Waiting for another job…");
      else if (event.type === "audio") player.push(event.pcm);
      else if (event.type === "done") reply.done(event);
      else if (parts.add(event)) reply.setText(parts.text);
      if (stick) chat.scrollTop = chat.scrollHeight;
    }, controller.signal);
  } catch (error) {
    if (error.name === "AbortError") reply.stopped();
    else reply.error(error.message);
  } finally {
    player.finish();
    if (talk.controller === controller) talk.controller = null;
    busy("talk", false);
    updateTalkAction();
  }
}

$("#talk-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const mode = talkAction.dataset.mode;
  if (mode === "recording") return talkFinish();
  if (mode === "busy") return interruptTalk();
  const text = talkText.value.trim();
  if (text || talk.image) {
    talkText.value = "";
    return sendTalk({ text });
  }
  talkRecord();
});

talkText.addEventListener("input", updateTalkAction);
talkText.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (talkText.value.trim() || talk.image) $("#talk-form").requestSubmit();
  }
});
$("#talk-rec-cancel").addEventListener("click", () => {
  cancelRecording();
  updateTalkAction();
});

const talkEmpty = $("#talk-empty").cloneNode(true);
chatInner.addEventListener("click", (event) => {
  const chip = event.target.closest("#talk-suggestions .chip");
  if (chip) sendTalk({ text: chip.textContent });
});

$("#talk-new").addEventListener("click", () => {
  interruptTalk();
  if (recordingFor === "talk") cancelRecording();
  if (talk.cid) post("/api/talk/reset", { conversation_id: talk.cid }).catch(() => {});
  talk.cid = null;
  setTalkImage(null);
  chatInner.replaceChildren(talkEmpty.cloneNode(true));
  talkText.value = "";
  updateTalkAction();
});

// Talk image attachment: button, paste or drop

function setTalkImage(media) {
  talk.image = media;
  const box = $("#talk-attachment");
  box.hidden = !media;
  if (media) $("img", box).src = media.url;
  updateTalkAction();
}

async function attachTalkImage(file) {
  if (!file?.type.startsWith("image/")) return toast("Talk takes images. Use Look for videos.");
  try {
    setTalkImage(await upload(file, file.name));
    talkText.focus();
  } catch (error) {
    toast(error.message);
  }
}

$("#talk-attach").addEventListener("click", () => $("#talk-file").click());
$("#talk-file").addEventListener("change", (event) => {
  attachTalkImage(event.target.files[0]);
  event.target.value = "";
});
$("#talk-attachment-remove").addEventListener("click", () => setTalkImage(null));
talkText.addEventListener("paste", (event) => {
  const file = [...event.clipboardData.files].find((f) => f.type.startsWith("image/"));
  if (file) {
    event.preventDefault();
    attachTalkImage(file);
  }
});
$("#talk").addEventListener("dragover", (event) => event.preventDefault());
$("#talk").addEventListener("drop", (event) => {
  event.preventDefault();
  attachTalkImage(event.dataTransfer.files[0]);
});

// Keyboard: hold Space to talk, Esc to stop, 1-4 for tabs

let spaceHeld = false;
addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (recordingFor === "talk" || recordingFor === "look") {
      cancelRecording();
      updateTalkAction();
      updateLookAction();
    } else {
      interruptTalk();
      interruptLook();
      stopSound();
    }
    return;
  }
  if (editable(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
  if (/^[1-4]$/.test(event.key)) return show(TABS[Number(event.key) - 1]);
  if (event.code === "Space" && tab === "talk" && !event.repeat) {
    event.preventDefault();
    if (recordingFor === "talk") return;
    spaceHeld = true;
    talkRecord();
  }
});
addEventListener("keyup", (event) => {
  if (event.code === "Space" && spaceHeld) {
    spaceHeld = false;
    if (recordingFor === "talk") talkFinish();
  }
});
addEventListener("blur", () => {
  if (spaceHeld && recordingFor === "talk") {
    spaceHeld = false;
    talkFinish();
  }
});

// Look

const look = { media: null, controller: null, camera: null };
const lookThread = $("#look-thread");
const lookText = $("#look-text");
const lookAction = $("#look-action");
const lookSpeak = $("#look-speak");
const lookListen = $("#look-listen");
lookSpeak.checked = saved.lookSpeak ?? false;
lookSpeak.addEventListener("change", () => remember("lookSpeak", lookSpeak.checked));

const SUGGESTIONS = {
  image: ["Describe this.", "Read all the text.", "What stands out here?", "Is anything unusual?"],
  video: ["What happens in this video?", "What can you hear?", "Describe it step by step.", "What is the mood?"],
};

function lookBusy() {
  return Boolean(look.controller) || (player.playing && lookThread.contains(player.owner));
}

function updateLookAction() {
  const recording = recordingFor === "look";
  $("#look-recording").hidden = !recording;
  lookText.hidden = recording;
  const mode = recording ? "recording" : lookText.value.trim() ? "send" : lookBusy() ? "busy" : "mic";
  setAction(lookAction, mode);
}

function interruptLook() {
  look.controller?.abort();
  if (lookThread.contains(player.owner)) player.stop();
}

function setLookMedia(media) {
  look.media = media;
  stopCamera();
  const viewer = $("#look-viewer");
  viewer.replaceChildren(
    media.kind === "image"
      ? h("img", { src: media.url, alt: media.name })
      : h("video", { src: media.url, controls: true, playsinline: true, preload: "metadata" }),
  );
  viewer.hidden = false;
  $("#look-drop").hidden = true;
  $("#look-bar").hidden = false;
  const details = media.kind === "image"
    ? ["Photo", `${media.width}×${media.height}`]
    : ["Video", clock(media.duration), media.has_soundtrack ? "with sound" : "no sound", media.trimmed && "trimmed to 60 s"];
  $("#look-meta").textContent = [media.name, ...details].filter(Boolean).join(" · ");
  $("#look-listen-wrap").hidden = !media.has_soundtrack;
  const suggestions = SUGGESTIONS[media.kind].filter((text) => media.has_soundtrack || !/hear/.test(text));
  $("#look-suggestions").replaceChildren(...suggestions.map((text) =>
    h("button", { class: "chip", type: "button", onclick: () => askLook({ text }) }, text)));
  lookThread.replaceChildren();
  lookText.focus();
}

function resetLookMedia() {
  look.media = null;
  $("#look-viewer").hidden = true;
  $("#look-viewer").replaceChildren();
  $("#look-bar").hidden = true;
  $("#look-drop").hidden = false;
  $("#look-suggestions").replaceChildren();
}

async function loadLookFile(file) {
  if (!file) return;
  if (!/^(image|video)\//.test(file.type) && file.type) return toast("Look takes a photo or a video.");
  const drop = $("#look-drop");
  const label = $("strong", drop).textContent;
  $("strong", drop).textContent = "Preparing…";
  try {
    const media = await upload(file, file.name);
    if (media.kind === "audio") return toast("That is audio only. Use Transcribe or Talk.");
    setLookMedia(media);
  } catch (error) {
    toast(error.message);
  } finally {
    $("strong", drop).textContent = label;
  }
}

$("#look-choose").addEventListener("click", () => $("#look-file").click());
$("#look-replace").addEventListener("click", () => {
  interruptLook();
  resetLookMedia();
});
$("#look-file").addEventListener("change", (event) => {
  loadLookFile(event.target.files[0]);
  event.target.value = "";
});
const stage = $("#look-stage");
stage.addEventListener("dragover", (event) => {
  event.preventDefault();
  $("#look-drop").dataset.over = "";
});
stage.addEventListener("dragleave", () => delete $("#look-drop").dataset.over);
stage.addEventListener("drop", (event) => {
  event.preventDefault();
  delete $("#look-drop").dataset.over;
  interruptLook();
  loadLookFile(event.dataTransfer.files[0]);
});

async function startCamera() {
  try {
    look.camera = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } });
  } catch (error) {
    return toast(error.name === "NotAllowedError" ? "Camera access was denied." : `Camera: ${error.message}`);
  }
  $("#look-drop").hidden = true;
  $("#look-cam").hidden = false;
  $("#look-cam video").srcObject = look.camera;
}

function stopCamera() {
  look.camera?.getTracks().forEach((t) => t.stop());
  look.camera = null;
  $("#look-cam").hidden = true;
}

$("#look-camera").addEventListener("click", startCamera);
$("#look-cam-cancel").addEventListener("click", () => {
  stopCamera();
  $("#look-drop").hidden = false;
});
$("#look-capture").addEventListener("click", () => {
  const video = $("#look-cam video");
  const canvas = h("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0);
  canvas.toBlob((blob) => {
    stopCamera();
    loadLookFile(new File([blob], "camera.png", { type: "image/png" }));
  }, "image/png");
});

async function lookRecord() {
  interruptLook();
  await startRecording("look", {
    onLevel: (level, seconds) => {
      lookAction.style.setProperty("--level", level.toFixed(3));
      $("#look-recording .rec-time").textContent = clock(seconds);
    },
  });
  updateLookAction();
}

async function askLook({ text = "", blob = null }) {
  if (!look.media) return toast("Add a photo or a video first.");
  player.unlock();
  interruptLook();
  $("#look-empty")?.remove();
  const user = userMessage({ text, voice: Boolean(blob) });
  const reply = assistantMessage();
  lookThread.append(user.el, reply.el);
  lookThread.scrollTop = lookThread.scrollHeight;
  const controller = new AbortController();
  look.controller = controller;
  busy("look", true);
  updateLookAction();
  try {
    let voice = null;
    if (blob) {
      voice = await upload(blob, `question.${extension(blob)}`);
      user.setVoice(voice);
    }
    if (lookSpeak.checked) player.begin(reply.el);
    const parts = new TextParts();
    await run("/api/look", {
      media_id: look.media.id,
      question: text,
      question_audio_id: voice?.id,
      speak: lookSpeak.checked,
      listen: lookListen.checked,
    }, (event) => {
      const stick = nearBottom(lookThread);
      if (event.type === "queued") reply.note(event.loading ? "Waiting for the model to load…" : "Waiting for another job…");
      else if (event.type === "audio") player.push(event.pcm);
      else if (event.type === "done") reply.done(event);
      else if (parts.add(event)) reply.setText(parts.text);
      if (stick) lookThread.scrollTop = lookThread.scrollHeight;
    }, controller.signal);
  } catch (error) {
    if (error.name === "AbortError") reply.stopped();
    else reply.error(error.message);
  } finally {
    player.finish();
    if (look.controller === controller) look.controller = null;
    busy("look", false);
    updateLookAction();
  }
}

$("#look-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const mode = lookAction.dataset.mode;
  if (mode === "recording") {
    const blob = await finishRecording();
    lookAction.style.setProperty("--level", 0);
    updateLookAction();
    if (blob) askLook({ blob });
    return;
  }
  if (mode === "busy") return interruptLook();
  const text = lookText.value.trim();
  if (text) {
    lookText.value = "";
    updateLookAction();
    return askLook({ text });
  }
  if (!look.media) return toast("Add a photo or a video first.");
  lookRecord();
});
lookText.addEventListener("input", updateLookAction);
lookText.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (lookText.value.trim()) $("#look-form").requestSubmit();
  }
});
$("#look-rec-cancel").addEventListener("click", () => {
  cancelRecording();
  updateLookAction();
});

// Transcribe

const tr = { media: null, controller: null, text: "" };

function fillLanguages() {
  const fill = (select, values, value) => {
    select.replaceChildren(...values.map((v) => h("option", { value: v }, v)));
    select.value = values.includes(value) ? value : values[0];
  };
  fill($("#tr-language"), model.asr_languages, saved.trLanguage ?? "English");
  fill($("#tr-target"), model.text_languages, saved.trTarget ?? "Polish");
  fill($("#sp-locale"), model.speech_locales, saved.spLocale ?? "American English");
}
$("#tr-language").addEventListener("change", (e) => remember("trLanguage", e.target.value));
$("#tr-target").addEventListener("change", (e) => remember("trTarget", e.target.value));
for (const radio of document.querySelectorAll('[name="tr-task"]')) {
  radio.addEventListener("change", () => {
    const translate = document.querySelector('[name="tr-task"]:checked').value === "translate";
    $("#tr-target-field").hidden = !translate;
    $("#tr-run").textContent = translate ? "Translate" : "Transcribe";
  });
}

function setTranscribeMedia(media) {
  tr.media = media;
  $("#tr-drop").hidden = Boolean(media);
  $("#tr-recorder").hidden = true;
  $("#tr-loaded").hidden = !media;
  $("#tr-run").disabled = !media;
  if (!media) return;
  const kind = media.kind === "video" ? "video soundtrack" : "audio";
  $("#tr-meta").textContent = [media.name, kind, clock(media.duration), media.trimmed && "trimmed to 30 min"].filter(Boolean).join(" · ");
  $("#tr-audio").src = media.kind === "video" ? media.soundtrack_url : media.url;
}

async function loadTranscribeFile(file) {
  if (!file) return;
  const drop = $("#tr-drop strong");
  const label = drop.textContent;
  drop.textContent = "Preparing…";
  try {
    const media = await upload(file, file.name, "transcribe");
    if (media.kind === "image") return toast("That is an image. Use Look.");
    if (media.kind === "video" && !media.has_soundtrack) return toast("This video has no sound.");
    setTranscribeMedia(media);
  } catch (error) {
    toast(error.message);
  } finally {
    drop.textContent = label;
  }
}

$("#tr-choose").addEventListener("click", () => $("#tr-file").click());
$("#tr-file").addEventListener("change", (event) => {
  loadTranscribeFile(event.target.files[0]);
  event.target.value = "";
});
$("#tr-replace").addEventListener("click", () => setTranscribeMedia(null));
const source = $("#tr-source");
source.addEventListener("dragover", (event) => {
  event.preventDefault();
  $("#tr-drop").dataset.over = "";
});
source.addEventListener("dragleave", () => delete $("#tr-drop").dataset.over);
source.addEventListener("drop", (event) => {
  event.preventDefault();
  delete $("#tr-drop").dataset.over;
  loadTranscribeFile(event.dataTransfer.files[0]);
});

$("#tr-record").addEventListener("click", async () => {
  const started = await startRecording("transcribe", {
    onLevel: (level, seconds) => {
      $("#tr-recorder .meter").style.setProperty("--level", level.toFixed(3));
      $("#tr-recorder .rec-time").textContent = clock(seconds);
    },
  });
  if (!started) return;
  $("#tr-drop").hidden = true;
  $("#tr-recorder").hidden = false;
});
$("#tr-stop").addEventListener("click", async () => {
  const blob = await finishRecording();
  $("#tr-recorder").hidden = true;
  if (!blob) return setTranscribeMedia(null);
  await loadTranscribeFile(new File([blob], `recording.${extension(blob)}`, { type: blob.type }));
  if (!tr.media) setTranscribeMedia(null);
});

$("#tr-run").addEventListener("click", async () => {
  if (tr.controller) return tr.controller.abort();
  if (!tr.media) return;
  const out = $("#tr-text");
  const button = $("#tr-run");
  const label = button.textContent;
  $("#tr-output").hidden = false;
  out.textContent = "";
  out.dataset.pending = "";
  $("#tr-stats").textContent = "";
  $("#tr-progress").textContent = "Listening…";
  const task = document.querySelector('[name="tr-task"]:checked').value;
  const controller = new AbortController();
  tr.controller = controller;
  button.textContent = "Stop";
  busy("transcribe", true);
  const parts = new TextParts();
  try {
    await run("/api/transcribe", {
      audio_id: tr.media.id,
      language: $("#tr-language").value,
      task,
      target: $("#tr-target").value,
    }, (event) => {
      if (event.type === "queued") $("#tr-progress").textContent = event.loading ? "Waiting for the model to load…" : "Waiting for another job…";
      if (event.type === "part" && event.parts > 1) $("#tr-progress").textContent = `Part ${event.index + 1} of ${event.parts}`;
      if (event.type === "start" && event.parts === 1) $("#tr-progress").textContent = "Listening…";
      if (parts.add(event)) out.textContent = parts.text;
      if (event.type === "done") {
        tr.text = event.text;
        out.textContent = event.text || "(no speech found)";
        $("#tr-progress").textContent = event.cancelled ? "Stopped" : task === "translate" ? "Translation" : "Transcript";
        $("#tr-stats").textContent = statsLine(event.stats);
      }
    }, controller.signal);
  } catch (error) {
    $("#tr-progress").textContent = error.name === "AbortError" ? "Stopped" : "Failed";
    if (error.name !== "AbortError") toast(error.message);
    tr.text = parts.text;
  } finally {
    delete out.dataset.pending;
    tr.controller = null;
    button.textContent = label;
    busy("transcribe", false);
  }
});

$("#tr-copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("#tr-text").textContent);
  toast("Copied.");
});
$("#tr-download").addEventListener("click", () => {
  const blob = new Blob([$("#tr-text").textContent], { type: "text/plain" });
  const link = h("a", { href: URL.createObjectURL(blob), download: "transcript.txt" });
  link.click();
  URL.revokeObjectURL(link.href);
});

// Speak

const sp = { controller: null };
const spText = $("#sp-text");
const spOutput = $("#sp-output");
$("#sp-locale").addEventListener("change", (e) => remember("spLocale", e.target.value));
const voiceRadio = document.querySelector(`[name="sp-voice"][value="${saved.spVoice ?? "female"}"]`);
if (voiceRadio) voiceRadio.checked = true;
for (const radio of document.querySelectorAll('[name="sp-voice"]')) {
  radio.addEventListener("change", () => remember("spVoice", radio.value));
}

const countText = () => ($("#sp-count").textContent = `${spText.value.length} / 5000`);
spText.addEventListener("input", countText);
countText();

for (const chip of document.querySelectorAll("#sp-samples .chip")) {
  chip.addEventListener("click", () => {
    spText.value = chip.dataset.text;
    $("#sp-locale").value = chip.dataset.locale;
    remember("spLocale", chip.dataset.locale);
    countText();
  });
}

function updateSpeak() {
  const live = player.owner === spOutput && (player.playing || player.open);
  const button = $("#sp-run");
  const active = Boolean(sp.controller) || live;
  button.replaceChildren(icon(active ? "stop" : "play"), active ? "Stop" : "Speak");
  $("#sp-live").hidden = !live;
}

$("#sp-run").addEventListener("click", async () => {
  if (sp.controller || (player.owner === spOutput && player.playing)) {
    sp.controller?.abort();
    player.stop();
    return;
  }
  const text = spText.value.trim();
  if (!text) return toast("Type something to say.");
  player.unlock();
  stopSound();
  spOutput.hidden = false;
  $("#sp-audio").hidden = true;
  $("#sp-download").hidden = true;
  $("#sp-stats").textContent = "";
  $("#sp-progress").textContent = "Starting…";
  $("#sp-live-text").textContent = "Speaking…";
  const controller = new AbortController();
  sp.controller = controller;
  player.begin(spOutput);
  busy("speak", true);
  updateSpeak();
  try {
    await run("/api/speak", {
      text,
      locale: $("#sp-locale").value,
      voice: document.querySelector('[name="sp-voice"]:checked').value,
    }, (event) => {
      if (event.type === "queued") $("#sp-progress").textContent = event.loading ? "Waiting for the model to load…" : "Waiting for another job…";
      if (event.type === "part") {
        $("#sp-progress").textContent = event.parts > 1 ? `Part ${event.index + 1} of ${event.parts}` : "Speaking";
      }
      if (event.type === "audio") player.push(event.pcm);
      if (event.type === "done") {
        $("#sp-progress").textContent = event.cancelled ? "Stopped" : "Generated";
        if (event.audio_url) {
          $("#sp-audio").src = event.audio_url;
          $("#sp-audio").hidden = false;
          $("#sp-download").href = event.audio_url;
          $("#sp-download").hidden = false;
        }
        $("#sp-stats").textContent = statsLine(event.stats);
      }
    }, controller.signal);
  } catch (error) {
    $("#sp-progress").textContent = error.name === "AbortError" ? "Stopped" : "Failed";
    if (error.name !== "AbortError") toast(error.message);
  } finally {
    player.finish();
    sp.controller = null;
    busy("speak", false);
    updateSpeak();
  }
});
$("#sp-audio").addEventListener("play", () => player.stop());

updateTalkAction();
updateLookAction();
updateSpeak();
