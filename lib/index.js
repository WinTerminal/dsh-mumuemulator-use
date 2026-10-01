import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';
import { parseJson, run } from './proc.js';
import { resolveMuMuPaths } from './locate.js';

export const name = 'dsh-mumuemulator-use';

export const inject = ['tools'];

const Config = z.object({
  mumuRoot: z.string().default(''),
  mumuManagerPath: z.string().default(''),
  adbPath: z.string().default(''),
  cacheFile: z.string().default(''),
  commandTimeoutMs: z.number().default(120000),
  bootTimeoutMs: z.number().default(300000),
  adbConnectTimeoutMs: z.number().default(60000),
  screenshotIncludeImage: z.boolean().default(true),
});

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
// The cache must not live inside the package: `pnpm install` replaces that tree.
// A profile links the package in under `node_modules`, so climb back out to the
// profile directory and keep the file beside it.
const DEFAULT_CACHE_FILE = (() => {
  for (const marker of [`${sep}node_modules${sep}`, `${sep}plugins${sep}`]) {
    const at = PACKAGE_DIR.lastIndexOf(marker);
    if (at > 0) return join(PACKAGE_DIR.slice(0, at), 'dsh-mumu-paths.json');
  }
  return join(PACKAGE_DIR, 'dsh-mumu-paths.json');
})();

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const KEY_EVENTS = ['go_back', 'go_home', 'go_task', 'key_enter', 'key_delete', 'key_space', 'volume_up', 'volume_down', 'volume_mute'];

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
};

const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string' },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    name: { type: 'string' },
  },
  required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
};

const INSTANCE_PROP = {
  type: 'string',
  description: 'MuMu instance index (vmindex), for example "1". Omit it to auto-select when exactly one instance exists.',
};

function parameters(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

function normalizeConfig(config) {
  return {
    mumuRoot: config.mumuRoot ?? '',
    mumuManagerPath: config.mumuManagerPath ?? '',
    adbPath: config.adbPath ?? '',
    cacheFile: config.cacheFile === undefined || config.cacheFile.length === 0 ? DEFAULT_CACHE_FILE : config.cacheFile,
    commandTimeoutMs: config.commandTimeoutMs ?? 120000,
    bootTimeoutMs: config.bootTimeoutMs ?? 300000,
    adbConnectTimeoutMs: config.adbConnectTimeoutMs ?? 60000,
    screenshotIncludeImage: config.screenshotIncludeImage ?? true,
  };
}

function describeInstance(entry) {
  const state = entry.is_android_started === true
    ? 'running'
    : entry.is_process_started === true ? `starting (${entry.player_state ?? 'unknown'})` : 'stopped';
  const endpoint = typeof entry.adb_port === 'number' ? ` adb=${entry.adb_host_ip ?? '127.0.0.1'}:${entry.adb_port}` : '';
  const pid = typeof entry.pid === 'number' ? ` pid=${entry.pid}` : '';
  return `instance ${entry.index}  "${entry.name ?? 'unnamed'}"  android ${entry.android_version ?? '?'}  ${state}${endpoint}${pid}`;
}

function summarizeInstances(all) {
  const list = Object.values(all).filter((entry) => entry !== null && typeof entry === 'object');
  if (list.length === 0) return 'MuMu Player 12 reports no emulator instances.';
  const running = list.filter((entry) => entry.is_android_started === true).length;
  return [`${list.length} instance(s), ${running} running`, ...list.map(describeInstance)].join('\n');
}

function formatResult(payload) {
  if (typeof payload === 'string') return payload.trim().length === 0 ? '(no output)' : payload.trim();
  return JSON.stringify(payload, null, 2);
}

function normalizePng(buffer) {
  if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return buffer;
  const repaired = Buffer.from(buffer.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
  return repaired.subarray(0, 8).equals(PNG_SIGNATURE) ? repaired : buffer;
}

function pngSize(buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      const error = new Error('tool call aborted');
      error.name = 'AbortError';
      reject(error);
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function apply(ctx, config = {}) {
  const settings = normalizeConfig(config);
  const children = new Set();

  const log = (level, message) => {
    const logger = ctx.logger;
    const sink = logger?.[level];
    if (typeof sink === 'function') sink.call(logger, `dsh-mumuemulator-use: ${message}`);
  };
  const note = (message) => log('info', message);
  const warn = (message) => log('warn', message);

  let pending;
  const paths = (force = false) => {
    if (force || pending === undefined) {
      pending = resolveMuMuPaths({ children, config: settings, note, force }).catch((error) => {
        pending = undefined;
        throw error;
      });
    }
    return pending;
  };

  paths()
    .then((found) => note(`emulator at ${found.mumuRoot} (${found.source}); MuMuManager=${found.mumuManagerPath}; adb=${found.adbPath}`))
    .catch((error) => warn(`path detection failed: ${error.message}`));

  ctx.effect(() => () => {
    for (const child of children) {
      try {
        child.kill('SIGKILL');
      } catch {
        // the process already exited
      }
    }
    children.clear();
  });

  const callManager = async (args, exec, options = {}) => {
    const found = await paths();
    const result = await run(children, found.mumuManagerPath, args, {
      timeoutMs: options.timeoutMs ?? settings.commandTimeoutMs,
      signal: exec?.signal,
    });
    const text = result.stdoutText.trim();
    const payload = parseJson(text);
    if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
      const errcode = payload.errcode;
      if (typeof errcode === 'number' && errcode !== 0 && errcode !== 200) {
        throw new Error(`MuMuManager ${args.join(' ')} reported errcode ${errcode}: ${payload.errmsg ?? '(no message)'}`);
      }
      return payload;
    }
    if (text.length === 0 && result.code !== 0) {
      const detail = result.stderrText.trim();
      throw new Error(`MuMuManager ${args.join(' ')} exited with code ${result.code}${detail.length > 0 ? `: ${detail}` : ''}`);
    }
    return text;
  };

  // `info -v <one>` replies with the entry itself; `info -v all` replies with a map keyed by index.
  const entryOf = (payload, instance) => {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
    if (payload.index !== undefined) return payload;
    const direct = payload[instance];
    if (direct !== null && typeof direct === 'object' && !Array.isArray(direct)) return direct;
    const first = Object.values(payload)
      .find((value) => value !== null && typeof value === 'object' && !Array.isArray(value));
    return first ?? null;
  };

  const infoAll = async (exec) => {
    const payload = await callManager(['info', '-v', 'all'], exec);
    if (payload === null || typeof payload !== 'object') {
      throw new Error(`MuMuManager info returned an unexpected reply: ${JSON.stringify(payload)}`);
    }
    return payload;
  };

  const pickInstance = async (requested, exec) => {
    const asked = requested === undefined || requested === null ? '' : String(requested).trim();
    if (asked.length > 0 && asked !== 'auto') return asked;
    const all = await infoAll(exec);
    const indexes = Object.values(all)
      .filter((entry) => entry !== null && typeof entry === 'object' && entry.index !== undefined)
      .map((entry) => String(entry.index));
    if (indexes.length === 0) {
      throw new Error('MuMu Player 12 has no emulator instance; create one with mumu_instance { action: "create" }.');
    }
    if (indexes.length === 1) return indexes[0];
    const names = Object.values(all).map((entry) => `${entry.index} (${entry.name ?? 'unnamed'})`).join(', ');
    throw new Error(`several MuMu instances exist — pass "instance" explicitly. Available: ${names}`);
  };

  const endpointOf = async (instance, exec) => {
    const info = await callManager(['info', '-v', instance], exec);
    const entry = entryOf(info, instance);
    if (entry === null) {
      throw new Error(`MuMu instance "${instance}" was not found; run mumu_list_instances for the available indexes.`);
    }
    if (entry.is_android_started !== true) {
      throw new Error(
        `MuMu instance "${instance}" is not running Android yet (player_state=${entry.player_state ?? 'stopped'}). `
        + `Start it with mumu_instance { action: "launch", instance: "${instance}" }.`,
      );
    }
    const host = typeof entry.adb_host_ip === 'string' && entry.adb_host_ip.length > 0 ? entry.adb_host_ip : '127.0.0.1';
    const port = entry.adb_port;
    if (typeof port !== 'number' || port <= 0) {
      throw new Error(`MuMu instance "${instance}" reports no adb port; wait for the boot to finish and retry.`);
    }
    return { host, port, serial: `${host}:${port}`, entry };
  };

  // MuMuManager validates the instance index for most subcommands, but
  // `show_window`, `hide_window` and `tool` answer errcode 0 for an index that
  // does not exist, so those paths ask for the roster themselves.
  const assertInstance = async (instance, exec) => {
    const info = await callManager(['info', '-v', instance], exec);
    if (entryOf(info, instance) === null) {
      throw new Error(`MuMu instance "${instance}" was not found; run mumu_list_instances for the available indexes.`);
    }
  };

  // MuMuManager's `sh` prints nothing of its own and still exits 0 when the guest
  // command fails, so the guest exit code is recovered with a trailing marker on
  // its own line: `; ` would be a syntax error after a trailing `&`. A bare named
  // key event is the one form MuMuManager intercepts by itself.
  const SH_EXIT_MARK = 'MUMU_SH_EXIT:';
  const shCommandWithExit = (command) => {
    const raw = command.trim();
    return KEY_EVENTS.includes(raw) ? raw : `${raw}\necho "${SH_EXIT_MARK}$?"`;
  };
  const callShWithExit = async (instance, command, exec, options = {}) => {
    const payload = await callSh(instance, shCommandWithExit(command), exec, options);
    if (typeof payload !== 'string') return { payload, output: '', code: null };
    const match = /\r?\n?MUMU_SH_EXIT:(\d+)\s*$/.exec(payload);
    if (match === null) return { payload, output: payload, code: null };
    return { payload, output: payload.slice(0, match.index), code: Number(match[1]) };
  };
  const formatShResult = ({ payload, output, code }) => {
    if (typeof payload !== 'string') return formatResult(payload);
    const body = output.trim();
    const status = code === null ? 'guest exit code unavailable' : `guest exit code ${code}`;
    return body.length === 0 ? `no output (${status}).` : `${body}\n[${status}]`;
  };

  const callAdb = async (args, exec, options = {}) => {
    const found = await paths();
    return run(children, found.adbPath, args, {
      timeoutMs: options.timeoutMs ?? settings.commandTimeoutMs,
      signal: exec?.signal,
      maxBytes: options.maxBytes,
    });
  };

  const waitForBoot = async (instance, exec) => {
    const deadline = Date.now() + settings.bootTimeoutMs;
    for (;;) {
      const info = await callManager(['info', '-v', instance], exec, { timeoutMs: 30000 });
      const entry = entryOf(info, instance);
      if (entry?.is_android_started === true) return entry;
      if (Date.now() >= deadline) {
        throw new Error(
          `MuMu instance "${instance}" did not finish booting within ${Math.round(settings.bootTimeoutMs / 1000)} s `
          + `(player_state=${entry?.player_state ?? 'unknown'}${entry?.launch_err_msg ? `, ${entry.launch_err_msg}` : ''}).`,
        );
      }
      await sleep(2000, exec?.signal);
    }
  };

  const control = (instance, subcommand) => ['control', '-v', instance, ...subcommand];
  // `sh` is a top-level MuMuManager subcommand, not a child of `control`.
  const callSh = (instance, command, exec, options = {}) =>
    callManager(['sh', '-v', instance, '-c', command], exec, options);

  ctx.tools.register({
    name: 'mumu_env',
    description:
      'Show which MuMu Player 12 installation the other mumu_* tools drive: MuMuManager.exe path, adb path, how they were found '
      + '(config override / cache / registry / filesystem sweep), the raw registry field values that were tried, the path cache file, '
      + 'and the MuMuManager version. Use refresh:true to discard the cached paths and re-detect from the registry and disk.',
    parameters: parameters({
      refresh: { type: 'boolean', description: 'Ignore the path cache and re-run registry + filesystem detection.' },
    }),
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const found = await paths(args.refresh === true);
      const version = await callManager(['version'], exec, { timeoutMs: 30000 });
      const lines = [
        `MuMuManager.exe : ${found.mumuManagerPath}`,
        `MuMu root       : ${found.mumuRoot}`,
        `adb             : ${found.adbPath}${found.adbFromPath === true ? '  (from PATH)' : ''}`,
        `resolved via    : ${found.source}${found.cacheHit === true ? ' (cached)' : ''}`,
        `cache file      : ${found.cacheFile}`,
        `version         : ${typeof version === 'string' ? version : JSON.stringify(version)}`,
      ];
      if (Array.isArray(found.registry) && found.registry.length > 0) {
        lines.push('', 'registry matches:');
        for (const entry of found.registry) {
          lines.push(`  ${entry.key}  DisplayName="${entry.displayName}"`);
          for (const field of entry.fields) {
            lines.push(`    ${field.field}: ${field.present ? field.raw : '<absent>'}${field.root ? `  ->  ${field.root}` : ''}`);
          }
        }
      }
      if (Array.isArray(found.notes) && found.notes.length > 0) {
        lines.push('', 'detection log:', ...found.notes.map((line) => `  ${line}`));
      }
      return lines.join('\n');
    },
  });

  ctx.tools.register({
    name: 'mumu_list_instances',
    description:
      'List every MuMu Player 12 emulator instance with its index, name, Android version, running state, adb endpoint and pid. '
      + 'The index shown here is the "instance" value the other mumu_* tools take.',
    parameters: parameters({}),
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const all = await infoAll(exec);
      return `${summarizeInstances(all)}\n\n${JSON.stringify(all, null, 2)}`;
    },
  });

  ctx.tools.register({
    name: 'mumu_instance',
    description:
      'Manage MuMu Player 12 emulator instances: launch (boot the instance, optionally straight into a package), shutdown, restart, '
      + 'create new instances, delete one, rename one, show or hide its window. Boot waiting is handled for you: "launch" returns once '
      + 'Android has finished starting unless wait:false is passed.',
    parameters: parameters({
      action: {
        type: 'string',
        enum: ['launch', 'shutdown', 'restart', 'create', 'delete', 'rename', 'show_window', 'hide_window'],
        description: 'launch=start and wait for Android; shutdown=stop; restart=reboot; create=add new instance(s); delete=remove one; rename=set its name; show_window/hide_window=toggle the emulator window.',
      },
      instance: INSTANCE_PROP,
      package: { type: 'string', description: 'For action "launch": bundle id to open right after boot, e.g. com.android.settings.' },
      name: { type: 'string', description: 'For action "rename": the new instance name.' },
      count: { type: 'integer', description: 'For action "create": how many instances to add (default 1).' },
      wait: { type: 'boolean', description: 'For action "launch": wait until Android is started (default true).' },
    }, ['action']),
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      switch (args.action) {
        case 'create': {
          const count = Number.isInteger(args.count) && args.count > 0 ? args.count : 1;
          return `create ${count} instance(s)\n${formatResult(await callManager(['create', '-n', String(count)], exec, { timeoutMs: settings.bootTimeoutMs }))}`;
        }
        case 'delete': {
          const instance = await pickInstance(args.instance, exec);
          return `delete instance ${instance}\n${formatResult(await callManager(['delete', '-v', instance], exec))}`;
        }
        case 'rename': {
          if (typeof args.name !== 'string' || args.name.trim().length === 0) {
            throw new Error('rename needs a non-empty "name".');
          }
          const instance = await pickInstance(args.instance, exec);
          return `rename instance ${instance} -> "${args.name.trim()}"\n${formatResult(await callManager(['rename', '-v', instance, '-n', args.name.trim()], exec))}`;
        }
        case 'show_window':
        case 'hide_window': {
          const instance = await pickInstance(args.instance, exec);
          await assertInstance(instance, exec);
          const reply = await callManager(control(instance, [args.action]), exec);
          return `${args.action} instance ${instance}\n${formatResult(reply)}`;
        }
        default: {
          const instance = await pickInstance(args.instance, exec);
          if (args.action === 'launch') {
            const subcommand = typeof args.package === 'string' && args.package.trim().length > 0
              ? ['launch', '-pkg', args.package.trim()]
              : ['launch'];
            const reply = formatResult(await callManager(control(instance, subcommand), exec, { timeoutMs: settings.bootTimeoutMs }));
            if (args.wait === false) return `launch instance ${instance}\n${reply}`;
            const entry = await waitForBoot(instance, exec);
            return `launch instance ${instance}\n${reply}\n\n${describeInstance(entry)}`;
          }
          const reply = formatResult(await callManager(control(instance, [args.action]), exec, {
            timeoutMs: args.action === 'restart' ? settings.bootTimeoutMs : settings.commandTimeoutMs,
          }));
          return `${args.action} instance ${instance}\n${reply}`;
        }
      }
    },
  });

  function control_(instance, subcommand, exec) {
    return callManager(control(instance, subcommand), exec);
  }

  ctx.tools.register({
    name: 'mumu_app',
    description:
      'Manage apps inside a MuMu Player 12 instance: list the installed packages, inspect one package, launch or close an app, '
      + 'install an APK/APKS/XAPK from the host, or uninstall a package.',
    parameters: parameters({
      action: {
        type: 'string',
        enum: ['list', 'info', 'launch', 'close', 'install', 'uninstall'],
        description: 'list=installed packages; info=details for one package; launch/close=start or stop it; install=install an archive from the host; uninstall=remove a package.',
      },
      instance: INSTANCE_PROP,
      package: { type: 'string', description: 'Android package name, e.g. com.android.settings. Required for info, launch, close and uninstall.' },
      apk: { type: 'string', description: 'Absolute Windows path to a .apk / .apks / .xapk file. Required for install.' },
    }, ['action']),
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const instance = await pickInstance(args.instance, exec);
      const needsPackage = args.action !== 'list' && args.action !== 'install';
      if (needsPackage && (typeof args.package !== 'string' || args.package.trim().length === 0)) {
        throw new Error(`action "${args.action}" needs a "package".`);
      }
      if (args.action === 'install' && (typeof args.apk !== 'string' || args.apk.trim().length === 0)) {
        throw new Error('action "install" needs an "apk" path.');
      }
      const pkg = typeof args.package === 'string' ? args.package.trim() : '';
      const apk = typeof args.apk === 'string' ? args.apk.trim() : '';
      // built through a switch: an object literal would evaluate every branch,
      // so a missing "apk" would throw for the unrelated list/info actions
      const argv = {
        list: ['app', 'info', '-i'],
        info: ['app', 'info', '-pkg', pkg],
        launch: ['app', 'launch', '-pkg', pkg],
        close: ['app', 'close', '-pkg', pkg],
        install: ['app', 'install', '-apk', apk],
        uninstall: ['app', 'uninstall', '-pkg', pkg],
      }[args.action];
      const payload = await callManager(control(instance, argv), exec, {
        timeoutMs: args.action === 'install' ? settings.bootTimeoutMs : settings.commandTimeoutMs,
      });
      if (args.action === 'list') {
        const entries = Object.entries(payload).filter(([key, value]) => key !== 'active' && value !== null && typeof value === 'object');
        const head = `instance ${instance}: ${entries.length} installed package(s), foreground=${payload.active ?? 'unknown'}`;
        return `${head}\n\n${JSON.stringify(payload, null, 2)}`;
      }
      return `${args.action} ${args.action === 'install' ? apk : pkg} on instance ${instance}\n${formatResult(payload)}`;
    },
  });

  ctx.tools.register({
    name: 'mumu_ui',
    description:
      'Drive the touch screen and buttons of a MuMu Player 12 instance. Coordinates are pixels in the emulator framebuffer as seen in a '
      + 'mumu_screenshot image (origin top-left). key sends an Android key event by name.',
    parameters: parameters({
      action: {
        type: 'string',
        enum: ['tap', 'swipe', 'long_press', 'text', 'key'],
        description: 'tap=click a point; swipe=drag from one point to another; long_press=hold a point; text=type a string; key=press a named key.',
      },
      instance: INSTANCE_PROP,
      x: { type: 'integer', description: 'X pixel for tap / swipe start / long_press.' },
      y: { type: 'integer', description: 'Y pixel for tap / swipe start / long_press.' },
      x2: { type: 'integer', description: 'X pixel of the swipe end point.' },
      y2: { type: 'integer', description: 'Y pixel of the swipe end point.' },
      duration: { type: 'integer', description: 'Gesture duration in milliseconds (swipe default 300, long_press default 800).' },
      text: { type: 'string', description: 'Text to type for action "text". ASCII is reliable; the emulator drops characters it cannot map.' },
      key: { type: 'string', enum: KEY_EVENTS, description: 'Key name for action "key".' },
    }, ['action']),
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const instance = await pickInstance(args.instance, exec);
      const point = (axis) => {
        const value = args[axis];
        if (!Number.isInteger(value)) throw new Error(`action "${args.action}" needs an integer "${axis}".`);
        return String(value);
      };
      const duration = Number.isInteger(args.duration) && args.duration > 0 ? args.duration : undefined;
      let argv;
      let summary;
      switch (args.action) {
        case 'tap':
          argv = ['tool', 'cmd', '-c', `input tap ${point('x')} ${point('y')}`];
          summary = `tap (${args.x}, ${args.y})`;
          break;
        case 'swipe':
          argv = ['tool', 'cmd', '-c', `input swipe ${point('x')} ${point('y')} ${point('x2')} ${point('y2')} ${duration ?? 300}`];
          summary = `swipe (${args.x}, ${args.y}) -> (${args.x2}, ${args.y2}) in ${duration ?? 300} ms`;
          break;
        case 'long_press':
          argv = ['tool', 'cmd', '-c', `input swipe ${point('x')} ${point('y')} ${point('x')} ${point('y')} ${duration ?? 800}`];
          summary = `long press (${args.x}, ${args.y}) for ${duration ?? 800} ms`;
          break;
        case 'text':
          if (typeof args.text !== 'string' || args.text.length === 0) throw new Error('action "text" needs a non-empty "text".');
          argv = ['tool', 'cmd', '-c', 'input_text', '-t', args.text];
          summary = `type ${JSON.stringify(args.text)}`;
          break;
        default: {
          if (typeof args.key !== 'string' || !KEY_EVENTS.includes(args.key)) {
            throw new Error(`action "key" needs one of: ${KEY_EVENTS.join(', ')}.`);
          }
          const payload = await callShWithExit(instance, args.key, exec);
          return `key ${args.key} on instance ${instance}\n${formatShResult(payload)}`;
        }
      }
      await assertInstance(instance, exec);
      const payload = await callManager(control(instance, argv), exec);
      return `${summary} on instance ${instance}\n${formatResult(payload)}`;
    },
  });

  ctx.tools.register({
    name: 'mumu_shell',
    description:
      'Run a shell command inside the Android system of a MuMu Player 12 instance and return its stdout, e.g. "getprop ro.product.cpu.abi", '
      + '"wm size", "pm list packages -3", "dumpsys battery". Runs through MuMuManager\'s sh subcommand, so no adb server setup is '
      + 'needed. A trailing marker on its own line recovers the guest exit code, reported back as "[guest exit code N]", so a command '
      + 'that fails silently is still visible as a failure. When the command line cannot be parsed (an unbalanced quote) the marker is '
      + 'never reached and the exit code reads "unavailable"; a bare key name such as "go_home" is passed through unchanged.',
    parameters: parameters({
      command: { type: 'string', description: 'The shell command line to run inside the instance.' },
      instance: INSTANCE_PROP,
    }, ['command']),
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      if (typeof args.command !== 'string' || args.command.trim().length === 0) {
        throw new Error('"command" must be a non-empty string.');
      }
      const instance = await pickInstance(args.instance, exec);
      const payload = await callShWithExit(instance, args.command, exec, {
        timeoutMs: settings.commandTimeoutMs,
      });
      const body = formatShResult(payload);
      return `instance ${instance} $ ${args.command}\n${body}`;
    },
  });

  ctx.inject(['attachments'], (imageCtx) => {
    imageCtx.tools.register({
      name: 'mumu_screenshot',
      description:
        'Capture the current screen of a MuMu Player 12 instance and return it as an image you can look at. Coordinates you read off this '
        + 'image are the pixel coordinates mumu_ui expects. Optionally also writes the PNG to a host path.',
      parameters: parameters({
        instance: INSTANCE_PROP,
        savePath: { type: 'string', description: 'Optional absolute Windows path to also write the PNG to.' },
        includeImage: {
          type: 'boolean',
          description: 'Whether to attach the image itself to the reply (default true). Pass false when you only need the size, or are '
            + 'polling the screen, to keep the picture out of the conversation.',
        },
      }),
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            summary: { type: 'string' },
            image: IMAGE_VALUE_SCHEMA,
          },
          required: ['summary'],
        },
        render: (_args, value) => (value.image === undefined
          ? [{ type: 'text', text: value.summary }]
          : [{ type: 'text', text: value.summary }, { type: 'image', attachment: value.image }]),
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const includeImage = args.includeImage ?? settings.screenshotIncludeImage;
        const attachments = includeImage ? imageCtx.get('attachments') : undefined;
        if (includeImage && attachments === undefined) throw new Error('no attachment service is mounted, so the screenshot cannot be shown.');
        const instance = await pickInstance(args.instance, exec);
        const { serial } = await endpointOf(instance, exec);
        const connected = await callAdb(['connect', serial], exec, { timeoutMs: settings.adbConnectTimeoutMs });
        if (/unable to connect|failed to connect|cannot connect/i.test(connected.stdoutText)) {
          throw new Error(`adb could not connect to ${serial}: ${connected.stdoutText.trim()}`);
        }
        const captured = await callAdb(['-s', serial, 'exec-out', 'screencap', '-p'], exec, { maxBytes: 64 * 1024 * 1024 });
        const data = normalizePng(captured.stdout);
        if (!data.subarray(0, 8).equals(PNG_SIGNATURE)) {
          const detail = captured.stderrText.trim();
          throw new Error(`screencap on ${serial} did not return a PNG (${data.length} bytes)${detail.length > 0 ? `: ${detail}` : ''}`);
        }
        const size = pngSize(data);
        const written = typeof args.savePath === 'string' && args.savePath.trim().length > 0 ? args.savePath.trim() : undefined;
        if (written !== undefined) {
          mkdirSync(dirname(written), { recursive: true });
          writeFileSync(written, data);
        }
        const attachmentName = `mumu-instance-${instance}-${Date.now()}.png`;
        let ref;
        if (includeImage) {
          try {
            ref = await attachments.saveImage({ data, mediaType: 'image/png', name: attachmentName });
          } catch (error) {
            throw new Error(`the screenshot could not be stored as an attachment: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        const dimensions = size === undefined ? '' : ` (${size.width}x${size.height} px)`;
        const summary = [
          `Screenshot of MuMu instance ${instance} via ${serial}${dimensions}, ${data.length} bytes.`,
          size === undefined ? '' : `Pixel coordinates for mumu_ui range from (0, 0) to (${size.width - 1}, ${size.height - 1}).`,
          written === undefined ? '' : `Also written to ${written}.`,
          includeImage ? '' : 'The image is not attached to this reply; pass includeImage:true (or set savePath) to actually look at it.',
        ].filter((line) => line.length > 0).join(' ');
        if (!includeImage) return { summary };
        return {
          summary,
          image: {
            attachmentId: ref.attachmentId,
            mediaType: ref.mediaType,
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
            name: ref.name ?? attachmentName,
          },
        };
      },
    });
  });
}

export { Config };
