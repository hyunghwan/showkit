const button = document.querySelector("button");
button.addEventListener("click", () => {
  document.querySelector("main").replaceChildren(
    Object.assign(document.createElement("h1"), {
      textContent: "Safe product state ready"
    })
  );
});
