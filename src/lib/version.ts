export type VersionRelationship =
  | "equal"
  | "server-newer"
  | "server-older"
  | "different";

export type VersionNotice = {
  updateAvailable: boolean;
  serverRestartRequired: boolean;
  updateVersion: string | null;
  updateNotes: string[];
};

type ParsedSemver = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseSemver(version: string): ParsedSemver | null {
  const match = SEMVER_PATTERN.exec(version);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return {
    major,
    minor,
    patch,
    prerelease: match[4]?.split(".") ?? [],
  };
}

function comparePrerelease(left: string[], right: string[]): -1 | 0 | 1 {
  if (left.length === 0 || right.length === 0) {
    if (left.length === right.length) return 0;
    return left.length === 0 ? 1 : -1;
  }

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const leftIdentifier = left[index];
    const rightIdentifier = right[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;

    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      const leftNumber = leftIdentifier.replace(/^0+(?=\d)/, "");
      const rightNumber = rightIdentifier.replace(/^0+(?=\d)/, "");
      if (leftNumber.length !== rightNumber.length) {
        return leftNumber.length < rightNumber.length ? -1 : 1;
      }
      if (leftNumber !== rightNumber) return leftNumber < rightNumber ? -1 : 1;
      continue;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

function compareSemver(left: ParsedSemver, right: ParsedSemver): -1 | 0 | 1 {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

export function classifyVersionRelationship(
  clientVersion: string,
  serverVersion: string,
): VersionRelationship {
  if (clientVersion === serverVersion) return "equal";
  const client = parseSemver(clientVersion);
  const server = parseSemver(serverVersion);
  if (client === null || server === null) return "different";
  const comparison = compareSemver(server, client);
  if (comparison === 0) return "equal";
  return comparison > 0 ? "server-newer" : "server-older";
}

export function deriveVersionNotice(
  clientVersion: string,
  serverVersion: string,
  serverNotes: string[] = [],
): VersionNotice {
  const relationship = classifyVersionRelationship(clientVersion, serverVersion);
  if (relationship === "equal") {
    return {
      updateAvailable: false,
      serverRestartRequired: false,
      updateVersion: null,
      updateNotes: [],
    };
  }
  if (relationship === "server-older") {
    return {
      updateAvailable: false,
      serverRestartRequired: true,
      updateVersion: serverVersion,
      updateNotes: [],
    };
  }
  return {
    updateAvailable: true,
    serverRestartRequired: false,
    updateVersion: serverVersion,
    updateNotes: serverNotes,
  };
}
