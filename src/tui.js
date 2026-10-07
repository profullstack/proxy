/**
 * `proxy tui`: one screen for the accounts and a live exit test.
 *
 *   ↑/↓ or j/k   choose a provider
 *   i / enter    test: fetch the exit IP through the chosen provider
 *   c            cycle the country (us → gb → de → ww)
 *   r            refresh account status
 *   q / ctrl-c   quit
 *
 * Plain ANSI, no framework: it redraws the whole screen on every change,
 * which at this size is cheaper than being clever.
 */

import { exitIp, status } from './index.js';

const COUNTRIES = ['us', 'gb', 'de', 'ww'];
const esc = (code) => `\x1b[${code}`;
const bold = (text) => `${esc('1m')}${text}${esc('0m')}`;
const dim = (text) => `${esc('2m')}${text}${esc('0m')}`;
const green = (text) => `${esc('32m')}${text}${esc('0m')}`;
const red = (text) => `${esc('31m')}${text}${esc('0m')}`;
const yellow = (text) => `${esc('33m')}${text}${esc('0m')}`;

function money(value) {
  return value === null || value === undefined ? '—' : `$${Number(value).toFixed(2)}`;
}

function days(iso) {
  if (!iso) return '—';
  const left = Math.round((Date.parse(iso) - Date.now()) / 86_400_000);
  const date = iso.slice(0, 10);
  return left < 0 ? red(`${date} (expired)`) : left <= 7 ? yellow(`${date} (${left}d)`) : `${date} (${left}d)`;
}

export function render(state) {
  const lines = [bold('proxy') + dim('  @profullstack/proxy — ↑↓ choose · i test · c country · r refresh · q quit'), ''];
  state.rows.forEach((row, index) => {
    const cursor = index === state.selected ? bold('›') : ' ';
    const mark = row.configured ? green('●') : red('○');
    lines.push(`${cursor} ${mark} ${bold(row.label)} ${dim(`(${row.provider})`)}`);
    if (row.account) {
      lines.push(`    credit ${money(row.account.credit)}${row.account.email ? dim(`  ${row.account.email}`) : ''}`);
      for (const sub of row.account.subscriptions) {
        const speed = sub.mbps
          ? `${sub.mbps} Mbps`
          : sub.remainingGb !== undefined && sub.remainingGb !== null
            ? `${sub.remainingGb}/${sub.bandwidthGb ?? '?'} GB left`
            : sub.bandwidthGb ? `${sub.bandwidthGb} GB` : '';
        // Pay-per-GB plans (HProxy) have no renewal to report.
        const renews = sub.autoRenew === null || sub.autoRenew === undefined ? '' : `  renews ${sub.autoRenew ? 'on' : 'off'}`;
        lines.push(
          `    #${sub.id} ${sub.kind} ${speed} ${sub.active ? green('active') : red('inactive')}` +
            `${renews}  until ${days(sub.expiresAt)}  ${money(sub.price)}`,
        );
      }
    } else if (row.error) {
      lines.push(`    ${dim(row.error)}`);
    }
    lines.push('');
  });
  lines.push(`country ${bold(COUNTRIES[state.country])}`);
  if (state.busy) lines.push(yellow(state.busy));
  if (state.test) {
    const t = state.test;
    lines.push(t.error ? red(`test failed: ${t.error}`) : green(`exit ${t.ip}  ${t.country ?? ''} ${t.city ?? ''}  ${t.org ?? ''}  via ${t.provider}  ${t.ms} ms`));
  }
  return lines.join('\n');
}

export async function runTui({ env = process.env, input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY) throw new Error('proxy tui needs a terminal (stdin is not a TTY)');
  const state = { rows: [], selected: 0, country: 0, busy: 'loading…', test: null };
  const draw = () => output.write(`${esc('2J')}${esc('H')}${render(state)}\n`);

  async function refresh() {
    state.busy = 'loading account status…';
    draw();
    state.rows = await status({ env });
    state.busy = null;
    draw();
  }

  async function test() {
    const row = state.rows[state.selected];
    if (!row) return;
    state.busy = `testing ${row.provider}…`;
    state.test = null;
    draw();
    const started = Date.now();
    try {
      state.test = { ...(await exitIp({ provider: row.provider, country: COUNTRIES[state.country], env })), ms: Date.now() - started };
    } catch (error) {
      state.test = { error: error.message };
    }
    state.busy = null;
    draw();
  }

  output.write(esc('?25l'));
  input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');

  return new Promise((done) => {
    const quit = () => {
      input.setRawMode(false);
      input.pause();
      input.off('data', onKey);
      output.write(`${esc('?25h')}\n`);
      done();
    };
    const onKey = (key) => {
      if (key === 'q' || key === '\u0003') return quit();
      if (key === '\x1b[A' || key === 'k') state.selected = Math.max(0, state.selected - 1);
      else if (key === '\x1b[B' || key === 'j') state.selected = Math.min(state.rows.length - 1, state.selected + 1);
      else if (key === 'c') state.country = (state.country + 1) % COUNTRIES.length;
      else if (key === 'r') return void refresh();
      else if (key === 'i' || key === '\r') return void test();
      draw();
    };
    input.on('data', onKey);
    refresh().catch((error) => {
      state.busy = red(error.message);
      draw();
    });
  });
}
