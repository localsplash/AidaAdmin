/** Canonical PlatformConfig setting keys; each database has its own app scope. */
export const DATABASE_SETTING_KEYS = [
  'DB_HOST',
  'DB_PORT',
  'DB_NAME',
  'DB_USER',
  'DB_PASSWORD',
] as const;
export const REQUIRED_DATABASE_KEYS = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'] as const;
export type DatabaseSettingKey = (typeof DATABASE_SETTING_KEYS)[number];
export type DatabaseSettings = Partial<Record<DatabaseSettingKey, string>>;

export interface MysqlConnectionConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export function missingDatabaseSettings(settings: DatabaseSettings): DatabaseSettingKey[] {
  return REQUIRED_DATABASE_KEYS.filter((key) => !settings[key]?.trim());
}

/** Never construct or percent-decode a URL: passwords are literal setting values. */
export function mysqlConnectionConfig(
  settings: DatabaseSettings,
  scope: string,
): MysqlConnectionConfig {
  const missing = missingDatabaseSettings(settings);
  if (missing.length)
    throw new Error(
      `Missing database configuration: ${missing.map((key) => `${scope}/${key}`).join(', ')}`,
    );
  const host = settings.DB_HOST!.trim();
  const database = settings.DB_NAME!.trim();
  const user = settings.DB_USER!.trim();
  const rawPort = settings.DB_PORT?.trim() || '3306';
  if (!/^[0-9]+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
    throw new Error(`Invalid database configuration: ${scope}/DB_PORT must be 1-65535`);
  }
  if (/[\s/@?#]/.test(host))
    throw new Error(
      `Invalid database configuration: ${scope}/DB_HOST must be a hostname or IP address`,
    );
  if (!/^[A-Za-z0-9_]{1,64}$/.test(database))
    throw new Error(`Invalid database configuration: ${scope}/DB_NAME must be a plain identifier`);
  return { host, port: Number(rawPort), database, user, password: settings.DB_PASSWORD! };
}
