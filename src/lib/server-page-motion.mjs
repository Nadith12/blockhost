const duration = 520;
const sampleCount = 16;
const lerp = (start, end, progress) => start + (end - start) * progress;
const clamp = value => Math.max(0, Math.min(1, value));
const smooth = value => value * value * (3 - 2 * value);

function glassOutline(card, stage, progress) {
  const horizontal = Math.abs(card.x + card.width / 2 - stage.width / 2) / stage.width
    >= Math.abs(card.y + card.height / 2 - stage.height / 2) / stage.height;
  const length = horizontal ? stage.width : stage.height;
  const breadth = horizontal ? stage.height : stage.width;
  const along = horizontal ? card.x : card.y;
  const span = horizontal ? card.width : card.height;
  const across = horizontal ? card.y : card.x;
  const crossSpan = horizontal ? card.height : card.width;
  const reflected = along + span / 2 > length / 2;
  const source = reflected ? length - along - span : along;
  const flex = .29 * Math.sin(Math.PI * progress);
  const near = clamp(progress - flex);
  const far = clamp(progress + flex);
  const start = lerp(source, 0, progress);
  const end = lerp(source + span, length, far);
  const nearTop = lerp(across, 0, near);
  const nearBottom = lerp(across + crossSpan, breadth, near);
  const farTop = lerp(across, 0, far);
  const farBottom = lerp(across + crossSpan, breadth, far);
  const radius = Math.min(lerp(card.radius, 0, progress), (end - start) / 3, (nearBottom - nearTop) / 3);
  const first = lerp(start + radius, end - radius, .34);
  const second = lerp(start + radius, end - radius, .66);
  const waist = crossSpan * flex * .45;
  const point = (u, v) => {
    const axis = reflected ? length - u : u;
    return horizontal ? `${axis} ${v}` : `${v} ${axis}`;
  };

  return `path("M ${point(start, nearTop + radius)}
    Q ${point(start, nearTop)} ${point(start + radius, nearTop)}
    C ${point(first, nearTop + waist)} ${point(second, farTop)} ${point(end - radius, farTop)}
    Q ${point(end, farTop)} ${point(end, farTop + radius)}
    L ${point(end, farBottom - radius)}
    Q ${point(end, farBottom)} ${point(end - radius, farBottom)}
    C ${point(second, farBottom)} ${point(first, nearBottom - waist)} ${point(start + radius, nearBottom)}
    Q ${point(start, nearBottom)} ${point(start, nearBottom - radius)} Z")`.replace(/\s+/g, " ");
}

function panelFrames(rect, origin, delay, bend) {
  const x = origin.x - (rect.left + rect.width / 2);
  const y = origin.y - (rect.top + rect.height / 2);
  const startingScale = Math.min(.45, origin.width * .8 / rect.width, origin.height * .8 / rect.height);
  return Array.from({ length: sampleCount + 1 }, (_, step) => {
    const offset = step / sampleCount;
    const time = clamp((offset - delay) / (.9 - delay));
    const progress = 1 - (1 - time) ** 2.5;
    const arc = Math.sin(Math.PI * progress) * bend;
    return {
      offset,
      transform: `translate(${x * (1 - progress) - y * arc}px, ${y * (1 - progress) + x * arc}px) scale(${lerp(startingScale, 1, progress)})`,
      opacity: smooth(clamp(time * 3.8)),
    };
  });
}

export function createServerPageMotion(stage, workspace, library, card, onReopen, onFinish) {
  const viewport = stage.getBoundingClientRect();
  const rect = card.getBoundingClientRect();
  const cardBox = {
    x: rect.left - viewport.left, y: rect.top - viewport.top, width: rect.width, height: rect.height,
    radius: parseFloat(getComputedStyle(card).borderTopLeftRadius) || 0,
  };
  const origin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height };
  library.style.transformOrigin = `${origin.x - viewport.left}px ${origin.y - viewport.top}px`;

  const softenedEdges = document.createElement("div");
  softenedEdges.className = "server-motion-glow";
  softenedEdges.setAttribute("aria-hidden", "true");
  const glass = document.createElement("div");
  glass.className = "server-motion-glass";
  glass.style.backgroundImage = getComputedStyle(workspace).backgroundImage;
  const highlight = document.createElement("div");
  highlight.className = "server-motion-highlight";
  glass.append(highlight);
  softenedEdges.append(glass);
  const returnButton = document.createElement("button");
  returnButton.className = "server-motion-return";
  returnButton.type = "button";
  returnButton.tabIndex = -1;
  returnButton.hidden = true;
  returnButton.setAttribute("aria-label", `Keep ${card.querySelector(".library-card-title").textContent} open`);
  Object.assign(returnButton.style, {
    left: `${cardBox.x}px`, top: `${cardBox.y}px`, width: `${cardBox.width}px`, height: `${cardBox.height}px`,
  });
  returnButton.addEventListener("click", onReopen);
  stage.append(softenedEdges, returnButton);
  stage.classList.add("server-pages-transitioning");
  glass.style.clipPath = glassOutline(cardBox, viewport, 0);

  // Each track uses the same clock so a change of direction preserves the current frame.
  const tracks = [];
  let resolveSettled;
  const motion = {
    opening: true,
    settled: new Promise(resolve => { resolveSettled = resolve; }),
    play(opening) {
      if (motion.opening === opening && tracks[0].playState === "running") return;
      const direction = opening ? 1 : -1;
      const position = tracks[0].currentTime ?? (opening ? 0 : duration);
      const startTime = document.timeline.currentTime - position / direction;
      motion.opening = opening;
      returnButton.hidden = opening;
      workspace.inert = !opening;
      for (const track of tracks) {
        track.playbackRate = direction;
        track.startTime = startTime;
      }
    },
    dispose() {
      tracks.forEach(track => track.cancel());
      workspace.inert = false;
      softenedEdges.remove();
      returnButton.remove();
      library.remove();
      stage.classList.remove("server-pages-transitioning");
      resolveSettled();
    },
  };
  const track = (element, frames) => {
    tracks.push(new Animation(new KeyframeEffect(element, frames, { duration, fill: "both" }), document.timeline));
  };
  const glassFrames = Array.from({ length: sampleCount + 1 }, (_, step) => {
    const time = step / sampleCount;
    return {
      clipPath: glassOutline(cardBox, viewport, 1 - (1 - time) ** 1.55),
      opacity: smooth(clamp(time * 9)),
    };
  });
  track(glass, glassFrames);
  track(workspace, glassFrames.map(({ clipPath }) => ({ clipPath })));
  track(softenedEdges, [
    { offset: 0, filter: "blur(15px)" },
    { offset: .90, filter: "blur(15px)" },
    { offset: 1, filter: "blur(0px)" },
  ]);
  track(highlight, [
    { offset: 0, opacity: 0 },
    { offset: .22, opacity: 1 },
    { offset: .63, opacity: .84 },
    { offset: 1, opacity: 0 },
  ]);
  track(library, [
    { offset: 0, opacity: 1, transform: "scale(1)", easing: "cubic-bezier(.3,.15,.25,1)" },
    { offset: .54, opacity: 0, transform: "scale(.82)" },
    { offset: 1, opacity: 0, transform: "scale(.82)" },
  ]);

  const groups = [
    [".server-heading", .015],
    [".header-actions", .05],
    [".server-breadcrumb", .09],
    [".workspace-nav", .115],
    [".metrics article", .16],
    [".quick-settings, .console-card, .workspace-panel, .startup-diagnosis", .23],
  ];
  const bend = cardBox.x + rect.width / 2 < viewport.width / 2 ? -.09 : .09;
  for (const [selector, delay] of groups) {
    const visible = [...workspace.querySelectorAll(selector)]
      .map(element => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width && rect.height && rect.bottom > viewport.top && rect.top < viewport.bottom)
      .sort((a, b) => Math.abs(a.rect.left + a.rect.width / 2 - origin.x) - Math.abs(b.rect.left + b.rect.width / 2 - origin.x));
    visible.forEach(({ element, rect }, index) => track(element, panelFrames(rect, origin, delay + index * .017, bend)));
  }

  motion.start = opening => {
    tracks[0].addEventListener("finish", onFinish);
    motion.play(opening);
  };
  return motion;
}
