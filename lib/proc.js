import { spawn } from 'node:child_process';

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_CHUNKS = 256;

/**
 * Decode console output without assuming the OEM code page is UTF-8. ASCII
 * survives either way; a Chinese Windows console speaks GBK (code page 936),
 * which is what `reg.exe` emits for DisplayName, so read that before giving up
 * on the bytes.
 */
export function decodeText(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder('utf-16le', { fatal: false }).decode(buffer.subarray(2));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    // not UTF-8: fall through to the OEM code page
  }
  try {
    return new TextDecoder('gbk', { fatal: true }).decode(buffer);
  } catch {
    return buffer.toString('latin1');
  }
}

export function abortError() {
  const error = new Error('tool call aborted');
  error.name = 'AbortError';
  return error;
}

export function parseJson(text) {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Spawn one child, register it in `children` for lifetime cleanup, and settle
 * with raw buffers so binary stdout (screencap) survives intact.
 */
export function run(children, exe, args, options = {}) {
  const { timeoutMs = 120000, signal, maxBytes = DEFAULT_MAX_BYTES, input } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError());
      return;
    }
    let child;
    try {
      child = spawn(exe, args, {
        windowsHide: true,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }
    children.add(child);

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let truncated = false;
    let settled = false;
    let timer;

    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      children.delete(child);
      settle(value);
    };
    const kill = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    };
    const onAbort = () => {
      kill();
      finish(reject, abortError());
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        kill();
        const argv = args.join(' ');
        const shown = argv.length > 400 ? `${argv.slice(0, 400)}…` : argv;
        finish(reject, new Error(`"${exe}" ${shown} did not finish within ${timeoutMs} ms and was killed`));
      }, timeoutMs);
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk) => {
      if (stdoutBytes >= maxBytes) {
        truncated = true;
        return;
      }
      stdoutBytes += chunk.length;
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (stderrChunks.length < MAX_STDERR_CHUNKS) stderrChunks.push(chunk);
    });
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code, closeSignal) => {
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks);
      finish(resolve, {
        code,
        signal: closeSignal,
        stdout,
        stderr,
        stdoutText: decodeText(stdout),
        stderrText: decodeText(stderr),
        truncated,
      });
    });

    if (input !== undefined && child.stdin !== null) child.stdin.end(input);
  });
}
