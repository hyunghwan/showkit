import {
  inspectPlayerThemeContrast,
  type CaptureSource,
  type StorySpec
} from "../core/schemas.js";
import { sha256 } from "../core/json.js";

export type PlayerFiles = {
  "index.html": string;
  "styles.css": string;
  "story.js": string;
  "player.js": string;
};

const PLAYER_ASSET_REVISION_NAMESPACE = "showkit-player-assets-v1";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function safeScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function createPlayerFiles(capture: CaptureSource, story: StorySpec): PlayerFiles {
  const captureSteps = new Map(capture.steps.map((step) => [step.id, step]));
  const themeContrast = inspectPlayerThemeContrast(story.theme);
  const steps = story.steps.map((storyStep) => {
    const captureStep = captureSteps.get(storyStep.captureStepId);
    if (!captureStep?.scene.target) {
      throw new Error(`Missing capture step ${storyStep.captureStepId}`);
    }
    return {
      id: storyStep.id,
      nodes: captureStep.scene.nodes,
      fontFaces: captureStep.scene.fontFaces ?? [],
      viewport: captureStep.scene.viewport,
      scroll: captureStep.scene.scroll ?? {
        x: 0,
        y: 0,
        width: captureStep.scene.viewport.width,
        height: captureStep.scene.viewport.height
      },
      anchorId: storyStep.anchorId,
      target: captureStep.scene.target,
      tooltip: storyStep.tooltip,
      advance: storyStep.advance
    };
  });
  const payload = {
    title: story.title,
    goal: story.goal,
    locale: story.locale,
    textRedactionActive:
      capture.redaction.sensitiveText?.mode === "text-only" &&
      ((capture.redaction.sensitiveText.redactedTextNodeCount ?? 0) > 0 ||
        (capture.redaction.sensitiveText.redactedAttributeCount ?? 0) > 0),
    welcome: story.welcome,
    theme: {
      ...story.theme,
      accentText: themeContrast.accentText
    },
    player: story.player,
    steps,
    terminal: {
      nodes: capture.terminalScene.nodes,
      fontFaces: capture.terminalScene.fontFaces ?? [],
      viewport: capture.terminalScene.viewport,
      scroll: capture.terminalScene.scroll ?? {
        x: 0,
        y: 0,
        width: capture.terminalScene.viewport.width,
        height: capture.terminalScene.viewport.height
      }
    },
    cta: story.cta ?? null,
    completion: story.completion ?? null
  };
  const storySource = `window.__SHOWKIT_DEMO__ = ${safeScriptJson(payload)};\n`;
  const assetRevision = sha256(
    [PLAYER_ASSET_REVISION_NAMESPACE, PLAYER_CSS_MODERN, PLAYER_JS, storySource].join(
      "\u0000"
    )
  ).slice(0, 16);

  return {
    "index.html": `<!doctype html>
<html lang="${escapeHtml(story.locale)}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; require-trusted-types-for 'script'; trusted-types 'none'"
    >
    <title>${escapeHtml(story.title)}</title>
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='${encodeURIComponent(story.theme.accent)}'/%3E%3Cpath d='M9 11h14M9 16h10M9 21h14' stroke='%23fffdf7' stroke-width='2.5'/%3E%3C/svg%3E">
    <link rel="stylesheet" href="./styles.css?v=${assetRevision}">
  </head>
  <body${story.welcome ? "" : ' data-initial-render="true"'}>
    <div class="demo-frame">
      <header class="frame-header" id="frame-header">
        <div class="frame-header-main" id="frame-header-main"></div>
        <div class="frame-header-meta" id="frame-header-meta"></div>
      </header>
      <main>
        <section class="stage-card" id="stage-card" aria-label="Product demo">
          <div class="scene-shell" id="scene-shell">
            <div class="scene-viewport" id="scene-viewport">
              <div class="scene-scroll" id="scene-scroll">
                <div class="scene-content" id="scene-content"></div>
                <div class="step-backdrop" id="step-backdrop" aria-hidden="true" hidden></div>
              </div>
            </div>
            <button class="hotspot" id="hotspot" type="button"></button>
            <aside class="tooltip" id="tooltip" aria-live="polite">
              <div class="tooltip-meta" id="tooltip-meta"></div>
              <h2 id="tooltip-title"></h2>
              <p id="tooltip-body"></p>
              <div class="tooltip-progress" id="tooltip-progress"></div>
              <div class="tooltip-actions" id="tooltip-actions">
                <div class="completion-actions" id="completion-actions" hidden></div>
                <button class="tooltip-next" id="tooltip-next" type="button">Next</button>
              </div>
            </aside>
            <a
              class="showkit-watermark"
              href="https://showkit.sqncs.com"
              target="_blank"
              rel="noopener noreferrer"
              referrerpolicy="no-referrer"
            >Powered by <strong>ShowKit</strong><span class="visually-hidden"> (opens in a new tab)</span></a>
          </div>
          <div class="chrome-overlay" id="chrome-overlay" aria-label="Demo controls">
            <div class="chrome-dock" data-position="top-left"></div>
            <div class="chrome-dock" data-position="top"></div>
            <div class="chrome-dock" data-position="top-right"></div>
            <div class="chrome-dock" data-position="left"></div>
            <div class="chrome-dock" data-position="center"></div>
            <div class="chrome-dock" data-position="right"></div>
            <div class="chrome-dock" data-position="bottom-left"></div>
            <div class="chrome-dock" data-position="bottom"></div>
            <div class="chrome-dock" data-position="bottom-right"></div>
          </div>
          <div
            class="welcome-layer"
            id="welcome-layer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="welcome-title"
            aria-describedby="welcome-body"
            hidden
          >
            <div class="welcome-card">
              <p class="welcome-kicker">Interactive HTML demo</p>
              <h1 id="welcome-title"></h1>
              <p id="welcome-body"></p>
              <button class="welcome-action" id="welcome-action" type="button"></button>
            </div>
          </div>
        </section>
      </main>
      <footer class="frame-footer" id="frame-footer">
        <div class="frame-footer-progress" id="frame-footer-progress"></div>
        <div class="frame-footer-actions" id="frame-footer-actions"></div>
      </footer>
      <div class="chrome-parts" id="chrome-parts" hidden>
        <h1 class="demo-title chrome-part" id="demo-title" data-chrome-part="title">${escapeHtml(story.title)}</h1>
        <p class="demo-goal chrome-part" id="demo-goal" data-chrome-part="goal">${escapeHtml(story.goal)}</p>
        <div class="step-count chrome-part" id="step-count" data-chrome-part="stepCount" aria-live="polite"></div>
        <div class="progress-control chrome-part" id="progress-control" data-chrome-part="progress">
          <span class="visually-hidden">Demo progress</span>
          <span class="progress-track" aria-hidden="true"><span id="progress-bar"></span></span>
        </div>
        <button
          class="control-button chrome-part"
          id="back"
          data-chrome-part="back"
          type="button"
          aria-label="Back"
          title="Back"
        >
          <svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M15 18 9 12l6-6M9 12h10"></path>
          </svg>
          <span class="control-label">Back</span>
        </button>
        <button
          class="control-button chrome-part"
          id="restart"
          data-chrome-part="restart"
          type="button"
          aria-label="Restart demo"
          title="Restart demo"
        >
          <svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
            <path d="M3 3v5h5"></path>
          </svg>
          <span class="control-label">Restart demo</span>
        </button>
        <a class="cta chrome-part" id="cta" data-chrome-part="cta" hidden>Open product</a>
      </div>
      <p class="visually-hidden" id="announcer" aria-live="polite"></p>
    </div>
    <script src="./story.js?v=${assetRevision}"></script>
    <script src="./player.js?v=${assetRevision}"></script>
  </body>
</html>
`,
    "story.js": storySource,
    "styles.css": PLAYER_CSS_MODERN,
    "player.js": PLAYER_JS
  };
}

const PLAYER_CSS = `:root {
  color-scheme: light;
  --accent: #ff5a36;
  --ink: #17211b;
  --paper: #f3efe6;
  --cream: #fffdf7;
  --font-heading: "Avenir Next", Avenir, "Gill Sans", sans-serif;
  --font-body: "Avenir Next", Avenir, "Gill Sans", sans-serif;
  --line: rgba(23, 33, 27, 0.2);
  --shadow: 0 26px 70px rgba(23, 33, 27, 0.2);
}

* { box-sizing: border-box; }

html { min-width: 320px; background: var(--paper); }

body {
  margin: 0;
  min-height: 100vh;
  color: var(--ink);
  background:
    linear-gradient(115deg, transparent 0 66%, rgba(255, 90, 54, 0.09) 66% 67%, transparent 67%),
    repeating-linear-gradient(0deg, rgba(23, 33, 27, 0.028) 0 1px, transparent 1px 7px),
    var(--paper);
  font-family: var(--font-body);
}

button, a { font: inherit; }

button:focus-visible, a:focus-visible {
  outline: 3px solid var(--accent);
  outline-offset: 3px;
}

.demo-frame {
  width: min(1520px, 100%);
  margin: 0 auto;
  padding: clamp(18px, 3vw, 44px);
}

.demo-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 28px;
  align-items: end;
  margin-bottom: 22px;
}

.eyebrow, .tooltip-kicker {
  margin: 0 0 8px;
  color: var(--accent);
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

h1 {
  max-width: 980px;
  margin: 0;
  font-family: var(--font-heading);
  font-size: clamp(34px, 4.5vw, 62px);
  font-weight: 600;
  letter-spacing: -0.045em;
  line-height: 0.96;
}

.demo-goal {
  max-width: 700px;
  margin: 14px 0 0;
  color: rgba(23, 33, 27, 0.72);
  font-size: clamp(15px, 1.5vw, 19px);
  line-height: 1.45;
}

.step-count {
  min-width: 94px;
  padding: 10px 14px;
  border: 1px solid var(--ink);
  background: var(--cream);
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-align: center;
  text-transform: uppercase;
}

.stage-card {
  width: 100%;
  margin-inline: auto;
  padding: clamp(7px, 1vw, 13px);
  border: 1px solid var(--ink);
  background: var(--ink);
  box-shadow: var(--shadow);
}

.scene-shell {
  position: relative;
  width: 100%;
  overflow: hidden;
  overflow: clip;
  background: white;
  isolation: isolate;
}

.scene-viewport {
  position: absolute;
  left: 0;
  top: 0;
  transform-origin: 0 0;
  overflow: hidden;
  pointer-events: auto;
  user-select: text;
  will-change: left, top, transform;
  transition: filter 360ms ease;
}

.scene-viewport[data-camera-mode="focus"] {
  transition:
    left 620ms cubic-bezier(0.22, 0.72, 0.2, 1),
    top 620ms cubic-bezier(0.22, 0.72, 0.2, 1),
    transform 620ms cubic-bezier(0.22, 0.72, 0.2, 1),
    filter 360ms ease;
}

.scene-scroll {
  position: relative;
  isolation: isolate;
  width: 100%;
  height: 100%;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-color: color-mix(in srgb, var(--ink) 42%, transparent) transparent;
  scrollbar-width: thin;
  touch-action: pan-x pan-y;
}

.scene-content {
  position: relative;
  z-index: 1;
  min-width: 100%;
  min-height: 100%;
  pointer-events: auto;
  user-select: text;
}

.scene-content [data-showkit-position-lock] {
  will-change: translate;
}

body[data-player-state="welcome"] .scene-viewport {
  filter: saturate(0.82) contrast(0.94) brightness(0.82);
}

.scene-viewport * {
  animation: none !important;
  margin: 0;
  padding: 0;
  transition: none !important;
}

.hotspot {
  position: absolute;
  z-index: 4;
  display: block;
  min-width: 24px;
  min-height: 24px;
  border: 0;
  border-radius: 8px;
  outline: 3px solid var(--accent);
  outline-offset: 3px;
  background: transparent;
  box-shadow: 0 0 0 5px rgba(255, 253, 247, 0.78), 0 8px 24px rgba(23, 33, 27, 0.24);
  cursor: pointer;
}

.hotspot[hidden],
.tooltip[hidden],
.step-backdrop[hidden] {
  display: none !important;
}

.hotspot::after {
  content: "";
  position: absolute;
  inset: -10px;
  border: 1px solid rgba(255, 90, 54, 0.65);
  border-radius: 13px;
  animation: hotspot-pulse 1.8s ease-out infinite;
}

@keyframes hotspot-pulse {
  0% { opacity: 0.9; transform: scale(0.92); }
  85%, 100% { opacity: 0; transform: scale(1.2); }
}

.tooltip {
  position: absolute;
  z-index: 6;
  width: min(320px, calc(100% - 24px));
  padding: 20px;
  border: 1px solid var(--ink);
  background: var(--cream);
  box-shadow: 8px 8px 0 var(--accent);
}

.tooltip h2 {
  margin: 0;
  font-family: var(--font-heading);
  font-size: 25px;
  line-height: 1.05;
}

.tooltip p:not(.tooltip-kicker) {
  margin: 11px 0 0;
  font-size: 14px;
  line-height: 1.45;
}

.tooltip-next {
  width: 100%;
  margin-top: 16px;
  padding: 10px 14px;
  border: 1px solid var(--ink);
  background: var(--ink);
  color: var(--cream);
  cursor: pointer;
}

.demo-controls {
  display: grid;
  grid-template-columns: minmax(140px, 1fr) auto;
  gap: 24px;
  align-items: center;
  margin-top: 24px;
}

.progress-track {
  height: 4px;
  overflow: hidden;
  background: rgba(23, 33, 27, 0.16);
}

.progress-track span {
  display: block;
  width: 0;
  height: 100%;
  background: var(--accent);
  transition: width 220ms ease;
}

.control-actions { display: flex; gap: 10px; align-items: center; }

.control-button, .cta {
  min-height: 42px;
  padding: 10px 16px;
  border: 1px solid var(--ink);
  background: transparent;
  color: var(--ink);
  text-decoration: none;
  cursor: pointer;
}

.control-button:hover { background: rgba(23, 33, 27, 0.07); }
.control-button:disabled { cursor: not-allowed; opacity: 0.38; }
.cta { background: var(--accent); font-weight: 700; }

.visually-hidden {
  position: absolute !important;
  width: 1px !important;
  height: 1px !important;
  padding: 0 !important;
  margin: -1px !important;
  overflow: hidden !important;
  clip: rect(0, 0, 0, 0) !important;
  white-space: nowrap !important;
  border: 0 !important;
}

@media (max-width: 720px) {
  .demo-frame { padding: 14px; }
  .demo-header { grid-template-columns: 1fr; gap: 14px; }
  .step-count { justify-self: start; }
  .demo-controls { grid-template-columns: 1fr; }
  .control-actions { flex-wrap: wrap; }
  .tooltip { padding: 15px; box-shadow: 5px 5px 0 var(--accent); }
  .tooltip h2 { font-size: 20px; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
}
`;

const PLAYER_CSS_MODERN = `:root {
  color-scheme: light;
  --accent: #ff5a36;
  --accent-contrast: #17211b;
  --ink: #17211b;
  --paper: #f3efe6;
  --font-heading: "Avenir Next", Avenir, "Gill Sans", sans-serif;
  --font-body: "Avenir Next", Avenir, "Gill Sans", sans-serif;
  --container-radius: 18px;
  --chrome-surface: color-mix(in srgb, var(--ink) 88%, transparent);
  --chrome-ink: color-mix(in srgb, var(--paper) 8%, white);
  --chrome-line: rgba(255, 255, 255, 0.14);
  --container-shadow: 0 18px 48px color-mix(in srgb, var(--ink) 15%, transparent);
}

* { box-sizing: border-box; }

html {
  width: 100%;
  height: 100%;
  min-width: 320px;
  background: var(--paper);
}

body {
  margin: 0;
  width: 100%;
  height: 100%;
  min-height: 100vh;
  overflow: hidden;
  color: var(--ink);
  background: var(--paper);
  font-family: var(--font-body);
}

button, a { font: inherit; }

button:focus-visible, a:focus-visible {
  outline: 3px solid var(--ink);
  outline-offset: 2px;
  box-shadow: 0 0 0 6px var(--paper);
}

.demo-frame {
  display: grid;
  width: 100%;
  height: 100svh;
  min-height: 0;
  margin: 0 auto;
  padding: 0;
}

main {
  min-width: 0;
  min-height: 0;
}

.frame-header,
.frame-footer {
  display: none;
  width: 100%;
  margin-inline: auto;
}

.stage-card {
  position: relative;
  width: 100%;
  height: 100%;
  margin-inline: auto;
  overflow: hidden;
  border: 0;
  border-radius: 0;
  background: #111413;
  box-shadow: none;
  isolation: isolate;
}

.showkit-watermark {
  position: absolute;
  z-index: 2;
  right: 8px;
  bottom: 8px;
  display: inline-flex;
  min-height: 24px;
  align-items: center;
  gap: 0.28em;
  padding: 4px 8px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 999px;
  background: #17211b;
  color: #fffdf7;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.01em;
  line-height: 1;
  text-decoration: none;
  white-space: nowrap;
  box-shadow: 0 3px 12px rgba(0, 0, 0, 0.12);
  backdrop-filter: blur(8px) saturate(1.1);
  -webkit-backdrop-filter: blur(8px) saturate(1.1);
  transition: background-color 140ms ease, color 140ms ease;
}

.showkit-watermark strong {
  font-weight: 700;
}

.showkit-watermark:hover {
  background: #0f1612;
  color: #ffffff;
}

.scene-shell {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  overflow: clip;
  border-radius: 0;
  background: white;
  isolation: isolate;
}

.scene-viewport {
  position: absolute;
  left: 0;
  top: 0;
  transform-origin: 0 0;
  overflow: hidden;
  pointer-events: auto;
  user-select: text;
  will-change: left, top, transform;
  transition: filter 360ms ease;
}

.scene-viewport[data-camera-mode="focus"] {
  transition:
    left 620ms cubic-bezier(0.22, 0.72, 0.2, 1),
    top 620ms cubic-bezier(0.22, 0.72, 0.2, 1),
    transform 620ms cubic-bezier(0.22, 0.72, 0.2, 1),
    filter 360ms ease;
}

body[data-initial-render="true"] .scene-viewport,
body[data-initial-render="true"] .progress-track > span,
body[data-initial-render="true"] .hotspot,
body[data-initial-render="true"] .hotspot::after {
  animation: none !important;
  transition: none !important;
}

@keyframes showkit-camera-transition-clock {
  from { opacity: 1; }
  to { opacity: 1; }
}

.scene-shell[data-camera-transitioning="true"] {
  animation: showkit-camera-transition-clock 650ms linear;
}

.scene-shell[data-camera-transitioning="true"] .hotspot,
.scene-shell[data-camera-transitioning="true"] .tooltip,
.scene-shell[data-camera-transitioning="true"] .step-backdrop {
  opacity: 0;
  pointer-events: none;
}

.scene-scroll {
  position: relative;
  isolation: isolate;
  width: 100%;
  height: 100%;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-color: color-mix(in srgb, var(--ink) 42%, transparent) transparent;
  scrollbar-width: thin;
  touch-action: pan-x pan-y;
}

.scene-content {
  position: relative;
  z-index: 1;
  min-width: 100%;
  min-height: 100%;
  pointer-events: auto;
  user-select: text;
}

.scene-content [data-showkit-position-lock] {
  will-change: translate;
}

body[data-player-state="welcome"] .scene-viewport {
  filter: saturate(0.82) contrast(0.94) brightness(0.82);
}

.step-backdrop {
  --step-backdrop-color: transparent;
  position: absolute;
  z-index: 3;
  width: 0;
  height: 0;
  border-radius: 7px;
  background: transparent;
  box-shadow: 0 0 0 200vmax var(--step-backdrop-color);
  pointer-events: none;
}

.step-backdrop[data-strength="light"] {
  --step-backdrop-color: rgba(6, 10, 9, 0.08);
}

.step-backdrop[data-strength="medium"] {
  --step-backdrop-color: rgba(6, 10, 9, 0.18);
}

.step-backdrop[data-strength="heavy"] {
  --step-backdrop-color: rgba(6, 10, 9, 0.34);
}

.welcome-layer {
  position: absolute;
  z-index: 12;
  inset: 0;
  display: grid;
  align-items: center;
  justify-items: start;
  overflow: hidden;
  padding: clamp(22px, 5vw, 72px);
}

.welcome-layer[hidden] {
  display: none !important;
}

.welcome-layer[data-backdrop="off"] {
  background: transparent;
}

.welcome-layer[data-backdrop="light"] {
  background:
    linear-gradient(90deg, rgba(4, 8, 7, 0.72) 0%, rgba(4, 8, 7, 0.48) 38%, rgba(4, 8, 7, 0.12) 76%, rgba(4, 8, 7, 0.04) 100%);
}

.welcome-layer[data-backdrop="medium"] {
  background:
    linear-gradient(90deg, rgba(4, 8, 7, 0.86) 0%, rgba(4, 8, 7, 0.68) 40%, rgba(4, 8, 7, 0.24) 76%, rgba(4, 8, 7, 0.08) 100%);
}

.welcome-layer[data-backdrop="heavy"] {
  background:
    radial-gradient(circle at 78% 48%, color-mix(in srgb, var(--accent) 13%, transparent), transparent 34%),
    linear-gradient(90deg, rgba(4, 8, 7, 0.96) 0%, rgba(4, 8, 7, 0.9) 38%, rgba(4, 8, 7, 0.46) 70%, rgba(4, 8, 7, 0.18) 100%);
}

.welcome-card {
  width: min(560px, 48vw);
  padding: clamp(26px, 3.8vw, 48px);
  border: 1px solid color-mix(in srgb, var(--accent) 28%, rgba(255, 255, 255, 0.2));
  border-radius: 22px;
  background: color-mix(in srgb, var(--ink) 88%, transparent);
  color: color-mix(in srgb, var(--paper) 8%, white);
  box-shadow: 0 32px 96px rgba(0, 0, 0, 0.38);
  backdrop-filter: blur(20px) saturate(1.08);
  -webkit-backdrop-filter: blur(20px) saturate(1.08);
  animation: welcome-card-enter 520ms cubic-bezier(0.22, 0.72, 0.2, 1) both;
}

@keyframes welcome-card-enter {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}

.welcome-kicker {
  margin: 0 0 14px;
  color: color-mix(in srgb, var(--accent) 86%, white);
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 10px;
  font-weight: 720;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.welcome-card h1 {
  margin: 0;
  font-family: var(--font-heading);
  font-size: clamp(32px, 4.6vw, 58px);
  font-weight: 680;
  letter-spacing: -0.05em;
  line-height: 0.98;
}

.welcome-card > p:not(.welcome-kicker) {
  max-width: 48ch;
  margin: 20px 0 0;
  color: rgba(255, 255, 255, 0.72);
  font-size: clamp(14px, 1.35vw, 17px);
  line-height: 1.58;
}

.welcome-action {
  min-height: 46px;
  margin-top: 30px;
  padding: 11px 18px;
  border: 1px solid color-mix(in srgb, var(--accent) 84%, white);
  border-radius: 11px;
  background: var(--accent);
  color: var(--accent-contrast);
  font-size: 14px;
  font-weight: 720;
  cursor: pointer;
  box-shadow: 0 12px 30px color-mix(in srgb, var(--accent) 24%, transparent);
}

.welcome-action:hover {
  background: color-mix(in srgb, var(--accent) 88%, white);
}

.scene-viewport * {
  animation: none !important;
  margin: 0;
  padding: 0;
  transition: none !important;
}

.hotspot {
  position: absolute;
  z-index: 4;
  display: block;
  min-width: 24px;
  min-height: 24px;
  border: 0;
  border-radius: 7px;
  outline: 2px solid var(--accent);
  outline-offset: 3px;
  background: transparent;
  box-shadow:
    0 0 0 3px rgba(255, 255, 255, 0.66),
    0 6px 16px rgba(16, 20, 18, 0.15);
  animation: hotspot-attention 1.65s cubic-bezier(0.2, 0.75, 0.25, 1) infinite;
  cursor: pointer;
}

.hotspot[hidden],
.tooltip[hidden],
.step-backdrop[hidden] {
  display: none !important;
}

.hotspot::after {
  content: "";
  position: absolute;
  inset: -7px;
  border: 1px solid color-mix(in srgb, var(--accent) 54%, transparent);
  border-radius: inherit;
  animation: hotspot-pulse 1.8s ease-out infinite;
}

@keyframes hotspot-pulse {
  0% { opacity: 0.82; transform: scale(0.94); }
  86%, 100% { opacity: 0; transform: scale(1.16); }
}

@keyframes hotspot-attention {
  0%, 100% {
    filter: drop-shadow(0 3px 5px rgba(16, 20, 18, 0.16));
  }
  46% {
    filter: drop-shadow(
      0 9px 13px color-mix(in srgb, var(--accent) 34%, transparent)
    );
  }
}

.tooltip {
  position: absolute;
  z-index: 6;
  width: min(332px, calc(100% - 24px));
  overflow: hidden;
  padding: 21px 18px 14px;
  border: 1px solid color-mix(in srgb, var(--accent) 48%, #d7d9d7);
  border-radius: 14px;
  background: color-mix(in srgb, var(--paper) 8%, white);
  color: var(--ink);
  box-shadow: 0 16px 40px color-mix(in srgb, var(--ink) 17%, transparent);
}

.tooltip-meta {
  display: flex;
  min-height: 16px;
  align-items: center;
  margin: 0 0 7px;
  color: color-mix(in srgb, var(--accent) 78%, #272b29);
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.11em;
  text-transform: uppercase;
}

.tooltip-meta:empty,
.tooltip-progress:empty,
.tooltip-progress[hidden],
.tooltip-actions[hidden] {
  display: none !important;
}

.tooltip h2 {
  margin: 0;
  font-family: var(--font-heading);
  font-size: 16px;
  font-weight: 700;
  letter-spacing: -0.015em;
  line-height: 1.3;
}

.tooltip p:not(.tooltip-kicker) {
  margin: 10px 0 0;
  color: color-mix(in srgb, var(--ink) 74%, transparent);
  font-size: 13px;
  line-height: 1.5;
}

.tooltip-progress {
  position: absolute;
  inset: 0 0 auto;
  min-height: 0;
  margin: 0;
}

.tooltip-actions {
  display: flex;
  min-height: 34px;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px solid color-mix(in srgb, var(--ink) 11%, transparent);
}

.tooltip-next {
  order: 3;
  display: block;
  min-height: 34px;
  margin: 0 0 0 auto;
  padding: 7px 12px;
  border: 0;
  border-radius: 8px;
  background: var(--ink);
  color: color-mix(in srgb, var(--paper) 8%, white);
  font-size: 12px;
  font-weight: 650;
  cursor: pointer;
}

.tooltip-next[hidden] {
  display: none !important;
}

.completion-actions {
  display: flex;
  order: 3;
  flex: 1 1 auto;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  margin-left: auto;
}

.completion-actions[hidden] {
  display: none !important;
}

.completion-action {
  display: inline-flex;
  min-height: 38px;
  align-items: center;
  justify-content: center;
  padding: 8px 13px;
  border: 1px solid color-mix(in srgb, var(--ink) 22%, transparent);
  border-radius: 9px;
  color: var(--ink);
  font-size: 12px;
  font-weight: 700;
  text-decoration: none;
}

.completion-action[data-style="primary"] {
  border-color: var(--ink);
  background: var(--ink);
  color: color-mix(in srgb, var(--paper) 8%, white);
}

.completion-action[data-style="secondary"] {
  background: color-mix(in srgb, var(--paper) 38%, white);
}

.chrome-overlay {
  position: absolute;
  z-index: 8;
  inset: 0;
  overflow: hidden;
  border-radius: inherit;
  pointer-events: none;
}

.chrome-overlay[hidden],
.chrome-part[hidden] {
  display: none !important;
}

.chrome-dock {
  position: absolute;
  display: none;
  max-width: calc(100% - 24px);
  min-height: 36px;
  align-items: center;
  gap: 6px;
  padding: 6px;
  border: 1px solid var(--chrome-line);
  border-radius: 12px;
  background: var(--chrome-surface);
  color: var(--chrome-ink);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.2);
  backdrop-filter: blur(16px) saturate(1.18);
  -webkit-backdrop-filter: blur(16px) saturate(1.18);
  pointer-events: auto;
}

.chrome-dock[data-active="true"] { display: flex; }
.chrome-dock[data-position="top-left"] { top: 12px; left: 12px; }
.chrome-dock[data-position="top"] { top: 12px; left: 50%; transform: translateX(-50%); }
.chrome-dock[data-position="top-right"] { top: 12px; right: 12px; }
.chrome-dock[data-position="left"] { top: 50%; left: 12px; flex-direction: column; transform: translateY(-50%); }
.chrome-dock[data-position="center"] { top: 50%; left: 50%; transform: translate(-50%, -50%); }
.chrome-dock[data-position="right"] { top: 50%; right: 12px; flex-direction: column; transform: translateY(-50%); }
.chrome-dock[data-position="bottom-left"] { bottom: 12px; left: 12px; }
.chrome-dock[data-position="bottom"] { bottom: 12px; left: 50%; transform: translateX(-50%); }
.chrome-dock[data-position="bottom-right"] { right: 12px; bottom: 12px; }

.chrome-part { flex: 0 0 auto; }

.demo-title {
  max-width: min(420px, 52vw);
  margin: 0;
  padding: 4px 7px;
  overflow: hidden;
  font-family: var(--font-heading);
  font-size: 13px;
  font-weight: 680;
  letter-spacing: -0.01em;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.demo-goal {
  max-width: min(440px, 58vw);
  margin: 0;
  padding: 4px 7px;
  color: rgba(255, 255, 255, 0.72);
  font-size: 12px;
  line-height: 1.35;
}

.step-count {
  min-width: 82px;
  padding: 4px 7px;
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.055em;
  text-align: center;
  text-transform: uppercase;
  white-space: nowrap;
}

.progress-control {
  display: flex;
  width: clamp(128px, 16vw, 210px);
  min-height: 24px;
  align-items: center;
  padding: 0 5px;
}

.progress-track {
  display: block;
  width: 100%;
  height: 3px;
  overflow: hidden;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.2);
}

.progress-track > span {
  display: block;
  width: 0;
  height: 100%;
  border-radius: inherit;
  background: var(--accent);
  transition: width 220ms ease;
}

.control-button,
.cta {
  min-height: 30px;
  padding: 6px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font-size: 11px;
  font-weight: 650;
  line-height: 1;
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
}

.control-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.control-icon {
  display: none;
  width: 16px;
  height: 16px;
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.control-button:hover { background: rgba(255, 255, 255, 0.1); }
.control-button:disabled { cursor: not-allowed; opacity: 0.36; }

.cta {
  display: inline-flex;
  align-items: center;
  background: var(--accent);
  color: var(--accent-contrast);
}

.tooltip .step-count {
  min-width: 0;
  padding: 0;
  color: inherit;
  font-size: 10px;
  text-align: left;
}

.tooltip .progress-control {
  width: 100%;
  min-height: 4px;
  padding: 0;
}

.tooltip .progress-track {
  height: 4px;
  border-radius: 0;
  background: color-mix(in srgb, var(--ink) 13%, transparent);
}

.tooltip .progress-track > span {
  background: var(--ink);
}

.tooltip .control-button,
.tooltip .cta {
  min-height: 34px;
  padding: 7px 11px;
  border: 1px solid color-mix(in srgb, var(--ink) 19%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--paper) 38%, white);
  color: var(--ink);
  font-size: 11px;
}

.tooltip .control-button:hover {
  border-color: color-mix(in srgb, var(--accent) 62%, var(--ink));
  background: color-mix(in srgb, var(--accent) 10%, white);
}

.tooltip #restart {
  border-color: color-mix(in srgb, var(--accent) 66%, var(--ink));
  background: color-mix(in srgb, var(--accent) 13%, white);
  font-weight: 720;
}

.tooltip .control-button:disabled {
  border-color: color-mix(in srgb, var(--ink) 10%, transparent);
  background: color-mix(in srgb, var(--ink) 4%, white);
  color: color-mix(in srgb, var(--ink) 46%, transparent);
  opacity: 1;
}

.tooltip .cta {
  order: 4;
  margin-left: auto;
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-contrast);
}

.tooltip[data-complete="true"] {
  container-type: inline-size;
  width: min(360px, calc(100% - 24px));
  padding: 14px 14px 12px;
  border-radius: 12px;
}

.tooltip[data-complete="true"] .tooltip-meta {
  min-height: 13px;
  margin-bottom: 5px;
}

.tooltip[data-complete="true"] .step-count {
  font-size: 9px;
  line-height: 1.2;
}

.tooltip[data-complete="true"] h2 {
  font-size: 15px;
  line-height: 1.2;
}

.tooltip[data-complete="true"] p:not(.tooltip-kicker) {
  margin-top: 7px;
  font-size: 11.5px;
  line-height: 1.4;
}

.tooltip[data-complete="true"] .tooltip-actions {
  display: grid;
  min-height: 32px;
  align-items: stretch;
  gap: 6px;
  margin-top: 10px;
  padding-top: 8px;
}

.tooltip[data-complete="true"][data-completion-action-count="1"] .tooltip-actions {
  grid-template-columns: minmax(0, 1fr) auto auto;
}

.tooltip[data-complete="true"][data-completion-action-count="2"] .tooltip-actions {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.tooltip[data-complete="true"] .completion-actions {
  display: contents;
}

.tooltip[data-complete="true"] .completion-action,
.tooltip[data-complete="true"] .control-button,
.tooltip[data-complete="true"] .cta {
  width: auto;
  min-width: 0;
  min-height: 32px;
  margin: 0;
  padding: 6px 8px;
  font-size: 10.5px;
  line-height: 1.1;
  white-space: nowrap;
}

body[data-chrome-mode="overlay"] main {
  height: 100%;
}

body[data-chrome-mode="frame"] .demo-frame {
  align-content: center;
  height: auto;
  min-height: 100svh;
  gap: 12px;
  padding: clamp(8px, 1.5vw, 24px);
}

body[data-chrome-mode="frame"] .stage-card {
  height: auto;
  border: 1px solid rgba(23, 33, 27, 0.13);
  border-radius: var(--container-radius);
  box-shadow: var(--container-shadow);
}

body[data-chrome-mode="frame"] .frame-header,
body[data-chrome-mode="frame"] .frame-footer {
  display: flex;
  max-width: var(--stage-max-width, 100%);
  align-items: center;
}

body[data-chrome-mode="frame"] .frame-header {
  justify-content: space-between;
  gap: 16px;
  padding: 0 4px;
}

.frame-header-main {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 12px;
}

.frame-header-meta,
.frame-footer-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

body[data-chrome-mode="frame"] .frame-footer {
  display: grid;
  grid-template-columns: minmax(120px, 1fr) auto;
  gap: 14px;
  padding: 0 4px;
}

.frame-footer-progress { min-width: 0; }

body[data-chrome-mode="frame"] .demo-title {
  max-width: min(540px, 54vw);
  padding: 0;
  color: var(--ink);
  font-size: 18px;
}

body[data-chrome-mode="frame"] .demo-goal {
  max-width: 560px;
  padding: 0;
  color: color-mix(in srgb, var(--ink) 64%, transparent);
}

body[data-chrome-mode="frame"] .step-count {
  color: color-mix(in srgb, var(--ink) 72%, transparent);
}

body[data-chrome-mode="frame"] .progress-control {
  width: 100%;
  padding: 0;
}

body[data-chrome-mode="frame"] .progress-track {
  background: color-mix(in srgb, var(--ink) 14%, transparent);
}

body[data-chrome-mode="frame"] .control-button,
body[data-chrome-mode="frame"] .cta {
  color: var(--ink);
}

body[data-chrome-mode="frame"] .control-button:hover {
  background: color-mix(in srgb, var(--ink) 7%, transparent);
}

.visually-hidden {
  position: absolute !important;
  width: 1px !important;
  height: 1px !important;
  padding: 0 !important;
  margin: -1px !important;
  overflow: hidden !important;
  clip: rect(0, 0, 0, 0) !important;
  white-space: nowrap !important;
  border: 0 !important;
}

@media (max-width: 720px) {
  :root { --container-radius: 13px; }
  body[data-chrome-mode="frame"] .demo-frame { padding: 6px; }
  .welcome-layer {
    justify-items: center;
    padding: 18px;
  }
  .welcome-layer[data-backdrop="light"],
  .welcome-layer[data-backdrop="medium"],
  .welcome-layer[data-backdrop="heavy"] {
    background:
      radial-gradient(circle at 50% 18%, color-mix(in srgb, var(--accent) 13%, transparent), transparent 34%),
      rgba(4, 8, 7, 0.8);
  }
  .welcome-card {
    width: min(520px, 100%);
    padding: clamp(24px, 7vw, 36px);
    border-radius: 18px;
  }
  .welcome-card h1 {
    font-size: clamp(28px, 9vw, 44px);
  }
  .showkit-watermark { right: 6px; bottom: 6px; font-size: 9px; }
  .chrome-dock {
    min-height: 32px;
    gap: 3px;
    padding: 3px;
    border-radius: 10px;
  }
  .chrome-dock[data-position="top-left"] { top: 8px; left: 8px; }
  .chrome-dock[data-position="top"] { top: 8px; }
  .chrome-dock[data-position="top-right"] { top: 8px; right: 8px; }
  .chrome-dock[data-position="left"] { left: 8px; }
  .chrome-dock[data-position="right"] { right: 8px; }
  .chrome-dock[data-position="bottom-left"] { bottom: 8px; left: 8px; }
  .chrome-dock[data-position="bottom"] { bottom: 8px; }
  .chrome-dock[data-position="bottom-right"] { right: 8px; bottom: 8px; }
  .demo-title {
    max-width: 50vw;
    padding: 3px 6px;
    font-size: 11px;
  }
  .step-count {
    min-width: 72px;
    padding: 3px 6px;
    font-size: 9px;
  }
  .progress-control {
    width: 42px;
    min-height: 22px;
    padding: 0 4px;
  }
  .control-button,
  .cta {
    min-height: 26px;
    padding: 5px 7px;
    font-size: 10px;
  }
  .tooltip { width: min(280px, calc(100% - 16px)); padding: 15px; }
  body[data-chrome-mode="frame"] .frame-header-main {
    align-items: flex-start;
    flex-direction: column;
    gap: 3px;
  }
  body[data-chrome-mode="frame"] .frame-footer {
    grid-template-columns: 1fr;
  }
  .frame-footer-actions { flex-wrap: wrap; }
}

@media (max-width: 480px) {
  .tooltip { width: min(220px, calc(100% - 16px)); }
}

@container (max-width: 300px) {
  .tooltip[data-complete="true"] #back,
  .tooltip[data-complete="true"] #restart {
    position: relative;
    width: 32px;
    min-width: 32px;
    padding-inline: 0;
  }

  .tooltip[data-complete="true"] #back .control-icon,
  .tooltip[data-complete="true"] #restart .control-icon {
    display: block;
  }

  .tooltip[data-complete="true"] #back .control-label,
  .tooltip[data-complete="true"] #restart .control-label {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
  }

  .tooltip[data-complete="true"] #back::after,
  .tooltip[data-complete="true"] #restart::after {
    position: absolute;
    z-index: 2;
    bottom: calc(100% + 6px);
    width: max-content;
    max-width: 120px;
    padding: 4px 6px;
    border-radius: 5px;
    background: var(--ink);
    color: color-mix(in srgb, var(--paper) 8%, white);
    content: attr(aria-label);
    font-size: 9px;
    font-weight: 650;
    line-height: 1.2;
    opacity: 0;
    pointer-events: none;
    visibility: hidden;
    transform: translateY(2px);
    transition:
      opacity 120ms ease,
      transform 120ms ease,
      visibility 120ms ease;
  }

  .tooltip[data-complete="true"] #back::after {
    left: 0;
  }

  .tooltip[data-complete="true"] #restart::after {
    right: 0;
  }

  .tooltip[data-complete="true"] #back:is(:hover, :focus)::after,
  .tooltip[data-complete="true"] #restart:is(:hover, :focus)::after {
    opacity: 1;
    visibility: visible;
    transform: translateY(0);
  }
}

@media (max-width: 280px) {
  .tooltip[data-complete="true"][data-completion-action-count="1"] .tooltip-actions {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .tooltip[data-complete="true"][data-completion-action-count="1"] .completion-action {
    grid-column: 1 / -1;
  }

  .tooltip[data-complete="true"] #back,
  .tooltip[data-complete="true"] #restart {
    width: 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
`;

const PLAYER_JS = `(() => {
  "use strict";
  const demo = window.__SHOWKIT_DEMO__;
  const elements = {
    frame: document.querySelector(".demo-frame"),
    frameHeader: document.getElementById("frame-header"),
    frameHeaderMain: document.getElementById("frame-header-main"),
    frameHeaderMeta: document.getElementById("frame-header-meta"),
    frameFooter: document.getElementById("frame-footer"),
    frameFooterProgress: document.getElementById("frame-footer-progress"),
    frameFooterActions: document.getElementById("frame-footer-actions"),
    stage: document.querySelector(".stage-card"),
    chromeOverlay: document.getElementById("chrome-overlay"),
    chromeParts: document.getElementById("chrome-parts"),
    shell: document.getElementById("scene-shell"),
    viewport: document.getElementById("scene-viewport"),
    scroll: document.getElementById("scene-scroll"),
    content: document.getElementById("scene-content"),
    stepBackdrop: document.getElementById("step-backdrop"),
    hotspot: document.getElementById("hotspot"),
    tooltip: document.getElementById("tooltip"),
    tooltipMeta: document.getElementById("tooltip-meta"),
    tooltipProgress: document.getElementById("tooltip-progress"),
    tooltipActions: document.getElementById("tooltip-actions"),
    completionActions: document.getElementById("completion-actions"),
    title: document.getElementById("tooltip-title"),
    body: document.getElementById("tooltip-body"),
    next: document.getElementById("tooltip-next"),
    demoTitle: document.getElementById("demo-title"),
    demoGoal: document.getElementById("demo-goal"),
    count: document.getElementById("step-count"),
    progressControl: document.getElementById("progress-control"),
    progress: document.getElementById("progress-bar"),
    back: document.getElementById("back"),
    restart: document.getElementById("restart"),
    cta: document.getElementById("cta"),
    welcome: document.getElementById("welcome-layer"),
    welcomeTitle: document.getElementById("welcome-title"),
    welcomeBody: document.getElementById("welcome-body"),
    welcomeAction: document.getElementById("welcome-action"),
    announcer: document.getElementById("announcer")
  };
  const sceneFontStyle = document.createElement("style");
  sceneFontStyle.id = "scene-font-faces";
  document.head.append(sceneFontStyle);
  let current = -1;
  let renderedViewport = { width: 1440, height: 900 };
  let renderedScroll = { x: 0, y: 0, width: 1440, height: 900 };
  let renderedScale = 1;
  let overlayFrame = 0;
  let overlayTimer = 0;
  let overlayTrackUntil = 0;
  let overlayRevealAt = 0;
  let overlayRevealTimer = 0;
  let renderRevision = 0;
  let animatedCameraRevision = -1;
  let completionSplitLayout = false;
  const defaultChrome = {
    mode: "overlay",
    placements: {
      title: "hidden",
      goal: "hidden",
      stepCount: "tooltip",
      progress: "tooltip",
      back: "tooltip",
      restart: "tooltip",
      cta: "tooltip"
    }
  };
  const chrome = demo.player?.chrome ?? defaultChrome;
  const navigation = demo.player?.navigation ?? "controls";
  const camera = demo.player?.camera ?? "fit";
  const hasWelcome = Boolean(demo.welcome);
  const firstState = hasWelcome ? -1 : 0;
  current = firstState;
  const chromePartElements = {
    title: elements.demoTitle,
    goal: elements.demoGoal,
    stepCount: elements.count,
    progress: elements.progressControl,
    back: elements.back,
    restart: elements.restart,
    cta: elements.cta
  };
  const sceneLayoutObserver = new ResizeObserver(() => {
    requestAnimationFrame(positionOverlay);
  });

  document.documentElement.style.setProperty("--accent", demo.theme.accent);
  document.documentElement.style.setProperty("--accent-contrast", demo.theme.accentText);
  document.documentElement.style.setProperty("--ink", demo.theme.ink);
  document.documentElement.style.setProperty("--paper", demo.theme.paper);
  document.documentElement.style.setProperty("--font-heading", demo.theme.fonts.heading);
  document.documentElement.style.setProperty("--font-body", demo.theme.fonts.body);
  if (hasWelcome) {
    elements.welcome.dataset.backdrop = demo.welcome.backdrop;
    elements.welcomeTitle.textContent = demo.welcome.title;
    elements.welcomeBody.textContent = demo.welcome.body;
    elements.welcomeAction.textContent = demo.welcome.actionLabel;
  }

  function configureChrome() {
    const overlayMode = chrome.mode === "overlay";
    document.body.dataset.chromeMode = overlayMode ? "overlay" : "frame";
    elements.chromeOverlay.hidden = !overlayMode;
    const docks = new Map(
      Array.from(elements.chromeOverlay.querySelectorAll(".chrome-dock")).map((dock) => [
        dock.dataset.position,
        dock
      ])
    );
    const frameDestinations = {
      title: elements.frameHeaderMain,
      goal: elements.frameHeaderMain,
      stepCount: elements.frameHeaderMeta,
      progress: elements.frameFooterProgress,
      back: elements.frameFooterActions,
      restart: elements.frameFooterActions,
      cta: elements.frameFooterActions
    };
    const tooltipDestinations = {
      stepCount: elements.tooltipMeta,
      progress: elements.tooltipProgress,
      back: elements.tooltipActions,
      restart: elements.tooltipActions,
      cta: elements.tooltipActions
    };

    for (const [kind, part] of Object.entries(chromePartElements)) {
      const placement = chrome.placements[kind];
      part.dataset.chromeHidden = placement === "hidden" ? "true" : "false";
      if (placement === "hidden") {
        part.hidden = true;
        elements.chromeParts.append(part);
        continue;
      }
      if (kind !== "cta") part.hidden = false;
      const destination = placement === "tooltip"
        ? tooltipDestinations[kind]
        : overlayMode
          ? docks.get(placement)
          : frameDestinations[kind];
      destination.append(part);
    }
    for (const dock of docks.values()) {
      dock.dataset.active = dock.childElementCount > 0 ? "true" : "false";
    }
  }

  configureChrome();

  function updateTooltipControlVisibility() {
    elements.tooltipProgress.hidden = elements.tooltipProgress.childElementCount === 0;
    elements.tooltipActions.hidden = Array.from(elements.tooltipActions.children).every(
      (element) => element.hidden
    );
  }

  function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum);
  }

  function intersectRect(rect, boundary) {
    const left = Math.max(rect.left, boundary.left);
    const top = Math.max(rect.top, boundary.top);
    const right = Math.min(rect.right, boundary.right);
    const bottom = Math.min(rect.bottom, boundary.bottom);
    if (right <= left || bottom <= top) return null;
    return {
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top
    };
  }

  function overlapArea(left, top, width, height, obstacle) {
    const overlapWidth = Math.max(
      0,
      Math.min(left + width, obstacle.right) - Math.max(left, obstacle.left)
    );
    const overlapHeight = Math.max(
      0,
      Math.min(top + height, obstacle.bottom) - Math.max(top, obstacle.top)
    );
    return overlapWidth * overlapHeight;
  }

  const tooltipEdgeMargin = 12;
  const tooltipMinimumBottomSafeArea = 48;
  const tooltipMaximumBottomSafeArea = 64;

  function visibleShellBounds(shellRect) {
    const visualViewport = window.visualViewport;
    if (!visualViewport) {
      return {
        left: 0,
        top: 0,
        right: shellRect.width,
        bottom: shellRect.height,
        width: shellRect.width,
        height: shellRect.height
      };
    }
    const viewportBounds = {
      left: visualViewport.offsetLeft,
      top: visualViewport.offsetTop,
      right: visualViewport.offsetLeft + visualViewport.width,
      bottom: visualViewport.offsetTop + visualViewport.height
    };
    const visible = intersectRect(shellRect, viewportBounds);
    if (!visible) {
      return {
        left: 0,
        top: 0,
        right: shellRect.width,
        bottom: shellRect.height,
        width: shellRect.width,
        height: shellRect.height
      };
    }
    const left = visible.left - shellRect.left;
    const top = visible.top - shellRect.top;
    return {
      left,
      top,
      right: left + visible.width,
      bottom: top + visible.height,
      width: visible.width,
      height: visible.height
    };
  }

  function visibleSceneBounds(shellRect) {
    const visibleShell = visibleShellBounds(shellRect);
    const sceneRect = elements.viewport.getBoundingClientRect();
    const left = Math.max(visibleShell.left, sceneRect.left - shellRect.left);
    const top = Math.max(visibleShell.top, sceneRect.top - shellRect.top);
    const right = Math.min(
      visibleShell.right,
      sceneRect.right - shellRect.left
    );
    const bottom = Math.min(
      visibleShell.bottom,
      sceneRect.bottom - shellRect.top
    );
    if (right <= left || bottom <= top) return visibleShell;
    return {
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top
    };
  }

  function tooltipPlacementBounds(
    shellRect,
    tooltipRect,
    visible = visibleShellBounds(shellRect)
  ) {
    const horizontalSpare = Math.max(0, visible.width - tooltipRect.width);
    const verticalSpare = Math.max(0, visible.height - tooltipRect.height);
    const horizontalMargin = Math.min(
      tooltipEdgeMargin,
      horizontalSpare / 2
    );
    const topMargin = Math.min(tooltipEdgeMargin, verticalSpare / 2);
    const desiredBottomSafeArea = clamp(
      visible.height * 0.08,
      tooltipMinimumBottomSafeArea,
      tooltipMaximumBottomSafeArea
    );
    const bottomSafeArea = Math.min(
      desiredBottomSafeArea,
      Math.max(0, verticalSpare - topMargin)
    );
    const minLeft = visible.left + horizontalMargin;
    const maxLeft = Math.max(
      minLeft,
      visible.right - tooltipRect.width - horizontalMargin
    );
    const minTop = visible.top + topMargin;
    const maxTop = Math.max(
      minTop,
      visible.bottom - tooltipRect.height - bottomSafeArea
    );
    return {
      ...visible,
      minLeft,
      maxLeft,
      minTop,
      maxTop,
      bottomSafeArea
    };
  }

  function sceneTooltipPlacementBounds(shellRect, tooltipRect, edgeInset = 0) {
    const rawVisibleScene = visibleSceneBounds(shellRect);
    const inset = Math.min(
      edgeInset,
      rawVisibleScene.width / 2,
      rawVisibleScene.height / 2
    );
    const visibleScene = {
      left: rawVisibleScene.left + inset,
      top: rawVisibleScene.top + inset,
      right: rawVisibleScene.right - inset,
      bottom: rawVisibleScene.bottom - inset,
      width: Math.max(0, rawVisibleScene.width - inset * 2),
      height: Math.max(0, rawVisibleScene.height - inset * 2)
    };
    const visible =
      tooltipRect.width <= visibleScene.width &&
      tooltipRect.height <= visibleScene.height
        ? visibleScene
        : visibleShellBounds(shellRect);
    return tooltipPlacementBounds(shellRect, tooltipRect, visible);
  }

  function visibleInteractionElement(anchor) {
    const anchorId = anchor.getAttribute("data-showkit-anchor");
    const capturedInteractionBox = anchorId
      ? elements.viewport.querySelector(
          '[data-showkit-interaction-box="' + CSS.escape(anchorId) + '"]'
        )
      : null;
    if (capturedInteractionBox) return capturedInteractionBox;
    if (
      !(anchor instanceof HTMLInputElement) ||
      !["checkbox", "radio"].includes(anchor.type.toLowerCase())
    ) {
      return anchor;
    }
    const anchorRect = anchor.getBoundingClientRect();
    if (anchorRect.width >= 24 && anchorRect.height >= 24) return anchor;
    const labels = new Set(Array.from(anchor.labels || []));
    const containingLabel = anchor.closest("label");
    if (containingLabel) labels.add(containingLabel);
    return (
      [...labels]
        .filter((label) => {
          const rect = label.getBoundingClientRect();
          const style = getComputedStyle(label);
          return (
            rect.width >= 24 &&
            rect.height >= 24 &&
            rect.bottom > 0 &&
            rect.right > 0 &&
            rect.top < window.innerHeight &&
            rect.left < window.innerWidth &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.visibility !== "collapse" &&
            Number.parseFloat(style.opacity || "1") > 0
          );
        })
        .sort((left, right) => {
          const containmentDifference =
            Number(!left.contains(anchor)) - Number(!right.contains(anchor));
          if (containmentDifference !== 0) return containmentDifference;
          const leftRect = left.getBoundingClientRect();
          const rightRect = right.getBoundingClientRect();
          return leftRect.width * leftRect.height - rightRect.width * rightRect.height;
        })[0] || anchor
    );
  }

  function prominentSceneObstacles(shellRect) {
    const candidates = Array.from(
      elements.viewport.querySelectorAll(
        '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"], [role="listbox"], [role="tooltip"]'
      )
    ).filter((element) => {
      if (!(element instanceof HTMLElement) || element.hidden) return false;
      if (element.getAttribute("aria-hidden") === "true") return false;
      const style = getComputedStyle(element);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number.parseFloat(style.opacity) === 0
      ) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width >= 24 && rect.height >= 24;
    });
    const outermost = candidates.filter(
      (candidate) =>
        !candidates.some(
          (other) => other !== candidate && other.contains(candidate)
        )
    );
    return outermost
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const left = rect.left - shellRect.left;
        const top = rect.top - shellRect.top;
        return {
          left,
          top,
          right: left + rect.width,
          bottom: top + rect.height,
          width: rect.width,
          height: rect.height
        };
      })
      .filter(
        (obstacle) =>
          obstacle.right > 0 &&
          obstacle.bottom > 0 &&
          obstacle.left < shellRect.width &&
          obstacle.top < shellRect.height
      );
  }

  function completionContentObstacles(shellRect) {
    const candidates = Array.from(
      elements.viewport.querySelectorAll(
        '[data-showkit-text], button, input, select, textarea, [role="button"], img, svg'
      )
    ).filter((element) => {
      if (!(element instanceof HTMLElement || element instanceof SVGElement)) {
        return false;
      }
      if (element instanceof HTMLElement && element.hidden) return false;
      const style = getComputedStyle(element);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        Number.parseFloat(style.opacity || "1") === 0
      ) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width >= 2 && rect.height >= 2;
    });
    const outermost = candidates.filter(
      (candidate) =>
        !candidates.some(
          (other) => other !== candidate && other.contains(candidate)
        )
    );
    return outermost
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const left = rect.left - shellRect.left;
        const top = rect.top - shellRect.top;
        return {
          left,
          top,
          right: left + rect.width,
          bottom: top + rect.height,
          width: rect.width,
          height: rect.height
        };
      })
      .filter(
        (obstacle) =>
          obstacle.right > 0 &&
          obstacle.bottom > 0 &&
          obstacle.left < shellRect.width &&
          obstacle.top < shellRect.height
      );
  }

  function activeChromeObstacles(shellRect) {
    if (chrome.mode !== "overlay") return [];
    return Array.from(
      elements.chromeOverlay.querySelectorAll('.chrome-dock[data-active="true"]')
    ).map((dock) => {
      const rect = dock.getBoundingClientRect();
      const left = rect.left - shellRect.left;
      const top = rect.top - shellRect.top;
      return {
        left,
        top,
        right: left + rect.width,
        bottom: top + rect.height,
        width: rect.width,
        height: rect.height
      };
    });
  }

  function selectCompletionPlacement(shellRect, tooltipRect, sceneObstacles) {
    const gap = 18;
    const chromeObstacles = activeChromeObstacles(shellRect);
    const contentObstacles = completionContentObstacles(shellRect);
    const placementBounds = sceneTooltipPlacementBounds(shellRect, tooltipRect);
    const centerLeft =
      placementBounds.left +
      (placementBounds.width - tooltipRect.width) / 2;
    const centerTop =
      placementBounds.top +
      (placementBounds.height - tooltipRect.height) / 2;
    const candidates = [
      {
        placement: "center",
        left: centerLeft,
        top: centerTop
      },
      ...contentObstacles.flatMap((obstacle) => [
        {
          placement: "center-shifted",
          left: centerLeft,
          top: obstacle.bottom + gap
        },
        {
          placement: "center-shifted",
          left: centerLeft,
          top: obstacle.top - tooltipRect.height - gap
        }
      ]),
      ...sceneObstacles.flatMap((obstacle) => [
        {
          placement: "right",
          left: obstacle.right + gap,
          top: obstacle.top + obstacle.height / 2 - tooltipRect.height / 2
        },
        {
          placement: "left",
          left: obstacle.left - tooltipRect.width - gap,
          top: obstacle.top + obstacle.height / 2 - tooltipRect.height / 2
        },
        {
          placement: "bottom",
          left: obstacle.left + obstacle.width / 2 - tooltipRect.width / 2,
          top: obstacle.bottom + gap
        },
        {
          placement: "top",
          left: obstacle.left + obstacle.width / 2 - tooltipRect.width / 2,
          top: obstacle.top - tooltipRect.height - gap
        }
      ]),
      {
        placement: "top-left",
        left: placementBounds.minLeft,
        top: placementBounds.minTop
      },
      {
        placement: "top-right",
        left: placementBounds.maxLeft,
        top: placementBounds.minTop
      },
      {
        placement: "bottom-left",
        left: placementBounds.minLeft,
        top: placementBounds.maxTop
      },
      {
        placement: "bottom-right",
        left: placementBounds.maxLeft,
        top: placementBounds.maxTop
      }
    ];
    let selected = {
      placement: "center",
      left: placementBounds.minLeft,
      top: placementBounds.minTop,
      sceneOverlap: Number.POSITIVE_INFINITY,
      contentOverlap: Number.POSITIVE_INFINITY,
      bottomSafeArea: placementBounds.bottomSafeArea,
      rank: Array(6).fill(Number.POSITIVE_INFINITY)
    };
    for (const [preferenceIndex, candidate] of candidates.entries()) {
      const left = clamp(
        candidate.left,
        placementBounds.minLeft,
        placementBounds.maxLeft
      );
      const top = clamp(
        candidate.top,
        placementBounds.minTop,
        placementBounds.maxTop
      );
      const overflow =
        Math.max(0, placementBounds.minLeft - candidate.left) +
        Math.max(0, placementBounds.minTop - candidate.top) +
        Math.max(0, candidate.left - placementBounds.maxLeft) +
        Math.max(0, candidate.top - placementBounds.maxTop);
      const sceneOverlap = sceneObstacles.reduce(
        (area, obstacle) =>
          area +
          overlapArea(
            left,
            top,
            tooltipRect.width,
            tooltipRect.height,
            obstacle
          ),
        0
      );
      const chromeOverlap = chromeObstacles.reduce(
        (area, obstacle) =>
          area +
          overlapArea(
            left,
            top,
            tooltipRect.width,
            tooltipRect.height,
            obstacle
          ),
        0
      );
      const contentOverlap = contentObstacles.reduce(
        (area, obstacle) =>
          area +
          overlapArea(
            left,
            top,
            tooltipRect.width,
            tooltipRect.height,
            obstacle
          ),
        0
      );
      const rank = [
        overflow,
        sceneOverlap,
        chromeOverlap,
        contentOverlap,
        Math.abs(left - centerLeft) + Math.abs(top - centerTop),
        preferenceIndex
      ];
      const better = rank.some(
        (value, index) =>
          value < selected.rank[index] &&
          rank.slice(0, index).every((earlier, earlierIndex) =>
            earlier === selected.rank[earlierIndex]
          )
      );
      if (better) {
        selected = {
          placement: candidate.placement,
          left,
          top,
          sceneOverlap,
          contentOverlap,
          bottomSafeArea: placementBounds.bottomSafeArea,
          rank
        };
      }
    }
    return selected;
  }

  function splitCompletionPlacement(shellRect, tooltipRect) {
    const margin = 12;
    const gap = 18;
    const placementBounds = tooltipPlacementBounds(shellRect, tooltipRect);
    const sideAvailableWidth = Math.max(
      0,
      shellRect.width - tooltipRect.width - gap - margin * 2
    );
    const bottomAvailableHeight = Math.max(
      0,
      placementBounds.maxTop - gap - margin
    );
    const sideScale = Math.min(
      sideAvailableWidth / renderedViewport.width,
      Math.max(0, shellRect.height - margin * 2) / renderedViewport.height,
      1
    );
    const bottomScale = Math.min(
      Math.max(0, shellRect.width - margin * 2) / renderedViewport.width,
      bottomAvailableHeight / renderedViewport.height,
      1
    );
    const useSide = sideScale > 0 && sideScale >= bottomScale;
    const scale = Math.max(0, useSide ? sideScale : bottomScale);
    const sceneWidth = renderedViewport.width * scale;
    const sceneHeight = renderedViewport.height * scale;
    let left;
    let top;
    let sceneLeft;
    let sceneTop;
    let placement;
    if (useSide) {
      sceneLeft = margin;
      sceneTop = Math.max(margin, (shellRect.height - sceneHeight) / 2);
      left = shellRect.width - tooltipRect.width - margin;
      top = clamp(
        (shellRect.height - tooltipRect.height) / 2,
        placementBounds.minTop,
        placementBounds.maxTop
      );
      placement = "split-right";
    } else {
      sceneLeft = Math.max(margin, (shellRect.width - sceneWidth) / 2);
      sceneTop = margin;
      left = clamp(
        (shellRect.width - tooltipRect.width) / 2,
        placementBounds.minLeft,
        placementBounds.maxLeft
      );
      top = placementBounds.maxTop;
      placement = "split-bottom";
    }
    left = clamp(left, placementBounds.minLeft, placementBounds.maxLeft);
    const previousTransition = elements.viewport.style.transition;
    elements.viewport.style.transition = "none";
    renderedScale = scale;
    elements.viewport.style.left = Math.round(sceneLeft) + "px";
    elements.viewport.style.top = Math.round(sceneTop) + "px";
    elements.viewport.style.transform = "scale(" + scale + ")";
    elements.viewport.getBoundingClientRect();
    const sceneObstacles = prominentSceneObstacles(shellRect);
    const sceneOverlap = sceneObstacles.reduce(
      (area, obstacle) =>
        area +
        overlapArea(
          left,
          top,
          tooltipRect.width,
          tooltipRect.height,
          obstacle
        ),
      0
    );
    const contentOverlap = completionContentObstacles(shellRect).reduce(
      (area, obstacle) =>
        area +
        overlapArea(
          left,
          top,
          tooltipRect.width,
          tooltipRect.height,
          obstacle
      ),
      0
    );
    if (previousTransition) {
      elements.viewport.style.transition = previousTransition;
    } else {
      elements.viewport.style.removeProperty("transition");
    }
    return {
      placement,
      left,
      top,
      sceneOverlap,
      contentOverlap,
      bottomSafeArea: placementBounds.bottomSafeArea,
      rank: [0, sceneOverlap, 0, contentOverlap, 0]
    };
  }

  const allowedAttributes = new Set([
    "alt",
    "aria-current",
    "aria-describedby",
    "aria-disabled",
    "aria-expanded",
    "aria-haspopup",
    "aria-hidden",
    "aria-label",
    "aria-labelledby",
    "aria-live",
    "aria-pressed",
    "aria-selected",
    "checked",
    "clip-path",
    "clip-rule",
    "clipPathUnits",
    "cx",
    "cy",
    "d",
    "disabled",
    "dir",
    "fill",
    "fill-opacity",
    "fill-rule",
    "focusable",
    "height",
    "href",
    "id",
    "lang",
    "multiple",
    "opacity",
    "open",
    "points",
    "placeholder",
    "preserveAspectRatio",
    "r",
    "readonly",
    "role",
    "rx",
    "ry",
    "src",
    "stroke",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-opacity",
    "stroke-width",
    "selected",
    "size",
    "tabindex",
    "title",
    "transform",
    "type",
    "value",
    "viewBox",
    "width",
    "x",
    "x1",
    "x2",
    "y",
    "y1",
    "y2",
    "data-showkit-anchor",
    "data-showkit-interaction-box",
    "data-showkit-position-lock",
    "data-showkit-pseudo",
    "data-showkit-scroll-x",
    "data-showkit-scroll-y",
    "data-showkit-text",
    "data-showkit-scene-root"
  ]);
  const allowedStyleName = /^[a-z-]+$/;
  const svgTags = new Set([
    "circle",
    "clippath",
    "defs",
    "ellipse",
    "g",
    "image",
    "line",
    "path",
    "polygon",
    "polyline",
    "rect",
    "symbol",
    "use",
    "svg"
  ]);
  const svgTagNames = new Map([
    ["clippath", "clipPath"]
  ]);

  function safeSceneStyleValue(value) {
    return (
      !/@import|expression\\s*\\(/i.test(value) &&
      !/url\\s*\\(/i.test(
        value.replace(
          /url\\s*\\(\\s*["']?\\.\\/assets\\/[a-f0-9]{64}\\.(?:png|jpg|webp|avif|gif|svg)["']?\\s*\\)/gi,
          ""
        )
      )
    );
  }

  const maximumSceneDepth = 256;

  function createSceneNode(node, depth = 0) {
    if (depth > maximumSceneDepth) {
      return document.createTextNode("");
    }
    if (node.type === "text") {
      return document.createTextNode(node.text);
    }
    const element = svgTags.has(node.tag)
      ? document.createElementNS(
          "http://www.w3.org/2000/svg",
          svgTagNames.get(node.tag) ?? node.tag
        )
      : document.createElement(node.tag);
    for (const [name, value] of Object.entries(node.attributes)) {
      if (!allowedAttributes.has(name) && !/^aria-[a-z][a-z-]*$/.test(name)) continue;
      if (
        name === "value" &&
        !(
          node.tag === "input" &&
          ["button", "reset", "submit"].includes(
            String(node.attributes.type ?? "text").toLowerCase()
          ) &&
          value.length <= 50_000
        )
      ) continue;
      if (
        name === "size" &&
        !(
          node.tag === "select" &&
          /^(?:[2-9]|[1-9][0-9]|100)$/.test(value)
        )
      ) continue;
      if (name === "open" && !(node.tag === "details" && value === "")) continue;
      if (
        (name === "data-showkit-scroll-x" ||
          name === "data-showkit-scroll-y") &&
        !/^\\d{1,6}$/.test(value)
      ) continue;
      if (
        name === "data-showkit-position-lock" &&
        !["fixed", "sticky"].includes(value)
      ) continue;
      if (
        name === "src" &&
        !/^\\.\\/assets\\/[a-f0-9]{64}\\.(?:png|jpg|webp|avif|gif|svg)$/.test(value)
      ) continue;
      if (
        name === "href" &&
        !/^\\.\\/assets\\/[a-f0-9]{64}\\.(?:png|jpg|webp|avif|gif|svg)$/.test(value) &&
        !/^#[A-Za-z][A-Za-z0-9_.:-]*$/.test(value)
      ) {
        continue;
      }
      element.setAttribute(name, value);
    }
    for (const [name, value] of Object.entries(node.styles)) {
      if (allowedStyleName.test(name) && safeSceneStyleValue(value)) {
        element.style.setProperty(name, value);
      }
    }
    for (const child of node.children) {
      element.append(createSceneNode(child, depth + 1));
    }
    if (
      element.matches(
        "a, button, input, select, textarea, summary, [role='button'], [role='link']"
      )
    ) {
      element.setAttribute("tabindex", "-1");
    }
    return element;
  }

  function fitCapturedTextMetrics(element, box, scale) {
    let fitted = element.querySelector(":scope > [data-showkit-text-fit]");
    if (!fitted) {
      if (
        Array.from(element.children).some(
          (child) => !child.matches("[data-showkit-text-fit]")
        )
      ) {
        return false;
      }
      fitted = document.createElement("span");
      fitted.dataset.showkitTextFit = "";
      fitted.style.display = "inline-block";
      fitted.style.transformOrigin = "0 0";
      fitted.style.whiteSpace = "inherit";
      fitted.append(...Array.from(element.childNodes));
      element.append(fitted);
    }
    fitted.style.transform = "none";
    const range = document.createRange();
    range.selectNodeContents(fitted);
    let rendered = range.getBoundingClientRect();
    const initialRectangles = Array.from(range.getClientRects()).filter(
      (rectangle) => rectangle.width > 0 && rectangle.height > 0
    );
    const firstLineHeight = initialRectangles[0]?.height ?? 0;
    const wrappedNearCapturedSingleLine =
      initialRectangles.length > 1 &&
      firstLineHeight > 0 &&
      box.height <= firstLineHeight + 2.5 * scale &&
      !/[\\r\\n]/u.test(element.textContent || "");
    if (wrappedNearCapturedSingleLine) {
      fitted.style.whiteSpace = "pre";
      rendered = range.getBoundingClientRect();
    }
    if (rendered.width <= 0 || rendered.height <= 0) return false;
    const scaleX = box.width / rendered.width;
    const scaleY = box.height / rendered.height;
    const glyphCount = Array.from((element.textContent || "").trim()).length;
    const shortGlyph = glyphCount > 0 && glyphCount <= 3;
    const minimumScale = wrappedNearCapturedSingleLine
      ? 0.8
      : shortGlyph
        ? 0.5
        : 0.67;
    const maximumScale = wrappedNearCapturedSingleLine
      ? 1.25
      : shortGlyph
        ? 2
        : 1.5;
    if (
      scaleX < minimumScale ||
      scaleX > maximumScale ||
      scaleY < minimumScale ||
      scaleY > maximumScale
    ) {
      return false;
    }
    const fittedBox = fitted.getBoundingClientRect();
    const translateX =
      (box.left -
        fittedBox.left -
        scaleX * (rendered.left - fittedBox.left)) /
      scale;
    const translateY =
      (box.top -
        fittedBox.top -
        scaleY * (rendered.top - fittedBox.top)) /
      scale;
    const maximumTranslation = wrappedNearCapturedSingleLine
      ? 8
      : shortGlyph
        ? 16
        : 12;
    if (
      Math.abs(translateX) > maximumTranslation ||
      Math.abs(translateY) > maximumTranslation
    ) {
      return false;
    }
    fitted.style.transform =
      "translate(" +
      translateX +
      "px," +
      translateY +
      "px) scale(" +
      scaleX +
      "," +
      scaleY +
      ")";
    return true;
  }

  function suppressConflictingOverlayPlaceholders() {
    let suppressedCount = 0;
    const isVisuallyClipped = (element) => {
      let current = element.parentElement;
      while (current && current !== elements.viewport) {
        const style = getComputedStyle(current);
        const box = current.getBoundingClientRect();
        const clipsOverflow = [style.overflow, style.overflowX, style.overflowY]
          .some((value) => value === "hidden" || value === "clip");
        if (
          box.width <= 2 &&
          box.height <= 2 &&
          clipsOverflow &&
          style.clipPath !== "none"
        ) {
          return true;
        }
        current = current.parentElement;
      }
      return false;
    };
    const visibleTextFragments = Array.from(
      elements.viewport.querySelectorAll("[data-showkit-text]")
    ).filter((element) => {
      if (!element.textContent?.trim() || isVisuallyClipped(element)) {
        return false;
      }
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    });
    for (const control of elements.viewport.querySelectorAll(
      "input[placeholder], textarea[placeholder]"
    )) {
      if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement)) {
        continue;
      }
      const color = getComputedStyle(control).color.replace(/\s+/g, "");
      if (!/rgba\([^)]*,0(?:\.0+)?\)$/i.test(color)) continue;
      const box = control.getBoundingClientRect();
      const conflicts = visibleTextFragments.some((fragment) => {
        const textBox = fragment.getBoundingClientRect();
        return (
          Math.min(box.right, textBox.right) - Math.max(box.left, textBox.left) > 2 &&
          Math.min(box.bottom, textBox.bottom) - Math.max(box.top, textBox.top) > 2
        );
      });
      if (!conflicts) continue;
      control.removeAttribute("placeholder");
      suppressedCount += 1;
    }
    elements.viewport.dataset.suppressedPlaceholderCount = String(
      suppressedCount
    );
  }

  function auditSceneTypography() {
    suppressConflictingOverlayPlaceholders();
    const scale = Math.max(renderedScale || 1, 0.0001);
    let redactionFitCount = 0;
    for (const element of elements.viewport.querySelectorAll(
      '[data-showkit-text="redacted"]'
    )) {
      const text = Array.from(element.textContent || "");
      if (text.length < 2) continue;
      const box = element.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(element);
      const rendered = range.getBoundingClientRect();
      const currentLetterSpacing = Number.parseFloat(
        getComputedStyle(element).letterSpacing
      );
      const adjustment =
        (box.width - rendered.width) / scale / (text.length - 1);
      if (Math.abs(adjustment) <= 0.01) continue;
      element.style.letterSpacing =
        ((Number.isFinite(currentLetterSpacing) ? currentLetterSpacing : 0) +
          adjustment) +
        "px";
      redactionFitCount += 1;
    }
    let metricFitCount = 0;
    for (const element of elements.viewport.querySelectorAll(
      "[data-showkit-text]"
    )) {
      const box = element.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(element);
      const rendered = range.getBoundingClientRect();
      const delta = Math.max(
        Math.abs(rendered.left - box.left),
        Math.abs(rendered.top - box.top),
        Math.abs(rendered.width - box.width),
        Math.abs(rendered.height - box.height)
      ) / scale;
      if (
        delta > 4 &&
        fitCapturedTextMetrics(element, box, scale)
      ) {
        metricFitCount += 1;
      }
    }
    const fragments = Array.from(
      elements.viewport.querySelectorAll("[data-showkit-text]")
    ).map((element) => {
      const box = element.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(
        element.querySelector(":scope > [data-showkit-text-fit]") ?? element
      );
      const rectangles = Array.from(range.getClientRects()).filter(
        (rectangle) => rectangle.width > 0 && rectangle.height > 0
      );
      const lineRectangles = rectangles.reduce((lines, rectangle) => {
        const center = rectangle.top + rectangle.height / 2;
        const line = lines.find(
          (candidate) =>
            center >= candidate.top - 0.75 &&
            center <= candidate.bottom + 0.75
        );
        if (!line) {
          lines.push({
            top: rectangle.top,
            bottom: rectangle.bottom
          });
          return lines;
        }
        line.top = Math.min(line.top, rectangle.top);
        line.bottom = Math.max(line.bottom, rectangle.bottom);
        return lines;
      }, []);
      const rendered = range.getBoundingClientRect();
      return {
        element,
        box,
        rectangles,
        rendered,
        lineCount: lineRectangles.length
      };
    });
    let metricDriftCount = 0;
    let multiLineFragmentCount = 0;
    let redactedMultiLineFragmentCount = 0;
    let boundedMultiLineFragmentCount = 0;
    for (const fragment of fragments) {
      const fragmentText = fragment.element.textContent || "";
      const isConfirmedRedactionMask =
        fragment.element.getAttribute("data-showkit-text") === "redacted" ||
        (demo.textRedactionActive === true &&
          fragment.element.getAttribute("data-showkit-text") === "" &&
          fragmentText.replace(/\\s/gu, "").length >= 2 &&
          /^[•\\s]+$/u.test(fragmentText));
      const delta = Math.max(
        Math.abs(fragment.rendered.left - fragment.box.left),
        Math.abs(fragment.rendered.top - fragment.box.top),
        Math.abs(fragment.rendered.width - fragment.box.width),
        Math.abs(fragment.rendered.height - fragment.box.height)
      ) / scale;
      if (fragment.lineCount !== 1) {
        if (fragment.lineCount > 1 && isConfirmedRedactionMask) {
          redactedMultiLineFragmentCount += 1;
        } else if (
          fragment.lineCount > 1 &&
          delta <= 4 &&
          !/[\\r\\n]/u.test(fragmentText)
        ) {
          boundedMultiLineFragmentCount += 1;
        } else {
          multiLineFragmentCount += 1;
        }
      }
      if (delta > 4) metricDriftCount += 1;
    }
    let collisionCount = 0;
    const overlapExtent = (left, right) => ({
      width: Math.max(
        0,
        Math.min(left.right, right.right) - Math.max(left.left, right.left)
      ),
      height: Math.max(
        0,
        Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top)
      )
    });
    for (let leftIndex = 0; leftIndex < fragments.length; leftIndex += 1) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < fragments.length;
        rightIndex += 1
      ) {
        const left = fragments[leftIndex];
        const right = fragments[rightIndex];
        const renderedOverlap = overlapExtent(left.rendered, right.rendered);
        const capturedOverlap = overlapExtent(left.box, right.box);
        const newHorizontalOverlap =
          (renderedOverlap.width - capturedOverlap.width) / scale;
        const newVerticalOverlap =
          (renderedOverlap.height - capturedOverlap.height) / scale;
        if (
          renderedOverlap.width > 0 &&
          renderedOverlap.height > 0 &&
          Math.max(newHorizontalOverlap, newVerticalOverlap) > 4
        ) {
          collisionCount += 1;
        }
      }
    }
    const failed =
      metricDriftCount > 0 ||
      multiLineFragmentCount > 0 ||
      collisionCount > 0;
    elements.viewport.dataset.textLayout = failed ? "failed" : "checked";
    elements.viewport.dataset.textMetricDriftCount = String(metricDriftCount);
    elements.viewport.dataset.textMultiLineFragmentCount = String(
      multiLineFragmentCount
    );
    elements.viewport.dataset.redactedMultiLineFragmentCount = String(
      redactedMultiLineFragmentCount
    );
    elements.viewport.dataset.boundedMultiLineFragmentCount = String(
      boundedMultiLineFragmentCount
    );
    elements.viewport.dataset.textCollisionCount = String(collisionCount);
    elements.viewport.dataset.redactionFitCount = String(redactionFitCount);
    elements.viewport.dataset.textMetricFitCount = String(metricFitCount);
  }

  function restoreNestedScrollPositions() {
    for (const element of elements.content.querySelectorAll(
      "[data-showkit-scroll-x], [data-showkit-scroll-y]"
    )) {
      if (!(element instanceof HTMLElement)) continue;
      const x = Number.parseInt(
        element.getAttribute("data-showkit-scroll-x") ?? "0",
        10
      );
      const y = Number.parseInt(
        element.getAttribute("data-showkit-scroll-y") ?? "0",
        10
      );
      if (Number.isFinite(x)) element.scrollLeft = Math.max(0, x);
      if (Number.isFinite(y)) element.scrollTop = Math.max(0, y);
    }
  }

  function updatePositionLocks() {
    for (const element of elements.content.querySelectorAll(
      "[data-showkit-position-lock]"
    )) {
      if (!(element instanceof HTMLElement || element instanceof SVGElement)) {
        continue;
      }
      let x = elements.scroll.scrollLeft - renderedScroll.x;
      let y = elements.scroll.scrollTop - renderedScroll.y;
      let ancestor = element.parentElement;
      while (ancestor && ancestor !== elements.content) {
        const initialX = Number.parseInt(
          ancestor.getAttribute("data-showkit-scroll-x") ?? "0",
          10
        );
        const initialY = Number.parseInt(
          ancestor.getAttribute("data-showkit-scroll-y") ?? "0",
          10
        );
        if (ancestor.hasAttribute("data-showkit-scroll-x")) {
          x += ancestor.scrollLeft - (Number.isFinite(initialX) ? initialX : 0);
        }
        if (ancestor.hasAttribute("data-showkit-scroll-y")) {
          y += ancestor.scrollTop - (Number.isFinite(initialY) ? initialY : 0);
        }
        ancestor = ancestor.parentElement;
      }
      element.style.translate = Math.round(x) + "px " + Math.round(y) + "px";
    }
  }

  function replaceScene(scene) {
    elements.viewport.dataset.textLayout = "pending";
    sceneFontStyle.textContent = (scene.fontFaces ?? [])
      .filter(
        (face) =>
          /^[^{};@<>"'\\\\\\r\\n]{1,120}$/.test(face.family) &&
          /^(?:normal|italic|oblique)$/.test(face.style) &&
          /^(?:normal|bold|[1-9]00(?: [1-9]00)?)$/.test(face.weight) &&
          /^(?:normal|(?:ultra-|extra-|semi-)?(?:condensed|expanded)|\\d{1,3}%)$/.test(
            face.stretch
          ) &&
          /^(?:auto|block|swap|fallback|optional)$/.test(face.display) &&
          /^\\.\\/assets\\/[a-f0-9]{64}\\.woff2$/.test(face.src) &&
          (!face.unicodeRange ||
            /^U\\+[0-9A-F?*]{1,6}(?:\\s*-\\s*[0-9A-F?*]{1,6})?(?:\\s*,\\s*U\\+[0-9A-F?*]{1,6}(?:\\s*-\\s*[0-9A-F?*]{1,6})?)*$/i.test(
              face.unicodeRange
            ))
      )
      .map(
        (face) =>
          "@font-face{" +
          "font-family:" + JSON.stringify(face.family) + ";" +
          "font-style:" + face.style + ";" +
          "font-weight:" + face.weight + ";" +
          "font-stretch:" + face.stretch + ";" +
          "font-display:" + face.display + ";" +
          (face.unicodeRange ? "unicode-range:" + face.unicodeRange + ";" : "") +
          "src:url(" + JSON.stringify(face.src) + ") format(\\"woff2\\");" +
          "}"
      )
      .join("\\n");
    elements.content.style.width = renderedScroll.width + "px";
    elements.content.style.height = renderedScroll.height + "px";
    elements.content.replaceChildren(...scene.nodes.map(createSceneNode));
    elements.scroll.scrollLeft = renderedScroll.x;
    elements.scroll.scrollTop = renderedScroll.y;
    restoreNestedScrollPositions();
    updatePositionLocks();
    sceneLayoutObserver.disconnect();
    for (const element of elements.content.querySelectorAll("*")) {
      sceneLayoutObserver.observe(element);
    }
    if (document.fonts) {
      document.fonts.ready.then(() => {
        scaleScene();
        requestAnimationFrame(() => {
          auditSceneTypography();
          positionOverlay();
        });
      });
    } else {
      requestAnimationFrame(auditSceneTypography);
    }
  }

  function positionOverlay() {
    const shellRect = elements.shell.getBoundingClientRect();
    if (overlayRevealAt > 0 && performance.now() >= overlayRevealAt) {
      overlayRevealAt = 0;
      window.clearTimeout(overlayRevealTimer);
      overlayRevealTimer = 0;
      delete elements.shell.dataset.cameraTransitioning;
    }
    if (current < 0) {
      elements.stepBackdrop.hidden = true;
      elements.hotspot.hidden = true;
      elements.tooltip.hidden = true;
      return;
    }
    const step = demo.steps[current];
    if (!step) {
      elements.stepBackdrop.hidden = true;
      elements.tooltip.hidden = false;
      elements.tooltip.style.visibility = "hidden";
      elements.tooltip.dataset.complete = "true";
      elements.tooltip.style.removeProperty("width");
      let tooltipRect = elements.tooltip.getBoundingClientRect();
      let sceneObstacles = prominentSceneObstacles(shellRect);
      let selected = completionSplitLayout
        ? splitCompletionPlacement(shellRect, tooltipRect)
        : selectCompletionPlacement(shellRect, tooltipRect, sceneObstacles);
      if (
        !completionSplitLayout &&
        selected.sceneOverlap > 0 &&
        sceneObstacles.length > 0
      ) {
        const minimumWidth = Math.min(220, shellRect.width - 24);
        const widestSide = Math.max(
          ...sceneObstacles.flatMap((obstacle) => [
            obstacle.left - 30,
            shellRect.width - obstacle.right - 30
          ])
        );
        if (widestSide >= minimumWidth && widestSide < tooltipRect.width) {
          elements.tooltip.style.width = Math.floor(widestSide) + "px";
          tooltipRect = elements.tooltip.getBoundingClientRect();
          selected = selectCompletionPlacement(
            shellRect,
            tooltipRect,
            sceneObstacles
          );
        }
      }
      const contentObstacles = completionContentObstacles(shellRect);
      if (
        (selected.sceneOverlap > 0 && sceneObstacles.length > 0) ||
        (selected.contentOverlap > 0 && contentObstacles.length > 0)
      ) {
        completionSplitLayout = true;
        elements.tooltip.style.removeProperty("width");
        tooltipRect = elements.tooltip.getBoundingClientRect();
        selected = splitCompletionPlacement(shellRect, tooltipRect);
        sceneObstacles = prominentSceneObstacles(shellRect);
      }
      elements.tooltip.dataset.placement = selected.placement;
      elements.tooltip.dataset.prominentObstacleCount = String(
        sceneObstacles.length
      );
      elements.tooltip.dataset.sceneOverlap = String(selected.sceneOverlap);
      elements.tooltip.dataset.contentOverlap = String(
        selected.contentOverlap
      );
      elements.tooltip.dataset.bottomSafeArea = String(
        selected.bottomSafeArea
      );
      elements.tooltip.style.left = selected.left + "px";
      elements.tooltip.style.top = selected.top + "px";
      elements.tooltip.style.visibility = "visible";
      return;
    }
    elements.tooltip.dataset.complete = "false";
    elements.tooltip.dataset.prominentObstacleCount = "0";
    elements.tooltip.dataset.sceneOverlap = "0";
    elements.tooltip.dataset.contentOverlap = "0";
    elements.tooltip.style.removeProperty("width");
    const anchor = elements.viewport.querySelector('[data-showkit-anchor="' + CSS.escape(step.anchorId) + '"]');
    if (!anchor) {
      elements.stepBackdrop.hidden = true;
      elements.hotspot.hidden = true;
      elements.tooltip.hidden = true;
      return;
    }
    const interactionElement = visibleInteractionElement(anchor);
    const interactionRect = interactionElement.getBoundingClientRect();
    const sceneRect = intersectRect(
      elements.viewport.getBoundingClientRect(),
      shellRect
    );
    const anchorRect = sceneRect
      ? intersectRect(interactionRect, sceneRect)
      : null;
    if (!anchorRect) {
      elements.stepBackdrop.hidden = true;
      elements.hotspot.hidden = true;
      elements.tooltip.hidden = true;
      return;
    }
    elements.hotspot.hidden = false;
    const left = anchorRect.left - shellRect.left;
    const top = anchorRect.top - shellRect.top;
    const hotspotWidth = Math.max(24, anchorRect.width);
    const hotspotHeight = Math.max(24, anchorRect.height);
    const hotspotLeft = clamp(
      left - (hotspotWidth - anchorRect.width) / 2,
      0,
      Math.max(0, shellRect.width - hotspotWidth)
    );
    const hotspotTop = clamp(
      top - (hotspotHeight - anchorRect.height) / 2,
      0,
      Math.max(0, shellRect.height - hotspotHeight)
    );
    elements.hotspot.style.left = hotspotLeft + "px";
    elements.hotspot.style.top = hotspotTop + "px";
    elements.hotspot.style.width = hotspotWidth + "px";
    elements.hotspot.style.height = hotspotHeight + "px";
    const anchorRadius = Number.parseFloat(
      getComputedStyle(interactionElement).borderTopLeftRadius
    );
    const renderedRadius = Number.isFinite(anchorRadius)
      ? Math.min(
          anchorRect.width / 2,
          anchorRect.height / 2,
          anchorRadius * renderedScale
        )
      : 7;
    elements.hotspot.style.borderRadius = Math.max(0, renderedRadius) + "px";
    if (step.tooltip.backdrop !== "off") {
      const viewportRect = elements.viewport.getBoundingClientRect();
      const transform = new DOMMatrixReadOnly(
        getComputedStyle(elements.viewport).transform
      );
      const scaleX = Math.max(0.0001, Math.abs(transform.a));
      const scaleY = Math.max(0.0001, Math.abs(transform.d));
      const backdropWidth = interactionRect.width / scaleX;
      const backdropHeight = interactionRect.height / scaleY;
      elements.stepBackdrop.style.left =
        (interactionRect.left - viewportRect.left) / scaleX +
        elements.scroll.scrollLeft +
        "px";
      elements.stepBackdrop.style.top =
        (interactionRect.top - viewportRect.top) / scaleY +
        elements.scroll.scrollTop +
        "px";
      elements.stepBackdrop.style.width = backdropWidth + "px";
      elements.stepBackdrop.style.height = backdropHeight + "px";
      elements.stepBackdrop.style.borderRadius =
        Math.max(
          0,
          Number.isFinite(anchorRadius)
            ? Math.min(
                backdropWidth / 2,
                backdropHeight / 2,
                anchorRadius
              )
            : 7
        ) + "px";
      elements.stepBackdrop.style.visibility = "visible";
      elements.stepBackdrop.hidden = false;
    } else {
      elements.stepBackdrop.hidden = true;
    }

    elements.tooltip.style.visibility = "hidden";
    elements.tooltip.hidden = false;
    const tooltipRect = elements.tooltip.getBoundingClientRect();
    const scenePlacementBounds = sceneTooltipPlacementBounds(
      shellRect,
      tooltipRect,
      12
    );
    const gap = 18;
    const candidates = {
      right: [hotspotLeft + hotspotWidth + gap, hotspotTop + hotspotHeight / 2 - tooltipRect.height / 2],
      left: [hotspotLeft - tooltipRect.width - gap, hotspotTop + hotspotHeight / 2 - tooltipRect.height / 2],
      bottom: [hotspotLeft + hotspotWidth / 2 - tooltipRect.width / 2, hotspotTop + hotspotHeight + gap],
      top: [hotspotLeft + hotspotWidth / 2 - tooltipRect.width / 2, hotspotTop - tooltipRect.height - gap]
    };
    const preferred = step.tooltip.placement === "auto"
      ? ["right", "left", "bottom", "top"]
      : [step.tooltip.placement, "right", "left", "bottom", "top"];
    const chromeObstacles = activeChromeObstacles(shellRect);
    const sceneObstacles = prominentSceneObstacles(shellRect);
    const obstacleCandidates = (placement) =>
      sceneObstacles.map((obstacle) => {
        if (placement === "right") {
          return [
            obstacle.right + gap,
            hotspotTop + hotspotHeight / 2 - tooltipRect.height / 2
          ];
        }
        if (placement === "left") {
          return [
            obstacle.left - tooltipRect.width - gap,
            hotspotTop + hotspotHeight / 2 - tooltipRect.height / 2
          ];
        }
        if (placement === "bottom") {
          return [
            hotspotLeft + hotspotWidth / 2 - tooltipRect.width / 2,
            obstacle.bottom + gap
          ];
        }
        return [
          hotspotLeft + hotspotWidth / 2 - tooltipRect.width / 2,
          obstacle.top - tooltipRect.height - gap
        ];
      });
    const betterRank = (candidate, current) => {
      for (let index = 0; index < candidate.length; index += 1) {
        if (candidate[index] === current[index]) continue;
        return candidate[index] < current[index];
      }
      return false;
    };
    const selectStepPlacement = (placementBounds) => {
      let selected = {
        placement: "right",
        left: placementBounds.minLeft,
        top: placementBounds.minTop,
        targetOverlap: Number.POSITIVE_INFINITY,
        sceneOverlap: Number.POSITIVE_INFINITY,
        chromeOverlap: Number.POSITIVE_INFINITY,
        bottomSafeArea: placementBounds.bottomSafeArea,
        rank: Array(8).fill(Number.POSITIVE_INFINITY)
      };
      for (const [preferenceIndex, placement] of [...new Set(preferred)].entries()) {
        const placementCandidates = [
          candidates[placement],
          ...obstacleCandidates(placement)
        ];
        for (const [variantIndex, candidate] of placementCandidates.entries()) {
          const candidateLeft = clamp(
            candidate[0],
            placementBounds.minLeft,
            placementBounds.maxLeft
          );
          const candidateTop = clamp(
            candidate[1],
            placementBounds.minTop,
            placementBounds.maxTop
          );
          const overflow =
            Math.max(0, placementBounds.minLeft - candidate[0]) +
            Math.max(0, placementBounds.minTop - candidate[1]) +
            Math.max(0, candidate[0] - placementBounds.maxLeft) +
            Math.max(0, candidate[1] - placementBounds.maxTop);
          const targetOverlap = overlapArea(
            candidateLeft,
            candidateTop,
            tooltipRect.width,
            tooltipRect.height,
            {
              left: hotspotLeft,
              top: hotspotTop,
              right: hotspotLeft + hotspotWidth,
              bottom: hotspotTop + hotspotHeight
            }
          );
          const chromeOverlap = chromeObstacles.reduce(
            (area, obstacle) =>
              area +
              overlapArea(
                candidateLeft,
                candidateTop,
                tooltipRect.width,
                tooltipRect.height,
                obstacle
              ),
            0
          );
          const sceneOverlap = sceneObstacles.reduce(
            (area, obstacle) =>
              area +
              overlapArea(
                candidateLeft,
                candidateTop,
                tooltipRect.width,
                tooltipRect.height,
                obstacle
              ),
            0
          );
          const rank = [
            targetOverlap === 0 ? 0 : 1,
            targetOverlap,
            sceneOverlap === 0 ? 0 : 1,
            sceneOverlap,
            chromeOverlap,
            overflow,
            preferenceIndex,
            variantIndex
          ];
          if (betterRank(rank, selected.rank)) {
            selected = {
              placement,
              left: candidateLeft,
              top: candidateTop,
              targetOverlap,
              sceneOverlap,
              chromeOverlap,
              bottomSafeArea: placementBounds.bottomSafeArea,
              rank
            };
          }
        }
      }
      return selected;
    };
    let selected = selectStepPlacement(scenePlacementBounds);
    if (
      selected.targetOverlap > 0 ||
      selected.sceneOverlap > 0 ||
      selected.chromeOverlap > 0
    ) {
      const shellPlacementBounds = tooltipPlacementBounds(
        shellRect,
        tooltipRect
      );
      const shellSelected = selectStepPlacement(shellPlacementBounds);
      if (betterRank(shellSelected.rank, selected.rank)) {
        selected = shellSelected;
      }
    }
    elements.tooltip.dataset.placement = selected.placement;
    elements.tooltip.dataset.targetOverlap = String(
      selected.targetOverlap ?? 0
    );
    elements.tooltip.dataset.sceneOverlap = String(
      selected.sceneOverlap ?? 0
    );
    elements.tooltip.dataset.bottomSafeArea = String(
      selected.bottomSafeArea
    );
    elements.tooltip.dataset.prominentObstacleCount = String(
      sceneObstacles.length
    );
    elements.tooltip.style.left = selected.left + "px";
    elements.tooltip.style.top = selected.top + "px";
    elements.tooltip.style.visibility = "visible";
  }

  function clearCameraTransition() {
    window.clearTimeout(overlayRevealTimer);
    overlayRevealTimer = 0;
    overlayRevealAt = 0;
    delete elements.shell.dataset.cameraTransitioning;
    positionOverlay();
  }

  function finishCameraTransition() {
    overlayRevealTimer = 0;
    const remaining = overlayRevealAt - performance.now();
    if (remaining > 0) {
      overlayRevealTimer = window.setTimeout(
        finishCameraTransition,
        remaining + 24
      );
      return;
    }
    clearCameraTransition();
  }

  function finishViewportCameraTransition(event) {
    if (
      event.target !== elements.viewport ||
      !["left", "top", "transform"].includes(event.propertyName) ||
      elements.shell.dataset.cameraTransitioning !== "true"
    ) return;
    clearCameraTransition();
  }

  elements.viewport.addEventListener(
    "transitionend",
    finishViewportCameraTransition
  );
  elements.viewport.addEventListener(
    "transitioncancel",
    finishViewportCameraTransition
  );
  elements.shell.addEventListener("animationend", (event) => {
    if (
      event.target !== elements.shell ||
      event.animationName !== "showkit-camera-transition-clock" ||
      elements.shell.dataset.cameraTransitioning !== "true"
    ) return;
    clearCameraTransition();
  });

  function scheduleOverlayPosition(duration = 180) {
    window.cancelAnimationFrame(overlayFrame);
    window.clearTimeout(overlayTimer);
    overlayTrackUntil = Math.max(
      overlayTrackUntil,
      performance.now() + duration
    );
    const track = () => {
      positionOverlay();
      if (performance.now() < overlayTrackUntil) {
        overlayFrame = window.requestAnimationFrame(track);
      }
    };
    overlayFrame = window.requestAnimationFrame(track);
    overlayTimer = window.setTimeout(positionOverlay, duration + 24);
  }

  function focusZoomFactor(step, shellWidth, shellHeight) {
    if (
      camera !== "focus" ||
      !step?.target ||
      shellWidth < 640 ||
      shellHeight < 360
    ) return 1;
    const fittedHeight =
      renderedViewport.height *
      Math.min(shellWidth / renderedViewport.width, 1);
    if (fittedHeight > shellHeight * 1.08) return 1;
    const bounds = step.target.bounds;
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    const compactTarget =
      bounds.width <= 0.18 &&
      bounds.height <= 0.16 &&
      bounds.width * bounds.height <= 0.018;
    const nearEdge =
      centerX < 0.22 ||
      centerX > 0.78 ||
      centerY < 0.14 ||
      centerY > 0.86;
    return compactTarget && nearEdge ? 1.18 : 1;
  }

  function focusedAxisPosition(center, low, high) {
    if (center < low) return 0.28;
    if (center > high) return 0.72;
    return 0.5;
  }

  function fittedAxisPosition(desired, shellSize, contentSize) {
    if (contentSize <= shellSize) return (shellSize - contentSize) / 2;
    return clamp(desired, shellSize - contentSize, 0);
  }

  function scaleScene() {
    const overlayMode = chrome.mode === "overlay";
    completionSplitLayout = false;
    const previousLeft = elements.viewport.style.left;
    const previousTop = elements.viewport.style.top;
    const previousTransform = elements.viewport.style.transform;
    elements.shell.scrollTop = 0;
    elements.shell.scrollLeft = 0;
    elements.viewport.style.width = renderedViewport.width + "px";
    elements.viewport.style.height = renderedViewport.height + "px";
    let scale;
    let cameraZoom = 1;
    if (overlayMode) {
      elements.stage.style.maxWidth = "none";
      elements.frame.style.removeProperty("--stage-max-width");
      elements.shell.style.height = "100%";
      const shellWidth = elements.shell.clientWidth;
      const shellHeight = elements.shell.clientHeight;
      const step = current >= 0 && current < demo.steps.length
        ? demo.steps[current]
        : undefined;
      const baseScale = Math.min(shellWidth / renderedViewport.width, 1);
      cameraZoom = focusZoomFactor(step, shellWidth, shellHeight);
      scale = baseScale * cameraZoom;
      const contentWidth = renderedViewport.width * scale;
      const contentHeight = renderedViewport.height * scale;
      let desiredLeft = (shellWidth - contentWidth) / 2;
      let desiredTop = (shellHeight - contentHeight) / 2;
      if (step) {
        const target = step.target.bounds;
        const centerX = target.x + target.width / 2;
        const centerY = target.y + target.height / 2;
        const focusX = focusedAxisPosition(centerX, 0.34, 0.66);
        const focusY = focusedAxisPosition(centerY, 0.3, 0.7);
        if (cameraZoom > 1) {
          desiredLeft =
            focusX * shellWidth - centerX * renderedViewport.width * scale;
          desiredTop =
            focusY * shellHeight - centerY * renderedViewport.height * scale;
        } else if (contentHeight > shellHeight) {
          desiredTop =
            shellHeight / 2 - centerY * renderedViewport.height * scale;
        }
      }
      elements.viewport.style.left = Math.round(
        fittedAxisPosition(desiredLeft, shellWidth, contentWidth)
      ) + "px";
      elements.viewport.style.top = Math.round(
        fittedAxisPosition(desiredTop, shellHeight, contentHeight)
      ) + "px";
    } else {
      const reservedHeight =
        elements.frameHeader.getBoundingClientRect().height +
        elements.frameFooter.getBoundingClientRect().height +
        60;
      const availableHeight = Math.max(280, window.innerHeight - reservedHeight);
      const aspect = renderedViewport.width / renderedViewport.height;
      const viewportLimitedWidth = Math.round(availableHeight * aspect);
      const stageMaxWidth = Math.max(320, viewportLimitedWidth);
      elements.stage.style.maxWidth = stageMaxWidth + "px";
      elements.frame.style.setProperty("--stage-max-width", stageMaxWidth + "px");
      scale = elements.shell.clientWidth / renderedViewport.width;
      const naturalHeight = renderedViewport.height * scale;
      const minimumInteractiveHeight = Math.min(520, availableHeight);
      elements.shell.style.height =
        Math.round(Math.max(naturalHeight, minimumInteractiveHeight)) + "px";
      elements.viewport.style.left = "0px";
      elements.viewport.style.top = "0px";
    }
    renderedScale = scale;
    elements.viewport.dataset.cameraMode = camera;
    elements.viewport.dataset.camera = cameraZoom > 1 ? "focus" : "fit";
    elements.viewport.dataset.cameraZoom = cameraZoom.toFixed(2);
    elements.viewport.style.transform = "scale(" + scale + ")";
    const sceneMoves =
      previousLeft !== elements.viewport.style.left ||
      previousTop !== elements.viewport.style.top ||
      previousTransform !== elements.viewport.style.transform;
    if (
      sceneMoves &&
      current >= 0 &&
      camera === "focus" &&
      animatedCameraRevision !== renderRevision &&
      !document.body.hasAttribute("data-initial-render") &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      animatedCameraRevision = renderRevision;
      overlayRevealAt = performance.now() + 650;
      elements.shell.dataset.cameraTransitioning = "true";
      window.clearTimeout(overlayRevealTimer);
      overlayRevealTimer = window.setTimeout(
        finishCameraTransition,
        Math.max(0, overlayRevealAt - performance.now()) + 24
      );
    }
    updatePositionLocks();
    positionOverlay();
    scheduleOverlayPosition(camera === "focus" ? 700 : 220);
  }

  function renderCompletionActions() {
    elements.completionActions.replaceChildren();
    if (!demo.completion) {
      elements.tooltip.dataset.completionActionCount = "0";
      elements.completionActions.hidden = true;
      return;
    }
    elements.tooltip.dataset.completionActionCount = String(
      demo.completion.actions.length
    );
    for (const action of demo.completion.actions) {
      const link = document.createElement("a");
      link.className = "completion-action";
      link.dataset.style = action.style;
      link.textContent = action.label;
      link.href = action.href;
      link.rel = "noopener noreferrer";
      elements.completionActions.append(link);
    }
    elements.completionActions.hidden = false;
  }

  function render() {
    renderRevision += 1;
    const welcome = hasWelcome && current < 0;
    const complete = current >= demo.steps.length;
    const step = welcome
      ? demo.steps[0]
      : complete
        ? demo.terminal
        : demo.steps[current];
    renderedViewport = step.viewport;
    const stepScroll = step.scroll ?? {
      x: 0,
      y: 0,
      width: renderedViewport.width,
      height: renderedViewport.height
    };
    const scrollWidth = Math.max(
      renderedViewport.width,
      Math.round(Number(stepScroll.width) || renderedViewport.width)
    );
    const scrollHeight = Math.max(
      renderedViewport.height,
      Math.round(Number(stepScroll.height) || renderedViewport.height)
    );
    renderedScroll = {
      x: clamp(
        Math.round(Number(stepScroll.x) || 0),
        0,
        Math.max(0, scrollWidth - renderedViewport.width)
      ),
      y: clamp(
        Math.round(Number(stepScroll.y) || 0),
        0,
        Math.max(0, scrollHeight - renderedViewport.height)
      ),
      width: scrollWidth,
      height: scrollHeight
    };
    elements.viewport.style.width = renderedViewport.width + "px";
    elements.viewport.style.height = renderedViewport.height + "px";
    replaceScene(step);
    document.body.dataset.playerState = welcome
      ? "welcome"
      : complete
        ? "complete"
        : "step";
    elements.welcome.hidden = !welcome;
    elements.completionActions.hidden = true;
    elements.completionActions.replaceChildren();
    elements.cta.hidden = true;
    elements.stepBackdrop.hidden = true;
    elements.restart.hidden =
      !complete || elements.restart.dataset.chromeHidden === "true";

    if (welcome) {
      elements.hotspot.hidden = true;
      elements.tooltip.hidden = true;
      elements.back.hidden = true;
      elements.next.hidden = true;
      elements.announcer.textContent = demo.welcome.title;
      updateTooltipControlVisibility();
      scaleScene();
      return;
    }

    elements.hotspot.hidden = complete;
    elements.tooltip.hidden = false;
    elements.next.hidden = complete || navigation !== "controls";
    elements.back.hidden =
      navigation !== "controls" || elements.back.dataset.chromeHidden === "true";
    elements.back.disabled = !hasWelcome && current === 0;
    elements.count.textContent = complete
      ? "Complete"
      : "Step " + (current + 1) + " of " + demo.steps.length;
    elements.progress.style.width =
      ((complete ? demo.steps.length : current + 1) / demo.steps.length) * 100 + "%";

    if (complete) {
      elements.title.textContent = demo.completion?.title ?? "Demo complete";
      elements.body.textContent =
        demo.completion?.body ?? "You reached the end of this demo.";
      elements.announcer.textContent =
        demo.completion?.title ?? "Demo complete";
      renderCompletionActions();
      if (
        !demo.completion &&
        demo.cta &&
        elements.cta.dataset.chromeHidden !== "true"
      ) {
        elements.cta.hidden = false;
        elements.cta.textContent = demo.cta.label;
        elements.cta.href = demo.cta.href;
        elements.cta.rel = "noopener noreferrer";
      }
    } else {
      elements.stepBackdrop.dataset.strength = step.tooltip.backdrop;
      elements.stepBackdrop.hidden = step.tooltip.backdrop === "off";
      elements.stepBackdrop.style.visibility = "hidden";
      elements.title.textContent = step.tooltip.title;
      elements.body.textContent = step.tooltip.body;
      elements.hotspot.setAttribute(
        "aria-label",
        "Select " + step.target.name + ": " + step.tooltip.title
      );
      elements.hotspot.setAttribute("aria-describedby", "tooltip-body");
      elements.announcer.textContent =
        "Step " + (current + 1) + ": " + step.tooltip.title;
    }
    updateTooltipControlVisibility();
    scaleScene();
    if (
      complete &&
      (document.activeElement === elements.hotspot ||
        document.activeElement === elements.next)
    ) {
      focusCompletionControl();
    } else if (
      !complete &&
      document.activeElement === elements.next &&
      elements.next.hidden
    ) {
      elements.hotspot.focus({ preventScroll: true });
    }
  }

  function focusCompletionControl() {
    const target = [
      elements.completionActions.querySelector("a"),
      elements.restart,
      elements.back,
      elements.cta
    ].find(
      (element) => element && !element.hidden && !element.disabled
    );
    target?.focus({ preventScroll: true });
  }

  function advance(moveFocus) {
    if (current < 0) {
      document.body.removeAttribute("data-initial-render");
      current = 0;
      render();
      if (moveFocus) elements.hotspot.focus({ preventScroll: true });
      return;
    }
    if (current < demo.steps.length) {
      document.body.removeAttribute("data-initial-render");
      current += 1;
      render();
      if (moveFocus) {
        if (current >= demo.steps.length) {
          focusCompletionControl();
        } else {
          elements.hotspot.focus({ preventScroll: true });
        }
      }
    }
  }

  elements.hotspot.addEventListener("click", () => {
    if (
      navigation === "hotspots" ||
      demo.steps[current]?.advance === "hotspot"
    ) {
      advance(true);
    }
  });
  elements.next.addEventListener("click", () => advance(true));
  elements.back.addEventListener("click", () => {
    current = Math.max(firstState, current - 1);
    render();
    if (current < 0) elements.welcomeAction.focus({ preventScroll: true });
    else elements.hotspot.focus({ preventScroll: true });
  });
  elements.restart.addEventListener("click", () => {
    current = firstState;
    if (hasWelcome) document.body.removeAttribute("data-initial-render");
    else document.body.dataset.initialRender = "true";
    render();
    if (current < 0) elements.welcomeAction.focus({ preventScroll: true });
    else elements.hotspot.focus({ preventScroll: true });
  });
  elements.welcomeAction.addEventListener("click", () => advance(true));
  elements.scroll.addEventListener(
    "scroll",
    () => {
      updatePositionLocks();
      scheduleOverlayPosition(180);
    },
    { capture: true, passive: true }
  );
  elements.scroll.addEventListener(
    "click",
    (event) => {
      if (event.target === elements.scroll) return;
      event.preventDefault();
      event.stopPropagation();
    },
    true
  );
  elements.scroll.addEventListener(
    "dragstart",
    (event) => event.preventDefault(),
    true
  );
  document.addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight" && current < demo.steps.length) advance(false);
    if (event.key === "ArrowLeft" && current > firstState) {
      current = Math.max(firstState, current - 1);
      render();
    }
    if (event.key === "Home") {
      current = firstState;
      if (hasWelcome) document.body.removeAttribute("data-initial-render");
      else document.body.dataset.initialRender = "true";
      render();
    }
  });
  new ResizeObserver(scaleScene).observe(elements.shell);
  window.addEventListener("resize", scaleScene, { passive: true });
  window.visualViewport?.addEventListener("resize", scaleScene, {
    passive: true
  });
  window.visualViewport?.addEventListener("scroll", scheduleOverlayPosition, {
    passive: true
  });
  if (document.fonts) {
    document.fonts.ready.then(scaleScene);
  }
  render();
})();\n`;
