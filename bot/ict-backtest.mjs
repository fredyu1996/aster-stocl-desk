// Standalone JSON study. Reads bars from disk and writes the report to stdout.
import { readFile } from 'node:fs/promises';
import { backtestIct, ICT_MNQ } from '../core/ict.mjs';
import { report } from './backtest.mjs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node bot/ict-backtest.mjs <input.json>');
  process.exitCode = 1;
} else {
  try {
    const input = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
    if (!['trade', 'mark'].includes(input.source)) throw new Error('Set source to trade or mark');
    const split = input.splitAt === undefined ? Infinity
      : typeof input.splitAt === 'number' ? input.splitAt
        : typeof input.splitAt === 'string' && /(?:Z|[+-]\d\d:\d\d)$/i.test(input.splitAt) ? Date.parse(input.splitAt) : NaN;
    if (input.splitAt !== undefined && !Number.isSafeInteger(split)) throw new Error('Invalid splitAt');
    const study = backtestIct(input);
    const { all, halves, months, exits } = report(study.trades, split);
    console.log(JSON.stringify({ ...study, source: input.source, pricePathOnly: input.source === 'mark',
      instrument: input.instrument ?? ICT_MNQ, costs: input.costs, metrics: { all, halves: split === Infinity ? null : halves, months, exits } }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
