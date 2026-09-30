const config = require('../ios/release-version.json');

// Anchor to the already published 1.1.4 (137). Each new workflow run
// increments the visible patch version; rerunning the same run stays stable.
function versionForRun(runNumber, base = config) {
  const run = Number(runNumber);
  const parts = String(base.baseVersion).split('.').map(Number);
  if (!Number.isSafeInteger(run) || run < base.baseRunNumber ||
      !Number.isSafeInteger(base.baseRunNumber) || base.baseRunNumber < 1 ||
      !/^[0-9]+[.][0-9]+[.][0-9]+$/.test(base.baseVersion) ||
      parts.some(part => !Number.isSafeInteger(part))) {
    throw new Error('Invalid iOS version baseline or workflow run number');
  }
  parts[2] += run - base.baseRunNumber;
  if (!Number.isSafeInteger(parts[2])) throw new Error('iOS patch version overflow');
  return parts.join('.');
}
if (require.main === module) {
  console.log('IOS_MARKETING_VERSION=' + versionForRun(process.env.GITHUB_RUN_NUMBER));
}
module.exports = { versionForRun };
