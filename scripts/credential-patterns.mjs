export const CREDENTIAL_PATTERNS = Object.freeze([
  {
    name: "private key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    canary: ["-----BEGIN ", "PRIVATE KEY-----"].join("")
  },
  {
    name: "GitHub token",
    pattern: /\bgh[oprsu]_[A-Za-z0-9]{20,}\b/,
    canary: ["ghp", "_", "A".repeat(36)].join("")
  },
  {
    name: "OpenAI API key",
    pattern: /\bsk-(?:proj|svcacct)-[A-Za-z0-9_-]{16,}\b/,
    canary: ["sk", "-proj-", "B".repeat(24)].join("")
  },
  {
    name: "Stripe API key",
    pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/,
    canary: ["sk", "_live_", "C".repeat(24)].join("")
  },
  {
    name: "Stripe webhook secret",
    pattern: /\bwhsec_[A-Za-z0-9]{16,}\b/,
    canary: ["whsec", "_", "D".repeat(32)].join("")
  },
  {
    name: "Slack token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    canary: ["xoxb", "-", "E".repeat(24)].join("")
  },
  {
    name: "AWS access key",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
    canary: ["AKIA", "F".repeat(16)].join("")
  },
  {
    name: "Google API key",
    pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/,
    canary: ["AIza", "G".repeat(35)].join("")
  },
  {
    name: "npm token",
    pattern: /\bnpm_[A-Za-z0-9]{20,}\b/,
    canary: ["npm", "_", "H".repeat(36)].join("")
  },
  {
    name: "GitLab token",
    pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/,
    canary: ["glpat", "-", "I".repeat(24)].join("")
  },
  {
    name: "Bearer token",
    pattern: /\bBearer[ \t]+[A-Za-z0-9._~+/=-]{20,}/i,
    canary: ["Bearer", " ", "J".repeat(32)].join("")
  }
]);

export function assertCredentialPatternCoverage() {
  if (
    CREDENTIAL_PATTERNS.some(({ canary, pattern }) => !pattern.test(canary))
  ) {
    throw new Error("The repository credential policy is incomplete.");
  }
}

export function findCredentialPattern(contents) {
  return CREDENTIAL_PATTERNS.find(({ pattern }) => pattern.test(contents))?.name ?? null;
}
