// Browser hints are advisory. In particular, "Intel Mac" also appears on Apple silicon.
/**
 * @typedef {{platform?: string, architecture?: string, bitness?: string, wow64?: boolean}} ComputerHints
 * @typedef {{userAgent?: string, platform?: string, maxTouchPoints?: number,
 * userAgentData?: {platform?: string, mobile?: boolean,
 * getHighEntropyValues?: (keys: string[]) => Promise<ComputerHints>}}} BrowserNavigator
 */
/** @param {BrowserNavigator} navigator @param {ComputerHints} hints */
export function detectComputer(navigator, hints = {}) {
  const ua = navigator.userAgent ?? "";
  const platform = hints.platform || navigator.userAgentData?.platform || navigator.platform || "";
  const mobile =
    navigator.userAgentData?.mobile ||
    /Android|iPhone|iPad|iPod/i.test(ua) ||
    (/Mac/i.test(platform) && (navigator.maxTouchPoints ?? 0) > 1);
  if (mobile) return { os: null, chip: null };
  const architecture = (hints.architecture ?? "").toLowerCase();
  if (/Mac/i.test(platform) || /Macintosh/i.test(ua)) {
    return { os: "macos", chip: "universal" };
  }
  if (/Win/i.test(platform) || /Windows/i.test(ua)) {
    return {
      os: "windows",
      chip:
        architecture === "arm" ? "arm64" : hints.bitness === "32" && !hints.wow64 ? "x86" : "x64",
    };
  }
  return { os: null, chip: null };
}

/** @param {BrowserNavigator} navigator @returns {Promise<ComputerHints>} */
export async function computerHints(navigator) {
  if (detectComputer(navigator).os !== "windows" || !navigator.userAgentData?.getHighEntropyValues)
    return {};
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  try {
    return await Promise.race([
      navigator.userAgentData.getHighEntropyValues(["architecture", "bitness", "wow64"]),
      new Promise((/** @type {(value: ComputerHints) => void} */ resolve) => {
        timer = setTimeout(() => resolve({}), 800);
      }),
    ]);
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}
