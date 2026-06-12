#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const home = process.env.HOME || homedir();
const tuiRoot = process.env.HERMES_TUI_ROOT || join(home, ".hermes", "hermes-agent", "ui-tui");
const appChrome = join(tuiRoot, "src", "components", "appChrome.tsx");
const testFile = join(tuiRoot, "src", "__tests__", "appChromeStatusRule.test.tsx");
const build = !process.argv.includes("--no-build");

if (!existsSync(appChrome)) {
  console.error(`Hermes TUI app chrome not found: ${appChrome}`);
  process.exit(1);
}

patchFile(appChrome, (src) => {
  let out = src;

  out = replaceOnce(
    out,
    "import { Box, type ScrollBoxHandle, stringWidth, Text } from '@hermes/ink'",
    [
      "import { readFileSync } from 'node:fs'",
      "import { homedir } from 'node:os'",
      "import { join } from 'node:path'",
      "",
      "import { Box, Link, type ScrollBoxHandle, stringWidth, Text } from '@hermes/ink'",
    ].join("\n")
  );

  out = insertAfterOnce(
    out,
    "const HEART_COLORS = ['#ff5fa2', '#ff4d6d']",
    [
      "const KICKBACKS_AD_CACHE = join(homedir(), '.kickbacks', 'hermes-ad.json')",
      "const KICKBACKS_TUI_AD_MAX_AGE_MS = 10 * 60 * 1000",
    ].join("\n")
  );

  out = insertAfterOnce(
    out,
    "export const padVerb = (verb: string) => `${verb}…`.padEnd(VERB_PAD_LEN, ' ')",
    tickerHelpers()
  );

  out = insertAfterOnce(
    out,
    "import { stickyPromptFromViewport } from '../domain/viewport.js'",
    "import { openExternalUrl } from '../lib/openExternalUrl.js'"
  );

  out = replaceOnce(
    out,
    "  const verbSegment = showVerb ? ` ${padVerb(verb)}` : ''",
    [
      "  const ad = showVerb ? readKickbacksTickerAd(now) : null",
      "  const verbSegment = showVerb ? ` ${padVerb(verb)}` : ''",
    ].join("\n")
  );

  out = insertAfterOnce(
    out,
    "  const durationSegment = startedAt ? ` · ${fmtDuration(now - startedAt)}` : ''",
    [
      "",
      "  if (ad) {",
      "    return (",
      "      <Box flexDirection=\"row\">",
      "        <Text color={color}>{frame} </Text>",
      "        <KickbacksTickerAdText ad={ad} />",
      "        <Text color={color}>{durationSegment}</Text>",
      "      </Box>",
      "    )",
      "  }",
    ].join("\n")
  );

  return out;
});

if (existsSync(testFile)) {
  patchFile(testFile, (src) => {
    let out = src;

    out = insertBeforeOnce(
      out,
      "import React from 'react'",
      [
        "import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'",
        "import { tmpdir } from 'node:os'",
        "import { join } from 'node:path'",
        "",
      ].join("\n")
    );

    out = replaceOnce(
      out,
      "import { describe, expect, it, vi } from 'vitest'",
      "import { afterEach, describe, expect, it, vi } from 'vitest'"
    );

    out = insertBeforeOnce(
      out,
      "import { StatusRule } from '../components/appChrome.js'",
      [
        "import { renderToScreen } from '../../packages/hermes-ink/src/ink/render-to-screen.js'",
        "import { cellAt } from '../../packages/hermes-ink/src/ink/screen.js'",
        "",
      ].join("\n")
    );

    out = replaceOnce(
      out,
      "import { StatusRule } from '../components/appChrome.js'",
      "import { KickbacksTickerAdText, readKickbacksTickerAd, StatusRule } from '../components/appChrome.js'"
    );

    out = insertAfterOnce(out, "const baseProps = {", "");

    if (!out.includes("describe('Kickbacks TUI ad link'")) {
      const marker = "\ndescribe('StatusRule session count click target', () => {";
      out = out.replace(marker, `\n${tickerTests()}\n${marker.trimStart()}`);
    }

    if (!out.includes("const findLinkWithText =")) {
      const marker = "\n// Find the innermost element whose own (direct) text content includes the";
      out = out.replace(marker, `\n${findLinkHelper()}\n${marker.trimStart()}`);
    }

    if (!out.includes("const rowTextAndLinks =")) {
      const marker = "\nconst baseProps = {";
      out = out.replace(marker, `\n${rowTextAndLinksHelper()}\n${marker.trimStart()}`);
    }

    return out;
  });
}

if (build) {
  execFileSync("npm", ["run", "build"], { cwd: tuiRoot, stdio: "inherit" });
}

console.log("Hermes TUI clickable Kickbacks ads patched.");

function patchFile(file, fn) {
  const before = readFileSync(file, "utf8");
  const after = fn(before);
  if (after !== before) {
    writeFileSync(file, after, "utf8");
  }
}

function replaceOnce(src, needle, replacement) {
  if (src.includes(replacement)) return src;
  if (!src.includes(needle)) return src;
  return src.replace(needle, replacement);
}

function insertAfterOnce(src, needle, insertion) {
  if (!insertion || src.includes(insertion)) return src;
  if (!src.includes(needle)) return src;
  return src.replace(needle, `${needle}\n${insertion}`);
}

function insertBeforeOnce(src, needle, insertion) {
  if (src.includes(insertion.trim())) return src;
  if (!src.includes(needle)) return src;
  return src.replace(needle, `${insertion}${needle}`);
}

function tickerHelpers() {
  return [
    "",
    "interface KickbacksTickerAd {",
    "  text: string",
    "  url: string",
    "}",
    "",
    "type KickbacksAdClickEvent = {",
    "  stopImmediatePropagation: () => void",
    "}",
    "",
    "const cleanAdText = (value: unknown): string => {",
    "  if (typeof value !== 'string') {",
    "    return ''",
    "  }",
    "",
    "  return value.replace(/[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f]/g, '').trim()",
    "}",
    "",
    "const safeHttpUrl = (value: unknown): string => {",
    "  const raw = cleanAdText(value)",
    "",
    "  if (!raw) {",
    "    return ''",
    "  }",
    "",
    "  try {",
    "    const parsed = new URL(raw)",
    "    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : ''",
    "  } catch {",
    "    return ''",
    "  }",
    "}",
    "",
    "export const readKickbacksTickerAd = (",
    "  now = Date.now(),",
    "  cachePath = process.env.KICKBACKS_HERMES_TUI_AD_CACHE || KICKBACKS_AD_CACHE",
    "): KickbacksTickerAd | null => {",
    "  try {",
    "    const raw = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, unknown>",
    "    const text = cleanAdText(raw.ad_text)",
    "    const url = safeHttpUrl(raw.click_url)",
    "    const ts = typeof raw.ts === 'number' ? raw.ts : 0",
    "",
    "    if (!text || !url || !ts || now - ts > KICKBACKS_TUI_AD_MAX_AGE_MS || ts > now + 60_000) {",
    "      return null",
    "    }",
    "",
    "    return { text, url }",
    "  } catch {",
    "    return null",
    "  }",
    "}",
    "",
    "export function KickbacksTickerAdText({",
    "  ad,",
    "  onOpen = openExternalUrl",
    "}: {",
    "  ad: KickbacksTickerAd",
    "  onOpen?: (url: string) => boolean",
    "}) {",
    "  return (",
    "    <Box",
    "      flexDirection=\"row\"",
    "      onClick={(event: KickbacksAdClickEvent) => {",
    "        event.stopImmediatePropagation()",
    "        onOpen(ad.url)",
    "      }}",
    "    >",
    "      <Link url={ad.url}>{ad.text}</Link>",
    "    </Box>",
    "  )",
    "}",
  ].join("\n");
}

function findLinkHelper() {
  return [
    "const findLinkWithText = (node: ReactNodeLike, needle: string): React.ReactElement | null => {",
    "  if (node === null || node === undefined || typeof node === 'boolean') {",
    "    return null",
    "  }",
    "",
    "  if (Array.isArray(node)) {",
    "    for (const child of node) {",
    "      const found = findLinkWithText(child, needle)",
    "",
    "      if (found) {",
    "        return found",
    "      }",
    "    }",
    "",
    "    return null",
    "  }",
    "",
    "  if (!React.isValidElement(node)) {",
    "    return null",
    "  }",
    "",
    "  if (typeof node.props.url === 'string' && textContent(node).includes(needle)) {",
    "    return node",
    "  }",
    "",
    "  return findLinkWithText(node.props.children, needle)",
    "}",
  ].join("\n");
}

function rowTextAndLinksHelper() {
  return [
    "const rowTextAndLinks = (node: React.ReactElement, width = 100): { links: string[]; text: string } => {",
    "  const { screen } = renderToScreen(node, width)",
    "  let text = ''",
    "  const links: string[] = []",
    "",
    "  for (let row = 0; row < screen.height; row++) {",
    "    for (let col = 0; col < screen.width; col++) {",
    "      const cell = cellAt(screen, col, row)",
    "",
    "      if (!cell) {",
    "        continue",
    "      }",
    "",
    "      text += cell.char",
    "",
    "      if (cell.hyperlink) {",
    "        links.push(`${cell.char}:${cell.hyperlink}`)",
    "      }",
    "    }",
    "  }",
    "",
    "  return { links, text }",
    "}",
  ].join("\n");
}

function tickerTests() {
  return [
    "const tempDirs: string[] = []",
    "",
    "afterEach(() => {",
    "  delete process.env.KICKBACKS_HERMES_TUI_AD_CACHE",
    "",
    "  while (tempDirs.length) {",
    "    rmSync(tempDirs.pop()!, { recursive: true, force: true })",
    "  }",
    "})",
    "",
    "function writeAdCache(payload: Record<string, unknown>): string {",
    "  const dir = mkdtempSync(join(tmpdir(), 'hermes-tui-ad-'))",
    "  tempDirs.push(dir)",
    "  const path = join(dir, 'ad.json')",
    "  writeFileSync(path, JSON.stringify(payload), 'utf8')",
    "  return path",
    "}",
    "",
    "describe('Kickbacks TUI ad link', () => {",
    "  it('reads a fresh cached ad with a safe click URL', () => {",
    "    const now = Date.now()",
    "    const path = writeAdCache({",
    "      ad_text: 'Ito AI, someone has to test this slop',",
    "      click_url: 'https://kickbacks.ai/click',",
    "      ts: now",
    "    })",
    "",
    "    expect(readKickbacksTickerAd(now, path)).toEqual({",
    "      text: 'Ito AI, someone has to test this slop',",
    "      url: 'https://kickbacks.ai/click'",
    "    })",
    "  })",
    "",
    "  it('opens the ad click URL from the TUI click target', () => {",
    "    const open = vi.fn(() => true)",
    "    const element = KickbacksTickerAdText({",
    "      ad: {",
    "        text: 'Ito AI, someone has to test this slop',",
    "        url: 'https://kickbacks.ai/click'",
    "      },",
    "      onOpen: open",
    "    })",
    "",
    "    expect(typeof element.props.onClick).toBe('function')",
    "",
    "    const event = { stopImmediatePropagation: vi.fn() }",
    "    element.props.onClick(event)",
    "",
    "    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce()",
    "    expect(open).toHaveBeenCalledWith('https://kickbacks.ai/click')",
    "  })",
    "",
    "  it('renders the busy status ad cells with a click URL', () => {",
    "    const now = Date.now()",
    "    const path = writeAdCache({",
    "      ad_text: 'Ito AI, someone has to test this slop',",
    "      click_url: 'https://kickbacks.ai/click',",
    "      ts: now",
    "    })",
    "",
    "    process.env.KICKBACKS_HERMES_TUI_AD_CACHE = path",
    "",
    "    const { links, text } = rowTextAndLinks(",
    "      <StatusRule {...baseProps} busy status=\"working\" turnStartedAt={now - 1000} />,",
    "      100",
    "    )",
    "",
    "    expect(text).toContain('Ito AI, someone has to test this slop')",
    "    expect(links.some(link => link.endsWith(':https://kickbacks.ai/click'))).toBe(true)",
    "  })",
    "",
    "  it('renders the ad phrase as an Ink link', () => {",
    "    const element = KickbacksTickerAdText({",
    "      ad: {",
    "        text: 'Ito AI, someone has to test this slop',",
    "        url: 'https://kickbacks.ai/click'",
    "      }",
    "    })",
    "    const link = findLinkWithText(element, 'Ito AI, someone has to test this slop')",
    "",
    "    expect(link?.props.url).toBe('https://kickbacks.ai/click')",
    "    expect(textContent(element)).toContain('Ito AI, someone has to test this slop')",
    "  })",
    "})",
  ].join("\n");
}
