/**
 * Login preflight CLI:
 *
 *   npm run doctor -w server
 *
 * Prints the exact redirect_uri and /authorize URL this deployment sends to
 * id, plus every configuration problem that would make the round-trip fail,
 * naming variables only — never their values. Exits non-zero when something
 * blocks login, so it can gate a deployment.
 */
import { buildDiagnostics } from './diagnostics.js';
import { ConfigError, loadConfig } from './config.js';

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }

  const report = buildDiagnostics(config);
  console.log('AidaAdmin login preflight');
  console.log(`  environment:  ${config.nodeEnv}`);
  console.log(`  redirect_uri: ${report.callbackUri ?? '(cannot be built)'}`);
  console.log(`  authorize:    ${report.authorizeUrl ?? '(cannot be built)'}`);
  if (report.missingConfiguration.length > 0) {
    console.log(`  unset:        ${report.missingConfiguration.join(', ')}`);
  }

  if (report.findings.length === 0) {
    console.log('\nNo problems found.');
  } else {
    console.log('');
    for (const finding of report.findings) {
      console.log(`${finding.level === 'error' ? 'ERROR  ' : 'WARNING'} ${finding.summary}`);
      console.log(`        fix: ${finding.fix}`);
    }
  }

  if (!report.loginReady) {
    console.log('\nLogin cannot succeed until the errors above are resolved.');
    process.exit(1);
  }
}

main();
