'use strict';

const BASE_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
  "script-src 'self' 'nonce-sg-bootstrap'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://youxishen.online http://localhost:* https://localhost:* http://127.0.0.1:*",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https://youxishen.online capacitor://localhost http://localhost:* https://localhost:* http://127.0.0.1:*",
  "worker-src 'self' blob:"
];

function contentSecurityPolicy(frameAncestors) {
  return [...BASE_CONTENT_SECURITY_POLICY, `frame-ancestors ${frameAncestors}`].join('; ') + ';';
}

const CONTENT_SECURITY_POLICY = contentSecurityPolicy("'none'");
const EMBEDDED_CONTENT_SECURITY_POLICY = contentSecurityPolicy("'self' app:");

function isEmbeddedViewPath(pathname) {
  const value = String(pathname || '');
  return value === '/embed' || value.startsWith('/embed/');
}

module.exports = {
  CONTENT_SECURITY_POLICY,
  EMBEDDED_CONTENT_SECURITY_POLICY,
  isEmbeddedViewPath
};
