const body = document.body;
const emphasis = document.querySelector('[data-setting="emphasis"]');
const statePill = document.querySelector(".state-pill");

document.querySelector('[data-action="customize-view"]').addEventListener("click", () => {
  emphasis.checked = true;
  body.dataset.state = "customized";
  statePill.textContent = "Styled";
});

document.querySelector('[data-action="align-preview"]').addEventListener("click", () => {
  body.dataset.state = "aligned";
});

document.querySelector('[data-action="review-summary"]').addEventListener("click", () => {
  body.dataset.state = "reviewed";
  statePill.textContent = "Ready";
});
