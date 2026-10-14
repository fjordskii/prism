// Impression and conversion totals for decide and stats.
//
// events is the only application write. Triggers on events are the only writer
// of arm_counts. A null audience_key stays its own arm and is added at read
// time, because an audience created later must still see those rows. Null is
// stored as a flag: this SQLite build cannot upsert a NULL primary-key column.

import type { Database, Statement } from "bun:sqlite";

export type Totals = {
  impressions: number;
  conversions: number;
};

export type PooledTotals = {
  variants: ReadonlyMap<number, Totals>;
  control: Totals;
};

export type ExperienceArm = {
  variant_id: number | null;
  selector: string;
  audience_key: string;
  impressions: number;
  conversions: number;
};

function isControl(row: string): string {
  return `(${row}.variant_id IS NULL)`;
}

function storedVariantId(row: string): string {
  return `COALESCE(${row}.variant_id, 0)`;
}

function audienceIsNull(row: string): string {
  return `(${row}.audience_key IS NULL)`;
}

function storedAudienceKey(row: string): string {
  return `COALESCE(${row}.audience_key, '')`;
}

function grainWhere(row: string): string {
  return `site = ${row}.site
    AND is_control = ${isControl(row)}
    AND variant_id = ${storedVariantId(row)}
    AND selector = ${row}.selector
    AND audience_null = ${audienceIsNull(row)}
    AND audience_key = ${storedAudienceKey(row)}`;
}

const LEDGER_SQL = `
CREATE TABLE arm_counts (
  site TEXT NOT NULL,
  is_control INTEGER NOT NULL CHECK (is_control IN (0, 1)),
  variant_id INTEGER NOT NULL,
  selector TEXT NOT NULL,
  audience_null INTEGER NOT NULL CHECK (audience_null IN (0, 1)),
  audience_key TEXT NOT NULL,
  impressions INTEGER NOT NULL CHECK (impressions >= 0),
  conversions INTEGER NOT NULL CHECK (conversions >= 0),
  CHECK (is_control = 0 OR variant_id = 0),
  CHECK (audience_null = 0 OR audience_key = ''),
  PRIMARY KEY (site, is_control, variant_id, selector, audience_null, audience_key)
) WITHOUT ROWID;

CREATE INDEX arm_counts_by_variant ON arm_counts (
  is_control, variant_id, audience_null, audience_key, impressions, conversions
);

CREATE TRIGGER events_count_insert AFTER INSERT ON events
WHEN NEW.type = 'impression' OR NEW.type = 'conversion'
BEGIN
  INSERT INTO arm_counts (
    site, is_control, variant_id, selector, audience_null, audience_key, impressions, conversions
  ) VALUES (
    NEW.site,
    ${isControl("NEW")},
    ${storedVariantId("NEW")},
    NEW.selector,
    ${audienceIsNull("NEW")},
    ${storedAudienceKey("NEW")},
    NEW.type = 'impression',
    NEW.type = 'conversion'
  )
  ON CONFLICT (site, is_control, variant_id, selector, audience_null, audience_key) DO UPDATE SET
    impressions = impressions + excluded.impressions,
    conversions = conversions + excluded.conversions;
END;

CREATE TRIGGER events_count_delete AFTER DELETE ON events
WHEN OLD.type = 'impression' OR OLD.type = 'conversion'
BEGIN
  SELECT RAISE(ABORT, 'arm count missing')
  WHERE NOT EXISTS (
    SELECT 1 FROM arm_counts WHERE ${grainWhere("OLD")}
  );
  UPDATE arm_counts SET
    impressions = impressions - (OLD.type = 'impression'),
    conversions = conversions - (OLD.type = 'conversion')
  WHERE ${grainWhere("OLD")};
  DELETE FROM arm_counts
  WHERE ${grainWhere("OLD")}
    AND impressions = 0 AND conversions = 0;
END;

CREATE TRIGGER events_count_no_update BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;
`;

const REBUILD_SQL = `
INSERT INTO arm_counts (
  site, is_control, variant_id, selector, audience_null, audience_key, impressions, conversions
)
SELECT
  site,
  ${isControl("events")},
  ${storedVariantId("events")},
  selector,
  ${audienceIsNull("events")},
  ${storedAudienceKey("events")},
  SUM(type = 'impression'),
  SUM(type = 'conversion')
FROM events
WHERE type = 'impression' OR type = 'conversion'
GROUP BY
  site,
  ${isControl("events")},
  ${storedVariantId("events")},
  selector,
  ${audienceIsNull("events")},
  ${storedAudienceKey("events")};
`;

const META_SQL = `
CREATE TABLE IF NOT EXISTS counts_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  definition TEXT NOT NULL
);
`;

const DEFINITION = LEDGER_SQL + "\n" + REBUILD_SQL;

const BANDIT_UNKEYED_SQL = `
SELECT COALESCE(SUM(impressions), 0) AS impressions,
       COALESCE(SUM(conversions), 0) AS conversions
FROM arm_counts
WHERE is_control = 0
  AND variant_id = ?
  AND audience_null = 1
  AND audience_key = ''
`;

const BANDIT_KEYED_SQL = `
SELECT COALESCE(SUM(impressions), 0) AS impressions,
       COALESCE(SUM(conversions), 0) AS conversions
FROM arm_counts
WHERE is_control = 0
  AND variant_id = ?
  AND audience_null = 0
  AND audience_key = ?
`;

const POOLED_VARIANTS_SQL = `
SELECT variant_id AS variantId,
       SUM(impressions) AS impressions,
       SUM(conversions) AS conversions
FROM arm_counts
WHERE is_control = 0
  AND variant_id IN (SELECT id FROM variants WHERE site = ?)
GROUP BY variant_id
`;

const POOLED_CONTROL_SQL = `
SELECT COALESCE(SUM(impressions), 0) AS impressions,
       COALESCE(SUM(conversions), 0) AS conversions
FROM arm_counts
WHERE site = ? AND is_control = 1
`;

const EXPERIENCE_SQL = `
SELECT CASE WHEN is_control = 1 THEN NULL ELSE variant_id END AS variant_id,
       selector,
       audience_key,
       impressions,
       conversions
FROM arm_counts
WHERE site = ? AND audience_null = 0
`;

type Statements = {
  unkeyed: Statement;
  keyed: Statement;
  pooledVariants: Statement;
  pooledControl: Statement;
  experience: Statement;
};

const statements = new WeakMap<Database, Statements>();

function prepare(db: Database): Statements {
  const cached = statements.get(db);
  if (cached) return cached;
  const created: Statements = {
    unkeyed: db.prepare(BANDIT_UNKEYED_SQL),
    keyed: db.prepare(BANDIT_KEYED_SQL),
    pooledVariants: db.prepare(POOLED_VARIANTS_SQL),
    pooledControl: db.prepare(POOLED_CONTROL_SQL),
    experience: db.prepare(EXPERIENCE_SQL),
  };
  statements.set(db, created);
  return created;
}

function totalsOf(row: { impressions: number | bigint; conversions: number | bigint }): Totals {
  return { impressions: Number(row.impressions), conversions: Number(row.conversions) };
}

export function installEventCounts(db: Database): void {
  db.exec(META_SQL);
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT definition FROM counts_meta WHERE id = 1").get() as { definition: string } | null;
    if (row?.definition === DEFINITION) {
      db.exec("COMMIT");
      return;
    }
    db.exec("DROP TRIGGER IF EXISTS events_count_insert");
    db.exec("DROP TRIGGER IF EXISTS events_count_delete");
    db.exec("DROP TRIGGER IF EXISTS events_count_no_update");
    db.exec("DROP TABLE IF EXISTS arm_counts");
    db.exec(LEDGER_SQL);
    db.exec(REBUILD_SQL);
    db.prepare(
      "INSERT INTO counts_meta (id, definition) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET definition = excluded.definition",
    ).run(DEFINITION);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function banditTotals(db: Database, variantId: number, audienceKey: string | null): Totals {
  const stmt = prepare(db);
  const unkeyed = totalsOf(stmt.unkeyed.get(variantId) as { impressions: number; conversions: number });
  const keyed = totalsOf(stmt.keyed.get(variantId, audienceKey) as { impressions: number; conversions: number });
  return {
    impressions: unkeyed.impressions + keyed.impressions,
    conversions: unkeyed.conversions + keyed.conversions,
  };
}

export function pooledTotals(db: Database, site: string): PooledTotals {
  const stmt = prepare(db);
  const rows = stmt.pooledVariants.all(site) as { variantId: number; impressions: number; conversions: number }[];
  const variants = new Map<number, Totals>();
  for (const row of rows) variants.set(row.variantId, totalsOf(row));
  const control = totalsOf(stmt.pooledControl.get(site) as { impressions: number; conversions: number });
  return { variants, control };
}

export function experienceArms(db: Database, site: string): ExperienceArm[] {
  const rows = prepare(db).experience.all(site) as ExperienceArm[];
  return rows.map((row) => ({
    variant_id: row.variant_id,
    selector: row.selector,
    audience_key: row.audience_key,
    impressions: Number(row.impressions),
    conversions: Number(row.conversions),
  }));
}
