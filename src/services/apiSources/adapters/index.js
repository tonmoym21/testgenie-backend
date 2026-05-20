// Adapter registry — adding a new source type (GraphQL, gRPC, HAR…) is one
// new file in this directory plus a line below. No core changes required.

const openapi = require('./openapi');
const postman = require('./postman');
const curl = require('./curl');
const urlProbe = require('./urlProbe');

const ADAPTERS = [
  { format: 'openapi3',  adapter: openapi },
  { format: 'openapi2',  adapter: openapi },
  { format: 'postman21', adapter: postman },
  { format: 'curl',      adapter: curl },
  { format: 'url_probe', adapter: urlProbe },
];

function adapterFor(format) {
  const entry = ADAPTERS.find((a) => a.format === format);
  return entry ? entry.adapter : null;
}

module.exports = { ADAPTERS, adapterFor };
