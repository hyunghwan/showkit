const release = "2026-08-06-capture-fidelity";
const origin = "https://showkit.sqncs.com";

const demos = {
  "travel-search": {
    title: "Explore flexible travel dates"
  },
  "issue-priority": {
    title: "Scaffold a project with Linear Agent"
  },
  "stripe-payments": {
    title: "Filter payments by date and amount"
  }
};

const tabs = Array.from(document.querySelectorAll("[role='tab'][data-demo]"));
const panel = document.getElementById("demo-panel");
const heading = document.getElementById("selected-demo-title");
const iframe = document.getElementById("showkit-demo");
const openDemo = document.getElementById("open-demo");

function demoUrl(demoId) {
  return `${origin}/demos/${demoId}/?release=${release}`;
}

function selectDemo(demoId, options = {}) {
  const demo = demos[demoId];
  const selectedTab = tabs.find((tab) => tab.dataset.demo === demoId);
  if (!demo || !selectedTab || !panel || !heading || !iframe || !openDemo) return;

  for (const tab of tabs) {
    const selected = tab === selectedTab;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }

  const url = demoUrl(demoId);
  panel.setAttribute("aria-labelledby", selectedTab.id);
  heading.textContent = demo.title;
  iframe.title = `${demo.title} interactive demo`;
  if (iframe.src !== url) iframe.src = url;
  openDemo.href = url;

  const tabList = selectedTab.parentElement;
  if (tabList && tabList.scrollWidth > tabList.clientWidth) {
    selectedTab.scrollIntoView({ block: "nearest", inline: "center" });
  }
  if (options.focus) selectedTab.focus();
  if (options.updateHistory) {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("demo", demoId);
    window.history.replaceState(null, "", nextUrl);
  }
}

for (const [index, tab] of tabs.entries()) {
  tab.addEventListener("click", () => {
    selectDemo(tab.dataset.demo, { updateHistory: true });
  });

  tab.addEventListener("keydown", (event) => {
    let nextIndex;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    selectDemo(tabs[nextIndex].dataset.demo, {
      focus: true,
      updateHistory: true
    });
  });
}

const requestedDemo = new URL(window.location.href).searchParams.get("demo");
if (requestedDemo && demos[requestedDemo]) selectDemo(requestedDemo);
