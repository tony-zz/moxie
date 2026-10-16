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
  return `这些图片是小学课本（或练习册、词汇表）的照片，可能是语文，也可能是英语，家长要给孩子听写/默写。
家长要求的范围：「${scope}」

请按要求从图片中找出需要报给孩子默写的内容：
- 如果提到笔的颜色（如红笔圈、蓝笔画线、黑笔打勾），只取被该颜色笔标记的内容，仔细辨认颜色，印刷的彩色字不算笔迹。
- 如果提到单元、课次、页码，只取那部分；没提到就取图中全部。
- 语文：词语一个一项；古诗、课文句子按一小句（逗号或句号断开）一项。去掉拼音和序号，不要标点，保留原文用字。
- 英语：家长读中文，孩子写英文。每个英文词条（单词、短语、句子）一项，写成「英文|中文」，如 "do exercise|锻炼"、"It's your turn|轮到你了"。英文去掉页码、星号*和句末标点，保留撇号；中文照抄书上的释义，去掉括号里的补充说明；书上没有中文的，自己给一个简短释义。带*的词条也要取，除非家长说只要核心词。
- 分两栏排版的，先读完左栏再读右栏，按课本中出现的顺序排列。
- 找不到符合要求的内容时 items 为空，并在 note 里说明看到了什么。

只回复 JSON，不要其他文字：{"items":["词语或句子", ...], "note":"一句话说明识别范围或问题"}`;
}

function parseJson(text) {
  const t = String(text || "").replace(/```(?:json)?/g, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("识别结果格式不对，再试一次。");
  return JSON.parse(t.slice(a, b + 1));
}

// Complete string elements of the "items" array seen so far in a partially streamed JSON reply.
function partialItems(text) {
  const m = /"items"\s*:\s*\[/.exec(text);
  if (!m) return [];
  const out = [], re = /\s*,?\s*"((?:[^"\\]|\\.)*)"/y;
  re.lastIndex = m.index + m[0].length;
  let r;
  while ((r = re.exec(text))) {
    try { out.push(JSON.parse('"' + r[1] + '"').trim()); } catch {}
  }
  return out.filter(Boolean);
}

const secs = ms => (ms / 1000).toFixed(1) + "s";
function timingText(t, usage) {
  const parts = [`图片处理 ${secs(t.prep)}`];
  if (t.firstToken != null) parts.push(`首字 ${secs(t.firstToken)}`);
  if (t.thinking) parts.push(`思考 ${secs(t.thinking)}`);
  parts.push(`总计 ${secs(t.total)}`);
  if (usage) {
    const rt = usage.completion_tokens_details?.reasoning_tokens;
    parts.push(`输入 ${usage.prompt_tokens} / 输出 ${usage.completion_tokens}` + (rt ? `（其中思考 ${rt}）` : "") + " tokens");
  }
  return "耗时：" + parts.join("，");
}

$("extract").onclick = async () => {
  if (!apiKey()) { openSettings(); return; }
  if (!photos.length) { setStatus("先拍一张课文照片。", true); return; }
  const scope = $("scope").value.trim() || "课文中需要默写的重点词语和句子";
  extractCtl = new AbortController();
  $("extract").disabled = true; $("stopExtract").hidden = false;
  setStatus("正在处理图片…");
  const t0 = performance.now(), t = {};
  try {
    const images = [];
    for (const p of photos) images.push(await toDataUrl(p.file));
    t.prep = performance.now() - t0;
    setStatus("正在上传并识别…");
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
        // Thinking is on by default and spent ~12k tokens (over a minute) deliberating on a word list.
        thinking: { type: "disabled" },
        stream: true,
        stream_options: { include_usage: true }
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
    // Server-sent events: "data: {...}" lines, ending with "data: [DONE]".
    const reader = resp.body.getReader(), dec = new TextDecoder();
    let buf = "", content = "", reasoning = 0, usage = null, shown = 0, thinkStart = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n"); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let chunk; try { chunk = JSON.parse(payload); } catch { continue; }
        if (chunk.usage) usage = chunk.usage;
        const d = chunk.choices?.[0]?.delta;
        if (!d) continue;
        const now = performance.now() - t0;
        if (d.reasoning_content) {
          if (t.firstToken == null) t.firstToken = now;
          if (thinkStart == null) thinkStart = now;
          reasoning += d.reasoning_content.length;
          setStatus(`模型思考中…已 ${secs(now - thinkStart)}，${reasoning} 字`);
        }
        if (d.content) {
          if (t.firstToken == null) t.firstToken = now;
          if (thinkStart != null && t.thinking == null) t.thinking = now - thinkStart;
          content += d.content;
          const got = partialItems(content);
          if (got.length > shown) {
            shown = got.length;
            $("list").value = got.join("\n");
            setStatus(`正在识别…已出 ${shown} 项`);
          }
        }
      }
    }
    t.total = performance.now() - t0;
    if (thinkStart != null && t.thinking == null) t.thinking = t.total - thinkStart;
    const timing = timingText(t, usage);
    console.log("[extract]", timing, usage);
    const res = parseJson(content);
    const items = Array.isArray(res?.items) ? res.items.map(s => String(s).trim()).filter(Boolean) : [];
    if (!items.length) { setStatus("没有找到符合要求的内容。" + (res?.note ? "（" + res.note + "）" : "") + "\n" + timing, true); return; }
    $("list").value = items.join("\n"); store.set("list", $("list").value);
    $("listBadge").hidden = true;
    setStatus(`识别出 ${items.length} 项，请核对一下再开始。` + (res?.note ? " " + res.note : "") + "\n" + timing);
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
      if (r.isFinal !== false) onVoice(r[0].transcript.replace(/[，。！？、,.!?\s]/g, "").toLowerCase());
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
  $("listen").textContent = on ? "🎤 在听：说“好了 / 下一个”继续，说“再读一遍”重读" : "";
}
function voiceBlocked() {
  $("listen").textContent = "语音识别不可用，点按钮就行。";
  $("micScope").hidden = true; $("micScope").classList.remove("on");
}
// Common phrasings are matched locally (instant, offline). Anything else that is short enough to be a
// command goes to DeepSeek to classify; long utterances are the child reading aloud and are ignored.
const INTENT_RULES = [
  ["finish", /结束|不写了|不默了|停止|退出|就到这|stop|quit|finish/i],
  ["again", /再[读说念来报讲]|重[读说念复新来]|再一遍|一遍|没听[清见到懂]|听不[清见懂]|什么|啥|说慢点|慢一点|again|repeat|pardon|sorry|what/i],
  ["next", /好了|好啦|好的|好嘞|好咯|写好|写完|完了|完成|下一|下个|继续|可以了|行了|然后|搞定|ok|okay|next|done|go/i],
  ["next", /^(好|行|嗯|对|下)$/]
];
function ruleIntent(t) {
  for (const [intent, re] of INTENT_RULES) if (re.test(t)) return intent;
  return null;
}
let intentBusy = false;
async function llmIntent(t) {
  if (!apiKey() || intentBusy || t.length > 12) return null;
  intentBusy = true;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const resp = await fetch(API_URL, {
      method: "POST", signal: ctl.signal,
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey() },
      body: JSON.stringify({
        model: model(), temperature: 0, max_tokens: 20, stream: false, thinking: { type: "disabled" },
        messages: [{ role: "user", content:
`小学生正在听写，程序逐个报词语。下面是语音识别听到孩子说的一句话（可能有识别错误、方言或英文）：
「${t}」
判断孩子的意图，只回复一个词：
next = 写好了/要下一个
again = 没听清/要再读一遍
finish = 不写了/结束
none = 不是指令（例如在念正在写的字、自言自语）` }]
      })
    });
    if (!resp.ok) return null;
    const out = String((await resp.json())?.choices?.[0]?.message?.content || "").toLowerCase();
    return /finish/.test(out) ? "finish" : /again/.test(out) ? "again" : /next/.test(out) ? "next" : null;
  } catch { return null; }
  finally { clearTimeout(timer); intentBusy = false; }
}
async function onVoice(t) {
  if (!t) return;
  if (recFor === "scope") { $("scope").value = t; stopRec(); return; }
  if (recFor !== "play" || speaking) return;
  $("heard").textContent = "听到：" + t;
  // The child reading the current word aloud (e.g. the word itself is “完成”) is not a command.
  const cur = splitItem(spoken[pos]).say.replace(/[，。！？、,.!?\s]/g, "").toLowerCase();
  if (t.length >= 2 && cur && (cur.includes(t) || t.includes(cur))) return;
  const at = pos;
  const intent = ruleIntent(t) || await llmIntent(t);
  if (at !== pos || speaking || $("play").hidden) return;   // something else already moved on
  if (intent === "next") next();
  else if (intent === "again") again();
  else if (intent === "finish") finish();
}
$("micScope").onclick = () => {
  if (recWanted && recFor === "scope") { stopRec(); return; }
  stopRec(); startRec("scope"); $("micScope").classList.add("on");
};

// ---------- dictation flow ----------
function items() { return $("list").value.split("\n").map(s => s.trim()).filter(Boolean); }
// "answer | prompt": English lists read the Chinese meaning aloud and the child writes the English.
// A line without "|" is both what is read and what is written (语文).
function splitItem(line) {
  const m = String(line || "").split(/\s*[|｜]\s*/);
  if (m.length < 2 || !m[0] || !m[1]) return { answer: line, say: line };
  return { answer: m[0], say: m.slice(1).join("，") };
}
// Keep the screen on while dictating. iOS drops the lock whenever the app goes to the background,
// so it is re-requested each time the page becomes visible again.
let wakeLock = null;
async function keepAwake() {
  if (!("wakeLock" in navigator)) { $("awakeHint").hidden = false; return; }
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    $("awakeHint").hidden = true;
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch { $("awakeHint").hidden = false; }
}
function releaseAwake() { try { wakeLock?.release(); } catch {} wakeLock = null; }
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !$("play").hidden && !wakeLock) keepAwake();
});
function start() {
  const list = items();
  if (!list.length) { $("ttsStatus").textContent = "清单是空的，先识别或输入要默写的内容。"; return; }
  order = list.map((_, i) => i);
  if (mode === "rand") for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  pos = 0; spoken = [];
  $("setup").hidden = true; $("finish").hidden = true; $("play").hidden = false;
  keepAwake();
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
  $("heard").textContent = "";
  $("peekBtn").textContent = "偷看答案";
  $("ok").textContent = pos === order.length - 1 ? "好了，完成" : "好了";
  speak(splitItem(text).say);
}
function next() { if ($("play").hidden) return; if (pos >= order.length - 1) finish(); else { pos++; show(); } }
function again() { if (!$("play").hidden) speak(splitItem(spoken[pos]).say); }
function finish() {
  stopRec(); synth?.cancel(); speaking = false; clearTimeout(speakTimer);
  releaseAwake();
  $("play").hidden = true; $("finish").hidden = false;
  const done = spoken.filter(Boolean);
  $("finishSub").textContent = `共报了 ${done.length} 个，对照下面的答案检查吧。`;
  const ol = $("doneList"); ol.textContent = "";
  done.forEach(t => {
    const { answer, say } = splitItem(t);
    const li = document.createElement("li"); li.textContent = answer === say ? answer : `${answer}（${say}）`; ol.append(li);
  });
  window.scrollTo(0, 0);
}
$("start").onclick = start;
$("ok").onclick = next;
$("again").onclick = again;
$("quit").onclick = finish;
$("peekBtn").onclick = () => {
  const showing = !!$("peek").textContent;
  $("peek").textContent = showing ? "" : splitItem(spoken[pos]).answer;
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
