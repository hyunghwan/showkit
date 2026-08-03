import {
  SCHEMA_VERSION,
  StorySpecSchema,
  type CaptureSource,
  type StorySpec
} from "./schemas.js";

export function createEvidenceGroundedStory(capture: CaptureSource): StorySpec {
  return StorySpecSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    id: `demo-${capture.captureId.slice(-12)}`,
    sourceCaptureId: capture.captureId,
    title: "Product insights walkthrough",
    audience: "Product viewers",
    goal: "Explore the verified product flow at your own pace.",
    locale: "en-US",
    welcome: {
      title: "Welcome to this interactive demo",
      body: "Explore the captured product flow at your own pace.",
      actionLabel: "Explore demo",
      backdrop: "heavy"
    },
    steps: capture.steps.map((step) => {
      const targetName = step.scene.target?.name ?? step.title;
      return {
        id: step.id,
        captureStepId: step.id,
        anchorId: step.scene.anchorId,
        tooltip: {
          title: step.title,
          body: `Select “${targetName}” to view the next product state.`,
          placement: "auto"
        },
        evidenceIds: step.evidence[0] ? [step.evidence[0].id] : [],
        advance: "hotspot"
      };
    }),
    theme: {
      accent: "#ff5a36",
      ink: "#17211b",
      paper: "#f3efe6"
    },
    player: {
      chrome: {
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
      },
      navigation: "controls"
    },
    completion: {
      title: "Ready to create your demo?",
      body: "Email us to discuss an interactive HTML demo for your product.",
      actions: [
        {
          label: "Email us for a demo",
          href: "mailto:hello@sqncs.com?subject=ShowKit%20demo%20request",
          style: "primary"
        }
      ]
    },
    formats: ["web", "markdown"]
  });
}
