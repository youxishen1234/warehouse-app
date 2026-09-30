#!/usr/bin/env python3
"""Offline tests; every HTTP operation is mocked."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import plistlib
import unittest
from unittest.mock import patch
import urllib.request
import warnings
import zipfile

spec = importlib.util.spec_from_file_location('published', Path(__file__).with_name('verify-published-ios.py'))
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)
URL = 'https://downloads.example.test/download/ipa.json'
IPA_URL = 'https://downloads.example.test/shuguang.ipa'


def ipa(version='1.1.5', build='130', binary=False, duplicate=False, missing=False):
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        if not missing:
            body = plistlib.dumps({'CFBundleShortVersionString': version, 'CFBundleVersion': build},
                                 fmt=plistlib.FMT_BINARY if binary else plistlib.FMT_XML)
            archive.writestr('Payload/App.app/Info.plist', body)
            if duplicate:
                with warnings.catch_warnings():
                    warnings.simplefilter('ignore')
                    archive.writestr('Payload/App.app/Info.plist', body)
        archive.writestr('Payload/App.app/App', b'not executed')
    return output.getvalue()


class Response(io.BytesIO):
    def __init__(self, body, url, headers=None, status=200):
        super().__init__(body)
        self.url, self.status = url, status
        self.headers = {'Content-Length': str(len(body))} if headers is None else headers

    def geturl(self):
        return self.url


class PublishedTests(unittest.TestCase):
    def setUp(self):
        self.data = ipa()
        self.metadata = {'version': '1.1.5', 'build': '130', 'sizeBytes': len(self.data),
                         'sha256': hashlib.sha256(self.data).hexdigest(), 'url': '/shuguang.ipa'}
        self.calls = []
        self.metadata_body = None
        self.ipa_headers = None
        self.response_url = IPA_URL

    def fake_open(self, request, timeout):
        self.calls.append(request)
        self.assertGreater(timeout, 0)
        self.assertEqual(request.headers['Cache-control'], 'no-cache, no-store')
        if request.full_url == URL:
            body = self.metadata_body if self.metadata_body is not None else json.dumps(self.metadata).encode()
            return Response(body, URL)
        self.assertEqual(request.full_url, IPA_URL)
        return Response(self.data, self.response_url, self.ipa_headers)

    def run_verify(self, **kwargs):
        with patch.object(urllib.request.OpenerDirector, 'open', side_effect=self.fake_open):
            return v.verify(URL, '1.1.5', '130', kwargs.pop('expected_sha256', self.metadata['sha256']), **kwargs)

    def test_xml_success(self):
        self.assertEqual(self.run_verify()['status'], 'verified')
        self.assertEqual(len(self.calls), 2)

    def test_binary_success(self):
        self.data = ipa(binary=True)
        self.metadata.update(sizeBytes=len(self.data), sha256=hashlib.sha256(self.data).hexdigest())
        self.assertEqual(self.run_verify()['build'], '130')

    def test_metadata_version_build_mismatch(self):
        for key in ('version', 'build'):
            with self.subTest(key=key):
                old = self.metadata[key]
                self.metadata[key] = '999'
                with self.assertRaises(v.VerificationError): self.run_verify()
                self.metadata[key] = old

    def test_metadata_hash_mismatch(self):
        with self.assertRaises(v.VerificationError): self.run_verify(expected_sha256='a'*64)

    def test_ipa_hash_mismatch(self):
        self.data = self.data[:-1] + bytes([self.data[-1] ^ 1])
        with self.assertRaises(v.VerificationError): self.run_verify()

    def test_plist_mismatch(self):
        for version, build in [('1.1.4', '130'), ('1.1.5', '122')]:
            self.data = ipa(version, build)
            self.metadata.update(sizeBytes=len(self.data), sha256=hashlib.sha256(self.data).hexdigest())
            with self.assertRaises(v.VerificationError): self.run_verify()

    def test_unique_plist_required(self):
        for options in ({'duplicate': True}, {'missing': True}):
            self.data = ipa(**options)
            self.metadata.update(sizeBytes=len(self.data), sha256=hashlib.sha256(self.data).hexdigest())
            with self.assertRaises(v.VerificationError): self.run_verify()

    def test_invalid_zip(self):
        self.data = b'not a zip'
        self.metadata.update(sizeBytes=len(self.data), sha256=hashlib.sha256(self.data).hexdigest())
        with self.assertRaises(zipfile.BadZipFile): self.run_verify()

    def test_invalid_sizes(self):
        for size in (True, 0, -1, '123', v.DEFAULT_MAX_BYTES+1):
            self.metadata['sizeBytes'] = size
            with self.assertRaises(v.VerificationError): self.run_verify()

    def test_limit(self):
        with self.assertRaises(v.VerificationError): self.run_verify(max_bytes=10)

    def test_short_and_long_body(self):
        for adjustment in (-1, 1):
            self.metadata['sizeBytes'] = len(self.data)+adjustment
            with self.assertRaises(v.VerificationError): self.run_verify()

    def test_invalid_content_length(self):
        for value in ('-1', 'abc', str(len(self.data)+1)):
            self.ipa_headers = {'Content-Length': value}
            with self.assertRaises(v.VerificationError): self.run_verify()

    def test_missing_content_length_is_bounded(self):
        self.ipa_headers = {}
        self.assertEqual(self.run_verify()['status'], 'verified')
        self.data += b'x'
        with self.assertRaises(v.VerificationError): self.run_verify()

    def test_metadata_limit_and_duplicates(self):
        for body in (b' '* (v.METADATA_LIMIT+1), b'{"build":"130","build":"130"}'):
            self.metadata_body = body
            with self.assertRaises(v.VerificationError): self.run_verify()

    def test_bad_ipa_urls(self):
        for url in ('http://downloads.example.test/a', 'https://evil.example/a', '//evil.example/a',
                    'https://u:p@downloads.example.test/a', '/a#fragment'):
            self.metadata['url'] = url
            with self.assertRaises(v.VerificationError): self.run_verify()

    def test_redirect_checked_before_following(self):
        handler = v.SameOriginRedirect(v.origin(URL))
        req = urllib.request.Request(URL)
        for url in ('http://downloads.example.test/a', 'https://evil.example/a', 'https://u:p@downloads.example.test/a'):
            with self.assertRaises(v.VerificationError):
                handler.redirect_request(req, None, 302, 'Found', {}, url)
        result = handler.redirect_request(req, None, 302, 'Found', {}, IPA_URL)
        self.assertEqual(result.full_url, IPA_URL)

    def test_final_response_origin(self):
        self.response_url = 'https://evil.example/a'
        with self.assertRaises(v.VerificationError): self.run_verify()

    def test_encoded_response(self):
        self.ipa_headers = {'Content-Encoding': 'gzip'}
        with self.assertRaises(v.VerificationError): self.run_verify()

    def test_timeout_validation(self):
        for value in (0, -1, float('nan'), float('inf'), 3601):
            with self.assertRaises(v.VerificationError): self.run_verify(timeout=value)

    def test_version_validation_before_network(self):
        with patch.object(urllib.request.OpenerDirector, 'open') as opened:
            for bad in ('1x2', '1/2', '', 'abc'):
                with self.assertRaises(v.VerificationError):
                    v.verify(URL, bad, '130', 'a'*64)
                with self.assertRaises(v.VerificationError):
                    v.verify(URL, '1.1.5', bad, 'a'*64)
            opened.assert_not_called()

    def test_plist_unsafe_entries(self):
        for mode in ('symlink', 'oversize', 'wrong_name'):
            output = io.BytesIO()
            with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
                name = 'Payload/App.app/Info.plist' if mode != 'wrong_name' else 'Payload/AppXapp/InfoYplist'
                entry = zipfile.ZipInfo(name)
                if mode == 'symlink':
                    entry.create_system = 3
                    entry.external_attr = (0o120777 << 16)
                data = b'x' * (v.PLIST_LIMIT+1) if mode == 'oversize' else plistlib.dumps({'CFBundleVersion':'130', 'CFBundleShortVersionString':'1.1.5'})
                archive.writestr(entry, data)
            self.data = output.getvalue()
            self.metadata.update(sizeBytes=len(self.data), sha256=hashlib.sha256(self.data).hexdigest())
            with self.assertRaises(v.VerificationError): self.run_verify()

    def test_http_failure(self):
        with patch.object(urllib.request.OpenerDirector, 'open', return_value=Response(b'error', URL, status=503)):
            with self.assertRaises(v.VerificationError):
                v.verify(URL, '1.1.5', '130', 'a'*64)

    def test_overall_deadline(self):
        with patch.object(v.time, 'monotonic', side_effect=[0, 301]):
            with self.assertRaises(v.VerificationError): self.run_verify()

    def test_cli_error_redacts_url(self):
        secret = 'private-query-token'
        with patch.object(v, 'verify', side_effect=OSError(secret)), contextlib.redirect_stdout(io.StringIO()) as output:
            status = v.main(['--metadata-url', URL+'?token='+secret, '--expected-version', '1.1.5',
                             '--expected-build', '130', '--expected-sha256', 'a'*64])
        self.assertEqual(status, 1)
        self.assertNotIn(secret, output.getvalue())
        self.assertEqual(json.loads(output.getvalue())['status'], 'failed')


if __name__ == '__main__':
    unittest.main()
