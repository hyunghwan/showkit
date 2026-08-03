import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  mkdir,
  readFile,
  readdir,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.join(repositoryRoot, "packages", "cli");
const outputIndex = process.argv.indexOf("--output");
const outputDirectory = path.resolve(
  outputIndex >= 0 && process.argv[outputIndex + 1]
    ? process.argv[outputIndex + 1]
    : path.join(repositoryRoot, "release")
);
await mkdir(outputDirectory, { recursive: true });

const packageJson = JSON.parse(
  await readFile(path.join(packageRoot, "package.json"), "utf8")
);
const packageRequire = createRequire(path.join(packageRoot, "package.json"));

function packageId(name, version) {
  return `${name}@${version}`;
}

function spdxId(name, version) {
  return `SPDXRef-Package-${packageId(name, version).replace(
    /[^a-zA-Z0-9.-]/g,
    "-"
  )}`;
}

function repositoryUrl(repository) {
  const value =
    typeof repository === "string" ? repository : repository?.url ?? null;
  return value?.replace(/^git\+/, "") ?? null;
}

function declaredLicense(metadata) {
  if (typeof metadata.license === "string") return metadata.license;
  if (Array.isArray(metadata.licenses)) {
    const licenses = metadata.licenses
      .map((entry) => (typeof entry === "string" ? entry : entry?.type))
      .filter(Boolean);
    if (licenses.length > 0) return licenses.join(" OR ");
  }
  return "NOASSERTION";
}

async function packageMetadata(component) {
  if (component.path) {
    try {
      return {
        source: "installed",
        value: JSON.parse(
          await readFile(path.join(component.path, "package.json"), "utf8")
        )
      };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(
    component.name
  )}/${encodeURIComponent(component.version)}`;
  const response = await fetch(registryUrl, {
    headers: { accept: "application/json" }
  });
  if (!response.ok) {
    throw new Error(
      `Could not verify release metadata for ${packageId(
        component.name,
        component.version
      )}: npm registry returned ${response.status}.`
    );
  }
  return { source: "registry", value: await response.json() };
}

const listResult = spawnSync(
  "pnpm",
  [
    "--filter",
    packageJson.name,
    "list",
    "--prod",
    "--depth",
    "Infinity",
    "--json"
  ],
  {
    cwd: repositoryRoot,
    encoding: "utf8"
  }
);
if (listResult.status !== 0) {
  throw new Error(
    `Could not enumerate the production dependency graph.\n${listResult.stderr}`
  );
}
const productionTree = JSON.parse(listResult.stdout)[0];
if (!productionTree || productionTree.name !== packageJson.name) {
  throw new Error("pnpm returned an unexpected production dependency graph.");
}

const componentNodes = new Map();
const rawRelationships = [];
const expanded = new Set();

function collectDependency(name, dependency, parentId, rootScope = null) {
  const id = packageId(name, dependency.version);
  if (!componentNodes.has(id)) {
    componentNodes.set(id, {
      name,
      version: dependency.version,
      path: dependency.path ?? null,
      resolved: dependency.resolved ?? null
    });
  }
  rawRelationships.push({
    parentId,
    childId: id,
    rootScope
  });
  if (expanded.has(id)) return;
  expanded.add(id);
  for (const [childName, child] of Object.entries(
    dependency.dependencies ?? {}
  )) {
    collectDependency(childName, child, id);
  }
}

for (const [name, dependency] of Object.entries(
  productionTree.dependencies ?? {}
)) {
  collectDependency(name, dependency, "root", "runtime");
}

for (const name of Object.keys(packageJson.peerDependencies ?? {}).sort()) {
  const dependencyPath = packageRequire.resolve(`${name}/package.json`);
  const dependency = JSON.parse(await readFile(dependencyPath, "utf8"));
  const id = packageId(name, dependency.version);
  componentNodes.set(id, {
    name,
    version: dependency.version,
    path: path.dirname(dependencyPath),
    resolved: null
  });
  rawRelationships.push({
    parentId: "root",
    childId: id,
    rootScope: "peer"
  });
}

const metadataById = new Map(
  await Promise.all(
    [...componentNodes.entries()].map(async ([id, component]) => [
      id,
      await packageMetadata(component)
    ])
  )
);

function dependencyScope(parentMetadata, childName, rootScope) {
  if (rootScope) return rootScope;
  if (parentMetadata?.optionalDependencies?.[childName] !== undefined) {
    return "optional";
  }
  if (parentMetadata?.peerDependencies?.[childName] !== undefined) {
    return parentMetadata?.peerDependenciesMeta?.[childName]?.optional === true
      ? "optional-peer"
      : "peer";
  }
  return "transitive";
}

const relationships = rawRelationships
  .map((relationship) => {
    const parentMetadata =
      relationship.parentId === "root"
        ? packageJson
        : metadataById.get(relationship.parentId)?.value;
    const child = componentNodes.get(relationship.childId);
    const scope = dependencyScope(
      parentMetadata,
      child.name,
      relationship.rootScope
    );
    return { ...relationship, scope };
  })
  .filter(
    (relationship, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.parentId === relationship.parentId &&
          candidate.childId === relationship.childId &&
          candidate.scope === relationship.scope
      ) === index
  )
  .sort(
    (left, right) =>
      left.parentId.localeCompare(right.parentId) ||
      left.childId.localeCompare(right.childId)
  );

const scopePriority = new Map([
  ["runtime", 0],
  ["peer", 1],
  ["transitive", 2],
  ["optional-peer", 3],
  ["optional", 4]
]);
const components = [...componentNodes.entries()]
  .map(([id, component]) => {
    const metadata = metadataById.get(id);
    const scopes = relationships
      .filter((relationship) => relationship.childId === id)
      .map((relationship) => relationship.scope)
      .sort(
        (left, right) =>
          scopePriority.get(left) - scopePriority.get(right)
      );
    return {
      name: component.name,
      version: component.version,
      license: declaredLicense(metadata.value),
      repository: repositoryUrl(metadata.value.repository),
      resolved: component.resolved ?? metadata.value.dist?.tarball ?? null,
      scope: scopes[0] ?? "transitive"
    };
  })
  .sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.version.localeCompare(right.version)
  );

const permissiveLicenses = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT"
]);
const noticeRequiredLicenses = new Set(["LGPL-3.0-or-later"]);
const reviewedLicenses = new Set([
  ...permissiveLicenses,
  ...noticeRequiredLicenses
]);
function licenseIdentifiers(expression) {
  return (expression.match(/[a-zA-Z0-9.+-]+/g) ?? []).filter(
    (token) => !["AND", "OR", "WITH"].includes(token)
  );
}
const unsupported = components.filter(
  (component) => {
    const identifiers = licenseIdentifiers(component.license);
    return (
      identifiers.length === 0 ||
      identifiers.some((identifier) => !reviewedLicenses.has(identifier))
    );
  }
);
if (unsupported.length > 0) {
  throw new Error(
    `Unsupported release license: ${unsupported
      .map((component) => `${component.name}:${component.license}`)
      .join(", ")}`
  );
}

const licenseReport = {
  schemaVersion: "0.2",
  package: `${packageJson.name}@${packageJson.version}`,
  policy: {
    permissive: [...permissiveLicenses].sort(),
    noticeRequired: [...noticeRequiredLicenses].sort(),
    passed: true
  },
  components
};
await writeFile(
  path.join(outputDirectory, "license-report.json"),
  `${JSON.stringify(licenseReport, null, 2)}\n`
);

const packageSpdxId = "SPDXRef-Package-showkit-cli";
const sbom = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: `${packageJson.name}-${packageJson.version}`,
  documentNamespace: `https://github.com/hyunghwan/showkit/sbom/${packageJson.version}`,
  creationInfo: {
    created: new Date(
      /^\d+$/.test(process.env.SOURCE_DATE_EPOCH ?? "")
        ? Number(process.env.SOURCE_DATE_EPOCH) * 1_000
        : Date.now()
    ).toISOString(),
    creators: ["Tool: showkit-release-metadata-0.1"]
  },
  packages: [
    {
      name: packageJson.name,
      SPDXID: packageSpdxId,
      versionInfo: packageJson.version,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: "MIT",
      licenseDeclared: "MIT",
      copyrightText: "Copyright (c) 2026 HyungHwan Byun"
    },
    ...components.map((component) => ({
      name: component.name,
      SPDXID: spdxId(component.name, component.version),
      versionInfo: component.version,
      downloadLocation: component.resolved ?? "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: component.license,
      licenseDeclared: component.license,
      copyrightText: "NOASSERTION"
    }))
  ],
  relationships: [
    {
      spdxElementId: "SPDXRef-DOCUMENT",
      relationshipType: "DESCRIBES",
      relatedSpdxElement: packageSpdxId
    },
    ...relationships.map((relationship) => {
      const parent = componentNodes.get(relationship.parentId);
      const child = componentNodes.get(relationship.childId);
      return {
        spdxElementId:
          relationship.parentId === "root"
            ? packageSpdxId
            : spdxId(parent.name, parent.version),
        relationshipType: "DEPENDS_ON",
        relatedSpdxElement: spdxId(child.name, child.version),
        comment: `Dependency scope: ${relationship.scope}`
      };
    })
  ]
};
await writeFile(
  path.join(outputDirectory, "sbom.spdx.json"),
  `${JSON.stringify(sbom, null, 2)}\n`
);

const compatibilityMatrix = {
  schemaVersion: "0.1",
  package: `${packageJson.name}@${packageJson.version}`,
  node: ["22", "24"],
  operatingSystems: ["ubuntu-latest", "macos-latest", "windows-latest"],
  playwright: packageJson.peerDependencies?.["@playwright/test"],
  playerBrowsers: ["chromium", "firefox", "webkit"],
  workflows: {
    pullRequest: ".github/workflows/ci.yml",
    release: ".github/workflows/release.yml"
  }
};
await writeFile(
  path.join(outputDirectory, "compatibility-matrix.json"),
  `${JSON.stringify(compatibilityMatrix, null, 2)}\n`
);

const expectedRepository = "https://github.com/hyunghwan/showkit.git";
if (
  packageJson.repository?.url !== expectedRepository ||
  packageJson.publishConfig?.access !== "public" ||
  packageJson.publishConfig?.provenance !== true
) {
  throw new Error("The package provenance configuration is incomplete.");
}
const provenanceReport = {
  schemaVersion: "0.1",
  package: `${packageJson.name}@${packageJson.version}`,
  repository: packageJson.repository,
  source: {
    ref: process.env.GITHUB_REF ?? null,
    sha: process.env.GITHUB_SHA ?? null
  },
  npm: {
    access: "public",
    trustedPublishing: "required",
    provenance: "required",
    command: "npm publish --provenance --access public",
    publicRepositoryRequired: true
  },
  artifactAttestation: {
    action: "actions/attest@v4",
    subject: "npm tarball",
    sbom: "release/sbom.spdx.json"
  },
  status: "configured",
  note:
    "This configuration report does not claim that publication or attestation has occurred."
};
await writeFile(
  path.join(outputDirectory, "provenance-report.json"),
  `${JSON.stringify(provenanceReport, null, 2)}\n`
);

const checksumCandidates = (await readdir(outputDirectory))
  .filter((name) => name !== "checksums.txt")
  .sort();
const checksums = await Promise.all(
  checksumCandidates.map(async (name) => {
    const contents = await readFile(path.join(outputDirectory, name));
    return `${createHash("sha256").update(contents).digest("hex")}  ${name}`;
  })
);
await writeFile(
  path.join(outputDirectory, "checksums.txt"),
  `${checksums.join("\n")}\n`
);

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    package: licenseReport.package,
    output: outputDirectory,
    files: [
      "license-report.json",
      "sbom.spdx.json",
      "compatibility-matrix.json",
      "provenance-report.json",
      "checksums.txt"
    ],
    licenses: components.map(({ name, version, license }) => ({ name, version, license }))
  })}\n`
);
