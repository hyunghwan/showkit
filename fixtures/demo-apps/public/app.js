const workspace = document.querySelector("#workspace");

const overviewBars = [42, 55, 48, 69, 58, 73, 64, 71, 80, 74, 86, 79, 91, 84];
const engagedBars = [36, 44, 51, 57, 61, 72, 68, 79, 83, 78, 88, 84, 94, 90];

let view = "overview";

function renderBars(values, highlightIndex = -1) {
  return values
    .map((value, index) => {
      const stateClass =
        index === highlightIndex ? "chart-bar highlight" : index >= 7 ? "chart-bar current" : "chart-bar";
      return `<span class="${stateClass}" style="height: ${value}%"></span>`;
    })
    .join("");
}

function metricCard({ label, value, change, caption, direction = "up", accent = false }) {
  return `
    <article class="metric-card${accent ? " accent" : ""}">
      <div class="metric-label">${label}</div>
      <div class="metric-value">
        <strong>${value}</strong>
        <span class="metric-change${direction === "down" ? " down" : ""}">
          ${direction === "down" ? "↓" : "↑"} ${change}
        </span>
      </div>
      <p class="metric-caption">${caption}</p>
    </article>
  `;
}

function overviewMarkup({ filtered = false, filterOpen = false } = {}) {
  const metrics = filtered
    ? [
        {
          label: "Sessions",
          value: "4,218",
          change: "22.4%",
          caption: "Engaged visitors",
          accent: true
        },
        {
          label: "Active attention",
          value: "6m 08s",
          change: "1m 12s",
          caption: "Average per session"
        },
        {
          label: "Journey depth",
          value: "8.3",
          change: "1.4",
          caption: "Pages per session"
        },
        {
          label: "Goal completion",
          value: "71.8%",
          change: "3.1%",
          caption: "Reached activation goal",
          direction: "down"
        }
      ]
    : [
        {
          label: "Sessions",
          value: "12,842",
          change: "18.6%",
          caption: "Compared with previous 7 days",
          accent: true
        },
        {
          label: "Active attention",
          value: "4m 12s",
          change: "38s",
          caption: "Average per session"
        },
        {
          label: "Journey depth",
          value: "5.8",
          change: "0.9",
          caption: "Pages per session"
        },
        {
          label: "Goal completion",
          value: "64.2%",
          change: "3.1%",
          caption: "Reached activation goal",
          direction: "down"
        }
      ];

  return `
    <div class="dashboard" aria-label="Product signals overview">
      <header class="page-heading">
        <div class="heading-copy">
          <p class="eyebrow">${filtered ? "Engaged visitor segment" : "Weekly signal review"}</p>
          <h1>${filtered ? "Find the sessions that explain the change." : "Know what changed before conversion moves."}</h1>
          <p class="heading-note">
            ${filtered ? "4,218 sessions match this view." : "Cinder web · Product behavior from the last 7 days"}
          </p>
        </div>
        <div class="heading-actions">
          <button type="button" class="button soft">Compare</button>
          <button type="button" class="button primary">Create report</button>
        </div>
      </header>

      <div>
        <div class="filter-row" aria-label="Session filters">
          <button type="button" class="filter-chip" data-action="open-filter">
            <span class="chip-mark" aria-hidden="true">+</span>
            <span>Add filter</span>
          </button>
          ${
            filtered
              ? `
                <button type="button" class="filter-chip active">
                  <span class="choice-dot" aria-hidden="true"></span>
                  <span>Engaged visitors</span>
                </button>
              `
              : `
                <button type="button" class="filter-chip">
                  <span class="view-dot coral" aria-hidden="true"></span>
                  <span>Checkout goal</span>
                </button>
              `
          }
          <button type="button" class="filter-chip date-chip">
            <span>May 11–17</span>
            <span aria-hidden="true">⌄</span>
          </button>
        </div>
      </div>

      <div class="dashboard" style="grid-template-rows: auto minmax(0, 1fr); gap: 10px;">
        <div class="metric-grid">
          ${metrics.map(metricCard).join("")}
        </div>

        <div class="dashboard-body">
          <section class="card trend-card" aria-labelledby="attention-heading">
            <div class="card-heading">
              <div>
                <h2 id="attention-heading">${filtered ? "Engaged sessions" : "Attention over time"}</h2>
                <p>${filtered ? "Matched sessions compared with all sessions" : "Active and inactive session volume"}</p>
              </div>
              <div class="legend" aria-label="Chart legend">
                <span class="legend-item"><span class="legend-swatch"></span>${filtered ? "Matched" : "Active"}</span>
                <span class="legend-item"><span class="legend-swatch muted"></span>All sessions</span>
              </div>
            </div>
            <div class="chart" aria-label="${filtered ? "Engaged sessions increased during the week" : "Active attention increased during the week"}">
              ${renderBars(filtered ? engagedBars : overviewBars, filtered ? 10 : -1)}
            </div>
            <div class="chart-labels" aria-hidden="true">
              <span>Mon</span>
              <span>Tue</span>
              <span>Wed</span>
              <span>Thu</span>
              <span>Fri</span>
              <span>Sat</span>
              <span>Sun</span>
            </div>
          </section>

          <aside class="card insight-panel" aria-labelledby="insight-heading">
            <div class="insight-kicker">
              <span class="insight-kicker-mark" aria-hidden="true">!</span>
              <span>${filtered ? "New pattern" : "Needs attention"}</span>
            </div>
            <h2 id="insight-heading">
              ${filtered ? "Checkout hesitation clusters on mobile." : "Goal completion slipped while attention rose."}
            </h2>
            <p>
              ${
                filtered
                  ? "312 engaged sessions returned from checkout within 20 seconds."
                  : "Visitors spent more time in the journey, but fewer reached the checkout goal."
              }
            </p>
            <div class="insight-stat">
              <span>${filtered ? "Quick returns" : "Completion change"}</span>
              <strong>${filtered ? "22%" : "−3.1%"}</strong>
            </div>
            <div class="insight-stat">
              <span>${filtered ? "Affected sessions" : "Additional attention"}</span>
              <strong>${filtered ? "312" : "+38s"}</strong>
            </div>
            <button
              type="button"
              class="text-button"
              data-action="open-insight"
              ${filtered ? "" : "disabled"}
            >
              Review friction insight
            </button>
          </aside>
        </div>
      </div>
    </div>

    ${
      filterOpen
        ? `
          <div class="filter-scrim" aria-hidden="true"></div>
          <aside class="filter-panel" role="dialog" aria-modal="true" aria-labelledby="filter-heading">
            <div class="panel-topline">
              <h2 id="filter-heading">Filter sessions</h2>
              <span class="panel-count">1</span>
            </div>
            <p>Focus the overview on a behavior or visitor group.</p>

            <section class="filter-group" aria-labelledby="visitor-group">
              <p class="filter-group-label" id="visitor-group">Visitor behavior</p>
              <div class="segment-chips">
                <button type="button" class="segment-button primary-choice" data-action="choose-engaged">
                  <span class="choice-dot" aria-hidden="true"></span>
                  <span>Engaged visitors</span>
                </button>
                <button type="button" class="segment-button">
                  <span class="choice-dot blue" aria-hidden="true"></span>
                  <span>New visitors</span>
                </button>
                <button type="button" class="segment-button">
                  <span class="choice-dot amber" aria-hidden="true"></span>
                  <span>Returning visitors</span>
                </button>
              </div>
            </section>

            <section class="filter-group" aria-labelledby="activity-group">
              <p class="filter-group-label" id="activity-group">Activity</p>
              <div class="segment-chips">
                <button type="button" class="segment-button">Reached checkout</button>
                <button type="button" class="segment-button">Opened pricing</button>
                <button type="button" class="segment-button">Returned quickly</button>
              </div>
            </section>

            <section class="filter-group" aria-labelledby="device-group">
              <p class="filter-group-label" id="device-group">Device</p>
              <div class="segment-chips">
                <button type="button" class="segment-button">Desktop</button>
                <button type="button" class="segment-button">Mobile</button>
                <button type="button" class="segment-button">Tablet</button>
              </div>
            </section>

            <div class="filter-preview">
              <div>
                <strong>4,218</strong>
                <span>matched sessions</span>
              </div>
              <div class="mini-bars" aria-label="Matched session volume preview">
                <span style="height: 11px"></span>
                <span style="height: 18px"></span>
                <span style="height: 15px"></span>
                <span style="height: 26px"></span>
                <span style="height: 22px"></span>
                <span style="height: 30px"></span>
              </div>
            </div>
          </aside>
        `
        : ""
    }
  `;
}

function insightMarkup() {
  return `
    <div class="insight-page">
      <header class="page-heading">
        <div class="heading-copy">
          <span class="back-link"><span aria-hidden="true">←</span> Product signals</span>
          <p class="eyebrow">Behavior insight · Engaged visitors</p>
          <h1>Checkout friction</h1>
          <p class="heading-note">A repeated return pattern appears in 312 mobile sessions.</p>
        </div>
        <div class="heading-actions">
          <button type="button" class="button soft">Save view</button>
          <button type="button" class="button primary">Create report</button>
        </div>
      </header>

      <div class="insight-layout">
        <article class="card insight-story" aria-labelledby="pattern-heading">
          <div>
            <h2 id="pattern-heading">Visitors return after reviewing delivery details.</h2>
            <div class="insight-meta">
              <span class="tag">High confidence</span>
              <span>312 sessions</span>
              <span>May 11–17</span>
            </div>
          </div>

          <div class="comparison" aria-label="Quick return comparison">
            <div class="comparison-cell">
              <small>Previous period</small>
              <strong>9.4%</strong>
            </div>
            <span class="comparison-arrow" aria-hidden="true">→</span>
            <div class="comparison-cell after">
              <small>Current period</small>
              <strong>22.0%</strong>
            </div>
          </div>

          <div class="path-map" aria-label="Common visitor path">
            <div class="path-node">
              <strong>Pricing</strong>
              <small>1m 08s</small>
            </div>
            <span class="path-arrow" aria-hidden="true">→</span>
            <div class="path-node risk">
              <strong>Checkout</strong>
              <small>2m 41s</small>
            </div>
            <span class="path-arrow" aria-hidden="true">↩</span>
            <div class="path-node">
              <strong>Pricing</strong>
              <small>20s return</small>
            </div>
          </div>
        </article>

        <aside class="card session-list" aria-labelledby="session-list-heading">
          <h2 id="session-list-heading">Matching sessions</h2>
          <p>Ordered by strongest match to this pattern.</p>

          <div class="session-row">
            <div class="session-identity">
              <span class="session-avatar">SS</span>
              <span class="session-copy">
                <strong>Sample session</strong>
                <small>Mobile · New visitor</small>
                <span class="session-meta"><span>8m 12s</span><span>11 pages</span><span>2 returns</span></span>
              </span>
            </div>
            <button type="button" class="session-action" data-action="review-session">
              Review sample session
            </button>
          </div>

          <div class="session-row">
            <div class="session-identity">
              <span class="session-avatar">2M</span>
              <span class="session-copy">
                <strong>Session 2M8Q</strong>
                <small>Mobile · Returning visitor</small>
                <span class="session-meta"><span>6m 43s</span><span>9 pages</span><span>2 returns</span></span>
              </span>
            </div>
            <button type="button" class="session-action">Review</button>
          </div>

          <div class="session-row">
            <div class="session-identity">
              <span class="session-avatar">9D</span>
              <span class="session-copy">
                <strong>Session 9D2L</strong>
                <small>Mobile · New visitor</small>
                <span class="session-meta"><span>5m 51s</span><span>8 pages</span><span>1 return</span></span>
              </span>
            </div>
            <button type="button" class="session-action">Review</button>
          </div>
        </aside>
      </div>
    </div>
  `;
}

function sessionMarkup() {
  return `
    <div class="session-page">
      <header class="page-heading">
        <div class="heading-copy">
          <span class="back-link"><span aria-hidden="true">←</span> Checkout friction</span>
          <p class="eyebrow">Session detail · Pattern match</p>
          <h1>Sample session</h1>
          <p class="heading-note">Mobile · New visitor · May 16 at 10:42 AM</p>
        </div>
        <div class="heading-actions">
          <button type="button" class="button soft">Add note</button>
          <button type="button" class="button primary">Create report</button>
        </div>
      </header>

      <div class="session-layout">
        <section class="card timeline-card" aria-labelledby="timeline-heading">
          <div class="card-heading">
            <div>
              <h2 id="timeline-heading">Session timeline</h2>
              <p>Key pages and actions from an 8m 12s session</p>
            </div>
            <span class="tag">2 quick returns</span>
          </div>

          <div class="timeline-visual">
            <div class="timeline-times" aria-hidden="true">
              <span>00:00</span>
              <span>01:14</span>
              <span>03:55</span>
              <span>04:15</span>
              <span>08:12</span>
            </div>
            <div class="timeline-events">
              <div class="timeline-event">
                <span class="timeline-dot"></span>
                <span><strong>Opened pricing</strong><small>Compared plans</small></span>
                <span>1m 14s</span>
              </div>
              <div class="timeline-event">
                <span class="timeline-dot risk"></span>
                <span><strong>Opened checkout</strong><small>Reviewed delivery details</small></span>
                <span>2m 41s</span>
              </div>
              <div class="timeline-event">
                <span class="timeline-dot risk"></span>
                <span><strong>Returned to pricing</strong><small>First quick return</small></span>
                <span>20s</span>
              </div>
              <div class="timeline-event">
                <span class="timeline-dot"></span>
                <span><strong>Compared plans again</strong><small>Reopened feature details</small></span>
                <span>3m 17s</span>
              </div>
              <div class="timeline-event">
                <span class="timeline-dot risk"></span>
                <span><strong>Session ended</strong><small>Checkout goal not reached</small></span>
                <span>—</span>
              </div>
            </div>
          </div>
        </section>

        <aside class="card session-drawer" aria-labelledby="summary-heading">
          <h2 id="summary-heading">Pattern summary</h2>
          <p>This session matches the mobile checkout-friction insight.</p>

          <div class="drawer-summary">
            <div class="drawer-stat">
              <small>Active attention</small>
              <strong>7m 38s</strong>
            </div>
            <div class="drawer-stat">
              <small>Journey depth</small>
              <strong>11 pages</strong>
            </div>
            <div class="drawer-stat">
              <small>Checkout visits</small>
              <strong>2</strong>
            </div>
            <div class="drawer-stat">
              <small>Goal reached</small>
              <strong>No</strong>
            </div>
          </div>

          <div class="finding">
            <strong>Observed pattern</strong>
            <p>The visitor reviewed delivery details, returned to pricing, and ended the session without reaching the checkout goal.</p>
          </div>

          <div class="drawer-actions">
            <button type="button" class="button soft">Add to watchlist</button>
            <button type="button" class="button primary" data-action="create-report-link">
              Create report link
            </button>
          </div>
        </aside>
      </div>
    </div>
  `;
}

function reportMarkup() {
  return `
    ${sessionMarkup()}
    <div class="report-overlay">
      <section class="report-ready" role="status" aria-labelledby="report-heading">
        <span class="ready-mark" aria-hidden="true">✓</span>
        <p class="eyebrow">Workspace report</p>
        <h2 id="report-heading">Report link ready</h2>
        <p>The checkout-friction insight and sample session are included for workspace members.</p>
        <div class="report-link">
          <code>reports / checkout-friction / may-17</code>
          <span>Copied</span>
        </div>
        <div class="report-meta">
          <span>Access: workspace members</span>
          <span>Expires in 14 days</span>
        </div>
      </section>
    </div>
  `;
}

function render() {
  if (view === "filter") {
    workspace.innerHTML = overviewMarkup({ filterOpen: true });
  } else if (view === "filtered") {
    workspace.innerHTML = overviewMarkup({ filtered: true });
  } else if (view === "insight") {
    workspace.innerHTML = insightMarkup();
  } else if (view === "session") {
    workspace.innerHTML = sessionMarkup();
  } else if (view === "report") {
    workspace.innerHTML = reportMarkup();
  } else {
    workspace.innerHTML = overviewMarkup();
  }
}

workspace.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (!(target instanceof HTMLButtonElement)) return;

  const action = target.dataset.action;
  if (action === "open-filter") view = "filter";
  if (action === "choose-engaged") view = "filtered";
  if (action === "open-insight") view = "insight";
  if (action === "review-session") view = "session";
  if (action === "create-report-link") view = "report";
  render();
});

render();
