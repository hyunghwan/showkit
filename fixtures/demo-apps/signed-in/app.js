const buttons = [...document.querySelectorAll("nav button")];
const heading = document.querySelector("main h2");
const description = document.querySelector("main > p:nth-of-type(2)");

for (const button of buttons) {
  button.addEventListener("click", () => {
    for (const candidate of buttons) {
      candidate.setAttribute("aria-pressed", String(candidate === button));
    }
    heading.textContent = `${button.textContent.trim()} is ready`;
    description.textContent = `Review the ${button.textContent.trim().toLowerCase()} state and continue when ready.`;
  });
}
