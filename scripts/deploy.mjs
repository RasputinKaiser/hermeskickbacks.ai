#!/usr/bin/env node

/**
 * Shared self-update manifest signing helpers.
 *
 * The extension verifies exactly this payload shape in src/update/client.ts.
 * Keep this tiny helper importable by tests so deploy-side signing and
 * client-side verification cannot drift silently.
 */
export function manifestSignedString(version, sha256, url, rollbackTo = "") {
  return `${version}\n${sha256}\n${url}\n${rollbackTo ?? ""}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [version, sha256, url, rollbackTo = ""] = process.argv.slice(2);
  if (!version || !sha256 || !url) {
    console.error("usage: node scripts/deploy.mjs <version> <sha256> <url> [rollback_to]");
    process.exit(2);
  }
  process.stdout.write(manifestSignedString(version, sha256, url, rollbackTo));
}
