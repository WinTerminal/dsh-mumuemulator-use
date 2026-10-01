import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { run } from './proc.js';

/** The three uninstall hives the user asked for, in probe order. */
export const UNINSTALL_HIVES = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

const VALUE_TYPE = /\b(REG_SZ|REG_EXPAND_SZ|REG_MULTI_SZ|REG_DWORD|REG_QWORD|REG_BINARY|REG_NONE)\b/;

function valueOf(line) {
  const match = VALUE_TYPE.exec(line);
  if (match === null) return undefined;
  const name = line.slice(0, match.index).trim();
  if (name.length === 0) return undefined;
  return { name, value: line.slice(match.index + match[0].length).trim() };
}

/** Flat value map from a `reg query <key>` (no `/s`) reply. */
export function parseRegValues(text) {
  const values = {};
  for (const raw of text.split(/\r?\n/)) {
    const parsed = valueOf(raw.replace(/\s+$/, ''));
    if (parsed !== undefined) values[parsed.name] = parsed.value;
  }
  return values;
}

/** Key-path → values map from a `reg query <key> /s` reply. */
export function parseRegSubtree(text) {
  const entries = [];
  let current;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (line.trim().length === 0) continue;
    const key = /^(HKEY_[A-Z_]+\\[^\r\n]+)$/.exec(line.trim());
    if (key !== null) {
      current = { key: key[1], values: {} };
      entries.push(current);
      continue;
    }
    if (current === undefined) continue;
    const parsed = valueOf(line);
    if (parsed !== undefined) current.values[parsed.name] = parsed.value;
  }
  return entries;
}

/**
 * Strip the `,<index>` suffix and the quotes of a registry path value, then
 * keep only the executable for command lines that carry arguments.
 */
export function commandTarget(raw) {
  const trimmed = raw.trim();
  const quoted = /^"([^"]+)"(?:[\s,]+-?\d+)?\s*$/.exec(trimmed);
  if (quoted !== null) return quoted[1].trim();
  const bare = trimmed.replace(/,\s*-?\d+\s*$/, '').trim();
  const exe = /^(.+?\.exe)\b/i.exec(bare);
  return (exe === null ? bare : exe[1]).trim();
}

export function isMuMuRoot(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  if (!existsSync(candidate)) return false;
  return existsSync(join(candidate, 'MuMuManager.exe')) || existsSync(join(candidate, 'nx_main', 'MuMuManager.exe'));
}

/** MuMuManager.exe sits in the install root on some builds and under nx_main on others. */
export function managerIn(root) {
  const direct = join(root, 'MuMuManager.exe');
  if (existsSync(direct)) return direct;
  const nested = join(root, 'nx_main', 'MuMuManager.exe');
  if (existsSync(nested)) return nested;
  return undefined;
}

/** Walk up from a file or directory until a directory looks like a MuMu install root. */
export function rootFromPath(candidate) {
  let current = candidate;
  for (let depth = 0; depth < 5; depth += 1) {
    if (isMuMuRoot(current)) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

export async function probeRegistry(children, note, timeoutMs) {
  const hits = [];
  for (const hive of UNINSTALL_HIVES) {
    const result = await run(children, 'reg.exe', ['query', hive, '/s', '/v', 'DisplayName'], { timeoutMs });
    const text = result.stdoutText.trim();
    if (text.length === 0) {
      note(`reg query ${hive} returned nothing (exit ${result.code}): ${result.stderrText.trim().split(/\r?\n/)[0] ?? ''}`);
      continue;
    }
    for (const entry of parseRegSubtree(result.stdoutText)) {
      const displayName = entry.values.DisplayName ?? '';
      if (/mumu/i.test(displayName)) hits.push({ hive, key: entry.key, displayName });
    }
  }

  const detailed = [];
  for (const hit of hits) {
    const result = await run(children, 'reg.exe', ['query', hit.key], { timeoutMs });
    detailed.push({ ...hit, values: parseRegValues(result.stdoutText) });
  }
  return detailed;
}

/**
 * Try InstallLocation, DisplayIcon and UninstallString in that order, keeping
 * every raw value and the resolved root so the caller can report fallbacks.
 */
export function rootsFromRegistryEntry(entry) {
  const attempts = [];
  const attempt = (field, raw) => {
    if (raw === undefined || raw.length === 0) {
      attempts.push({ field, raw: raw ?? '', present: false });
      return;
    }
    const target = commandTarget(raw);
    attempts.push({ field, raw, present: true, target, root: rootFromPath(target) });
  };
  attempt('InstallLocation', entry.values.InstallLocation);
  attempt('DisplayIcon', entry.values.DisplayIcon);
  attempt('UninstallString', entry.values.UninstallString);
  return attempts;
}

function driveLetters() {
  const letters = [];
  for (let code = 65; code <= 90; code += 1) {
    const letter = `${String.fromCharCode(code)}:`;
    if (existsSync(`${letter}\\`)) letters.push(letter);
  }
  return letters;
}

function vendorDirs() {
  const dirs = [];
  for (const base of [process.env.ProgramFiles, process.env.ProgramW6432, process.env['ProgramFiles(x86)']]) {
    if (typeof base === 'string' && base.length > 0) dirs.push(join(base, 'Netease'));
  }
  for (const drive of driveLetters()) {
    dirs.push(`${drive}\\Netease`, `${drive}\\Program Files\\Netease`, `${drive}\\Program Files (x86)\\Netease`);
  }
  return [...new Set(dirs)];
}

/** Last-resort sweep of the vendor folders on every attached drive. */
export function scanCommonRoots() {
  const found = [];
  for (const dir of vendorDirs()) {
    if (!existsSync(dir)) continue;
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const candidate = join(dir, name);
      if (isMuMuRoot(candidate)) found.push(candidate);
    }
  }
  return [...new Set(found)];
}

function byVersion(a, b) {
  const left = a.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return a.localeCompare(b);
}

/** Prefer the version-matched adb shipped under nx_device, then nx_main, then PATH. */
export function findAdb(root) {
  const deviceRoot = join(root, 'nx_device');
  if (existsSync(deviceRoot)) {
    let names;
    try {
      names = readdirSync(deviceRoot);
    } catch {
      names = [];
    }
    const withAdb = names.filter((name) => existsSync(join(deviceRoot, name, 'shell', 'adb.exe'))).sort(byVersion);
    if (withAdb.length > 0) return join(deviceRoot, withAdb[withAdb.length - 1], 'shell', 'adb.exe');
  }
  for (const candidate of [join(root, 'nx_main', 'adb.exe'), join(root, 'adb.exe')]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function usableRoot(root) {
  if (typeof root !== 'string' || !isMuMuRoot(root)) return undefined;
  return root;
}

function readCache(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function cacheUsable(cached) {
  if (cached === null || typeof cached !== 'object') return false;
  if (usableRoot(cached.mumuRoot) === undefined) return false;
  if (typeof cached.mumuManagerPath !== 'string' || !existsSync(cached.mumuManagerPath)) return false;
  if (cached.adbPath !== undefined && cached.adbPath !== null && cached.adbPath !== 'adb' && !existsSync(cached.adbPath)) return false;
  return true;
}

function finish(root, adbPath, extra) {
  const mumuManagerPath = managerIn(root);
  return {
    mumuRoot: root,
    mumuManagerPath,
    adbPath: typeof adbPath === 'string' && adbPath.length > 0 ? adbPath : findAdb(root),
    adbFromPath: adbPath === 'adb',
    ...extra,
  };
}

/**
 * Resolve MuMuManager.exe and adb: explicit config first, then the cached
 * detection result, then the registry, then a filesystem sweep.
 */
export async function resolveMuMuPaths({ children, config, note, force = false }) {
  const cacheFile = config.cacheFile;
  const notes = [];
  const record = (message) => {
    notes.push(message);
    note?.(message);
  };

  const settleAdb = (resolved, label) => {
    if (config.adbPath.length > 0) {
      resolved.adbPath = config.adbPath;
      resolved.adbFromPath = false;
      return resolved;
    }
    if (typeof resolved.adbPath !== 'string' || resolved.adbPath.length === 0) {
      record(`${label}: no bundled adb found under nx_device; falling back to "adb" on PATH`);
      resolved.adbPath = 'adb';
      resolved.adbFromPath = true;
    }
    return resolved;
  };

  if (config.mumuManagerPath.length > 0 || config.mumuRoot.length > 0) {
    const root = config.mumuRoot.length > 0
      ? usableRoot(config.mumuRoot)
      : (() => {
        const manager = config.mumuManagerPath;
        return manager.length > 0 && existsSync(manager) ? rootFromPath(manager) : undefined;
      })();
    if (config.mumuRoot.length > 0 && root === undefined) {
      record(`configured mumuRoot "${config.mumuRoot}" is not a MuMu install directory`);
    }
    if (config.mumuManagerPath.length > 0 && root === undefined) {
      record(`configured mumuManagerPath "${config.mumuManagerPath}" does not exist`);
    }
    if (root !== undefined) {
      return settleAdb(finish(root, config.adbPath, { source: 'config', cacheFile, cacheHit: false, notes }), 'config');
    }
  }

  if (!force) {
    const cached = readCache(cacheFile);
    if (cacheUsable(cached)) {
      record(`cache hit: ${cacheFile}`);
      return settleAdb({ ...cached, source: 'cache', cacheFile, cacheHit: true, notes }, 'cache');
    }
    if (cached !== undefined) record(`cache at ${cacheFile} is stale; re-probing`);
  }

  const registryHits = await probeRegistry(children, record, 30000);
  const registryAttempts = registryHits.map((hit) => ({
    key: hit.key,
    displayName: hit.displayName,
    fields: rootsFromRegistryEntry(hit),
  }));
  for (const entry of registryAttempts) {
    record(`registry ${entry.key} (DisplayName="${entry.displayName}")`);
    for (const field of entry.fields) {
      record(`  ${field.field} = ${field.present ? JSON.stringify(field.raw) : '<absent>'} → ${field.root ?? 'unresolved'}`);
    }
  }

  let root;
  let source;
  for (const entry of registryAttempts) {
    const hit = entry.fields.find((field) => field.root !== undefined);
    if (hit !== undefined) {
      root = hit.root;
      source = `registry:${entry.key}#${hit.field}`;
      break;
    }
  }

  if (root === undefined) {
    const scanned = scanCommonRoots();
    record(`filesystem sweep found ${scanned.length} candidate(s): ${scanned.join(', ') || 'none'}`);
    if (scanned.length > 0) {
      root = scanned[0];
      source = 'scan';
    }
  }

  if (root === undefined) {
    throw new Error(
      'MuMu Player 12 was not found: the registry uninstall keys carry no usable path and the common install folders are empty. '
      + 'Set "mumuRoot" (or "mumuManagerPath") in the plugin config, or install MuMu Player 12.',
    );
  }

  const resolved = settleAdb(
    finish(root, undefined, { source, cacheFile, cacheHit: false, notes, registry: registryAttempts }),
    'detected',
  );
  if (resolved.mumuManagerPath === undefined) {
    throw new Error(`"${root}" has no MuMuManager.exe in the root or under nx_main\\; set "mumuManagerPath" in the plugin config.`);
  }
  try {
    writeFileSync(cacheFile, `${JSON.stringify({ ...resolved, notes: undefined, cachedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
    record(`cached to ${cacheFile}`);
  } catch (error) {
    record(`could not write the path cache: ${String(error)}`);
  }
  return resolved;
}
