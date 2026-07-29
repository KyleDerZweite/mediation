// Preloaded into the MCP client via NODE_OPTIONS=--import. Makes one hostname
// resolve to a black-holed TEST-NET-3 address followed by a local one: the
// shape of a broken-IPv6 network, where the first connect attempt hangs and
// Happy Eyeballs must abandon it before falling through to the next address.
import dns from 'node:dns';

const real = dns.lookup;
dns.lookup = (host, opts, cb) => {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  if (host !== 'blackhole.invalid') return real.call(dns, host, opts, cb);
  const all = [
    { address: '203.0.113.1', family: 4 }, // black-holed: no SYN answer ever
    { address: '127.0.0.1', family: 4 },   // the test binds nothing here: refused
  ];
  return opts?.all ? cb(null, all) : cb(null, all[0].address, all[0].family);
};
