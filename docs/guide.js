// guide.js — the user guide's self-running tutorial.
// Scenes advance on their own (time scaled to how much there is to read), pause while
// you hover, focus or switch tabs, and can be stepped with the controls or arrow keys.
// Without JavaScript, or with reduced motion, the scenes are simply stacked.
(function () {
  const tour = document.querySelector(".tour");
  if (!tour) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) return;
  tour.classList.add("js");

  const scenes = [...tour.querySelectorAll(".scene")];
  const bar = tour.querySelector(".tour-bar");
  const count = tour.querySelector(".tour-count");
  const playBtn = tour.querySelector("[data-act=play]");
  const endCard = tour.querySelector(".tour-end");
  const segs = scenes.map((s, i) => {
    const b = document.createElement("button");
    b.className = "tour-seg"; b.type = "button";
    b.setAttribute("aria-label", `Go to step ${i + 1}: ${s.querySelector("h2")?.textContent || ""}`);
    b.innerHTML = "<i></i>";
    b.addEventListener("click", () => go(i, true));
    bar.appendChild(b);
    return b;
  });
  // Reading time: ~260 ms a word plus a few seconds to look at the picture
  const dur = scenes.map(s => Math.min(34000, Math.max(11000, s.innerText.split(/\s+/).length * 260 + 4500)));

  let idx = 0, elapsed = 0, last = 0, playing = false, started = false, hold = 0, finished = false;

  function show(i, dir = 1) {
    const prev = scenes.find(s => s.classList.contains("active"));
    if (prev && prev !== scenes[i]) {
      prev.classList.remove("active", "enter");
      prev.classList.add("leave");
      prev.setAttribute("aria-hidden", "true");
      setTimeout(() => prev.classList.remove("leave"), 700);
    }
    const s = scenes[i];
    s.classList.remove("enter"); void s.offsetWidth;   // restart the entrance animation
    s.classList.add("active", "enter");
    s.removeAttribute("aria-hidden");
    // restart the illustration's one-shot animations
    s.querySelectorAll(".drop").forEach(el => { el.style.animation = "none"; void el.getBoundingClientRect(); el.style.animation = ""; });
    segs.forEach((g, k) => { g.classList.toggle("done", k < i); g.firstChild.style.width = k < i ? "100%" : "0"; g.setAttribute("aria-current", k === i ? "step" : "false"); });
    count.textContent = `${i + 1} / ${scenes.length}`;
  }

  function go(i, user = false) {
    finished = false; endCard.hidden = true;
    idx = Math.max(0, Math.min(scenes.length - 1, i));
    elapsed = 0;
    show(idx);
    if (user && !playing) setPlaying(true);
  }

  function finish() {
    finished = true; setPlaying(false);
    segs.forEach(g => { g.classList.add("done"); g.firstChild.style.width = "100%"; });
    endCard.hidden = false;
    setTimeout(() => document.getElementById("faq")?.scrollIntoView({ behavior: "smooth", block: "start" }), 1400);
  }

  function setPlaying(on) {
    playing = on;
    playBtn.innerHTML = on ? ICON_PAUSE + "Pause" : ICON_PLAY + (finished ? "Replay" : "Play");
    playBtn.setAttribute("aria-label", on ? "Pause the tour" : "Play the tour");
    last = performance.now();
  }

  function tick(t) {
    const dt = t - last; last = t;
    if (playing && !hold && !document.hidden) {
      elapsed += dt;
      const f = Math.min(1, elapsed / dur[idx]);
      segs[idx].firstChild.style.width = (f * 100).toFixed(2) + "%";
      if (f >= 1) { if (idx < scenes.length - 1) go(idx + 1); else finish(); }
    }
    requestAnimationFrame(tick);
  }

  const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5v14l12-7z" fill="currentColor"/></svg>';
  const ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/></svg>';

  tour.querySelector("[data-act=prev]").addEventListener("click", () => go(idx - 1, true));
  tour.querySelector("[data-act=next]").addEventListener("click", () => (idx < scenes.length - 1 ? go(idx + 1, true) : finish()));
  playBtn.addEventListener("click", () => { if (finished) { go(0); setPlaying(true); } else setPlaying(!playing); });
  tour.querySelector("[data-act=replay]")?.addEventListener("click", () => { go(0); setPlaying(true); tour.scrollIntoView({ behavior: "smooth", block: "start" }); });

  // Pause while the reader is pointing at, touching or tabbing through a scene
  const stage = tour.querySelector(".stage");
  stage.addEventListener("pointerenter", e => { if (e.pointerType === "mouse") hold++; });
  stage.addEventListener("pointerleave", e => { if (e.pointerType === "mouse") hold = Math.max(0, hold - 1); });
  stage.addEventListener("touchstart", () => { hold++; }, { passive: true });
  stage.addEventListener("touchend", () => { setTimeout(() => { hold = Math.max(0, hold - 1); }, 1500); });
  stage.addEventListener("focusin", () => { hold++; });
  stage.addEventListener("focusout", () => { hold = Math.max(0, hold - 1); });
  tour.addEventListener("keydown", e => {
    if (e.key === "ArrowRight") go(idx + 1, true);
    if (e.key === "ArrowLeft") go(idx - 1, true);
  });

  scenes.forEach(s => s.setAttribute("aria-hidden", "true"));
  show(0);
  setPlaying(false);
  requestAnimationFrame(t => { last = t; tick(t); });

  // Start when the tour scrolls into view (not when someone arrived for the FAQ)
  const start = () => { if (!started) { started = true; go(0); setPlaying(true); } };
  document.querySelectorAll("[data-start-tour]").forEach(a => a.addEventListener("click", e => {
    e.preventDefault(); tour.scrollIntoView({ behavior: "smooth", block: "start" }); started = false; start();
  }));
  if (location.hash !== "#faq" && "IntersectionObserver" in window) {
    const io = new IntersectionObserver(es => { if (es.some(x => x.isIntersecting)) { start(); io.disconnect(); } }, { threshold: 0.45 });
    io.observe(stage);
  }
})();
