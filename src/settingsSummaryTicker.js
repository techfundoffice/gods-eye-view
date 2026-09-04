/**
 * SUMMARY OF CURRENT SETTINGS ticker under LIVE Breaking News.
 * Mirrors active globe settings from the live HUD DOM (no clones).
 */
function text(el) {
  return (el?.textContent || "").replace(/\s+/g, " ").trim();
}

function activeStyle() {
  const named = text(document.getElementById("active-style-name"));
  if (named) return named.startsWith("/style-") ? named : `/style-${named.toLowerCase()}`;
  const btn = document.querySelector("#control-panel .style-btn.active");
  const id = btn?.getAttribute("data-style");
  if (id) return `/style-${id}`;
  return "/style-normal";
}

function activeMapSource() {
  const chip = document.querySelector("#control-panel .map-stack-chip.active, #control-panel .map-stack-chip[aria-pressed='true']");
  if (!chip) return "—";
  return text(chip).replace(/ION$/i, "").trim() || "—";
}

function enabledLayers() {
  const rows = [...document.querySelectorAll("#data-toggles .data-toggle-row")];
  const on = [];
  for (const row of rows) {
    const btn = row.querySelector(".data-toggle-btn");
    const pressed = btn?.getAttribute("aria-pressed") === "true"
      || btn?.getAttribute("data-feed-state") === "on"
      || text(btn).toUpperCase() === "ON";
    if (!pressed) continue;
    const name = text(row.querySelector(".data-name")) || row.getAttribute("data-layer-id") || "layer";
    on.push(name);
  }
  return on.length ? on.join(", ") : "none";
}

function displayFlags() {
  const hudSelect = document.getElementById("hud-layout-select");
  const hudBtn = document.getElementById("hud-toggle");
  const det = document.getElementById("detection-toggle");
  const hudOn = hudBtn
    ? (hudBtn.classList.contains("active") || hudBtn.getAttribute("aria-pressed") === "true" || !hudBtn.classList.contains("off"))
    : true;
  const detOn = det?.getAttribute("aria-pressed") === "true" || det?.classList.contains("active");
  const layout = hudSelect?.value || "—";
  return `HUD ${hudOn ? "ON" : "OFF"}/${layout} · Detection ${detOn ? "ON" : "OFF"}`;
}

function radioSummary() {
  const state = text(document.getElementById("radio-layer-state")) || "OFF";
  const station = text(document.getElementById("radio-station-name"));
  if (/^off$/i.test(state) || !station || /NO STATION/i.test(station)) {
    return `Radio ${state || "OFF"}`;
  }
  return `Radio ${state} · ${station}`;
}

function modeSummary() {
  const mode = text(document.getElementById("hud-mode"));
  const mission = text(document.getElementById("hud-mission"));
  const parts = [];
  if (mode) parts.push(`Mode ${mode}`);
  if (mission && !/^—+$/.test(mission)) parts.push(`Mission ${mission}`);
  return parts.join(" · ");
}

function placeSummary() {
  const place = text(document.querySelector("#location-lookat .location-place, #location-place, #hud-place"))
    || text(document.getElementById("hud-latlon"));
  if (!place || /no location/i.test(place)) return "";
  // Keep the ticker readable — full intel stamp stays in LOCATION.
  const short = place.length > 64 ? `${place.slice(0, 61)}…` : place;
  return `Place ${short}`;
}

export function collectSettingsSummaryParts() {
  const parts = [
    `Style ${activeStyle()}`,
    `Map ${activeMapSource()}`,
    displayFlags(),
    `Layers ${enabledLayers()}`,
    radioSummary(),
  ];
  const mode = modeSummary();
  if (mode) parts.push(mode);
  const place = placeSummary();
  if (place) parts.push(place);
  return parts.filter(Boolean);
}

function renderContent(contentEl, parts) {
  const nodes = [];
  parts.forEach((part, index) => {
    if (index) {
      const sep = document.createElement("span");
      sep.setAttribute("aria-hidden", "true");
      sep.textContent = "·";
      nodes.push(sep);
    }
    const span = document.createElement("span");
    span.textContent = part;
    nodes.push(span);
  });
  // Duplicate once for a seamless marquee when content is long.
  const clone = nodes.map((n) => n.cloneNode(true));
  const gap = document.createElement("span");
  gap.setAttribute("aria-hidden", "true");
  gap.textContent = "·";
  contentEl.replaceChildren(...nodes, gap, ...clone);
}

export function refreshSettingsSummaryTicker(root = document) {
  const content = root.getElementById?.("settings-summary-ticker-content")
    || root.querySelector?.("#settings-summary-ticker-content");
  if (!content) return null;
  const parts = collectSettingsSummaryParts();
  const signature = parts.join(" | ");
  if (content.dataset.signature === signature) return signature;
  content.dataset.signature = signature;
  renderContent(content, parts);
  return signature;
}

export function startSettingsSummaryTicker({ intervalMs = 1500 } = {}) {
  const run = () => {
    try { refreshSettingsSummaryTicker(); }
    catch (err) { console.warn("[settings-summary-ticker]", err); }
  };
  run();
  const timer = window.setInterval(run, intervalMs);
  const onVis = () => { if (!document.hidden) run(); };
  document.addEventListener("visibilitychange", onVis);
  // Refresh quickly when operators click HUD controls.
  document.addEventListener("click", (event) => {
    if (event.target?.closest?.("#control-panel, #data-toggles, #pp-toggles, #radio-panel, #global-context-panel, #location-bar")) {
      window.setTimeout(run, 50);
    }
  }, true);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onVis);
  };
}
