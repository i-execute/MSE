'use strict';
/* Where the build takes its pieces from, when the repository is not the one this tree grew out of.
   Everything is an env var with a neutral default; nothing here names a machine of anybody's. */
const path = require('path');
const ROOT = process.env.MSE_ROOT || path.join(__dirname, '..', '..');
module.exports = {
  ROOT,
  SRC: process.env.MSE_SRC_DIR || path.join(ROOT, 'Extensions', 'src'),
  VENDOR: process.env.MSE_VENDOR_DIR || path.join(ROOT, 'vendor', 'syncshare-2.22.0'),
  OUT: process.env.MSE_OUT_DIR || path.join(ROOT, 'Storage', 'artifacts', 'mse.user.js'),
  REPORT: process.env.MSE_REPORT || path.join(ROOT, 'Storage', 'artifacts', 'build-report.json')
};
