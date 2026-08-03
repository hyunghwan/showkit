(() => {
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
  let renderedViewport = { width: 1280, height: 720 };
  let renderedScale = 1;
  let overlayFrame = 0;
  let overlayTimer = 0;
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
  elements.welcome.dataset.backdrop = demo.welcome.backdrop;
  elements.welcomeTitle.textContent = demo.welcome.title;
  elements.welcomeBody.textContent = demo.welcome.body;
  elements.welcomeAction.textContent = demo.welcome.actionLabel;

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
    "tabindex",
    "title",
    "transform",
    "type",
    "viewBox",
    "width",
    "x",
    "x1",
    "x2",
    "y",
    "y1",
    "y2",
    "data-showkit-anchor",
    "data-showkit-pseudo",
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
      !/@import|expression\s*\(/i.test(value) &&
      !/url\s*\(/i.test(
        value.replace(
          /url\s*\(\s*["']?\.\/assets\/[a-f0-9]{64}\.(?:png|jpg|webp|avif|gif|svg)["']?\s*\)/gi,
          ""
        )
      )
    );
  }

  function createSceneNode(node) {
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
        name === "src" &&
        !/^\.\/assets\/[a-f0-9]{64}\.(?:png|jpg|webp|avif|gif|svg)$/.test(value)
      ) continue;
      if (
        name === "href" &&
        !/^\.\/assets\/[a-f0-9]{64}\.(?:png|jpg|webp|avif|gif|svg)$/.test(value) &&
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
      element.append(createSceneNode(child));
    }
    return element;
  }

  function replaceScene(scene) {
    sceneFontStyle.textContent = (scene.fontFaces ?? [])
      .filter(
        (face) =>
          /^[^{};@<>"'\\\r\n]{1,120}$/.test(face.family) &&
          /^(?:normal|italic|oblique)$/.test(face.style) &&
          /^(?:normal|bold|[1-9]00(?: [1-9]00)?)$/.test(face.weight) &&
          /^(?:normal|(?:ultra-|extra-|semi-)?(?:condensed|expanded)|\d{1,3}%)$/.test(
            face.stretch
          ) &&
          /^(?:auto|block|swap|fallback|optional)$/.test(face.display) &&
          /^\.\/assets\/[a-f0-9]{64}\.woff2$/.test(face.src) &&
          (!face.unicodeRange ||
            /^U\+[0-9A-F?*]{1,6}(?:\s*-\s*[0-9A-F?*]{1,6})?(?:\s*,\s*U\+[0-9A-F?*]{1,6}(?:\s*-\s*[0-9A-F?*]{1,6})?)*$/i.test(
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
          "src:url(" + JSON.stringify(face.src) + ") format(\"woff2\");" +
          "}"
      )
      .join("\n");
    elements.viewport.replaceChildren(...scene.nodes.map(createSceneNode));
    sceneLayoutObserver.disconnect();
    for (const element of elements.viewport.querySelectorAll("*")) {
      sceneLayoutObserver.observe(element);
    }
    if (document.fonts) {
      document.fonts.ready.then(() => {
        scaleScene();
        positionOverlay();
      });
    }
  }

  function positionOverlay() {
    const shellRect = elements.shell.getBoundingClientRect();
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
      elements.tooltip.dataset.placement = "center";
      elements.tooltip.dataset.complete = "true";
      const tooltipRect = elements.tooltip.getBoundingClientRect();
      elements.tooltip.style.left =
        Math.max(12, (shellRect.width - tooltipRect.width) / 2) + "px";
      elements.tooltip.style.top =
        Math.max(12, (shellRect.height - tooltipRect.height) / 2) + "px";
      elements.tooltip.style.visibility = "visible";
      return;
    }
    elements.tooltip.dataset.complete = "false";
    const anchor = elements.viewport.querySelector('[data-showkit-anchor="' + CSS.escape(step.anchorId) + '"]');
    if (!anchor) {
      elements.stepBackdrop.hidden = true;
      elements.hotspot.hidden = true;
      elements.tooltip.hidden = true;
      return;
    }
    const anchorRect = anchor.getBoundingClientRect();
    const left = anchorRect.left - shellRect.left;
    const top = anchorRect.top - shellRect.top;
    elements.hotspot.style.left = left + "px";
    elements.hotspot.style.top = top + "px";
    elements.hotspot.style.width = anchorRect.width + "px";
    elements.hotspot.style.height = anchorRect.height + "px";
    const anchorRadius = Number.parseFloat(
      getComputedStyle(anchor).borderTopLeftRadius
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
      elements.stepBackdrop.style.left = left + "px";
      elements.stepBackdrop.style.top = top + "px";
      elements.stepBackdrop.style.width = anchorRect.width + "px";
      elements.stepBackdrop.style.height = anchorRect.height + "px";
      elements.stepBackdrop.style.borderRadius =
        Math.max(0, renderedRadius) + "px";
      elements.stepBackdrop.style.visibility = "visible";
      elements.stepBackdrop.hidden = false;
    } else {
      elements.stepBackdrop.hidden = true;
    }

    elements.tooltip.style.visibility = "hidden";
    elements.tooltip.hidden = false;
    const tooltipRect = elements.tooltip.getBoundingClientRect();
    const gap = 18;
    const candidates = {
      right: [left + anchorRect.width + gap, top + anchorRect.height / 2 - tooltipRect.height / 2],
      left: [left - tooltipRect.width - gap, top + anchorRect.height / 2 - tooltipRect.height / 2],
      bottom: [left + anchorRect.width / 2 - tooltipRect.width / 2, top + anchorRect.height + gap],
      top: [left + anchorRect.width / 2 - tooltipRect.width / 2, top - tooltipRect.height - gap]
    };
    const preferred = step.tooltip.placement === "auto"
      ? ["right", "left", "bottom", "top"]
      : [step.tooltip.placement, "right", "left", "bottom", "top"];
    const chromeObstacles = chrome.mode === "overlay"
      ? Array.from(
          elements.chromeOverlay.querySelectorAll('.chrome-dock[data-active="true"]')
        ).map((dock) => dock.getBoundingClientRect())
      : [];
    let selected = { placement: "right", left: 12, top: 12, score: Number.POSITIVE_INFINITY };
    for (const [preferenceIndex, placement] of [...new Set(preferred)].entries()) {
      const candidate = candidates[placement];
      const candidateLeft = clamp(candidate[0], 12, shellRect.width - tooltipRect.width - 12);
      const candidateTop = clamp(candidate[1], 12, shellRect.height - tooltipRect.height - 12);
      const overflow =
        Math.max(0, 12 - candidate[0]) +
        Math.max(0, 12 - candidate[1]) +
        Math.max(0, candidate[0] + tooltipRect.width - shellRect.width + 12) +
        Math.max(0, candidate[1] + tooltipRect.height - shellRect.height + 12);
      const overlapWidth = Math.max(
        0,
        Math.min(candidateLeft + tooltipRect.width, left + anchorRect.width) -
          Math.max(candidateLeft, left)
      );
      const overlapHeight = Math.max(
        0,
        Math.min(candidateTop + tooltipRect.height, top + anchorRect.height) -
          Math.max(candidateTop, top)
      );
      const chromeOverlap = chromeObstacles.reduce((area, obstacle) => {
        const obstacleLeft = obstacle.left - shellRect.left;
        const obstacleTop = obstacle.top - shellRect.top;
        const width = Math.max(
          0,
          Math.min(candidateLeft + tooltipRect.width, obstacleLeft + obstacle.width) -
            Math.max(candidateLeft, obstacleLeft)
        );
        const height = Math.max(
          0,
          Math.min(candidateTop + tooltipRect.height, obstacleTop + obstacle.height) -
            Math.max(candidateTop, obstacleTop)
        );
        return area + width * height;
      }, 0);
      const score =
        overflow * 10_000 +
        chromeOverlap * 200 +
        overlapWidth * overlapHeight * 100 +
        preferenceIndex;
      if (score < selected.score) {
        selected = {
          placement,
          left: candidateLeft,
          top: candidateTop,
          score
        };
      }
    }
    elements.tooltip.dataset.placement = selected.placement;
    elements.tooltip.style.left = selected.left + "px";
    elements.tooltip.style.top = selected.top + "px";
    elements.tooltip.style.visibility = "visible";
  }

  function scheduleOverlayPosition() {
    window.cancelAnimationFrame(overlayFrame);
    window.clearTimeout(overlayTimer);
    overlayFrame = window.requestAnimationFrame(() => {
      positionOverlay();
      overlayFrame = window.requestAnimationFrame(positionOverlay);
    });
    overlayTimer = window.setTimeout(positionOverlay, 120);
  }

  function scaleScene() {
    const overlayMode = chrome.mode === "overlay";
    elements.shell.scrollTop = 0;
    elements.shell.scrollLeft = 0;
    elements.viewport.style.width = renderedViewport.width + "px";
    elements.viewport.style.height = renderedViewport.height + "px";
    let scale;
    if (overlayMode) {
      elements.stage.style.maxWidth = "none";
      elements.frame.style.removeProperty("--stage-max-width");
      elements.shell.style.height = "100%";
      const shellWidth = elements.shell.clientWidth;
      const shellHeight = elements.shell.clientHeight;
      scale = Math.min(shellWidth / renderedViewport.width, 1);
      const contentHeight = renderedViewport.height * scale;
      let top = contentHeight <= shellHeight
        ? (shellHeight - contentHeight) / 2
        : 0;
      const step = current >= 0 && current < demo.steps.length
        ? demo.steps[current]
        : undefined;
      if (step && contentHeight > shellHeight) {
        const target = step.target.bounds;
        const targetCenter = (target.y + target.height / 2) * contentHeight;
        const desiredTop = shellHeight / 2 - targetCenter;
        top = clamp(desiredTop, shellHeight - contentHeight, 0);
      }
      elements.viewport.style.left =
        Math.round((shellWidth - renderedViewport.width * scale) / 2) + "px";
      elements.viewport.style.top = Math.round(top) + "px";
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
      elements.shell.style.height = Math.round(renderedViewport.height * scale) + "px";
      elements.viewport.style.left = "0px";
      elements.viewport.style.top = "0px";
    }
    renderedScale = scale;
    elements.viewport.style.transform = "scale(" + scale + ")";
    scheduleOverlayPosition();
  }

  function renderCompletionActions() {
    elements.completionActions.replaceChildren();
    if (!demo.completion) {
      elements.completionActions.hidden = true;
      return;
    }
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
    const welcome = current < 0;
    const complete = current >= demo.steps.length;
    const step = welcome
      ? demo.steps[0]
      : complete
        ? demo.terminal
        : demo.steps[current];
    renderedViewport = step.viewport;
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
    elements.back.disabled = false;
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
      current = 0;
      render();
      if (moveFocus) elements.hotspot.focus({ preventScroll: true });
      return;
    }
    if (current < demo.steps.length) {
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
    current = Math.max(-1, current - 1);
    render();
    if (current < 0) elements.welcomeAction.focus({ preventScroll: true });
    else elements.hotspot.focus({ preventScroll: true });
  });
  elements.restart.addEventListener("click", () => {
    current = -1;
    render();
    elements.welcomeAction.focus({ preventScroll: true });
  });
  elements.welcomeAction.addEventListener("click", () => advance(true));
  document.addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight" && current < demo.steps.length) advance(false);
    if (event.key === "ArrowLeft" && current >= 0) {
      current = Math.max(-1, current - 1);
      render();
    }
    if (event.key === "Home") {
      current = -1;
      render();
    }
  });
  new ResizeObserver(scaleScene).observe(elements.shell);
  if (document.fonts) {
    document.fonts.ready.then(scaleScene);
  }
  render();
})();
