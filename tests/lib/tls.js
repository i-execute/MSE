'use strict';
/* The self-signed certificate the gateway tests need, made here and never committed: a private key has no
   business in a public repository, even a throwaway one for 127.0.0.1. */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = path.join(__dirname, '..', 'fixtures', 'tls');

function ensureTls() {
  const cert = path.join(DIR, 'cert.pem');
  const key = path.join(DIR, 'key.pem');
  if (fs.existsSync(cert) && fs.existsSync(key)) return { cert, key };
  fs.mkdirSync(DIR, { recursive: true });
  execFileSync(process.env.MSE_OPENSSL || 'openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650',
    '-keyout', key, '-out', cert,
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'
  ], { stdio: 'ignore' });
  fs.chmodSync(key, 0o600);
  return { cert, key };
}

module.exports = { ensureTls, DIR };
