'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { verify } = require('./verify-backend-release');

const root = path.resolve(__dirname, '..');
const PUBLISHER = path.join(root, 'scripts', 'publish-backend.py');
const DAILY_STATUS_VERIFIER = path.join(root, 'scripts', 'verify-backend-daily-status.js');
const BILLING_VERIFIER = path.join(root, 'scripts', 'verify-backend-billing.cjs');
const BACKUP_ROOT = '/opt/shuguang/backups/backend-release';
const PUBLISHER_FAILURE_MARKER = 'BACKEND_PUBLISH_FAILURE ';
const PUBLISHER_FAILURE_ENUMS = {
  phase: new Set([
    'startup', 'argument_validation', 'load_bundle', 'materialize_preflight',
    'service_properties', 'backup_create_staging', 'acquire_lock',
    'backup_stage_files', 'activate_files', 'restart_service',
    'daily_status_acceptance', 'billing_acceptance', 'write_acceptance',
    'rollback_files', 'rollback_restart', 'cleanup'
  ]),
  exception: new Set([
    'OSError', 'ValueError', 'RuntimeError', 'TimeoutExpired',
    'CalledProcessError', 'JSONDecodeError', 'Exception'
  ]),
  reason: new Set([
    'backend_bundle_invalid', 'backend_bundle_incomplete',
    'backend_bundle_content_invalid', 'backend_bundle_dependency_missing',
    'staged_preflight_failed', 'staged_preflight_timeout',
    'service_configuration_invalid', 'backup_failed', 'lock_failed',
    'staging_failed', 'file_activation_failed', 'service_restart_failed',
    'service_inactive', 'daily_status_failed', 'billing_failed',
    'acceptance_write_failed', 'permission_denied', 'operation_timeout',
    'storage_io_failed', 'unexpected_error'
  ]),
  rollback: new Set([
    'not_attempted', 'restored', 'file_restore_failed', 'service_restart_failed'
  ])
};
const SOURCE_PATHS = [
  'backend',
  'deploy/backend-release',
  'scripts/publish-backend.py',
  'scripts/verify-backend-release.js',
  'scripts/verify-backend-daily-status.js',
  'scripts/verify-backend-billing.cjs',
  'scripts/upload-backend.cjs'
];
const REMOTE_SUMMARY_SCRIPT = [
  'import hashlib,json,pathlib,subprocess,sys',
  "acceptance=json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8-sig'))",
  "bundle=json.loads(pathlib.Path(sys.argv[2]).read_text(encoding='utf-8-sig'))",
  "working=subprocess.check_output(['systemctl','show','shuguang.service','--property=WorkingDirectory','--value'],text=True).strip()",
  "service=subprocess.check_output(['systemctl','show','shuguang.service','--property=ActiveState','--property=MainPID','--no-pager'],text=True)",
  "state=dict(line.split('=',1) for line in service.splitlines() if '=' in line)",
  'root=pathlib.Path(working)',
  "names=sorted(name for name in bundle['files'] if not name.startswith('node_modules/'))",
  "hashes={name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in names}",
  "print(json.dumps({'acceptance':acceptance,'hashes':hashes,'service':{'active':state.get('ActiveState')=='active','mainPid':int(state.get('MainPID','0'))}},separators=(',',':')))"
].join(';');

function shellQuote(value) {
  return "'" + String(value).replaceAll("'", "'\\''") + "'";
}

function parseBundle(bundleFile) {
  return JSON.parse(fs.readFileSync(bundleFile, 'utf8').replace(/^\ufeff/, ''));
}

function validateLocalBundle(bundleFile, releaseCommit, options = {}) {
  if (!bundleFile) throw new Error('BACKEND_LOCAL_BUNDLE must be explicitly set');
  if (!/^[a-f0-9]{40,64}$/.test(releaseCommit || '')) throw new Error('RELEASE_COMMIT must be a full Git commit');
  const absoluteBundle = path.resolve(root, bundleFile);
  const verified = verify(absoluteBundle, releaseCommit);
  const bundle = parseBundle(absoluteBundle);
  const sourceRoot = options.sourceRoot || root;
  for (const [name, metadata] of Object.entries(bundle.files)) {
    if (name.startsWith('node_modules/')) continue;
    const sourcePath = path.resolve(sourceRoot, 'backend', ...name.split('/'));
    if (!sourcePath.startsWith(path.resolve(sourceRoot, 'backend') + path.sep)) {
      throw new Error('backend release source path escapes backend directory');
    }
    const repositoryPath = `backend/${name}`;
    const isTracked = options.isTracked || ((candidate, revision) => {
      try {
        execFileSync('git', ['cat-file', '-e', `${revision}:${candidate}`], {
          cwd: options.cwd || root, stdio: 'ignore'
        });
        return true;
      } catch { return false; }
    });
    if (!isTracked(repositoryPath, releaseCommit)) throw new Error(`backend release source is not tracked by Git at ${releaseCommit}: ${name}`);
    const sourceBytes = fs.readFileSync(sourcePath);
    if (crypto.createHash('sha256').update(sourceBytes).digest('hex') !== metadata.sha256) {
      throw new Error(`backend release source does not match committed file: ${name}`);
    }
  }
  const sourceHashes = Object.fromEntries(
    Object.entries(bundle.files)
      .filter(([name]) => !name.startsWith('node_modules/'))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, metadata]) => [name, metadata.sha256])
  );
  if (!Object.keys(sourceHashes).length) throw new Error('backend release has no source files');
  return {
    bundleFile: absoluteBundle,
    commit: verified.commit,
    files: verified.files,
    sourceHashes
  };
}

function validateProvenance(releaseCommit, options = {}) {
  const runGit = options.runGit || ((args) => execFileSync('git', args, {
    cwd: options.cwd || root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }));
  if (!/^[a-f0-9]{40,64}$/.test(releaseCommit || '')) throw new Error('RELEASE_COMMIT must be a full Git commit');

  const head = runGit(['rev-parse', 'HEAD']).trim();
  const dirty = runGit([
    'status',
    '--porcelain=v1',
    '--untracked-files=normal',
    '--',
    ...SOURCE_PATHS,
    ':(exclude,glob)backend/public/uploads/**'
  ]).trim();
  if (dirty) throw new Error('backend release source has uncommitted changes');

  const remoteLines = runGit(['ls-remote', 'origin', 'refs/heads/main']).trim().split(/\r?\n/);
  const latest = remoteLines
    .map(line => line.trim().match(/^([a-f0-9]{40,64})\s+refs\/heads\/main$/))
    .find(Boolean)?.[1];
  if (!latest || head !== releaseCommit || head !== latest) {
    throw new Error('backend release commit must equal HEAD and the latest origin/main');
  }
  return { commit: head, latest };
}

function connection(env = process.env) {
  const host = env.HOTUPDATE_HOST;
  const user = env.HOTUPDATE_USER;
  if (!/^[A-Za-z0-9.-]+$/.test(host || '') || !/^[A-Za-z0-9_-]+$/.test(user || '')) {
    throw new Error('HOTUPDATE_HOST and HOTUPDATE_USER are required');
  }
  const port = Number(env.HOTUPDATE_PORT || 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SSH port');
  if (!env.SSH_PRIVATE_KEY && !env.HOTUPDATE_PASSWORD) {
    throw new Error('SSH_PRIVATE_KEY or HOTUPDATE_PASSWORD is required');
  }
  return { target: `${user}@${host}`, port: String(port) };
}

function createRemotePlan(bundleFile, releaseCommit, id = crypto.randomUUID()) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('invalid backend staging id');
  if (!/^[a-f0-9]{40,64}$/.test(releaseCommit || '')) throw new Error('RELEASE_COMMIT must be a full Git commit');
  const stage = `/tmp/shuguang-backend-${id}`;
  const acceptance = `${stage}/acceptance.json`;
  const names = {
    bundle: 'bundle.json',
    publisher: 'publish-backend.py',
    verifier: 'verify-backend-daily-status.js',
    billingVerifier: 'verify-backend-billing.cjs'
  };
  const remoteFiles = Object.values(names).map(name => `${stage}/${name}`);
  const cleanup = `rm -f -- ${[...remoteFiles, acceptance].map(shellQuote).join(' ')}; rmdir -- ${shellQuote(stage)}`;
  const publish = [
    `RELEASE_COMMIT=${shellQuote(releaseCommit)}`,
    'python3',
    shellQuote(`${stage}/${names.publisher}`),
    shellQuote(`${stage}/${names.bundle}`),
    shellQuote(BACKUP_ROOT),
    shellQuote(acceptance),
    '--restart'
  ].join(' ');
  const summary = [
    'python3',
    '-c',
    shellQuote(REMOTE_SUMMARY_SCRIPT),
    shellQuote(acceptance),
    shellQuote(`${stage}/${names.bundle}`)
  ].join(' ');
  return {
    stage,
    acceptance,
    names,
    remoteFiles,
    cleanup,
    mkdir: `umask 077 && mkdir -m 700 -- ${shellQuote(stage)}`,
    publish,
    summary
  };
}

function sanitizedChildEnv(env = process.env, additions = {}) {
  const childEnv = { ...env, ...additions };
  delete childEnv.SSH_PRIVATE_KEY;
  delete childEnv.HOTUPDATE_PASSWORD;
  delete childEnv.SSHPASS;
  return childEnv;
}

function withAuth(run, env = process.env, execute = execFileSync) {
  if (env.SSH_PRIVATE_KEY) {
    let agentEnv;
    try {
      const output = execute('ssh-agent', ['-s'], {
        encoding: 'utf8',
        env: sanitizedChildEnv(env),
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const socket = output.match(/SSH_AUTH_SOCK=([^;\s]+);/);
      const pid = output.match(/SSH_AGENT_PID=(\d+);/);
      if (!socket || !pid) throw new Error('agent did not return connection details');
      agentEnv = sanitizedChildEnv(env, { SSH_AUTH_SOCK: socket[1], SSH_AGENT_PID: pid[1] });
      execute('ssh-add', ['-'], {
        encoding: 'utf8',
        input: env.SSH_PRIVATE_KEY,
        env: agentEnv,
        stdio: ['pipe', 'ignore', 'pipe']
      });
    } catch {
      if (agentEnv) {
        try { execute('ssh-agent', ['-k'], { encoding: 'utf8', env: agentEnv, stdio: ['ignore', 'ignore', 'ignore'] }); } catch {}
      }
      throw new Error('unable to load SSH_PRIVATE_KEY into a temporary SSH agent');
    }
    try { return run(agentEnv, false); }
    finally {
      try { execute('ssh-agent', ['-k'], { encoding: 'utf8', env: agentEnv, stdio: ['ignore', 'ignore', 'ignore'] }); } catch {}
    }
  }
  const childEnv = sanitizedChildEnv(env);
  childEnv.SSHPASS = env.HOTUPDATE_PASSWORD;
  return run(childEnv, true);
}

function classifyRemoteFailure(error) {
  const diagnostic = [error?.stderr, error?.stdout]
    .map(value => Buffer.isBuffer(value) ? value.toString('utf8') : String(value || ''))
    .join('\n')
    .toLowerCase();
  const classifications = [
    [/connection timed out|connect timed out|operation timed out|etimedout/, 'SSH connection timed out'],
    [/connection refused|econnrefused/, 'SSH connection refused'],
    [/connection reset|reset by peer|econnreset/, 'SSH connection reset'],
    [/could not resolve hostname|name or service not known|temporary failure in name resolution|no route to host|network is unreachable|ehostunreach|enetunreach/, 'SSH host or network unreachable'],
    [/host key verification failed|remote host identification has changed|no matching host key type/, 'SSH host-key verification failed'],
    [/permission denied \(publickey|permission denied \(password|permission denied \(publickey,password|authentication failed|too many authentication failures|no supported authentication methods/, 'SSH authentication failed'],
    [/could not open remote file|failed to upload|scp:.*permission denied|permission denied.*(?:bundle\.json|publish-backend\.py|verify-backend)/, 'remote staging upload was denied'],
    [/staged backend preflight failed|preflight (?:contract|failed)/, 'staged backend preflight failed'],
    [/service must run as a non-root user/, 'service account must be non-root'],
    [/service working directory is invalid/, 'service working-directory configuration is invalid'],
    [/service restart failed|service did not become active after restart/, 'backend service restart or activation failed'],
    [/daily status verification failed|daily-status acceptance failed/, 'daily-status acceptance failed'],
    [/billing verification failed|production billing acceptance failed/, 'billing acceptance failed'],
    [/backend release has a missing or unsafe local dependency|backend release is incomplete|backend release is missing express runtime content/, 'backend bundle is incomplete or has a missing dependency'],
    [/invalid backend release format|backend release commit mismatch|backend release is incomplete|backend release content mismatch|backend release contains unexpected binary data/, 'backend bundle validation failed'],
    [/backend service is not active|deployed backend source hash(?: set)? mismatch|deployed backend source hash set does not match the bundle/, 'deployed backend service or source-hash check failed'],
    [/backend acceptance summary is invalid|remote backend acceptance summary is invalid/, 'deployed backend acceptance summary is invalid']
  ];
  return classifications.find(([pattern]) => pattern.test(diagnostic))?.[1] || 'remote command returned an unclassified error';
}

function validatedPublisherFailure(error) {
  const stderr = Buffer.isBuffer(error?.stderr) ? error.stderr.toString('utf8') : String(error?.stderr || '');
  for (const line of stderr.split(/\r?\n/).slice(-100)) {
    if (!line.startsWith(PUBLISHER_FAILURE_MARKER) || line.length > 2048) continue;
    let marker;
    try { marker = JSON.parse(line.slice(PUBLISHER_FAILURE_MARKER.length)); }
    catch { continue; }
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)) continue;
    if (Object.keys(marker).sort().join(',') !== 'errno,exception,phase,reason,rollback') continue;
    if (!PUBLISHER_FAILURE_ENUMS.phase.has(marker.phase)
      || !PUBLISHER_FAILURE_ENUMS.exception.has(marker.exception)
      || !PUBLISHER_FAILURE_ENUMS.reason.has(marker.reason)
      || !PUBLISHER_FAILURE_ENUMS.rollback.has(marker.rollback)) continue;
    if (marker.errno !== null && (!Number.isSafeInteger(marker.errno) || marker.errno <= 0)) continue;
    return {
      phase: marker.phase,
      exception: marker.exception,
      errno: marker.errno,
      reason: marker.reason,
      rollback: marker.rollback
    };
  }
  return null;
}



function executeRemote(phase, command, args, options = {}, authEnv, usePassword = false, execute = execFileSync) {
  const executable = usePassword ? 'sshpass' : command;
  const commandArgs = usePassword ? ['-e', command, ...args] : args;
  try {
    return execute(executable, commandArgs, {
      ...options,
      env: authEnv,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024
    });
  } catch (error) {
    const details = [];
    if (Number.isInteger(error?.status) && error.status >= 0) details.push(`exit=${error.status}`);
    const publisherFailure = validatedPublisherFailure(error);
    if (publisherFailure) {
      details.push(`publisherPhase=${publisherFailure.phase}`);
      details.push(`publisherReason=${publisherFailure.reason}`);
      details.push(`publisherException=${publisherFailure.exception}`);
      details.push(`publisherRollback=${publisherFailure.rollback}`);
      if (publisherFailure.errno !== null) details.push(`publisherErrno=${publisherFailure.errno}`);
    } else {
      details.push(`reason=${classifyRemoteFailure(error)}`);
    }
    const safeCodes = new Set([
      'EACCES', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH',
      'ENOENT', 'ENETUNREACH', 'EPIPE', 'ETIMEDOUT'
    ]);
    if (safeCodes.has(error?.code)) details.push(`code=${error.code}`);
    const safeSignals = new Set(['SIGHUP', 'SIGINT', 'SIGKILL', 'SIGTERM']);
    if (safeSignals.has(error?.signal)) details.push(`signal=${error.signal}`);
    const suffix = details.length ? ` (${details.join(', ')})` : '';
    throw new Error(`remote backend release failed during ${phase}${suffix}`);
  }
}

function validateRemoteSummary(raw, expectedHashes) {
  let result;
  try { result = JSON.parse(raw); } catch { throw new Error('remote backend acceptance summary is invalid'); }
  const acceptance = result?.acceptance;
  if (!acceptance || typeof acceptance !== 'object' || acceptance.dailyStatus?.status !== 200) {
    throw new Error('backend daily-status acceptance failed');
  }
  if (acceptance.billing?.verified !== true || acceptance.billing.productionReceivable !== 500
    || acceptance.billing.collected !== 100 || acceptance.billing.finalDebt !== 400
    || acceptance.billing.shipmentReceivable !== 0) {
    throw new Error('backend production billing acceptance failed');
  }
  const hashes = result.hashes;
  if (result.service?.active !== true || !Number.isSafeInteger(result.service?.mainPid) || result.service.mainPid <= 0) {
    throw new Error('backend service is not active after publication');
  }
  const names = Object.keys(expectedHashes).sort();
  if (!hashes || typeof hashes !== 'object' || Array.isArray(hashes)
    || Object.keys(hashes).sort().join('\0') !== names.join('\0')) {
    throw new Error('deployed backend source hash set does not match the bundle');
  }
  for (const name of names) {
    if (hashes[name] !== expectedHashes[name]) throw new Error(`deployed backend source hash mismatch: ${name}`);
  }
  return {
    acceptance: {
      dailyStatus: {
        status: acceptance.dailyStatus.status,
        verified: Boolean(acceptance.dailyStatus.verified),
        active: Boolean(acceptance.dailyStatus.active)
      },
      billing: {
        verified: acceptance.billing.verified,
        productionReceivable: acceptance.billing.productionReceivable,
        collected: acceptance.billing.collected,
        finalDebt: acceptance.billing.finalDebt,
        shipmentReceivable: acceptance.billing.shipmentReceivable
      }
    },
    service: {
      active: result.service.active,
      mainPid: result.service.mainPid
    },
    sourceHashes: hashes
  };
}

function upload(options = {}) {
  const env = options.env || process.env;
  const execute = options.execute || execFileSync;
  const bundleFile = env.BACKEND_LOCAL_BUNDLE;
  const releaseCommit = env.RELEASE_COMMIT;
  const release = validateLocalBundle(bundleFile, releaseCommit);
  validateProvenance(releaseCommit, { runGit: options.runGit });
  if (!fs.existsSync(PUBLISHER) || !fs.existsSync(DAILY_STATUS_VERIFIER) || !fs.existsSync(BILLING_VERIFIER)) {
    throw new Error('backend publisher or required acceptance verifier is missing');
  }
  const c = connection(env);
  const plan = createRemotePlan(release.bundleFile, releaseCommit, options.stagingId || crypto.randomUUID());
  const remote = (phase, command, args, input, authEnv, password) => executeRemote(phase, command, args, {
    cwd: root,
    input,
    maxBuffer: 32 * 1024 * 1024
  }, authEnv, password, execute);

  return withAuth((authEnv, password) => {
    let staged = false;
    const ssh = (phase, command) => remote(phase, 'ssh', [
      '-p', c.port,
      '-o', 'ConnectTimeout=15',
      c.target,
      command
    ], undefined, authEnv, password);
    const scp = (phase, source, destination) => remote(phase, 'scp', [
      '-P', c.port,
      '-o', 'ConnectTimeout=15',
      path.resolve(source),
      `${c.target}:${destination}`
    ], undefined, authEnv, password);

    try {
      ssh('create remote staging directory', plan.mkdir);
      staged = true;
      scp('upload backend bundle', release.bundleFile, `${plan.stage}/${plan.names.bundle}`);
      scp('upload backend publisher', PUBLISHER, `${plan.stage}/${plan.names.publisher}`);
      scp('upload daily-status verifier', DAILY_STATUS_VERIFIER, `${plan.stage}/${plan.names.verifier}`);
      scp('upload billing verifier', BILLING_VERIFIER, `${plan.stage}/${plan.names.billingVerifier}`);
      ssh('publish backend revision and run acceptance', plan.publish);
      const raw = ssh('read deployed backend acceptance', plan.summary);
      const summary = validateRemoteSummary(raw, release.sourceHashes);
      const output = {
        commit: release.commit,
        acceptance: summary.acceptance,
        sourceFiles: Object.keys(summary.sourceHashes).length,
        sourceHashes: summary.sourceHashes
      };
      process.stdout.write(JSON.stringify(output) + '\n');
      return output;
    } finally {
      if (staged) {
        try { ssh('clean temporary staging files', plan.cleanup); } catch {}
      }
    }
  }, env, execute);
}

if (require.main === module) {
  try { upload(); }
  catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  BACKUP_ROOT,
  SOURCE_PATHS,
  validateLocalBundle,
  validateProvenance,
  connection,
  createRemotePlan,
  executeRemote,
  validatedPublisherFailure,
  validateRemoteSummary,
  sanitizedChildEnv,
  withAuth,
  upload
};
