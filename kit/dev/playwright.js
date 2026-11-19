// Finds playwright-core for the kit's checks: an installed copy, the folder named in PLAYWRIGHT_CORE, or a copy
// already on this PC. The checks drive the Chrome installed on the PC (channel "chrome"); nothing is downloaded.
'use strict';

const fs = require('fs');
const path = require('path');

const KNOWN = [
  path.join(__dirname, '..', '..', 'node_modules', 'playwright-core')   // npm install in the kit repository
];

module.exports = (() => {
  try { return require('playwright-core'); } catch (missing) { /* fall through */ }
  if (process.env.PLAYWRIGHT_CORE) return require(process.env.PLAYWRIGHT_CORE);
  for (const folder of KNOWN) {
    if (fs.existsSync(path.join(folder, 'package.json'))) return require(folder);
  }
  throw new Error('playwright-core was not found. Set PLAYWRIGHT_CORE to the folder of a copy on this PC.');
})();
