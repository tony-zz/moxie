"use strict";
const $ = id => document.getElementById(id);
const SAMPLE = ["春眠不觉晓", "处处闻啼鸟", "夜来风雨声", "花落知多少", "美丽", "温暖", "游戏", "灿烂"];
const API_URL = "https://api.deepseek.com/chat/completions";
const DEFAULT_MODEL = "deepseek-flash";
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} }
};

// ---------- state ----------
let photos = [];
let mode = store.get("mode") === "rand" ? "rand" : "seq";
let order = [], pos = 0, spoken = [];
let extractCtl = null;

const saved = store.get("list");
$("list").value = saved || SAMPLE.join("\n");
$("listBadge").hidden = !!saved;
$("list").addEventListener("input", () => { $("listBadge").hidden = true; store.set("list", $("list").value); });
for (const id of ["twice", "slow", "voice"]) {
  const v = store.get(id);
  if (v !== null) $(id).checked = v === "1";
  $(id).addEventListener("change", () => store.set(id, $(id).checked ? "1" : "0"));
}

function setMode(m) {
  mode = m; store.set("mode", m);
  $("mSeq").setAttribute("aria-pressed", m === "seq");
  $("mRand").setAttribute("aria-pressed", m === "rand");
}
setMode(mode);
$("mSeq").onclick = () => setMode("seq");
$("mRand").onclick = () => setMode("rand");

// ---------- settings ----------
function apiKey() { return (store.get("apiKey") || "").trim(); }
function model() { return (store.get("model") || "").trim() || DEFAULT_MODEL; }
function refreshBanner() { $("keyBanner").hidden = !!apiKey(); }
function openSettings() {
  $("apiKey").value = apiKey();
  $("model").value = model();
  $("settings").showModal();
}
$("openSettings").onclick = openSettings;
$("bannerSet").onclick = openSettings;
$("settings").addEventListener("close", () => {
  if ($("settings").returnValue !== "save") return;
  store.set("apiKey", $("apiKey").value.trim());
  store.set("model", $("model").value.trim() || DEFAULT_MODEL);
  refreshBanner();
});
refreshBanner();

// ---------- photos ----------
$("file").addEventListener("change", e => {
  for (const f of e.target.files) photos.push({ file: f, url: URL.createObjectURL(f) });
  e.target.value = "";
  renderThumbs();
});
function renderThumbs() {
  const box = $("thumbs"); box.textContent = "";
  photos.forEach((p, i) => {
    const d = document.createElement("div"); d.className = "thumb";
    const img = document.createElement("img"); img.src = p.url; img.alt = "课文照片 " + (i + 1);
    const x = document.createElement("button"); x.type = "button"; x.textContent = "×"; x.setAttribute("aria-label", "删除");
    x.onclick = () => { URL.revokeObjectURL(p.url); photos.splice(i, 1); renderThumbs(); };
    d.append(img, x); box.append(d);
  });
  $("imgHint").textContent = photos.length ? `已选 ${photos.length} 张` : "可以多拍几页";
}

// Phone photos are 10+ MB; shrink to a size that still keeps small print and pen marks legible.
async function toDataUrl(file, maxSide = 2048) {
  const img = await new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im); im.onerror = () => rej(new Error("图片无法读取"));
    im.src = URL.createObjectURL(file);
  });
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  URL.revokeObjectURL(img.src);
  return c.toDataURL("image/jpeg", 0.85);
}

// ---------- scope chips ----------
$("chips").addEventListener("click", e => {
  if (e.target.tagName !== "BUTTON") return;
  const s = $("scope"); s.value = s.value ? s.value + "，" + e.target.textContent : e.target.textContent;
});

// ---------- DeepSeek extraction ----------
function setStatus(t, err) { const s = $("exStatus"); s.textContent = t; s.classList.toggle("err", !!err); }

function buildPrompt(scope) {
  return `这些图片是小学语文课本（或练习册）的照片，家长要给孩子听写/默写。
家长要求的范围：「${scope}」

请按要求从图片中找出需要报给孩子默写的内容：
- 如果提到笔的颜色（如红笔圈、蓝笔画线、黑笔打勾），只取被该颜色笔标记的内容，仔细辨认颜色，印刷的彩色字不算笔迹。
- 如果提到单元、课次、页码，只取那部分。
- 词语一个一项；古诗、课文句子按一小句（逗号或句号断开）一项。
- 按课本中出现的顺序排列。去掉拼音和序号，不要标点，保留原文用字。
- 找不到符合要求的内容时 items 为空，并在 note 里说明看到了什么。

只回复 JSON，不要其他文字：{"items":["词语或句子", ...], "note":"一句话说明识别范围或问题"}`;
}

function parseJson(text) {
  const t = String(text || "").replace(/```(?:json)?/g, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("识别结果格式不对，再试一次。");
  return JSON.parse(t.slice(a, b + 1));
}

$("extract").onclick = async () => {
  if (!apiKey()) { openSettings(); return; }
  if (!photos.length) { setStatus("先拍一张课文照片。", true); return; }
  const scope = $("scope").value.trim() || "课文中需要默写的重点词语和句子";
  extractCtl = new AbortController();
  $("extract").disabled = true; $("stopExtract").hidden = false;
  setStatus("正在处理图片…");
  try {
    const images = [];
    for (const p of photos) images.push(await toDataUrl(p.file));
    setStatus("正在识别，大约需要半分钟…");
    const resp = await fetch(API_URL, {
      method: "POST",
      signal: extractCtl.signal,
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey() },
      body: JSON.stringify({
        model: model(),
        messages: [{
          role: "user",
          content: [
            { type: "text", text: buildPrompt(scope) },
            ...images.map(url => ({ type: "image_url", image_url: { url, detail: "high" } }))
          ]
        }],
        stream: false
      })
    });
    if (!resp.ok) {
      let msg = "";
      try { msg = (await resp.json())?.error?.message || ""; } catch {}
      if (resp.status === 401) throw new Error("API Key 不对，请在设置里检查。");
      if (resp.status === 402) throw new Error("DeepSeek 账户余额不足，请充值。");
      if (resp.status === 429) throw new Error("请求太频繁，稍等一会再试。");
      throw new Error(`识别失败（${resp.status}）${msg ? "：" + msg : ""}`);
    }
    const data = await resp.json();
    const res = parseJson(data?.choices?.[0]?.message?.content);
    const items = Array.isArray(res?.items) ? res.items.map(s => String(s).trim()).filter(Boolean) : [];
    if (!items.length) { setStatus("没有找到符合要求的内容。" + (res?.note ? "（" + res.note + "）" : ""), true); return; }
    $("list").value = items.join("\n"); store.set("list", $("list").value);
    $("listBadge").hidden = true;
    setStatus(`识别出 ${items.length} 项，请核对一下再开始。` + (res?.note ? " " + res.note : ""));
  } catch (e) {
    if (e.name === "AbortError") setStatus("已停止。");
    else if (e instanceof TypeError) setStatus("连不上 DeepSeek，检查一下网络。", true);
    else setStatus(e.message || "识别失败，请重试。", true);
  } finally {
    $("extract").disabled = false;
    $("stopExtract").hidden = true;
  }
};
$("stopExtract").onclick = () => extractCtl?.abort();

// ---------- speech output ----------
const synth = window.speechSynthesis;
let zhVoice = null, speaking = false, speakToken = 0, speakTimer = 0;
function pickVoice() {
  const vs = synth?.getVoices() || [];
  zhVoice = vs.find(v => /zh[-_]CN/i.test(v.lang)) || vs.find(v => /^zh/i.test(v.lang)) || null;
}
if (synth) { pickVoice(); synth.onvoiceschanged = pickVoice; }
else $("ttsStatus").textContent = "这个浏览器不能朗读，请用 Safari 或 Chrome 打开。";

function speak(text) {
  if (!synth) return;
  const my = ++speakToken;
  pauseRec();
  synth.cancel();
  clearTimeout(speakTimer);
  const times = $("twice").checked ? 2 : 1;
  const rate = $("slow").checked ? 0.7 : 0.95;
  speaking = true;
  $("speaking").textContent = "🔊 正在读…";
  const done = () => {
    if (my !== speakToken) return;
    clearTimeout(speakTimer);
    speaking = false; $("speaking").textContent = "";
    resumeRec();
  };
  for (let i = 0; i < times; i++) {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "zh-CN"; if (zhVoice) u.voice = zhVoice;
    u.rate = rate;
    if (i === times - 1) u.onend = u.onerror = done;
    synth.speak(u);
    if (i < times - 1) {
      const gap = new SpeechSynthesisUtterance("。。"); gap.lang = "zh-CN"; gap.volume = 0; gap.rate = 0.5;
      synth.speak(gap);
    }
  }
  // iOS sometimes never fires onend; don't let the mic stay paused forever.
  speakTimer = setTimeout(done, (text.length * 0.45 / rate * times + 3) * 1000);
}

// ---------- speech input (voice commands) ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, recFor = null, recWanted = false, recPaused = false;
if (SR) { $("voiceWrap").hidden = false; $("micScope").hidden = false; }

function startRec(target) {
  if (!SR) return;
  recFor = target; recWanted = true; recPaused = false;
  runRec();
}
function runRec() {
  if (rec || !recWanted || recPaused) return;
  try {
    rec = new SR(); rec.lang = "zh-CN"; rec.continuous = true; rec.interimResults = false;
    rec.onresult = ev => {
      const r = ev.results[ev.results.length - 1];
      if (r.isFinal !== false) onVoice(r[0].transcript.replace(/[，。！？,.!?\s]/g, ""));
    };
    rec.onerror = ev => {
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") { recWanted = false; voiceBlocked(); }
    };
    rec.onend = () => { rec = null; if (recWanted && !recPaused) setTimeout(runRec, 250); else showListen(); };
    rec.start();
    showListen();
  } catch { rec = null; }
}
function stopRec() { recWanted = false; try { rec?.stop(); } catch {} rec = null; showListen(); $("micScope").classList.remove("on"); }
function pauseRec() { recPaused = true; try { rec?.abort(); } catch {} rec = null; showListen(); }
function resumeRec() { if (!recWanted) return; recPaused = false; setTimeout(runRec, 200); }
function showListen() {
  const on = recWanted && !recPaused && recFor === "play";
  $("listen").textContent = on ? "🎤 在听：说“好了”报下一个，说“再读一遍”重读" : "";
}
function voiceBlocked() {
  $("listen").textContent = "语音识别不可用，点按钮就行。";
  $("micScope").hidden = true; $("micScope").classList.remove("on");
}
function onVoice(t) {
  if (!t) return;
  if (recFor === "scope") { $("scope").value = t; stopRec(); return; }
  if (recFor === "play" && !speaking) {
    if (/再|重|没听清|重复/.test(t)) again();
    else if (/好了|好的|写好|写完|下一个|^好$|ok/i.test(t)) next();
    else if (/结束|不写了/.test(t)) finish();
  }
}
$("micScope").onclick = () => {
  if (recWanted && recFor === "scope") { stopRec(); return; }
  stopRec(); startRec("scope"); $("micScope").classList.add("on");
};

// ---------- dictation flow ----------
function items() { return $("list").value.split("\n").map(s => s.trim()).filter(Boolean); }
let wakeLock = null;
function start() {
  const list = items();
  if (!list.length) { $("ttsStatus").textContent = "清单是空的，先识别或输入要默写的内容。"; return; }
  order = list.map((_, i) => i);
  if (mode === "rand") for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  pos = 0; spoken = [];
  $("setup").hidden = true; $("finish").hidden = true; $("play").hidden = false;
  try { navigator.wakeLock?.request("screen").then(l => wakeLock = l).catch(() => {}); } catch {}
  stopRec();
  // Mic stays paused until the first item has been read aloud (speak → done → resumeRec).
  if (SR && $("voice").checked) { recFor = "play"; recWanted = true; recPaused = true; }
  show();
}
function show() {
  const text = items()[order[pos]];
  spoken[pos] = text;
  $("count").textContent = `第 ${pos + 1} 个 / 共 ${order.length} 个 · ${mode === "rand" ? "随机" : "顺序"}`;
  $("bigNum").textContent = pos + 1;
  $("peek").textContent = "";
  $("peekBtn").textContent = "偷看答案";
  $("ok").textContent = pos === order.length - 1 ? "好了，完成" : "好了";
  speak(text);
}
function next() { if ($("play").hidden) return; if (pos >= order.length - 1) finish(); else { pos++; show(); } }
function again() { if (!$("play").hidden) speak(spoken[pos]); }
function finish() {
  stopRec(); synth?.cancel(); speaking = false; clearTimeout(speakTimer);
  try { wakeLock?.release(); } catch {} wakeLock = null;
  $("play").hidden = true; $("finish").hidden = false;
  const done = spoken.filter(Boolean);
  $("finishSub").textContent = `共报了 ${done.length} 个，对照下面的答案检查吧。`;
  const ol = $("doneList"); ol.textContent = "";
  done.forEach(t => { const li = document.createElement("li"); li.textContent = t; ol.append(li); });
  window.scrollTo(0, 0);
}
$("start").onclick = start;
$("ok").onclick = next;
$("again").onclick = again;
$("quit").onclick = finish;
$("peekBtn").onclick = () => {
  const showing = !!$("peek").textContent;
  $("peek").textContent = showing ? "" : spoken[pos];
  $("peekBtn").textContent = showing ? "偷看答案" : "藏起来";
};
$("restart").onclick = start;
$("back").onclick = () => { $("finish").hidden = true; $("setup").hidden = false; };
document.addEventListener("keydown", e => {
  if ($("play").hidden || /TEXTAREA|INPUT/.test(e.target.tagName)) return;
  if (e.code === "Space" || e.key === "Enter") { e.preventDefault(); next(); }
  else if (e.key === "r" || e.key === "R") again();
});

// ---------- offline ----------
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
