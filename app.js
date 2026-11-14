/* Lecture Hub main window. Components render from api.state(), polled every 250 ms.
   The recorder itself runs in a separate engine process (see ui/backend.py). */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  // write only a changed value: the 250 ms poll must not touch the DOM when nothing moved (review #3)
  const setp = (o, k, v) => { if (typeof o[k] === "boolean") v = !!v; if (o[k] !== v) o[k] = v; };
  const sett = (el, v) => setp(el, "textContent", String(v));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (ms) => { const s = Math.floor((ms || 0) / 1000); return [Math.floor(s / 3600), Math.floor(s % 3600 / 60), s % 60].map((n) => String(n).padStart(2, "0")).join(":"); };
  const shortDevice = (name) => String(name || "").split("(")[0].trim() || "마이크";
  const db = (v) => (v === null || v === undefined ? "-∞" : Math.round(v)) + " dB";

  const ui = { info: null, course: "", device: null, mic: true, pc: false, state: null, levels: [], lastToast: 0, attachedShown: false };
  let api = null;

  /* ---------- keyboard: layers and clickable rows ---------- */
  // every dialog and panel is a .scrim appended to <body>, so the last one is the top layer; Esc (and a dialog's
  // Enter) acts only on that one — a confirm dialog over a panel closes alone, the panel stays (and an open menu wins)
  const isTop = (el) => { if (!el || $("menu")) return false; const all = document.querySelectorAll("body > .scrim"); return all[all.length - 1] === el; };
  // rows drawn as <div>/<span> and handled by click delegation: reachable with Tab, Enter/Space click them
  const CLICKABLE = "[data-toggle],[data-lecture],[data-course],[data-files],[data-memo],[data-open],[data-ev],[data-day],[data-sday]," +
    "[data-inbox],[data-cands],[data-hw],[data-hwopen],[data-seek],[data-path],[data-event],[data-edit],[data-key],[data-note],[data-f]," +
    "[data-media],[data-session],[data-join],[data-sort],[data-range],[data-move],[data-etlf],[data-ann],.hcard,.seg-row";
  const NATIVE = /^(BUTTON|A|INPUT|SELECT|TEXTAREA|LABEL|OPTION|IFRAME)$/;
  function keyable(root) {
    if (!root.querySelectorAll) return;
    const list = [...root.querySelectorAll(CLICKABLE)]; if (root.matches && root.matches(CLICKABLE)) list.push(root);
    list.forEach((el) => {
      if (NATIVE.test(el.tagName) || el.hasAttribute("tabindex") || el.closest("button,a,.menu")) return;
      el.tabIndex = 0; if (!el.hasAttribute("role")) el.setAttribute("role", "button");
    });
  }
  new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach(keyable))).observe(document.documentElement, { childList: true, subtree: true });
  if (document.body) keyable(document.body);
  window.addEventListener("keydown", (e) => {
    const t = e.target;
    if ((e.key !== "Enter" && e.key !== " ") || e.ctrlKey || e.altKey || e.metaKey || e.isComposing || !t || !t.matches) return;
    if (t.getAttribute("role") !== "button" || NATIVE.test(t.tagName)) return;
    e.preventDefault(); e.stopPropagation(); t.click();
  }, true);

  /* ---------- toast ---------- */
  function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove("show"), 1800); }

  /* ---------- dialog (replaces window.confirm, same visual language as the mockup) ---------- */
  // tone "danger": the safe button (cancel) has the focus and Enter never confirms (user 2026-09-29: a pair discard
  // taken by an extra Enter lost the lecture's transcript)
  /* resolves true (ok), false (cancel, Esc, outside) or "extra" (a third button, only when `extra` is given) */
  function dialog({ title, body, ok = "확인", cancel = "취소", tone = "primary", extra = "", check = null, checks = null }) {
    return new Promise((resolve) => {
      const scrim = document.createElement("div");
      scrim.className = "scrim";
      // check / checks: {label, value} — optional check boxes; their state is written back to .value
      const boxes = checks || (check ? [check] : []);
      const box = boxes.map((c) => `<label class="dlg-check"><input type="checkbox"${c.value ? " checked" : ""}> ${esc(c.label)}</label>`).join("");
      scrim.innerHTML = `<div class="dialog" role="dialog"><h4>${esc(title)}</h4><p>${esc(body)}</p>${box}
        <div class="acts">${extra ? `<button class="ghost" data-r="x">${esc(extra)}</button>` : ""}<button data-r="0">${esc(cancel)}</button><button class="${tone}" data-r="1">${esc(ok)}</button></div></div>`;
      const done = (r) => { scrim.querySelectorAll(".dlg-check input").forEach((el, i) => { boxes[i].value = el.checked; }); scrim.remove(); document.removeEventListener("keydown", key); resolve(r); };
      const key = (e) => {
        if (!isTop(scrim)) return;
        if (e.key === "Escape") done(false);
        if (e.key === "Enter") { e.preventDefault(); done(tone === "danger" ? document.activeElement === scrim.querySelector(".acts ." + tone) : true); }
      };
      scrim.addEventListener("click", (e) => { const b = e.target.closest("button[data-r]"); if (b) done(b.dataset.r === "x" ? "extra" : b.dataset.r === "1"); else if (e.target === scrim) done(false); });
      document.addEventListener("keydown", key);
      document.body.appendChild(scrim); keepFocus(scrim);
      scrim.querySelector(tone === "danger" ? '.acts [data-r="0"]' : ".acts ." + tone).focus();
    });
  }

  /* keyboard for the big dialogs (settings, timetable, first run, panels): focus moves in, Tab stays inside, Esc closes
     when `onEsc` is given, and focus returns to the button that opened it. Works across redraws (innerHTML). */
  const FOCUSABLE = 'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]';
  function keepFocus(scrim, onEsc = null) {
    const opener = document.activeElement;
    const visible = () => [...scrim.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    const key = (e) => {
      if (!isTop(scrim)) return;
      if (e.key === "Escape" && onEsc) { e.preventDefault(); e.stopPropagation(); onEsc(); return; }
      if (e.key !== "Tab") return;
      const list = visible(); if (!list.length) return;
      const first = list[0], last = list[list.length - 1], at = document.activeElement;
      if (!scrim.contains(at)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && at === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
    };
    const label = () => {
      const d = scrim.querySelector(".dialog") || scrim.firstElementChild; if (!d) return;
      if (!d.getAttribute("role")) d.setAttribute("role", "dialog");
      d.setAttribute("aria-modal", "true");
      const h = d.querySelector("h4, h3, b"); if (h) { h.id = h.id || "dlg" + Math.random().toString(36).slice(2, 8); d.setAttribute("aria-labelledby", h.id); }
      if (!scrim.contains(document.activeElement)) { const f = visible()[0]; if (f) f.focus({ preventScroll: true }); }
    };
    const watch = new MutationObserver(() => {
      if (document.body.contains(scrim)) { label(); return; }
      watch.disconnect(); document.removeEventListener("keydown", key, true);
      if (opener && opener.focus && document.body.contains(opener)) opener.focus({ preventScroll: true });
    });
    watch.observe(document.body, { childList: true });
    watch.observe(scrim, { childList: true });
    document.addEventListener("keydown", key, true);
    label();
  }

  function askText({ title, body = "", value = "", ok = "저장", multiline = false, secret = false }) {
    return new Promise((resolve) => {
      const scrim = document.createElement("div");
      scrim.className = "scrim";
      const field = multiline ? `<textarea class="ask" rows="5">${esc(value)}</textarea>` : `<input class="ask" value="${esc(value)}"${secret ? ' type="password" autocomplete="off"' : ""}>`;
      scrim.innerHTML = `<div class="dialog" role="dialog"><h4>${esc(title)}</h4>${body ? `<p>${esc(body)}</p>` : ""}${field}
        <div class="acts"><button data-r="0">취소</button><button class="primary" data-r="1">${esc(ok)}</button></div></div>`;
      const input = scrim.querySelector(".ask");
      const done = (r) => { scrim.remove(); document.removeEventListener("keydown", key); resolve(r ? input.value : null); };
      const key = (e) => { if (!isTop(scrim)) return; if (e.key === "Escape") done(false); if (e.key === "Enter" && !multiline) done(true); };
      scrim.addEventListener("click", (e) => { const b = e.target.closest("button[data-r]"); if (b) done(b.dataset.r === "1"); else if (e.target === scrim) done(false); });
      document.addEventListener("keydown", key);
      document.body.appendChild(scrim); keepFocus(scrim);
      input.focus(); if (input.select) input.select();
    });
  }

  /* ---------- dropdown menu ---------- */
  const UNSORTED = "미분류";  // core/extra_courses.py UNSORTED
  function menu(anchor, sections, onPick) {
    closeMenu();
    const m = document.createElement("div");
    m.className = "menu"; m.id = "menu";
    // values stay in JS and the element carries only a position: an attribute cannot hold "\u0000…" (the HTML
    // parser turns NUL into U+FFFD, so "과목 없이 녹음" and "+ 새로 만들기" were saved as course names, 2026-10-03)
    const values = [];
    m.innerHTML = sections.map((s) => (s.label ? `<div class="ml">${esc(s.label)}</div>` : "") +
      s.items.map((it) => `<div class="mi${it.sel ? " sel" : ""}" role="menuitem" tabindex="-1" data-i="${values.push(it.value) - 1}">${esc(it.text)}${it.note ? `<small>${esc(it.note)}</small>` : ""}</div>`).join("")).join("");
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    m.style.left = Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8)) + "px";
    const above = r.top - m.offsetHeight - 6;  // open upward (dock), or downward when there is no room (panel heads)
    m.style.top = (above >= 8 ? above : Math.max(8, Math.min(r.bottom + 6, innerHeight - m.offsetHeight - 8))) + "px";
    m.setAttribute("role", "menu");
    m.addEventListener("click", (e) => { const it = e.target.closest(".mi"); if (it) { closeMenu(); onPick(values[+it.dataset.i]); } });
    setTimeout(() => document.addEventListener("click", closeMenu, { once: true }), 0);
    // keyboard: ↑↓ to move, Enter to pick, Esc to close (back to the button that opened it)
    const items = [...m.querySelectorAll(".mi")];
    const focusAt = (k) => { if (items.length) items[(k + items.length) % items.length].focus(); };
    menuKeys = (e) => {
      if (!document.body.contains(m)) return;
      const at = items.indexOf(document.activeElement);
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(); if (anchor.focus) anchor.focus(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); focusAt(at + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); focusAt(at < 0 ? -1 : at - 1); }
      else if (e.key === "Enter" && at >= 0) { e.preventDefault(); closeMenu(); onPick(values[at]); }
    };
    document.addEventListener("keydown", menuKeys, true);
    focusAt(Math.max(0, items.findIndex((x) => x.classList.contains("sel"))));
  }
  let menuKeys = null;
  function closeMenu() {
    const m = $("menu"); if (m) m.remove();
    if (menuKeys) { document.removeEventListener("keydown", menuKeys, true); menuKeys = null; }
  }

  /* ---------- top bar ---------- */
  const courseName = (folder) => { const c = (ui.info.courses || []).find((x) => x.folder === folder); return c && c.name !== folder ? c.name : ""; };
  const mdText = (iso) => { const [, m, d] = iso.split("-"); return `${+m}/${+d}`; };
  function renderTop() {
    const info = ui.info, L = ui.view === "lecture" ? ui.lecture : null, home = ui.view === "home";
    document.body.classList.toggle("home-view", home);
    $("body").classList.toggle("noside", home ? !ui.sideInHome : !!ui.sideHidden);
    $("homeBtn").classList.toggle("on", home);
    $("sideBtn").classList.toggle("on", !$("body").classList.contains("noside"));
    sett($("rTitle"), home ? "오늘 할 일" : "전사");
    if (home) {
      setp($("title").firstChild, "nodeValue", "오늘 ");
      sett($("subtitle"), info.date);
      setp($("lstate"), "hidden", true); setp($("lnext"), "hidden", true); setp($("lecDiscard"), "hidden", true);
    } else if (L) {
      setp($("title").firstChild, "nodeValue", `${L.course} ${L.label} `);
      sett($("subtitle"), `${mdText(L.date)}(${L.weekday})` + (courseName(L.course) ? " · " + courseName(L.course) : ""));
      const st = L.state, tone = st.key === "reviewable" ? "ok" : st.key === "needs_transcript" ? "wait" : "";
      const tr = (ui.state || {}).transcription, paths = L.recordings.map((r) => r.path);
      const running = tr && paths.includes(tr.master) && !["done", "qa_warning", "failed"].includes(tr.state);
      setp($("lstate"), "className", "lstate " + (running ? "wait" : tone));
      sett($("lstate"), running ? `전사 중 · ${tr.label || "준비"}` : st.label); setp($("lstate"), "hidden", false);
      setp($("lnext"), "hidden", running || !st.action); sett($("lnext"), st.action_label || "");
      setp($("lnext"), "title", st.why ? `이유: ${st.why}` : "");
      const canDiscard = L.recordings.length > 0;
      setp($("lecDiscard"), "hidden", !canDiscard); setp($("htmlDiscard"), "hidden", !canDiscard);
    } else {
      const c = info.courses.find((x) => x.folder === ui.course);
      const slot = info.today.find((x) => x.folder === ui.course);
      setp($("title").firstChild, "nodeValue", (c ? c.folder : ui.course || "새 녹음") + " ");
      sett($("subtitle"), info.date + (slot ? " " + slot.start : "") + (c && c.name !== c.folder ? " · " + c.name : ""));
      setp($("lstate"), "hidden", true); setp($("lnext"), "hidden", true); setp($("lecDiscard"), "hidden", true);
    }
    renderEnginesChip();
  }

  /* ---------- transcription engines: Google (requests/day) · Whisper (Groq audio hours) · MAI (chunks/day) ---------- */
  const hours = (s) => `${(Math.max(0, s || 0) / 3600).toFixed(1)}시간`;
  function engineSummary() {
    const E = ui.engines, q = ui.quota, info = ui.info.engines || {};
    const g = E ? E.google : { state: info.google, quota: q };
    const gq = g && g.quota;
    const google = g && g.state === "ok" ? (gq && gq.ok ? `Google ${gq.remaining}/${gq.limit}` : "Google") : "Google 키 없음";
    if (!E) return { text: google, bad: !(g && g.state === "ok") || (gq && gq.ok && gq.remaining === 0) };
    const w = E.whisper, m = E.mai;
    const whisper = w.state === "ok" ? `Whisper ${hours(w.usage.day_left_s)} 남음` : "Whisper 키 없음";
    const mai = m.state === "aside" || m.state === "agent" ? `MAI 오늘 ${m.usage.today_chunks}조각` : "MAI 수동";
    const bad = g.state !== "ok" || (gq && gq.ok && gq.remaining === 0) || (w.state === "ok" && w.usage.day_left_s <= 0);
    return { text: (ed("mai") ? [google, whisper, mai] : [google, whisper]).join(" · "), bad };
  }
  function renderEnginesChip() {
    // plain words on the chip (a first-time user read "Google 25/25 · Whisper 8.0시간" as noise); numbers stay in the
    // pop-up and the tooltip
    const s = engineSummary(), E = ui.engines, info = ui.info.engines || {}, gq = E ? E.google.quota : ui.quota;
    const gOk = (E ? E.google.state : info.google) === "ok", wOk = (E ? E.whisper.state : info.whisper) === "ok";
    const left = (gOk && !(gq && gq.ok && gq.remaining === 0)) || (wOk && !(E && E.whisper.usage && E.whisper.usage.day_left_s <= 0));
    const word = !gOk && !wOk ? "전사 연결 필요" : left ? "전사 준비됨" : "전사 한도 다 씀";
    const html = `<span><i class="dot ${left ? "ok" : "wait"}"></i>${esc(word)}</span>`;
    if ($("engines").dataset.h !== html) { $("engines").innerHTML = html; $("engines").dataset.h = html; }
    setp($("engines"), "title", `전사(녹음을 글로 바꾸기) 서비스 상태: ${s.text} — 누르면 남은 양을 자세히 봅니다`);
  }
  async function loadEngines() {
    try {
      const r = await api.engines();
      if (r && r.ok) { ui.engines = r; ui.quota = r.google.quota; } else ui.quota = await api.quota();
    } catch (err) { /* keep the last value */ }
    renderEnginesChip();
    const pop = document.querySelector(".eng-pop"); if (pop) pop.innerHTML = enginePopHtml();
  }
  function enginePopHtml() {
    const E = ui.engines;
    if (!E) return `<div class="ep"><b>Google</b><pre>${esc(quotaTitle())}</pre></div>`;
    const w = E.whisper, m = E.mai, u = w.usage || {}, mu = m.usage || {};
    const google = E.google.state === "ok" ? quotaTitle() : "API 키가 없습니다";
    const whisper = w.state === "ok"
      ? [`오늘(24시간) 남은 오디오 ${hours(u.day_left_s)} / ${hours(u.day_limit_s)}`, `최근 1시간 남은 오디오 ${Math.floor((u.hour_left_s || 0) / 60)}분 / ${Math.floor((u.hour_limit_s || 0) / 60)}분`, u.basis || ""].join("\n")
      : "Groq API 키(GROQ_API_KEY)가 없습니다";
    const mai = m.state === "aside" || m.state === "agent"
      ? [`오늘 가져온 조각 ${mu.today_chunks}개 · 거절 ${mu.today_rejections}번`, `막히지 않았던 관찰값: 하루 ${mu.observed_ok_per_day}조각`, mu.basis || ""].join("\n")
      : "Aside CLI·Claude Code를 찾지 못해 수동으로만 올릴 수 있습니다";
    return [["Google", E.google.note, google], ["Whisper (Groq)", w.note, whisper], ["MAI", m.note, mai]]
      .map(([t, note, body]) => `<div class="ep"><b>${esc(t)}</b><small>${esc(note || "")}</small><pre>${esc(body)}</pre></div>`).join("") +
      (E.recording ? `<div class="ep-rec">녹음 중: Google 새 시작·MAI는 녹음이 끝난 뒤, Whisper는 녹음 중에도 보냅니다</div>` : "");
  }
  function openEnginePop() {
    const old = document.querySelector(".eng-pop"); if (old) { old.remove(); return; }
    const pop = document.createElement("div");
    pop.className = "eng-pop";
    pop.innerHTML = enginePopHtml();
    const r = $("engines").getBoundingClientRect();
    pop.style.top = `${r.bottom + 6}px`; pop.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
    document.body.appendChild(pop);
    const off = (e) => { if (!pop.contains(e.target) && !$("engines").contains(e.target)) { pop.remove(); document.removeEventListener("mousedown", off); } };
    setTimeout(() => document.addEventListener("mousedown", off), 0);
    loadEngines();
  }

  /* per recording: which engines ran, what they are doing, and [실행]/[다시] (why a button is off in its tooltip) */
  const ENGINES_ALL = [["gemini_transcribe", "google", "Google"], ["whisper", "whisper", "Whisper"], ["mai", "mai", "MAI"]];
  const enginesNow = () => ENGINES_ALL.filter((e) => e[1] !== "mai" || ed("mai"));
  // speech language per recording (2026-10-19: a German video sent as Korean came back as two lines)
  const LANGS = { ko: "한국어", de: "독어", en: "영어", ja: "일본어", zh: "중국어", fr: "프랑스어", es: "스페인어", auto: "자동(Whisper)" };
  const engLang = {};  // recording path → picked language, kept across the panel's re-renders
  async function renderLectureEngines() {
    const L = ui.view === "lecture" && ui.lecture, box = $("lvEngines");
    const recs = L ? L.recordings.filter((r) => r.exists) : [];
    if (!recs.length) { box.style.display = "none"; box.innerHTML = ""; return; }
    const id = L.id;
    const rows = await Promise.all(recs.map(async (rec) => {
      let r;
      try { r = await api.recording_engines(rec.path, L.course); } catch (err) { r = null; }
      if (!r || !r.ok) return "";
      const name = rec.origin === "app_loopback" ? "PC 소리" : rec.origin === "app_mic" ? "녹음" : "가져온 녹음";
      // a transcript can exist without an app job (imported files, older runs): show it as done
      const have = new Set(L.transcripts.filter((t) => t.media_id === rec.id || !t.media_id).map((t) => t.engine));
      const cells = enginesNow().map(([key, arg, label]) => {
        const x = r.engines[key] || {}, j = x.job, exists = !j && have.has(key);
        let st = j ? j.label || j.state : exists ? "전사본 있음" : "없음";
        if (j && j.language && j.language !== "ko") st += ` · ${LANGS[j.language] || j.language}`;
        if (j && j.chunks_total && !["done", "qa_warning"].includes(j.state)) st += ` ${j.chunks_done}/${j.chunks_total}`;
        if (j && j.next_eligible_at) st += ` · ${hm(j.next_eligible_at)} 이후`;
        const tone = exists ? "ok" : !j ? "" : ["done", "qa_warning"].includes(j.state) ? "ok" : j.state === "failed" ? "err" : "wait";
        const pick = engLang[rec.path] || r.language || "ko";
        // Google goes again only in another language (quota); the backend keeps the same guard
        const googleAgain = key === "gemini_transcribe" && x.again && pick !== "auto" && pick !== ((j && j.language) || "ko");
        const btn = exists ? (key === "gemini_transcribe" ? "" : "다시") : x.again ? (key === "gemini_transcribe" ? (googleAgain ? "다시" : "") : "다시") : j && !["failed", "cancelled"].includes(j.state) ? "" : "실행";
        const title = x.why || (j && j.error ? `오류: ${j.error}` : "");
        const b = btn ? `<button class="mini${x.can_start ? "" : " off"}" data-eng="${arg}" data-master="${esc(rec.path)}"${x.can_start ? "" : " disabled"} title="${esc(title)}">${btn}</button>` : "";
        return `<span class="ec ${tone}" title="${esc(title)}"><b>${label}</b> ${esc(st)}${b}</span>`;
      }).join("");
      const pick = engLang[rec.path] || r.language || "ko";
      const opts = (r.languages || ["ko"]).map((v) => `<option value="${v}"${v === pick ? " selected" : ""}>${LANGS[v] || v}</option>`).join("");
      const sel = `<select class="lang" data-master="${esc(rec.path)}" title="음성 언어 — 외국어 영상·강의면 바꾼 뒤 [실행]/[다시]">${opts}</select>`;
      return `<div class="er"><span class="en">${name} ${rec.duration_ms ? clock(rec.duration_ms) : ""}</span>${sel}${cells}</div>`;
    }));
    if (!(ui.view === "lecture" && ui.lecture && ui.lecture.id === id)) return;  // moved on meanwhile
    const html = rows.join("");
    box.style.display = html ? "" : "none";
    if (box.dataset.h !== html) { box.innerHTML = html; box.dataset.h = html; }
  }
  async function startEngine(button) {
    const L = ui.lecture, engine = button.dataset.eng, master = button.dataset.master;
    const label = { google: "Google", whisper: "Whisper", mai: "MAI" }[engine];
    const sel = button.closest(".er") && button.closest(".er").querySelector("select.lang");
    const language = engine === "mai" ? "" : (sel ? sel.value : "");
    if (engine === "google" && language === "auto") { toast("Google은 자동 언어를 못 씁니다 — 언어를 고르세요"); return; }
    let r = await api.engine_start(engine, master, L.course, false, language);
    if (!r.ok && r.needs_consent) {
      if (!(await dialog({ title: `${label}로 이 녹음을 보낼까요?`, body: `${r.notice}\n과목이 정해지지 않은 녹음이라 이번에만 적용합니다(저장하지 않음).`, ok: "보내고 전사", cancel: "취소" }))) return;
      r = await api.engine_start(engine, master, L.course, true, language);
    }
    if (!r.ok) { toast(r.reason || r.error || `${label} 전사를 시작하지 못했습니다`); return; }
    toast(engine === "mai" ? (r.hint || "MAI 조각을 만들어 올리기 시작했습니다") : `${label} 전사를 시작했습니다`);
    setTimeout(() => { renderLectureEngines(); loadEngines(); }, 1500);
  }

  /* ---------- live captions (2026-11-06): grey quick line (Gemini Live), black confirmed lines (Chirp 3) ---------- */
  const cap = { timer: null, shown: false, last: "" };
  function capCourse() {
    const st = ui.state || {}, live = ["starting", "recording", "stopping"].includes(st.phase);
    return (live && st.status && st.status.course) || (ui.view === "lecture" && ui.lecture && ui.lecture.course) || ui.course || "";
  }
  function capPanel() {
    let p = document.querySelector(".cap-panel");
    if (!p) {
      p = document.createElement("div");
      p.className = "cap-panel";
      p.innerHTML = `<header><b>실시간 자막</b><span id="capInfo"></span><span class="sp"></span><button class="ghost" id="capFile">파일</button><button class="ghost" id="capPause">일시중단</button><button class="primary" id="capStop">그만</button><button class="ghost" id="capClose">닫기</button></header><div class="cap-body" id="capBody"></div><div class="cap-err" id="capErr"></div>`;
      document.body.appendChild(p);
      p.querySelector("#capStop").onclick = async () => { await api.captions_stop(); toast("마지막 조각까지 적고 멈춥니다"); };
      p.querySelector("#capClose").onclick = () => { p.remove(); cap.shown = false; };
      p.querySelector("#capPause").onclick = async () => {  // P-050: stop listening for a while, same file
        const r = await api.captions_pause(!cap.paused);
        toast(r.ok ? (r.paused ? "자막을 잠깐 멈춥니다 — 소리를 보내지 않습니다" : "자막을 이어서 적습니다") : r.reason);
      };
      p.querySelector("#capFile").onclick = () => { if (cap.file) api.open_folder(cap.file.replace(/[\\/][^\\/]*$/, "")); };
    }
    cap.shown = true;
    return p;
  }
  function renderCaptions(s) {
    const btn = $("capBtn"), running = !!(s && s.running);
    btn.classList.toggle("on", running);
    cap.paused = !!(s && s.paused);
    btn.textContent = running ? `자막 ${cap.paused ? "⏸" : "●"} ${clock((s.elapsed_s || 0) * 1000)}` : "자막";
    if (s) cap.status = s;
    renderLive();
    if (!cap.shown || !s) return;
    const p = capPanel(), body = p.querySelector("#capBody");
    cap.file = s.file;
    const eng = s.engines || {};
    p.querySelector("#capStop").disabled = !running || s.state === "finishing";
    const pauseBtn = p.querySelector("#capPause");
    pauseBtn.disabled = !running || s.state === "finishing";
    pauseBtn.textContent = cap.paused ? "이어하기" : "일시중단";
    pauseBtn.classList.toggle("primary", cap.paused);
    p.querySelector("#capInfo").textContent = `${s.course || "과목 미지정"} · ${running ? ({ finishing: "마무리 중", paused: "일시중단 — 듣지 않음" }[s.state] || "듣는 중") : "멈춤"}` +
      (eng.confirmed ? ` · Chirp 3 확정 줄${s.hints ? ` (용어 힌트 ${s.hints})` : ""}${eng.quick ? " + Gemini Live" : ""}` : eng.quick ? " · Gemini Live" : "");
    const lines = (s.lines || []).map((l) => `<p class="cap-line${l.from === "quick" ? " quick" : ""}"><small>${clock(l.at * 1000)}</small>${l.from === "quick" ? "(빠른 줄) " : ""}${esc(l.text)}</p>`).join("");
    const html = lines + (s.interim ? `<p class="cap-interim">${esc(s.interim)}</p>` : "");
    if (html !== cap.last) {
      const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
      body.innerHTML = html || `<p class="cap-interim">${running ? "듣는 중… 첫 줄은 몇 초 뒤에 나옵니다" : "자막 없음"}</p>`;
      cap.last = html;
      if (atBottom) body.scrollTop = body.scrollHeight;
    }
    const errs = (s.errors || []).slice(-2).map((e) => e.message).join(" · ");
    p.querySelector("#capErr").textContent = errs;
  }
  async function pollCaptions() {
    let s = null;
    try { s = await api.captions_status(); } catch (err) { /* keep polling */ }
    renderCaptions(s);
    const running = !!(s && s.running);
    clearTimeout(cap.timer);
    cap.timer = setTimeout(pollCaptions, running || cap.shown || sv.on ? 700 : 15000);  // idle: only notices captions started elsewhere
  }
  /* ---------- live transcription in the middle pane while recording (2026-11-13, replaces the slide pane).
     Gemini Live only, started with the recording when the Gemini key is connected and the course said yes;
     it pauses and stops with the recording. Declines and the off switch are remembered on this PC. ---------- */
  const LIVE_KEY = "lh.liveWithRecording", LIVE_DECLINED = "lh.liveDeclined";
  const store = { get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (err) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (err) { /* private window: this run only */ } } };
  const liveReady = () => ((ui.info && ui.info.features) || {}).captions?.state === "ready";
  const liveWanted = () => store.get(LIVE_KEY, true) !== false;
  const liveDeclined = (course) => (store.get(LIVE_DECLINED, []) || []).includes(course || "");
  function liveSource() { const m = recMode(); return m.mode === "loopback" ? "pc" : "mic"; }
  /* consent first (the native window stores a course's yes), then start; false when nothing started */
  async function startLive(auto) {
    const course = capCourse();
    const check = await api.captions_check(course);
    let consent = false, token = null;
    if (check.needs_consent && !check.once_only) {
      const q = await api.consent_confirm("google_live", course);
      if (!q.ok) { toast(q.error); return false; }
      if (!q.yes) { if (auto) store.set(LIVE_DECLINED, [...new Set([...(store.get(LIVE_DECLINED, []) || []), course])]); renderLive(); return false; }
      token = q.token;
    } else if (check.needs_consent) {
      consent = await dialog({ title: "실시간 전사를 켤까요?", body: `${check.notice}\n과목이 정해지지 않아 이번에만 적용합니다(저장하지 않음).`, ok: "켜기", cancel: "켜지 않기" });
      if (!consent) return false;
    }
    const eng = ((await api.live_engine_get()) || {}).engine || "quick";  // settings: Gemini Live, Chirp 3 or both
    const r = await api.captions_start(course, liveSource(), consent, token, eng !== "quick", eng !== "chirp");
    if (!r.ok) { cap.error = r.reason || "실시간 전사를 켜지 못했습니다"; renderLive(); if (!auto) toast(cap.error); return false; }
    cap.error = ""; cap.auto = !!auto || ["starting", "recording"].includes((ui.state || {}).phase); cap.recPaused = undefined; cap.last = ""; cap.liveHtml = "";
    if (!auto) store.set(LIVE_DECLINED, (store.get(LIVE_DECLINED, []) || []).filter((c) => c !== course));
    pollCaptions();
    return true;
  }
  /* called when a recording starts (onRec) and on every state poll: start, pause, resume and stop with it */
  async function followRecording(st) {
    const phase = st.phase, live = phase === "recording", s = cap.status || {};
    if (cap.busy) return;
    if (live && cap.pendingAuto) {
      cap.pendingAuto = false;
      if (liveReady() && liveWanted() && !s.running && !liveDeclined(capCourse())) { cap.busy = true; try { await startLive(true); } finally { cap.busy = false; } }
      return;
    }
    if (!cap.auto || !s.running) return;
    if (!["starting", "recording", "stopping"].includes(phase)) {  // the recording ended: captions end with it
      cap.auto = false; cap.recPaused = undefined; cap.busy = true;
      try { await api.captions_stop(); } finally { cap.busy = false; }
      pollCaptions(); return;
    }
    // follow the recording's pause button only when it changes (a pause pressed on the captions alone stays)
    const paused = live && !!(st.status && st.status.paused);
    if (cap.recPaused === undefined) cap.recPaused = paused;
    if (paused !== cap.recPaused) {
      cap.recPaused = paused;
      if (!!s.paused !== paused && s.state !== "finishing") {
        cap.busy = true;
        try { await api.captions_pause(paused); } finally { cap.busy = false; }
        pollCaptions();
      }
    }
  }
  function renderLive() {
    renderSideLive();
    const head = $("liveHead"), body = $("liveBody");
    if (!head || ui.view === "lecture" || ui.view === "home") return;
    const s = cap.status || {}, st = ui.state || {}, recording = ["starting", "recording", "stopping"].includes(st.phase);
    const running = !!s.running, course = capCourse();
    let line = "", acts = "";
    if (running) {
      const what = { finishing: "마지막 조각을 적는 중", paused: "일시중단 — 소리를 보내지 않음" }[s.state] || "듣는 중";
      line = `<i class="dot ${s.state === "paused" ? "wait" : "ok"}"></i><b>실시간 전사</b> · ${esc(what)} · <span class="num">${clock((s.elapsed_s || 0) * 1000)}</span>${cap.auto ? " · 녹음과 함께 멈춥니다" : ""}`;
      acts = `<button class="ghost" data-live="pause"${s.state === "finishing" ? " disabled" : ""}>${cap.paused ? "이어하기" : "일시중단"}</button><button class="ghost" data-live="stop"${s.state === "finishing" ? " disabled" : ""}>끄기</button>` +
        (s.file ? `<button class="ghost" data-live="file" title="자막 파일이 있는 폴더">파일</button>` : "");
    } else if (!liveReady()) {
      line = `<i class="dot"></i>실시간 전사는 꺼져 있습니다 — 설정 › 계정 연결에서 Gemini 키를 연결하면 녹음과 함께 켜집니다.`;
      acts = `<button class="ghost" data-live="settings">설정 열기</button>`;
    } else if (cap.error) {
      line = `<i class="dot warn"></i>${esc(cap.error)}`;
      acts = `<button class="ghost" data-live="start">다시 켜기</button>`;
    } else if (recording && liveDeclined(course)) {
      line = `<i class="dot"></i>${esc(course || "이 과목")}은 실시간 전사에 동의하지 않아 켜지 않았습니다.`;
      acts = `<button class="ghost" data-live="start">지금 켜기</button>`;
    } else if (recording && !liveWanted()) {
      line = `<i class="dot"></i>녹음과 함께 켜기가 꺼져 있어 실시간 전사를 하지 않습니다.`;
      acts = `<button class="ghost" data-live="start">지금 켜기</button>`;
    } else if (recording) {
      line = `<i class="dot wait"></i>실시간 전사를 켜는 중…`;
    } else {
      line = `<i class="dot"></i>녹음을 시작하면 수업에서 하는 말이 여기에 바로 글로 나옵니다(엔진은 설정 › AI 엔진 › 실시간 전사).`;
      acts = `<label class="live-auto"><input type="checkbox" data-live="auto"${liveWanted() ? " checked" : ""}> 녹음과 함께 켜기</label>`;
    }
    const headHtml = `<div class="live-line">${line}</div><div class="live-acts">${acts}</div>`;
    if (head.dataset.h !== headHtml) { head.innerHTML = headHtml; head.dataset.h = headHtml; }
    const lines = (s.lines || []).map((l) => `<p class="cap-line"><small>${clock(l.at * 1000)}</small>${esc(l.text)}</p>`).join("");
    const html = lines + (running && s.interim ? `<p class="cap-interim">${esc(s.interim)}</p>` : "") ||
      (running ? `<p class="cap-interim">듣는 중… 첫 줄은 몇 초 뒤에 나옵니다</p>` : "");
    if (html !== cap.liveHtml) {
      const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
      body.innerHTML = html || `<div class="empty live-empty"><svg style="width:30px;height:30px;color:var(--faint)"><use href="#i-wave"/></svg><div>${running ? "" : "아직 받아 적은 말이 없습니다"}</div></div>`;
      cap.liveHtml = html;
      if (atBottom) body.scrollTop = body.scrollHeight;
    }
    if (document.body.classList.contains("masked")) body.classList.add("masked-live"); else body.classList.remove("masked-live");
  }
  async function liveAction(el) {
    const act = el.dataset.live;
    if (act === "settings") openSettings();
    else if (act === "start") { el.disabled = true; await startLive(false); el.disabled = false; }
    else if (act === "stop") { cap.auto = false; await api.captions_stop(); toast("마지막 조각까지 적고 끕니다"); pollCaptions(); }
    else if (act === "pause") { const r = await api.captions_pause(!cap.paused); if (!r.ok) toast(r.reason); pollCaptions(); }
    else if (act === "file") { if (cap.status && cap.status.file) api.open_folder(cap.status.file.replace(/[\\/][^\\/]*$/, "")); }
  }

  /* ---------- 옆으로 보기 (user 2026-11-14): the window on the right third of the screen (PDF·Chrome on the left);
     live transcript above, any lecture's transcript below (chosen by course and date) ---------- */
  const sv = { on: false, course: "", lec: "", timer: null, liveHtml: "" };
  async function sideView(on) {
    const r = await api.side_view(on);
    if (!r.ok) { toast(r.error || "창을 옮기지 못했습니다"); return; }
    sv.on = on; $("sideView").hidden = !on; document.body.classList.toggle("sv-on", on);
    clearInterval(sv.timer);
    if (!on) return;
    sv.liveHtml = ""; svFill(); renderSideLive(); svRecSync();
    sv.timer = setInterval(svRecSync, 1000);
    pollCaptions();
  }
  function svRecSync() {
    const st = ui.state || {}, live = ["starting", "recording", "stopping"].includes(st.phase), b = $("svRec");
    b.classList.toggle("on", live); b.disabled = $("recBtn").disabled;
    $("svRecText").textContent = live ? `녹음 중 ${$("timer").textContent}` : st.phase === "finalizing" ? "저장 중…" : "녹음 시작";
  }
  function svItems() {
    const by = {};
    ((ui.side && ui.side.groups) || []).forEach((g) => g.items.forEach((it) => { (by[it.course] = by[it.course] || []).push(it); }));
    Object.values(by).forEach((list) => list.sort((a, b) => b.date.localeCompare(a.date) || b.n - a.n));
    return by;
  }
  function svFill() {
    const by = svItems(), names = Object.keys(by), cc = capCourse();
    if (!by[sv.course]) sv.course = (ui.lecture && by[ui.lecture.course] && ui.lecture.course) || (by[cc] && cc) || names[0] || "";
    $("svCourse").innerHTML = names.map((n) => `<option${n === sv.course ? " selected" : ""}>${esc(n)}</option>`).join("") || "<option>회차 없음</option>";
    const items = by[sv.course] || [];
    if (!items.some((it) => it.id === sv.lec)) sv.lec = ui.lecture && items.some((it) => it.id === ui.lecture.id) ? ui.lecture.id : (items[0] || {}).id || "";
    $("svLec").innerHTML = items.map((it) => `<option value="${it.id}"${it.id === sv.lec ? " selected" : ""}>${esc(mdText(it.date))} ${esc(it.label)}</option>`).join("");
    svLoad();
  }
  async function svLoad() {
    const box = $("svTr"), id = sv.lec;
    if (!id) { box.innerHTML = `<div class="empty">회차를 고르세요</div>`; return; }
    box.innerHTML = `<div class="empty">불러오는 중…</div>`;
    const r = await api.lecture(id);
    if (id !== sv.lec) return;
    if (!r.ok) { box.innerHTML = `<div class="empty">${esc(r.error || "회차를 열 수 없습니다")}</div>`; return; }
    const segs = r.lecture.segments || [];
    box.innerHTML = segs.length ? segs.map((g) => `<p class="sv-seg"><small class="num">${clock(g.start_ms)}</small>${g.speaker ? `<b>${esc(g.speaker)}</b> ` : ""}${esc(g.text)}</p>`).join("")
      : `<div class="empty">이 회차는 아직 전사가 없습니다</div>`;
    box.scrollTop = 0;
  }
  function renderSideLive() {
    if (!sv.on) return;
    const s = cap.status || {}, running = !!s.running;
    $("svLiveInfo").textContent = running ? `${({ finishing: "마무리 중", paused: "일시중단" })[s.state] || "듣는 중"} · ${clock((s.elapsed_s || 0) * 1000)}` : liveReady() ? "꺼짐" : "Gemini 키를 연결하면 켤 수 있습니다";
    const b = $("svLiveBtn");
    b.textContent = running ? "끄기" : "켜기"; b.disabled = s.state === "finishing" || (!running && !liveReady());
    const html = (s.lines || []).map((l) => `<p class="cap-line"><small>${clock(l.at * 1000)}</small>${esc(l.text)}</p>`).join("") + (running && s.interim ? `<p class="cap-interim">${esc(s.interim)}</p>` : "");
    if (html === sv.liveHtml) return;
    const body = $("svLive"), atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    body.innerHTML = html || `<div class="empty">${running ? "듣는 중… 첫 줄은 몇 초 뒤에 나옵니다" : "켜면 수업에서 하는 말이 여기에 바로 글로 나옵니다"}</div>`;
    sv.liveHtml = html;
    if (atBottom) body.scrollTop = body.scrollHeight;
  }

  async function onCaptions() {
    const s = await api.captions_status();
    if (s && s.running) {
      if (ui.view !== "lecture" && ui.view !== "home") { toast("가운데 칸에서 실시간 전사를 보고 있습니다"); return; }
      capPanel(); renderCaptions(s); return;
    }
    const course = capCourse();
    const quick = { label: "Gemini Live — 말하는 즉시 적기", value: true };
    const chirp = { label: "Chirp 3 확정 줄 — 더 정확, 15~25초 늦음, 월 60분 넘으면 Cloud 크레딧 (수업 내내 기록해 두기 좋음)", value: false };
    const pick = await dialog({ title: "실시간 자막", body: `${course || "과목 미지정"} — 무엇을 들을까요?\n마이크: 강의실 수업 · PC 소리: 온라인 강의·영상\n발표 날에는 Chirp만 켜 두면 [질의응답]을 켤 때 Gemini Live가 자동으로 더해집니다.`, ok: "마이크", extra: "PC 소리", cancel: "취소", checks: [quick, chirp] });
    if (!pick) return;
    if (!quick.value && !chirp.value) { toast("엔진을 하나 이상 고르세요"); return; }
    const source = pick === "extra" ? "pc" : "mic";
    const check = await api.captions_check(course);
    let consent = false, token = null;
    if (check.needs_consent && !check.once_only) {
      const q = await api.consent_confirm("google_live", course);
      if (!q.ok) { toast(q.error); return; }
      if (!q.yes) return;
      token = q.token;
    } else if (check.needs_consent) {
      consent = await dialog({ title: "실시간 자막을 켤까요?", body: `${check.notice}\n과목이 정해지지 않아 이번에만 적용합니다(저장하지 않음).`, ok: "켜기", cancel: "취소" });
      if (!consent) return;
    }
    const r = await api.captions_start(course, source, consent, token, chirp.value, quick.value);
    if (!r.ok) { toast(r.reason || "실시간 자막을 켜지 못했습니다"); return; }
    cap.last = ""; cap.liveHtml = ""; cap.error = "";
    if (ui.view === "lecture" || ui.view === "home") capPanel();  // the live view shows them in the middle pane
    toast("실시간 자막을 켰습니다"); pollCaptions();
  }

  /* ---------- presentation Q&A helper (2026-11-07): materials + live captions → Claude answer cards, button only ---------- */
  const qa = { timer: null, shown: false, last: "", deck: "", page: 1, pages: null, shownPage: 0, from: null, now: null, polled: 0, heard: "", fromHtml: "" };
  function qaPanel() {
    let p = document.querySelector(".qa-panel");
    if (!p) {
      p = document.createElement("div");
      p.className = "qa-panel";
      qa.last = ""; qa.heard = ""; qa.fromHtml = ""; qa.deck = "";  // a new (re-opened) panel is empty: draw everything again
      p.innerHTML = `<header><b>질의응답 도우미</b><span id="qaInfo"></span><span class="sp"></span><button class="ghost" id="qaEnd" title="도우미를 끕니다">끝내기</button><button class="ghost" id="qaClose" title="패널만 숨깁니다 — 도우미는 켜진 채로, [질의응답]을 누르면 다시 보입니다">숨기기</button></header>
        <div class="qa-deck" id="qaDeck" hidden><div class="qa-slide"><img id="qaSlide" alt=""><p class="hint" id="qaSlideNote"></p></div>
          <div class="qa-deck-bar"><button class="ghost" id="qaPrev" title="이전 슬라이드 (← · PageUp)">◀</button><span id="qaPage"></span><input id="qaGo" inputmode="numeric" placeholder="번호" title="슬라이드 번호로 가기 (Enter)"><button class="ghost" id="qaNext" title="다음 슬라이드 (→ · PageDown)">▶</button></div></div>
        <div class="qa-fromrow" id="qaFrom"></div><div class="qa-heard" id="qaHeard"></div>
        <div class="qa-row"><button class="ghost qa-mark" id="qaMark" title="지금부터 하는 말을 질문으로 (F7) — 위의 자막 줄을 눌러 그 줄부터로 고를 수도 있습니다">질문 시작 <small>F7</small></button><button class="primary qa-ask" id="qaAsk">HELP <small>F8</small></button>
          <form class="qa-type" id="qaTypeForm"><input id="qaType" placeholder="질문을 직접 쳐도 됩니다 — Enter" autocomplete="off"><button class="ghost">보내기</button></form></div>
        <div class="qa-cards" id="qaCards"></div><div class="cap-err" id="qaErr"></div>`;
      document.body.appendChild(p);
      p.querySelector("#qaAsk").onclick = () => qaAsk();
      p.querySelector("#qaMark").onclick = () => qaMark();
      p.querySelector("#qaFrom").onclick = (e) => { if (e.target.closest("[data-clear]")) { qa.from = null; qa.heard = ""; pollQa(); } };
      p.querySelector("#qaHeard").onclick = (e) => {  // a heard line: the question starts there (P-051); again: off
        const line = e.target.closest("[data-at]");
        if (!line) return;
        const at = +line.dataset.at;
        qa.from = qa.from === at ? null : at; qa.heard = ""; pollQa();
      };
      p.querySelector("#qaTypeForm").onsubmit = async (e) => {  // a typed question (P-050)
        e.preventDefault();
        const box = p.querySelector("#qaType"), text = box.value.trim();
        if (!text) return;
        const r = await api.qa_ask(text);
        if (!r.ok) { toast(r.reason || "보내지 못했습니다"); return; }
        box.value = "";
      };
      p.querySelector("#qaPrev").onclick = () => qaSlide(qa.page - 1);
      p.querySelector("#qaNext").onclick = () => qaSlide(qa.page + 1);
      p.querySelector("#qaGo").onkeydown = (e) => { if (e.key === "Enter") { qaSlide(parseInt(e.target.value, 10) || qa.page); e.target.value = ""; e.target.blur(); } };
      p.querySelector("#qaCards").onclick = (e) => { const t = e.target.closest("[data-slide]"); if (t) qaSlide(+t.dataset.slide); };
      p.querySelector("#qaEnd").onclick = async () => { await api.qa_stop(); toast("질의응답 도우미를 끕니다"); };
      p.querySelector("#qaClose").onclick = () => { p.remove(); qa.shown = false; };
    }
    qa.shown = true;
    return p;
  }
  async function qaSlide(page) {  // the deck in the panel (P-050): a cached PowerPoint→PDF page as an image
    if (!qa.deck) return;
    const max = qa.pages || 9999, want = Math.max(1, Math.min(page, max));
    qa.page = want;
    const p = qaPanel(), img = p.querySelector("#qaSlide"), note = p.querySelector("#qaSlideNote");
    p.querySelector("#qaPage").textContent = `${want}${qa.pages ? " / " + qa.pages : ""}`;
    const r = await api.material_preview(qa.deck, want);
    if (qa.page !== want) return;  // flipped again meanwhile
    if (r && r.page_count) qa.pages = r.page_count;
    p.querySelector("#qaPage").textContent = `${want}${qa.pages ? " / " + qa.pages : ""}`;
    if (r && r.url) { img.src = r.url; img.hidden = false; note.textContent = ""; qa.shownPage = want; return; }
    img.hidden = true;
    note.textContent = r && r.deferred ? "녹음 중이라 슬라이드를 PDF로 바꾸지 못했습니다 — 녹음 전에 한 번 열어 두면 됩니다"
      : (r && r.error) || "이 슬라이드를 그리지 못했습니다";
  }
  async function qaAsk() {  // with a chosen start (P-051) the question is the words from there, else since the last HELP
    const r = await api.qa_ask("", qa.from);
    if (!r.ok) { toast(r.reason || "요청하지 못했습니다"); return; }
    qa.from = null; qa.heard = "";
  }
  function qaMark() {  // [질문 시작]: the captions clock now (status gives it at each poll; add the time since)
    if (qa.now == null) { toast("자막이 꺼져 있어 시작점을 잡을 수 없습니다"); return; }
    qa.from = Math.round((qa.now + (Date.now() - qa.polled) / 1000) * 10) / 10; qa.heard = ""; pollQa();
  }
  const mmss = (s) => {  // captions clock: 05:07, or 1:56:18 past an hour (like the captions file)
    const t = Math.floor(s), mm = String(Math.floor(t % 3600 / 60)).padStart(2, "0"), ss = String(t % 60).padStart(2, "0");
    return t >= 3600 ? `${Math.floor(t / 3600)}:${mm}:${ss}` : `${mm}:${ss}`;
  };
  const slideLinks = (html) => qa.deck ? html.replace(/(슬라이드|slide)\s*(\d{1,3})/gi, (m, w, n) => `<a class="qa-slide-link" data-slide="${n}" title="이 슬라이드 보기">${m}</a>`) : html;
  const dimSources = (html) => html.replace(/\[[^\[\]<>]{1,60}\]/g, (m) => `<span class="qa-src">${m}</span>`);  // [덱 p.12] · [수업 전사 12:34]
  const why = (text) => `<p class="qa-why">${slideLinks(dimSources(esc(text)))}</p>`;
  function qaPrepared(list) {  // prepared answers matched at once from the pack's expected questions (P-046)
    // via "words": letters heard (0 s); via "claude": Claude named it on its first line (~1.5 s, by meaning)
    return (list || []).map((x) => `<div class="qa-prep"><p class="qa-q">준비한 답 · ${esc(x.id)} · ${esc(x.q)}${x.asked ? " · 실제로 받은 질문" : ""}` +
      `${x.via === "claude" ? ` <span class="qa-via" title="Claude가 질문의 뜻을 보고 고른 예상 질문">Claude가 고름</span>` : ""}</p>` +
      `<p class="qa-a">${esc(x.answer)}</p>${(x.basis || []).slice(0, 2).map(why).join("")}` +
      `${x.caution ? `<p class="qa-warn">⚠ ${esc(x.caution)}</p>` : ""}</div>`).join("");
  }
  function qaCard(c) {
    if (c.error && !c.answer && !(c.prepared || []).length) return `<div class="qa-card err">${esc(c.error)}</div>`;
    // layout review 2026-11-09: the question on top; once Claude's 답 line is in, its answer comes first and the
    // prepared answers move below (smaller); before that (first 1–2 s) the prepared answers lead
    const rows = String(c.answer || "").split(/\r?\n/).filter((l) => l.trim());
    let question = "", answered = false;
    const mine = rows.map((l) => {
      const t = l.trim();
      if (/^질문\s*:/.test(t)) { question = t.replace(/^질문\s*:\s*/, ""); return ""; }
      if (/^답\s*:/.test(t)) { answered = true; return `<p class="qa-a">${esc(t.replace(/^답\s*:\s*/, ""))}</p>`; }
      if (/^주의\s*:/.test(t)) return `<p class="qa-warn">⚠ ${esc(t.replace(/^주의\s*:\s*/, ""))}</p>`;
      if (/^근거\s*:?\s*$/.test(t)) return "";
      return why(t.replace(/^[-•]\s*/, ""));
    }).join("");
    const preps = (c.prepared || []).length ? `<div class="qa-preps${answered ? " later" : ""}">${qaPrepared(c.prepared)}</div>` : "";
    const claude = `${preps ? `<p class="qa-who">Claude</p>` : ""}${mine || `<p class="qa-why">생각 중…</p>`}`;
    const top = (c.typed ? `<p class="qa-typed">직접 입력 · ${esc(c.transcript)}</p>` : "") + (question ? `<p class="qa-qline">${esc(question)}</p>` : "");
    const meta = c.done ? (c.first_s != null ? `첫 줄 ${c.first_s}초 · 끝 ${c.total_s}초` : "") : "쓰는 중…";
    return `<div class="qa-card${c.done ? "" : " live"}">${top}${answered ? claude + preps : preps + claude}<small>${esc(meta)}${c.error ? " · " + esc(c.error) : ""}</small></div>`;
  }
  function renderQa(s) {
    if (s && s.state === "unknown") return;  // status file unreadable for a moment: keep what is on screen
    const btn = $("qaBtn"), running = !!(s && s.running);
    btn.classList.toggle("on", running);
    btn.textContent = running ? (s.state === "loading" ? "질의응답 ● 준비 중" : "질의응답 ●") : "질의응답";
    if (!qa.shown || !s) return;
    const p = qaPanel(), capt = s.captions || {};
    const deck = (s.pack && s.pack.deck) || "";
    if (deck !== qa.deck) {
      qa.deck = deck; qa.page = 1; qa.pages = null; qa.last = "";
      p.querySelector("#qaDeck").hidden = !deck;
      p.classList.toggle("with-deck", !!deck);
      if (deck) qaSlide(1);
    }
    const n = (s.sources || []).filter((x) => x.units).length;
    p.querySelector("#qaInfo").textContent = `${s.pack ? s.pack.title + (s.pack.questions ? ` (예상 질문 ${s.pack.questions})` : "") : s.course || ""} · ${running ? ({ loading: "자료 읽는 중", ready: "준비됨", answering: "답 쓰는 중" }[s.state] || s.state) : "꺼짐"}` +
      (s.pack_chars ? ` · 자료 ${n}개 ${Math.round(s.pack_chars / 1000)}천 자` : "") + (s.class_chars ? ` · 수업 전사 ${Math.round(s.class_chars / 1000)}천 자` : "") +
      (capt.confirmed && capt.hints ? ` · 용어 힌트 ${capt.hints}` : "");
    p.querySelector("#qaInfo").title = [p.querySelector("#qaInfo").textContent, ...(s.sources || []).map((x) => `${x.units ? "✓" : "–"} ${x.file}${x.cut ? " (일부)" : ""}`)].join("\n");
    p.querySelector("#qaAsk").disabled = !running || s.state !== "ready";
    qa.now = capt.running && capt.now != null ? capt.now : null; qa.polled = Date.now();
    const from = qa.from;  // the chosen question start (P-051): lines from there are marked
    const fromHtml = from != null ? `질문 시작 ${mmss(from)} — 이 뒤의 말로 답합니다 <a data-clear="1" title="시작점 지우기">✕</a>` : "";
    if (fromHtml !== qa.fromHtml) { p.querySelector("#qaFrom").innerHTML = fromHtml; qa.fromHtml = fromHtml; }  // outside the scroll box: always seen
    p.classList.toggle("has-from", from != null);
    const heard = (capt.recent || []).slice(-6).map((l) => `<p class="qa-line${from != null && l.at >= from ? " sel" : ""}" data-at="${l.at}" title="이 줄부터를 질문으로"><small>${mmss(l.at)}</small>${esc(l.text)}</p>`).join("") +
      (capt.interim ? `<p class="cap-interim">${esc(capt.interim)}</p>` : "");
    const heardHtml = capt.running ? (capt.quick ? heard || `<p class="cap-interim">듣는 중…</p>` : `<p class="cap-interim">Gemini Live 켜는 중…</p>`) : `<p class="cap-interim">자막이 꺼져 있습니다</p>`;
    if (heardHtml !== qa.heard) { const box = p.querySelector("#qaHeard"); box.innerHTML = heardHtml; box.scrollTop = box.scrollHeight; qa.heard = heardHtml; }
    p.querySelector("#qaMark").disabled = !running || !capt.running;
    const html = (s.cards || []).slice().reverse().map(qaCard).join("");
    if (html !== qa.last) { p.querySelector("#qaCards").innerHTML = html; qa.last = html; }
    p.querySelector("#qaErr").textContent = s.error || "";
  }
  async function pollQa() {
    if (!ed("qa") && !qa.shown) return;  // edition without the Q&A helper: nothing to watch
    let s = null;
    try { s = await api.qa_status(); } catch (err) { /* keep polling */ }
    renderQa(s);
    clearTimeout(qa.timer);
    qa.timer = setTimeout(pollQa, (s && s.running) || qa.shown ? 400 : 15000);
  }
  async function onQa() {
    const s = await api.qa_status();
    if (s && s.running) { qaPanel(); renderQa(s); return; }
    openQaSetup();
  }
  /* which presentation (P-046): packs are made and edited in Claude Code (skill qa-pack); here only [시작]
     (user 2026-11-07: the prepare/folder/files/new buttons go, "code로 할거니까"). The line under the list says
     whether today's class is being captioned, because the helper reads it too (the professor's earlier remarks, P-049). */
  function openQaSetup() {
    if (document.querySelector(".qa-setup")) return;
    const scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.innerHTML = `<div class="dialog qa-setup" role="dialog"><h4>질의응답 도우미 — 어느 발표?</h4>
      <div class="qa-packs" id="qaPacks"><div class="hint">불러오는 중…</div></div>
      <p class="qa-class" id="qaClass"></p>
      <div class="acts"><span class="sp"></span><button data-qclose="1">닫기</button></div></div>`;
    document.body.appendChild(scrim);
    let packs = [];
    const close = () => { scrim.remove(); document.removeEventListener("keydown", key); };
    const key = (e) => { if (isTop(scrim) && e.key === "Escape") close(); };
    document.addEventListener("keydown", key);
    const kchars = (n) => `${Math.max(1, Math.round(n / 1000))}천 자`;
    const render = () => {
      scrim.querySelector("#qaPacks").innerHTML = packs.map((p) => {
        const bits = [p.course, p.digest_chars ? `요약본 ${kchars(p.digest_chars)}` : "요약본 없음",
          ...(p.extra_chars ? [`참고 ${kchars(p.extra_chars)}`] : []), `예상 질문 ${p.questions}개`,
          ...(p.read_folder === false ? [] : [p.folder_ok ? "자료 폴더도 읽음" : "자료 폴더 없음"])];
        const ready = (p.read_folder !== false && p.folder_ok) || p.digest_chars || p.questions;
        return `<div class="qa-pack"><div class="qp-main"><b>${esc(p.title)}</b><small title="${esc(p.path)}">${esc(bits.join(" · "))}</small></div>` +
          `<button class="primary" data-qstart="${esc(p.id)}"${ready ? "" : " disabled"}>시작</button></div>`;
      }).join("") || `<div class="hint">아직 발표가 없습니다. Claude Code에서 /qa-pack으로 만드세요.</div>`;
    };
    const classLine = async () => {
      const c = await api.captions_status();
      const eng = (c && c.engines) || {};
      scrim.querySelector("#qaClass").textContent = !(c && c.running)
        ? "자막이 꺼져 있습니다 — 앞서 수업에서 나온 말(다른 조 피드백 등)까지 반영하려면 수업 시작 때 [자막]에서 Chirp를 켜 두세요."
        : eng.confirmed ? `자막 켜짐(Chirp) — 지금까지의 수업 자막 ${c.line_count || 0}줄도 함께 읽습니다.`
          : "자막 켜짐(Gemini만) — 수업 내용도 읽지만 Chirp보다 덜 정확합니다.";
    };
    const load = async () => { const r = await api.qa_packs(); packs = (r && r.packs) || []; render(); };
    const start = async (p) => {
      const check = await api.qa_check(p.course);
      let tokenQa = null, tokenLive = null;
      for (const provider of check.needs || []) {
        const q = await api.consent_confirm(provider, p.course);
        if (!q.ok) { toast(q.error); return; }
        if (!q.yes) return;
        if (provider === "claude_qa") tokenQa = q.token; else tokenLive = q.token;
      }
      const r = await api.qa_start(p.course, "", tokenQa, tokenLive, "sonnet", p.id);
      if (!r.ok) { toast(r.reason || "질의응답 도우미를 켜지 못했습니다"); return; }
      close(); qa.last = ""; qaPanel(); toast("자료를 읽는 중입니다(약 10초)"); pollQa();
    };
    scrim.addEventListener("click", async (e) => {
      if (e.target === scrim || e.target.closest("[data-qclose]")) { close(); return; }
      const t = e.target.closest("[data-qstart]");
      if (!t || t.disabled) return;
      const p = packs.find((x) => x.id === t.dataset.qstart);
      if (!p) return;
      t.disabled = true; await start(p); t.disabled = false;
    });
    load(); classLine();
  }

  const hm = (ms) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
  function quotaTitle() {
    const q = ui.quota;
    if (!q) return "Google 전사 한도 확인 중";
    if (!q.ok) return "Google 전사 한도를 읽지 못함: " + (q.error || "");
    const perLecture = Math.ceil(110 * 60 / (q.chunk_s || 1200));
    const lines = [`오늘 남은 Google 전사 요청: ${q.remaining}회 (하루 ${q.limit}회)`,
      `요청 1회 = ${Math.round((q.chunk_s || 1200) / 60)}분 조각 1개 · 110분 수업 ≈ ${perLecture}회 → 수업 약 ${Math.floor(q.remaining / perLecture)}개분`,
      `Google 기준(태평양 날짜) 오늘 ${q.used}회 사용 · ${hm(q.provider_reset_at)}에 다시 채워짐`,
      `내 예산(한국 날짜) 하루 ${q.personal_budget}회 중 ${q.used_personal}회 사용 · ${hm(q.personal_reset_at)}에 초기화`,
      "남은 횟수는 둘 중 적은 쪽입니다"];
    lines.push("이 앱이 보낸 요청만 셉니다(다른 곳에서 같은 키를 쓰면 실제로는 더 적을 수 있음)");
    return lines.join("\n");
  }

  /* ---------- sidebar: course tree — every course collapsed until clicked (user 2026-09-29) ---------- */
  function renderSide() {
    const st = ui.state || {}, live = ["starting", "recording", "stopping"].includes(st.phase);
    const recCourse = live ? (st.status && st.status.course) || ui.course : null;
    const side = ui.side && ui.side.ok ? ui.side : null;
    const counts = {}; (side ? side.courses : []).forEach((c) => { counts[c.folder] = c.count; });
    const folders = ui.info.courses.map((c) => c.folder);
    (side ? side.courses : []).forEach((c) => { if (!folders.includes(c.folder)) folders.push(c.folder); });
    const extraSet = new Set((side ? side.courses : []).filter((c) => c.extra).map((c) => c.folder));
    const todayIso = ui.info.today_iso, selected = ui.view === "lecture" && ui.lecture ? ui.lecture.id : null;
    const byCourse = {};
    (side ? side.groups : []).forEach((g) => g.items.forEach((it) => { (byCourse[it.course] = byCourse[it.course] || []).push(it); }));
    Object.values(byCourse).forEach((list) => list.sort((a, b) => b.date.localeCompare(a.date) || b.n - a.n));
    const open = ui.open || (ui.open = new Set());
    const row = (f) => {
      const items = byCourse[f] || [], slot = ui.info.today.find((s) => s.folder === f), todayL = items.find((it) => it.date === todayIso);
      const tail = recCourse === f ? `<span class="live"><i class="dot rec"></i>녹음 중</span>`
        : slot && !todayL ? `<span class="meta num">오늘 ${esc(slot.start)}</span>` : counts[f] ? `<span class="count num">${counts[f]}</span>` : "";
      const html = `<div class="item crs${open.has(f) ? " open" : ""}" data-toggle="${esc(f)}"><svg class="chev"><use href="#i-right"/></svg>${esc(f)}${tail}</div>`;
      if (!open.has(f)) return html;
      let sub = extraSet.has(f) ? "" : `<div class="item sub files" data-files="${esc(f)}"><svg><use href="#i-folder"/></svg>자료</div>`;
      if (slot && !todayL) sub += `<div class="item sub" data-course="${esc(f)}"><span class="d num">오늘</span>${esc(slot.start)} 수업 · 녹음 전</div>`;
      sub += items.map((it) => `<div class="item sub${it.id === selected ? " sel" : ""}" data-lecture="${it.id}"><span class="d num">${it.date === todayIso ? "오늘" : mdText(it.date)}</span>${esc(it.label)}<span class="meta">${it.reviewable ? "✓" : ""}</span></div>`).join("");
      return html + `<div class="subs">${sub || `<div class="item sub dim">회차 없음</div>`}</div>`;
    };
    let html = folders.filter((f) => !extraSet.has(f)).map(row).join("") +
      (extraSet.size ? `<div class="slabel">수업 외</div>` + [...extraSet].map(row).join("") : "");
    if (!side && ui.side) html += `<div class="item dim" title="${esc(ui.side.error)}">라이브러리를 열 수 없음 — 녹음은 계속 됩니다</div>`;
    if ($("courseList").dataset.h !== html) { $("courseList").innerHTML = html; $("courseList").dataset.h = html; }
    const holds = side ? side.holds : 0;
    setp($("inboxBadge"), "hidden", !holds); sett($("inboxBadge"), holds || "");
  }

  /* ---------- start screen: this month's calendar + today's to-do (user 2026-09-29: "C안처럼") ---------- */
  function dayAttrs(iso, today, count) {
    const [y, m, d] = iso.split("-").map(Number), wd = "일월화수목금토"[new Date(y, m - 1, d).getDay()];
    const stop = today && today.slice(0, 7) === iso.slice(0, 7) ? iso === today : d === 1;
    return ` role="button" tabindex="${stop ? 0 : -1}" aria-label="${m}월 ${d}일 ${wd}요일${iso === today ? ", 오늘" : ""}${count ? `, 일정 ${count}개` : ""}"`;
  }
  document.addEventListener("keydown", (e) => {
    const cell = e.target.closest && e.target.closest(".day[data-day]");
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (!cell || !step || e.target !== cell) return;
    const all = [...cell.parentElement.querySelectorAll(".day[data-day]")], next = all[all.indexOf(cell) + step];
    if (!next) return;
    e.preventDefault(); all.forEach((x) => { x.tabIndex = -1; }); next.tabIndex = 0; next.focus();
  });
  async function renderHome() {
    const now = new Date(), H = ui.home || (ui.home = { year: now.getFullYear(), month: now.getMonth() + 1 });
    const [r, board] = await Promise.all([api.calendar(H.year, H.month), api.etl_board()]);
    showExamChip(r);  // next_exam does not depend on the month shown: no second calendar call
    if (ui.view !== "home") return;
    ui.homeData = r; ui.homeBoard = board.ok ? board : null;
    $("homeTitle").textContent = `${H.year}년 ${H.month}월`;
    if (!r.ok) { $("homeGrid").innerHTML = `<div class="hint">달력을 열 수 없습니다: ${esc(r.error)}</div>`; renderTodo(null); return; }
    const first = new Date(H.year, H.month - 1, 1), days = new Date(H.year, H.month, 0).getDate(), lead = (first.getDay() + 6) % 7;
    const byDay = {}; r.events.forEach((e) => { (byDay[e.date] = byDay[e.date] || []).push(e); });
    const exc = {}; r.exceptions.forEach((e) => { (exc[e.date] = exc[e.date] || []).push(e); });
    let html = "월화수목금토일".split("").map((d) => `<div class="dow">${d}</div>`).join("") + "<div></div>".repeat(lead);
    for (let d = 1; d <= days; d++) {
      const iso = `${H.year}-${String(H.month).padStart(2, "0")}-${String(d).padStart(2, "0")}`, list = byDay[iso] || [];
      const items = list.slice(0, 3).map((e) => `<div class="ev k-${e.kind}${e.source === "etl" ? " etl" : ""}" data-ev="${e.id}" title="${esc(e.title + (e.note ? " — " + e.note : ""))}">${e.course ? esc(e.course) + " " : ""}${esc(e.kind_label)}</div>`).join("");
      const ex = (exc[iso] || []).map((e) => `<div class="ex" title="${esc(e.note)}">${esc(e.course)} ${esc(e.kind)}${e.confirmation === "confirmed_by_user" ? "" : "(추정)"}</div>`).join("");
      html += `<div class="day${iso === r.today ? " today" : ""}" data-day="${iso}"${dayAttrs(iso, r.today, list.length)}><span class="n">${d}</span>${ex}${items}${list.length > 3 ? `<div class="more">+${list.length - 3}</div>` : ""}</div>`;
    }
    $("homeGrid").innerHTML = html;
    renderTodo(r);
  }

  function renderTodo(r) {
    const now = new Date(), mins = now.getHours() * 60 + now.getMinutes(), todayIso = ui.info.today_iso;
    const side = ui.side && ui.side.ok ? ui.side : null, lectures = {};
    (side ? side.groups : []).forEach((g) => g.items.forEach((it) => { if (it.date === todayIso) lectures[it.course] = it; }));
    // closures today: confirmed on the calendar (whole day) or a registered 휴강 exception
    const closed = (folder) => r && (r.events.some((e) => e.kind === "closure" && e.date === todayIso && e.date_precision === "day" && (!e.course || e.course === folder)) ||
      r.exceptions.some((e) => e.date === todayIso && e.kind === "휴강" && (!e.course_id || e.course === folder)));
    const classes = ui.info.today.map((s) => {
      const L = lectures[s.folder], [h, m] = s.start.split(":").map(Number), started = mins >= h * 60 + m;
      const st = L ? (L.reviewable ? "복습 가능" : "녹음됨") : closed(s.folder) ? "휴강" : started ? "지금·지난 수업" : "예정";
      return `<div class="td" ${L ? `data-lecture="${L.id}"` : `data-course="${esc(s.folder)}"`}><span class="when num">${esc(s.start)}</span><span class="what">${esc(s.folder)}</span><span class="st">${st}</span></div>`;
    }).join("");
    const soon = r ? r.upcoming.filter((e) => e.d_day >= 0 && e.d_day <= 21) : [];
    const due = soon.map((e) => `<div class="td" data-ev="${e.id}" data-date="${e.date}"><span class="dd${e.d_day <= 2 ? " urgent" : ""}">${dday(e.d_day)}</span>` +
      `<span class="what">${e.course ? esc(e.course) + " · " : ""}${esc(e.title)}<small>${mdText(e.date)}${e.start_ms !== null ? " " + hhmm(e.start_ms) : ""} · ${esc(e.kind_label)}</small></span>` +
      (e.kind === "assignment" && ed("assignment") ? `<span class="hw-acts"><button class="mini" data-hw="${e.id}" title="과제 파일·작성요령·관련 수업 노트를 모아 Claude Code로 과제를 시작합니다">과제 준비</button><button class="mini" data-hwopen="${e.id}" title="모아 둔 과제 폴더 열기">폴더</button></span>` : "") + `</div>`).join("");
    const holds = side ? side.holds : 0, cands = r ? r.candidates.length : 0;
    const checks = (holds ? `<div class="td" data-inbox="1"><span class="dd">${holds}건</span><span class="what">확인함 — 어느 수업 것인지 골라 줄 녹음·파일</span></div>` : "") +
      (cands ? `<div class="td" data-cands="1"><span class="dd">${cands}건</span><span class="what">달력 후보 — 수업 중 언급된 날짜</span></div>` : "") + etlTodo();
    $("todo").innerHTML = `<div class="sl">오늘 수업</div>${classes || `<div class="none">오늘은 수업이 없습니다</div>`}` +
      `<div class="sl">마감·시험 (3주 안)</div>${due || `<div class="none">3주 안에 잡힌 일정이 없습니다</div>`}` +
      (checks ? `<div class="sl">확인할 것</div>${checks}` : "");
  }

  /* eTL on the home list: announcements of the last 7 days and course files not in the course folder yet */
  function etlTodo() {
    const b = ui.homeBoard; if (!b) return "";
    const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const fresh = b.announcements.filter((a) => a.posted.slice(0, 10) >= since);
    return (fresh.length ? `<div class="td" data-cands="1"><span class="dd">${fresh.length}건</span><span class="what">eTL 새 공지<small>${esc(fresh.slice(0, 2).map((a) => a.course + " · " + a.title).join(" / "))}</small></span></div>` : "") +
      (b.files.length ? `<div class="td" data-cands="1"><span class="dd">${b.files.length}개</span><span class="what">eTL 자료 — 과목 폴더에 없는 파일<small>${b.files.some((f) => f.case === "etl" || f.case === "both") ? "eTL에서 바뀐 자료 있음" : b.files.some((f) => f.state === "changed") ? "내가 고친 파일 확인" : "받기·옮기기"}</small></span></div>` : "");
  }

  /* schedule notices heard in class (AI reads the whole transcript, user request 2026-10-30): a banner until "확인함" */
  async function loadNotices() {
    if (!api || !api.notices) return;
    const r = await api.notices();
    if (!r || !r.ok) return;
    // decided on the calendar already (confirmed or ignored): nothing left to tell
    const done = r.unseen.filter((n) => n.status === "confirmed" || n.status === "cancelled").map((n) => n.key);
    if (done.length) api.notices_seen(done);
    ui.notices = r.unseen.filter((n) => !done.includes(n.key));
    renderNotices();
  }

  function renderNotices() {
    const bar = $("noticeBar"), list = ui.notices || [];
    bar.hidden = !list.length;
    if (!list.length) { bar.innerHTML = ""; return; }
    const when = (n) => n.date ? `${dayText(n.date)}${n.date_precision === "approx" ? " 쯤" : ""}` : "날짜 미정";
    const who = { professor: "교수", ta: "조교", student: "학생" };
    const rows = list.slice(0, 4).map((n) => `<div class="nb-item" data-key="${esc(n.key)}">
      <div class="nb-head"><b>${esc(n.course)} · ${esc(when(n))} · ${esc(n.kind_label)}</b><span class="nb-cert c-${esc(n.certainty)}">확신도 ${esc(n.certainty_label)}</span></div>
      <div class="nb-sum">${esc(n.summary)}</div>
      <div class="nb-quote">“${esc(n.quote)}”<small>${esc(mdText(n.lecture_date))} 수업 ${Math.floor((n.at_ms || 0) / 60000)}분경 · ${esc(n.engines.join("·"))}${who[n.speaker] ? " · " + who[n.speaker] : ""}</small></div>
      ${n.date_reasoning ? `<div class="nb-why">날짜 근거: ${esc(n.date_reasoning)}</div>` : ""}
      ${n.stt_note ? `<div class="nb-why">잘못 들렸을 수 있음(추정): ${esc(n.stt_note)}</div>` : ""}
      <div class="nb-acts">${n.event_id && n.date ? `<button class="mini" data-nb-cal="${esc(n.key)}">달력에서 확정·무시</button>` : ""}<button class="mini" data-nb-seen="${esc(n.key)}">확인함</button></div></div>`).join("");
    bar.innerHTML = `<div class="nb-top"><b>수업 중 공지 ${list.length}건</b><small>AI가 전사본 전체를 읽고 찾은 것 · 확정 전까지는 후보</small><span class="grow"></span>${list.length > 1 ? `<button class="mini" data-nb-all="1">모두 확인함</button>` : ""}</div>${rows}${list.length > 4 ? `<div class="nb-more">외 ${list.length - 4}건</div>` : ""}`;
  }

  function bindNotices() {
    $("noticeBar").addEventListener("click", async (ev) => {
      const t = ev.target.closest("button"); if (!t) return;
      const list = ui.notices || [];
      if (t.dataset.nbAll) { await api.notices_seen(list.map((n) => n.key)); ui.notices = []; renderNotices(); return; }
      if (t.dataset.nbSeen) { await api.notices_seen([t.dataset.nbSeen]); ui.notices = list.filter((n) => n.key !== t.dataset.nbSeen); renderNotices(); return; }
      if (t.dataset.nbCal) {
        const n = list.find((x) => x.key === t.dataset.nbCal); if (!n) return;
        openCalendar(+n.date.slice(0, 4), +n.date.slice(5, 7), { id: n.event_id });
      }
    });
    window.__lecturehubNotices = loadNotices;  // app.py calls this when a new notice is found
  }

  function goHome() {
    ui.view = "home"; setHtmlSize("pane");
    renderAll(); renderHome();
  }

  /* ---------- dock ---------- */
  const wave = $("wave"); for (let i = 0; i < 14; i++) wave.appendChild(document.createElement("i"));
  function renderWave(rms) {
    const v = rms === null || rms === undefined ? 0 : Math.max(0, Math.min(1, (rms + 70) / 55));
    ui.levels.push(v); if (ui.levels.length > 14) ui.levels.shift();
    wave.querySelectorAll("i").forEach((b, i) => { const x = ui.levels[i] ?? 0; setp(b.style, "transform", `scaleY(${+((4 + x * 18) / 22).toFixed(3)})`); });  // 4–22 px of a 22 px bar
  }

  function healthHtml(st) {
    const s = st.status || {}, sum = st.summary;
    if (st.phase === "starting") return `<span><i class="dot wait"></i>녹음 엔진 시작 중…</span>`;
    if (st.phase === "recording") {
      if (s.paused) return `<span class="warn"><i class="dot wait"></i>일시정지 중 — 지금 소리는 저장하지 않습니다 · <span class="link" data-act="resume">다시 녹음</span></span><span class="num faint">${esc(shortDevice(s.device))}</span>`;
      // PC sound is recorded only while something plays: no samples arrive in silence, so the timer stands still too
      if (s.mode === "loopback" && (s.rms === null || s.rms === undefined)) return `<span class="warn"><i class="dot wait"></i>PC에서 소리가 나지 않는 중 — PC 소리는 날 때만 저장되고, 녹음 시간도 그때만 갑니다</span><span class="num faint">${esc(shortDevice(s.device))}</span>`;
      if (s.quiet) return `<span class="warn"><i class="dot warn"></i>소리 매우 작음 (30초 이상)</span><span class="num faint">${db(s.rms)} · ${esc(shortDevice(s.device))}</span>`;
      if (s.dropped_samples || s.capture_status_count) return `<span class="warn"><i class="dot warn"></i>캡처 누락 ${s.dropped_samples || 0} · 경고 ${s.capture_status_count || 0}</span><span class="num faint">${db(s.rms)}</span>`;
      const pc = st.pc && st.pc.status ? ` · PC 소리 ${db(st.pc.status.rms)}` : st.pc && st.pc.state === "error" ? " · PC 소리 녹음 안 됨" : "";
      const lv = st.live && st.live.state === "running" ? " · 녹음 중 전사" : "";
      return `<span><i class="dot ok"></i>소리 정상</span><span class="num faint">${db(s.rms)} · ${esc(shortDevice(s.device))}${pc}${lv}</span>`;
    }
    if (st.phase === "stopping") return `<span><i class="dot wait"></i>녹음 끝내는 중…</span>`;
    if (st.phase === "finalizing") return `<span><i class="dot wait"></i>저장 중(병합)… ${fmt(sum && sum.total_ms)}</span>`;
    if (st.phase === "done" && sum && sum.discarded) {
      const t = sum.recycled ? "녹음을 버렸습니다 · 휴지통으로 옮김" : sum.recycle_error ? "녹음은 멈췄지만 휴지통으로 옮기지 못함: " + esc(sum.recycle_error) : "녹음을 버리는 중…";
      return `<span><i class="dot ${sum.recycle_error ? "warn" : "wait"}"></i>${t}</span>`;
    }
    if (st.phase === "done" && sum) {
      const warn = sum.partial || sum.finalize_error;
      let html = sum.auto_stop ? `<span class="warn"><i class="dot warn"></i>${esc(sum.auto_stop.reason)} · 소리 없는 뒷부분은 회차 화면의 [자르기]로 뺄 수 있습니다</span>` : "";
      html += `<span class="${warn ? "warn" : ""}"><i class="dot ${warn ? "warn" : "ok"}"></i>저장됨 · <span class="num">${fmt(sum.total_ms)}</span> · 누락 ${sum.dropped_samples || 0}${sum.paused_ms ? " · 일시정지 " + fmt(sum.paused_ms) + " 제외" : ""}${sum.bookmarks ? " · ★ " + sum.bookmarks : ""}${st.pc ? (st.pc.state === "error" ? " · PC 소리 저장 실패" : st.pc.state === "done" ? " · PC 소리 따로 저장" : " · PC 소리 저장 중…") : ""}</span>`;
      html += `<span class="link" data-act="folder" title="${esc(sum.session_dir)}">저장 위치</span>`;
      const link = st.link || {};
      if (link.state === "short") html += `<span class="warn">1분 미만 녹음 — 실수로 누른 거면 버리세요</span><span class="link danger-t" data-act="short-discard">버리기</span><span class="link" data-act="short-keep">회차에 남기기</span>`;
      else if (link.state === "discarding") html += `<span class="faint">휴지통으로 보내는 중…</span>`;
      else if (link.state === "discarded") html += `<span class="faint">버렸습니다(녹음 정리에서 되살릴 수 있음)</span>`;
      else if (link.state === "discard_failed") html += `<span class="warn" title="${esc(link.reason || "")}">버리지 못했습니다${link.reason ? ": " + esc(link.reason) : ""} — 녹음은 그대로 있습니다</span><span class="link" data-act="sessions">녹음 정리에서 다시</span>`;
      else if (link.state === "linking") html += `<span class="faint">회차 연결 중…</span>`;
      else if (link.state === "linked") html += `<span class="link" data-act="open-linked" title="${esc(link.reason || "")}">회차 열기${link.confidence === "medium" ? "(추정)" : ""}</span>`;
      else if (link.state === "pending") html += `<span class="link warn" data-act="confirm-pending" title="${esc(link.reason || "")}">미확정 회차 · 과목 확인</span>`;
      else if (link.state === "error") html += `<span class="warn" title="${esc(link.reason || "")}">회차 연결 실패(녹음은 저장됨)</span>`;
      const tr = st.transcription;
      if (tr) html += `<span class="${tr.state === "failed" ? "err" : ""}">전사 ${esc(tr.label || "시작됨")}${tr.auto ? " · 자동" : ""}</span>`;
      else if (sum.master && !["linking", "pending", "short", "discarding", "discarded", "discard_failed"].includes(link.state)) html += `<span class="link" data-act="transcribe">Google 전사 시작 →</span>`;
      return html;
    }
    if (st.phase === "error") return `<span class="err"><i class="dot rec"></i>${esc(st.error || "오류")}</span>`;
    const p = st.probe;
    if (!p) return `<span><i class="dot wait"></i>소리 점검 준비 중…</span>`;
    if (p.running) return `<span><i class="dot wait"></i>소리 점검 중… ${Math.ceil((p.remaining_ms || 0) / 1000)}초</span><span class="num faint">${p.peak === undefined || p.peak === null ? "" : db(p.peak)}</span>`;
    const where = ui.pc && !ui.mic ? "PC 소리" : "마이크";  // the probe checks the chosen source
    const text = { ok: `${where} 점검 정상`, quiet: "소리가 작아요 — 말해서 확인해 보세요", silent: "입력이 거의 없음 — 조용한 곳이면 정상", no_data: "소리가 들어오지 않음 — 장치 확인", error: `${where}를 열 수 없음` }[p.verdict] || "점검 완료";
    const tone = p.verdict === "ok" ? "ok" : p.verdict === "error" || p.verdict === "no_data" ? "rec" : "wait";
    return `<span class="${tone === "rec" ? "err" : ""}"><i class="dot ${tone}"></i>${text}</span><span class="num faint">${p.verdict === "error" ? esc(p.message || "") : db(p.peak)}</span><span class="link" data-act="probe">다시 점검</span>`;
  }

  function renderDock() {
    const st = ui.state || {}, phase = st.phase, live = phase === "recording";
    const btn = $("recBtn");
    btn.classList.toggle("on", live || phase === "stopping");
    btn.classList.toggle("busy", ["starting", "stopping", "finalizing"].includes(phase));
    sett(btn.querySelector(".label"), phase === "starting" ? "시작 중…" : phase === "finalizing" ? "저장 중…" : "녹음 시작");
    const paused = live && !!(st.status && st.status.paused);
    sett($("timer"), (paused ? "일시정지 " : "") + fmt(st.status && st.status.elapsed_ms));
    btn.classList.toggle("paused", paused);
    if (live) renderWave(paused ? null : st.status && st.status.rms);
    $("starBtn").classList.toggle("dis", !live || paused);
    $("pauseBtn").classList.toggle("dis", !live);
    $("discardBtn").classList.toggle("dis", !live);
    $("pauseBtn").classList.toggle("on", paused);
    sett($("pauseLabel"), "");  // icon only (toolbar width); the timer and status line say "일시정지"
    setp($("pauseBtn"), "title", paused ? "다시 녹음 — 이어서 저장합니다" : "녹음 일시정지 — 쉬는 시간 등. 멈춘 동안의 소리는 저장하지 않습니다");
    const locked = ["starting", "recording", "stopping", "finalizing"].includes(phase);
    $("courseBtn").classList.toggle("off", locked);
    $("srcBtn").classList.toggle("off", locked);
    document.querySelector(".dock").classList.toggle("live", live);  // pause · 중요 · 버리기 appear only now
    // second source on its own (user 2026-09-29): "+ PC 소리"/"+ 마이크" while recording, then its own timer and stop
    const pc = st.pc || {}, second = ["starting", "recording", "stopping", "finalizing"].includes(pc.state);
    const other = second ? (pc.mode || "loopback") : ((st.status && st.status.mode) === "loopback" ? "mic" : "loopback");
    const otherName = other === "mic" ? "마이크" : "PC 소리", icon = other === "mic" ? "i-mic" : "i-speaker";
    const r2 = $("rec2Btn");
    setp(r2, "hidden", !(second || live));
    const r2html = second
      ? `<svg><use href="#${icon}"/></svg><span class="num">${pc.state === "recording" ? fmt(pc.status && pc.status.elapsed_ms) : pc.state === "starting" ? "시작 중" : "저장 중"}</span>${pc.state === "recording" ? '<i class="sq"></i>' : ""}`
      : `<svg><use href="#${icon}"/></svg><span>+ ${otherName}</span>`;
    if (r2.dataset.h !== r2html) { r2.innerHTML = r2html; r2.dataset.h = r2html; }
    r2.classList.toggle("on", second);
    r2.classList.toggle("busy", second && pc.state !== "recording");
    setp(r2, "title", second ? `${otherName} 따로 녹음 중 — 누르면 이것만 멈추고 저장합니다` : `${otherName}도 따로 녹음 시작 — 따로 저장되고 따로 멈춥니다`);
    // "forgot to stop" (user 2026-09-30): a notice, and an automatic stop only after 15 minutes with no sound
    const over = live && st.class_over, pausedNotice = over && over.kind === "paused";
    setp($("overCard"), "hidden", !over);
    if (over) {
      sett($("overTitle"), pausedNotice ? "아직 일시정지 중이에요" : "수업이 끝난 것 같아요");
      sett($("overWhy"), ` — ${over.reason}${pausedNotice ? "" : " · 녹음은 계속되고 있습니다"}`);
      sett($("overAuto"), over.auto_stop_at_ms ? ` 소리가 계속 없으면 ${wall(over.auto_stop_at_ms, 0)}에 자동으로 멈추고 저장합니다.` : "");
      sett($("overMain"), pausedNotice ? "다시 녹음" : "지금 멈추고 저장");
      $("overMain").dataset.over = pausedNotice ? "resume" : "stop";
    }
    const nxt = live && st.next_class;
    setp($("nextCard"), "hidden", !nxt);
    if (nxt) sett($("nextTitle"), `다음 수업 ${nxt.course}(${nxt.start}) 녹음으로 바꿀까요?`);
    if (st.switched && ui.lastSwitched !== JSON.stringify(st.switched)) {
      ui.lastSwitched = JSON.stringify(st.switched);
      toast(st.switched.ok ? `${st.switched.course} 녹음을 시작했습니다` : `다음 수업 녹음을 시작하지 못했습니다: ${st.switched.reason || ""}`);
    }
    const h = healthHtml(st);
    if ($("health").dataset.h !== h) { $("health").innerHTML = h; $("health").dataset.h = h; }
  }

  function renderTranscript() {
    const st = ui.state || {}, lectureMode = ui.view === "lecture" && ui.lecture;
    ["lvHead", "player", "lvList"].forEach((id) => setp($(id).style, "display", lectureMode ? "" : "none"));
    if (!lectureMode) setp($("lvEngines").style, "display", "none");
    if (lectureMode) { setp($("trEmpty").style, "display", "none"); setp($("trList").style, "display", "none"); return; }
    const show = ["starting", "recording", "stopping", "finalizing", "done"].includes(st.phase);
    setp($("trEmpty").style, "display", show ? "none" : "");
    setp($("trList").style, "display", show ? "block" : "none");
    if (!show) return;
    const rows = [];
    const link = st.link || {}, tr = st.transcription;
    const first = st.phase !== "done" ? (st.live && st.live.state === "running" ? "녹음 중… 동의한 과목이라 40분마다 전사도 함께 진행합니다."
      : "녹음 중… 전사는 녹음을 끝내면 시작합니다.")
      : link.state === "pending" ? "녹음을 저장했습니다. 어느 과목인지 확인하면 회차에 연결합니다."
      : link.state === "short" ? "1분이 안 되는 녹음입니다. 실수로 누른 거면 [버리기], 남길 거면 [회차에 남기기]를 누르세요."
      : ["discarding", "discarded"].includes(link.state) ? "이 녹음은 버렸습니다. 녹음 정리에서 되살릴 수 있습니다."
      : link.state === "discard_failed" ? "녹음을 버리지 못했습니다. 녹음은 그대로 있습니다 — 녹음 정리에서 다시 버릴 수 있습니다."
      : tr && tr.auto ? `녹음을 저장하고 회차에 연결했습니다. 동의한 과목이라 Google 전사를 자동으로 진행합니다(${tr.label || "준비"}).`
      : tr ? `Google 전사: ${tr.label || "진행 중"}`
      : "녹음을 저장했습니다. 'Google 전사 시작'을 누르면 전사가 시작됩니다.";
    rows.push(`<div class="seg-row"><div class="t num">00:00</div><div><div class="x" style="color:var(--sub)">${first}</div></div></div>`);
    (st.bookmarks || []).forEach((b) => rows.push(`<div class="seg-row"><div class="t num">${fmt(b.at_ms).replace(/^00:/, "")}</div><div><div class="x">★ 중요 표시</div><div class="badges"><span class="b cue">내가 표시</span></div></div></div>`));
    const html = rows.join("");
    if ($("trList").dataset.h !== html) { $("trList").innerHTML = html; $("trList").dataset.h = html; }
  }

  /* ---------- lecture view (S1) ---------- */
  const clock = (ms) => { const s = Math.floor((ms || 0) / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : String(m).padStart(2, "0")) + ":" + String(x).padStart(2, "0"); };
  function selectTab(group, id) { const b = document.querySelector(`.seg[data-group="${group}"] button[data-t="${id}"]`); if (b) b.click(); }

  async function loadSidebar() {
    ui.side = await api.sidebar(); renderSide(); if (ui.view === "home" && ui.homeData) renderTodo(ui.homeData);
  }

  async function openLecture(id, atMs, highlight) {
    const r = await api.lecture(id);
    if (!r.ok) { toast(r.error || "회차를 열 수 없습니다"); return; }
    ui.lecture = r.lecture; ui.view = "lecture"; ui.highlight = highlight || null;
    (ui.open || (ui.open = new Set())).add(r.lecture.course);
    // jumping to a quote wants the transcript; a running recording must stay visible (user 2026-09-29)
    ui.noFullHtml = (atMs !== undefined && atMs !== null) || ["starting", "recording", "stopping", "finalizing"].includes((ui.state || {}).phase);
    selectTab("r", "r-tr");
    renderLecture(); renderTop(); renderSide(); renderTranscript();
    if (atMs !== undefined && atMs !== null) jumpTo(atMs);
  }

  async function saveTranscript(anchor) {
    const list = ui.lecture.transcripts.filter((t) => t.segments);
    const save = async (id) => {
      const r = await api.transcript_save(id);
      toast(r.ok ? `다운로드 폴더에 저장했습니다 · ${r.name}` : r.error || "저장하지 못했습니다");
    };
    if (list.length === 1) return save(list[0].id);
    menu(anchor, [{ label: "어느 전사본을 내려받을까요?", items: list.map((t) => ({ value: t.id, text: t.label, note: `~${Math.floor((t.last_ms || 0) / 60000)}분${t.in_use ? " · 사용본" : ""}` })) }], save);
  }

  function renderLecture() {
    const L = ui.lecture, audio = $("audio");
    const inUse = L.in_use && L.transcripts.find((t) => t.id === L.in_use.transcript_id);
    $("lvHead").innerHTML = L.transcripts.length
      ? L.transcripts.map((t) => `<span class="b${t.in_use ? " use" : ""}" title="${esc(t.source_file || "")}">${esc(t.label)}${t.in_use ? " · 사용본" : ""}</span>`).join("") +
        (L.transcripts.length > 1 ? `<span class="switch" id="switchUse">사용본 바꾸기 ▾</span>` : "") +
        (L.transcripts.filter((t) => t.segments).length > 1 ? `<span class="switch" id="cmpTr" title="두 엔진의 전사를 시각에 맞춰 나란히 놓고 다른 낱말을 표시합니다">나란히 비교</span>` : "") +
        (L.transcripts.some((t) => t.segments) ? `<span class="switch" id="saveTr" title="전사본을 .txt로 다운로드 폴더에 저장합니다(내가 고친 곳 반영)">내려받기${L.transcripts.filter((t) => t.segments).length > 1 ? " ▾" : ""}</span>` : "")
      : `<span>전사본 없음</span>`;
    const R = L.range, D = R && R.decided;
    if (D && D.cut) $("lvHead").innerHTML += `<span class="b" title="원본 전체는 _lecturehub에 그대로 있습니다">녹음 범위 ${wall(R.suggest.recorded_start, D.start_ms)}–${wall(R.suggest.recorded_start, D.end_ms)} · 원본 보관${L.hidden_segments ? ` · 수업 뒤 ${L.hidden_segments}구간 숨김` : ""}</span><span class="switch" data-range="revert">되돌리기</span>`;
    if ((L.bookmarks || []).length) $("lvHead").innerHTML += `<span class="bm-list" title="녹음 중 누른 ★ 중요 표시 — 누르면 그 시각부터 재생">★ ${L.bookmarks.map((b) => `<span class="bm" data-seek="${b.at_ms}">${clock(b.at_ms)}</span>`).join("")}</span>`;
    if ((L.orphaned_corrections || []).length) $("lvHead").innerHTML += `<span class="b cue" title="사용본이 바뀌어 자리를 못 찾은 교정입니다. 전사를 보고 다시 고쳐 주세요">교정 ${L.orphaned_corrections.length}건 다시 확인 필요</span>`;
    const media = L.media;
    if (media && media.url) {
      if (audio.dataset.src !== media.url) { audio.src = media.url; audio.dataset.src = media.url; }
      $("player").className = "player"; $("playDur").textContent = media.duration_ms ? clock(media.duration_ms) : "";
      $("playTime").textContent = clock(audio.currentTime * 1000);
      $("player").title = media.path;
    } else {
      audio.removeAttribute("src"); audio.dataset.src = "";
      $("player").className = "player none";
      $("playTime").textContent = ""; $("playDur").textContent = "";
    }
    $("player").querySelector("#playBtn").style.display = media && media.url ? "" : "none";
    $("playSeek").style.display = media && media.url ? "" : "none";
    if (!(media && media.url)) {
      const why = media && !media.exists ? "연결된 원음 파일을 찾지 못함" : "연결된 원음 없음";
      $("playTime").textContent = why;
    }
    const rows = (L.segments || []).map((g, i) => {
      let text = esc(g.text);
      if (ui.highlight) text = text.split(esc(ui.highlight)).join(`<mark>${esc(ui.highlight)}</mark>`);
      const fixed = (g.corrections || []).length ? `<div class="badges"><span class="b fix" title="원시 전사는 그대로 두고 고친 내용을 보여 줍니다">교정 ${g.corrections.length}</span></div>` : "";
      return `<div class="seg-row" data-i="${i}" data-ms="${g.start_ms}" data-seq="${g.seq}"><div class="t num" data-seek="${g.start_ms}">${clock(g.start_ms)}</div><div><div class="x">${g.speaker ? `<span class="who">${esc(g.speaker)}</span>` : ""}<span class="tx">${text}</span></div>${fixed}</div></div>`;
    });
    if (rows.length && document.body.classList.contains("masked")) {
      rows.unshift(`<div class="mask-bar">전사 내용을 가려 두었습니다 <button class="ghost" data-act="unmask">전사 보기</button></div>`);
    }
    if (!inUse) {
      const st = L.state;
      rows.push(`<div class="empty"><svg style="width:34px;height:34px;color:var(--faint)"><use href="#i-wave"/></svg><div class="big">${st.key === "needs_transcript" ? "이 회차는 아직 전사가 없습니다" : "이 회차에는 녹음·전사가 없습니다"}</div>` +
        `<div>${st.key === "needs_transcript" ? "녹음은 있습니다. Google로 초벌 전사를 만들 수 있습니다." : "녹음이나 전사본을 가져오면 여기에서 읽고 들을 수 있습니다."}</div>` +
        (st.action === "transcribe" ? `<button class="ghost" data-act="transcribe-lecture">Google 전사 시작</button>` : "") + `</div>`);
    }
    const S = L.range && L.range.suggest;
    if (S && S.ask) {
      const t0 = S.recorded_start, spoke = S.speech_end_ms ?? S.class_end_ms;
      rows.unshift(`<div class="range-card"><div><b>수업이 ${wall(t0, spoke)}쯤 끝난 것 같아요</b> · 녹음은 ${wall(t0, S.duration_ms)}까지(${Math.floor(S.duration_ms / 60000)}분)</div>` +
        `<div class="nsub">근거: ${esc(S.reason)}. 자르면 원본은 그대로 두고 수업 부분만 따로 저장해 재생·전사·노트·녹음본 폴더에 씁니다.</div>` +
        `<div class="acts"><button class="ghost primary" data-range="cut" data-end="${S.end_ms}">${wall(t0, S.end_ms)}까지로 자르기</button>` +
        `<button class="ghost" data-range="adjust">끝 지점 조정</button><span class="link" data-range="listen" data-end="${S.end_ms}">끝 지점 들어 보기</span>` +
        ` · <span class="link" data-range="keep">끝까지 수업 맞음</span></div></div>`);
    }
    $("lvList").innerHTML = rows.join("");
    $("lvList").scrollTop = 0;
    $("lvEngines").dataset.h = ""; renderLectureEngines();
    renderLectureCenter();
  }

  /* the middle pane: 실시간 전사 on the recording screen; 정리본 and 자료·녹음 on a lecture (2026-11-13) */
  function renderCenter() {
    const lecture = ui.view === "lecture" && !!ui.lecture;
    $("liveTab").hidden = lecture; $("htmlTab").hidden = !lecture; $("filesTab").hidden = !lecture;
    const on = document.querySelector('.seg[data-group="c"] button.on'), t = on && on.dataset.t;
    if (lecture && (!t || t === "c-live")) selectTab("c", "c-html");
    if (!lecture) {
      if (t !== "c-live") selectTab("c", "c-live");
      $("htmlTools").hidden = true; document.querySelector(".center").classList.remove("has-html");
      $("liveHead").dataset.h = ""; cap.liveHtml = null; renderLive();
    }
  }

  function renderLectureCenter() {
    const L = ui.lecture;
    renderCenter();
    // A finished lecture opens its organized HTML note large (user 2026-09-29); without one, [정리본 만들기].
    const pages = L.notes.filter((n) => n.url);
    $("htmlTools").hidden = !pages.length;
    document.querySelector(".center").classList.toggle("has-html", pages.length > 0);
    $("htmlFrame").hidden = !pages.length; $("noteEmpty").hidden = !!pages.length;
    if (pages.length) {
      $("htmlSel").innerHTML = pages.map((n, i) => `<option value="${i}">${esc(n.path.split("\\").pop())}</option>`).join("");
      $("htmlSel").hidden = pages.length < 2;
      ui.htmlPages = pages;
      const job = ui.noteJob || {}, running = job.state === "running" && job.lecture_id === L.id;
      setp($("noteRemake"), "disabled", running || !L.transcripts.some((t) => t.segments));
      sett($("noteRemake"), running ? "만드는 중…" : "다시 만들기");
      if (document.querySelector('.seg[data-group="c"] button.on')?.dataset.t !== "c-files") selectTab("c", "c-html");
      if ($("htmlFrame").dataset.path !== pages[0].path) { showHtml(pages[0]); setHtmlSize(ui.noFullHtml ? "pane" : "full"); }  // default: full window
      else if (ui.noFullHtml && ui.htmlSize === "full") setHtmlSize("pane");
    } else {
      $("htmlFrame").removeAttribute("srcdoc"); $("htmlFrame").dataset.path = "";
      setHtmlSize("pane");
      $("noteEmpty").innerHTML = noteEmptyHtml(L);
    }
    // 자료·녹음: materials open in the user's own program (D-056); recordings keep their tools
    const otherNotes = L.notes.filter((n) => !n.url).map((n) => `<div class="item" data-open="${esc(n.path)}"><svg><use href="#i-file"/></svg>${esc(n.path.split("\\").pop())}<span class="meta">${n.exists ? "정리본 파일" : "파일 없음"}</span></div>`).join("");
    const fileHtml = L.materials.map((m) => `<div class="item" data-open="${esc(m.path)}"><svg><use href="#i-file"/></svg>${esc(m.title)}<span class="meta num">${m.page_from ? `${m.page_from}–${m.page_to}쪽` : ""}${m.decided_by === "user" ? "" : " · 추정"}</span></div>`).join("")
      + otherNotes
      + L.recordings.map((r) => `<div class="item" data-open="${esc(r.path)}"><svg><use href="#i-wave"/></svg>${esc(r.path.split("\\").pop())}<span class="meta num">${r.duration_ms ? clock(r.duration_ms) : ""}${r.exists ? "" : " · 파일 없음"}</span><span class="link drop" data-trim="${r.id}" title="앞뒤 필요 없는 부분을 잘라 냅니다(원본은 그대로 보관)">자르기</span><span class="link drop" data-join="${r.id}" title="같은 날 같은 과목의 다른 녹음과 하나로 이어 붙입니다(원본은 그대로)">이어 붙이기</span><span class="link drop" data-move="${r.id}" title="다른 회차나 수업 외 항목으로 옮깁니다">옮기기</span><span class="link drop" data-discard="${r.id}" title="휴지통으로 보내고 앱에서 숨깁니다">버리기</span></div>`).join("");
    $("filesList").innerHTML = fileHtml; $("filesList").style.display = fileHtml ? "" : "none"; $("filesEmpty").style.display = fileHtml ? "none" : "";
  }
  function noteEmptyHtml(L) {
    const job = ui.noteJob || {}, running = job.state === "running" && job.lecture_id === L.id;
    const hasText = L.transcripts.some((t) => t.segments), engine = esc(ui.ai?.features?.notes?.label || "AI");
    const icon = `<svg style="width:34px;height:34px;color:var(--faint)"><use href="#i-file"/></svg>`;
    if (running) return `${icon}<div class="big">정리본을 만드는 중입니다</div><div>전사를 ${engine}로 읽고, 각주의 시각·원문이 실제 전사에 있는지 확인한 뒤 저장합니다. 몇 분 걸릴 수 있습니다.</div>`;
    if (!hasText) return `${icon}<div class="big">이 회차는 아직 정리본이 없습니다</div><div>전사가 끝나면 버튼 한 번으로 정리본을 만들 수 있습니다.</div>` +
      (L.state && L.state.action === "transcribe" ? `<button class="ghost" data-act="transcribe-lecture">Google 전사 시작</button>` : "");
    return `${icon}<div class="big">이 회차는 아직 정리본이 없습니다</div>` +
      `<div>전사를 ${engine}로 읽어 읽기 쉬운 글로 정리하고, 근거가 된 전사 시각과 원문은 각주로 남깁니다.<br>각주가 실제 전사와 맞을 때만 저장합니다.</div>` +
      `<button class="ghost primary" data-note="make">정리본 만들기</button>` +
      (job.state && job.lecture_id === L.id && job.state !== "running" && job.error ? `<div class="err">지난번에 만들지 못했습니다: ${esc(job.error)}</div>` : "");
  }

  /* [정리본 만들기]: the note job (study/note_job.py) with the consent window as before; on success it writes the
     HTML 정리본 with transcript footnotes (study/note_html.py) and attaches it to the lecture */
  async function makeNote(lectureId) {
    const job = ui.noteJob || {};
    if (job.state === "running") { toast("다른 정리본을 만드는 중입니다 · 끝난 뒤 다시 누르세요"); return false; }
    const check = await api.note_check(lectureId);
    if (!check.ok) { toast(check.error); return false; }
    let token = null;
    if (check.needs_consent) {
      const yes = await api.consent_confirm(check.provider, check.course);
      if (!yes.ok) { toast(yes.error); return false; }
      if (!yes.yes) return false;
      token = yes.token;
    }
    const r = await api.make_note(lectureId, null, token);
    if (!r.ok) { toast(r.error); return false; }
    ui.noteJob = { state: "running", lecture_id: lectureId };
    if (ui.view === "lecture" && ui.lecture && ui.lecture.id === lectureId) renderLectureCenter();
    toast("정리본을 만드는 중입니다 · 몇 분 걸릴 수 있습니다");
    pollNote();
    return true;
  }
  async function noteAction(el) {
    if (el.dataset.note === "make" && ui.lecture) { el.disabled = true; if (!(await makeNote(ui.lecture.id))) el.disabled = false; }
  }
  async function pollNote() {
    const s = await api.note_status();
    ui.noteJob = s;
    if (s.state === "running") { setTimeout(pollNote, 3000); return; }
    if (s.state === "done" && s.html) toast("정리본을 만들었습니다 · 이 회차에 붙였습니다");
    else if (s.state === "done") toast(s.html_error || "근거는 저장했지만 정리본 HTML을 쓰지 못했습니다");
    else if (s.state === "waiting_user") toast("정리본을 자동으로 만들지 못했습니다" + (s.error ? ` · ${s.error}` : ""));
    else if (s.error) toast(s.error);
    if (ui.lecture && s.lecture_id === ui.lecture.id && ui.view === "lecture") openLecture(ui.lecture.id);
    if (window.__lecturehubNotesChanged) window.__lecturehubNotesChanged();
  }
  async function correctSelection() {
    const sel = window.getSelection(); if (!sel || sel.isCollapsed) return;
    const tx = sel.anchorNode && sel.anchorNode.parentElement && sel.anchorNode.parentElement.closest(".tx");
    if (!tx || !tx.contains(sel.focusNode)) { toast("한 구간 안에서 고칠 글자를 고르세요"); return; }
    const row = tx.closest(".seg-row"), L = ui.lecture, g = L.segments[+row.dataset.i];
    const range = sel.getRangeAt(0), pre = document.createRange();
    pre.selectNodeContents(tx); pre.setEnd(range.startContainer, range.startOffset);
    const from = pre.toString().length, to = from + range.toString().length, words = range.toString();
    const after = await askText({ title: "전사 고치기", body: `"${words}" → 무엇으로 고칠까요? 원시 전사는 그대로 두고, 고친 내용이 화면·검색·노트에 쓰입니다.`, value: words });
    if (after === null || after === words) return;
    const r = await api.correct(L.in_use.transcript_id, g.seq, from, to, after, g.text);
    if (!r.ok) { toast(r.error); return; }
    toast("고쳤습니다 · 원시 전사는 그대로 두고 고친 내용을 보여 줍니다"); openLecture(L.id);
  }

  /* ---------- join recordings of one class (user request 2026-09-29: "다음 녹음과 연결해줘") ---------- */
  async function joinRecording(anchor) {
    const id = anchor.dataset.join, c = await api.join_candidates(id);
    if (!c.ok) { toast(c.error); return; }
    if (!c.items.length) { toast("같은 날 같은 과목의 다른 녹음이 없습니다(마이크와 PC 소리는 따로 이어 붙입니다)"); return; }
    const hm = (ms) => new Date(ms).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
    menu(anchor, [{ label: "어느 녹음과 이어 붙일까요? (시간 순서대로 붙습니다)", items: c.items.map((x) => ({ value: x.id, text: `${hm(x.recorded_start)} 시작`, note: clock(x.duration_ms) }))
      .concat(c.items.length > 1 ? [{ value: "\u0000all", text: "모두 이어 붙이기", note: `${c.items.length + 1}개` }] : []) }], async (v) => {
      const ids = v === "\u0000all" ? [id, ...c.items.map((x) => x.id)] : [id, v];
      if (!(await dialog({ title: "녹음을 하나로 이어 붙일까요?", body: `${ids.length}개 녹음을 시간 순서대로 붙여 새 파일을 만듭니다. 원본 파일은 그대로 두고 목록에서만 숨깁니다.\n전사가 있으면 시간을 맞춰 함께 이어 붙입니다(다시 보내지 않음).`, ok: "이어 붙이기" }))) return;
      toast("이어 붙이는 중…");
      const r = await api.join(ids);
      if (!r.ok) { toast(r.error); return; }
      toast(`이어 붙였습니다 · ${clock(r.duration_ms)}${r.transcripts.length ? ` · 전사 ${r.transcripts.length}개도 이어 붙임` : ""}${r.engines_partial.length ? " · 일부 조각에만 있는 전사는 빠짐" : ""}`);
      loadSidebar(); openLecture(r.lecture_id);
    });
  }

  /* ---------- '수업 외' / move a recording to another lecture ---------- */
  function moveRecording(anchor) {
    const L = ui.lecture, id = anchor.dataset.move;
    const courses = ui.info.courses.map((c) => ({ value: "c:" + c.folder, text: c.folder, note: `${mdText(L.date)} 회차` }));
    const extras = (ui.info.extras || []).map((x) => ({ value: "c:" + x, text: x, note: "수업 외" }));
    menu(anchor, [{ label: "어디로 옮길까요?", items: courses.filter((c) => c.text !== L.course) }, { label: "수업 외", items: extras.concat([{ value: "new", text: "+ 새로 만들기" }]) }], async (v) => {
      let course = v.slice(2);
      if (v === "new") {
        const name = await askText({ title: "수업 외 항목 만들기", body: "예: AI 외부 강의", value: "" }); if (!name) return;
        const a = await api.add_extra(name); if (!a.ok) { toast(a.error); return; }
        ui.info.extras = a.extras; course = name.trim().split(/\s+/).join(" ");
      }
      if (!(await dialog({ title: `${course}(으)로 옮길까요?`, body: `${mdText(L.date)} 녹음을 옮깁니다. 녹음본 폴더에 잘못 복사된 파일이 있으면 휴지통으로 보내고 새 폴더로 다시 복사합니다.`, ok: "옮기기" }))) return;
      let r = await api.relink(id, course, L.date, false);
      if (r.ok && r.confirm) {  // the recording has transcripts: they move only with the user's yes
        if (!(await dialog({ title: `전사 ${r.confirm.transcripts}개도 함께 옮길까요?`, body: `이 녹음의 전사가 ${course}(으)로 같이 옮겨지고, ${L.course} 회차의 검색·노트에서는 빠집니다. 전사 내용은 바뀌지 않고, 옮긴 기록이 남습니다.`, ok: "전사도 옮기기" }))) return;
        r = await api.relink(id, course, L.date, true);
      }
      if (!r.ok) { toast(r.error); return; }
      toast((r.transcripts ? `옮겼습니다 · 전사 ${r.transcripts}개 포함` : "옮겼습니다") + (r.recycled_copy ? " · 잘못된 녹음본 복사본은 휴지통으로" : ""));
      loadSidebar(); openLecture(r.lecture_id);
    });
  }

  /* ---------- D-058: throw away a recording (Recycle Bin, never a hard delete) ---------- */
  const mb = (n) => (n || 0) >= 1048576 ? `${Math.round(n / 1048576)}MB` : `${Math.max(1, Math.round((n || 0) / 1024))}KB`;
  async function discardRecording(mediaId) {
    const p = await api.discard_plan(mediaId);
    if (!p.ok) { toast(p.error); return false; }
    const files = p.trash.map((x) => "· " + x.split("\\").slice(-2).join("\\")).join("\n");
    const body = `${p.lecture ? p.lecture + " · " : ""}휴지통으로 보냅니다(${mb(p.bytes)}). [녹음 정리]에서 되살릴 수 있습니다.\n${files}` +
      (p.transcripts ? `\n⚠ 이 녹음의 전사 ${p.transcripts}개가 앱에서 사라집니다.` : "\n이 녹음에는 전사가 없습니다.") + (p.archive_note ? `\n${p.archive_note}` : "");
    if (!(await dialog({ title: p.transcripts ? "전사가 있는 녹음입니다 — 버릴까요?" : "이 녹음을 버릴까요?", body, ok: "휴지통으로", tone: "danger" }))) return false;
    let withPair = false;
    if (p.pair) withPair = await dialog({ title: `같이 녹음한 ${p.pair.kind} 녹음도 버릴까요?`,
      body: p.pair.transcripts ? `⚠ ${p.pair.kind} 녹음에 전사 ${p.pair.transcripts}개가 있습니다. 같이 버리면 그 전사도 사라집니다.\n보통은 [이것만]을 고르세요.` : `${p.pair.session} (전사 없음)`,
      ok: "같이 버리기", cancel: "이것만", tone: "danger" });
    const r = await api.discard(mediaId, withPair);
    if (!r.ok) { toast(r.error); return false; }
    toast("휴지통으로 보냈습니다 · 녹음 정리에서 되살릴 수 있습니다"); loadSidebar(); return true;
  }
  /* the whole lecture at once (user 2026-09-29: "3강 폐기하고 다시 녹음하려는데 왜 삭제가 없냐") */
  async function discardLecture(lectureId) {
    const p = await api.lecture_discard_plan(lectureId);
    if (!p.ok) { toast(p.error); return false; }
    const files = p.trash.map((x) => "· " + x.split("\\").slice(-2).join("\\")).join("\n");
    const stays = [p.stays.transcripts ? `가져온 전사 ${p.stays.transcripts}개` : "", p.stays.slides ? "슬라이드 연결" : ""].filter(Boolean);
    const body = `녹음 ${p.recordings.length}개를 휴지통으로 보냅니다(${mb(p.bytes)}). [녹음 정리]에서 되살릴 수 있습니다.\n${files}` +
      (p.transcripts ? `\n⚠ 이 녹음들의 전사 ${p.transcripts}개가 앱에서 사라집니다.` : "") +
      (stays.length ? `\n${stays.join("·")}은(는) 남으므로 회차는 목록에 남습니다.` : "\n회차가 목록에서 사라지고, 다시 녹음하면 이 번호로 새로 잡힙니다.");
    if (!(await dialog({ title: `${p.lecture || "이 회차"}를 버릴까요?`, body, ok: "휴지통으로", tone: "danger" }))) return false;
    let withPair = false;
    if (p.pairs.length) {
      const t = p.pairs.reduce((n, x) => n + (x.transcripts || 0), 0);
      withPair = await dialog({ title: `같이 녹음한 ${p.pairs.map((x) => x.kind).join("·")} 녹음도 버릴까요?`,
        body: t ? `⚠ 그 녹음에 전사 ${t}개가 있습니다. 같이 버리면 그 전사도 사라집니다.` : `${p.pairs.map((x) => x.session).join(", ")} (전사 없음)`,
        ok: "같이 버리기", cancel: "이것만", tone: "danger" });
    }
    const r = await api.lecture_discard(lectureId, withPair);
    if (!r.ok) { toast(r.error); return false; }
    toast(`${p.lecture || "회차"}를 휴지통으로 보냈습니다 · 녹음 정리에서 되살릴 수 있습니다`);
    if (ui.view === "lecture" && ui.lecture && ui.lecture.id === lectureId) {
      if (stays.length) openLecture(lectureId);
      else { ui.lecture = null; ui.view = "live"; setHtmlSize("pane"); renderCenter(); renderTop(); }
    }
    loadSidebar();
    return true;
  }
  async function openSessions() {
    if (document.querySelector(".hold-panel")) return;
    const scrim = document.createElement("div");
    scrim.className = "scrim top";
    scrim.innerHTML = `<div class="hold-panel"><div class="hhead"><b>녹음 정리</b><span class="nsub">실수 녹음·시험 녹음을 휴지통으로 보냅니다. 완전히 지우지 않습니다.</span><button class="ibtn" data-close="1" title="닫기">✕</button></div><div class="hlist" id="slist"><div class="hint">불러오는 중…</div></div></div>`;
    document.body.appendChild(scrim); keepFocus(scrim);
    const close = () => { scrim.remove(); document.removeEventListener("keydown", key); loadSidebar(); };
    const key = (e) => { if (e.key === "Escape" && isTop(scrim)) close(); };
    document.addEventListener("keydown", key);
    const label = { linked: "회차에 연결됨", pending: "미확정", unlinked: "연결 안 됨(시험 등)", needs_recovery: "복구 필요 (비정상 종료)", recording: "녹음 중", discarded: "버림(휴지통)" };
    const when = (name) => { const m = name.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})/); return m ? `${+m[2]}/${+m[3]} ${m[4]}:${m[5]}` : name; };
    const load = async () => {
      const r = await api.sessions(), box = scrim.querySelector("#slist");
      if (!r.ok) { box.innerHTML = `<div class="hint">${esc(r.error)}</div>`; return; }
      box.innerHTML = r.sessions.length ? r.sessions.map((s) => `<div class="srow ${s.state}"><span class="num">${esc(when(s.name))}</span><span>${esc({ loopback: "PC 소리", import: "가져옴" }[s.name.split("_").pop()] || "마이크")}</span><span class="nsub">${s.lecture ? esc(s.lecture) + " · " : ""}${label[s.state] || s.state}${s.segments ? ` · 전사 ${s.segments}문단` : ""} · ${s.bytes ? mb(s.bytes) : "휴지통"}</span>` +
        (s.state === "discarded" ? `<span class="link" data-restore="${s.media_id}">되살리기</span>`
          : s.state === "recording" ? "" : `<span class="sacts">` + (s.ingest_id ? `<span class="link" data-ingest="${s.ingest_id}" data-day="${esc(s.date || "")}">과목 정하기</span>` : "") + (s.state === "needs_recovery" ? `<span class="link" data-recover="${esc(s.name)}">복구</span>` : "") + (s.media_id ? `<span class="link" data-media="${s.media_id}">버리기</span>` : `<span class="link" data-session="${esc(s.name)}">버리기</span>`) + `</span>`) + `</div>`).join("")
        : `<div class="hint">녹음이 없습니다.</div>`;
    };
    scrim.addEventListener("click", async (e) => {
      if (e.target === scrim || e.target.closest("[data-close]")) { close(); return; }
      const t = e.target.closest("[data-media],[data-session],[data-restore],[data-ingest],[data-recover]"); if (!t) return;
      if (t.dataset.recover) {
        toast("복구하고 병합하는 중… 몇 분 걸릴 수 있어요");
        const r = await api.recover_session(t.dataset.recover); if (!r.ok) toast(r.error); else { toast("복구했습니다. 이제 회차에 연결할 수 있어요"); load(); }
        return;
      }
      if (t.dataset.ingest) { e.stopPropagation(); confirmPendingMenu(t, { ingest_id: t.dataset.ingest, date: t.dataset.day }, load); return; }
      if (t.dataset.media) { if (await discardRecording(t.dataset.media)) load(); }
      else if (t.dataset.session) {
        const crashed = t.closest(".srow").classList.contains("needs_recovery");
        if (!(await dialog({ title: "이 녹음 세션을 버릴까요?", body: crashed ? `${t.dataset.session}\n비정상 종료로 끝난 실제 녹음일 수 있습니다. 먼저 [복구]를 눌러 보세요.` : `${t.dataset.session}\n회차에 연결되지 않은 녹음입니다. 폴더째 휴지통으로 보냅니다.`, ok: "휴지통으로" }))) return;
        if (crashed && !(await dialog({ title: "정말 버릴까요? (두 번째 확인)", body: "복구하지 않은 수업 녹음은 회차 연결도 전사도 되지 않습니다. 폴더째 휴지통으로 보냅니다.", ok: "그래도 버리기" }))) return;
        const r = await api.discard_session(t.dataset.session, crashed); if (!r.ok) toast(r.error); else { toast("휴지통으로 보냈습니다"); load(); }
      } else if (t.dataset.restore) {
        const r = await api.discard_restore(t.dataset.restore); if (!r.ok) toast(r.error); else { toast("되살렸습니다"); load(); }
      }
    });
    load();
  }

  /* ---------- a course folder by category (user 2026-10-01): the folder a file sits in is its category ---------- */
  async function openFiles(course) {
    if (document.querySelector(".hold-panel")) return;
    const scrim = document.createElement("div");
    scrim.className = "scrim top";
    scrim.innerHTML = `<div class="hold-panel"><div class="hhead"><b>${esc(course)} 자료</b><span class="nsub">누르면 열립니다. 폴더가 곧 분류입니다.</span><button class="ibtn" data-close="1" title="닫기">✕</button></div><div class="hlist" id="flist"><div class="hint">불러오는 중…</div></div></div>`;
    document.body.appendChild(scrim); keepFocus(scrim);
    const close = () => { scrim.remove(); document.removeEventListener("keydown", key); closeMenu(); };
    const key = (e) => { if (e.key === "Escape" && isTop(scrim)) close(); };
    document.addEventListener("keydown", key);
    const size = (b) => b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
    const row = (it, loose) => `<div class="frow" data-path="${esc(it.path)}"><svg><use href="#${it.folder ? "i-folder" : "i-file"}"/></svg><span class="fname">${esc(it.name)}</span><span class="nsub num">${it.folder ? `${it.count}개` : size(it.bytes)}</span>` +
      (loose ? `<span class="link" data-sort="${esc(it.path)}" data-suggest="${esc(it.suggest || "")}">${it.suggest ? `${esc(it.suggest)}?` : "분류"} ▾</span>` : "") + `</div>`;
    let data = null;
    const load = async () => {
      const r = await api.course_files(course), box = scrim.querySelector("#flist");
      if (!r.ok) { box.innerHTML = `<div class="hint">${esc(r.error)}</div>`; return; }
      data = r;
      box.innerHTML = r.groups.map((g) => `<div class="fhead">${esc(g.category)}<span class="nsub num">${g.items.length}</span></div>` + g.items.map((it) => row(it)).join("")).join("") +
        (r.loose.length ? `<div class="fhead">분류 안 됨<span class="nsub num">${r.loose.length}</span><span class="nsub">오른쪽에서 분류를 고르면 그 폴더로 옮깁니다</span></div>` + r.loose.map((it) => row(it, true)).join("") : "") +
        (r.top.length ? `<div class="fhead">강의계획서</div>` + r.top.map((it) => row(it)).join("") : "") +
        (!r.groups.length && !r.loose.length && !r.top.length ? `<div class="hint">이 과목 폴더는 비어 있습니다.</div>` : "") +
        `<div class="hfoot"><span class="link" data-path="${esc(r.folder)}">탐색기에서 폴더 열기</span>${r.undo ? `<span class="link" data-undo="${r.undo.batch}">마지막 이동 되돌리기 (${r.undo.moves}건)</span>` : ""}</div>`;
    };
    scrim.addEventListener("click", async (e) => {
      if (e.target === scrim || e.target.closest("[data-close]")) { close(); return; }
      const sort = e.target.closest("[data-sort]");
      if (sort) {
        e.stopPropagation();
        menu(sort, [{ label: "어디에 둘까요", items: data.categories.map((c) => ({ value: c, text: c, note: c === sort.dataset.suggest ? "이름으로 본 추천" : "", sel: c === sort.dataset.suggest })) }], async (category) => {
          const r = await api.file_sort(sort.dataset.sort, category);
          if (!r.ok) { toast(r.error); return; }
          toast(`${category}(으)로 옮겼습니다`); load(); loadSidebar();
        });
        return;
      }
      const undo = e.target.closest("[data-undo]");
      if (undo) {
        if (!(await dialog({ title: "마지막 이동 되돌리기", body: "마지막에 옮긴 파일들을 원래 자리로 돌려놓습니다.", ok: "되돌리기" }))) return;
        const r = await api.files_undo(+undo.dataset.undo);
        if (!r.ok) toast(r.error); else { toast(`${r.moved.length}건을 되돌렸습니다${r.stopped ? " · 일부는 못 옮김" : ""}`); load(); loadSidebar(); }
        return;
      }
      const it = e.target.closest("[data-path]");
      if (it) { const r = await api.open_path(it.dataset.path); if (!r.ok) toast(r.error); }
    });
    load();
  }

  /* ---------- recordings made outside the app: drop on the window, pick, or take a recently received file. The app pre-fills; the user's click decides. ---------- */
  const imp = { items: [], open: false, busy: false, recent: null };
  const DEVICE_LABEL = { phone: "휴대폰", laptop: "노트북", external_mic: "외장 마이크" };
  function importCourseOptions(selected) {
    const courses = ui.info.courses.map((c) => c.folder), extras = ui.info.extras || [];
    const opt = (v) => `<option value="${esc(v)}"${v === selected ? " selected" : ""}>${esc(v)}</option>`;
    return `<option value=""${selected ? "" : " selected"}>과목 선택…</option>` + courses.map(opt).join("") +
      `<optgroup label="수업 외">${extras.map(opt).join("")}<option value="__new__">+ 새로 만들기…</option></optgroup>`;
  }
  function renderImport() {
    const box = document.querySelector("#impList"); if (!box) return;
    const ready = imp.items.filter((x) => x.ok && !x.done);
    const row = (x, i) => {
      const head = `<div class="ihead"><b title="${esc(x.path)}">${esc(x.name)}</b><span class="nsub num">${x.duration_ms ? clock(x.duration_ms) + " · " : ""}${x.bytes ? mb(x.bytes) : ""}${x.convert ? " · MP3로 바꿔서 보관" : ""}</span>` +
        (x.done || x.working ? "" : `<span class="link" data-idrop="${i}">빼기</span>`) + `</div>`;
      if (!x.ok) return `<div class="irow bad">${head}<div class="nsub warn">${esc(x.error || "가져올 수 없는 파일입니다")}</div></div>`;
      if (x.done) return `<div class="irow done">${head}<div class="nsub">✓ ${esc(x.done)} <span class="link" data-iopen="${esc(x.lecture_id)}">회차 열기</span></div></div>`;
      const g = x.guess || {};
      return `<div class="irow">${head}<div class="hform">` +
        `<select data-i="${i}" data-f="course">${importCourseOptions(x.course)}</select>` +
        `<input data-i="${i}" data-f="date" type="date" value="${esc(x.date || "")}" max="${esc(ui.info.today_iso)}" title="녹음한 날">` +
        `<input data-i="${i}" data-f="time" type="time" value="${esc(x.time || "")}" title="녹음을 시작한 시각(모르면 비워 두세요)">` +
        `<select data-i="${i}" data-f="device" title="녹음한 기기">${Object.entries(DEVICE_LABEL).map(([v, t]) => `<option value="${v}"${v === x.device ? " selected" : ""}>${t}</option>`).join("")}</select></div>` +
        `<div class="nsub">${g.note ? `미리 채운 근거(추정): ${esc(g.note)} — 맞는지 확인하세요` : "날짜와 과목을 알 수 없어 비워 두었습니다. 직접 골라 주세요"}${x.time ? "" : " · 시작 시각을 비우면 시간표의 수업 시작 시각으로 기록합니다"}</div>` +
        (x.working ? `<div class="nsub">가져오는 중…</div>` : x.failed ? `<div class="nsub warn">${esc(x.failed)}</div>` : "") + `</div>`;
    };
    box.innerHTML = imp.items.length ? imp.items.map(row).join("") : "";
    const go = document.querySelector("#impGo");
    const complete = ready.length && ready.every((x) => x.course && x.date);
    go.hidden = !ready.length; go.disabled = !complete || imp.busy;
    go.textContent = imp.busy ? "가져오는 중…" : ready.length > 1 ? `${ready.length}개 가져오기` : "가져오기";
    go.title = complete ? "원본 파일은 그대로 두고 앱 안에 복사해 회차에 연결합니다" : "과목과 날짜를 골라 주세요";
    const rec = document.querySelector("#impRecent"), R = imp.recent;
    if (!R) rec.innerHTML = `<div class="hint">최근 받은 파일을 찾는 중…</div>`;
    else if (!R.ok) rec.innerHTML = `<div class="hint">${esc(R.error)}</div>`;
    else {
      const taken = new Set(imp.items.map((x) => x.path));
      const when = (ms) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
      const C = R.clova, cw = C && C.checked_at ? C.checked_at.slice(5, 16).replace("-", "/").replace("T", " ") : "";
      const clova = `<div class="srow clova${C && C.login_required ? " warn" : ""}"><span>클로바노트</span><span class="nsub"${C && C.message ? ` title="${esc(C.message)}"` : ""}>${imp.clovaBusy ? "확인하는 중… (1~2분)" : C ? `${esc(cw)} · ${esc(C.message)}` : "아직 확인하지 않음"}</span>` +
        (imp.clovaBusy ? "" : `<span class="link" id="impClova" title="Aside 브라우저로 클로바노트의 새 노트(녹음+전사)를 다운로드 폴더에 받습니다. 받은 노트는 다시 받지 않습니다. 앱이 열려 있으면 일주일마다(실패하면 하루 뒤) 저절로 확인합니다">확인</span>`) + `</div>`;
      rec.innerHTML = clova + `<div class="sl">최근 받은 파일 <small>${R.folders.map((f) => esc(f.split("\\").pop())).join(" · ") || "받은 파일 폴더를 찾지 못함"}</small></div>` +
        (R.items.length ? R.items.map((f) => `<div class="srow${f.imported ? " discarded" : ""}"><span class="num">${when(f.mtime_ms)}</span><span>${esc(f.folder === "Downloads" ? "다운로드" : "카카오톡")}</span><span title="${esc(f.path)}">${esc(f.name)} <small class="nsub">${mb(f.bytes)}</small></span>` +
          (f.imported ? `<span class="nsub">가져옴</span>` : taken.has(f.path) ? `<span class="nsub">위에 있음</span>` : `<span class="link" data-iadd="${esc(f.path)}">추가</span>`) + `</div>`).join("")
          : `<div class="hint">최근 30일 안에 받은 녹음 파일이 없습니다.</div>`);
    }
  }
  async function importAdd(paths) {
    const fresh = paths.filter((p) => !imp.items.some((x) => x.path === p)); if (!fresh.length) return;
    const r = await api.import_probe(fresh);
    if (!r.ok) { toast(r.error); return; }
    r.items.forEach((x) => { const g = x.guess || {}; imp.items.push({ ...x, course: g.course || "", date: g.date || "", time: g.time || "", device: "phone" }); });
    renderImport();
  }
  async function importRun() {
    if (imp.busy) return;
    imp.busy = true;
    const done = [];
    for (const x of imp.items.filter((y) => y.ok && !y.done)) {
      x.working = true; x.failed = null; renderImport();
      const r = await api.import_commit({ path: x.path, course: x.course, date: x.date, time: x.time || null, device: x.device, guess: x.guess || null });
      x.working = false;
      if (!r.ok) { x.failed = r.error || "가져오지 못했습니다"; continue; }
      const t = r.transcription || {}, names = { google: "Google", whisper: "Whisper" };
      x.lecture_id = r.lecture_id;
      x.done = `${x.course}에 연결` + ((t.started || []).length ? ` · ${t.started.map((k) => names[k] || k).join("·")} 전사 시작` : t.why ? ` · ${t.why}` : "");
      done.push(x);
    }
    imp.busy = false;
    loadSidebar(); loadEngines();
    imp.recent = await api.import_recent();
    renderImport();
    if (done.length === 1 && imp.items.every((x) => x.done)) { toast(`가져왔습니다 · ${done[0].done}`); closeImport(); openLecture(done[0].lecture_id); }
    else if (done.length) toast(`${done.length}개 가져왔습니다`);
  }
  function closeImport() {
    const scrim = document.querySelector(".import-scrim"); if (scrim) scrim.remove();
    document.removeEventListener("keydown", importKey);
    imp.open = false; imp.items = imp.items.filter((x) => x.ok && !x.done);
  }
  function importKey(e) { if (e.key === "Escape" && isTop(document.querySelector(".import-scrim"))) closeImport(); }
  function openImport(paths) {
    if (!imp.open) {
      const scrim = document.createElement("div");
      scrim.className = "scrim top import-scrim";
      scrim.innerHTML = `<div class="hold-panel"><div class="hhead"><b>녹음 가져오기</b><span class="nsub">휴대폰 등 앱 밖에서 녹음한 파일 · 원본은 그대로 두고 앱 안에 복사합니다</span><button class="ibtn" data-close="1" title="닫기">✕</button></div>` +
        `<div class="hlist"><div class="idrop"><svg><use href="#i-import"/></svg><div><b>녹음 파일을 이 창에 끌어다 놓으세요</b><div class="nsub">탐색기나 카카오톡 대화창에서 바로 끌어올 수 있습니다 (m4a · mp3 · wav 등)</div></div><button class="ghost" id="impPick">파일 고르기…</button></div>` +
        `<div id="impList"></div><div class="iacts"><button class="ghost primary" id="impGo" hidden>가져오기</button></div><div id="impRecent"></div></div></div>`;
      document.body.appendChild(scrim); keepFocus(scrim);
      imp.open = true; imp.recent = null;
      document.addEventListener("keydown", importKey);
      scrim.addEventListener("click", async (e) => {
        if (e.target === scrim || e.target.closest("[data-close]")) { if (!imp.busy) closeImport(); return; }
        const t = e.target.closest("[data-idrop],[data-iadd],[data-iopen],#impPick,#impGo,#impClova"); if (!t) return;
        if (t.id === "impClova") {
          imp.clovaBusy = true; renderImport();
          const r = await api.clova_sync(); imp.clovaBusy = false;
          if (!r.ok) toast(r.error); else toast(r.result.message);
          imp.recent = await api.import_recent(); renderImport(); return;
        }
        if (t.id === "impPick") { const r = await api.import_pick(); if (r.ok && r.paths.length) importAdd(r.paths); }
        else if (t.id === "impGo") importRun();
        else if (t.dataset.idrop) { imp.items.splice(+t.dataset.idrop, 1); renderImport(); }
        else if (t.dataset.iadd) importAdd([t.dataset.iadd]);
        else if (t.dataset.iopen) { closeImport(); openLecture(t.dataset.iopen); }
      });
      scrim.addEventListener("change", async (e) => {
        const f = e.target.closest("[data-f]"); if (!f) return;
        const x = imp.items[+f.dataset.i]; if (!x) return;
        if (f.dataset.f === "course" && f.value === "__new__") {
          const name = await askText({ title: "수업 외 항목 만들기", body: "예: AI 외부 강의", value: "" });
          const a = name ? await api.add_extra(name) : null;
          if (a && a.ok) { ui.info.extras = a.extras; x.course = name.trim().split(/\s+/).join(" "); } else if (a) toast(a.error);
        } else x[f.dataset.f] = f.value;
        renderImport();
      });
      api.import_recent().then((r) => { imp.recent = r; renderImport(); });
    }
    renderImport();
    if (paths && paths.length) importAdd(paths);
  }
  function bindDrop() {
    const veil = document.createElement("div");
    veil.className = "drop-veil"; veil.hidden = true;
    veil.innerHTML = `<div><svg><use href="#i-import"/></svg><b>여기에 놓으면 녹음을 가져옵니다</b><span>과목과 날짜는 놓은 뒤에 확인합니다</span></div>`;
    document.body.appendChild(veil);
    const files = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files");
    let depth = 0;
    window.addEventListener("dragenter", (e) => { if (!files(e)) return; e.preventDefault(); depth++; veil.hidden = false; });
    window.addEventListener("dragover", (e) => { if (!files(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
    window.addEventListener("dragleave", (e) => { if (!files(e)) return; depth = Math.max(0, depth - 1); if (!depth) veil.hidden = true; });
    window.addEventListener("drop", (e) => { if (!files(e)) return; e.preventDefault(); depth = 0; veil.hidden = true; }, true);
    // the full paths arrive from the app side (ui/app.py _on_drop); a web page alone only sees file names
    window.__lecturehubDropped = (paths, names) => {
      if (paths && paths.length) openImport(paths);
      else toast(names && names.length ? "파일 위치를 읽지 못했습니다 — [파일 고르기]를 써 주세요" : "파일이 아닙니다");
    };
  }

  /* ---------- D-057: recording range fix (the original is kept; a derived clip is used) ---------- */
  const wall = (t0, ms) => { const d = new Date((t0 || 0) + (ms || 0)); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`; };
  async function rangeAction(el) {
    const L = ui.lecture, R = L.range, S = R.suggest, act = el.dataset.range;
    if (act === "listen") { jumpTo(Math.max(0, +el.dataset.end - 10000), true); return; }
    let end = +el.dataset.end;
    if (act === "adjust") {
      const v = await askText({ title: "수업 끝 시각", body: "이 시각까지 남기고 뒤는 잘라 냅니다(원본은 그대로 보관). 예: 11:12", value: wall(S.recorded_start, S.end_ms) });
      if (v === null) return;
      const m = v.trim().match(/^(\d{1,2}):(\d{2})$/);
      if (!m) { toast("11:12처럼 적어 주세요"); return; }
      const d = new Date(S.recorded_start); d.setHours(+m[1], +m[2], 0, 0);
      end = d.getTime() - S.recorded_start;
      if (!(end > 60000 && end <= S.duration_ms)) { toast("녹음 시간 안의 시각을 적어 주세요"); return; }
    }
    if (act === "cut" || act === "adjust") {
      const r = await api.range_cut(R.media_id, 0, end);
      if (!r.ok) { toast(r.error); return; }
      toast(`${wall(S.recorded_start, end)}까지로 잘랐습니다 · 원본은 그대로 보관`);
    } else if (act === "keep") {
      const r = await api.range_keep(R.media_id); if (!r.ok) { toast(r.error); return; }
      toast("끝까지 수업으로 두었습니다");
    } else if (act === "revert") {
      if (!(await dialog({ title: "녹음 범위 되돌리기", body: "자르기 전 전체 녹음을 다시 씁니다. 잘라 둔 파일은 지우지 않습니다.", ok: "되돌리기" }))) return;
      const r = await api.range_revert(R.media_id); if (!r.ok) { toast(r.error); return; }
    }
    openLecture(L.id);
  }

  /* manual cut of any recording: start and end by typing or from the player position (original kept, D-057) */
  const hms = (ms) => { const s = Math.floor((ms || 0) / 1000); return `${Math.floor(s / 3600)}:${String(Math.floor(s % 3600 / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
  const parseHms = (v) => {
    const p = String(v).trim().split(":").map(Number);
    if (!p.length || p.some((x) => !Number.isFinite(x) || x < 0)) return null;
    return p.reduce((a, x) => a * 60 + x, 0) * 1000;
  };
  async function trimRecording(mediaId) {
    const L = ui.lecture, rec = L.recordings.find((x) => x.id === mediaId);
    if (!rec) return;
    const plan = await api.range_plan(mediaId);
    if (!plan.ok) { toast(plan.error); return; }
    // audio time → wall clock: add the pauses before that point (the audio has no pauses in it)
    const shift = (ms) => (plan.pauses || []).reduce((a, x) => a + (x.at_ms <= ms ? x.paused_ms : 0), 0);
    const t0 = plan.recorded_start, dur = plan.duration_ms, playing = $("audio").dataset.src && ui.lecture && L.media && L.media.id === mediaId;
    const scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.innerHTML = `<div class="dialog trim-dialog" role="dialog"><h4>녹음 자르기</h4>
      <p>남길 부분의 시작과 끝을 녹음 안 시간(시:분:초)으로 적으세요. 원본은 그대로 두고 이 부분만 따로 저장해 재생·전사·녹음본 폴더에 씁니다. 되돌릴 수 있습니다.</p>
      <div class="trim-row"><label>시작</label><input id="trStart" value="${hms(plan.start_ms)}"><span class="wall" id="trStartWall"></span>${playing ? `<button class="ghost" data-pos="trStart">지금 재생 위치</button>` : ""}</div>
      <div class="trim-row"><label>끝</label><input id="trEnd" value="${hms(plan.end_ms)}"><span class="wall" id="trEndWall"></span>${playing ? `<button class="ghost" data-pos="trEnd">지금 재생 위치</button>` : ""}</div>
      <p class="faint">녹음 길이 ${hms(dur)}${plan.reason ? ` · 제안 근거: ${esc(plan.reason)}` : ""}</p>
      <div class="acts"><button data-r="0">취소</button><button class="primary" data-r="1">자르기</button></div></div>`;
    document.body.appendChild(scrim);
    const upd = () => ["trStart", "trEnd"].forEach((id) => { const ms = parseHms(scrim.querySelector("#" + id).value); scrim.querySelector("#" + id + "Wall").textContent = ms === null ? "형식: 1:05:30" : `실제 ${wall(t0 + shift(ms), ms)}쯤`; });
    upd();
    scrim.addEventListener("input", upd);
    const answer = await new Promise((resolve) => scrim.addEventListener("click", (e) => {
      const pos = e.target.closest("[data-pos]");
      if (pos) { scrim.querySelector("#" + pos.dataset.pos).value = hms($("audio").currentTime * 1000); upd(); return; }
      const b = e.target.closest("button[data-r]"); if (b) resolve(b.dataset.r === "1"); else if (e.target === scrim) resolve(false);
    }));
    const start = parseHms(scrim.querySelector("#trStart").value), end = parseHms(scrim.querySelector("#trEnd").value);
    scrim.remove();
    if (!answer) return;
    if (start === null || end === null || !(start < end && end <= dur)) { toast("시작 < 끝, 끝은 녹음 길이 안으로 적어 주세요"); return; }
    const r = await api.range_cut(mediaId, start, end);
    if (!r.ok) { toast(r.error); return; }
    toast(`${hms(start)}–${hms(end)}만 남겼습니다 · 원본은 그대로 보관`);
    openLecture(L.id);
  }

  /* ---------- S5: hold inbox — redesigned 2026-11-13: one question at a time, in plain words.
     What the file is, why the app could not decide (holds.REASON_KO), the answers as buttons, and an easy 나중에.
     One answer registers only that file; nothing is moved or deleted. ---------- */
  const HOLD_KIND = { media: "녹음 파일", transcript: "전사본", material: "자료", note: "정리본" };
  async function openInbox() {
    if (document.querySelector(".hold-panel")) return;
    const scrim = document.createElement("div");
    scrim.className = "scrim top";
    scrim.innerHTML = `<div class="hold-panel"><div class="hhead"><b>확인</b><span class="nsub">앱이 혼자 정하지 못한 파일입니다. 답하면 그 파일만 회차에 연결하고, 파일은 옮기거나 지우지 않습니다.</span><button class="ibtn" data-close="1" title="닫기" aria-label="닫기">✕</button></div><div class="hlist" id="hlist"><div class="hint">불러오는 중…</div></div></div>`;
    document.body.appendChild(scrim); keepFocus(scrim);
    const close = () => { scrim.remove(); document.removeEventListener("keydown", key); loadSidebar(); };
    const key = (e) => {
      if (!isTop(scrim)) return;
      if (e.key === "Escape") close();
      const typing = /^(INPUT|SELECT|TEXTAREA)$/.test((e.target && e.target.tagName) || "");
      if (!typing && e.key === "ArrowRight") go(S.at + 1);
      if (!typing && e.key === "ArrowLeft") go(S.at - 1);
    };
    document.addEventListener("keydown", key);
    const S = { cards: [], at: 0, done: {}, pick: {}, deferred: 0 };
    const box = () => scrim.querySelector("#hlist");
    const evidenceRows = (c) => (c.evidence || []).filter((e) => !["파일", "보류 이유"].includes(e.label))
      .map((e) => `<li><span>${esc(e.label)}</span> ${esc(e.value)}</li>`).join("");
    function answers(c, i) {
      const g = c.guesses || {};
      if (c.question === "identity") {
        const pick = S.pick[c.id] || g.course || "";
        return `<div class="hq-group"><div class="hq-lab">과목</div><div class="hq-chips">${(c.folders || []).map((f) =>
          `<button class="chip${f === pick ? " on" : ""}" data-course-pick="${esc(f)}" aria-pressed="${f === pick}">${esc(f)}${f === g.course ? " <small>이름에서 추정</small>" : ""}</button>`).join("")}</div></div>` +
          `<div class="hq-group"><label class="hq-lab" for="hq-date">수업 날짜</label><input id="hq-date" data-f="date" type="date" value="${esc(g.date || "")}">${g.date ? `<small class="hq-note">파일 이름에서 읽은 날짜입니다. 맞는지 확인하세요.</small>` : ""}</div>` +
          `<details class="hq-more"><summary>그날 같은 과목 수업이 두 번 있었다면</summary><input data-f="session" placeholder="몇 번째 수업인지 (예: 2)" size="18" inputmode="numeric"></details>` +
          `<div class="hq-go"><button class="primary" data-save="${i}">이 회차로 연결</button></div>`;
      }
      if (c.question === "device") {
        return `<div class="hq-group"><label class="hq-lab" for="hq-start">녹음 시작 시각 <small>알면 적기 — 몰라도 됩니다</small></label><input id="hq-start" data-f="start" placeholder="예: 10:05" size="10"></div>` +
          `<div class="hq-choices">${c.options.map((o) => `<button class="choice" data-dev="${i}" data-device="${esc(o.value.device_type)}">${esc(o.label)}</button>`).join("")}</div>` +
          `<small class="hq-note">시작 시각을 모르면 기기만 알려 줘도 됩니다. 이 경우 보류로 남을 수 있습니다.</small>`;
      }
      if (c.question === "date" && c.options.length) {
        return `<div class="hq-choices">${c.options.map((o, j) => `<button class="choice" data-opt="${i}:${j}">${esc(o.label)}</button>`).join("")}</div>` +
          `<div class="hq-group hq-inline"><label class="hq-lab" for="hq-other">다른 날짜</label><input id="hq-other" data-f="other" type="date"><button class="ghost" data-other="${i}">이 날짜로</button></div>`;
      }
      if (c.options.length) return `<div class="hq-choices">${c.options.map((o, j) => `<button class="choice" data-opt="${i}:${j}">${esc(o.label)}</button>`).join("")}</div>`;
      return `<p class="hq-note">이 파일은 앱에서 고를 답이 없습니다. 파일을 직접 확인해 보고, 공부에 쓰지 않는 파일이면 [학습 대상 아님]으로 빼 두세요. 모르겠으면 [나중에]를 누르면 됩니다.</p>`;
    }
    function draw() {
      const n = S.cards.length;
      if (!n) {
        box().innerHTML = `<div class="hq-empty"><svg style="width:34px;height:34px;color:var(--faint)"><use href="#i-check"/></svg><b>확인할 것이 없습니다</b>` +
          `<span>${S.deferred ? `나중에 보기로 한 ${S.deferred}개는 내일 다시 묻습니다.` : "앱이 모든 파일을 스스로 정리했습니다."}</span><button class="ghost" data-close="1">닫기</button></div>`;
        return;
      }
      S.at = Math.max(0, Math.min(S.at, n - 1));
      const i = S.at, c = S.cards[i], done = S.done[c.id];
      const p = c.preview || {};
      const pv = p.type === "text" ? `<pre class="hpre">${p.lines.map(esc).join("\n")}${p.total_lines > p.lines.length ? "\n…" : ""}</pre>`
        : p.type === "audio" ? (p.url ? `<audio controls preload="none" src="${esc(p.url)}"></audio>` : `<div class="hsub">녹음 파일을 찾지 못해 들을 수 없습니다</div>`) : "";
      const same = c.items.length > 1 ? `<div class="hsub">내용이 같은 파일 ${c.items.length}개를 한 번에 답합니다: ${c.items.map((x) => esc(x.name)).join(", ")}</div>` : "";
      const ev = evidenceRows(c);
      const dots = S.cards.map((x, k) => `<i class="${k === i ? "on" : ""}${S.done[x.id] ? " done" : ""}"></i>`).join("");
      box().innerHTML = `<div class="hq-top"><span class="num">질문 ${i + 1} / ${n}</span><span class="hq-dots" aria-hidden="true">${dots}</span></div>` +
        `<div class="hq-card${done ? " answered" : ""}">` +
        `<div class="hq-what"><span class="hkind">${esc(HOLD_KIND[c.kind] || "파일")}</span><b class="hfile" title="${esc((c.items[0] || {}).path || "")}">${esc(c.file || (c.items[0] || {}).name || "")}</b></div>` +
        `<div class="hq-why"><span>왜 묻나요</span>${esc(c.reason_ko || "")}</div>` +
        (ev ? `<ul class="hq-ev">${ev}</ul>` : "") + same + pv +
        `<h3 class="hq-ask">${esc(c.text)}</h3>` +
        (done ? `<div class="hres">${done}</div>` : `<div class="hq-ans">${answers(c, i)}</div><div class="hres" id="hres"></div>`) +
        `<div class="hq-foot">${done ? "" : `<button class="ghost" data-later="${i}" title="내일 다시 묻습니다">나중에</button><button class="ghost subtle" data-reject="${i}">학습 대상 아님</button>`}` +
        `<span class="grow"></span><button class="ghost" data-prev="1"${i ? "" : " disabled"}>‹ 이전</button><button class="${done ? "primary" : "ghost"}" data-next="1"${i < n - 1 ? "" : " disabled"}>다음 ›</button></div></div>`;
      const first = scrim.querySelector(done ? '[data-next="1"]:not([disabled])' : ".hq-ans button, .hq-ans input");
      if (first) first.focus({ preventScroll: true });
    }
    function go(k) { if (!S.cards.length || k < 0 || k >= S.cards.length) return; S.at = k; draw(); }
    const load = async () => {
      const r = await api.holds();
      if (!r.ok) { box().innerHTML = `<div class="hint">${esc(r.error)}</div>`; return; }
      S.cards = r.cards || []; S.deferred = r.deferred || 0; draw();
    };
    const ids = (i) => S.cards[i].items.map((x) => x.id);
    const say = (html) => { const el = scrim.querySelector("#hres"); if (el) el.innerHTML = html; };
    const answer = async (i, value) => {
      say(`<span class="nsub">연결하는 중…</span>`);
      scrim.querySelectorAll(".hq-ans button").forEach((b) => { b.disabled = true; });
      const r = await api.hold_answer(ids(i), value);
      if (!r.ok) { say(`<span class="err">${esc(r.error)}</span>`); scrim.querySelectorAll(".hq-ans button").forEach((b) => { b.disabled = false; }); return; }
      const lines = r.outcome.map((o) => o.state === "confirmed"
        ? `<div class="ok-line">✓ ${esc(o.course || "")} ${o.date ? mdText(o.date) : ""}에 연결했습니다 — ${esc(o.next || "연결됨")}${o.lecture_id ? ` <span class="link" data-go="${o.lecture_id}">회차 열기</span>` : ""}</div>`
        : `<div>아직 정하지 못했습니다: ${esc(o.reason || "")} <span class="link" data-undo="${o.id}">답 되돌리기</span></div>`);
      S.done[S.cards[i].id] = lines.join("");
      draw(); loadSidebar();
    };
    scrim.addEventListener("click", async (e) => {
      if (e.target === scrim || e.target.closest("[data-close]")) { close(); return; }
      const t = e.target.closest("[data-opt],[data-save],[data-dev],[data-other],[data-later],[data-reject],[data-go],[data-undo],[data-prev],[data-next],[data-course-pick]");
      if (!t || t.disabled) return;
      const card = scrim.querySelector(".hq-card"), v = (f) => { const el = card && card.querySelector(`[data-f="${f}"]`); return el ? el.value.trim() : ""; };
      if (t.dataset.coursePick) { const c = S.cards[S.at]; S.pick[c.id] = t.dataset.coursePick;
        card.querySelectorAll("[data-course-pick]").forEach((b) => { const on = b === t; b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); }); }
      else if (t.dataset.opt) { const [i, j] = t.dataset.opt.split(":").map(Number); answer(i, S.cards[i].options[j].value); }
      else if (t.dataset.dev) answer(+t.dataset.dev, { device_type: t.dataset.device, start: v("start") });
      else if (t.dataset.other) {
        const i = +t.dataset.other, base = S.cards[i].options[0].value;
        if (!v("other")) { say(`<span class="err">날짜를 골라 주세요</span>`); return; }
        answer(i, { ...base, date: v("other") });
      }
      else if (t.dataset.save) {
        const i = +t.dataset.save, c = S.cards[i], folder = S.pick[c.id] || (c.guesses || {}).course || "";
        if (!folder) { say(`<span class="err">과목을 골라 주세요</span>`); return; }
        if (!v("date")) { say(`<span class="err">수업 날짜를 골라 주세요</span>`); return; }
        answer(i, { folder, date: v("date"), session: v("session") });
      }
      else if (t.dataset.later) {
        const r = await api.hold_defer(ids(+t.dataset.later));
        if (!r.ok) { toast(r.error); return; }
        toast("내일 다시 묻겠습니다"); await load(); loadSidebar();
      }
      else if (t.dataset.reject) {
        const i = +t.dataset.reject;
        if (!(await dialog({ title: "학습 대상이 아닌 파일로 뺄까요?", body: "이 파일은 회차에 연결하지 않고 확인 목록에서 뺍니다. 파일은 그대로 두며, 나중에 되돌릴 수 있습니다.", ok: "빼기" }))) return;
        const r = await api.hold_reject(ids(i));
        if (!r.ok) { toast(r.error); return; }
        S.done[S.cards[i].id] = `<div>목록에서 뺐습니다 · <span class="link" data-undo="${ids(i)[0]}">되돌리기</span></div>`;
        draw(); loadSidebar();
      }
      else if (t.dataset.undo) { const r = await api.hold_undo(t.dataset.undo); if (r.ok) { toast("되돌렸습니다"); S.done = {}; await load(); loadSidebar(); } else toast(r.error); }
      else if (t.dataset.go) { close(); openLecture(t.dataset.go); }
      else if (t.dataset.prev) go(S.at - 1);
      else if (t.dataset.next) go(S.at + 1);
    });
    load();
  }

  /* A note is untrusted HTML (security review 2026-11-05): the frame is sandboxed without allow-scripts, and this
     policy goes first so nothing in the note can run scripts, fetch, embed plugins or change the base address. */
  const NOTE_CSP = `<meta http-equiv="Content-Security-Policy" content="script-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; img-src 'self' data:; font-src 'self' data:; media-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-src 'none'">`;
  /* organized HTML note: full window by default, Esc shrinks (user 2026-09-29) */
  async function showHtml(note) {
    $("htmlFrame").dataset.path = note.path; $("htmlFloatName").textContent = note.path.split("\\").pop();
    $("htmlFrame").srcdoc = NOTE_CSP + `<p style="font:14px sans-serif;padding:24px;color:#6b6359">정리본을 여는 중…</p>`;
    let r;
    try { r = await api.note_html(note.path); } catch (err) { r = { ok: false, error: "정리본을 읽지 못했습니다 — [새 창]으로 열어 보세요" }; }
    if ($("htmlFrame").dataset.path !== note.path) return;
    ui.htmlDoc = NOTE_CSP + (r.ok ? r.html : `<p style="font:14px sans-serif;padding:24px">${esc(r.error || "열지 못했습니다")}</p>`);
    $("htmlFrame").srcdoc = ui.htmlDoc;
  }
  /* A srcdoc page takes the app's own address as its base, so a table-of-contents link ("#2-1") would load the
     app itself inside the frame. Links inside the note are scrolled to by hand. */
  function noteLink(e) {
    const a = e.target.closest ? e.target.closest("a[href]") : null;
    if (!a || e.defaultPrevented) return;
    const href = a.getAttribute("href") || "";
    e.preventDefault();  // every link is handled here; javascript:/data:/vbscript: never navigate (security review)
    if (/^\s*(javascript|data|vbscript):/i.test(href)) return;
    if (!href.startsWith("#")) { toast("바깥 링크는 [새 창]으로 연 정리본에서 누르세요"); return; }
    if (href === "#") return;
    const doc = a.ownerDocument; let id = href.slice(1);
    try { id = decodeURIComponent(id); } catch (err) { /* keep it as written */ }
    const target = doc.getElementById(id) || doc.getElementsByName(id)[0];
    if (target) target.scrollIntoView({ block: "start" }); else if (/^top$/i.test(id)) doc.defaultView.scrollTo(0, 0);
  }
  function noteFrameLoaded() {
    const frame = $("htmlFrame");
    try {
      if (frame.dataset.path && frame.contentWindow.location.href !== "about:srcdoc") {  // left the note anyway: put it back
        if (ui.htmlDoc && (noteFrameLoaded.fixed || 0) < 3) { noteFrameLoaded.fixed = (noteFrameLoaded.fixed || 0) + 1; frame.removeAttribute("srcdoc"); frame.srcdoc = ui.htmlDoc; }
        return;
      }
      noteFrameLoaded.fixed = 0;
      frame.contentDocument.addEventListener("keydown", htmlKeys);  // srcdoc is same-origin: Esc works after clicking into the note
      frame.contentDocument.addEventListener("click", noteLink);
    } catch (err) { /* ignore */ }
  }
  function setHtmlSize(size) {
    ui.htmlSize = size;
    document.body.classList.toggle("html-full", size === "full");
    document.body.classList.toggle("wide", size === "wide");
    document.querySelectorAll(".size-seg button[data-size]").forEach((b) => b.classList.toggle("on", b.dataset.size === size));
  }
  function htmlKeys(e) {
    if (e.key === "Escape" && ui.htmlSize && ui.htmlSize !== "pane" && !document.querySelector("body > .scrim, #menu")) { e.preventDefault(); setHtmlSize(ui.htmlSize === "full" ? "pane" : "pane"); }
  }

  function rowAt(ms) {
    const segs = ui.lecture.segments || []; let lo = 0, hi = segs.length - 1, found = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (segs[mid].start_ms <= ms) { found = mid; lo = mid + 1; } else hi = mid - 1; }
    return found;
  }
  function markPlaying(i, scroll) {
    document.querySelectorAll("#lvList .seg-row.playing").forEach((r) => r.classList.remove("playing"));
    const row = document.querySelector(`#lvList .seg-row[data-i="${i}"]`);
    if (row) { row.classList.add("playing"); if (scroll) row.scrollIntoView({ block: "center" }); }
  }
  function jumpTo(ms, play) {
    const i = rowAt(ms); markPlaying(Math.max(i, 0), true);
    const audio = $("audio");
    if (audio.dataset.src) { audio.currentTime = ms / 1000; if (play) audio.play(); }
    else if (play) toast("연결된 원음 없음 — 전사만 볼 수 있습니다");
  }

  async function chooseTranscript(e) {
    e.stopPropagation();
    const L = ui.lecture;
    menu(e.target, [{ label: "사용본 (이 회차에서 쓰는 전사본)", items: L.transcripts.map((t) => ({ value: t.id, text: t.label, note: `${t.segments}문단${t.in_use ? " · 사용 중" : ""}`, sel: t.in_use })) }],
      async (tid) => {
        if (tid === (L.in_use && L.in_use.transcript_id)) return;
        const r = await api.choose_transcript(L.id, tid);
        if (!r.ok) { toast(r.error); return; }
        toast("사용본을 바꿨습니다(이력 기록)"); openLecture(L.id);
      });
  }

  /* 나란히 비교 (user 2026-11-14): two engines' transcripts side by side, rows follow the left one by time;
     words found in only one side are marked. Either side can become the 사용본 from here. */
  async function compareTranscripts() {
    const L = ui.lecture, list = L.transcripts.filter((t) => t.segments);
    if (list.length < 2) return;
    const use = list.find((t) => t.in_use) || list[0];
    const pick = { a: use.id, b: (list.find((t) => t.id !== use.id) || list[1]).id };
    const scrim = document.createElement("div");
    scrim.className = "scrim cmp-scrim";
    scrim.innerHTML = `<div class="cmp-panel"><div class="cal-head"><b>전사본 나란히 비교</b><small class="room-sub">같은 시각의 말을 한 줄에 · 한쪽에만 있는 낱말은 색으로</small><span class="grow"></span><button class="ibtn" data-c="close" title="닫기">✕</button></div><div class="cmp-top" id="cmpTop"></div><div class="cmp-body" id="cmpBody"><div class="hint">불러오는 중…</div></div></div>`;
    document.body.appendChild(scrim); keepFocus(scrim);
    const close = () => { scrim.remove(); document.removeEventListener("keydown", key); };
    const key = (e) => { if (e.key === "Escape" && isTop(scrim)) close(); };
    document.addEventListener("keydown", key);
    const norm = (w) => w.replace(/^[“"'(]+|[.,?!·…"”')]+$/g, "");  // edge punctuation only: 0.02 stays one word
    const words = (s) => String(s || "").split(/\s+/).map(norm).filter(Boolean);
    const marked = (text, other) => text.split(/(\s+)/).map((w) => (!w.trim() || other.has(norm(w)) ? esc(w) : `<mark class="cmp-d">${esc(w)}</mark>`)).join("");
    const draw = async () => {
      const opts = (cur) => list.map((t) => `<option value="${esc(t.id)}"${t.id === cur ? " selected" : ""}>${esc(t.label)}${t.in_use ? " · 사용본" : ""}</option>`).join("");
      const useBtn = (id) => (id === use.id ? `<span class="b use">사용본</span>` : `<button class="ghost" data-use="${esc(id)}">이쪽을 사용본으로</button>`);
      scrim.querySelector("#cmpTop").innerHTML = `<div class="cmp-col"><select data-side="a">${opts(pick.a)}</select>${useBtn(pick.a)}</div><div class="cmp-col"><select data-side="b">${opts(pick.b)}</select>${useBtn(pick.b)}</div>`;
      const [ra, rb] = await Promise.all([api.transcript(pick.a), api.transcript(pick.b)]);
      const A = ra.segments || [], B = rb.segments || [];
      if (!A.length || !B.length) { scrim.querySelector("#cmpBody").innerHTML = `<div class="hint">전사 내용을 불러오지 못했습니다.</div>`; return; }
      let k = 0, diff = 0;
      const rows = A.map((g, i) => {
        const until = i + 1 < A.length ? A[i + 1].start_ms : Infinity, right = [];
        while (k < B.length && B[k].start_ms < until) right.push(B[k++]);
        const ta = g.text, tb = right.map((x) => x.text).join(" ");
        const wa = new Set(words(ta)), wb = new Set(words(tb));
        const la = marked(ta, wb), lb = tb ? marked(tb, wa) : `<span class="faint">(이 시각에 들은 말 없음)</span>`;
        diff += (la.match(/cmp-d/g) || []).length + (lb.match(/cmp-d/g) || []).length;
        return `<div class="cmp-row"><div class="t num" data-seek="${g.start_ms}">${clock(g.start_ms)}</div><div class="cx">${la}</div><div class="cx">${lb}</div></div>`;
      });
      scrim.querySelector("#cmpBody").innerHTML = `<div class="cmp-sum">${A.length}문단 · 한쪽에만 있는 낱말 ${diff}곳 — 시각을 누르면 그 자리부터 들을 수 있습니다</div>` + rows.join("");
    };
    scrim.addEventListener("change", (e) => { const s = e.target.closest("select[data-side]"); if (!s) return; pick[s.dataset.side] = s.value; draw(); });
    scrim.addEventListener("click", async (e) => {
      if (e.target === scrim || e.target.closest('[data-c="close"]')) return close();
      const t = e.target.closest("[data-seek],[data-use]"); if (!t) return;
      if (t.dataset.seek) { close(); return jumpTo(+t.dataset.seek, true); }
      const r = await api.choose_transcript(L.id, t.dataset.use);
      if (!r.ok) { toast(r.error); return; }
      toast("사용본을 바꿨습니다(이력 기록)"); close(); openLecture(L.id);
    });
    draw();
  }

  async function transcribeLecture() {
    const L = ui.lecture, rec = L.recordings.find((r) => r.exists);
    if (!rec) { toast("연결된 녹음 파일을 찾지 못했습니다"); return; }
    await runTranscription(rec.path, L.course);
  }

  async function showMai(mai) {
    if (mai.state === "failed") { toast("MAI 조각을 만들지 못했습니다: " + (mai.error || "")); return; }
    if (mai.state !== "ready") return;
    const open = await dialog({
      title: "MAI 보강 — 조각을 만들었습니다",
      body: `${mai.chunks.length}개 조각(30분)을 만들었습니다.\n` + (mai.via === "aside"
        ? "Aside 브라우저가 조각을 MAI에 올리고, 끝나면 자동으로 전사본이 됩니다."
        : mai.claude
        ? "Claude 창이 조각을 MAI에 올리고, 끝나면 자동으로 전사본이 됩니다."
        : "Claude Code를 찾지 못했습니다. 폴더의 조각을 MAI 플레이그라운드에 직접 올리세요.") +
        (mai.hint ? `\n${mai.hint}` : "") + `\n${mai.folder}`,
      ok: "폴더 열기", cancel: "닫기" });
    if (open) api.open_folder(mai.folder);
  }

  /* ---------- search (Ctrl+K) ---------- */
  function snippet(text, q, width = 70) {
    const t = String(text || ""), i = q ? t.indexOf(q) : -1;
    if (i < 0) return esc(t.length > width * 2 ? t.slice(0, width * 2) + "…" : t);
    const a = Math.max(0, i - width), b = Math.min(t.length, i + q.length + width);
    return (a ? "…" : "") + esc(t.slice(a, i)) + `<mark>${esc(q)}</mark>` + esc(t.slice(i + q.length, b)) + (b < t.length ? "…" : "");
  }
  /* ---------- calendar: exams · quizzes · assignments · closures · personal (sources: user / eTL / class speech) ---------- */
  const KIND_OPTIONS = [["exam", "시험"], ["quiz", "퀴즈"], ["assignment", "과제"], ["closure", "휴강"], ["personal", "개인"], ["other", "기타"]];
  const dday = (n) => (n === 0 ? "D-day" : n > 0 ? `D-${n}` : `D+${-n}`);
  const hhmm = (ms) => (ms === null || ms === undefined ? "" : `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms % 3600000 / 60000)).padStart(2, "0")}`);
  async function loadExamChip() {
    const now = new Date();
    showExamChip(await api.calendar(now.getFullYear(), now.getMonth() + 1));
  }
  function showExamChip(r) {
    const x = r && r.ok && r.next_exam;
    $("examChip").hidden = !x;
    if (x) { $("examChip").textContent = `${x.course ? x.course + " " : ""}${x.kind_label} ${dday(x.d_day)}`; $("examChip").title = `${x.title} · ${x.date}${x.note ? "\n" + x.note : ""}`; }
  }
  /* ---------- 정리본 모음 (2026-11-13, the rail button that used to open the exam screen): per course, its lectures
     by date with the HTML 정리본 attached to each. A note opens in the lecture view (or the user's browser);
     a lecture without one gets [정리본 만들기]. The exam screen stays one click away for each course. ---------- */
  function openNotes(folder) {
    if (document.querySelector(".notes-panel")) return;
    const scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.innerHTML = `<div class="exam-panel notes-panel"><div class="hhead"><b>정리본 모음</b><span class="nsub">회차마다 만든 정리본입니다. 누르면 앱에서 열고, [브라우저]는 평소 쓰는 브라우저로 엽니다.</span><button class="ibtn" data-close="1" title="닫기" aria-label="닫기">✕</button></div><div class="exam-body"><div class="exam-courses" id="ncCourses"></div><div class="exam-main" id="ncMain"><div class="hint">불러오는 중…</div></div></div></div>`;
    document.body.appendChild(scrim); keepFocus(scrim);
    const S = { data: null, course: folder || null };
    const close = () => { scrim.remove(); document.removeEventListener("keydown", key); window.__lecturehubNotesChanged = null; };
    const key = (e) => { if (isTop(scrim) && e.key === "Escape") close(); };
    document.addEventListener("keydown", key);
    const course = () => S.data && S.data.courses.find((c) => c.folder === S.course);
    const draw = () => {
      scrim.querySelector("#ncCourses").innerHTML = S.data.courses.map((c) =>
        `<button class="exc${c.folder === S.course ? " on" : ""}" data-nc-course="${esc(c.folder)}"><b>${esc(c.folder)}</b>` +
        `<span class="exd${c.with_notes ? "" : " none"}">${c.with_notes}/${c.lectures.length}</span><small>정리본 있는 회차 ${c.with_notes}개</small></button>`).join("")
        || `<div class="hint">회차가 아직 없습니다.</div>`;
      const c = course(), box = scrim.querySelector("#ncMain");
      if (!c) { box.innerHTML = `<div class="hint">${S.data.courses.length ? "왼쪽에서 과목을 고르세요." : "녹음하거나 전사본을 가져오면 회차가 생기고, 여기에서 정리본을 만들 수 있습니다."}</div>`; return; }
      const job = ui.noteJob || {};
      const rows = c.lectures.map((x) => {
        const notes = x.notes.filter((n) => n.exists), missing = x.notes.length - notes.length;
        const running = job.state === "running" && job.lecture_id === x.id;
        const act = notes.length
          ? notes.map((n) => `<button class="ghost primary" data-nc-open="${esc(x.id)}" data-path="${esc(n.path)}" title="${esc(n.name)}">${notes.length > 1 ? esc(n.name) : "열기"}</button><button class="ghost" data-nc-browser="${esc(n.path)}" title="평소 쓰는 브라우저로 엽니다">브라우저</button>`).join("")
          : running ? `<span class="nc-state">만드는 중…</span>`
          : x.can_make ? `<button class="ghost" data-nc-make="${esc(x.id)}">정리본 만들기</button>`
          : `<span class="nc-state" title="전사가 끝나면 정리본을 만들 수 있습니다">전사 전</span>`;
        return `<div class="nc-row"><b class="num">${esc(dayText(x.date))}</b><span class="nc-label">${esc(x.label)}${missing ? ` <small class="warn-t">파일 ${missing}개 없음</small>` : ""}</span><span class="nc-acts">${act}</span></div>`;
      }).join("");
      box.innerHTML = `<div class="exsec"><h5>${esc(c.folder)} 회차별 정리본<span class="link" data-nc-exam="${esc(c.folder)}">시험 대비 보기</span></h5>${rows}</div>`;
    };
    const load = async () => {
      const r = await api.note_collection();
      if (!r.ok) { scrim.querySelector("#ncMain").innerHTML = `<div class="hint">${esc(r.error)}</div>`; return; }
      S.data = r;
      if (!S.course || !course()) S.course = (r.courses.find((c) => c.with_notes) || r.courses[0] || {}).folder || null;
      draw();
    };
    window.__lecturehubNotesChanged = () => { if (document.body.contains(scrim)) load(); };
    scrim.addEventListener("click", async (e) => {
      if (e.target === scrim || e.target.closest("[data-close]")) { close(); return; }
      const t = e.target.closest("[data-nc-course],[data-nc-open],[data-nc-browser],[data-nc-make],[data-nc-exam]");
      if (!t || t.disabled) return;
      const d = t.dataset;
      if (d.ncCourse) { S.course = d.ncCourse; draw(); }
      else if (d.ncOpen) {
        close(); await openLecture(d.ncOpen);
        const i = (ui.htmlPages || []).findIndex((n) => n.path === d.path);
        if (i > 0) { $("htmlSel").value = String(i); showHtml(ui.htmlPages[i]); }
      }
      else if (d.ncBrowser) { const r = await api.open_path(d.ncBrowser); if (!r.ok) toast(r.error); }
      else if (d.ncMake) { t.disabled = true; if (await makeNote(d.ncMake)) draw(); else t.disabled = false; }
      else if (d.ncExam) { close(); openExam(d.ncExam); }
    });
    load();
  }
  /* ---------- exam prep (user 2026-10-11): per course its dates, what was said in class, prep files.
     Practice moved out of the app (user 2026-11-07, P-045): each course links to its own exam page instead. ---------- */
  const WD = ["일", "월", "화", "수", "목", "금", "토"];
  const dayText = (iso) => { const d = new Date(iso + "T00:00:00"); return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`; };
  function openExam(folder) {
    if (document.querySelector(".exam-panel")) return;
    const scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.innerHTML = `<div class="exam-panel"><div class="hhead"><b>시험 대비</b><span class="nsub">달력에서 확정한 일정만 날짜로 셉니다. 수업 중 들린 날짜는 확인 전까지 후보입니다.</span><button class="ibtn" data-close="1" title="닫기">✕</button></div><div class="exam-body"><div class="exam-courses" id="exCourses"></div><div class="exam-main" id="exMain"></div></div></div>`;
    document.body.appendChild(scrim); keepFocus(scrim);
    const S = { data: null, course: folder || null, adding: false };
    const close = () => { scrim.remove(); document.removeEventListener("keydown", key); loadExamChip(); };
    const course = () => S.data.courses.find((c) => c.folder === S.course);
    const when = (e) => `${dayText(e.date)}${e.start_ms !== null && e.start_ms !== undefined ? " " + hhmm(e.start_ms) : ""}`;
    const renderCourses = () => {
      scrim.querySelector("#exCourses").innerHTML = S.data.courses.map((c) => {
        const x = c.exams[0], n = (c.pages || []).length;
        return `<button class="exc${c.folder === S.course ? " on" : ""}" data-course="${esc(c.folder)}"><b>${esc(c.folder)}</b>` +
          (x ? `<span class="exd${x.d_day <= 7 ? " near" : ""}">${esc(x.kind_label)} ${dday(x.d_day)}</span>` : `<span class="exd none">일정 미정</span>`) +
          `<small>${n ? `시험 페이지 ${n}` : "시험 페이지 없음"}${c.files.length ? ` · 자료 ${c.files.length}` : ""}</small></button>`;
      }).join("") || `<div class="hint">과목이 없습니다.</div>`;
    };
    const pagesSection = (c) => {
      const pages = c.pages || [];
      const rows = pages.map((g) => `<div class="exrow page${g.missing ? " missing" : ""}"><button class="ghost primary" data-page-open="${esc(g.id)}"${g.missing ? " disabled" : ""}>${esc(g.title)}</button>` +
        `<small class="ptarget" title="${esc(g.target)}">${g.kind === "artifact" ? "claude.ai 아티팩트" : esc(g.missing ? "파일 없음 · " + g.path : g.path)}</small>` +
        `<button class="ibtn" data-page-del="${esc(g.id)}" title="링크 빼기 (페이지는 지우지 않음)">✕</button></div>`).join("");
      const form = S.adding
        ? `<div class="exacts page-add"><input class="ask" data-page-target="1" placeholder="https://claude.ai/artifact/… 또는 학기 폴더 안 .html" spellcheck="false" autocomplete="off">` +
          `<button class="ghost" data-page-pick="1">파일 고르기</button></div>` +
          `<div class="exacts page-add"><input class="ask" data-page-title="1" placeholder="이름 (비우면 파일 이름)" maxlength="60" autocomplete="off">` +
          `<button class="ghost primary" data-page-save="1">넣기</button><button class="ghost" data-page-cancel="1">취소</button></div>`
        : "";
      return `<div class="exsec pages"><h5>시험 페이지<small>과목마다 따로 만든 시험 대비 페이지를 바깥 창으로 엽니다</small>${S.adding ? "" : `<span class="link" data-page-add="1">+ 링크 추가</span>`}</h5>` +
        (rows || (S.adding ? "" : `<div class="hint">아직 없습니다. 이 과목의 시험 페이지(claude.ai 아티팩트 주소나 학기 폴더 안 HTML)를 [+ 링크 추가]로 넣어 주세요.</div>`)) + form + `</div>`;
    };
    const renderCourse = () => {
      const c = course(), box = scrim.querySelector("#exMain");
      if (!c) { box.innerHTML = `<div class="hint">왼쪽에서 과목을 고르세요.</div>`; return; }
      box.innerHTML =
        `<div class="exsec"><h5>시험 일정<span class="link" data-add="1">+ 일정 추가</span></h5>` +
        (c.exams.map((e) => `<div class="exrow" data-event="${e.id}"><b class="num">${esc(when(e))}</b><span>${esc(e.title)}</span><span class="exd${e.d_day <= 7 ? " near" : ""}">${dday(e.d_day)}</span>${e.source === "etl" ? `<small>eTL</small>` : ""}${e.note ? `<p>${esc(e.note)}</p>` : ""}</div>`).join("") ||
          `<div class="hint">확정된 시험·퀴즈 일정이 없습니다. 날짜를 알면 [+ 일정 추가]로 넣어 주세요.</div>`) +
        c.candidates.map((e) => `<div class="exrow cand" data-event="${e.id}"><b class="num">${esc(dayText(e.date))}</b><span>수업 중 들린 날짜 — 확인 필요</span><span class="link">달력에서 확정·무시</span>${e.evidence && e.evidence.quote ? `<p>“${esc(e.evidence.quote)}”</p>` : ""}</div>`).join("") + `</div>` +
        pagesSection(c) +
        `<div class="exsec"><h5>대비 자료</h5>` + (c.files.map((f) => `<div class="frow" data-path="${esc(f.path)}"><svg><use href="#i-file"/></svg><span class="fname">${esc(f.name)}</span><span class="nsub num">${esc(f.changed)}</span></div>`).join("") ||
          `<div class="hint">이름에 '대비'·'시험'·'문제'가 든 HTML이 과목 폴더나 정리본에 없습니다.</div>`) + `</div>` +
        `<div class="exsec"><h5>수업 중 발언<small>전사에 실제로 있는 말만 — 누르면 그 대목으로 갑니다</small></h5>` + (c.cues.map((u) => `<div class="exrow cue" data-lecture="${u.lecture_id}" data-at="${u.at_ms}"><b class="num">${esc(mdText(u.date))} ${clock(u.at_ms)}</b><span class="b cue">${esc(u.kind_label)}</span><small>${esc(u.by_label)}</small><p>“${esc(u.quote)}”${u.note ? `\n${esc(u.note)}` : ""}</p></div>`).join("") ||
          `<div class="hint">전사에서 찾은 시험 관련 발언이 없습니다.</div>`) + `</div>`;
      if (window.LHGerman) window.LHGerman.mountExam(box, c.folder, toast);  // 암기장 열기(german.js, P-037)
      const input = S.adding && box.querySelector("[data-page-target]"); if (input) input.focus();
    };
    const load = async () => {
      const r = await api.exam_board();
      if (!r.ok) { scrim.querySelector("#exMain").innerHTML = `<div class="hint">${esc(r.error)}</div>`; return; }
      S.data = r;
      if (!S.course || !course()) S.course = (r.courses[0] || {}).folder || null;
      renderCourses(); renderCourse();
      const said = ((r.banks && r.banks.cues) || []).reduce((n, c) => n + c.added, 0);
      const bad = ((r.banks && r.banks.errors) || []).filter((x) => /\.cues\.json$/.test(x.file));
      if (said) toast(`수업 중 발언 ${said}건을 읽어 들였습니다`);
      else if (bad.length) toast(`읽지 못한 발언 파일: ${bad[0].file} — ${bad[0].error}`);
    };
    const setPages = (r) => {  // add/remove answer with the course's new list
      if (!r.ok) { toast(r.error); return false; }
      const c = course(); if (c) c.pages = r.pages;
      renderCourses(); renderCourse();
      return true;
    };
    const savePage = async () => {
      const box = scrim.querySelector("#exMain"), c = course();
      const target = box.querySelector("[data-page-target]").value, title = box.querySelector("[data-page-title]").value;
      if (!target.trim()) { toast("주소나 파일을 넣어 주세요"); return; }
      S.adding = false;
      if (!setPages(await api.exam_page_add(c.folder, target, title))) { S.adding = true; renderCourse(); }
    };
    const key = (e) => {
      if (!isTop(scrim)) return;
      if (e.key === "Escape") { if (S.adding) { S.adding = false; renderCourse(); } else close(); return; }
      if (e.key === "Enter" && S.adding && e.target && e.target.matches("[data-page-target],[data-page-title]")) { e.preventDefault(); savePage(); }
    };
    document.addEventListener("keydown", key);
    scrim.addEventListener("click", async (e) => {
      if (e.target === scrim || e.target.closest("[data-close]")) { close(); return; }
      const t = e.target.closest("[data-course],[data-add],[data-event],[data-path],[data-lecture],[data-page-open],[data-page-del],[data-page-add],[data-page-pick],[data-page-save],[data-page-cancel]");
      if (!t || t.disabled) return;
      const d = t.dataset;
      if (d.course) { S.course = d.course; S.adding = false; renderCourses(); renderCourse(); }
      else if (d.add) { const n = new Date(); close(); openCalendar(n.getFullYear(), n.getMonth() + 1, { day: S.data.today, course_id: (course() || {}).id }); }
      else if (d.event) { const ev = [...course().exams, ...course().candidates].find((x) => x.id === d.event); close(); openCalendar(+ev.date.slice(0, 4), +ev.date.slice(5, 7), { id: ev.id }); }
      else if (d.path) { const r = await api.open_path(d.path); if (!r.ok) toast(r.error); }
      else if (d.lecture) { close(); openLecture(d.lecture, +d.at, null); }
      else if (d.pageOpen) { t.disabled = true; const r = await api.exam_page_open(S.course, d.pageOpen); t.disabled = false; toast(r.ok ? `${r.title} 여는 중…` : r.error); }
      else if (d.pageDel) {
        const g = (course().pages || []).find((x) => x.id === d.pageDel);
        if (g && await dialog({ title: "시험 페이지 링크 빼기", body: `'${g.title}' 링크만 뺍니다. 페이지(아티팩트·파일)는 지우지 않습니다.`, ok: "빼기", tone: "danger" })) setPages(await api.exam_page_remove(S.course, d.pageDel));
      }
      else if (d.pageAdd) { S.adding = true; renderCourse(); }
      else if (d.pageCancel) { S.adding = false; renderCourse(); }
      else if (d.pagePick) { const r = await api.exam_page_pick(S.course); const input = scrim.querySelector("[data-page-target]"); if (r.ok && r.path && input) input.value = r.path; }
      else if (d.pageSave) savePage();
    });
    load();
  }
  /* assignment helper (user request 2026-09-29): gather files + notes, then a Claude Code session does the writing */
  async function prepareAssignment(id) {
    toast("과제 자료를 모으는 중…");
    let r = await api.assignment_prepare(id);
    if (r.ok && r.need_consent) {
      // stored consent: the native window hands out a one-time token (security review 2026-11-05)
      const q = await api.consent_confirm("claude_assignment", r.need_consent);
      if (!q.ok) { toast(q.error); return; }
      if (!q.yes) return;
      const c = await api.assignment_consent(r.need_consent, q.token);
      if (!c.ok) { toast(c.error); return; }
      r = await api.assignment_prepare(id);
    }
    if (!r.ok) { toast(r.error); return; }
    const n = r.counts;
    const body = `과제 파일 ${n.assignment} · 작성요령 ${n.guide} · 강의계획서 ${n.syllabus} · 수업 ${r.lectures}회` +
      (r.top_lectures.length ? `\n관련 높은 수업: ${r.top_lectures.map(mdText).join(", ")}` : "") + `\n${r.ai_policy}` +
      (r.etl ? "" : "\neTL 과제 설명은 가져오지 못했습니다(eTL 연결 전이면 Claude가 내용을 물어봅니다).") +
      "\n\nClaude Code 창에서 과제 내용을 정리해 보여 주고, 모르는 것만 묻고 초안을 씁니다.";
    const go = await dialog({ title: "과제 묶음을 만들었습니다", body, ok: "Claude Code로 시작", cancel: "닫기" });
    if (!go) return;
    const x = await api.assignment_claude(id);
    toast(x.ok ? "Claude Code 창을 열었습니다" : x.error);
  }

  function openCalendar(year, month, pick) {
    const now = new Date();
    const state = { year: year || now.getFullYear(), month: month || now.getMonth() + 1, data: null, editing: null };
    document.querySelectorAll(".cal-scrim").forEach((s) => s.remove());
    const scrim = document.createElement("div");
    scrim.className = "scrim cal-scrim";
    scrim.innerHTML = `<div class="cal-panel compact"><div class="cal-head"><b id="calTitle">일정</b><span class="grow"></span><button class="ghost" data-c="add">+ 일정 추가</button><button class="ibtn" data-c="close" title="닫기">✕</button></div><div class="cal-body"><div class="cal-grid" id="calGrid"></div><div class="cal-side" id="calSide"></div></div></div>`;
    document.body.appendChild(scrim); keepFocus(scrim);
    const close = () => { scrim.remove(); document.removeEventListener("keydown", key); loadNotices(); if (ui.view === "home") renderHome(); else loadExamChip(); };
    const key = (e) => { if (e.key === "Escape" && isTop(scrim)) close(); };
    document.addEventListener("keydown", key);
    const load = async () => {
      const [r, etl, board] = await Promise.all([api.calendar(state.year, state.month), api.etl_status(), api.etl_board()]);
      state.data = r; state.etl = etl.ok ? etl : null; state.board = board.ok ? board : null;
      if (pick && r.ok) {  // opened from the start screen: that day's form or that event
        const ev = pick.id && [...r.events, ...r.upcoming, ...r.candidates].find((x) => x.id === pick.id);
        state.editing = ev ? { ...ev } : pick.day ? { kind: "exam", date: pick.day, course_id: pick.course_id || null } : null;
        pick = null;
      }
      draw();
    };
    const ago = (s) => { const m = Math.round((Date.now() / 1000 - s) / 60); return m < 1 ? "방금" : m < 60 ? `${m}분 전` : m < 1440 ? `${Math.round(m / 60)}시간 전` : `${Math.round(m / 1440)}일 전`; };
    const etlLine = () => {
      const e = state.etl;
      if (!e) return "";
      if (!e.connected) return `<div class="etl">eTL 과제 마감을 자동으로 가져오려면 <span class="link" data-c="etl-connect">eTL 연결</span></div>`;
      const when = e.ok_at ? `${ago(e.ok_at)} 가져옴 · ${e.count}건` : "아직 가져오지 않음";
      return `<div class="etl">eTL 과제: ${when}${e.error && (!e.ok_at || e.error_at > e.ok_at) ? ` · <span class="warn">${esc(e.error)}</span>` : ""} · <span class="link" data-c="etl-sync">지금 가져오기</span> · <span class="link" data-c="etl-connect">토큰 바꾸기</span></div>`;
    };
    const size = (n) => n >= 1073741824 ? (n / 1073741824).toFixed(2) + "GB" : n >= 1048576 ? Math.round(n / 1048576) + "MB" : Math.max(1, Math.round(n / 1024)) + "KB";
    const etlBoard = () => {
      const b = state.board, e = state.etl;
      if (!b || !e || !e.connected) return "";
      const open = state.openAnn || (state.openAnn = new Set());
      const notes = b.announcements.slice(0, state.allAnn ? 30 : 5).map((a) =>
        `<div class="ann${open.has(a.id) ? " open" : ""}" data-ann="${esc(a.id)}"><div class="ah"><span class="num">${esc(mdText(a.posted.slice(0, 10)))}</span><b>${esc(a.course)}</b><span>${esc(a.title)}</span></div>` +
        (open.has(a.id) ? `<div class="at">${esc(a.text)}${a.attachments.length ? `<div class="nsub">첨부: ${esc(a.attachments.join(", "))}</div>` : ""}</div>` : "") + `</div>`).join("");
      const what = { changed: "크기가 다름", local: "다운로드 폴더에 있음", missing: "없음" };
      const who = { mine: "내가 고침", etl: "eTL이 바뀜", both: "둘 다 바뀜", unknown: "크기가 다름" };
      const files = b.files.map((f) => {
        const get = `<span class="link" data-etlf="beside" data-id="${f.id}">eTL 판도 옆에 받기</span>`, stay = `<span class="link" data-etlf="keep" data-id="${f.id}">내 것만 두기</span>`;
        const acts = f.state === "changed" ? (f.case === "mine" ? stay + get : get + stay)  // the likely answer first
          : `<span class="link" data-etlf="${f.big ? "big" : "take"}" data-id="${f.id}">${f.state === "local" ? "과목 폴더로 옮기기" : "받기"}</span>`;
        const detail = f.state === "changed"
          ? `<b>${esc(f.hint)}</b><br>내 파일 ${size(f.mine_size)} · 받은 때 ${esc(f.mine_created.replace("T", " "))} · 고친 때 ${esc(f.mine_changed.replace("T", " "))}<br>eTL 파일 ${size(f.size)} · 올라온 때 ${esc(f.updated.replace("T", " "))}`
          : `${size(f.size)} · eTL ${esc(f.updated.slice(0, 10))}${f.big ? " · 큰 파일" : ""}`;
        return `<div class="ef ${f.state}"><div><b>${esc(f.course)}</b> ${esc(f.name)} <small>${f.state === "changed" ? who[f.case] : what[f.state]}</small></div><div class="nsub">${detail}</div><div class="eacts">${acts}</div></div>`;
      }).join("");
      return `<div class="sl">eTL 공지${b.announcements.length > 5 && !state.allAnn ? ` <span class="link" data-c="ann-all">전체 ${b.announcements.length}건</span>` : ""}</div>${notes || `<div class="hint">가져온 공지가 없습니다.</div>`}` +
        `<div class="sl">eTL 자료 — 과목 폴더에 없는 것 ${b.files.length}개 <small>(있는 것 ${b.have} / 전체 ${b.total})</small></div>${files || `<div class="hint">${b.total ? "eTL에 올라온 파일이 모두 과목 폴더에 있습니다." : "아직 파일 목록을 가져오지 않았습니다. [지금 가져오기]를 누르세요."}</div>`}` +
        (b.closed.length ? `<div class="nsub">파일 목록을 열어 두지 않은 과목: ${esc(b.closed.join(", "))}</div>` : "");
    };
    const etlFile = async (t) => {
      const id = +t.dataset.id, how = t.dataset.etlf;
      if (how === "keep") { const r = await api.etl_file_keep(id); if (!r.ok) toast(r.error); return load(); }
      if (how === "big" && !(await dialog({ title: "큰 파일입니다 — 받을까요?", body: "용량이 커서 시간이 걸립니다. 과목 폴더에 그대로 저장합니다.", ok: "받기" }))) return;
      toast("eTL 파일을 넣는 중…");
      const r = await api.etl_file_take(id, how === "beside", how === "big");
      toast(r.ok ? `${r.state === "moved" ? "다운로드 폴더에서 옮겼습니다" : "받았습니다"} · ${r.name}` : r.error);
      load();
    };
    const etlSync = async (token) => {
      toast("eTL에서 과제를 가져오는 중…");
      const r = await api.etl_sync(true, token || null);
      if (!r.ok) { toast(r.error); load(); return; }
      toast(`eTL 과제 ${r.count}건 확인 · 새로 ${r.added}건, 날짜 바뀜 ${r.updated}건` + (r.board ? ` · 공지 ${r.board.announcements}건 · 파일 ${r.board.files}개` : r.board_error ? ` · ${r.board_error}` : "") + (r.unmatched && r.unmatched.length ? ` · 시간표에 없는 과목: ${r.unmatched.join(", ")}` : ""));
      load();
    };
    const draw = () => {
      const r = state.data;
      scrim.querySelector("#calTitle").textContent = state.editing ? "일정" : "다가오는 일정 · 확인할 날짜";
      if (!r.ok) {
        scrim.querySelector("#calGrid").innerHTML = `<div class="hint">달력을 열 수 없습니다: ${esc(r.error)}</div>`;
        scrim.querySelector("#calSide").innerHTML = "";
        return;
      }
      const first = new Date(state.year, state.month - 1, 1), days = new Date(state.year, state.month, 0).getDate();
      const lead = (first.getDay() + 6) % 7;  // Monday first
      const byDay = {};
      r.events.forEach((e) => { (byDay[e.date] = byDay[e.date] || []).push(e); });
      const exc = {};
      r.exceptions.forEach((e) => { (exc[e.date] = exc[e.date] || []).push(e); });
      let html = "월화수목금토일".split("").map((d) => `<div class="dow">${d}</div>`).join("") + "<div></div>".repeat(lead);
      for (let d = 1; d <= days; d++) {
        const iso = `${state.year}-${String(state.month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        const items = (byDay[iso] || []).slice(0, 3).map((e) => `<div class="ev k-${e.kind}${e.source === "etl" ? " etl" : ""}" data-edit="${e.id}" title="${esc(e.title + (e.note ? " — " + e.note : ""))}">${e.start_ms !== null ? hhmm(e.start_ms) + " " : ""}${e.course ? esc(e.course) + " " : ""}${esc(e.kind_label)}${e.date_precision === "approx" ? "(쯤)" : ""}</div>`).join("");
        const more = (byDay[iso] || []).length > 3 ? `<div class="more">+${byDay[iso].length - 3}</div>` : "";
        const ex = (exc[iso] || []).map((e) => `<div class="ex" title="${esc(e.note)}">${esc(e.course)} ${esc(e.kind)}${e.confirmation === "confirmed_by_user" ? "" : "(추정)"}</div>`).join("");
        html += `<div class="day${iso === r.today ? " today" : ""}" data-day="${iso}"${dayAttrs(iso, r.today, (byDay[iso] || []).length)}><span class="n">${d}</span>${ex}${items}${more}</div>`;
      }
      scrim.querySelector("#calGrid").innerHTML = html;
      const masked = document.body.classList.contains("masked");
      const hw = (e) => (e.kind === "assignment" && ed("assignment") && e.d_day >= 0 ? `<span class="hw-acts"><button class="mini" data-hw="${e.id}" title="과제 파일·작성요령·관련 수업 노트를 모아 Claude Code로 과제를 시작합니다">과제 준비</button><button class="mini" data-hwopen="${e.id}" title="모아 둔 과제 폴더 열기">폴더</button></span>` : "");
      const up = r.upcoming.map((e) => `<div class="up" data-edit="${e.id}"><span class="dd">${dday(e.d_day)}</span><span>${e.course ? esc(e.course) + " · " : ""}${esc(e.title)}<small>${mdText(e.date)}${e.start_ms !== null ? " " + hhmm(e.start_ms) : ""}${e.source === "etl" ? " · eTL" : ""}${e.note && e.source !== "etl" ? " · " + esc(e.note) : ""}</small>${hw(e)}</span></div>`).join("") || `<div class="hint">60일 안에 잡힌 일정이 없습니다.</div>`;
      const cand = r.candidates.map((c) => {
        const ev = c.evidence || {};
        return `<div class="cand"><div><b>${c.course ? esc(c.course) + " · " : ""}${esc(c.kind_label)} ${esc(c.date_text || mdText(c.date))}</b> <small>${esc(c.title)}${ev.engines_agree > 1 ? ` · 엔진 ${ev.engines_agree}개 일치` : " · 한 엔진만"}</small></div>` +
          `<div class="q">${masked ? "(전사 가림 — 전사 탭의 [전사 보기]를 누르면 인용이 보입니다)" : "“" + esc(ev.quote || "") + "”"}</div>` +
          `<div class="acts">${ev.lecture_id ? `<button class="ghost" data-go="${ev.lecture_id}" data-ms="${ev.at_ms || 0}">전사로 가기</button>` : ""}<button class="ghost" data-edit="${c.id}">날짜 고쳐서 확정</button><button class="primary" data-confirm="${c.id}">확정</button><button class="ghost" data-dismiss="${c.id}">무시</button></div></div>`;
      }).join("");
      scrim.querySelector("#calSide").innerHTML = (state.editing ? form() : "") +
        `<div class="sl">다가오는 일정</div>${up}` + (cand ? `<div class="sl">확인 필요 — 수업 중 언급 ${r.candidates.length}건</div>${cand}` : "") +
        etlLine() + etlBoard() + `<div class="src">출처: 직접 입력 · eTL 과제 마감·공지·자료 목록(읽기만, 받기는 누를 때만) · 수업 중 발언(확정 전까지 후보)</div>`;
    };
    const form = () => {
      const e = state.editing, r = state.data;
      const opts = KIND_OPTIONS.map(([v, t]) => `<option value="${v}"${e.kind === v ? " selected" : ""}>${t}</option>`).join("");
      const courses = `<option value="">과목 없음</option>` + r.courses.map((c) => `<option value="${c.id}"${e.course_id === c.id ? " selected" : ""}>${esc(c.folder)}</option>`).join("");
      return `<div class="cal-form"><div class="sl">${e.id ? (e.status === "candidate" ? "후보 고쳐서 확정" : "일정 고치기") : "일정 추가"}</div>
        <div class="row"><select id="fKind">${opts}</select><select id="fCourse">${courses}</select></div>
        <input id="fTitle" placeholder="제목 (예: 중간고사)" value="${esc(e.title || "")}">
        <div class="row"><input id="fDate" type="date" value="${esc(e.date || "")}"><input id="fStart" type="time" value="${esc(hhmm(e.start_ms))}"><input id="fEnd" type="time" value="${esc(hhmm(e.end_ms))}"></div>
        <textarea id="fNote" placeholder="메모 — 시험 범위, 장소 등">${esc(e.note || "")}</textarea>
        <div class="acts">${e.id && e.status !== "candidate" ? `<button class="ghost danger-t" data-c="cancel-ev">일정 취소</button>` : ""}<span class="grow"></span><button class="ghost" data-c="form-close">닫기</button><button class="primary" data-c="save">저장</button></div></div>`;
    };
    const values = () => ({ kind: scrim.querySelector("#fKind").value, course_id: scrim.querySelector("#fCourse").value, title: scrim.querySelector("#fTitle").value,
      date: scrim.querySelector("#fDate").value, start: scrim.querySelector("#fStart").value, end: scrim.querySelector("#fEnd").value, note: scrim.querySelector("#fNote").value });
    const findEvent = (id) => { const r = state.data; return [...r.events, ...r.upcoming, ...r.candidates].find((x) => x.id === id); };
    scrim.addEventListener("click", async (e) => {
      if (e.target === scrim) { close(); return; }
      const t = e.target.closest("[data-c],[data-hw],[data-hwopen],[data-edit],[data-confirm],[data-dismiss],[data-go],[data-day],[data-etlf],[data-ann]"); if (!t) return;
      const c = t.dataset.c;
      if (t.dataset.etlf) return etlFile(t);
      if (t.dataset.ann) { const o = state.openAnn; o.has(t.dataset.ann) ? o.delete(t.dataset.ann) : o.add(t.dataset.ann); return draw(); }
      if (c === "ann-all") { state.allAnn = true; return draw(); }
      if (c === "close") return close();
      if (t.dataset.hw) return prepareAssignment(t.dataset.hw);
      if (t.dataset.hwopen) { const x = await api.assignment_open(t.dataset.hwopen); if (!x.ok) toast(x.error); return; }
      if (c === "etl-sync") return etlSync();
      if (c === "etl-connect") {
        const token = await askText({ title: "eTL 연결", ok: "연결", secret: true, body: "eTL(myetl.snu.ac.kr) → 계정 → 설정 → '새 액세스 토큰'에서 용도에 Lecture Hub를 적고 만든 토큰을 붙여 넣으세요. 과제 목록을 읽기만 하고, 토큰은 이 PC의 Windows 자격 증명 관리자에만 저장됩니다." });
        if (token && token.trim()) return etlSync(token.trim());
        return;
      }
      if (c === "prev" || c === "next") { const d = new Date(state.year, state.month - 1 + (c === "next" ? 1 : -1), 1); state.year = d.getFullYear(); state.month = d.getMonth() + 1; return load(); }
      if (c === "add") { state.editing = { kind: "exam", date: "" }; return draw(); }
      if (c === "form-close") { state.editing = null; return draw(); }
      if (c === "save") {
        const v = values(), ed = state.editing;
        if (!v.title.trim() || !v.date) { toast("제목과 날짜를 넣어 주세요"); return; }
        let r;
        if (ed.id) { r = await api.calendar_update(ed.id, { ...v, day: v.date }); if (r.ok && ed.status === "candidate") r = await api.calendar_status(ed.id, "confirmed"); }
        else r = await api.calendar_add(v);
        if (!r.ok) { toast(r.error || "저장하지 못했습니다"); return; }
        state.editing = null; toast("저장했습니다"); return load();
      }
      if (c === "cancel-ev") {
        const go = await dialog({ title: "이 일정을 취소할까요?", body: `${state.editing.title || "일정"} — 달력에서 빠집니다. 기록은 남습니다.`, ok: "일정 취소", cancel: "그대로 두기", tone: "danger" });
        if (!go) return;
        const r = await api.calendar_status(state.editing.id, "cancelled"); if (r.ok) { state.editing = null; toast("일정을 취소했습니다(기록은 남음)"); load(); } return; }
      if (t.dataset.edit) { const ev = findEvent(t.dataset.edit); if (ev) { state.editing = { ...ev }; draw(); } return; }
      if (t.dataset.confirm) { const r = await api.calendar_status(t.dataset.confirm, "confirmed"); if (r.ok) { toast("확정했습니다"); load(); } else toast(r.error); return; }
      if (t.dataset.dismiss) { const r = await api.calendar_status(t.dataset.dismiss, "cancelled"); if (r.ok) load(); return; }
      if (t.dataset.go) { close(); openLecture(t.dataset.go, +t.dataset.ms); return; }
      if (t.dataset.day && !state.editing) { state.editing = { kind: "exam", date: t.dataset.day }; draw(); }
    });
    load();
  }

  /* 그스룸 함께 쓰는 사람: 이름 | 학번 연도 - 나머지 칸 (user 2026-11-14). rows: [[이름, 연도, 나머지], ...] */
  const nameWidth = (s) => `${Math.max(3, [...String(s || "")].length) + 1.6}em`;  // a 3-letter name fits; longer names widen the box
  const mateRow = (m, i) => `<div class="mate" data-i="${i}"><input class="ask m-name" data-f="0" style="width:${nameWidth(m[0])}" value="${esc(m[0])}" placeholder="이름" maxlength="20" autocomplete="off" aria-label="이름"><input class="ask m-y" data-f="1" value="${esc(m[1])}" placeholder="2020" inputmode="numeric" autocomplete="off" aria-label="학번 앞 4자리(입학 연도)"><span class="m-dash">-</span><input class="ask m-n" data-f="2" value="${esc(m[2])}" placeholder="12345" maxlength="8" inputmode="numeric" autocomplete="off" aria-label="학번 뒤 자리"><button class="ibtn m-del" data-mdel="${i}" title="이 줄 지우기" aria-label="이 줄 지우기">✕</button></div>`;
  const matesHtml = (rows) => `<div class="mates">${rows.map(mateRow).join("")}</div><button class="ghost m-add" data-madd="1">+ 사람 추가</button>`;
  const matesText = (rows) => rows.filter((m) => m[0].trim() || m[1] || m[2]).map((m) => `${m[0].trim().replace(/\s+/g, " ") || "?"} ${m[1]}${m[2]}`).join("\n");
  const matesFrom = (pairs) => { const out = (pairs || []).map(([n, no]) => [String(n), String(no).slice(0, 4), String(no).slice(4)]); while (out.length < 3) out.push(["", "", ""]); return out; };
  // typing in a row: keeps rows in step; 4 digits of the year (or a pasted 'YYYY-NNNNN') moves on to the second box
  const matesInput = (e, rows) => {
    const inp = e.target.closest(".mate input"); if (!inp) return false;
    const i = +inp.closest(".mate").dataset.i, f = +inp.dataset.f, row = rows[i]; if (!row) return true;
    let v = inp.value;
    if (f) { v = v.replace(/\D/g, ""); if (v !== inp.value) inp.value = v; } else inp.style.width = nameWidth(v);
    if (f === 1 && v.length > 4) { const rest = inp.parentNode.querySelector(".m-n"); row[2] = rest.value = v.slice(4, 12); v = inp.value = v.slice(0, 4); rest.focus(); }
    else if (f === 1 && v.length === 4 && e.inputType !== "deleteContentBackward") inp.parentNode.querySelector(".m-n").focus();
    row[f] = v; return true;
  };
  const matesClick = (t, rows) => {
    if (t.closest("[data-madd]")) { if (rows.length < 8) rows.push(["", "", ""]); return true; }
    const del = t.closest("[data-mdel]"); if (!del) return false;
    rows.splice(+del.dataset.mdel, 1); while (rows.length < 3) rows.push(["", "", ""]); return true;
  };

  /* ---------- 그룹스터디룸 예약 (P-019): Aside(기본, D-069) 또는 Claude in Chrome이 예약·반납하고, 앱은 결과만 보여 준다 ---------- */
  function openRoom(only) {
    document.querySelectorAll(".room-scrim").forEach((s) => s.remove());
    const publicRooms = (ui.info.edition || {}).name === "public";
    const prefs = !publicRooms && (ui.info.edition || {}).gsr_prefs !== false;  // full build: saved companions prefill the form
    const rulesOnly = only === "rules" && !publicRooms;  // 사이드바 정기 예약 버튼: 규칙·다음 시도·정기 예약 기록만
    const st = { data: null, day: null, start: "15:00", hours: 3, use: "과제", room: "", mates: matesFrom([]), me: [["", "", ""]], saved: [], rules: [], auto: true, dirty: false, lastJob: null, alts: null, notice: null, chat: [], thinking: false };
    const scrim = document.createElement("div");
    scrim.className = "scrim cal-scrim room-scrim";
    scrim.innerHTML = rulesOnly
      ? `<div class="cal-panel room-panel room-rules"><div class="cal-head"><b>그스룸 정기 예약</b><small class="room-sub">매주 같은 요일·시각에 자동 예약 (30분~12시간)</small><span class="grow"></span><button class="ghost" data-c="full">그스룸 창</button><button class="ibtn" data-c="close" title="닫기">✕</button></div><div class="room-job" id="roomJob" hidden></div><div class="room-main room-rules-body" id="roomMain"></div></div>`
      : `<div class="cal-panel room-panel"><div class="cal-head"><b>그룹스터디룸 예약</b><small class="room-sub">관정관 4층 6인실 · ${publicRooms ? "최대 3시간 · 예약마다 확인" : "30분~12시간(3시간을 넘으면 이어서)"} · 신청인+동반 3명</small><span class="grow"></span>${publicRooms ? "" : `<button class="ghost" data-c="rules">정기 예약</button>`}<button class="ghost" data-c="refresh">예약 목록 확인</button><button class="ibtn" data-c="close" title="닫기">✕</button></div><div class="room-job" id="roomJob" hidden></div>${publicRooms ? "" : `<div class="room-chat"><div class="room-chat-log" id="roomChatLog" hidden></div><div class="room-chat-in"><input id="rChat" autocomplete="off" maxlength="300" placeholder="말로 지시하세요 — 내일 2시부터 6시간 예약 · 수요일 거 취소"><button class="primary" data-c="chat" id="rChatGo">보내기</button></div></div>`}<div class="cal-body"><div class="room-main" id="roomMain"></div><div class="cal-side" id="roomSide"></div></div></div>`;
    document.body.appendChild(scrim); keepFocus(scrim);
    const main = scrim.querySelector("#roomMain"), side = scrim.querySelector("#roomSide"), banner = scrim.querySelector("#roomJob");
    let timer = null;
    const close = () => { clearTimeout(timer); scrim.remove(); document.removeEventListener("keydown", key); };
    const key = (e) => { if (e.key === "Escape" && isTop(scrim)) close(); };
    document.addEventListener("keydown", key);
    if (prefs && !rulesOnly) api.gsr_companions_get().then((r) => {
      if (!r.ok || !r.rows.length) return;
      st.saved = r.rows;
      if (r.applicant && !matesText(st.me)) st.me = [[r.applicant[0], String(r.applicant[1]).slice(0, 4), String(r.applicant[1]).slice(4)]];
      if (!matesText(st.mates)) { st.mates = matesFrom(r.rows); if (st.data && main.querySelector(".room-mates")) draw(); }
    });
    const hm = (t) => (t && t.length === 4 ? `${t.slice(0, 2)}:${t.slice(2)}` : t || "");
    const viaAside = () => ((st.data || {}).browser || "aside") === "aside";
    const browserName = () => (viaAside() ? "Aside" : "Chrome");
    const plus3h = (t, h = 3) => { const m = +t.slice(0, 2) * 60 + +t.slice(3, 5) + h * 60; return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };
    const dayLabel = (iso) => { const d = (st.data.days || []).find((x) => x.date === iso); return d ? d.label : mdText(iso); };
    const stamp = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
    const hText = (h) => { const m = Math.round(h * 60); return m % 60 === 0 ? `${m / 60}시간` : m < 60 ? `${m}분` : `${Math.floor(m / 60)}시간 ${m % 60}분`; };
    const KIND = { book: "예약", return: "반납", cancel: "예약 취소", list: "확인", chat: "말로 지시" };
    const BY = { app: "앱", "app-auto": "앱 자동반납", task: "예약 작업" };
    const WD = "월화수목금토일", wd = (d) => WD[(d.getDay() + 6) % 7];
    const md = (d) => `${d.getMonth() + 1}/${d.getDate()}(${wd(d)})`;
    // 정기 예약은 앱 밖의 예약 작업(스케줄러)이 하루 두 번 '오늘+3일'을 보고 건다. TRY = 그 작업의 실행 시각(작업 설정과 맞춘다)
    const TRY = [[0, 5], [9, 5]];
    const tryText = (h, m) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    const nextTry = (rule) => {
      const now = new Date();
      for (let k = 0; k < 15; k++) {
        const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + k);
        if (wd(day) !== rule.weekday) continue;
        for (const [h, m] of TRY) {
          const at = new Date(day.getFullYear(), day.getMonth(), day.getDate() - 3, h, m);
          if (at > now) return { day, at };
        }
      }
      return null;
    };
    const chatLog = scrim.querySelector("#roomChatLog"), chatIn = scrim.querySelector("#rChat");
    const drawChat = () => {
      if (!chatLog) return;
      chatLog.hidden = !st.chat.length;
      chatLog.innerHTML = st.chat.slice(-5).map((m, i, all) => `<div class="rc ${m.who}">${esc(m.text)}${m.confirm && i === all.length - 1 ? `<span class="rc-acts"><button class="primary" data-chat-do="1"${st.thinking ? " disabled" : ""}>${m.confirm.intent === "book" ? "예약 확인" : m.confirm.intent === "cancel" ? "예약 취소" : "반납"}</button><button class="ghost" data-chat-no="1">그만두기</button></span>` : ""}</div>`).join("");
      chatLog.scrollTop = chatLog.scrollHeight;
    };
    const sendChat = async () => {
      if (!chatIn) return;  // public edition: manual booking only (user 2026-11-14)
      const text = (chatIn.value || "").trim();
      if (!text || st.thinking) return;
      chatIn.value = ""; st.thinking = true;
      st.chat.push({ who: "me", text }, { who: "bot", text: "해석하는 중… (몇 초)" }); drawChat();
      const r = await api.room_chat(text);
      st.thinking = false; st.chat.pop();
      if (!r.ok) st.chat.push({ who: "bot", text: r.error || "해석하지 못했습니다" });
      else st.chat.push({ who: "bot", text: r.say || "", confirm: r.confirm || null });
      drawChat();
      if (r.ok && r.started) { st.notice = null; st.lastJob = "running"; load(); }
    };
    const load = async () => {
      clearTimeout(timer);
      const r = await api.room();
      st.data = r;
      if (r.ok) {
        if (!r.days.some((d) => d.date === st.day)) st.day = (r.days[1] || r.days[0]).date;
        if (!r.starts.includes(st.start)) st.start = r.starts[0];
        if (!st.dirty) { st.rules = r.rules.map((x) => ({ ...x })); st.auto = r.auto_return; }
        const job = r.job || {};
        if (st.lastJob === "running" && job.state !== "running") finished(job);
        st.lastJob = job.state;
        if (job.state === "running") timer = setTimeout(load, 2000);
      }
      draw();
    };
    const finished = (job) => {
      const res = job.result || {};
      let text;
      if (job.state === "stopped") {
        const what = { book: "예약", cancel: "취소", return: "반납" }[job.action];
        text = `중지했습니다.${what ? ` 사이트에 ${what} 요청이 이미 나갔다면 처리됐을 수 있으니 [예약 목록 확인]으로 확인하세요.` : ""} ${browserName()}에 예약 탭이 남아 있으면 닫아 주세요.`;
        st.notice = { tone: "stop", text }; return;
      }
      if (res.login_required) text = `SNU 로그인이 풀려 있고 자동 로그인도 되지 않았습니다. ${browserName()}에서 로그인한 뒤 다시 누르세요.`;
      else if (job.action === "book") text = res.ok ? `${res.room}${String(res.room).split("·").every((n) => (st.data.monitor_rooms || []).includes(n)) ? "(모니터 있음)" : " (모니터 없는 방)"} 예약했습니다 — ${dayLabel(`${res.date.slice(0, 4)}-${res.date.slice(4, 6)}-${res.date.slice(6)}`)} ${hm(res.start)}~${hm(res.end)}${res.shortened ? ` (${hText((res.requested || 180) / 60)} 빈 방이 없어 ${hText(res.minutes / 60)}만 잡음)` : ""}` : `예약하지 못했습니다: ${res.why || res.error || "이유 미상"}${res.partial ? ` — 앞 ${res.blocks.length}블록(${res.blocks.map((b) => `${b[0]} ${hm(b[1])}~${hm(b[2])}`).join(", ")})은 예약됨` : ""}`;
      else if (job.action === "cancel") text = res.ok ? `${(res.cancelled || []).map((c) => `${c[0]} ${c[1].slice(11)}~${c[2]}`).join(", ")} 예약을 취소했습니다` : `취소하지 않았습니다: ${res.why || res.error || "이유 미상"}${(res.cancelled || []).length ? ` — 앞 ${res.cancelled.length}건(${res.cancelled.map((c) => `${c[0]} ${c[1].slice(11)}~${c[2]}`).join(", ")})은 취소됨` : ""}`;
      else if (job.action === "return") text = res.ok ? `${res.room || ""} 반납했습니다` : `반납하지 않았습니다: ${res.why || res.error || "이유 미상"}`;
      else text = res.ok ? "예약 목록을 새로 받았습니다" : `확인하지 못했습니다: ${res.error || "이유 미상"}`;
      st.notice = { tone: res.ok ? "ok" : "bad", text };
      if (job.action === "book") st.alts = res.ok && !res.shortened ? null : res.alternatives || null;
    };
    const row = (b, dis) => `<div class="room-bk${b.active ? "" : " past"}"><i class="dot ${b.tone === "done" ? "" : b.tone}"></i><div class="grow"><b>${esc(b.seat)}</b>${b.monitor ? ` <span class="tag">모니터</span>` : ""} ${esc(b.when)}<small>${esc(b.status_name)}${b.auto_at ? " · " + esc(b.auto_at) : ""}</small></div>` +
      (b.can_return ? `<button class="ghost" data-ret="${esc(b.id)}" data-seat="${esc(b.seat)}"${dis}>반납</button>` : "") +
      (b.chain ? `<button class="ghost" data-cancel="${esc(b.chain.ids.join(","))}" data-seat="${esc(b.chain.seat)}" data-when="${esc(b.chain.when)}" data-n="${b.chain.ids.length}"${dis}>이어진 ${b.chain.ids.length}건 취소</button>` : "") +
      (b.can_cancel ? `<button class="ghost" data-cancel="${esc(b.id)}" data-seat="${esc(b.seat)}" data-when="${esc(b.when)}" data-n="1"${dis}>${b.chain ? "이 블록만 취소" : "예약 취소"}</button>` : "") + `</div>`;
    const draw = () => {
      const r = st.data;
      if (!r || !r.ok) { main.innerHTML = `<div class="hint">그스룸을 열 수 없습니다: ${esc(r && r.error)}</div>`; if (side) side.innerHTML = ""; return; }
      const job = r.job || {}, running = job.state === "running", dis = running ? " disabled" : "";
      if (running) {
        banner.hidden = false; banner.className = "room-job run";
        banner.innerHTML = `<i class="dot rec"></i><span class="grow">${job.stopping ? "중지하는 중…" : (viaAside() ? `Aside에서 ‘${esc(job.label)}’ 하는 중… 몇 초면 끝납니다.` : `Claude가 Chrome에서 ‘${esc(job.label)}’ 하는 중… 1분쯤 걸립니다.`) + " 이 창을 닫아도 계속됩니다."}</span><button class="ghost" data-c="stop"${job.stopping ? " disabled" : ""} title="작업을 멈춥니다. 사이트에 요청이 이미 나갔다면 되돌려지지 않습니다">중지</button>`;
      }
      else if (st.notice) { banner.hidden = false; banner.className = "room-job " + st.notice.tone; banner.textContent = st.notice.text; }
      else banner.hidden = true;
      scrim.querySelectorAll('[data-c="refresh"]').forEach((b) => { b.disabled = running; });
      const opt = (list, cur) => list.map((v) => `<option${v === cur ? " selected" : ""}>${esc(v)}</option>`).join("");
      const hopt = (cur) => (r.hours || [3]).map((h) => `<option value="${h}"${h === (+cur || 3) ? " selected" : ""}>${hText(h)}</option>`).join("");
      const logRow = (e) => `<div class="room-log${e.ok || e.skipped || e.stopped ? "" : " bad"}"><span class="t">${esc(stamp(e.ts))}</span>${esc(KIND[e.kind] || e.kind)}${e.room ? " " + esc(e.room) : ""}${e.ok ? " ✓" : ""}${e.detail ? " — " + esc(e.detail) : ""}<small>${esc(BY[e.by] || e.by || "")}</small></div>`;
      const ruleRows = (wide) => st.rules.map((x, i) => `<div class="room-rule"><input type="checkbox" title="켜기/끄기" data-ri="${i}" data-rk="enabled"${x.enabled ? " checked" : ""}>` +
        `<select data-ri="${i}" data-rk="weekday">${opt(r.weekdays, x.weekday)}</select><select data-ri="${i}" data-rk="start">${opt(r.starts, x.start)}</select>` +
        `<select data-ri="${i}" data-rk="hours" title="길이">${hopt(x.hours)}</select>` + (wide ? `<span class="room-end">~ ${plus3h(x.start, x.hours || 3)}</span>` : "") +
        `<select data-ri="${i}" data-rk="use">${opt(r.uses, x.use)}</select><button class="ibtn" data-rdel="${i}" title="규칙 지우기">✕</button></div>`).join("") || `<div class="hint">규칙이 없습니다. [+ 규칙]으로 추가하세요.</div>`;
      const ruleActs = `<div class="acts"><button class="ghost" data-c="radd">+ 규칙</button><span class="grow"></span>${st.dirty ? `<span class="hint">저장하지 않은 변경</span>` : ""}<button class="primary" data-c="rsave"${st.dirty ? "" : " disabled"}>저장</button></div>`;
      if (rulesOnly) {
        const plan = (st.dirty ? r.rules : st.rules).map((x) => {
          if (!x.enabled) return `<div class="room-next off"><b>${esc(x.weekday)} ${esc(x.start)}~${plus3h(x.start, x.hours || 3)}</b><small>꺼짐</small></div>`;
          const n = nextTry(x);
          return n ? `<div class="room-next"><b>${md(n.day)} ${esc(x.start)}~${plus3h(x.start, x.hours || 3)}</b> ${esc(x.use)}<small>${md(n.at)} ${tryText(n.at.getHours(), n.at.getMinutes())}에 예약 시도${TRY.length > 1 ? ` (실패하면 그날 ${tryText(...TRY[TRY.length - 1])}에 한 번 더)` : ""}</small></div>` : "";
        }).join("") || `<div class="hint">켜진 규칙이 없습니다.</div>`;
        const books = r.log.filter((e) => e.kind === "book");
        main.innerHTML = `<div class="sl">규칙</div>${ruleRows(true)}${ruleActs}
          <div class="sl">다음 예약 시도${st.dirty ? " <small>(저장된 규칙 기준)</small>" : ""}</div>${plan}
          <div class="hint">따로 설정한 예약 작업이 매일 ${TRY.map((t) => tryText(...t)).join("·")}에 3일 뒤 날짜를 봅니다. 작업을 돌리는 프로그램이 켜져 있어야 하고, 그날 이미 예약이 있으면 건너뜁니다. 3시간을 넘으면 3시간 블록을 이어서 잡고, 블록마다 끝나기 5분 전 자동반납을 걸어 둡니다.</div>
          <div class="sl">예약 기록</div>${books.map(logRow).join("") || `<div class="hint">아직 예약 기록이 없습니다.</div>`}`;
        return;
      }
      const days = r.days.map((d) => `<button class="chipbtn${d.date === st.day ? " on" : ""}" data-day="${d.date}">${esc(d.label)}</button>`).join("");
      const sug = r.suggest.length ? r.suggest.map((s) => `<button class="chipbtn sug" data-sday="${s.date}" data-sstart="${s.start}" title="시간표 공강 ${esc(s.gap)}">${esc(dayLabel(s.date))} ${s.start}~${s.end}</button>`).join("")
        : `<span class="hint">예약 가능한 날에 3시간 공강이 없거나, 그날 이미 예약이 있습니다.</span>`;
      const alts = st.alts && st.alts.length ? `<div class="sl">${r.public ? st.hours : 3}시간 가능한 다른 시각 — 누르면 예약 확인</div><div class="chips">${st.alts.map((a) => `<button class="chipbtn" data-alt-room="${esc(a.room)}" data-alt-start="${hm(a.start)}"${dis}>${esc(a.room)} · ${hm(a.start)}~${hm(a.end)}</button>`).join("")}</div>` : "";
      const seen = r.updated_at ? `마지막 확인 ${stamp(r.updated_at)}${r.updated_by ? " · " + (BY[r.updated_by] || r.updated_by) : ""}` : "아직 확인 안 함 — 위 [예약 목록 확인]";
      main.innerHTML = `<div class="sl">날짜 (3일 뒤까지)</div><div class="chips">${days}</div>
        <div class="room-form">${r.public ? `<label>방<input id="rRoom" value="${esc(st.room)}" maxlength="4" placeholder="방 번호" style="width:76px"></label>` : ""}<label>시작<select id="rStart">${opt(r.starts, st.start)}</select></label><label>길이<select id="rHours">${hopt(st.hours)}</select></label><span class="room-end">~ ${plus3h(st.start, st.hours)}</span><label>용도<select id="rUse">${opt(r.uses, st.use)}</select></label><button class="primary" data-c="book"${dis}>${hText(st.hours)} 예약</button></div>
        <div class="room-mates room-me"><div class="sl">신청인 (나) <small>로그인할 계정의 이름과 학번 · 사이트에서 같은 사람인지 확인합니다</small></div><div class="mates" data-me="1">${mateRow(st.me[0], 0).replace(/<button class="ibtn m-del"[^]*?<\/button>/, "")}</div></div>
        <div class="room-mates"><div class="sl">함께 쓰는 사람 <small>나를 빼고 3명 이상 · 학번은 앞 4자리와 뒷자리를 나눠 적습니다 · ${prefs ? "설정에 저장한 사람이 미리 채워집니다. 여기서 바꾸면 이번 예약에만 씁니다" : "이번 예약에만 쓰고 저장하지 않습니다"}</small></div>${matesHtml(st.mates)}</div>
        <div class="sl">시간표 공강 추천 — 누르면 위에 채워짐</div><div class="chips">${sug}</div>${alts}
        <div class="sl">내 예약 <small>${esc(seen)}</small></div>${r.active.map((b) => row(b, dis)).join("") || `<div class="hint">다가오는 예약이 없습니다.</div>`}
        ${r.past.length ? `<div class="sl">지난 예약</div>${r.past.map((b) => row(b, dis)).join("")}` : ""}`;
      const log = r.log.map(logRow).join("") || `<div class="hint">기록이 없습니다.</div>`;
      side.innerHTML = `${r.public ? `<div class="sl">예약 규칙</div><div class="hint">자동·정기 예약과 3시간 초과 체인은 사용하지 않습니다. 방과 시각을 예약마다 확인합니다.</div><button class="ghost" data-c="rsave">반납 설정 저장</button>` : `<div class="sl">정기 예약</div><div class="hint">설정한 정기 예약 규칙입니다.</div>${ruleRows(false)}${ruleActs}`}
        <label class="room-auto"><input type="checkbox" id="rAuto"${st.auto ? " checked" : ""}>앱이 켜져 있으면 끝나기 ${r.auto_lead_min}분 전에 자동반납 (사용중일 때만)</label>
        <div class="sl">최근 기록</div>${log}
        <div class="src">${viaAside() ? "예약·반납은 Aside 브라우저가 합니다(AI 없이 정해진 순서대로, 로그인은 Aside 비밀번호 관리자가 채움)" : "예약·반납은 Claude가 사용자 Chrome(저장된 SNU 로그인)에서 합니다"}. 앱은 비밀번호를 다루지 않습니다.</div>`;
    };
    const start = async (call, booking = false) => {
      const r = await call;
      if (!r.ok) { toast(r.error || "시작하지 못했습니다"); return; }
      if (booking) st.mates = matesFrom(st.saved);  // typed for each booking (full build: back to the saved list)
      st.notice = null; st.lastJob = "running"; load();
    };
    scrim.addEventListener("input", (e) => { matesInput(e, e.target.closest("[data-me]") ? st.me : st.mates); });
    // 4 people in all: me + at least 3 companions, every row with a name and a full student number (user 2026-11-14)
    const peopleError = () => {
      const full = (m) => m[0].trim() && m[1].length === 4 && m[2].length >= 2;
      const me = st.me[0];
      if (!full(me)) return "신청인(나)의 이름과 학번을 적어 주세요";
      const typed = st.mates.filter((m) => m[0].trim() || m[1] || m[2]);
      if (typed.some((m) => !full(m))) return "함께 쓰는 사람 중 이름이나 학번이 빈 줄이 있습니다";
      const n = typed.filter((m) => `${m[1]}${m[2]}` !== `${me[1]}${me[2]}`).length;
      if (n < 3) return `그룹스터디룸은 4명부터 예약됩니다 — 나 말고 ${3 - n}명을 더 적어 주세요 (지금 ${n + 1}명)`;
      return "";
    };
    scrim.addEventListener("keydown", (e) => { if (e.target.id === "rChat" && e.key === "Enter" && !e.isComposing) { e.preventDefault(); sendChat(); } });
    scrim.addEventListener("change", (e) => {
      const t = e.target;
      if (t.id === "rRoom") { st.room = t.value.trim().toUpperCase(); return; }
      if (t.id === "rStart") { st.start = t.value; draw(); return; }
      if (t.id === "rHours") { st.hours = +t.value; draw(); return; }
      if (t.id === "rUse") { st.use = t.value; return; }
      if (t.id === "rAuto") { st.auto = t.checked; st.dirty = true; draw(); return; }
      if (t.dataset.ri !== undefined) { st.rules[+t.dataset.ri][t.dataset.rk] = t.type === "checkbox" ? t.checked : t.dataset.rk === "hours" ? +t.value : t.value; st.dirty = true; draw(); }
    });
    scrim.addEventListener("click", async (e) => {
      if (e.target === scrim) { close(); return; }
      if (matesClick(e.target, st.mates)) return draw();
      const t = e.target.closest("[data-c],[data-day],[data-sday],[data-alt-room],[data-ret],[data-cancel],[data-rdel],[data-chat-do],[data-chat-no]"); if (!t || t.disabled) return;
      const c = t.dataset.c;
      if (c === "close") return close();
      if (c === "rules" || c === "full") {
        if (st.dirty && !(await dialog({ title: "저장하지 않은 규칙", body: "바꾼 규칙을 저장하지 않고 옮길까요?", ok: "옮기기" }))) return;
        close(); return openRoom(c === "rules" ? "rules" : undefined);
      }
      if (c === "refresh") return start(api.room_refresh());
      if (c === "chat") return sendChat();
      if (c === "stop") {
        const r = await api.room_stop();
        if (!r.ok) toast(r.error || "중지하지 못했습니다");
        return load();
      }
      if (c === "book") {
        const bad = peopleError(); if (bad) { toast(bad); return; }
        return start(api.room_book(st.day, st.start, st.use, publicRooms ? st.room : null, st.hours, matesText(st.mates), matesText(st.me)), true);
      }
      if (c === "radd") { st.rules.push({ weekday: "월", start: "15:00", use: "과제", hours: 3, enabled: true }); st.dirty = true; return draw(); }
      if (c === "rsave") {
        const r = await api.room_rules(st.rules, st.auto);
        if (!r.ok) { toast(r.error || "저장하지 못했습니다"); return; }
        st.dirty = false; toast("저장했습니다"); return load();
      }
      if (t.dataset.day) { st.day = t.dataset.day; st.alts = null; return draw(); }
      if (t.dataset.sday) { st.day = t.dataset.sday; st.start = t.dataset.sstart; st.alts = null; return draw(); }
      if (t.dataset.altRoom) {
        const bad = peopleError(); if (bad) { toast(bad); return; }
        return start(api.room_book(st.day, t.dataset.altStart, st.use, t.dataset.altRoom, publicRooms ? st.hours : 3, matesText(st.mates), matesText(st.me)), true);
      }
      if (t.dataset.ret) {
        const ok = await dialog({ title: `${t.dataset.seat} 반납`, body: "지금 반납하면 이 예약이 끝납니다. 방에서 나왔을 때만 누르세요.", ok: "반납", tone: "danger" });
        if (ok) start(api.room_return(t.dataset.ret));
        return;
      }
      if (t.dataset.chatNo) {
        const m = st.chat[st.chat.length - 1];
        if (m) m.confirm = null;
        st.chat.push({ who: "bot", text: "그만뒀습니다." });
        return drawChat();
      }
      if (t.dataset.chatDo) {
        const m = st.chat[st.chat.length - 1];
        if (!m || !m.confirm) return;
        const go = m.confirm; m.confirm = null; drawChat();
        const r = await api.room_chat_confirm(go.intent, go.ids, go.booking || null, go.intent === "book" ? matesText(st.mates) : "");
        if (!r.ok) { if (go.intent === "book") m.confirm = go; st.chat.push({ who: "bot", text: r.error || "실행하지 못했습니다" }); return drawChat(); }
        if (go.intent === "book") { st.mates = matesFrom(st.saved); draw(); }
        st.chat.push({ who: "bot", text: go.intent === "book" ? "예약을 시작합니다." : go.intent === "cancel" ? "취소를 시작합니다. 1분쯤 걸립니다." : "반납을 시작합니다." }); drawChat();
        st.notice = null; st.lastJob = "running"; return load();
      }
      if (t.dataset.cancel) {
        const n = +t.dataset.n || 1;
        const ok = await dialog({ title: n > 1 ? `이어진 ${n}건 예약 취소` : `${t.dataset.seat} 예약 취소`,
          body: `${t.dataset.seat} ${t.dataset.when} 예약${n > 1 ? ` ${n}건을 모두` : "을"} 취소합니다. 취소하면 방이 다른 사람에게 열리고, 되돌리려면 새로 예약해야 하는데 그때는 빈 방이 없을 수 있습니다.`,
          ok: "예약 취소", tone: "danger" });
        if (ok) start(api.room_cancel(t.dataset.cancel.split(",")));
        return;
      }
      if (t.dataset.rdel !== undefined) { st.rules.splice(+t.dataset.rdel, 1); st.dirty = true; draw(); }
    });
    load();
  }

  function openSearch() {
    if (document.querySelector(".search-panel")) return;
    const scrim = document.createElement("div");
    scrim.className = "scrim top";
    scrim.innerHTML = `<div class="search-panel"><input id="q" placeholder="전사·자료 검색 — 결과를 누르면 그 회차의 그 시각으로 이동" autocomplete="off"><div class="results" id="qr"><div class="hint">두 글자 이상 입력하세요.</div></div></div>`;
    document.body.appendChild(scrim); keepFocus(scrim);
    const input = scrim.querySelector("#q"), box = scrim.querySelector("#qr");
    let results = [], on = 0, timer = null, seq = 0;
    const close = () => { scrim.remove(); document.removeEventListener("keydown", key, true); };
    const draw = () => {
      box.innerHTML = results.length ? results.map((r, i) => {
        const where = r.lecture_id ? `${esc(r.course)} ${esc(r.label || "")} · ${r.date ? mdText(r.date) : ""}` : esc(r.course);
        const at = r.start_ms !== null && r.start_ms !== undefined ? ` · ${clock(r.start_ms)}` : r.page ? ` · ${r.page}쪽` : "";
        const tag = r.kind === "material_title" ? "자료" : r.kind === "material" ? "자료 본문" : esc(r.engine || "전사");
        return `<div class="r${i === on ? " on" : ""}" data-i="${i}"><div class="h"><span>${where}${at}</span><span class="b">${tag}</span></div><div class="x">${snippet(r.text, input.value.trim())}</div></div>`;
      }).join("") : `<div class="hint">${input.value.trim().length < 2 ? "두 글자 이상 입력하세요." : "결과가 없습니다."}</div>`;
    };
    const pick = async (r) => {
      if (!r) return; close();
      if (r.kind === "material" && r.path) {  // S4-0: page text hit → that page in the user's PDF program (D-056)
        if (r.lecture_id) await openLecture(r.lecture_id, null, null);
        const o = await api.open_material(r.path, r.page || 1);
        if (!o.ok) toast(o.error); else if (o.note) toast(o.note);
        return;
      }
      if (r.lecture_id) {
        await openLecture(r.lecture_id, r.kind === "transcript" ? r.start_ms : null, r.kind === "transcript" ? input.value.trim() : null);
        if (r.kind !== "transcript") selectTab("c", "c-files");
      } else if (r.path) api.open_path(r.path);
    };
    const key = (e) => {
      if (!isTop(scrim)) return;
      if (e.key === "Escape") { e.preventDefault(); close(); }
      if (e.key === "ArrowDown") { e.preventDefault(); on = Math.min(on + 1, results.length - 1); draw(); }
      if (e.key === "ArrowUp") { e.preventDefault(); on = Math.max(on - 1, 0); draw(); }
      if (e.key === "Enter") { e.preventDefault(); pick(results[on]); }
    };
    document.addEventListener("keydown", key, true);
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = input.value.trim(), mine = ++seq;
        if (q.length < 2) { results = []; draw(); return; }
        const r = await api.search(q);
        if (mine !== seq) return;
        results = r.ok ? r.results : []; on = 0; draw();
        if (!r.ok) box.innerHTML = `<div class="hint">${esc(r.error)}</div>`;
      }, 220);
    });
    box.addEventListener("click", (e) => { const el = e.target.closest(".r"); if (el) pick(results[+el.dataset.i]); });
    scrim.addEventListener("click", (e) => { if (e.target === scrim) close(); });
    input.focus();
  }

  /* ---------- actions ---------- */
  /* The app may be opened long before class: keep the timetable's suggestion current until the user picks. */
  async function refreshCourse() {
    if (ui.courseSource === "user_pick") return;
    const st = ui.state || {};
    if (["starting", "recording", "stopping", "finalizing"].includes(st.phase)) return;
    try {
      const r = await api.suggest_course();
      if (r.course !== ui.course) {
        ui.course = r.course; ui.courseSource = r.course ? "timetable_auto" : "unknown";
        renderAll(); await syncSelection(); applySourceFor(ui.course);
        remindClass(ui.course);
      }
    } catch (err) { /* keep the current choice */ }
  }
  /* TT-001: when the timetable's class comes up, ask once (never records by itself). Off in settings; skipped for a
     course whose recording is forbidden. */
  async function remindClass(course) {
    if (!course || !ui.info.class_reminder || ui.courseSource !== "timetable_auto") return;
    const key = `${ui.info.today_iso}|${course}`;
    if ((remindClass.done || (remindClass.done = new Set())).has(key)) return;
    remindClass.done.add(key);
    const st = ui.state || {};
    if (["starting", "recording", "stopping", "finalizing"].includes(st.phase)) return;
    const permission = await api.recording_permission(course);
    if (!permission.ok || !permission.allowed) return;
    const slot = (ui.info.today || []).find((s) => s.folder === course);
    const ok = await dialog({ title: `${course} 수업 시간이에요`,
      body: `${slot ? `시간표상 ${slot.start}~${slot.end} 수업입니다.\n` : ""}녹음을 시작할까요? 시작하지 않으면 아무것도 녹음하지 않습니다.`,
      ok: "녹음 시작", cancel: "나중에" });
    if (ok && ui.course === course && !["starting", "recording", "stopping", "finalizing"].includes((ui.state || {}).phase)) await onRec();
  }
  // [마이크] and [PC 소리] are separate switches (user 2026-09-29): mic only, PC sound only, or both (two files).
  function sourceFor(course) {
    const remembered = ((ui.info.prefs || {}).source_by_course || {})[course];
    if (remembered) return { src: remembered, why: "지난번 이 과목" };
    if ((ui.info.extras || []).includes(course)) return { src: "pc", why: "수업 외 기본" };
    return null;
  }
  function applySourceFor(course, quiet) {
    const st = ui.state || {};
    if (["starting", "recording", "stopping", "finalizing"].includes(st.phase)) return;
    const s = sourceFor(course);
    if (!s) return;
    const mic = s.src !== "pc", pc = s.src !== "mic";
    if (mic === ui.mic && pc === ui.pc) return;
    ui.mic = mic; ui.pc = pc;
    renderMic(); syncSelection(); probe();
    if (!quiet) toast(`녹음할 소리를 ${s.src === "both" ? "마이크 + PC 소리" : s.src === "pc" ? "PC 소리" : "마이크"}로 맞췄습니다(${s.why})`);
  }
  function recMode() {
    if (ui.mic) return { mode: "mic", withPc: ui.pc };
    return { mode: ui.pc ? "loopback" : null, withPc: false };
  }
  async function syncSelection() {
    const m = recMode();
    await api.set_selection(ui.course, m.mode || "mic", ui.device, ui.courseSource, m.withPc);
  }
  function probe() { const m = recMode(); if (m.mode) api.probe(m.mode, ui.device); }

  async function onRec() {
    const st = ui.state || {};
    if (st.phase === "recording" && st.status && st.status.paused) {
      // paused: the big button is where the eye goes, so it must offer the way back. Before 2026-10-11 it only asked
      // "녹음을 끝낼까요?" with [계속 녹음] as its cancel — pressing that left the pause on, and the user read it as broken.
      const r = await dialog({ title: "일시정지 중입니다", body: `${fmt(st.status.elapsed_ms)}까지 녹음하고 멈춰 둔 상태입니다.\n멈춘 동안의 소리는 저장하지 않습니다.`, ok: "다시 녹음", cancel: "그대로 두기", extra: "녹음 끝내기" });
      if (r === true) { const x = await api.pause(false); toast(x.ok ? "다시 녹음합니다" : "다시 녹음하지 못했습니다 — 일시정지 버튼을 눌러 보세요"); }
      else if (r === "extra") await api.stop();
      return;
    }
    if (st.phase === "recording") {
      const ok = await dialog({ title: "녹음을 끝낼까요?", body: `${fmt(st.status && st.status.elapsed_ms)} 녹음했습니다.\n끝내면 파일을 저장하고 병합합니다.`, ok: "녹음 끝내기", cancel: "계속 녹음", tone: "danger" });
      if (ok) await api.stop();
      return;
    }
    if (["starting", "stopping", "finalizing"].includes(st.phase)) return;
    const m = recMode();
    if (!m.mode) { toast("마이크나 PC 소리 중 하나는 켜 주세요"); return; }
    await refreshCourse();
    if (!ui.course) {
      const picked = await askCourse();
      if (picked === null) return;  // closed the question: nothing starts
      if (picked) { ui.course = picked; ui.courseSource = "user_pick"; applySourceFor(picked, true); }
    }
    const permission = await api.recording_permission(ui.course);
    if (!permission.allowed) { toast(permission.reason || permission.error); return; }
    if (permission.warning && !(await dialog({ title: "녹음 허락 확인", body: permission.warning, ok: "확인하고 시작", cancel: "취소" }))) return;
    const m2 = recMode();
    ui.levels = []; ui.view = "live"; setHtmlSize("pane"); renderCenter(); renderTop(); renderSide();
    await syncSelection();
    cap.error = ""; cap.pendingAuto = true;  // live transcription starts once the recorder runs (followRecording)
    const r = await api.start(ui.course, m2.mode, ui.device, ui.courseSource, m2.withPc);
    if (!r.ok) { cap.pendingAuto = false; toast(r.reason || "시작하지 못했습니다"); return; }
    if (ui.course) {  // the backend remembers it too (ui_prefs.json); keep this window's copy in step
      const P = ui.info.prefs || (ui.info.prefs = {});
      (P.source_by_course || (P.source_by_course = {}))[ui.course] = m2.withPc ? "both" : m2.mode === "loopback" ? "pc" : "mic";
      if ((ui.info.extras || []).includes(ui.course)) P.last_extra = ui.course;
    }
  }
  /* "어느 과목 녹음인가요?" — the last 수업 외 item first (a series of online lectures), then today's classes */
  function askCourse() {
    return new Promise((resolve) => {
      const last = (ui.info.prefs || {}).last_extra, today = ui.info.today.map((s) => s.folder);
      const items = [];
      if (last) items.push({ value: last, text: last, note: "지난번 수업 외" });
      today.filter((f) => f !== last).forEach((f) => items.push({ value: f, text: f, note: "오늘 " + ui.info.today.find((s) => s.folder === f).start }));
      ui.info.courses.filter((c) => !today.includes(c.folder)).forEach((c) => items.push({ value: c.folder, text: c.folder }));
      (ui.info.extras || []).filter((x) => x !== last).forEach((x) => items.push({ value: x, text: x, note: "수업 외" }));
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      menu($("recBtn"), [{ label: "어느 과목 녹음인가요? (지금 시간표에 수업이 없습니다)", items },
        { items: [{ value: "\u0000none", text: "과목 없이 녹음", note: "끝난 뒤 과목을 고릅니다" }] }],
        (v) => finish(v === "\u0000none" ? "" : v));
      setTimeout(() => document.addEventListener("click", () => setTimeout(() => finish(null), 0), { once: true }), 0);
    });
  }

  async function runTranscription(master, course) {
    const info = await api.transcription_check(master || null, master ? course : null);
    let consent = !info.needs_consent, token = null;
    if (info.needs_consent && !info.once_only) {  // stored per course: native window + one-time token (security review)
      const q = await api.consent_confirm("gemini_transcribe", info.course);
      if (!q.ok) { toast(q.error); return; }
      if (!q.yes) return;
      consent = true; token = q.token;
    } else if (info.needs_consent) {
      consent = await dialog({ title: "Google로 녹음을 보낼까요?", body: `${info.notice}\n과목: ${info.course || "(미지정)"}\n\n${info.once_only ? "과목이 정해지지 않아 이번 녹음에만 적용합니다(저장하지 않음)." : "이 과목에서는 한 번만 묻습니다."}`, ok: "보내고 전사", cancel: "취소" });
      if (!consent) return;
    }
    const r = await api.transcription_start(consent, master || null, master ? course : null, token);
    toast(r.ok ? "Google 전사를 시작했습니다" : r.reason || "시작하지 못했습니다");
  }
  function onTranscribe() {
    const st = ui.state || {}, link = st.link || {};
    // A linked recording is sent under the lecture's course; otherwise under what was picked (blank = this time only).
    if (link.state === "linked" && link.master) return runTranscription(link.master, link.course || "");
    return runTranscription(null, null);
  }

  function confirmPendingMenu(anchor, pending, done) {
    const link = pending || (ui.state || {}).link || {};
    const hints = (link.candidates || []).map((c) => c.course);
    const folders = ui.info.courses.map((c) => c.folder);
    menu(anchor, [{ label: `어느 과목 녹음인가요? (${link.date || ""})`, items: folders.map((f) => ({ value: f, text: f, note: hints.includes(f) ? "시간표 후보" : f === link.course_hint ? "고른 과목" : "" })) },
      { label: "수업 외", items: (ui.info.extras || []).map((x) => ({ value: x, text: x })).concat([{ value: "\u0000new", text: "+ 새로 만들기" }]) },
      { items: [{ value: UNSORTED, text: UNSORTED, note: "나중에 옮길 수 있습니다" }] }],
      async (course) => {
        if (course === "\u0000new") {
          const name = await askText({ title: "수업 외 항목 만들기", body: "학교 수업이 아닌 녹음(외부 강의 등)을 모아 둘 이름입니다. 녹음본\\수업 외\\<이름>에 복사됩니다.", value: "" });
          if (!name) return;
          const a = await api.add_extra(name); if (!a.ok) { toast(a.error); return; }
          ui.info.extras = a.extras; course = name.trim().split(/\s+/).join(" ");
        }
        const r = await api.confirm_pending(link.ingest_id, course);
        if (!r.ok) { toast(r.reason || "연결하지 못했습니다"); return; }
        toast(`${course} 회차에 연결했습니다`);
        loadSidebar(); if (done) done(r);
      });
  }

  function bind() {
    document.querySelectorAll(".seg").forEach((seg) => seg.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      seg.querySelectorAll("button").forEach((x) => x.classList.remove("on")); b.classList.add("on");
      seg.closest(".pane").querySelectorAll(":scope > .tab").forEach((t) => t.classList.toggle("on", t.id === b.dataset.t));
    }));
    $("settingsBtn").onclick = () => openSettings();
    $("themeBtn").onclick = async () => {
      const r = document.documentElement, d = r.getAttribute("data-theme");
      const dark = d ? d === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
      const theme = dark ? "light" : "dark";
      const result = await api.appearance(theme);
      if (result.ok) applyAppearance(result); else toast(result.error);
    };
    $("sideBtn").onclick = () => { if (ui.view === "home") ui.sideInHome = !ui.sideInHome; else ui.sideHidden = !ui.sideHidden; renderTop(); };
    $("homeBtn").onclick = goHome;
    $("searchBtn").onclick = openSearch;
    $("inboxBtn").onclick = openInbox;
    $("sessionsBtn").onclick = openSessions;
    $("examBtn").onclick = () => openNotes();
    $("importBtn").onclick = () => openImport();
    bindDrop();
    $("homePrev").onclick = () => { const d = new Date(ui.home.year, ui.home.month - 2, 1); ui.home = { year: d.getFullYear(), month: d.getMonth() + 1 }; renderHome(); };
    $("homeNext").onclick = () => { const d = new Date(ui.home.year, ui.home.month, 1); ui.home = { year: d.getFullYear(), month: d.getMonth() + 1 }; renderHome(); };
    $("homeAdd").onclick = () => openCalendar(ui.home.year, ui.home.month, { day: ui.info.today_iso });
    $("homeGrid").addEventListener("click", (e) => {
      const ev = e.target.closest("[data-ev]"), day = e.target.closest("[data-day]");
      if (ev) openCalendar(ui.home.year, ui.home.month, { id: ev.dataset.ev });
      else if (day) openCalendar(ui.home.year, ui.home.month, { day: day.dataset.day });
    });
    $("todo").addEventListener("click", async (e) => {
      const t = e.target.closest("[data-hw],[data-hwopen],[data-lecture],[data-course],[data-ev],[data-inbox],[data-cands]"); if (!t) return;
      if (t.dataset.hw) return prepareAssignment(t.dataset.hw);
      if (t.dataset.hwopen) { const x = await api.assignment_open(t.dataset.hwopen); if (!x.ok) toast(x.error); return; }
      if (t.dataset.lecture) return openLecture(t.dataset.lecture);
      if (t.dataset.course) return openToday(t.dataset.course);
      if (t.dataset.inbox) return openInbox();
      if (t.dataset.cands) return openCalendar();
      if (t.dataset.ev) { const [y, m] = t.dataset.date.split("-").map(Number); openCalendar(y, m, { id: t.dataset.ev }); }
    });
    $("miniBtn").onclick = async () => { await syncSelection(); api.show_mini(); };
    $("recBtn").onclick = onRec;
    $("engines").onclick = openEnginePop;
    $("lvEngines").addEventListener("click", (e) => { const b = e.target.closest("button[data-eng]"); if (b && !b.disabled) startEngine(b); });
    $("lvEngines").addEventListener("change", (e) => {
      const s = e.target.closest("select.lang");
      if (s) { engLang[s.dataset.master] = s.value; $("lvEngines").dataset.h = ""; renderLectureEngines(); }
    });
    $("rec2Btn").onclick = async () => {
      const pc = (ui.state || {}).pc || {}, name = pc.mode === "mic" ? "마이크" : "PC 소리";
      if (pc.state === "recording") {
        if (!(await dialog({ title: `따로 녹음한 ${name}만 멈출까요?`, body: "다른 녹음은 계속됩니다. 멈춘 것은 따로 저장하고 전사합니다.", ok: "멈추고 저장" }))) return;
        const r = await api.stop_companion(); if (!r.ok) toast("멈추지 못했습니다");
        return;
      }
      if (["starting", "stopping", "finalizing"].includes(pc.state)) return;
      const r = await api.start_companion();
      if (!r.ok) toast(r.reason || "시작하지 못했습니다");
    };
    $("htmlSel").onchange = () => showHtml(ui.htmlPages[+$("htmlSel").value]);
    $("noteRemake").onclick = async () => {
      if (!ui.lecture) return;
      const ok = await dialog({ title: "정리본을 다시 만들까요?", body: "전사를 다시 읽어 정리본을 새로 씁니다. 앱이 만든 정리본은 새 내용으로 바뀌고, 직접 고친 정리본 파일은 그대로 두고 새 파일로 만듭니다.", ok: "다시 만들기" });
      if (!ok) return;
      setHtmlSize("pane"); $("noteRemake").disabled = true;
      if (!(await makeNote(ui.lecture.id))) $("noteRemake").disabled = false;
    };
    $("liveHead").addEventListener("change", (e) => { if (e.target.matches('[data-live="auto"]')) { store.set(LIVE_KEY, e.target.checked); renderLive(); } });
    document.querySelectorAll("[data-size]").forEach((b) => b.addEventListener("click", () => setHtmlSize(b.dataset.size)));
    document.addEventListener("keydown", htmlKeys);
    $("htmlFrame").addEventListener("load", noteFrameLoaded);
    $("htmlOpen").onclick = async () => { const n = ui.htmlPages && ui.htmlPages[+$("htmlSel").value || 0]; if (n) { const r = await api.open_path(n.path); if (!r.ok) toast(r.error); } };
    $("roomBtn").onclick = () => openRoom();
    $("memBtn").onclick = () => { if (window.LHGerman) window.LHGerman.openFromRail($("memBtn"), toast, openExam); };  // 암기장 바로 열기(german.js)
    $("examChip").onclick = () => openExam();
    $("capBtn").onclick = () => onCaptions();
    $("sideViewBtn").onclick = () => sideView(true);
    $("svBack").onclick = () => sideView(false);
    $("svRec").onclick = () => $("recBtn").click();
    $("svLiveBtn").onclick = async () => { if ((cap.status || {}).running) { cap.auto = false; await api.captions_stop(); } else await startLive(false); pollCaptions(); };
    $("svCourse").onchange = (e) => { sv.course = e.target.value; sv.lec = ""; svFill(); };
    $("svLec").onchange = (e) => { sv.lec = e.target.value; svLoad(); };
    pollCaptions();
    $("qaBtn").onclick = () => onQa();
    pollQa();
    window.addEventListener("keydown", (e) => {
      if (e.key === "F8" && qa.shown) { e.preventDefault(); qaAsk(); }
      if (e.key === "F7" && qa.shown) { e.preventDefault(); qaMark(); }  // the question starts now (P-051)
    });
    window.addEventListener("keydown", (e) => {  // slides in the Q&A panel: arrows and a presenter clicker (PageUp/Down)
      if (!qa.shown || !qa.deck || /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || "")) return;
      if (document.querySelector(".scrim")) return;
      const step = { ArrowRight: 1, PageDown: 1, ArrowLeft: -1, PageUp: -1 }[e.key];
      if (step) { e.preventDefault(); qaSlide(qa.page + step); }
    });
    $("discardBtn").onclick = async () => {
      const st = ui.state || {};
      if (st.phase !== "recording") return;
      const ok = await dialog({ title: "이 녹음을 버릴까요?", body: `지금까지 ${fmt(st.status && st.status.elapsed_ms)} 녹음한 것을 멈추고 휴지통으로 보냅니다.\n회차 연결·전사·녹음본 복사는 하지 않습니다(휴지통에서 되살릴 수 있음).`, ok: "버리기", cancel: "계속 녹음", tone: "danger" });
      if (ok) { const r = await api.discard_recording(); if (!r.ok) toast("버리지 못했습니다"); }
    };
    $("pauseBtn").onclick = async () => {
      const st = ui.state || {};
      if (st.phase !== "recording") return;
      const paused = !(st.status && st.status.paused);
      const r = await api.pause(paused);
      toast(!r.ok ? (paused ? "일시정지하지 못했습니다" : "다시 녹음하지 못했습니다") : paused ? "일시정지 — 이 버튼이나 녹음 버튼을 누르면 이어서 녹음합니다(멈춘 동안은 저장 안 함)" : "다시 녹음합니다");
    };
    $("overCard").addEventListener("click", async (e) => {
      const b = e.target.closest("[data-over]");
      if (b && b.dataset.over === "resume") { await api.pause(false); await api.class_over_answer("snooze"); return; }
      if (b) { const r = await api.class_over_answer(b.dataset.over); if (b.dataset.over === "stop" && !r.ok) toast("멈추지 못했습니다"); }
    });
    $("nextCard").addEventListener("click", async (e) => {
      const b = e.target.closest("[data-next]"); if (!b) return;
      const r = await api.next_class_answer(b.dataset.next);
      if (b.dataset.next === "switch") toast(r.ok ? `저장하고 ${r.course} 녹음을 준비합니다…` : "바꾸지 못했습니다");
    });
    $("overMore").onclick = (e) => {
      e.stopPropagation();
      menu($("overMore"), [{ items: [{ value: "snooze", text: "계속 녹음 — 10분 뒤 다시 묻기" }, { value: "mute", text: "계속 녹음 — 이번 수업은 묻지 않기" }] }],
        (v) => api.class_over_answer(v));
    };
    $("starBtn").onclick = async () => { const r = await api.bookmark(); if (r.ok) toast("★ 중요 표시 · " + fmt(r.at_ms)); };
    $("courseBtn").onclick = (e) => {
      e.stopPropagation();
      const today = new Set(ui.info.today.map((s) => s.folder));
      menu($("courseBtn"), [
        { label: "과목", items: ui.info.courses.map((c) => ({ value: c.folder, text: c.folder, note: today.has(c.folder) ? "오늘 " + ui.info.today.find((s) => s.folder === c.folder).start : c.name !== c.folder ? c.name : "", sel: c.folder === ui.course })) },
        { label: "수업 외", items: (ui.info.extras || []).map((x) => ({ value: x, text: x, sel: x === ui.course })).concat([{ value: "\u0000new", text: "+ 새로 만들기", note: "예: AI 외부 강의" }]) },
        { items: [{ value: "", text: "과목 없음", sel: !ui.course }] },
      ], async (v) => {
        if (v === "\u0000new") {
          const name = await askText({ title: "수업 외 항목 만들기", body: "학교 수업이 아닌 녹음(외부 강의 등)을 모아 둘 이름입니다. 녹음본\\수업 외\\<이름>에 복사됩니다.", value: "" });
          if (!name) return;
          const r = await api.add_extra(name); if (!r.ok) { toast(r.error); return; }
          ui.info.extras = r.extras; v = name.trim().split(/\s+/).join(" ");
        }
        ui.course = v; ui.courseSource = v ? "user_pick" : "unknown"; renderAll(); syncSelection(); applySourceFor(v);
      });
    };
    $("srcBtn").onclick = (e) => {  // what to record + which microphone, in one menu
      e.stopPropagation();
      const mics = ui.info.devices.mic || [], mode = ui.mic && ui.pc ? "both" : ui.pc ? "pc" : "mic";
      menu($("srcBtn"), [
        { label: "무엇을 녹음할까요", items: [
          { value: "m:mic", text: "마이크", note: "강의실", sel: mode === "mic" },
          { value: "m:pc", text: "PC 소리", note: "온라인·영상 강의", sel: mode === "pc" },
          { value: "m:both", text: "마이크 + PC 소리", note: "두 파일로 따로 저장", sel: mode === "both" }] },
        mics.length ? { label: "마이크 장치 (이름으로 기억)", items: mics.map((d) => ({ value: "d:" + d.name, text: d.name, note: d.default ? "기본" : "", sel: d.name === ui.device })) }
          : { label: "마이크 장치", items: [{ value: "x", text: ui.info.devices.error || "마이크를 찾지 못했습니다" }] },
      ], (v) => {
        if (v.startsWith("m:")) { const m = v.slice(2); ui.mic = m !== "pc"; ui.pc = m !== "mic"; } else if (v.startsWith("d:")) ui.device = v.slice(2); else return;
        renderMic(); syncSelection(); probe();
      });
    };
    $("health").addEventListener("click", (e) => {
      const a = e.target.closest("[data-act]"); if (!a) return;
      if (a.dataset.act === "probe") probe();
      if (a.dataset.act === "folder") api.open_folder(ui.state.summary.session_dir);
      if (a.dataset.act === "transcribe") onTranscribe();
      if (a.dataset.act === "open-linked") openLecture(ui.state.link.lecture_id);
      if (a.dataset.act === "short-discard") api.short_answer("discard");
      if (a.dataset.act === "short-keep") api.short_answer("keep");
      if (a.dataset.act === "sessions") openSessions();
      if (a.dataset.act === "confirm-pending") { e.stopPropagation(); confirmPendingMenu(a); }
      if (a.dataset.act === "resume") api.pause(false).then((x) => toast(x.ok ? "다시 녹음합니다" : "다시 녹음하지 못했습니다"));
    });
    $("lecDiscard").onclick = () => ui.lecture && discardLecture(ui.lecture.id);
    $("htmlDiscard").onclick = () => ui.lecture && discardLecture(ui.lecture.id);
    document.querySelector(".side").addEventListener("contextmenu", (e) => {  // right-click a lecture → 버리기
      const it = e.target.closest("[data-lecture]"); if (!it) return;
      e.preventDefault();
      menu(it, [{ items: [{ value: "open", text: "열기" }, { value: "discard", text: "이 회차 버리기", note: "휴지통으로 · 되살릴 수 있음" }] }],
        (v) => { if (v === "open") openLecture(it.dataset.lecture); if (v === "discard") discardLecture(it.dataset.lecture); });
    });
    document.querySelector(".side").addEventListener("click", (e) => {
      const tg = e.target.closest("[data-toggle]");
      if (tg) { const f = tg.dataset.toggle, open = ui.open || (ui.open = new Set()); if (open.has(f)) open.delete(f); else open.add(f); renderSide(); return; }
      const lecture = e.target.closest("[data-lecture]");
      if (lecture) { openLecture(lecture.dataset.lecture); return; }
      const files = e.target.closest("[data-files]");
      if (files) { openFiles(files.dataset.files); return; }
      const it = e.target.closest("[data-course]"); if (it) openToday(it.dataset.course);
    });
    function openToday(folder) {
      // A class of today that has not been recorded yet: the recorder ready, live transcription in the middle.
      // The recording course follows only when nothing is recording (review S2-3: never switch mid-recording).
      const st = ui.state || {};
      if (!["starting", "recording", "stopping", "finalizing"].includes(st.phase)) {
        ui.course = folder; ui.courseSource = "user_pick"; syncSelection();
      }
      ui.view = "live"; setHtmlSize("pane");
      renderCenter(); renderAll();
    }
    document.addEventListener("keydown", (e) => { if (e.ctrlKey && (e.key === "k" || e.key === "K")) { e.preventDefault(); openSearch(); } });
    $("lnext").onclick = () => {
      const st = ui.lecture && ui.lecture.state; if (!st) return;
      if (st.action === "open_transcript") { selectTab("r", "r-tr"); $("lvList").scrollTop = 0; }
      if (st.action === "transcribe") transcribeLecture();
      if (st.action === "mai_prepare" && ed("mai")) {
        const rec = ui.lecture.recordings.find((r) => r.exists);
        if (!rec) { toast("연결된 녹음 파일을 찾지 못했습니다"); return; }
        ui.maiShown = "running"; api.mai_prepare(rec.path); toast("MAI용 조각을 만드는 중…");
      }
    };
    $("lvHead").addEventListener("click", (e) => { const bm = e.target.closest(".bm[data-seek]"); if (bm) { jumpTo(+bm.dataset.seek, true); return; } if (e.target.id === "switchUse") chooseTranscript(e); if (e.target.id === "cmpTr") compareTranscripts(); if (e.target.id === "saveTr") { e.stopPropagation(); saveTranscript(e.target); } const r = e.target.closest("[data-range]"); if (r) rangeAction(r); });
    $("lvList").addEventListener("click", (e) => {
      const t = e.target.closest("[data-seek]"); if (t) { jumpTo(+t.dataset.seek, true); return; }
      if (e.target.closest("[data-act='transcribe-lecture']")) transcribeLecture();
      const rg = e.target.closest("[data-range]"); if (rg) rangeAction(rg);
      if (e.target.closest("[data-act='unmask']")) { document.body.classList.remove("masked"); renderLecture(); }
    });
    $("lvList").addEventListener("mouseup", () => {
      const sel = window.getSelection(), fix = $("fixBtn");
      const inTx = sel && !sel.isCollapsed && sel.anchorNode && sel.anchorNode.parentElement && sel.anchorNode.parentElement.closest("#lvList .tx");
      if (!inTx) { fix.hidden = true; return; }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      fix.style.left = `${rect.left + rect.width / 2}px`; fix.style.top = `${rect.top - 34}px`; fix.hidden = false;
    });
    $("fixBtn").addEventListener("mousedown", (e) => e.preventDefault());
    $("fixBtn").addEventListener("click", () => { $("fixBtn").hidden = true; correctSelection(); });
    document.querySelector(".center").addEventListener("click", async (e) => {
      const lv = e.target.closest("[data-live]"); if (lv && lv.tagName === "BUTTON" && !lv.disabled) { liveAction(lv); return; }
      if (e.target.closest("[data-act='transcribe-lecture']")) { transcribeLecture(); return; }
      const na = e.target.closest("[data-note]"); if (na && !na.disabled) { noteAction(na); return; }
      const jn = e.target.closest("[data-join]"); if (jn) { e.stopPropagation(); joinRecording(jn); return; }
      const mv = e.target.closest("[data-move]"); if (mv) { e.stopPropagation(); moveRecording(mv); return; }
      const tm = e.target.closest("[data-trim]"); if (tm) { e.stopPropagation(); trimRecording(tm.dataset.trim); return; }
      const dc = e.target.closest("[data-discard]"); if (dc) { e.stopPropagation(); if (await discardRecording(dc.dataset.discard)) openLecture(ui.lecture.id); return; }
      const it = e.target.closest("[data-open]"); if (!it) return;
      const r = await api.open_path(it.dataset.open); if (!r.ok) toast(r.error);
    });
    const audio = $("audio");
    $("playBtn").onclick = () => { if (!audio.dataset.src) return; if (audio.paused) audio.play(); else audio.pause(); };
    audio.addEventListener("timeupdate", () => {
      $("playTime").textContent = clock(audio.currentTime * 1000);
      if (audio.duration) $("playSeek").value = Math.floor(audio.currentTime / audio.duration * 1000);
      if (!audio.paused && ui.lecture) markPlaying(rowAt(audio.currentTime * 1000), false);
    });
    audio.addEventListener("loadedmetadata", () => { if (audio.duration && isFinite(audio.duration)) $("playDur").textContent = clock(audio.duration * 1000); });
    audio.addEventListener("error", () => { if (audio.dataset.src) $("playTime").textContent = "원음을 재생할 수 없음"; });
    $("playSeek").addEventListener("input", () => { if (audio.duration) audio.currentTime = $("playSeek").value / 1000 * audio.duration; });
    let memoTimer = null;
    $("memo").addEventListener("input", () => {
      $("memoSaved").textContent = ""; clearTimeout(memoTimer);
      memoTimer = setTimeout(async () => { const r = await api.save_memo(ui.course, $("memo").value); $("memoSaved").textContent = r.ok ? "자동 저장됨" : "저장 실패"; }, 800);
    });
    document.addEventListener("keydown", (e) => { if (e.ctrlKey && (e.key === "b" || e.key === "B") && (ui.state || {}).phase === "recording") $("starBtn").click(); });
  }

  function renderMic() {
    const name = ui.mic && ui.pc ? "마이크 + PC 소리" : ui.mic ? "마이크" : ui.pc ? "PC 소리" : "입력 없음";
    $("srcName").textContent = name; $("srcIcon").setAttribute("href", ui.mic || !ui.pc ? "#i-mic" : "#i-speaker");
    $("srcBtn").title = `녹음할 소리: ${name}${ui.mic ? " · " + (ui.device || "기본 마이크") : ""} — 누르면 바꿉니다`;
    $("recBtn").title = ui.mic && ui.pc ? "마이크와 PC 소리를 따로 두 파일로 녹음" : ui.mic ? "마이크 녹음" : ui.pc ? "PC 소리만 녹음" : "마이크나 PC 소리를 켜 주세요";
  }
  function renderAll() { renderTop(); renderSide(); renderMic(); sett($("courseName"), ui.course || "과목 없음"); renderDock(); renderTranscript(); }

  /* State poll: every 250 ms while recording (timer, levels) and for 5 s after the user clicks or types; once a second
     (1.5 s) otherwise, 2 s after 30 s without input, every 5 s while the window is hidden (was 250 ms always: ~240 calls a minute on an idle window).
     Backs off when the backend does not answer instead of retrying four times a second. */
  const POLL_ACTIVE = ["starting", "recording", "stopping", "finalizing"];
  let pollTimer = 0, pollFails = 0, polling = false;
  function schedulePoll() {
    const active = POLL_ACTIVE.includes(ui.state && ui.state.phase) || Date.now() < (ui.fastUntil || 0);
    const still = Date.now() - (ui.lastInput || 0) > 30000;  // nobody touched the window for 30 s
    const wait = pollFails ? Math.min(500 * 2 ** pollFails, 10000) : active ? 250 : document.hidden ? 5000 : still ? 2000 : 1000;
    clearTimeout(pollTimer); pollTimer = setTimeout(poll, wait);
  }
  function pollSoon() {
    ui.lastInput = Date.now(); ui.fastUntil = ui.lastInput + 1500;
    if (!polling && !pollFails) { clearTimeout(pollTimer); pollTimer = setTimeout(poll, 250); }
  }
  async function poll() {
    polling = true;
    try {
      try { ui.state = await api.state(); } catch (err) {
        pollFails += 1;
        if (pollFails === 4) toast("앱 내부 연결이 잠시 끊겼습니다 · 다시 연결하는 중…");
        return;
      }
      pollFails = 0;
      const sd = ui.state.status && ui.state.status.session_dir;
      if (ui.state.phase === "recording" && sd && ui.awakeShown !== sd && ui.state.keep_awake !== undefined && ui.state.keep_awake !== null) {
        ui.awakeShown = sd;  // K6: once per recording
        toast(ui.state.keep_awake ? "녹음하는 동안 PC가 잠자기로 들어가지 않습니다 · 노트북 덮개를 닫으면 멈출 수 있어요"
          : "잠자기 방지를 켜지 못했습니다 · 전원 설정에서 잠자기를 늦춰 주세요");
      }
      if (ui.state.attached && !ui.attachedShown) { ui.attachedShown = true; toast("진행 중인 녹음에 다시 연결했습니다"); }
      // 다시 연 앱: 녹음기가 첫 상태(과목)를 쓰는 데 1초쯤 걸린다 — 과목이 보일 때까지 매번 맞춘다
      if (ui.state.attached && ui.state.status && ui.state.status.course && ui.course !== ui.state.status.course && ["starting", "recording", "stopping"].includes(ui.state.phase)) {
        ui.course = ui.state.status.course; ui.courseSource = "user_pick"; renderTop();
      }
      if (ui.state.library_version !== ui.libraryVersion) {
        const first = ui.libraryVersion === undefined;
        ui.libraryVersion = ui.state.library_version;
        if (!first) {
          await loadSidebar();
          if (ui.view === "lecture" && ui.lecture) openLecture(ui.lecture.id);
        }
      }
      if (ui.state.phase !== ui.lastPhase) {
        const was = ui.lastPhase; ui.lastPhase = ui.state.phase;
        // a recording started here or from the mini window: live transcription follows (not a re-attached one)
        if (was && !POLL_ACTIVE.includes(was) && ["starting", "recording"].includes(ui.state.phase) && !ui.state.attached) cap.pendingAuto = true;
        if (was && ["recording", "stopping", "finalizing"].includes(was) && ["done", "idle", "error"].includes(ui.state.phase)
            && ui.courseSource === "user_pick") {
          const r = await api.suggest_course();  // e.g. "AI 외부 강의" picked last night must not label today's class
          if (r.course && r.course !== ui.course) {
            ui.course = r.course; ui.courseSource = "timetable_auto"; syncSelection(); applySourceFor(r.course, true);
            toast(`다음 녹음 과목을 지금 수업(${r.course})으로 바꿨습니다`);
          }
        }
      }
      const link = ui.state.link || {};
      if (link.state === "linked" && link.media_id && ui.openedLink !== link.media_id && ui.state.phase === "done") {
        ui.openedLink = link.media_id;  // S2: show the lecture this recording now belongs to (once per recording)
        openLecture(link.lecture_id);
      }
      renderTop();
      if (ui.state.mai && ui.state.mai.state !== ui.maiShown) { ui.maiShown = ui.state.mai.state; showMai(ui.state.mai); }
      renderSide(); renderDock(); renderTranscript(); renderLive();
      sett($("courseName"), ui.course || "과목 없음");
      followRecording(ui.state);
    } catch (err) { /* keep polling */ } finally { polling = false; schedulePoll(); }
  }

  /* ---------- settings: account connections, outside programs, what each feature needs (release prep 2026-11) ---------- */
  const FEATURE_BADGE = { ready: ["on", "사용 가능"], fallback: ["mid", "대체 방법으로"], missing: ["off", "연결 필요"] };

  /* optional features: hidden until switched on in settings; greyed (with the reason) while the program they need is missing */
  const ed = (k) => !(ui.info && ui.info.edition && ui.info.edition[k] === false);  // public edition: no assignment / mai / qa

  function applyLabs() {
    // the public edition has no 질의응답 and no 자막 buttons (user 2026-11-14); the owner's app keeps both
    [["qaBtn", "qa"], ["capBtn", "captions"]].forEach(([id, k]) => { const el = $(id); if (el && !ed(k)) { el.hidden = true; el.style.display = "none"; } });
    const labs = (ui.info && ui.info.labs) || {}, feats = (ui.info && ui.info.features) || {};
    const rules = [["roomBtn", "gsr", "gsr"], ["memBtn", "memorizer", null]];
    rules.forEach(([id, lab, feat]) => {
      const el = $(id); if (!el) return;
      el.hidden = !labs[lab] || !ed(lab);
      const f = feat && feats[feat];
      el.classList.toggle("needs", !!(f && f.state === "missing"));
      if (f && f.state === "missing") el.title = f.hint;
    });
  }

  function applyAppearance(a) {
    const root = document.documentElement;
    if (a.theme === "system") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", a.theme);
    root.style.setProperty("--reading-size", ({ normal: "14px", large: "16px", larger: "18px" })[a.text_size] || "14px");
  }

  /* folder layout (2026-11-13): 기본 · 자세히 · 이미 쓰는 폴더, with the tree each one makes (folder_layout_get) */
  const LAYOUT_ORDER = ["basic", "detailed", "existing"];
  const LAYOUT_HELP = {
    basic: "과목 폴더 안에 강의자료·과제·정리본만 둡니다. 처음 쓰면 이것이 편합니다.",
    detailed: "실습자료·참고자료·교재까지 나누고, 녹음·전사 보관용 폴더도 둡니다.",
    existing: "이미 정리해 둔 학기 폴더를 그대로 읽습니다. 파일을 옮기지 않습니다.",
  };
  function layoutSection(L, mode, pick) {
    if (!L || !L.ok) return `<h5>폴더 구성</h5><p class="err">${esc((L && L.error) || "폴더 구성을 읽지 못했습니다")}</p>`;
    const style = pick || L.style;
    const opts = LAYOUT_ORDER.filter((k) => L.choices[k]).map((k) => `<label class="layout-opt${k === style ? " on" : ""}">` +
      `<input type="radio" name="layout-${mode}" value="${k}" data-layout${k === style ? " checked" : ""}><span><b>${esc(L.choices[k])}</b><small>${esc(LAYOUT_HELP[k] || "")}</small></span></label>`).join("");
    const tree = (L.previews[style] || []).join("\n");
    return `<h5>폴더 구성</h5><p>과목 폴더 안을 어떻게 나눌지 고릅니다.${mode === "set" ? " 바꿔도 이미 있는 파일은 옮기지 않고, 새로 생기는 파일부터 따릅니다." : " 나중에 설정에서 바꿀 수 있습니다."}</p>` +
      `<div class="layout-row"><div class="layout-opts" role="radiogroup" aria-label="폴더 구성">${opts}</div><pre class="layout-tree" aria-label="폴더 미리 보기">${esc(tree)}</pre></div>` +
      (mode === "set" ? `<label class="dlg-check"><input type="checkbox" data-archive${L.archive_copies ? " checked" : ""}> 녹음 보관용 복사본도 과목별로 두기 (녹음본\\과목\\)</label>` : "");
  }
  function cleanupRow(c) {
    if (!c || !c.ok) return `<p class="err">${esc((c && c.error) || "녹음 정리 설정을 읽지 못했습니다")}</p>`;
    return `<div class="cleanup-row"><label class="dlg-check"><input type="checkbox" data-cleanup${c.enabled ? " checked" : ""}> Google 전사가 끝나고</label>` +
      `<input type="number" class="ask short" data-cleanup-days min="1" max="365" value="${esc(c.days)}" aria-label="며칠 뒤"${c.enabled ? "" : " disabled"}>` +
      `<span>일 지난 녹음은 휴지통으로 (정리본이 있는 회차만)</span></div>` +
      `<small>영구 삭제가 아니라 휴지통으로 옮깁니다. 휴지통 비우기는 직접 합니다. 앱을 켤 때 한 번 확인합니다.</small>`;
  }

  async function openSettings() {
    const scrim = document.createElement("div");
    scrim.className = "scrim setup";
    document.body.appendChild(scrim); keepFocus(scrim, () => { scrim.remove(); loadEngines(); });
    let busy = "";
    const note = {};  // per connection: the last result line, kept across redraws ({text, tone})
    async function load(login = false) {
      const s = await api.conn_status(login);
      s.permissions = await api.recording_permissions();
      s.appearance = await api.appearance();
      s.ai = await api.ai_status(login);
      s.layout = await api.folder_layout_get();
      s.cleanup = await api.audio_cleanup_get();
      s.live = await api.live_engine_get();
      const gsrPrefs = s.labs.gsr && (ui.info.edition || {}).name !== "public";
      if (gsrPrefs && !gsr) {  // the owner's 그스룸 list and room order (full build only), loaded once and kept while typing
        const [c, r] = [await api.gsr_companions_get(), await api.gsr_rooms_get()];
        if (c.ok && r.ok) gsr = { rows: matesFrom(c.rows), rooms: { ...r.rooms, avoid: r.rooms.avoid.join(" "), center: r.rooms.center == null ? "" : String(r.rooms.center), floor_first: r.rooms.floor_first ? String(r.rooms.floor_first) : "" }, msg: "", rmsg: "" };
      }
      s.gsr = gsrPrefs ? gsr : null;
      ui.ai = s.ai;
      if (ui.info && Array.isArray(s.features)) { ui.info.features = Object.fromEntries(s.features.map((f) => [f.id, f])); renderLive(); }
      last = s;
      draw(s);
    }
    let gsr = null;  // 그스룸 saved companions + room order being edited (full build)
    let last = null;  // the whole screen state: a "checking…" redraw reuses it (conn_status alone lacks the AI/layout parts)
    function draw(s) {
      const old = scrim.querySelector(".dialog"), keep = old ? [old.scrollTop, scrim.scrollTop] : null;  // a redraw keeps the place
      const features = s.features.map((f) => { const [cls, txt] = FEATURE_BADGE[f.state]; return `<tr><td>${esc(f.label)}</td><td><span class="pill ${cls}">${txt}</span></td><td>${esc(f.hint)}</td></tr>`; }).join("");
      const keys = s.keys.map((k) => `<div class="conn" data-id="${esc(k.id)}">
        <div class="ct"><b>${esc(k.label)}</b> <span class="pill ${k.connected ? "on" : "off"}">${k.connected ? "연결됨" + (k.source === "env" ? " (환경 변수)" : "") : "연결 안 됨"}</span></div>
        <div class="cn">${esc(k.steps)} ${esc(k.note)}</div>
        <div class="ca"><button data-a="connect" ${busy ? "disabled" : ""}>${k.connected ? "키 바꾸기" : "연결"}</button>
          ${k.connected ? `<button data-a="test" ${busy ? "disabled" : ""}>테스트</button><button class="ghost" data-a="remove">연결 끊기</button>` : ""}
          <button class="ghost" data-a="help">키 받는 곳 ↗</button><span class="cmsg${note[k.id] ? " " + note[k.id].tone : ""}" id="cm-${esc(k.id)}">${busy === k.id ? "서비스에 확인하는 중… (몇 초)" : note[k.id] ? esc(note[k.id].text) : ""}</span></div></div>`).join("");
      const tools = s.tools.map((t) => `<tr><td>${esc(t.label)}</td><td>${t.found ? "✔ 있음" : t.required ? "✖ 필요" : "– 없음(선택)"}${t.signed_in === true ? " · 로그인됨" : t.signed_in === false ? " · 로그인 필요" : ""}</td>
        <td>${esc(t.needed_for)}${t.found ? "" : `<br><small>${esc(t.hint)}</small>`}</td><td>${t.help_url && !t.found ? `<button class="ghost" data-a="thelp" data-id="${esc(t.id)}">설치 안내 ↗</button>` : ""}</td></tr>`).join("");
      scrim.innerHTML = `<div class="dialog wide" role="dialog"><h4>설정 · 연결</h4>
        <h5>화면</h5><div class="appearance-row"><label>테마 <select data-appearance="theme">${[["system", "시스템"], ["light", "밝게"], ["dark", "어둡게"]].map(([k,v]) => `<option value="${k}"${s.appearance?.theme === k ? " selected" : ""}>${v}</option>`).join("")}</select></label>
        <label>본문 글자 크기 <select data-appearance="text_size">${[["normal", "보통"], ["large", "크게"], ["larger", "더 크게"]].map(([k,v]) => `<option value="${k}"${s.appearance?.text_size === k ? " selected" : ""}>${v}</option>`).join("")}</select></label></div>
        <h5>시간표 · 학기</h5><p>과목 순서, 녹음 과목 자동 선택, 수업 알림, 빠진 녹음 찾기가 이 시간표를 따릅니다.</p>
        <div class="ca"><button data-a="tt">시간표·학기 편집</button><label class="dlg-check"><input type="checkbox" data-reminder${ui.info.class_reminder ? " checked" : ""}> 수업 시간이 되면 녹음할지 묻기</label></div>
        ${layoutSection(s.layout, "set")}
        <h5>녹음 자동 정리</h5>${cleanupRow(s.cleanup)}
        <h5>AI 엔진</h5><p>전사·자료 글의 정리와 그스룸 지시 해석에 쓸 엔진입니다. 녹음 전사는 별도 Google/Groq 연결을 씁니다.</p>
        ${[["default", "기본"], ["notes", "정리본·HTML 도우미"], ["gsr_chat", "그스룸 지시 해석"]].map(([key,label]) => `<label class="permission-row">${label}<select data-ai-feature="${key}">${(key === "default" ? [] : [["inherit", "기본값 따름"]]).concat(Object.entries(s.ai.choices)).map(([k,v]) => `<option value="${k}"${(s.ai.settings[key] || (key === "default" ? "codex" : "inherit")) === k ? " selected" : ""}>${esc(v)}</option>`).join("")}</select></label>`).join("")}
        ${s.ai.env_override ? `<small>환경 변수로 엔진이 고정되어 있습니다.</small>` : ""}
        ${s.live ? `<label class="permission-row">실시간 전사<select data-live-engine>${Object.entries(s.live.choices).map(([k, v]) => `<option value="${k}"${s.live.engine === k ? " selected" : ""}>${esc(v)}</option>`).join("")}</select></label><small>다음에 실시간 전사를 켤 때부터 적용됩니다. Chirp 3은 Google Cloud CLI 로그인과 프로젝트가 필요합니다.</small>` : ""}
        <h5>기능 상태</h5><table class="tools">${features}</table>
        <h5>과목별 녹음 허락</h5><p>녹음 허락과 외부 AI 전송 동의는 따로 확인합니다. 허락 상태는 이 학기 폴더에 저장합니다.</p>
        ${(s.permissions?.courses || []).map((c) => `<label class="permission-row">${esc(c.course)} <select data-permission="${esc(c.course)}">${Object.entries(s.permissions.states).map(([key, label]) => `<option value="${key}"${c.state === key ? " selected" : ""}>${esc(label)}</option>`).join("")}</select></label>`).join("") || "<small>시간표에 과목을 먼저 추가하세요.</small>"}
        <h5>계정 연결</h5>${keys}
        <h5>프로그램</h5><table class="tools">${tools}</table>
        <h5>실험실 (선택 기능)</h5><div class="labs">${Object.entries(s.lab_names).map(([k, name]) => `<label class="dlg-check"><input type="checkbox" data-lab="${esc(k)}"${s.labs[k] ? " checked" : ""}> ${esc(name)}</label>`).join("")}
          <small>켜면 왼쪽 메뉴에 나타납니다. 필요한 프로그램이 없으면 위 '기능 상태'에 안내가 나옵니다.</small></div>
        ${s.gsr ? `<h5>그스룸</h5><div class="gsrc"><b>함께 쓰는 사람 (미리 채우기)</b><small>예약 화면의 '함께 쓰는 사람' 칸에 미리 채워집니다. 이 PC 설정 파일에만 저장되고 앱 코드나 기록에는 들어가지 않습니다. 본인이 직접 아는 사람만 넣으세요.</small>
          ${matesHtml(s.gsr.rows)}<div class="ca"><button data-a="gsrsave">저장</button><span class="cmsg">${esc(s.gsr.msg)}</span></div>
          <b>빈 방 고르는 순서</b><small>여러 방이 비어 있을 때 먼저 잡을 방입니다. 비워 두면 '예약 뒤에도 비는 방 → 방 이름순'으로 고릅니다.</small>
          <div class="gsr-rooms"><label>먼저 볼 층 <select data-g="floor_first">${[["", "상관없음"], ["4", "4층"], ["2", "2층"]].map(([k, v]) => `<option value="${k}"${s.gsr.rooms.floor_first === k ? " selected" : ""}>${v}</option>`).join("")}</select></label>
            <label>뒤로 미룰 방 <input class="ask" data-g="avoid" value="${esc(s.gsr.rooms.avoid)}" placeholder="예: G404 G405"></label>
            <label>가까운 방 번호 <input class="ask short" data-g="center" value="${esc(s.gsr.rooms.center)}" placeholder="416" inputmode="decimal"></label>
            <label class="dlg-check"><input type="checkbox" data-g="prefer_monitor"${s.gsr.rooms.prefer_monitor ? " checked" : ""}> 모니터 있는 방 먼저</label></div>
          <div class="ca"><button data-a="gsrrooms">순서 저장</button><span class="cmsg">${esc(s.gsr.rmsg)}</span></div></div>` : ""}
        <div class="acts"><button data-a="refind">프로그램 다시 찾기</button><button class="primary" data-a="done">닫기</button></div></div>`;
      const dlg = scrim.querySelector(".dialog");
      if (dlg && keep) { dlg.scrollTop = keep[0]; scrim.scrollTop = keep[1]; }
    }
    scrim.addEventListener("change", async (e) => {
      if (e.target.matches("[data-live-engine]")) { const r = await api.live_engine_set(e.target.value); toast(r.ok ? "실시간 전사 엔진을 바꿨습니다 · 다음에 켤 때부터" : r.error); return; }
      const engine = e.target.closest("[data-ai-feature]");
      if (engine) { const r = await api.ai_select(engine.value, engine.dataset.aiFeature); if (!r.ok) toast(r.error); await load(); return; }
      const appearance = e.target.closest("[data-appearance]");
      if (appearance) {
        const theme = scrim.querySelector('[data-appearance="theme"]').value;
        const size = scrim.querySelector('[data-appearance="text_size"]').value;
        const r = await api.appearance(theme, size); if (r.ok) applyAppearance(r); else toast(r.error); return;
      }
      if (e.target.matches("[data-reminder]")) { const r = await api.class_reminder_set(e.target.checked); if (r.ok) ui.info.class_reminder = r.reminder; return; }
      if (e.target.matches("[data-layout]")) {
        const r = await api.folder_layout_set(e.target.value, null);
        toast(r.ok ? `폴더 구성을 '${r.label}'(으)로 바꿨습니다 · 이미 있는 파일은 옮기지 않습니다` : r.error); await load(); return;
      }
      if (e.target.matches("[data-archive]")) {
        const style = (scrim.querySelector("[data-layout]:checked") || {}).value;
        const r = await api.folder_layout_set(style, e.target.checked); if (!r.ok) toast(r.error); await load(); return;
      }
      if (e.target.matches("[data-cleanup],[data-cleanup-days]")) {
        const on = scrim.querySelector("[data-cleanup]").checked, days = scrim.querySelector("[data-cleanup-days]").value;
        const r = await api.audio_cleanup_set(on, days);
        toast(r.ok ? (r.enabled ? `Google 전사 ${r.days}일 뒤 녹음을 휴지통으로 보냅니다(정리본이 있는 회차만)` : "녹음 자동 정리를 껐습니다") : r.error);
        await load(); return;
      }
      const permission = e.target.closest("[data-permission]");
      if (permission) { const r = await api.recording_permission(permission.dataset.permission, permission.value); if (!r.ok) { toast(r.error); await load(); } return; }
      const box = e.target.closest("[data-lab]"); if (!box) return;
      const r = await api.lab_set(box.dataset.lab, box.checked);
      if (r.ok) { ui.info.labs = r.labs; applyLabs(); await load(); } else toast(r.error);
    });
    scrim.addEventListener("input", (e) => {
      if (!gsr) return;
      if (matesInput(e, gsr.rows)) return;
      const g = e.target.closest("[data-g]"); if (g) gsr.rooms[g.dataset.g] = g.type === "checkbox" ? g.checked : g.value;
    });
    scrim.addEventListener("click", async (e) => {
      if (gsr && matesClick(e.target, gsr.rows)) return draw(last);
      const b = e.target.closest("button[data-a]");
      if (!b) { if (e.target === scrim) scrim.remove(); return; }
      const a = b.dataset.a, row = b.closest(".conn"), id = row ? row.dataset.id : b.dataset.id;
      const say = (m) => { const el = scrim.querySelector("#cm-" + id); if (el) el.textContent = m; };
      if (a === "done") { scrim.remove(); loadEngines(); return; }
      if (a === "tt") { if (await openTimetable()) await load(); return; }
      if (a === "refind") { await load(true); return; }
      if (a === "gsrsave" && gsr) { const r = await api.gsr_companions_set(matesText(gsr.rows)); gsr.msg = r.ok ? `저장했습니다(${r.count}명)` : r.error; return draw(last); }
      if (a === "gsrrooms" && gsr) {
        const q = gsr.rooms, r = await api.gsr_rooms_set({ floor_first: q.floor_first, avoid: q.avoid, center: String(q.center).trim(), prefer_monitor: !!q.prefer_monitor });
        gsr.rmsg = r.ok ? "저장했습니다" : r.error; return draw(last);
      }
      if (a === "help" || a === "thelp") { await api.conn_open_help(id); return; }
      if (a === "remove") {
        if (!(await dialog({ title: "연결 끊기", body: "이 PC에 저장된 키를 지웁니다. 서비스 쪽 키는 그대로이니 필요하면 그곳에서 지우세요.", ok: "끊기", tone: "danger" }))) return;
        const r = await api.conn_remove(id); toast(r.ok ? (r.still_from_env ? "저장된 키를 지웠습니다. 환경 변수의 키는 남아 있습니다." : "끊었습니다") : r.error); await load(); return;
      }
      if (a === "connect") {
        const label = (row && row.querySelector(".ct b") || {}).textContent || "연결";
        for (;;) {  // a failed try says clearly that nothing was saved and offers to paste again
          const key = await askText({ title: `${label} 연결`, ok: "확인 후 저장", secret: true, body: "붙여 넣은 키가 이 서비스에서 통하는지 먼저 확인하고, 통할 때만 이 PC의 Windows 자격 증명 관리자에 저장합니다." });
          if (!key || !key.trim()) return;
          busy = id; delete note[id]; draw(last);
          const r = await api.conn_connect(id, key.trim()); busy = "";
          if (r.ok && r.saved) {
            note[id] = { tone: "ok", text: `연결했습니다${r.account ? ` — ${r.account} 계정으로 확인` : ""} · 저장됨` };
            toast(`${label}: 연결하고 저장했습니다`); await load(); return;
          }
          note[id] = { tone: "bad", text: "저장하지 않았습니다 — " + (r.error || "이유 미상") };
          await load();
          const again = await dialog({ title: "연결하지 못했습니다 · 저장 안 됨", body: `${r.error || "이유 미상"} 키는 저장하지 않았습니다. [다시 붙여 넣기]를 누르면 처음부터 다시 확인합니다.`,
            ok: "다시 붙여 넣기", cancel: "닫기", extra: r.can_save_anyway ? "확인 없이 저장" : "" });
          if (again === "extra") {
            const s = await api.conn_save_unchecked(id, key.trim());
            note[id] = s.saved ? { tone: "warn", text: "확인하지 못한 채 저장했습니다 — 인터넷이 되면 [테스트]를 눌러 보세요" } : { tone: "bad", text: s.error };
            await load(); return;
          }
          if (again !== true) return;
        }
      }
      if (a === "test") {
        busy = id; delete note[id]; draw(last); const r = await api.conn_test(id); busy = "";
        note[id] = r.ok ? { tone: "ok", text: `정상입니다${r.account ? ` — ${r.account} 계정` : ""}` } : { tone: "bad", text: r.error };
        await load();
      }
    });
    await load();
  }
  /* ---------- timetable and term editor (TT-001): saves 시간표.csv (old one kept in _lecturehub/backups) ---------- */
  const TT_DAYS = ["월", "화", "수", "목", "금", "토", "일"];
  function ttCourses(courses) {
    return `<div class="courses">${courses.map((c, i) => `<div class="crs" data-i="${i}">
      <input class="ask cname" placeholder="과목 이름" value="${esc(c.name)}" data-folder="${esc(c.folder || "")}">
      ${c.slots.map((s, j) => `<span class="slot" data-j="${j}"><select class="sday">${TT_DAYS.map((d) => `<option${d === s.day ? " selected" : ""}>${d}</option>`).join("")}</select>
        <input class="ask short sstart" value="${esc(s.start)}" size="5"> ~ <input class="ask short send" value="${esc(s.end)}" size="5"><button class="ghost" data-tt="unslot" data-i="${i}" data-j="${j}" title="이 시간 빼기">×</button></span>`).join("")}
      <button class="ghost" data-tt="slot" data-i="${i}">+ 다른 요일·시간</button><button class="ghost" data-tt="del" data-i="${i}">삭제</button></div>`).join("")}</div>
      <button class="ghost" data-tt="add">+ 과목 추가</button>`;
  }
  function ttRead(box) {
    return [...box.querySelectorAll(".crs")].map((c) => {
      const name = c.querySelector(".cname");
      return { name: name.value.trim(), folder: name.dataset.folder || "",
        slots: [...c.querySelectorAll(".slot")].map((s) => ({ day: s.querySelector(".sday").value, start: s.querySelector(".sstart").value.trim(), end: s.querySelector(".send").value.trim() })) };
    });
  }
  function openTimetable() {
    return new Promise(async (resolve) => {
      const data = await api.timetable_get();
      const st = { courses: data.courses || [], start: (data.term || {}).start || "", end: (data.term || {}).end || "", error: "", busy: false };
      const scrim = document.createElement("div");
      scrim.className = "scrim setup";
      document.body.appendChild(scrim); keepFocus(scrim, () => { scrim.remove(); resolve(false); });
      const read = () => { st.courses = ttRead(scrim); st.start = scrim.querySelector("#tt-start").value; st.end = scrim.querySelector("#tt-end").value; };
      function draw() {
        scrim.innerHTML = `<div class="dialog wide" role="dialog"><h4>시간표 · 학기</h4>
          <p>과목 이름을 바꾸면 화면에 보이는 이름만 바뀌고 폴더는 그대로입니다. 새 과목은 폴더를 새로 만듭니다. 이전 시간표는 _lecturehub\\backups에 남깁니다.</p>
          <div class="row"><label>개강 <input type="date" id="tt-start" class="ask" value="${esc(st.start)}"></label>
            <label>종강 <input type="date" id="tt-end" class="ask" value="${esc(st.end)}"></label>
            <small>비우면 모든 주를 수업 주로 봅니다. 공휴일·휴강은 달력에 '휴강'으로 넣으면 그날 수업에서 빠집니다.</small></div>
          ${ttCourses(st.courses)}
          ${st.error ? `<p class="err">${esc(st.error)}</p>` : ""}
          <div class="acts"><button data-tt="cancel">취소</button><button class="primary" data-tt="save"${st.busy ? " disabled" : ""}>저장</button></div></div>`;
      }
      scrim.addEventListener("click", async (e) => {
        const b = e.target.closest("[data-tt]"); if (!b) return;
        const act = b.dataset.tt, i = +b.dataset.i;
        if (act === "cancel") { scrim.remove(); resolve(false); return; }
        read();
        if (act === "add") st.courses.push({ name: "", folder: "", slots: [{ day: "월", start: "09:00", end: "10:15" }] });
        else if (act === "slot") st.courses[i].slots.push({ day: "수", start: "09:00", end: "10:15" });
        else if (act === "unslot") st.courses[i].slots.splice(+b.dataset.j, 1);
        else if (act === "del") st.courses.splice(i, 1);
        else if (act === "save") {
          st.busy = true; st.error = ""; draw();
          const r = await api.timetable_save(st.courses.filter((c) => c.name), st.start, st.end);
          st.busy = false;
          if (!r.ok) { st.error = r.error || "저장하지 못했습니다."; draw(); return; }
          Object.assign(ui.info, await api.init());
          renderAll(); refreshCourse();
          const lib = r.library && r.library.error ? ` · ${r.library.error}` : "";
          toast(`시간표를 저장했습니다 (${r.courses.length}과목${r.new_folders.length ? ` · 새 폴더 ${r.new_folders.length}개` : ""})${lib}`);
          scrim.remove(); resolve(true); return;
        }
        draw();
      });
      draw();
    });
  }

  /* ---------- first-run setup wizard (release prep 2026-11): notice -> folder -> timetable -> tools ---------- */
  const SETUP_NOTES = [
    "녹음하기 전에 교수님께 허락을 받았거나 강의계획서에서 녹음이 허용된 것을 확인했습니다. 허락이 없거나 금지된 수업은 녹음하지 않습니다.",
    "녹음과 전사본은 내 공부용이며 다른 사람에게 나누거나 올리지 않습니다.",
    "녹음에는 교수님과 다른 학생의 목소리가 담길 수 있습니다. 외부 AI 서비스로 보내기 전에 과목마다 따로 동의를 확인합니다.",
    "슬라이드와 기출에는 저작권이 있습니다. 정리본과 시험 페이지는 내 컴퓨터 안에서만 씁니다.",
    "개인적인 대화나 쉬는 시간에는 녹음을 멈춥니다.",
  ];

  function runSetup() {
    return new Promise((resolve) => {
      const st = { step: 0, parent: "", term: "", courses: [{ name: "", slots: [{ day: "월", start: "09:00", end: "10:15" }] }], tools: {}, busy: false, error: "" };
      const scrim = document.createElement("div");
      scrim.className = "scrim setup";
      document.body.appendChild(scrim); keepFocus(scrim);  // no Esc: the first-run notices must be confirmed
      api.setup_info().then((info) => { st.parent = info.parent; st.term = info.term; st.tools = info.tools || {}; st.trialOffer = info.needs_setup || info.trial; draw(); });
      const days = ["월", "화", "수", "목", "금", "토", "일"];
      const steps = ["안내", "폴더", "시간표", "폴더 구성", "도구"];
      function body() {
        if (st.step === 0) return `<p><b>Lecture Hub</b>는 수업 녹음을 글로 옮기고(전사) 슬라이드·달력과 묶어 복습을 돕는 앱입니다. 녹음은 내가 버튼을 눌렀을 때만 시작합니다.</p><p>처음 한 번만 아래 약속을 확인합니다. 모두 확인해야 시작할 수 있어요.</p>` +
          SETUP_NOTES.map((t, i) => `<label class="dlg-check"><input type="checkbox" data-note="${i}"> ${esc(t)}</label>`).join("");
        if (st.step === 1) return `<p>녹음, 전사, 정리본이 모이는 폴더입니다. 주 작업은 <b>_lecturehub</b>에 저장합니다. 녹음 보관용 복사본과 과목 정리본도 해당 학기 폴더에 추가할 수 있습니다.</p>
          <div class="row"><input id="su-parent" class="ask" value="${esc(st.parent)}" readonly><button data-act="pick">폴더 고르기</button></div>
          <div class="row"><label>학기 이름 <input id="su-term" class="ask short" value="${esc(st.term)}" maxlength="24"></label></div>
          <p class="hint">학기 폴더는 <b>${esc(st.parent)}\\${esc(st.term)}</b> 로 만들어집니다.</p>
          ${st.trialOffer ? `<div class="trial-offer"><p><b>먼저 둘러보고 싶다면</b> — 합성 강의 1개(짧은 녹음·전사·슬라이드)와 그 정리본이 든 <b>체험 학기</b>를 앱 폴더에 만들어 엽니다. 실제 수업 자료는 쓰지 않고, 나중에 설정에서 내 학기 폴더를 정하면 빠져나옵니다.</p>
            <button data-act="trial"${st.busy ? " disabled" : ""}>${st.busy ? "체험 학기 만드는 중…" : "체험 학기로 둘러보기"}</button></div>` : ""}`;
        if (st.step === 2) return `<p>수강 과목과 시간을 적으면 수업 시간에 맞춰 과목이 골라지고 녹음할지 물어봐요. 나중에 설정의 '시간표·학기 편집'에서 고칠 수 있고, 지금은 비워 둬도 됩니다.</p>
          <div class="row"><label>개강일(선택) <input type="date" id="su-start" class="ask" value="${esc(st.termStart || "")}"></label>
            <label>종강일(선택) <input type="date" id="su-end" class="ask" value="${esc(st.termEnd || "")}"></label></div>
          <div class="courses">${st.courses.map((c, i) => `<div class="crs" data-i="${i}">
            <input class="ask cname" placeholder="과목 이름" value="${esc(c.name)}">
            ${c.slots.map((s, j) => `<span class="slot" data-j="${j}"><select class="sday">${days.map((d) => `<option${d === s.day ? " selected" : ""}>${d}</option>`).join("")}</select>
              <input class="ask short sstart" value="${esc(s.start)}" size="5"> ~ <input class="ask short send" value="${esc(s.end)}" size="5"></span>`).join("")}
            <button class="ghost" data-act="slot" data-i="${i}">+ 다른 요일·시간</button><button class="ghost" data-act="del" data-i="${i}">삭제</button></div>`).join("")}</div>
          <button class="ghost" data-act="add">+ 과목 추가</button>`;
        if (st.step === 3) {
          if (!st.layout) return `<p class="hint">불러오는 중…</p>`;
          const note = st.style === "existing" ? `<p class="hint">이미 쓰는 폴더: 앞에서 고른 <b>${esc(st.parent)}</b> 폴더를 학기 폴더로 그대로 씁니다(그 안에 _lecturehub만 더합니다).</p>` : "";
          return layoutSection(st.layout, "setup", st.style) + note;
        }
        const row = (t) => `<tr><td>${esc(t.label)}</td><td>${t.found ? "✔ 있음" : t.required ? "✖ 필요" : "– 없음"}</td><td>${esc(t.needed_for)}${t.found ? "" : `<br><small>${esc(t.hint)}</small>`}</td></tr>`;
        const all = Object.values(st.tools), need = all.filter((t) => t.required), lack = need.filter((t) => !t.found);
        const head = lack.length
          ? `<p class="err">녹음 파일을 마무리하는 데 필요한 프로그램(${lack.map((t) => esc(t.label)).join(", ")})이 없습니다. 아래 안내대로 설치한 뒤 앱을 다시 켜세요. 설정은 지금 저장해 둘 수 있습니다.</p>`
          : `<p class="ok-line">✔ 녹음에 필요한 프로그램이 모두 있습니다. 바로 시작할 수 있어요.</p>`;
        return `${head}<table class="tools">${need.map(row).join("")}</table>
          <details class="opt-tools"><summary>선택 프로그램 보기 — 없어도 녹음과 전사는 됩니다</summary><table class="tools">${all.filter((t) => !t.required).map(row).join("")}</table></details>`;
      }
      function draw() {
        const last = st.step === steps.length - 1;
        scrim.innerHTML = `<div class="dialog wide" role="dialog"><h4>처음 설정 · ${st.step + 1}/${steps.length} ${esc(steps[st.step])}</h4>${body()}
          ${st.error ? `<p class="err">${esc(st.error)}</p>` : ""}
          <div class="acts">${st.step ? `<button data-act="back">이전</button>` : ""}<button class="primary" data-act="next"${st.busy ? " disabled" : ""}>${last ? "설정 저장" : "다음"}</button></div></div>`;
        if (st.step === 0) scrim.querySelector('[data-act="next"]').disabled = true;
      }
      function readStep() {
        if (st.step === 1) { const t = scrim.querySelector("#su-term"); if (t) st.term = t.value.trim(); }
        if (st.step === 2) {
          st.termStart = scrim.querySelector("#su-start").value; st.termEnd = scrim.querySelector("#su-end").value;
          st.courses =[...scrim.querySelectorAll(".crs")].map((c) => ({
            name: c.querySelector(".cname").value.trim(),
            slots: [...c.querySelectorAll(".slot")].map((s) => ({ day: s.querySelector(".sday").value, start: s.querySelector(".sstart").value.trim(), end: s.querySelector(".send").value.trim() })),
          }));
        }
      }
      async function loadLayout() {  // the trees use the term and course names typed in the steps before
        st.layout = null; draw();
        const r = await api.folder_layout_get(st.term, st.courses.filter((c) => c.name).map((c) => c.name));
        st.layout = r;
        if (!st.style) st.style = r && r.ok ? r.style : "basic";
        if (st.step === 3) draw();
      }
      async function finish() {
        st.busy = true; st.error = ""; draw();
        const rows = st.courses.filter((c) => c.name);
        const res = await api.setup_apply(st.parent, st.term, rows, st.termStart || "", st.termEnd || "", st.style || "");
        st.busy = false;
        if (!res.ok) { st.error = res.error || "저장하지 못했습니다."; draw(); return; }
        scrim.innerHTML = `<div class="dialog wide" role="dialog"><h4>설정을 저장했어요</h4><p>앱을 다시 켜면 바로 쓸 수 있습니다. 지금은 앱을 닫습니다.</p>
          <div class="acts"><button class="primary" data-act="close">앱 닫기</button></div></div>`;
      }
      scrim.addEventListener("change", (e) => {
        if (st.step === 0 && e.target.matches("[data-note]")) {
          const all = [...scrim.querySelectorAll("[data-note]")].every((b) => b.checked);
          scrim.querySelector('[data-act="next"]').disabled = !all;
        }
        if (st.step === 3 && e.target.matches("[data-layout]")) { st.style = e.target.value; draw(); }
      });
      scrim.addEventListener("click", async (e) => {
        const b = e.target.closest("[data-act]"); if (!b) return;
        const act = b.dataset.act, i = +b.dataset.i;
        if (act === "close") { await api.setup_close(); resolve(true); return; }
        readStep();
        if (act === "pick") { const r = await api.setup_pick_folder(); if (r.path) st.parent = r.path; draw(); return; }
        if (act === "trial") {
          st.busy = true; st.error = ""; draw();
          const r = await api.trial_start();
          st.busy = false;
          if (!r || !r.ok) { st.error = (r && r.error) || "체험 학기를 만들지 못했습니다."; draw(); return; }
          scrim.innerHTML = `<div class="dialog wide" role="dialog"><h4>체험 학기를 만들었어요</h4><p>'${esc(r.course || "체험 과목")}' 강의 1개와 정리본이 들어 있습니다. 앱을 다시 켜면 체험 학기로 열립니다.</p>
            <div class="acts"><button class="primary" data-act="close">앱 닫기</button></div></div>`;
          return;
        }
        if (act === "add") st.courses.push({ name: "", slots: [{ day: "월", start: "09:00", end: "10:15" }] });
        else if (act === "slot") st.courses[i].slots.push({ day: "수", start: "09:00", end: "10:15" });
        else if (act === "del") st.courses.splice(i, 1);
        else if (act === "back") st.step -= 1;
        else if (act === "next") {
          if (st.step === 1 && (!st.parent || !st.term)) { st.error = "폴더와 학기 이름을 정해 주세요."; draw(); return; }
          st.error = "";
          if (st.step === steps.length - 1) { await finish(); return; }
          st.step += 1;
          if (st.step === 3) loadLayout();
        }
        draw();
      });
    });
  }
  function startFailed(err) {
    const box = document.createElement("div");
    box.className = "scrim setup";
    box.innerHTML = `<div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="bootErrT"><h4 id="bootErrT">화면을 준비하지 못했습니다</h4>
      <p>앱 내부에서 정보를 읽지 못했습니다. 다시 시도해도 같으면 앱을 껐다 켜 주세요.</p><p class="err">${esc(String((err && err.message) || err || ""))}</p>
      <div class="acts"><button class="primary" id="bootRetry">다시 시도</button></div></div>`;
    document.body.appendChild(box);
    const retry = box.querySelector("#bootRetry");
    retry.onclick = () => location.reload();
    retry.focus();
  }
  async function start() {
    try { await startApp(); } catch (err) { startFailed(err); }
  }
  // a background load that failed (bridge busy, file locked): say so once in a while instead of failing silently
  const report = (what) => { try { if (api && api.client_error) api.client_error(String(what).slice(0, 2000)).catch(() => {}); } catch (_) { /* never loop */ } };
  window.addEventListener("error", (e) => report(`error: ${e.message} @ ${e.filename}:${e.lineno}:${e.colno} ${(e.error && e.error.stack) || ""}`));
  window.addEventListener("unhandledrejection", (e) => {
    console.error(e.reason);
    report(`rejection: ${(e.reason && (e.reason.stack || e.reason.message)) || e.reason}`);
    if (Date.now() - (ui.rejectToast || 0) < 60000 || !window.__lecturehubReady) return;
    ui.rejectToast = Date.now(); toast("일부 정보를 불러오지 못했습니다 · 잠시 뒤 다시 읽습니다");
  });
  async function startApp() {
    api = window.pywebview.api;
    const [info, appearance, ai] = await Promise.all([api.init(), api.appearance(), api.ai_status()]);
    ui.info = info;
    applyAppearance(appearance);
    ui.ai = ai;
    if (matchMedia("(max-width: 1180px)").matches) { ui.sideHidden = true; ui.sideInHome = false; }
    if (ui.info.needs_setup) { try { applyLabs(); } catch (_) { /* edition buttons only */ } await runSetup(); return; }  // first run: the wizard saves the folder and closes the app
    if (ui.info.trial) {  // synthetic trial semester: one line on top until the user picks a real folder
      const bar = document.createElement("div");
      bar.className = "trial-bar";
      bar.innerHTML = `<span>체험 학기를 보고 있어요 · 합성 강의 1개로 녹음→전사→정리본 흐름을 보여 줍니다</span><button class="primary" id="trialLeave">내 학기 폴더 정하기</button>`;
      document.body.prepend(bar);
      bar.querySelector("#trialLeave").onclick = () => runSetup();
    }
    ui.course = ui.info.course || "";
    ui.courseSource = ui.course ? "timetable_auto" : "unknown";  // D-052: a timetable pre-fill is not a user pick
    { const s = ui.course && sourceFor(ui.course); if (s) { ui.mic = s.src !== "pc"; ui.pc = s.src !== "mic"; } }
    const mics = ui.info.devices.mic || [], want = ui.info.device_name;
    const pick = mics.find((d) => want && d.name.toLowerCase().includes(want.toLowerCase())) || mics.find((d) => d.default) || mics[0];
    ui.device = pick ? pick.name : null;
    if (ui.info.mask) document.body.classList.add("masked");  // content hidden until "전사 보기" (this app run)
    ui.view = "home";
    bind(); renderAll();
    applyLabs();
    loadSidebar(); renderCenter();
    bindNotices();
    setTimeout(() => { loadEngines(); loadNotices(); }, 700);  // not needed for the first screen: let it paint first
    // a tick is skipped while the previous one still runs (slow disk): no overlapping calls, no older answer winning
    const single = (fn) => { let busy = false; return async () => { if (busy) return; busy = true; try { await fn(); } catch (err) { /* next tick */ } finally { busy = false; } }; };
    setInterval(single(loadNotices), 120000);  // the inbox file; app.py also pushes a new notice right away
    setInterval(single(loadEngines), 60000);  // use by running jobs, Pacific-midnight refill, Groq's rolling hour/day
    setInterval(single(async () => { if (ui.view === "lecture") await renderLectureEngines(); }), 20000);  // job progress on the open lecture
    setInterval(single(async () => { await refreshCourse(); }), 60000);  // the class moves on
    await syncSelection();
    ui.state = await api.state();
    if (["starting", "recording", "stopping", "finalizing"].includes(ui.state.phase)) { ui.view = "live"; renderAll(); loadExamChip(); } else renderHome();  // renderHome fills the exam chip too
    if (!["recording", "starting"].includes(ui.state.phase)) probe();
    schedulePoll();  // the state was just read above; the first poll follows
    document.addEventListener("pointerdown", pollSoon, true);  // react quickly to what the user just did
    document.addEventListener("keydown", pollSoon, true);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) pollSoon(); });
    if (ui.info.config_error) toast(ui.info.config_error);
    if (ui.state.phase === "idle") remindClass(ui.course);
    window.__lecturehubReady = true;  // for the verification driver
  }

  if (window.pywebview && window.pywebview.api) start(); else window.addEventListener("pywebviewready", start);
})();
