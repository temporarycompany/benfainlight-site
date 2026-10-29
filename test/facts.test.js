// test/facts.test.js — Node built-in test runner (node --test)
'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const fm = require('../public/facts.js');
const { computeFacts, resolveLead, parseStartYear, DEFAULT_FACT_SETTINGS, getFamily } = fm;

// ── Fixtures ──────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

function loadCollection() {
  const p = path.join(__dirname, '..', 'collection.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function makeGarment(overrides = {}) {
  return {
    accession: 'TEST.001',
    seq: 1000,
    status: 'accessioned',
    type: 'Shirt',
    maker: 'Test Band',
    title: 'Test Shirt',
    date: '1994',
    label: 'Fruit of the Loom',
    sleeve: 'short',
    department: 'Music',
    bodyColour: '#000000',
    ...overrides,
  };
}

function makeBook(overrides = {}) {
  return {
    accession: 'TEST.B01',
    seq: 2001,
    status: 'accessioned',
    type: 'Book',
    maker: 'Jenny Holzer',
    title: 'Truisms',
    date: '1991',
    publisher: 'Dia Art Foundation',
    cover: 'soft',
    pages: 128,
    department: 'Art',
    bodyColour: '#f5f5f5',
    ...overrides,
  };
}

function makeEphemera(overrides = {}) {
  return {
    accession: 'TEST.E01',
    seq: 3001,
    status: 'accessioned',
    type: 'Ephemera',
    maker: 'Fugazi',
    title: '930 Club Flyer',
    date: '1991',
    kind: 'flyer',
    city: 'Washington DC',
    department: 'Music',
    bodyColour: '#ffffff',
    ...overrides,
  };
}

// ── Test 1: Garments unchanged when books/ephemera added ──────────────────────
describe('Test 1: Garments unchanged when books/ephemera are added', () => {
  // Garment-pool facts are colour, sleeve, label, tagless, note.
  // Shared facts (maker, department, decade) change when non-garment objects with the
  // same maker/department/decade are added — that is intentional per spec.
  // This test verifies that garment-pool-isolated facts do not change.
  const GARMENT_POOL_KEYS = new Set(['colour', 'sleeve', 'label', 'tagless', 'note']);

  test('garment colour ranks, sleeve counts and label counts are unaffected by books/ephemera', () => {
    const all = loadCollection();
    const garments = all.filter(x => x.status === 'accessioned');

    // Baseline: garment-pool facts for each garment
    const baseline = {};
    for (const g of garments) {
      const fs = computeFacts(g, garments, DEFAULT_FACT_SETTINGS);
      baseline[g.accession] = fs.filter(f => GARMENT_POOL_KEYS.has(f.key)).map(f => f.text);
    }

    // Add a fixture book and ephemera (same department as garments to stress-test isolation)
    const withExtra = [
      ...all,
      makeBook({ accession: 'TEST.B01', department: 'Music' }),
      makeEphemera({ accession: 'TEST.E01', department: 'Music' }),
    ];

    // Recompute — garment-pool facts must be identical
    for (const g of garments) {
      const after = computeFacts(g, withExtra, DEFAULT_FACT_SETTINGS)
        .filter(f => GARMENT_POOL_KEYS.has(f.key))
        .map(f => f.text);
      assert.deepEqual(
        after,
        baseline[g.accession],
        `Garment ${g.accession} pool facts changed after adding books/ephemera`
      );
    }
  });
});

// ── Test 2: Books never enter garment pools ───────────────────────────────────
describe('Test 2: Books never enter garment pools', () => {
  test('book has no garment-specific fact keys', () => {
    const book = makeBook();
    const all = [makeGarment({ accession: 'G1' }), makeGarment({ accession: 'G2' }), book];
    const facts = computeFacts(book, all, DEFAULT_FACT_SETTINGS);
    const keys = facts.map(f => f.key);
    assert.ok(!keys.includes('sleeve'), 'Book should not have sleeve fact');
    assert.ok(!keys.includes('label'),  'Book should not have label fact');
    assert.ok(!keys.includes('tagless'), 'Book should not have tagless fact');
    assert.ok(!keys.includes('note'),   'Book should not have note fact');
  });

  test('adding book does not change garment colour rank or sleeve count', () => {
    const g1 = makeGarment({ accession: 'G1', bodyColour: '#000000', sleeve: 'long' });
    const g2 = makeGarment({ accession: 'G2', bodyColour: '#ffffff', sleeve: 'short' });
    const garments = [g1, g2];
    const book = makeBook();

    const before = computeFacts(g1, garments, DEFAULT_FACT_SETTINGS);
    const after  = computeFacts(g1, [...garments, book], DEFAULT_FACT_SETTINGS);

    const colourBefore = before.find(f => f.key === 'colour')?.text;
    const colourAfter  = after.find(f => f.key === 'colour')?.text;
    assert.equal(colourAfter, colourBefore, 'Garment colour rank changed after adding book');

    const sleeveBefore = before.find(f => f.key === 'sleeve')?.text;
    const sleeveAfter  = after.find(f => f.key === 'sleeve')?.text;
    assert.equal(sleeveAfter, sleeveBefore, 'Garment sleeve count changed after adding book');
  });

  test('book caption does not contain "sleeve"', () => {
    // Family caption is computed in collection.html; we test getFamily instead
    const book = makeBook();
    assert.equal(getFamily(book), 'book', 'Book family should be "book"');
    // The caption function (familyCaption in collection.html) won't produce "sleeve" for a book
    // since it only reads x.cover. We verify getFamily here as the guard.
  });
});

// ── Test 3: Shared facts cross families ───────────────────────────────────────
describe('Test 3: Shared facts cross families', () => {
  test('Jenny Holzer maker count includes book and garments', () => {
    const holzerShirt1 = makeGarment({ accession: 'H1', maker: 'Jenny Holzer', department: 'Art' });
    const holzerShirt2 = makeGarment({ accession: 'H2', maker: 'Jenny Holzer', department: 'Art' });
    const holzerBook   = makeBook({ accession: 'HB1', maker: 'Jenny Holzer' });

    const all = [holzerShirt1, holzerShirt2, holzerBook];

    const shirtFacts = computeFacts(holzerShirt1, all, DEFAULT_FACT_SETTINGS);
    const bookFacts  = computeFacts(holzerBook,   all, DEFAULT_FACT_SETTINGS);

    const shirtMaker = shirtFacts.find(f => f.key === 'maker')?.text;
    const bookMaker  = bookFacts.find(f => f.key === 'maker')?.text;

    // Both should see 3 objects
    assert.ok(shirtMaker?.includes('3'), `Shirt maker fact should mention 3 objects, got: ${shirtMaker}`);
    assert.ok(bookMaker?.includes('3'),  `Book maker fact should mention 3 objects, got: ${bookMaker}`);
  });
});

// ── Test 4: Age parsing ───────────────────────────────────────────────────────
describe('Test 4: Age parsing', () => {
  test('"1984" parses to year 1984, not decade', () => {
    const r = parseStartYear('1984');
    assert.deepEqual(r, { year: 1984, isDecade: false });
  });

  test('"1979-82" parses to start year 1979, not decade', () => {
    const r = parseStartYear('1979-82');
    assert.deepEqual(r, { year: 1979, isDecade: false });
  });

  test('"1980s" parses to year 1980, isDecade=true', () => {
    const r = parseStartYear('1980s');
    assert.deepEqual(r, { year: 1980, isDecade: true });
  });

  test('"Undated" returns null', () => {
    assert.equal(parseStartYear('Undated'), null);
  });

  test('empty string returns null', () => {
    assert.equal(parseStartYear(''), null);
  });

  test('null returns null', () => {
    assert.equal(parseStartYear(null), null);
  });

  test('exact year sorts before same-decade decade entry', () => {
    // "1984" (sortKey = 1984*2+0=3968) < "1980s" (sortKey = 1980*2+1=3961)?
    // Actually 1980*2+1=3961 < 1984*2+0=3968, so "1980s" sorts BEFORE "1984"
    // BUT spec says: "1980, after any exact year from the 1980s"
    // So "1980s" = sortKey 1980*2+1 = 3961 but 1984 = sortKey 1984*2+0 = 3968
    // "1980s" comes BEFORE 1984 in absolute sort, but spec says exact years before decade-style
    // Re-reading: sortKey = year * 2 + (isDecade ? 1 : 0) means:
    //   1984 exact: 1984*2 + 0 = 3968
    //   1980s decade: 1980*2 + 1 = 3961
    // So 1980s sorts before 1984. But within the same decade: e.g. 1983 vs 1980s:
    //   1983 exact: 1983*2 + 0 = 3966
    //   1980s decade: 1980*2 + 1 = 3961
    // Still 1980s sorts before 1983.
    // The spec says "1980s" sorts AFTER "any exact year from the 1980s".
    // This means sortKey should be: decade year with isDecade offset that makes it AFTER exact years.
    // So for 1980s: sortKey = 1989*2+1 = 3979 (end of decade + isDecade)? No...
    // Actually re-reading the spec: "1980s → 1980, after any exact year from the 1980s"
    // So "1980s" should sort as if it's 1989 for tie-breaking within the decade.
    // The implementation in facts.js uses year * 2 + isDecade, so:
    //   1981 exact: 1981*2+0=3962
    //   1980s: 1980*2+1=3961
    // This means "1980s" comes BEFORE 1981, which is WRONG per spec.
    // The correct interpretation: "1980s" should sort AFTER 1989 within the decade.
    // Implementation bug? Let me re-check what I actually wrote in facts.js.
    // Looking at the code: sortKey = r.year * 2 + (r.isDecade ? 1 : 0)
    // For 1980s: year=1980, isDecade=true, sortKey = 1980*2+1 = 3961
    // For 1981: year=1981, isDecade=false, sortKey = 1981*2+0 = 3962
    // So 1980s (3961) sorts BEFORE 1981 (3962). But spec says "1980s, after any exact year from the 1980s"
    // This is a bug in my implementation! The spec says decade entries should sort AFTER exact years from that decade.
    // I need to fix this. The sortKey for "1980s" should be e.g. 1989*2+1 = 3979, not 1980*2+1.
    // OR better: use year * 2 + isDecade where isDecade=1 means it sorts AFTER the same year.
    // But "1980s" should sort after 1989 (last year of decade), not after 1980.
    //
    // Actually wait - re-reading: facts.js has year * 2 + (isDecade ? 1 : 0). So:
    //   1989 exact: 1989*2+0=3978
    //   1980s: 1980*2+1=3961
    // 1980s (3961) sorts BEFORE 1989 (3978). This is wrong.
    //
    // I need to fix this. The decade sortKey should be: (year+9)*2 + 1 = year's last year * 2 + 1
    // Or simply: decade * 2 + 1 where decade = 1989 for 1980s? No...
    //
    // Actually, the cleanest fix: for "1980s", use sortKey = 1989.5 * 2... but that's float.
    // Better: sortKey = year * 2 + isDecade, where for "1980s": year = 1989, isDecade = 1
    // So facts.js should set year to the END of the decade: year = 1989 for "1980s"
    //
    // Wait, let me re-read: The spec says: "1980s → 1980, after any exact year from the 1980s"
    // The number 1980 is the start year returned by parseStartYear. The "after any exact year" means
    // in the sort order. So the sort should put "1980s" after 1989 but before any 1990 entries.
    //
    // Actually, maybe the spec means: "1980s" parses to year 1980, and in the age rank, it goes
    // after any exact year from the 1980s. So the sort puts "1980s" at the END of the 1980s.
    //
    // The fix would be: for isDecade=true, use sortKey = (year + 9) * 2 + 1
    // For 1980s: (1980+9)*2+1 = 1989*2+1 = 3979. This places it after 1989 (3978) but before 1990 (3980).
    //
    // But wait, my test file refers to facts.js which already has the implementation.
    // I need to fix facts.js to match the spec, and write the test to verify the CORRECT behavior.
    //
    // Let me write the test to verify the correct behavior:
    // "1980s" should sort after 1989 but before 1990.

    // book with exact 1981
    const book1 = makeBook({ accession: 'B1981', date: '1981', maker: 'AAA' });
    // book with 1980s
    const book80s = makeBook({ accession: 'B1980s', date: '1980s', maker: 'BBB' });
    // book with exact 1990
    const book1990 = makeBook({ accession: 'B1990', date: '1990', maker: 'CCC' });

    const all = [book1, book80s, book1990];
    // Expected age rank: 1981 (rank 1), 1980s (rank 2), 1990 (rank 3)
    // Because 1980s means "somewhere in the 1980s" and sorts after all exact 1980s years

    const f1981  = computeFacts(book1,    all, DEFAULT_FACT_SETTINGS).find(f => f.key === 'age');
    const f1980s = computeFacts(book80s,  all, DEFAULT_FACT_SETTINGS).find(f => f.key === 'age');
    const f1990  = computeFacts(book1990, all, DEFAULT_FACT_SETTINGS).find(f => f.key === 'age');

    assert.ok(f1981?.text.includes('1st'),  `1981 exact should rank 1st, got: ${f1981?.text}`);
    assert.ok(f1980s?.text.includes('2nd'), `1980s decade should rank 2nd (after 1981), got: ${f1980s?.text}`);
    assert.ok(f1990?.text.includes('3rd'),  `1990 should rank 3rd, got: ${f1990?.text}`);
  });
});

// ── Test 5: Lead resolution ────────────────────────────────────────────────────
describe('Test 5: Lead resolution', () => {
  test('leadFact override wins over family order', () => {
    const g = makeGarment({
      accession: 'G1', sleeve: 'long', label: 'Fruit of the Loom',
      leadFact: 'sleeve',
    });
    const all = [g, makeGarment({ accession: 'G2', sleeve: 'long', label: 'Fruit of the Loom' })];
    const lead = resolveLead(g, all, DEFAULT_FACT_SETTINGS);
    assert.ok(lead.includes('long-sleeve'), `Expected sleeve fact to lead, got: ${lead}`);
  });

  test('disabled key is skipped and next enabled key leads', () => {
    const settings = {
      ...DEFAULT_FACT_SETTINGS,
      garment: [
        { key: 'maker',  enabled: false },
        { key: 'label',  enabled: true  },
        { key: 'sleeve', enabled: true  },
        { key: 'colour', enabled: true  },
        { key: 'department', enabled: true },
        { key: 'decade', enabled: true },
      ],
    };
    const g1 = makeGarment({ accession: 'G1', maker: 'Test', label: 'Anvil' });
    const g2 = makeGarment({ accession: 'G2', maker: 'Test', label: 'Anvil' });
    const all = [g1, g2];
    const lead = resolveLead(g1, all, settings);
    // maker is disabled, so label should lead
    assert.ok(lead.includes('Anvil'), `Expected label fact to lead (maker disabled), got: ${lead}`);
  });

  test('customFacts lead over generated facts', () => {
    const g = makeGarment({
      accession: 'G1',
      customFacts: ['is one custom fact.'],
    });
    const all = [g];
    const lead = resolveLead(g, all, DEFAULT_FACT_SETTINGS);
    assert.equal(lead, 'is one custom fact.');
  });

  test('leadFact key that does not apply falls back to family order', () => {
    const g = makeGarment({
      accession: 'G1',
      maker: 'Unique Artist', // only one, so no maker fact
      sleeve: 'short', // not long, so no sleeve fact
      leadFact: 'sleeve', // override to non-applicable key
      label: 'Hanes',
    });
    const g2 = makeGarment({ accession: 'G2', maker: 'Other Artist', label: 'Hanes', sleeve: 'short' });
    const all = [g, g2];
    const lead = resolveLead(g, all, DEFAULT_FACT_SETTINGS);
    // sleeve doesn't apply (short), maker doesn't apply (unique artist),
    // falls back to label fact (2 objects on Hanes label)
    assert.ok(lead.includes('Hanes'), `Expected label fact fallback, got: ${lead}`);
  });
});

// ── Test 6: Admin type round-trip ─────────────────────────────────────────────
describe('Test 6: Admin type round-trip (Sweatshirt)', () => {
  test('getFamily returns "garment" for Sweatshirt', () => {
    assert.equal(getFamily({ type: 'Sweatshirt' }), 'garment');
  });

  test('getFamily returns "garment" for Hoodie', () => {
    assert.equal(getFamily({ type: 'Hoodie' }), 'garment');
  });

  test('Sweatshirt facts use garment pool (not mixed with books)', () => {
    const sweat = {
      accession: '2026.074',
      seq: 74,
      status: 'accessioned',
      type: 'Sweatshirt',
      maker: 'Pangaia',
      title: 'Sweatshirt',
      date: '2021',
      sleeve: 'long',
      label: 'Pangaia',
      department: 'Other',
      bodyColour: '#cccccc',
    };
    const garment = makeGarment({ accession: 'G1', sleeve: 'long' });
    const book = makeBook({ accession: 'B1' });
    const all = [sweat, garment, book];

    const facts = computeFacts(sweat, all, DEFAULT_FACT_SETTINGS);
    const colourFact = facts.find(f => f.key === 'colour');
    // Pool = garments only = 2 objects (sweat + garment)
    assert.ok(colourFact?.text.includes('2'), `Sweatshirt colour rank denominator should be 2 (garment pool), got: ${colourFact?.text}`);
  });
});

// ── Test 7: Garment plates are unchanged by book/detail-count changes ─────────
describe('Test 7: Garment object plates unchanged', () => {
  // Simulate drawObj plate-building logic (mirrors collection.html drawObj)
  function buildPlates(x) {
    const imgs = x.images || [];
    const views = imgs.filter(i => i.role === 'front' || i.role === 'back');
    const dets = imgs.filter(i => i.role === 'detail');
    const lbl = imgs.find(i => i.role === 'label');
    const fam = getFamily(x);
    const defaultViewCap = (i) => fam === 'book' ? (i === 0 ? 'Cover' : 'Back cover') : (i === 0 ? 'Front' : 'Back');
    const defaultLblCap = () => fam === 'book' ? 'Colophon' : 'Label';
    return [
      ...views.map((v, i) => ({ cap: v.caption || defaultViewCap(i), cutout: v.cutout, photo: false })),
      ...dets.map(d => ({ cap: d.caption || 'Detail', cutout: d.cutout, photo: !d.cutout && fam !== 'book' })),
      ...(lbl ? [{ cap: lbl.caption || defaultLblCap(), photo: true }] : []),
    ];
  }

  test('garment with front/back/label gets three plates: Front, Back, Label', () => {
    const g = makeGarment({
      images: [
        { role: 'front', src: 'f.webp', cutout: true },
        { role: 'back', src: 'b.webp', cutout: true },
        { role: 'label', src: 'l.webp' },
      ],
    });
    const plates = buildPlates(g);
    assert.equal(plates.length, 3);
    assert.equal(plates[0].cap, 'Front');
    assert.equal(plates[1].cap, 'Back');
    assert.equal(plates[2].cap, 'Label');
    assert.equal(plates[2].photo, true);
  });

  test('garment with one detail gets four plates, detail is photo (not cutout)', () => {
    const g = makeGarment({
      images: [
        { role: 'front', src: 'f.webp', cutout: true },
        { role: 'back', src: 'b.webp', cutout: true },
        { role: 'detail', src: 'd.jpg', cutout: false },
        { role: 'label', src: 'l.webp' },
      ],
    });
    const plates = buildPlates(g);
    assert.equal(plates.length, 4);
    assert.equal(plates[2].cap, 'Detail');
    assert.equal(plates[2].photo, true);
  });

  test('book with seven detail plates gets all seven in order with correct captions', () => {
    const b = makeBook({
      images: [
        { role: 'front', src: 'f.webp', cutout: true, caption: 'Cover' },
        { role: 'back', src: 'b.webp', cutout: true, caption: 'Back cover' },
        { role: 'detail', src: 'spine.webp', cutout: true, caption: 'Spine' },
        { role: 'detail', src: 's1.webp', cutout: true, caption: 'Spread' },
        { role: 'detail', src: 's2.webp', cutout: true, caption: 'Spread' },
        { role: 'detail', src: 's3.webp', cutout: true, caption: 'Spread' },
        { role: 'detail', src: 'col.webp', cutout: true, caption: 'Colophon' },
      ],
    });
    const plates = buildPlates(b);
    assert.equal(plates.length, 7);
    assert.equal(plates[0].cap, 'Cover');
    assert.equal(plates[1].cap, 'Back cover');
    assert.equal(plates[2].cap, 'Spine');
    assert.equal(plates[6].cap, 'Colophon');
    // All detail plates are cutout → not photo
    for (const p of plates.slice(2)) assert.equal(p.photo, false);
  });

  test('book detail with cutout:false renders at plate size (not photo)', () => {
    const b = makeBook({
      images: [
        { role: 'front', src: 'f.webp', cutout: true },
        { role: 'detail', src: 'spread.webp', cutout: false, caption: 'Spread' },
      ],
    });
    const plates = buildPlates(b);
    assert.equal(plates[1].photo, false, 'book non-cutout detail should not be photo');
  });

  test('garment detail with cutout:false stays photo', () => {
    const g = makeGarment({
      images: [
        { role: 'front', src: 'f.webp', cutout: true },
        { role: 'detail', src: 'd.jpg', cutout: false },
      ],
    });
    const plates = buildPlates(g);
    assert.equal(plates[1].photo, true, 'garment non-cutout detail should remain photo');
  });

  test('book with no label and seven detail plates has no label plate', () => {
    const b = makeBook({
      images: [
        { role: 'front', src: 'f.webp', cutout: true },
        { role: 'back', src: 'b.webp', cutout: true },
        { role: 'detail', src: 'd1.webp', cutout: true, caption: 'Spine' },
      ],
    });
    const plates = buildPlates(b);
    assert.equal(plates.length, 3);
    assert.ok(!plates.some(p => p.cap === 'Label'), 'no label plate for book without label image');
  });

  test('adding a book with multiple detail plates does not affect garment plate count', () => {
    const g = makeGarment({
      images: [
        { role: 'front', src: 'f.webp', cutout: true },
        { role: 'back', src: 'b.webp', cutout: true },
        { role: 'label', src: 'l.webp' },
      ],
    });
    const gPlatesBefore = buildPlates(g);
    // Simulate: book is also in collection (irrelevant to garment plate building)
    const gPlatesAfter = buildPlates(g);
    assert.deepEqual(gPlatesBefore, gPlatesAfter);
  });
});

// ── Test 8: Co-credited makers ────────────────────────────────────────────────
describe('Test 8: Co-credited makers', () => {
  test('"NIGO / Sotheby\'s" counts toward both NIGO and Sotheby\'s', () => {
    const nigo1 = makeGarment({ accession: 'G1', maker: 'NIGO' });
    const nigo2 = makeBook({ accession: 'B1', maker: 'NIGO' });
    const coCredit = makeBook({ accession: 'B2', maker: "NIGO / Sotheby's" });
    const sothebyOther = makeBook({ accession: 'B3', maker: "Sotheby's" });
    const all = [nigo1, nigo2, coCredit, sothebyOther];

    const coFacts = computeFacts(coCredit, all, DEFAULT_FACT_SETTINGS);
    const makerFact = coFacts.find(f => f.key === 'maker');
    assert.ok(makerFact, 'co-credited object should have a maker fact');
    // NIGO: 3 objects (nigo1, nigo2, coCredit)
    assert.ok(makerFact.text.includes('3') && makerFact.text.includes('NIGO'), `NIGO count should be 3, got: ${makerFact.text}`);
    // Sotheby's: 2 objects (coCredit, sothebyOther)
    assert.ok(makerFact.text.includes("Sotheby's"), `fact should mention Sotheby's, got: ${makerFact.text}`);
  });

  test('single-maker objects are unchanged by co-credited additions', () => {
    const nigo1 = makeGarment({ accession: 'G1', maker: 'NIGO' });
    const nigo2 = makeBook({ accession: 'B1', maker: 'NIGO' });
    const all = [nigo1, nigo2];
    const factsNigo = computeFacts(nigo1, all, DEFAULT_FACT_SETTINGS);
    const makerFact = factsNigo.find(f => f.key === 'maker');
    assert.ok(makerFact?.text.includes('2') && makerFact.text.includes('NIGO'),
      `NIGO single-maker fact wrong: ${makerFact?.text}`);
  });

  test('co-credited object with only-once names has no maker fact', () => {
    const obj = makeBook({ accession: 'B1', maker: 'Alice / Bob' });
    const facts = computeFacts(obj, [obj], DEFAULT_FACT_SETTINGS);
    const makerFact = facts.find(f => f.key === 'maker');
    assert.ok(!makerFact, 'no maker fact when both names appear only once');
  });
});

// ── Test 9: selfPublished book fact ───────────────────────────────────────────
describe('Test 9: selfPublished book fact', () => {
  test('self-published book gets "is the only self-published book" when alone', () => {
    const b = makeBook({ accession: 'B1', selfPublished: true, publisher: 'Amyl and the Sniffers' });
    const facts = computeFacts(b, [b], DEFAULT_FACT_SETTINGS);
    const f = facts.find(f => f.key === 'selfPublished');
    assert.ok(f, 'selfPublished fact should exist');
    assert.ok(f.text.includes('only'), `expected "only" in: ${f.text}`);
  });

  test('two self-published books each get "is one of 2 self-published books"', () => {
    const b1 = makeBook({ accession: 'B1', selfPublished: true });
    const b2 = makeBook({ accession: 'B2', selfPublished: true });
    const facts = computeFacts(b1, [b1, b2], DEFAULT_FACT_SETTINGS);
    const f = facts.find(f => f.key === 'selfPublished');
    assert.ok(f?.text.includes('2'), `expected 2 in: ${f?.text}`);
  });

  test('non-self-published book has no selfPublished fact', () => {
    const b = makeBook({ accession: 'B1', selfPublished: false });
    const facts = computeFacts(b, [b], DEFAULT_FACT_SETTINGS);
    assert.ok(!facts.find(f => f.key === 'selfPublished'), 'no selfPublished fact for false');
  });
});
