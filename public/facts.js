// public/facts.js — category-aware facts for temporary collection
// Works as a browser <script> (sets window.factsModule) and as a Node require().
(function () {
  'use strict';

  // ── Type → family map ────────────────────────────────────────────────────────
  const FAMILIES = {
    Shirt:     'garment',
    Sweatshirt:'garment',
    Hoodie:    'garment',
    Book:      'book',
    Ephemera:  'ephemera',
  };

  function getFamily(x) {
    return FAMILIES[x.type] || 'garment';
  }

  // ── Colour helpers ───────────────────────────────────────────────────────────
  function hsl(hex) {
    if (!hex || hex.length < 7) return { h: 0, s: 0, l: 0.53 };
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    let h = 0, s = 0;
    if (mx !== mn) {
      const d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      h = mx === r ? (g - b) / d + (g < b ? 6 : 0)
        : mx === g ? (b - r) / d + 2
        : (r - g) / d + 4;
      h *= 60;
    }
    return { h, s, l };
  }

  function ord(n) {
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  // darkest (l=0) → lightest (l=1), 1-indexed
  function computeDarkRanks(pool) {
    const ranks = {};
    [...pool]
      .sort((a, b) => hsl(a.bodyColour || '#888').l - hsl(b.bodyColour || '#888').l)
      .forEach((x, i) => { if (x.accession) ranks[x.accession] = i + 1; });
    return ranks;
  }

  // ── Date helpers ─────────────────────────────────────────────────────────────
  // Returns { year, isDecade } or null.
  // "1984"     → { year: 1984, isDecade: false }
  // "1979-82"  → { year: 1979, isDecade: false }
  // "1980s"    → { year: 1980, isDecade: true }
  // "Undated" / empty / null → null
  function parseStartYear(date) {
    if (!date) return null;
    if (/undated/i.test(date)) return null;
    // Decade: "1980s"
    const dm = date.match(/^(\d{4})s$/i);
    if (dm) return { year: parseInt(dm[1], 10), isDecade: true };
    // Range: "1979-82", "1979–82", "1979-1982", "1979–1982"
    const rm = date.match(/^(\d{4})[-–]/);
    if (rm) return { year: parseInt(rm[1], 10), isDecade: false };
    // Exact: "1984"
    const em = date.match(/^(\d{4})$/);
    if (em) return { year: parseInt(em[1], 10), isDecade: false };
    // Any 4-digit year
    const am = date.match(/(\d{4})/);
    if (am) return { year: parseInt(am[1], 10), isDecade: false };
    return null;
  }

  function getStartYear(date) {
    const r = parseStartYear(date);
    return r ? r.year : null;
  }

  // Oldest (rank 1) → newest. Ties share a rank.
  // Exact years before decade-style within the same decade.
  // Exact year:  sortKey = year * 2
  // Decade year: sortKey = (year + 9) * 2 + 1   e.g. "1980s" → after 1989, before 1990
  function computeAgeRanks(pool) {
    const dated = pool
      .filter(x => x.accession && parseStartYear(x.date) !== null)
      .map(x => {
        const r = parseStartYear(x.date);
        const sortKey = r.isDecade ? (r.year + 9) * 2 + 1 : r.year * 2;
        return { acc: x.accession, sortKey };
      });
    dated.sort((a, b) => a.sortKey - b.sortKey);
    const ranks = {};
    for (let i = 0; i < dated.length; i++) {
      const rank = i > 0 && dated[i].sortKey === dated[i - 1].sortKey
        ? ranks[dated[i - 1].acc]
        : i + 1;
      ranks[dated[i].acc] = rank;
    }
    return ranks;
  }

  // Fewest pages (rank 1) → most. Ties share a rank.
  function computePagesRanks(pool) {
    const wp = pool.filter(x => x.accession && x.pages)
      .map(x => ({ acc: x.accession, pages: Number(x.pages) }));
    wp.sort((a, b) => a.pages - b.pages);
    const ranks = {};
    for (let i = 0; i < wp.length; i++) {
      const rank = i > 0 && wp[i].pages === wp[i - 1].pages
        ? ranks[wp[i - 1].acc]
        : i + 1;
      ranks[wp[i].acc] = rank;
    }
    return ranks;
  }

  // ── Default fact order per family ────────────────────────────────────────────
  const DEFAULT_FACT_SETTINGS = {
    garment: [
      { key: 'maker',      enabled: true  },
      { key: 'label',      enabled: true  },
      { key: 'tagless',    enabled: true  },
      { key: 'note',       enabled: true  },
      { key: 'sleeve',     enabled: true  },
      { key: 'colour',     enabled: true  },
      { key: 'department', enabled: true  },
      { key: 'decade',     enabled: true  },
    ],
    book: [
      { key: 'maker',         enabled: true  },
      { key: 'publisher',     enabled: true  },
      { key: 'selfPublished', enabled: true  },
      { key: 'age',           enabled: true  },
      { key: 'signed',     enabled: true  },
      { key: 'edition',    enabled: true  },
      { key: 'cover',      enabled: true  },
      { key: 'pages',      enabled: true  },
      { key: 'colour',     enabled: true  },
      { key: 'department', enabled: true  },
      { key: 'decade',     enabled: true  },
    ],
    ephemera: [
      { key: 'maker',      enabled: true  },
      { key: 'kind',       enabled: true  },
      { key: 'city',       enabled: true  },
      { key: 'age',        enabled: true  },
      { key: 'colour',     enabled: true  },
      { key: 'department', enabled: true  },
      { key: 'decade',     enabled: true  },
    ],
  };

  const LABEL_EXCLUDE = /Unknown|Faded|Tagless|Custom/;

  // ── Main API ─────────────────────────────────────────────────────────────────

  // Returns [{ key, text }, ...] — facts applicable to x, in family order.
  // all:         full collection array (mix of statuses).
  // factSettings: { garment: [{key,enabled},...], book:[...], ephemera:[...] } or null/undefined.
  function computeFacts(x, all, factSettings) {
    if (!x || !x.accession) return [];

    const family = getFamily(x);

    // Only published objects enter any pool
    const published = all.filter(y => y.status === 'accessioned');
    const pool      = published.filter(y => getFamily(y) === family);

    // Rankings (all within pool)
    const darkRanks = computeDarkRanks(pool);
    const ageRanks  = computeAgeRanks(pool);

    // Fact order
    const settings = factSettings || {};
    const order = (settings[family] && settings[family].length)
      ? settings[family]
      : DEFAULT_FACT_SETTINGS[family];

    const allFacts = {};

    // ── SHARED (pool = whole published collection) ────────────────────────────
    // Split co-credited makers ("A / B") so each name counts separately
    const makerNames = x.maker.split(' / ').map(s => s.trim()).filter(Boolean);
    const makerFacts = makerNames
      .map(name => {
        const n = published.filter(y =>
          y.maker.split(' / ').map(s => s.trim()).some(m => m.toLowerCase() === name.toLowerCase())
        ).length;
        return n > 1 ? { name, n } : null;
      })
      .filter(Boolean);
    if (makerFacts.length > 0) {
      // Use first matching name fact (for single-maker objects this is the same as before)
      allFacts.maker = makerFacts.map(mf =>
        `is one of ${mf.n} ${mf.name} objects in the collection.`
      ).join(' ');
    }

    const sameDept = published.filter(y => y.department === x.department);
    if (sameDept.length > 1) {
      allFacts.department = `is one of ${sameDept.length} ${x.department} objects.`;
    }

    const yr = getStartYear(x.date);
    if (yr !== null) {
      const decade = Math.floor(yr / 10) * 10;
      const sameDecade = published.filter(y => {
        const yy = getStartYear(y.date);
        return yy !== null && Math.floor(yy / 10) * 10 === decade;
      });
      if (sameDecade.length > 1) {
        allFacts.decade = `is one of ${sameDecade.length} objects from the ${decade}s.`;
      }
    }

    // ── GARMENT ──────────────────────────────────────────────────────────────
    if (family === 'garment') {
      if (x.label && !LABEL_EXCLUDE.test(x.label)) {
        const key = x.label.split(' ').slice(0, 2).join(' ');
        const k = pool.filter(y => y.label && y.label.startsWith(key)).length;
        allFacts.label = k > 1
          ? `is one of ${k} objects on a ${key} label.`
          : `is the only object on a ${x.label.replace(/ label$/i, '')} label.`;
      }
      if (x.label === 'Tagless') {
        allFacts.tagless = 'has no label at all.';
      }
      if (x.sleeve === 'long') {
        const n = pool.filter(y => y.sleeve === 'long').length;
        allFacts.sleeve = `is one of ${n} long-sleeve objects.`;
      }
      if (darkRanks[x.accession]) {
        allFacts.colour = `ranks ${ord(darkRanks[x.accession])} of ${pool.length}, darkest to lightest.`;
      }
      if (x.note === 'Ringer') {
        allFacts.note = 'is a ringer, with a contrast collar and cuffs.';
      } else if (x.note === 'Crew shirt') {
        allFacts.note = 'is a crew shirt.';
      } else if (x.note && /Named collar/.test(x.note)) {
        allFacts.note = `has "${x.note.split(': ')[1]}" written inside the collar.`;
      }
    }

    // ── BOOK ─────────────────────────────────────────────────────────────────
    if (family === 'book') {
      if (x.publisher) {
        const n = pool.filter(y => y.publisher === x.publisher).length;
        allFacts.publisher = n > 1
          ? `is one of ${n} books published by ${x.publisher}.`
          : `is the only book from ${x.publisher}.`;
      }
      if (x.selfPublished) {
        const n = pool.filter(y => y.selfPublished).length;
        allFacts.selfPublished = n > 1
          ? `is one of ${n} self-published books.`
          : `is the only self-published book.`;
      }
      if (x.cover) {
        const label = x.cover === 'hard' ? 'hardcover' : 'softcover';
        const n = pool.filter(y => y.cover === x.cover).length;
        allFacts.cover = `is one of ${n} ${label} books.`;
      }
      if (ageRanks[x.accession]) {
        const datedN = pool.filter(y => getStartYear(y.date) !== null).length;
        allFacts.age = `ranks ${ord(ageRanks[x.accession])} of ${datedN} books, oldest to newest.`;
      }
      if (x.signed) {
        allFacts.signed = 'is signed.';
      }
      if (x.edition && /first edition|first printing/i.test(x.edition)) {
        allFacts.edition = 'is a first edition.';
      }
      if (x.pages) {
        const pRanks = computePagesRanks(pool);
        if (pRanks[x.accession]) {
          const withPagesN = pool.filter(y => y.pages).length;
          allFacts.pages = `ranks ${ord(pRanks[x.accession])} of ${withPagesN} books by page count, at ${x.pages} pages.`;
        }
      }
      if (darkRanks[x.accession]) {
        allFacts.colour = `ranks ${ord(darkRanks[x.accession])} of ${pool.length} books, darkest to lightest.`;
      }
    }

    // ── EPHEMERA ─────────────────────────────────────────────────────────────
    if (family === 'ephemera') {
      if (x.kind) {
        const n = pool.filter(y => y.kind === x.kind).length;
        // simple plural
        const plural = x.kind.endsWith('s') ? x.kind : x.kind + 's';
        allFacts.kind = n > 1
          ? `is one of ${n} ${plural}.`
          : `is the only ${x.kind}.`;
      }
      if (x.city) {
        const n = pool.filter(y => y.city === x.city).length;
        allFacts.city = `is one of ${n} pieces of ephemera from ${x.city}.`;
      }
      if (ageRanks[x.accession]) {
        const datedN = pool.filter(y => getStartYear(y.date) !== null).length;
        allFacts.age = `ranks ${ord(ageRanks[x.accession])} of ${datedN} pieces of ephemera, oldest to newest.`;
      }
      if (darkRanks[x.accession]) {
        allFacts.colour = `ranks ${ord(darkRanks[x.accession])} of ${pool.length} pieces of ephemera, darkest to lightest.`;
      }
    }

    // ── Apply order ───────────────────────────────────────────────────────────
    const result = [];
    for (const item of order) {
      if (!item.enabled) continue;
      if (allFacts[item.key] !== undefined) {
        result.push({ key: item.key, text: allFacts[item.key] });
      }
    }
    return result;
  }

  // Returns the lead fact text (plain string, empty if none).
  // Priority: customFacts > leadFact override > first enabled in family order.
  function resolveLead(x, all, factSettings) {
    if (x.customFacts && x.customFacts.length) {
      if (x.leadFact && x.leadFact.startsWith('custom:')) {
        const idx = parseInt(x.leadFact.slice(7), 10) - 1;
        return x.customFacts[idx] || x.customFacts[0];
      }
      return x.customFacts[0];
    }
    const fs = computeFacts(x, all, factSettings);
    if (x.leadFact) {
      const found = fs.find(f => f.key === x.leadFact);
      if (found) return found.text;
    }
    return fs.length ? fs[0].text : '';
  }

  // ── Export ───────────────────────────────────────────────────────────────────
  const factsModule = {
    computeFacts,
    resolveLead,
    parseStartYear,
    getStartYear,
    DEFAULT_FACT_SETTINGS,
    FAMILIES,
    getFamily,
  };

  if (typeof module !== 'undefined') module.exports = factsModule;
  else window.factsModule = factsModule;
}());
