import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export type DeviceBrowser = { id: string; name: string };

const CACHE_MILLISECONDS = 10 * 60_000;
const COMMAND_TIMEOUT_MILLISECONDS = 6_000;

// NSWorkspace resolves the URL's current default handler; it does not open the URL.
// Using an unregistered domain avoids selecting an installed universal-link app.
const MAC_BROWSER_QUERY =
  'import AppKit\nimport Foundation\nif let address = URL(string: "https://example.invalid"),\n   let appURL = NSWorkspace.shared.urlForApplication(toOpen: address),\n   let bundle = Bundle(url: appURL),\n   let identifier = bundle.bundleIdentifier {\n    let name = (bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)\n        ?? (bundle.object(forInfoDictionaryKey: "CFBundleName") as? String)\n        ?? appURL.deletingPathExtension().lastPathComponent\n    if let data = try? JSONSerialization.data(withJSONObject: ["id": identifier, "name": name]),\n       let json = String(data: data, encoding: .utf8) {\n        print(json)\n    }\n}';

function containsControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

export function parseDeviceBrowser(output: string): DeviceBrowser | null {
  if (output.length > 4_096) return null;
  try {
    const value: unknown = JSON.parse(output);
    if (typeof value !== "object" || value === null || !("id" in value) || !("name" in value))
      return null;
    const { id, name } = value;
    if (
      typeof id !== "string" ||
      typeof name !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id) ||
      !name.trim() ||
      name.length > 120 ||
      containsControlCharacters(name)
    )
      return null;
    return { id, name: name.trim() };
  } catch {
    return null;
  }
}

type CommandReader = (command: string, args: readonly string[]) => Promise<string | null>;

function readCommand(command: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolveOutput) => {
    execFile(
      command,
      [...args],
      {
        encoding: "utf8",
        timeout: COMMAND_TIMEOUT_MILLISECONDS,
        maxBuffer: 8_192,
        windowsHide: true,
      },
      (error, stdout) => resolveOutput(error ? null : stdout),
    );
  });
}

function executableExists(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

type DeviceBrowserReaderOptions = {
  platform?: NodeJS.Platform;
  now?: () => number;
  run?: CommandReader;
  hasExecutable?: (path: string) => boolean;
};

// One reader has one bounded cache, including unavailable results. Concurrent state
// requests share a read, so opening or polling the panel never starts repeated compilers.
export function createDeviceBrowserReader(options: DeviceBrowserReaderOptions = {}) {
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  const run = options.run ?? readCommand;
  const hasExecutable = options.hasExecutable ?? executableExists;
  let cache: { value: DeviceBrowser | null; expiresAt: number } | null = null;
  let pending: Promise<DeviceBrowser | null> | null = null;

  const read = async (): Promise<DeviceBrowser | null> => {
    if (platform !== "darwin" || !hasExecutable("/usr/bin/xcode-select")) return null;
    const developerPath = (await run("/usr/bin/xcode-select", ["-p"]))?.trim();
    if (
      !developerPath ||
      !isAbsolute(developerPath) ||
      developerPath.length > 2_048 ||
      containsControlCharacters(developerPath)
    )
      return null;
    // Invoke an installed runtime directly. The system Swift shim can prompt to
    // install developer tools on machines without a runtime, so it is never used.
    const swift = [
      resolve(developerPath, "Toolchains/XcodeDefault.xctoolchain/usr/bin/swift"),
      resolve(developerPath, "usr/bin/swift"),
    ].find(hasExecutable);
    if (!swift) return null;
    const output = await run(swift, ["-e", MAC_BROWSER_QUERY]);
    return output === null ? null : parseDeviceBrowser(output);
  };

  return (): Promise<DeviceBrowser | null> => {
    if (cache && now() < cache.expiresAt) return Promise.resolve(cache.value);
    if (pending) return pending;
    pending = read()
      .catch(() => null)
      .then((value) => {
        cache = { value, expiresAt: now() + CACHE_MILLISECONDS };
        return value;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
}

// macOS metadata only. Other platforms return null; a detected default handler
// does not imply that the host can control that browser or access its sessions.
export const getDeviceBrowser = createDeviceBrowserReader();
