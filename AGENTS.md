# Parallel work and release rules

Preserve changes from other tasks in this shared workspace. Never reset or replace unrelated source files.

All hot updates must use `.github/workflows/publish-hotupdate.yml`. Complete and validate the requested changes before committing them; only committed changes integrated into `main` are releasable. Pushing `main` schedules a complete build. To explicitly request another run use `npm run release:request`.

Never publish a downloaded baseline with patched webpack modules, overwrite the live `www.zip` or `manifest.json` directly, or use ad hoc SCP/deploy scripts for hot updates. These bypass the source and server gates and can remove another task's features. Do not claim a release is live merely because a local test passed: verify the published manifest commit and actual feature behavior.

For local concurrent builds set unique `TARO_OUTPUT_DIR` and `WAREHOUSE_BUILD_STAGE` under `release/`. Never build into another task's directories. The CI workflow supplies isolated directories and validates the complete build. Do not merge unfinished work automatically or include credentials in commits.
