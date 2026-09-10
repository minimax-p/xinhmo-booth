/**
 * Printing to the Canon Selphy through CUPS.
 *
 * A dye-sub Selphy consumes one full ribbon panel set per print regardless of
 * content, so a failed print costs real media. We therefore do not retry
 * automatically: a failure is surfaced to staff instead of silently burning
 * paper. Everything resolves, nothing throws.
 */
'use strict';

const { spawn, execFile } = require('child_process');
const fs = require('fs');

const log = require('./logger');

function run(cmd, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let done = false;
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ ok: false, stdout: '', stderr: String(err.message), code: -1 });
    }
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        child.kill('SIGKILL');
      } catch {}
      resolve({ ok: false, stdout, stderr: stderr + '\n[timed out]', code: -2, timedOut: true });
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: String(err.message), code: -1, spawnError: true });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr, code });
    });
  });
}

class Printer {
  constructor(cfg) {
    this.cfg = cfg;
    this.lastError = null;
    this.printing = false;
  }

  /** Is the CUPS queue present and enabled? Used by the staff panel. */
  async status() {
    if (this.cfg.printDryRun) {
      return { ok: true, dryRun: true, message: 'Dry run: prints are saved to disk.' };
    }
    const res = await run('lpstat', ['-p', this.cfg.printerName], 8000);
    if (!res.ok) {
      return {
        ok: false,
        message: `Printer "${this.cfg.printerName}" was not found. Check it is on and connected.`,
      };
    }
    const text = res.stdout.toLowerCase();
    const disabled = text.includes('disabled');
    return {
      ok: !disabled,
      message: disabled
        ? 'The printer is paused. Open Printers in System Settings and resume it.'
        : 'Printer ready.',
      raw: res.stdout.trim(),
    };
  }

  /**
   * Print one file. Resolves { ok } or { ok:false, error }.
   * `copies` is passed to lp so the Selphy handles duplicates itself.
   */
  async print(filePath, copies = 1) {
    if (!fs.existsSync(filePath)) {
      return { ok: false, error: 'The photo file to print is missing.' };
    }
    this.printing = true;
    try {
      if (this.cfg.printDryRun) {
        log.info(`[printer] DRY RUN: would print ${copies} copy(ies) of ${filePath}`);
        await new Promise((r) => setTimeout(r, 1200));
        return { ok: true, dryRun: true };
      }

      const args = [
        '-d',
        this.cfg.printerName,
        '-n',
        String(copies),
        '-o',
        `media=${this.cfg.printerMedia}`,
        '-o',
        'fit-to-page',
        filePath,
      ];
      log.info('[printer] lp', args.join(' '));
      const res = await run('lp', args, 30000);
      if (!res.ok) {
        const error = friendlyPrintError(res, this.cfg.printerName);
        this.lastError = error;
        log.error('[printer] failed:', error, res.stderr.trim());
        return { ok: false, error };
      }
      this.lastError = null;
      return { ok: true, jobId: (res.stdout.match(/request id is (\S+)/) || [])[1] || null };
    } catch (err) {
      const error = String((err && err.message) || err);
      log.error('[printer] threw:', error);
      return { ok: false, error };
    } finally {
      this.printing = false;
    }
  }

  /** Names of queues CUPS knows about, for setup and the staff panel. */
  async listQueues() {
    const res = await run('lpstat', ['-p'], 8000);
    if (!res.ok) return [];
    return res.stdout
      .split('\n')
      .map((l) => (l.match(/^printer (\S+)/) || [])[1])
      .filter(Boolean);
  }
}

function friendlyPrintError(res, name) {
  const text = `${res.stderr || ''} ${res.stdout || ''}`.toLowerCase();
  if (res.spawnError && /enoent/i.test(res.stderr || '')) {
    return 'Printing is not available on this computer (lp command missing).';
  }
  if (res.timedOut) return 'The printer did not respond in time.';
  if (/unknown (destination|printer)|does not exist/.test(text)) {
    return `Printer "${name}" was not found. Check it is on and connected.`;
  }
  if (/disabled|paused|not accepting/.test(text)) {
    return 'The printer is paused. Resume it in System Settings, then try again.';
  }
  if (/media|paper|out of/.test(text)) return 'The printer is out of paper or ink.';
  const first = (res.stderr || '').split('\n').find((l) => l.trim());
  return first ? first.trim().slice(0, 160) : 'The printer would not accept the job.';
}

module.exports = { Printer };
