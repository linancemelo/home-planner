/**
 * Ring dials (tachometer style) that drive the engine's hidden range inputs.
 * The engine listens to `input` on #sun / #lamp; when it changes a value
 * programmatically it dispatches `hps-sync` so the dial redraws.
 */
import { playTick } from "./sfx";

const SWEEP = 270;
const START = -135;

function polar(r: number, deg: number) {
  const rad = (deg * Math.PI) / 180;
  return [50 + r * Math.sin(rad), 50 - r * Math.cos(rad)];
}

function mountDial(el: HTMLElement): () => void {
  const input = el.querySelector<HTMLInputElement>("input[type=range]");
  if (!input) return () => {};
  const min = +input.min;
  const max = +input.max;
  const step = +input.step || 1;
  const count = +(el.dataset.ticks ?? 24);
  const zones = (el.dataset.zones ?? "")
    .split(",")
    .filter(Boolean)
    .map((z) => {
      const [at, label] = z.split(":");
      return { at: +at, label };
    });
  const zoneEl = el.querySelector<HTMLElement>(".hps-dialzone");

  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("class", "hps-dialsvg");
  svg.setAttribute("aria-hidden", "true");
  const ticks: SVGLineElement[] = [];
  for (let i = 0; i < count; i++) {
    const deg = START + (SWEEP * i) / (count - 1);
    const major = i % 4 === 0 || i === count - 1;
    const [x1, y1] = polar(major ? 35 : 38, deg);
    const [x2, y2] = polar(45, deg);
    const line = document.createElementNS(svgNS, "line");
    line.setAttribute("x1", x1.toFixed(2));
    line.setAttribute("y1", y1.toFixed(2));
    line.setAttribute("x2", x2.toFixed(2));
    line.setAttribute("y2", y2.toFixed(2));
    line.setAttribute("stroke-width", major ? "2.6" : "1.8");
    line.setAttribute("stroke-linecap", "round");
    svg.appendChild(line);
    ticks.push(line);
  }
  for (const z of zones) {
    const t = (z.at - min) / (max - min);
    const [x, y] = polar(30, START + SWEEP * t);
    const dot = document.createElementNS(svgNS, "circle");
    dot.setAttribute("cx", x.toFixed(2));
    dot.setAttribute("cy", y.toFixed(2));
    dot.setAttribute("r", "1.3");
    dot.setAttribute("class", "hps-dialmark");
    svg.appendChild(dot);
  }
  const needle = document.createElementNS(svgNS, "circle");
  needle.setAttribute("r", "3");
  needle.setAttribute("class", "hps-dialneedle");
  svg.appendChild(needle);
  el.prepend(svg);

  let lit = -1;

  const draw = (silent: boolean) => {
    const v = +input.value;
    const t = (v - min) / (max - min);
    const on = Math.round(t * (count - 1));
    ticks.forEach((line, i) => {
      const active = i <= on;
      line.style.stroke = active ? "rgba(255,255,255,.92)" : "rgba(255,255,255,.16)";
    });
    const [nx, ny] = polar(45, START + SWEEP * t);
    needle.setAttribute("cx", nx.toFixed(2));
    needle.setAttribute("cy", ny.toFixed(2));
    needle.style.fill = "#fff";
    el.setAttribute("aria-valuenow", String(v));
    if (zoneEl && zones.length) {
      const zone = [...zones].reverse().find((z) => v >= z.at) ?? zones[0];
      zoneEl.textContent = zone.label;
      el.dataset.zone = zone.label;
    }
    if (!silent && on !== lit && lit !== -1) playTick(t);
    lit = on;
  };

  const set = (v: number) => {
    const snapped = Math.min(max, Math.max(min, Math.round((v - min) / step) * step + min));
    if (snapped === +input.value) return;
    input.value = String(snapped);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    draw(false);
  };

  const fromPointer = (e: PointerEvent) => {
    const r = svg.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    let deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
    deg = Math.max(START, Math.min(START + SWEEP, deg));
    set(min + ((deg - START) / SWEEP) * (max - min));
  };

  let dragId: number | null = null;
  const onDown = (e: PointerEvent) => {
    dragId = e.pointerId;
    el.setPointerCapture(e.pointerId);
    el.classList.add("hps-dialdrag");
    fromPointer(e);
    e.preventDefault();
  };
  const onMove = (e: PointerEvent) => {
    if (e.pointerId === dragId) fromPointer(e);
  };
  const onUp = (e: PointerEvent) => {
    if (e.pointerId !== dragId) return;
    dragId = null;
    el.classList.remove("hps-dialdrag");
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    set(+input.value + (e.deltaY < 0 ? step : -step) * (e.shiftKey ? 4 : 1));
  };
  const onKey = (e: KeyboardEvent) => {
    const dir =
      e.key === "ArrowUp" || e.key === "ArrowRight" ? 1 : e.key === "ArrowDown" || e.key === "ArrowLeft" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    set(+input.value + dir * step * (e.shiftKey ? 4 : 1));
  };
  const onSync = () => draw(true);

  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onUp);
  el.addEventListener("wheel", onWheel, { passive: false });
  el.addEventListener("keydown", onKey);
  input.addEventListener("hps-sync", onSync);
  el.setAttribute("aria-valuemin", String(min));
  el.setAttribute("aria-valuemax", String(max));
  draw(true);

  return () => {
    el.removeEventListener("pointerdown", onDown);
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointercancel", onUp);
    el.removeEventListener("wheel", onWheel);
    el.removeEventListener("keydown", onKey);
    input.removeEventListener("hps-sync", onSync);
    svg.remove();
  };
}

export function mountDials(root: HTMLElement): () => void {
  const cleanups = [...root.querySelectorAll<HTMLElement>(".hps-dial")].map(mountDial);
  return () => cleanups.forEach((fn) => fn());
}
