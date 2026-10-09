// Keep large warehouse imports bounded without applying the ordinary form limit.
const configuredMiB = Number(process.env.WAREHOUSE_BACKUP_MAX_MB);
const BACKUP_MAX_BYTES = (Number.isSafeInteger(configuredMiB) && configuredMiB >= 5 && configuredMiB <= 256 ? configuredMiB : 64) * 1024 * 1024;
module.exports = { BACKUP_MAX_BYTES };
