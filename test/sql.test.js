import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySql } from '../src/sql.js';

const reads = [
  'SELECT * FROM orders WHERE id = 1',
  'select count(*) from users; select 1',
  "SELECT 'DELETE FROM users' AS s",
  'SELECT "update" FROM t',
  '-- DELETE FROM x\nSELECT 1',
  '/* DROP TABLE x */ SELECT 1',
  'WITH a AS (SELECT 1) SELECT * FROM a',
  'EXPLAIN SELECT * FROM t',
  'EXPLAIN UPDATE t SET a = 1',
  'EXPLAIN ANALYZE SELECT * FROM t',
  'SHOW TABLES',
  'DESCRIBE users',
  'PRAGMA table_info(users)',
  'SELECT $$DROP TABLE x$$',
  'SELECT $fn$ DELETE $fn$',
  'BEGIN; SELECT 1; COMMIT;',
  'SELECT * FROM t FOR UPDATE',
  'TABLE users',
  '',
];
const writes = [
  ['UPDATE orders SET status = \'refunded\' WHERE id = 1042', 'UPDATE'],
  ['delete from users', 'DELETE'],
  ['INSERT INTO t VALUES (1)', 'INSERT'],
  ['DROP TABLE users', 'DROP TABLE'],
  ['DROP TABLE IF EXISTS users', 'DROP TABLE'],
  ['CREATE OR REPLACE VIEW v AS SELECT 1', 'CREATE VIEW'],
  ['CREATE UNIQUE INDEX CONCURRENTLY i ON t(a)', 'CREATE INDEX'],
  ['ALTER TABLE t ADD COLUMN b int', 'ALTER TABLE'],
  ['TRUNCATE t', 'TRUNCATE'],
  ['SELECT 1; DELETE FROM t WHERE id = 2', 'DELETE'],
  ['WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d', 'WITH … DELETE'],
  ['SELECT * INTO backup FROM t', 'SELECT INTO'],
  ['EXPLAIN ANALYZE DELETE FROM t WHERE id = 1', 'EXPLAIN ANALYZE DELETE'],
  ['EXPLAIN (ANALYZE, BUFFERS) UPDATE t SET a = 1 WHERE b = 2', 'EXPLAIN ANALYZE UPDATE'],
  ['SELECT pg_terminate_backend(123)', 'SELECT (side-effect function)'],
  ["SELECT setval('s', 1)", 'SELECT (side-effect function)'],
  ['PRAGMA journal_mode = WAL', 'PRAGMA'],
  ['GRANT ALL ON t TO bob', 'GRANT'],
  ['CALL do_things()', 'CALL'],
  ["DO $$ BEGIN DELETE FROM t; END $$", 'DO'],
  ['COPY t FROM \'/tmp/x\'', 'COPY'],
  ['VACUUM', 'VACUUM'],
  ['SET ROLE admin', 'SET'],
  ["SELECT 'unterminated", 'UNPARSEABLE'],
  ['MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE', 'MERGE'],
];

for (const sql of reads) {
  test(`read: ${JSON.stringify(sql)}`, () => {
    const r = classifySql(sql);
    assert.equal(r.write, false, JSON.stringify(r));
  });
}
for (const [sql, kind] of writes) {
  test(`write: ${sql}`, () => {
    const r = classifySql(sql);
    assert.equal(r.write, true);
    assert.ok(r.kinds.includes(kind), `kinds ${JSON.stringify(r.kinds)} should include ${kind}`);
  });
}

test('warns about UPDATE/DELETE without WHERE and DROP', () => {
  assert.match(classifySql('DELETE FROM users').warnings.join(), /without WHERE/);
  assert.equal(classifySql('DELETE FROM users WHERE id = 1').warnings.length, 0);
  assert.match(classifySql('DROP TABLE users').warnings.join(), /cannot be undone/);
});
