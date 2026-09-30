#!/usr/bin/env python3
"""Read-only post-publication IPA verification; requires independently expected values."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import plistlib
import re
import stat
import tempfile
import time
import urllib.parse
import urllib.request
import zipfile

METADATA_LIMIT = 1024 * 1024
PLIST_LIMIT = 1024 * 1024
DEFAULT_MAX_BYTES = 512 * 1024 * 1024


class VerificationError(Exception):
    pass


def origin(url):
    try:
        if not isinstance(url, str) or any(ord(c) < 33 for c in url) or '\\' in url:
            raise ValueError()
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username is not None or parsed.password is not None or parsed.fragment:
            raise ValueError()
        return (parsed.scheme, parsed.hostname.lower(), parsed.port or 443)
    except (ValueError, TypeError):
        raise VerificationError('URL must be HTTPS without credentials or fragment') from None


def check_origin(url, expected):
    if origin(url) != expected:
        raise VerificationError('Cross-origin URL or redirect rejected')


class SameOriginRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, expected):
        self.expected = expected

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check_origin(newurl, self.expected)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def unique_json(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise VerificationError('Duplicate metadata field')
        result[key] = value
    return result


def download(opener, url, target, expected_origin, limit, timeout, deadline):
    check_origin(url, expected_origin)
    request = urllib.request.Request(url, headers={
        'Cache-Control': 'no-cache, no-store', 'Pragma': 'no-cache',
        'Accept-Encoding': 'identity', 'User-Agent': 'Warehouse-Published-IPA-Verifier/1'})
    if time.monotonic() >= deadline:
        raise VerificationError('Verification deadline exceeded')
    digest, size = hashlib.sha256(), 0
    with opener.open(request, timeout=min(timeout, max(.001, deadline-time.monotonic()))) as response:
        check_origin(response.geturl(), expected_origin)
        if response.status != 200:
            raise VerificationError('Download did not return HTTP 200')
        if response.headers.get('Content-Encoding', 'identity').lower() != 'identity':
            raise VerificationError('Encoded HTTP response rejected')
        length = response.headers.get('Content-Length')
        if length is not None:
            if not re.fullmatch(r'[0-9]+', length) or int(length) > limit:
                raise VerificationError('Invalid or oversized Content-Length')
            length = int(length)
        with target.open('wb') as output:
            while True:
                if time.monotonic() >= deadline:
                    raise VerificationError('Verification deadline exceeded')
                # HTTPResponse.read1 performs at most one underlying read, so
                # a trickling peer cannot keep a buffered read filling forever.
                reader = getattr(response, 'read1', response.read)
                chunk = reader(min(65536, limit-size+1))
                if not chunk:
                    break
                size += len(chunk)
                if size > limit:
                    raise VerificationError('Download exceeds byte limit')
                digest.update(chunk)
                output.write(chunk)
        if length is not None and size != length:
            raise VerificationError('Truncated download or Content-Length mismatch')
    return size, digest.hexdigest()


def verify(metadata_url, expected_version, expected_build, expected_sha256, *,
           max_bytes=DEFAULT_MAX_BYTES, timeout=30, total_timeout=300):
    if not isinstance(expected_version, str) or not re.fullmatch(r'[0-9]+(?:[.][0-9]+)*', expected_version):
        raise VerificationError('Expected version must be explicit numeric dotted string')
    if not isinstance(expected_build, str) or not re.fullmatch(r'[0-9]+(?:[.][0-9]+)*', expected_build):
        raise VerificationError('Expected build must be explicit numeric string')
    if not isinstance(expected_sha256, str) or not re.fullmatch(r'[0-9a-fA-F]{64}', expected_sha256):
        raise VerificationError('Expected SHA256 must contain 64 hex characters')
    if type(max_bytes) is not int or not 1 <= max_bytes <= 2 * 1024**3:
        raise VerificationError('Maximum IPA bytes must be between 1 and 2 GiB')
    if any(not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v) or not 0 < v <= 3600 for v in (timeout, total_timeout)):
        raise VerificationError('Timeouts must be finite, positive and at most 3600 seconds')
    expected_sha256 = expected_sha256.lower()
    expected_origin = origin(metadata_url)
    opener = urllib.request.build_opener(SameOriginRedirect(expected_origin))
    deadline = time.monotonic() + total_timeout
    with tempfile.TemporaryDirectory(prefix='warehouse-ipa-verify-') as directory:
        root = Path(directory)
        download(opener, metadata_url, root/'ipa.json', expected_origin, METADATA_LIMIT, timeout, deadline)
        metadata = json.loads((root/'ipa.json').read_text(encoding='utf-8-sig'), object_pairs_hook=unique_json)
        if not isinstance(metadata, dict):
            raise VerificationError('Metadata must be an object')
        if metadata.get('version') != expected_version or metadata.get('build') != expected_build:
            raise VerificationError('Metadata version/build differs from expected release')
        if not isinstance(metadata.get('sha256'), str) or metadata['sha256'].lower() != expected_sha256:
            raise VerificationError('Metadata SHA256 differs from expected release')
        size = metadata.get('sizeBytes')
        if type(size) is not int or not 0 < size <= max_bytes:
            raise VerificationError('Metadata sizeBytes is invalid or exceeds limit')
        if not isinstance(metadata.get('url'), str) or not metadata['url']:
            raise VerificationError('Metadata IPA URL is missing')
        ipa_url = urllib.parse.urljoin(metadata_url, metadata['url'])
        check_origin(ipa_url, expected_origin)
        ipa = root/'download.ipa'
        actual_size, actual_hash = download(opener, ipa_url, ipa, expected_origin, size, timeout, deadline)
        if actual_size != size or actual_hash != expected_sha256:
            raise VerificationError('Downloaded IPA size/SHA256 differs from expected release')
        with zipfile.ZipFile(ipa) as archive:
            entries = [entry for entry in archive.infolist() if re.fullmatch(r'Payload/[^/\\]+[.]app/Info[.]plist', entry.filename)]
            if len(entries) != 1:
                raise VerificationError('Expected exactly one Payload/*.app/Info.plist')
            entry = entries[0]
            if entry.file_size <= 0 or entry.file_size > PLIST_LIMIT or entry.flag_bits & 1 or stat.S_ISLNK(entry.external_attr >> 16):
                raise VerificationError('Unsafe Info.plist archive entry')
            with archive.open(entry) as stream:
                data = stream.read(PLIST_LIMIT + 1)
            if len(data) > PLIST_LIMIT:
                raise VerificationError('Info.plist exceeds byte limit')
            info = plistlib.loads(data)
        if not isinstance(info, dict) or info.get('CFBundleShortVersionString') != expected_version or info.get('CFBundleVersion') != expected_build:
            raise VerificationError('IPA Info.plist version/build differs from expected release')
        return {'status': 'verified', 'version': expected_version, 'build': expected_build,
                'sha256': actual_hash, 'sizeBytes': actual_size,
                'scope': 'Published bytes and bundle metadata; signature, installation and runtime not assessed'}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--metadata-url', required=True)
    parser.add_argument('--expected-version', required=True)
    parser.add_argument('--expected-build', required=True)
    parser.add_argument('--expected-sha256', required=True)
    parser.add_argument('--max-bytes', type=int, default=DEFAULT_MAX_BYTES)
    parser.add_argument('--timeout', type=float, default=30)
    parser.add_argument('--total-timeout', type=float, default=300)
    args = parser.parse_args(argv)
    try:
        result = verify(args.metadata_url, args.expected_version, args.expected_build, args.expected_sha256,
                        max_bytes=args.max_bytes, timeout=args.timeout, total_timeout=args.total_timeout)
    except Exception as error:
        # Never print raw HTTP/URL errors: they may contain query tokens or credentials.
        message = str(error) if isinstance(error, VerificationError) else 'Network, metadata or archive verification failed (' + type(error).__name__ + ')'
        print(json.dumps({'status': 'failed', 'error': message}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
