import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../../scripts/db-users.sh', import.meta.url));
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

it('provisions from literal DB_* fields, validates before MySQL and never logs secrets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aida-admin-db-users-'));
  directories.push(directory);
  const capture = join(directory, 'capture.json');
  await writeFile(
    join(directory, 'mysql'),
    `#!/usr/bin/env node
let sql = ''; process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => sql += chunk);
process.stdin.on('end', async () => {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(process.env.CAPTURE_MYSQL, JSON.stringify({ sql, args: process.argv.slice(2), password: process.env.MYSQL_PWD }));
});\n`,
    { mode: 0o700 },
  );
  const password = "literal%40'\\$(not-a-command)\n";
  const env = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
    CAPTURE_MYSQL: capture,
    DB_HOST: 'app-network',
    DB_PORT: '3306',
    DB_NAME: 'aida_admin_db',
    DB_USER: 'admin_app_test',
    DB_PASSWORD: password,
    MYSQL_ADMIN_HOST: 'operator-tunnel',
    MYSQL_ADMIN_PORT: '13306',
    MYSQL_ADMIN_USER: 'operator',
    MYSQL_ADMIN_PASSWORD: 'operator-secret',
  };
  const result = await exec('bash', [script], { env });
  const recorded = JSON.parse(await readFile(capture, 'utf8')) as {
    sql: string;
    args: string[];
    password: string;
  };
  expect(recorded.args).toContain('--host=operator-tunnel');
  expect(recorded.args).toContain('--port=13306');
  expect(recorded.password).toBe('operator-secret');
  expect(recorded.sql).toContain("IDENTIFIED BY 'literal%40''\\\\$(not-a-command)\n'");
  expect(recorded.sql).toContain('REVOKE ALL PRIVILEGES, GRANT OPTION');
  expect(recorded.sql).toContain('GRANT ALL PRIVILEGES ON `aida\\_admin\\_db`.*');
  expect(JSON.stringify(recorded.args) + result.stdout + result.stderr).not.toMatch(
    /operator-secret|literal%40|not-a-command/,
  );
  for (const invalid of [
    { DB_HOST: '' },
    { DB_NAME: 'other_db' },
    { DB_USER: 'root' },
    { DB_USER: 'operator' },
    { DB_USER: 'bad-name' },
    { DB_PASSWORD: '' },
    { MYSQL_ADMIN_PASSWORD: '' },
    { MYSQL_ADMIN_PORT: '0' },
    { MYSQL_ADMIN_PORT: '65536' },
  ]) {
    await rm(capture, { force: true });
    await expect(exec('bash', [script], { env: { ...env, ...invalid } })).rejects.toThrow();
    await expect(readFile(capture)).rejects.toThrow();
  }
  await writeFile(join(directory, 'mysql'), '#!/bin/sh\necho "secret SQL error" >&2\nexit 1\n', {
    mode: 0o700,
  });
  await expect(exec('bash', [script], { env })).rejects.toMatchObject({
    stderr:
      '[db-users] MySQL provisioning failed; check connectivity/admin privileges and rerun.\n',
  });
});

const adminUrl = process.env.TEST_DB_USERS_MYSQL_URL;
describe.skipIf(!adminUrl)('disposable MySQL admin-store provisioning', () => {
  it('preserves literal passwords, isolates schema grants and is idempotent', async () => {
    const url = new URL(adminUrl!);
    expect(url.pathname).toMatch(/^\/aida_[a-z0-9_]+_test$/);
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const user = `aida_admin_${suffix}`;
    const table = `db_users_${suffix}`;
    const decoy = 'aidaxadminxdb';
    const admin = {
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
    const connection = await mysql.createConnection(admin);
    const password = "literal%40'\\passwordé\n";
    const env = {
      ...process.env,
      MYSQL_ADMIN_USER: admin.user,
      MYSQL_ADMIN_PASSWORD: admin.password,
      DB_HOST: admin.host,
      DB_PORT: String(admin.port),
      DB_NAME: 'aida_admin_db',
      DB_USER: user,
      DB_PASSWORD: password,
    };
    try {
      await exec('bash', [script], { env });
      const [original] = await connection.query(`SHOW GRANTS FOR '${user}'@'%'`);
      await exec('bash', [script], { env });
      expect((await connection.query(`SHOW GRANTS FOR '${user}'@'%'`))[0]).toEqual(original);
      await connection.query(`CREATE DATABASE \`${decoy}\``);
      await connection.query(`CREATE TABLE \`${decoy}\`.private_data (id INT)`);
      const app = await mysql.createConnection({
        ...admin,
        user,
        password,
        database: 'aida_admin_db',
      });
      try {
        await app.query(`CREATE TABLE \`${table}\` (id INT)`);
        await app.query(`INSERT INTO \`${table}\` VALUES (1)`);
        expect(
          (await app.query<mysql.RowDataPacket[]>(`SELECT * FROM \`${table}\``))[0],
        ).toHaveLength(1);
        await expect(app.query('SELECT * FROM mysql.user')).rejects.toThrow(/denied/);
        await expect(app.query(`SELECT * FROM \`${decoy}\`.private_data`)).rejects.toThrow(
          /denied/,
        );
      } finally {
        await app.end();
      }
    } finally {
      await connection.query(`DROP USER IF EXISTS '${user}'@'%'`);
      await connection.query(`DROP TABLE IF EXISTS aida_admin_db.\`${table}\``);
      await connection.query(`DROP DATABASE IF EXISTS \`${decoy}\``);
      await connection.end();
    }
  }, 30_000);
});
