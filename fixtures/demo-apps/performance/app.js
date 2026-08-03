const main = document.querySelector("main");
const button = document.querySelector("button");
const heading = document.querySelector("h1");
let step = 1;
let pointerStartedAt = 0;
window.__showkitMaxInputLatency = 0;

button.addEventListener("pointerdown", () => {
  pointerStartedAt = performance.now();
});

button.addEventListener("click", () => {
  if (pointerStartedAt > 0) {
    window.__showkitMaxInputLatency = Math.max(
      window.__showkitMaxInputLatency,
      performance.now() - pointerStartedAt
    );
  }
  step += 1;
  if (step > 25) {
    main.replaceChildren(Object.assign(document.createElement("h1"), {
      textContent: "Capture performance complete"
    }));
    return;
  }
  heading.textContent = `Capture state ${step}`;
  button.textContent = `Advance ${step} of 25`;
});
