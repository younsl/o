import { Config } from '@backstage/config';

/**
 * The catalog is static config, so it doubles as the allowlist for what may be
 * recorded and as the retention list for what may be kept.
 */
export function readPlatformNames(config: Config): string[] {
  return (config.getOptionalConfigArray('app.platforms') ?? []).map(item =>
    item.getString('name'),
  );
}
