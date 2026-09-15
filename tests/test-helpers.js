const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadCore() {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'extension', 'shared-core.js'),
    'utf8',
  );
  const context = vm.createContext({ URL, URLSearchParams });
  vm.runInContext(source, context);
  return context.SCShuffleCore;
}

module.exports = { loadCore };
