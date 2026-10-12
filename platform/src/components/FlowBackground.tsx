import { useEffect, useRef } from 'react';
import { flowBus, PIPELINE, type FlowEvent, type StepId } from '../pipeline';

/**
 * Lebendiger Hintergrund: Die Agenten liegen als Sternbild auf einem Datenstrom.
 * Jedes Workflow-Ereignis schickt einen Kometen zum nächsten Schritt, Knoten zünden,
 * Freigaben pulsieren, Blockaden senden eine rote Schockwelle.
 */

type Vec = { x: number; y: number };

interface Comet {
  from: number; // Index im Pfad
  to: number;
  start: number;
  duration: number;
  color: string;
}

interface Burst {
  x: number;
  y: number;
  start: number;
  color: string;
  strong: boolean;
}

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: string;
}

const NODE_POS: Vec[] = [
  { x: 0.07, y: 0.74 },
  { x: 0.2, y: 0.52 },
  { x: 0.34, y: 0.66 },
  { x: 0.49, y: 0.42 },
  { x: 0.63, y: 0.56 },
  { x: 0.78, y: 0.3 },
  { x: 0.93, y: 0.42 },
];

const WARN = '#fbbf24';
const BAD = '#fb7185';

function cssVar(name: string, fallback: string) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const rgba = (hex: string, a: number) => {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
};

/** Catmull-Rom-Spline durch die Knoten, fein abgetastet. */
function buildPath(nodes: Vec[], samplesPerSeg = 60) {
  const pts: Vec[] = [];
  const nodeIndex: number[] = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    const p0 = nodes[i - 1] ?? nodes[i];
    const p1 = nodes[i];
    const p2 = nodes[i + 1];
    const p3 = nodes[i + 2] ?? p2;
    nodeIndex.push(pts.length);
    for (let s = 0; s < samplesPerSeg; s++) {
      const t = s / samplesPerSeg;
      const t2 = t * t;
      const t3 = t2 * t;
      pts.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  nodeIndex.push(pts.length);
  pts.push(nodes[nodes.length - 1]);
  return { pts, nodeIndex };
}

export function FlowBackground({ intensity = 1 }: { intensity?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const intensityRef = useRef(intensity);
  intensityRef.current = intensity;

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d')!;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let w = 0;
    let h = 0;
    let dpr = 1;
    let path = buildPath(NODE_POS);
    let screenPts: Vec[] = [];
    let raf = 0;
    const mouse = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 };

    const comets: Comet[] = [];
    const bursts: Burst[] = [];
    const sparks: Spark[] = [];
    const heat = new Map<number, { until: number; color: string; pulse: boolean }>();

    const dust = Array.from({ length: 140 }, () => ({
      x: Math.random(),
      y: Math.random(),
      z: 0.2 + Math.random() * 0.8,
      r: Math.random() * 1.3 + 0.2,
      tw: Math.random() * Math.PI * 2,
    }));

    let accent = cssVar('--accent', '#22d3ee');
    let accent2 = cssVar('--accent-2', '#8b5cf6');

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Hochformat: Sternbild verläuft eher senkrecht
      const portrait = h > w * 1.1;
      const nodes = portrait ? NODE_POS.map((_, i) => ({ x: i % 2 === 0 ? 0.26 : 0.74, y: 0.14 + (i / (NODE_POS.length - 1)) * 0.74 })) : NODE_POS;
      path = buildPath(nodes);
      screenPts = path.pts.map((p) => ({ x: p.x * w, y: p.y * h }));
    };

    const stepIndex = (step: StepId) => Math.max(0, PIPELINE.findIndex((p) => p.id === step));

    const spawnSparks = (x: number, y: number, color: string, n: number, speed = 1.6) => {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const v = (0.4 + Math.random()) * speed;
        sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 40 + Math.random() * 40, color });
      }
      if (sparks.length > 600) sparks.splice(0, sparks.length - 600);
    };

    const onEvent = (e: FlowEvent) => {
      const i = stepIndex(e.step);
      const node = path.nodeIndex[i];
      const now = performance.now();
      const color = e.status === 'blocked' || e.status === 'failed' ? BAD : e.status === 'waiting' ? WARN : i % 2 ? accent2 : accent;
      if (e.status === 'started') {
        const from = i > 0 ? path.nodeIndex[i - 1] : 0;
        comets.push({ from, to: node, start: now, duration: i > 0 ? 1100 : 700, color });
        heat.set(i, { until: now + 9000, color, pulse: false });
      } else {
        const p = screenPts[node];
        if (!p) return;
        bursts.push({ x: p.x, y: p.y, start: now, color, strong: e.status !== 'done' });
        spawnSparks(p.x, p.y, color, e.status === 'done' ? 26 : 44, e.status === 'done' ? 1.4 : 2.2);
        heat.set(i, { until: now + (e.status === 'waiting' ? 60_000 : 4000), color, pulse: e.status === 'waiting' });
      }
    };
    const off = flowBus.on(onEvent);

    const onMove = (ev: PointerEvent) => {
      mouse.tx = ev.clientX / w;
      mouse.ty = ev.clientY / h;
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('resize', resize);
    resize();

    // Akzentfarbe beobachten (Wechsel des Unternehmens)
    const mo = new MutationObserver(() => {
      accent = cssVar('--accent', accent);
      accent2 = cssVar('--accent-2', accent2);
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });

    const draw = (t: number) => {
      const boost = intensityRef.current;
      mouse.x += (mouse.tx - mouse.x) * 0.04;
      mouse.y += (mouse.ty - mouse.y) * 0.04;
      const px = (mouse.x - 0.5) * 18;
      const py = (mouse.y - 0.5) * 12;

      ctx.clearRect(0, 0, w, h);

      // 1. Farbnebel
      const blobs: [number, number, number, string, number][] = [
        [0.18 + Math.sin(t / 9000) * 0.06, 0.2 + Math.cos(t / 11000) * 0.05, 0.55, accent, 0.16],
        [0.85 + Math.cos(t / 10000) * 0.05, 0.8 + Math.sin(t / 8000) * 0.05, 0.6, accent2, 0.15],
        [0.55 + Math.sin(t / 13000) * 0.08, 0.5, 0.4, accent, 0.06 + 0.05 * boost],
      ];
      for (const [bx, by, br, col, a] of blobs) {
        const g = ctx.createRadialGradient(bx * w, by * h, 0, bx * w, by * h, br * Math.max(w, h));
        g.addColorStop(0, rgba(col, a));
        g.addColorStop(1, rgba(col, 0));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      }

      // 2. Raster (sehr dezent)
      ctx.strokeStyle = 'rgba(148,163,184,0.035)';
      ctx.lineWidth = 1;
      const grid = 64;
      ctx.beginPath();
      for (let x = ((px * 0.3) % grid) - grid; x < w + grid; x += grid) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
      }
      for (let y = ((py * 0.3) % grid) - grid; y < h + grid; y += grid) {
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
      }
      ctx.stroke();

      // 3. Staub mit Parallaxe
      for (const d of dust) {
        d.y -= 0.00004 * d.z * (1 + boost);
        if (d.y < -0.02) d.y = 1.02;
        const tw = 0.35 + 0.35 * Math.sin(t / 900 + d.tw);
        ctx.fillStyle = `rgba(226,232,240,${tw * d.z * 0.55})`;
        ctx.beginPath();
        ctx.arc(d.x * w + px * d.z, d.y * h + py * d.z, d.r * d.z, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.save();
      ctx.translate(px * 0.6, py * 0.6);

      // 4. Datenstrom: Grundlinie + wandernde Striche
      if (screenPts.length) {
        const line = (width: number, style: string | CanvasGradient, dash: number[] = [], offset = 0) => {
          ctx.beginPath();
          ctx.moveTo(screenPts[0].x, screenPts[0].y);
          for (let i = 1; i < screenPts.length; i++) ctx.lineTo(screenPts[i].x, screenPts[i].y);
          ctx.setLineDash(dash);
          ctx.lineDashOffset = offset;
          ctx.lineWidth = width;
          ctx.strokeStyle = style;
          ctx.stroke();
          ctx.setLineDash([]);
        };
        const lg = ctx.createLinearGradient(0, h, w, 0);
        lg.addColorStop(0, rgba(accent, 0.22));
        lg.addColorStop(1, rgba(accent2, 0.22));
        line(10, rgba(accent, 0.025));
        line(1.2, lg);
        line(1.6, rgba(accent, 0.35 + 0.25 * boost), [2, 22], -t / (38 / (1 + boost)));
      }

      // 5. Kometen
      const now = performance.now();
      for (let ci = comets.length - 1; ci >= 0; ci--) {
        const c = comets[ci];
        const k = Math.min(1, (now - c.start) / c.duration);
        const ease = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        const idx = Math.round(c.from + (c.to - c.from) * ease);
        const trail = 26;
        for (let j = 0; j < trail; j++) {
          const p = screenPts[Math.max(c.from, idx - j * 2)];
          if (!p) continue;
          const a = (1 - j / trail) * 0.9;
          ctx.fillStyle = rgba(c.color, a * 0.6);
          ctx.beginPath();
          ctx.arc(p.x, p.y, 3.2 * (1 - j / trail) + 0.4, 0, Math.PI * 2);
          ctx.fill();
        }
        const head = screenPts[idx];
        if (head) {
          const g = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, 26);
          g.addColorStop(0, rgba('#ffffff', 0.95));
          g.addColorStop(0.2, rgba(c.color, 0.8));
          g.addColorStop(1, rgba(c.color, 0));
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(head.x, head.y, 26, 0, Math.PI * 2);
          ctx.fill();
          if (Math.random() < 0.5) spawnSparks(head.x, head.y, c.color, 1, 0.5);
        }
        if (k >= 1) {
          comets.splice(ci, 1);
          const p = screenPts[c.to];
          if (p) {
            bursts.push({ x: p.x, y: p.y, start: now, color: c.color, strong: false });
            spawnSparks(p.x, p.y, c.color, 14, 1.1);
          }
        }
      }

      // 6. Knoten
      path.nodeIndex.forEach((pi, i) => {
        const p = screenPts[pi];
        if (!p) return;
        const ht = heat.get(i);
        const hot = ht && ht.until > now;
        const color = hot ? ht!.color : i === 4 ? WARN : i % 2 ? accent2 : accent;
        const pulse = hot && ht!.pulse ? 0.5 + 0.5 * Math.sin(now / 260) : 0;
        const base = 0.5 + 0.15 * Math.sin(t / 1400 + i);
        const glowR = 30 + (hot ? 26 : 0) + pulse * 18;
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, glowR);
        g.addColorStop(0, rgba(color, (hot ? 0.55 : 0.18) * (0.7 + base * 0.6)));
        g.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, glowR, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = rgba(color, hot ? 0.9 : 0.35);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 9 + pulse * 4, 0, Math.PI * 2);
        ctx.stroke();

        // umlaufender Bogen = Agent arbeitet
        if (hot && !ht!.pulse) {
          ctx.strokeStyle = rgba(color, 0.95);
          ctx.lineWidth = 2;
          ctx.beginPath();
          const a0 = now / 220;
          ctx.arc(p.x, p.y, 15, a0, a0 + Math.PI * 0.9);
          ctx.stroke();
        }

        ctx.fillStyle = hot ? '#fff' : rgba(color, 0.9);
        ctx.beginPath();
        ctx.arc(p.x, p.y, hot ? 3.6 : 2.6, 0, Math.PI * 2);
        ctx.fill();

        if (w > 900) {
          ctx.font = '500 10px "Inter Variable", system-ui, sans-serif';
          ctx.fillStyle = `rgba(203,213,225,${hot ? 0.8 : 0.28})`;
          ctx.textAlign = 'center';
          ctx.fillText(PIPELINE[i].label.toUpperCase(), p.x, p.y + 30);
        }
      });

      // 7. Schockwellen
      for (let bi = bursts.length - 1; bi >= 0; bi--) {
        const b = bursts[bi];
        const k = (now - b.start) / (b.strong ? 1400 : 900);
        if (k >= 1) {
          bursts.splice(bi, 1);
          continue;
        }
        ctx.strokeStyle = rgba(b.color, (1 - k) * 0.8);
        ctx.lineWidth = b.strong ? 2.4 : 1.6;
        ctx.beginPath();
        ctx.arc(b.x, b.y, 10 + k * (b.strong ? 120 : 60), 0, Math.PI * 2);
        ctx.stroke();
      }

      // 8. Funken
      for (let si = sparks.length - 1; si >= 0; si--) {
        const s = sparks[si];
        s.life++;
        s.x += s.vx;
        s.y += s.vy;
        s.vx *= 0.965;
        s.vy *= 0.965;
        const a = 1 - s.life / s.max;
        if (a <= 0) {
          sparks.splice(si, 1);
          continue;
        }
        ctx.fillStyle = rgba(s.color, a * 0.9);
        ctx.fillRect(s.x, s.y, 1.6, 1.6);
      }
      ctx.restore();

      // 9. Vignette
      const v = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.8);
      v.addColorStop(0, 'rgba(5,7,13,0)');
      v.addColorStop(1, 'rgba(5,7,13,0.75)');
      ctx.fillStyle = v;
      ctx.fillRect(0, 0, w, h);

      if (!reduced) raf = requestAnimationFrame(draw);
    };

    const onVis = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden && !reduced) raf = requestAnimationFrame(draw);
    };
    document.addEventListener('visibilitychange', onVis);
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      off();
      mo.disconnect();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  return <canvas ref={ref} aria-hidden className="pointer-events-none fixed inset-0 z-0" />;
}
