import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { Window } from "happy-dom";
import type { Element } from "happy-dom";
import {
  installerAsset,
  installerFilmBase,
  installerOpenStep,
  targets,
} from "../website/downloads/releases.js";
import { computerHints, detectComputer } from "../website/downloads/platform.js";
import type { BrowserNavigator, ComputerHints } from "../website/downloads/platform.js";

const asset = {
  name: "Goodfinds-macos-universal.pkg",
  state: "uploaded",
  size: 5_099_131,
  browser_download_url:
    "https://github.com/example/goodfinds/releases/download/v0.1.0/Goodfinds-macos-universal.pkg",
};
const release = {
  html_url: "https://github.com/example/goodfinds/releases/tag/v0.1.0",
  tag_name: "v0.1.0",
  assets: [asset],
  draft: false,
  prerelease: false,
};
void test("selects only a published installer for the selected computer", () => {
  assert.equal(installerAsset(release, "macos-universal"), asset);
  assert.equal(installerAsset(release, "windows-x64"), null);
  assert.equal(installerAsset(release, "unknown"), null);
  assert.equal(installerAsset(null, "macos-universal"), null);
  assert.equal(installerAsset({ ...release, draft: true }, "macos-universal"), null);
  assert.equal(installerAsset({ ...release, prerelease: true }, "macos-universal"), null);
  assert.equal(installerAsset({ ...release, assets: [null, {}, asset] }, "macos-universal"), asset);
  const withoutDigest = { ...asset, digest: null };
  assert.equal(
    installerAsset({ ...release, assets: [withoutDigest] }, "macos-universal"),
    withoutDigest,
  );
});

void test("never substitutes source archives, empty uploads or another repository", () => {
  for (const changes of [
    { name: "source.zip" },
    { name: "Goodfinds-macos-universal.dmg" },
    { name: "Goodfinds-macos-arm64.dmg" },
    { name: "Goodfinds-9.0.0-macos-universal.dmg" },
    { size: 0 },
    { state: "starter" },
    { browser_download_url: "https://example.org/installer.dmg" },
    { browser_download_url: "https://github.com/another/repo/releases/download/v1/installer.dmg" },
    { browser_download_url: "javascript:alert(1)" },
  ])
    assert.equal(
      installerAsset({ ...release, assets: [{ ...asset, ...changes }] }, "macos-universal"),
      null,
    );
});

const mac = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "MacIntel" };
void test("detects the OS and sends both Mac chips to the universal download", () => {
  assert.deepEqual(detectComputer(mac), { os: "macos", chip: "universal" });
  assert.deepEqual(detectComputer(mac, { architecture: "arm", bitness: "64" }), {
    os: "macos",
    chip: "universal",
  });
  assert.deepEqual(detectComputer(mac, { architecture: "x86", bitness: "64" }), {
    os: "macos",
    chip: "universal",
  });
  assert.deepEqual(detectComputer({ userAgent: "Windows NT 10.0; Win64; x64" }), {
    os: "windows",
    chip: "x64",
  });
  assert.deepEqual(
    detectComputer({ userAgent: "Windows NT 10.0" }, { architecture: "arm", bitness: "64" }),
    { os: "windows", chip: "arm64" },
  );
  assert.deepEqual(
    detectComputer({ userAgent: "Windows NT 10.0" }, { architecture: "x86", bitness: "32" }),
    { os: "windows", chip: "x86" },
  );
  assert.deepEqual(detectComputer({ ...mac, maxTouchPoints: 5 }), { os: null, chip: null });
  assert.deepEqual(detectComputer({ userAgent: "Android" }), { os: null, chip: null });
  assert.deepEqual(detectComputer({ platform: "Linux x86_64" }), { os: null, chip: null });
});
void test("Mac detection needs no CPU permission, and Windows tolerates refused hints", async () => {
  assert.deepEqual(await computerHints({}), {});
  assert.deepEqual(
    await computerHints({
      platform: "Win32",
      userAgentData: {
        getHighEntropyValues: async () => {
          throw new Error("not allowed");
        },
      },
    }),
    {},
  );
});

async function page(
  navigator: BrowserNavigator = mac,
  hints: Promise<ComputerHints> = Promise.resolve({}),
  pageRelease: typeof release = release,
) {
  const window = new Window({ url: "https://goodfinds.thirdtechapps.com/downloads/" });
  window.document.write(
    await readFile(new URL("../website/downloads/index.html", import.meta.url), "utf8"),
  );
  const source = await readFile(
    new URL("../website/downloads/downloads.js", import.meta.url),
    "utf8",
  );
  const downloads: string[] = [];
  window.document.addEventListener("click", (event) => {
    const link =
      event.target instanceof window.Element ? event.target.closest("a#download-button") : null;
    if (link instanceof window.HTMLAnchorElement && link.href && !event.defaultPrevented) {
      event.preventDefault();
      downloads.push(link.href);
    }
  });
  runInNewContext(source.replace(/^import[^\n]+\n/gm, ""), {
    document: window.document,
    HTMLElement: window.HTMLElement,
    HTMLAnchorElement: window.HTMLAnchorElement,
    HTMLVideoElement: window.HTMLVideoElement,
    navigator,
    release: pageRelease,
    installerAsset,
    installerFilmBase,
    installerOpenStep,
    targets,
    detectComputer,
    computerHints: () => hints,
    matchMedia: () => ({ matches: true, addEventListener() {} }),
    fetch: () => {
      throw new Error("Visitors should not need a GitHub API request");
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  function element<T extends Element>(selector: string, type: new () => T) {
    const found = window.document.querySelector(selector);
    assert.ok(found instanceof type);
    return found;
  }
  return {
    element,
    window,
    document: window.document,
    downloads,
    button: element("#download-button", window.HTMLAnchorElement),
  };
}
void test("a Mac gets an immediate universal download without a detected badge or chip choice", async () => {
  const p = await page(mac, Promise.resolve({ architecture: "arm", bitness: "64" }));
  try {
    assert.equal(p.button.href, asset.browser_download_url);
    assert.match(p.element("#open-step", p.window.HTMLElement).textContent, /\.pkg/);
    assert.doesNotMatch(p.element("#open-step", p.window.HTMLElement).textContent, /disk image/);
    assert.equal(
      p.element("#install-film source", p.window.HTMLElement).getAttribute("src"),
      "/media/install-goodfinds-package.mp4",
    );
    assert.equal(p.document.querySelector("[data-detected]"), null);
    assert.equal(p.document.querySelector('[name="chip"]'), null);
    p.button.click();
    assert.deepEqual(p.downloads, [asset.browser_download_url]);
    assert.match(
      p.element("#download-title", p.window.HTMLElement).textContent,
      /Thanks for downloading/,
    );
  } finally {
    await p.window.happyDOM.close();
  }
});
void test("unknown Mac CPU gets the same download, and unavailable Windows never downloads it by mistake", async () => {
  const p = await page();
  try {
    assert.equal(p.button.href, asset.browser_download_url);
    p.element('[name="os"][value="windows"]', p.window.HTMLInputElement).click();
    assert.equal(p.button.hasAttribute("href"), false);
    p.button.click();
    assert.equal(p.downloads.length, 0);
    assert.doesNotMatch(p.element("#download-title", p.window.HTMLElement).textContent, /Thanks/);
    p.element("#mac-alternative", p.window.HTMLElement).click();
    assert.equal(p.button.href, asset.browser_download_url);
  } finally {
    await p.window.happyDOM.close();
  }
});
void test("late device detection never replaces a user's manual selection", async () => {
  const { promise: pending, resolve: resolveHints } = Promise.withResolvers<ComputerHints>();
  const p = await page(mac, pending);
  try {
    p.element('[name="os"][value="windows"]', p.window.HTMLInputElement).click();
    resolveHints({ architecture: "arm", bitness: "64" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      p.element('[name="os"][value="windows"]', p.window.HTMLInputElement).checked,
      true,
    );
    assert.equal(p.button.hasAttribute("href"), false);
  } finally {
    await p.window.happyDOM.close();
  }
});
