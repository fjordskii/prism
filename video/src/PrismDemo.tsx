import { Sequence, useCurrentFrame, useVideoConfig, interpolate, Easing, AbsoluteFill } from "remotion";

const INK = "#111312";
const PAPER = "#fdfdfb";
const MUTE = "#6d726e";
const HAIR = "#e2e4df";
const BLUE = "#3a6fd8";
const RED = "#e5453c";
const ORANGE = "#f08c1e";
const YELLOW = "#e9c46a";
const GREEN = "#2a9d6e";
const VIOLET = "#7b5ea7";

const SANS = '"IBM Plex Sans", system-ui, sans-serif';
const MONO = '"IBM Plex Mono", ui-monospace, monospace';

const fadeUp = (frame: number, start: number, dur = 18) => ({
  opacity: interpolate(frame, [start, start + dur], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) }),
  translate: interpolate(frame, [start, start + dur], ["0px 24px", "0px 0px"], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) }),
});

const Kicker: React.FC<{ children: string }> = ({ children }) => (
  <div style={{ fontFamily: MONO, fontSize: 26, color: MUTE, marginBottom: 20 }}>{children}</div>
);

// ---------- Scene 1: one site, every visitor ----------
const SceneHook: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ background: PAPER, justifyContent: "center", padding: 140, fontFamily: SANS }}>
      <Kicker>Your website today</Kicker>
      <div style={{ fontSize: 96, fontWeight: 500, letterSpacing: "-0.02em", lineHeight: 1.05, color: INK, ...fadeUp(frame, 6) }}>
        Every visitor sees<br />the same page.
      </div>
      <div style={{ marginTop: 48, fontSize: 36, color: MUTE, fontWeight: 300, maxWidth: 900, ...fadeUp(frame, 20) }}>
        The gift buyer. The subscriber. The one who's about to leave. One page, one pitch, one chance.
      </div>
      <div style={{ marginTop: 60, fontSize: 40, fontWeight: 500, color: BLUE, ...fadeUp(frame, 2.2 * fps) }}>
        What if the page knew who was looking?
      </div>
    </AbsoluteFill>
  );
};

// ---------- Scene 2: the prism split ----------
const SceneSplit: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const personas = [
    { label: "gift buyer", color: RED, y: 190 },
    { label: "bundle builder", color: ORANGE, y: 320 },
    { label: "returning customer", color: YELLOW, y: 450 },
    { label: "category browser", color: GREEN, y: 580 },
    { label: "first-time visitor", color: BLUE, y: 710 },
    { label: "…your segments", color: VIOLET, y: 840 },
  ];
  const beamProgress = interpolate(frame, [0, 1 * fps], [0, 1], { extrapolateRight: "clamp", easing: Easing.bezier(0.4, 0, 0.2, 1) });
  const splitStart = 1.1 * fps;
  return (
    <AbsoluteFill style={{ background: PAPER, fontFamily: SANS }}>
      <div style={{ position: "absolute", top: 90, left: 140 }}>
        <Kicker>Prism</Kicker>
        <div style={{ fontSize: 64, fontWeight: 500, letterSpacing: "-0.02em", color: INK }}>One beam in. A spectrum out.</div>
      </div>
      {/* incoming beam */}
      <svg width="1920" height="1080" style={{ position: "absolute", inset: 0 }}>
        <line x1={140} y1={540} x2={140 + 560 * beamProgress} y2={540} stroke={INK} strokeWidth={6} strokeDasharray="16 12" />
        <polygon points="760,340 900,740 620,740" fill="none" stroke={INK} strokeWidth={5} strokeLinejoin="round" opacity={interpolate(frame, [0.7 * fps, 1 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })} />
        {personas.map((p, i) => {
          const t = interpolate(frame, [splitStart + i * 5, splitStart + i * 5 + 22], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) });
          const x2 = 900 + (1560 - 900) * t;
          const y2 = 540 + (p.y - 540) * t;
          return (
            <g key={p.label}>
              <line x1={900} y1={540} x2={x2} y2={y2} stroke={p.color} strokeWidth={14} strokeLinecap="round" opacity={t} />
              <text x={1600} y={p.y + 10} fontFamily={SANS} fontSize={30} fill={INK} opacity={t}>{p.label}</text>
            </g>
          );
        })}
        <text x={140} y={505} fontFamily={MONO} fontSize={24} fill={MUTE}>your website</text>
        <text x={700} y={800} fontFamily={MONO} fontSize={24} fill={MUTE} opacity={interpolate(frame, [0.8 * fps, 1.1 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}>prism</text>
      </svg>
    </AbsoluteFill>
  );
};

// ---------- Scene 3: before/after personalize ----------
const MockPage: React.FC<{ heroTitle: string; heroSub: string; cta: string; tag?: string; tagColor?: string; swapped: number }> = ({ heroTitle, heroSub, cta, tag, tagColor = BLUE, swapped }) => (
  <div style={{ width: 1180, borderRadius: 18, border: `3px solid ${HAIR}`, background: "white", overflow: "hidden", boxShadow: "0 24px 60px rgba(0,0,0,0.08)" }}>
    <div style={{ display: "flex", gap: 8, padding: "16px 20px", borderBottom: `2px solid ${HAIR}` }}>
      <div style={{ width: 16, height: 16, borderRadius: 8, background: HAIR }} />
      <div style={{ width: 16, height: 16, borderRadius: 8, background: HAIR }} />
      <div style={{ width: 16, height: 16, borderRadius: 8, background: HAIR }} />
      <div style={{ flex: 1, marginLeft: 16, background: "#f4f4f0", borderRadius: 8, fontFamily: MONO, fontSize: 18, color: MUTE, padding: "4px 14px" }}>lindencandles.com</div>
      {tag && <div style={{ fontFamily: MONO, fontSize: 18, color: "white", background: tagColor, borderRadius: 8, padding: "4px 14px" }}>{tag}</div>}
    </div>
    <div style={{ padding: "56px 64px", background: "#efe9df", position: "relative" }}>
      <div style={{ fontFamily: MONO, fontSize: 17, letterSpacing: "0.2em", color: "#8a8175" }}>HAND-POURED IN SMALL BATCHES</div>
      <div style={{ fontSize: 58, fontFamily: "Georgia, serif", marginTop: 12, color: "#2b2620", opacity: 1 - Math.abs(swapped - 1) * 0 }}>{heroTitle}</div>
      <div style={{ fontSize: 24, color: "#6b6357", marginTop: 14, maxWidth: 620 }}>{heroSub}</div>
      <div style={{ display: "inline-block", marginTop: 28, background: "#2b2620", color: "white", padding: "16px 34px", fontSize: 20, letterSpacing: "0.08em", borderRadius: 4 }}>{cta}</div>
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 18, padding: 32 }}>
      {["Fig & Cedar", "Black Pepper & Oak", "Sandalwood & Amber"].map((n) => (
        <div key={n} style={{ border: `2px solid ${HAIR}`, borderRadius: 10, padding: 22, textAlign: "center", fontSize: 20, color: "#2b2620" }}>
          <div style={{ height: 60, borderRadius: 6, background: "#d9cfbc", marginBottom: 12 }} />
          {n}
        </div>
      ))}
    </div>
  </div>
);

const ScenePersonalize: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  // timeline: default page -> identify gift -> swap
  const swapAt = 2.6 * fps;
  const t = interpolate(frame, [swapAt, swapAt + 0.5 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) });
  const gift = t > 0.5;
  return (
    <AbsoluteFill style={{ background: "#f4f4f0", fontFamily: SANS, justifyContent: "center", alignItems: "center" }}>
      <div style={{ position: "absolute", top: 70, left: 140, right: 140, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div>
          <Kicker>Live on a real store</Kicker>
          <div style={{ fontSize: 52, fontWeight: 500, letterSpacing: "-0.01em", color: INK }}>
            {gift ? "Gift buyer detected — page adapts." : "A visitor arrives…"}
          </div>
        </div>
        <div style={{ fontFamily: MONO, fontSize: 22, color: gift ? GREEN : MUTE, border: `2px solid ${gift ? GREEN : HAIR}`, borderRadius: 10, padding: "10px 18px" }}>
          {gift ? "prism.identify({ intent: \"gift\" })  ✓  <1ms" : "prism_vid: v_8f3k…"}
        </div>
      </div>
      <div style={{ opacity: 1, transform: `translateY(${(1 - t) * 0}px)` }}>
        <MockPage
          heroTitle={gift ? "The gift that fills a room." : "Light every moment."}
          heroSub={gift ? "Three hand-poured scents in a linen box. Ready to give, from $108." : "Hand-poured candles made with clean ingredients and crafted for a calm, beautiful home."}
          cta={gift ? "SHOP GIFT SETS" : "EXPLORE COLLECTION"}
          tag={gift ? "gift buyer" : undefined}
          swapped={t}
        />
      </div>
      <div style={{ position: "absolute", bottom: 60, fontFamily: MONO, fontSize: 22, color: MUTE, opacity: interpolate(frame, [swapAt + 0.6 * fps, swapAt + 1 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }}>
        swapped after first paint · no reload · no flicker on return visits
      </div>
    </AbsoluteFill>
  );
};

// ---------- Scene 4: it learns ----------
const SceneLearn: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const rows = [
    { name: "Gift-buyer hero", imp: 1284, conv: 167, rate: 13.0, color: RED },
    { name: "Bundle-buyer hero", imp: 1102, conv: 121, rate: 11.0, color: ORANGE },
    { name: "Subscribe strip", imp: 986, conv: 89, rate: 9.0, color: YELLOW },
    { name: "Woody-first sort", imp: 743, conv: 41, rate: 5.5, color: GREEN },
    { name: "Control (default)", imp: 2104, conv: 63, rate: 3.0, color: MUTE },
  ];
  return (
    <AbsoluteFill style={{ background: PAPER, fontFamily: SANS, padding: 120, paddingTop: 100 }}>
      <Kicker>While you sleep</Kicker>
      <div style={{ fontSize: 56, fontWeight: 500, letterSpacing: "-0.01em", color: INK, marginBottom: 56 }}>
        Every visit makes the next one smarter.
      </div>
      <div style={{ border: `2px solid ${HAIR}`, borderRadius: 14, overflow: "hidden", background: "white" }}>
        {rows.map((r, i) => {
          const t = interpolate(frame, [0.4 * fps + i * 7, 0.4 * fps + i * 7 + 20], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) });
          return (
            <div key={r.name} style={{ display: "grid", gridTemplateColumns: "380px 1fr 160px", alignItems: "center", gap: 32, padding: "26px 36px", borderTop: i ? `2px solid ${HAIR}` : "none", opacity: t, transform: `translateY(${(1 - t) * 20}px)` }}>
              <div style={{ fontSize: 26, fontWeight: 500, color: INK }}>{r.name}</div>
              <div style={{ height: 22, borderRadius: 11, background: "#f0f0ec", overflow: "hidden" }}>
                <div style={{ width: `${(r.rate / 13) * 100 * t}%`, height: "100%", background: r.color, borderRadius: 11 }} />
              </div>
              <div style={{ fontFamily: MONO, fontSize: 26, color: INK, textAlign: "right" }}>{r.rate.toFixed(1)}%</div>
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 40, fontSize: 28, color: MUTE, fontWeight: 300, opacity: interpolate(frame, [2.2 * fps, 2.8 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }}>
        A Bayesian bandit shifts traffic to winners per segment — automatically. No test babysitting.
      </div>
    </AbsoluteFill>
  );
};

// ---------- Scene 5: install + CTA ----------
const SceneCTA: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ background: INK, fontFamily: SANS, justifyContent: "center", padding: 140 }}>
      <div style={{ fontFamily: MONO, fontSize: 26, color: "#8a8f8a", marginBottom: 24, ...fadeUp(frame, 4) }}>One line of JavaScript</div>
      <div style={{ fontFamily: MONO, fontSize: 34, color: "#d8dbd6", background: "#1c1f1d", border: "2px solid #333834", borderRadius: 14, padding: "34px 40px", ...fadeUp(frame, 10) }}>
        <span style={{ color: "#6d726e" }}>&lt;</span>script defer src=<span style={{ color: YELLOW }}>"https://prism…/snippet.js"</span> data-site=<span style={{ color: YELLOW }}>"yourstore"</span><span style={{ color: "#6d726e" }}>&gt;&lt;/script&gt;</span>
      </div>
      <div style={{ marginTop: 64, fontSize: 84, fontWeight: 500, letterSpacing: "-0.02em", color: PAPER, lineHeight: 1.08, ...fadeUp(frame, 1 * fps) }}>
        Your next visitor is not<br />your average visitor.
      </div>
      <div style={{ marginTop: 44, display: "flex", gap: 24, ...fadeUp(frame, 1.6 * fps) }}>
        <div style={{ background: PAPER, color: INK, fontSize: 28, fontWeight: 500, padding: "18px 40px", borderRadius: 6 }}>Start free — shadow mode</div>
        <div style={{ border: `2px solid #4a4f4b`, color: PAPER, fontSize: 28, padding: "18px 40px", borderRadius: 6 }}>Watch it learn</div>
      </div>
    </AbsoluteFill>
  );
};

export const PrismDemo: React.FC = () => {
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ background: PAPER }}>
      <Sequence durationInFrames={6 * fps} premountFor={fps}><SceneHook /></Sequence>
      <Sequence from={6 * fps} durationInFrames={6 * fps} premountFor={fps}><SceneSplit /></Sequence>
      <Sequence from={12 * fps} durationInFrames={8 * fps} premountFor={fps}><ScenePersonalize /></Sequence>
      <Sequence from={20 * fps} durationInFrames={6 * fps} premountFor={fps}><SceneLearn /></Sequence>
      <Sequence from={26 * fps} durationInFrames={6 * fps} premountFor={fps}><SceneCTA /></Sequence>
    </AbsoluteFill>
  );
};
