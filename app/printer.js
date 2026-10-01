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
  /**
   * @param {object} cfg
   * @param {(sheets:number) => void} [onPrinted] told how many sheets each real
   *   job used, so paper and ink can be counted. Not called for dry runs.
   */
  constructor(cfg, onPrinted) {
    this.cfg = cfg;
    this.onPrinted = onPrinted || null;
    this.lastError = null;
    this.printing = false;
  }

  /** Is the CUPS queue present, enabled and not stopped on paper or ink? */
  async status() {
    if (this.cfg.printDryRun) {
      return { ok: true, dryRun: true, message: 'Dry run: prints are saved to disk.' };
    }
    // -l adds the Alerts line, where CUPS repeats what the printer reports.
    const res = await run('lpstat', ['-l', '-p', this.cfg.printerName], 8000);
    if (!res.ok) {
      return {
        ok: false,
        message: `Printer "${this.cfg.printerName}" was not found. Check it is on and connected.`,
      };
    }
    const disabled = res.stdout.split('\n')[0].toLowerCase().includes('disabled');
    const problem = printerProblem(res.stdout);
    // Waiting prints with no reported problem still mean something is wrong:
    // the backstop for anything the SELPHY does not name.
    const jobs = await run('lpstat', ['-o', this.cfg.printerName], 8000);
    const waiting = jobs.ok ? jobs.stdout.split('\n').filter((l) => l.trim()).length : 0;
    return {
      ok: !disabled && !problem,
      problem: problem ? problem.kind : null,
      label: problem ? problem.label : null,
      waiting,
      stuck: waiting >= 2,
      message: disabled
        ? 'The printer is paused. Open Printers in System Settings and resume it.'
        : problem
        ? problem.message
        : waiting >= 2
        ? `${waiting} prints are waiting in the printer. Check its paper and ink.`
        : 'Printer ready.',
      raw: res.stdout.split('\n')[0].trim(),
    };
  }

  /**
   * Print a file `copies` times. Resolves { ok, printed } or
   * { ok:false, error, printed }, where printed is how many copies CUPS took.
   *
   * Each copy is a job of its own. lp -n is no use here: the SELPHY's AirPrint
   * queue hands a JPEG straight to the printer with copies=2, and the printer
   * prints it once, so a second copy that was paid for never came out.
   */
  async print(filePath, copies = 1) {
    if (!fs.existsSync(filePath)) {
      return { ok: false, error: 'The photo file to print is missing.', printed: 0 };
    }
    copies = Math.max(1, Math.floor(copies) || 1);
    this.printing = true;
    let printed = 0;
    try {
      if (this.cfg.printDryRun) {
        log.info(`[printer] DRY RUN: would print ${copies} copy(ies) of ${filePath}`);
        await new Promise((r) => setTimeout(r, 1200));
        return { ok: true, dryRun: true, printed: copies };
      }

      const args = [
        '-d',
        this.cfg.printerName,
        '-n',
        '1',
        '-o',
        `media=${this.cfg.printerMedia}`,
        '-o',
        'fit-to-page',
        filePath,
      ];
      const jobIds = [];
      for (; printed < copies; printed++) {
        log.info('[printer] lp', args.join(' ') + (copies > 1 ? ` (copy ${printed + 1} of ${copies})` : ''));
        const res = await run('lp', args, 30000);
        if (!res.ok) {
          const error = friendlyPrintError(res, this.cfg.printerName);
          this.lastError = error;
          log.error('[printer] failed:', error, res.stderr.trim());
          return { ok: false, error, printed };
        }
        jobIds.push((res.stdout.match(/request id is (\S+)/) || [])[1] || null);
        if (this.onPrinted) {
          try {
            this.onPrinted(1);
          } catch {}
        }
      }
      this.lastError = null;
      return { ok: true, printed, jobId: jobIds[0], jobIds };
    } catch (err) {
      const error = String((err && err.message) || err);
      log.error('[printer] threw:', error);
      return { ok: false, error, printed };
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

/**
 * What stopped the printer, from the Alerts line of `lpstat -l -p`.
 *
 * Tested on the SELPHY CP1500: it says nothing while idle, even with the tray
 * out, but as soon as a print is waiting it names the problem, and CUPS
 * repeats it within a few seconds. So this catches the print that is stuck,
 * not an empty tray before anyone prints.
 *
 *   tray out     input-tray-missing
 *   tray empty   media-empty-error, media-needed
 *   ink out      marker-supply-empty-error
 *
 * media-jam is the standard name for a jam; not seen on the SELPHY yet.
 */
const PROBLEMS = [
  {
    kind: 'tray',
    label: 'Tray out',
    match: /\binput-tray-missing\b/,
    message: 'The paper tray is out. Push it back in.',
  },
  {
    kind: 'paper',
    label: 'Out of paper',
    match: /\bmedia-(empty|needed)\b/,
    message: 'Out of paper. Fill the tray (18 sheets at most), then tap Paper.',
  },
  {
    kind: 'ink',
    label: 'Out of ink',
    match: /\bmarker-supply-(empty|missing)\b/,
    message: 'Out of ink, or the ink cassette is out. Put in a new one, then tap Ink.',
  },
  {
    kind: 'jam',
    label: 'Paper jam',
    match: /\bmedia-jam\b/,
    message: 'Paper jam. Turn the printer off, pull the tray out, remove the stuck sheet, then turn it on.',
  },
];

function printerProblem(lpstatLong) {
  const m = /Alerts:(.*)/.exec(lpstatLong || '');
  if (!m) return null;
  return PROBLEMS.find((p) => p.match.test(m[1])) || null;
}

module.exports = { Printer, printerProblem };
