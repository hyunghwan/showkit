type ParsedVersion = [major: number, minor: number, patch: number];

export function parseVersion(value: string): ParsedVersion | undefined {
  const match = value.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match?.[1]) return undefined;
  return [
    Number(match[1]),
    Number(match[2] ?? "0"),
    Number(match[3] ?? "0")
  ];
}

function compare(left: ParsedVersion, right: ParsedVersion): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function satisfiesVersionRange(version: string, range: string): boolean {
  const parsedVersion = parseVersion(version);
  if (!parsedVersion) return false;
  const constraints = range.trim().split(/\s+/).filter(Boolean);
  if (constraints.length === 0) return false;

  return constraints.every((constraint) => {
    const match = constraint.match(/^(>=|<=|>|<|=)?(.+)$/);
    const expected = match?.[2] ? parseVersion(match[2]) : undefined;
    if (!expected) return false;
    const comparison = compare(parsedVersion, expected);
    switch (match?.[1] ?? "=") {
      case ">=":
        return comparison >= 0;
      case "<=":
        return comparison <= 0;
      case ">":
        return comparison > 0;
      case "<":
        return comparison < 0;
      default:
        return comparison === 0;
    }
  });
}
