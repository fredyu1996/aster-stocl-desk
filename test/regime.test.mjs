// Parity with the original Python skills (tradermonty/claude-trading-skills): expected values in
// test/fixtures/regime_expected.json were produced by running their calculators on the same inputs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { breadthRows, exposure, parseCSV, posture, pyRound, scoreBreadth, scoreUptrend, sectorHealth, uptrendSeries } from '../core/regime.mjs';

const fx = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const expected = JSON.parse(fx('regime_expected.json'));
const series = uptrendSeries(fx('uptrend_all.csv'));

test('pyRound rounds half to even like Python', () => {
  assert.deepEqual([0.5, 1.5, 2.5, -0.5, 2.675, 7.45].map(v => pyRound(v)), [0, 2, 2, 0, 3, 7]);
  assert.equal(pyRound(2.675, 2), 2.67);
  assert.equal(pyRound(20.05, 1), 20.1); // binary 20.05 is above the half, as in Python
  assert.equal(pyRound(0.25, 1), 0.2);
});

test('uptrend-analyzer port matches the Python scorer on real and varied sector data', () => {
  for (const c of expected.uptrend) {
    const out = scoreUptrend(series.slice(0, c.cut), c.sectors);
    assert.deepEqual(out.components, c.components, `components at cut ${c.cut}`);
    assert.equal(out.composite, c.composite, `composite at cut ${c.cut}`);
    assert.equal(out.zone, c.zone);
  }
});

test('market-breadth-analyzer port matches the Python scorer, including missing components', () => {
  for (const c of expected.breadth) {
    const out = scoreBreadth(breadthRows(c.csv), expected.summary);
    assert.deepEqual(out.components, c.components, `components seed ${c.seed}`);
    assert.equal(out.composite, c.composite, `composite seed ${c.seed}`);
    assert.equal(out.zone, c.zone);
  }
});

test('exposure-coach sector health and composite / ceiling / recommendation match Python', () => {
  for (const c of expected.uptrend) {
    assert.equal(sectorHealth(c.sectors), c.sector_score);
    const e = exposure({ breadth: c.exposure.breadth, uptrend: Math.trunc(c.composite), sector: c.sector_score });
    assert.ok(Math.abs(e.composite - pyRound(c.exposure.composite, 1)) < 1e-9);
    assert.equal(e.ceiling, c.exposure.ceiling);
    assert.equal(e.recommendation, c.exposure.recommendation);
    assert.equal(e.participation, c.exposure.participation);
    assert.equal(e.confidence, c.exposure.confidence);
  }
});

test('posture survives a missing source and reports it', () => {
  const p = posture({ uptrendText: fx('uptrend_all.csv'), sectorText: fx('uptrend_sectors.csv'), breadthText: null });
  assert.equal(p.breadth, null);
  assert.equal(p.uptrend.composite, 20.1);
  assert.deepEqual(p.exposure.missing_critical, ['regime', 'top_risk', 'breadth']);
  assert.equal(p.exposure.recommendation, 'CASH_PRIORITY');
  assert.equal(parseCSV('a,b\n"x,1",2\n')[0].a, 'x,1');
});
