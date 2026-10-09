const { execFileSync } = require('node:child_process');
try {
  execFileSync('gh', ['workflow', 'run', 'publish-hotupdate.yml', '--ref', 'main'], { stdio: 'inherit' });
  console.log('Requested a complete release from latest main. The workflow validates, builds and publishes through the shared gate.');
} catch (error) { console.error('Unable to request release: push completed changes to main, or authenticate gh and retry.'); process.exitCode = 1; }
