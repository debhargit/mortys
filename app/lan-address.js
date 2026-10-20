// Which IPv4 address of this machine the other computers in the shop should be
// told to connect to.
//
//   const { lanAddress, lanAddressDetail } = require('./lan-address');
//   node lan-address.js --selftest
//   node lan-address.js              # show what this machine would advertise
//
// This is the most load-bearing guess the LAN deploy makes. It ends up in the
// UDP discovery announce, in the `terminals` table, and in machine-config.json
// -- which START HERE.txt tells a human to read to find the server. Get it
// wrong and every till reports "cannot reach the server" while the server sits
// there answering perfectly well on a different address.
//
// It had been got wrong three ways at once:
//
//   * server.js returned the FIRST non-internal IPv4 os.networkInterfaces()
//     happened to list, with no filtering at all -- on a machine with WSL, a
//     VPN and Tailscale that is effectively a coin toss.
//   * boot.js filtered by interface-name PREFIX against a fixed list
//     (vEthernet|VMware|Tailscale|WSL|...). A VPN adapter named
//     "DuckDuckGo.VPN" matches none of those, so it ranked level with the real
//     Wi-Fi adapter and won on list order.
//   * Both therefore chose 10.110.8.189 (the VPN) on the shop's own machine,
//     whose real LAN address is 192.168.12.240.
//
// So: match virtual/tunnel adapters anywhere in the name rather than only at
// the start, drop address ranges a shop LAN never uses, and rank what is left
// by how much it looks like an ordinary LAN. A VPN adapter that reveals
// nothing in its name (OpenVPN's TAP often shows up as plain "Ethernet 2")
// still cannot be told apart from a real NIC this way -- for that, and for any
// machine with two real NICs, the operator pins the answer:
//
//   machine-config.json:  { "lan_ip": "192.168.12.240", "lan_ip_pinned": true }
//
// A pinned address is returned as-is and boot.js leaves it alone. The stronger
// automatic answer would be to ask Windows which interface owns the default
// route; that needs a child process on a path called every few seconds by the
// discovery announce, so it is deliberately not done here.

const os = require('os');
const fs = require('fs');
const path = require('path');

// Virtual, tunnel and VPN adapters, matched anywhere in the interface name.
// Hyper-V/WSL/Docker publish their own private address that nothing else on
// the shop network can route to; a VPN's address routes somewhere, just never
// to the till in the next room.
const VIRTUAL = new RegExp([
  'vethernet', 'hyper-?v', 'virtual', 'vmware', 'virtualbox', 'vbox', 'docker', 'wsl',
  'loopback', 'npcap', 'pcap', 'bluetooth', 'teredo', 'isatap', 'tunnel', 'tun\\d', 'tap[-\\d]',
  'vpn', 'wireguard', 'wg\\d', 'openvpn', 'tailscale', 'zerotier', 'hamachi', 'radmin',
  'nord', 'proton', 'mullvad', 'surfshark', 'expressvpn', 'cloudflare', 'warp',
  'anyconnect', 'cisco', 'forticlient', 'globalprotect', 'pangp', 'juniper', 'sonicwall',
  'checkpoint', 'zscaler', 'netextender', 'softether', 'pppoe', 'ras ', 'wan miniport',
].join('|'), 'i');

// Ranges no shop LAN is ever on, whatever the adapter is called.
function isUnusable(ip) {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => Number.isNaN(n))) return true;
  if (o[0] === 127) return true;                             // loopback
  if (o[0] === 169 && o[1] === 254) return true;             // link-local, DHCP failed
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true; // CGNAT -- Tailscale et al
  if (o[0] === 0 || o[0] >= 224) return true;                // unspecified / multicast
  return false;
}

// Lower is better. A real shop LAN is overwhelmingly 192.168.x; 172.16-31.x is
// usually a virtual switch; 10.x is the range consumer VPNs hand out most, so
// it is ranked last among the private ranges even though plenty of real
// networks use it -- a tie there is what `lan_ip_pinned` is for.
function rangeRank(ip) {
  const o = ip.split('.').map(Number);
  if (o[0] === 192 && o[1] === 168) return 0;
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return 1;
  if (o[0] === 10) return 2;
  return 3;                                                   // a routable public address
}

// "192.168.12.240" + "255.255.255.0" -> "192.168.12.0/24". pg_hba.conf wants
// the network address and a prefix length, not a host address.
function networkCidr(address, netmask) {
  try {
    const a = String(address).split('.').map(Number);
    const m = String(netmask).split('.').map(Number);
    if (a.length !== 4 || m.length !== 4
      || a.concat(m).some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
    const net = a.map((o, i) => o & m[i]).join('.');
    const bits = m.reduce((acc, o) => acc + o.toString(2).replace(/0/g, '').length, 0);
    return net + '/' + bits;
  } catch (_) { return null; }
}

// Every usable candidate, best first, each with why it ranked where it did so
// a wrong pick is diagnosable from the boot log instead of guesswork.
function lanCandidates(ifaces) {
  const all = ifaces || os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(all)) {
    for (const nf of all[name] || []) {
      if (nf.family !== 'IPv4' && nf.family !== 4) continue;
      if (nf.internal || !nf.address) continue;
      if (isUnusable(nf.address)) continue;
      out.push({
        name,
        address: nf.address,
        netmask: nf.netmask,
        cidr: networkCidr(nf.address, nf.netmask),
        virtual: VIRTUAL.test(name),
        rangeRank: rangeRank(nf.address),
      });
    }
  }
  // Real adapters before virtual ones, then by how LAN-like the address is,
  // then by name so the result is stable rather than dependent on OS ordering.
  out.sort((a, b) => (a.virtual ? 1 : 0) - (b.virtual ? 1 : 0)
    || a.rangeRank - b.rangeRank
    || a.name.localeCompare(b.name));
  return out;
}

// The operator's pinned answer, if there is one. Read fresh each time: this is
// edited by hand while the server is running and the next announce should use
// it without a restart.
function pinnedAddress(appDir) {
  try {
    const p = path.join(appDir || __dirname, 'machine-config.json');
    const mc = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
    if (!mc || mc.lan_ip_pinned !== true) return null;
    const ip = String(mc.lan_ip || '').trim();
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && !isUnusable(ip) ? ip : null;
  } catch (_) { return null; }
}

// { address, name, netmask, cidr, pinned, candidates } -- or null if this
// machine has no usable address at all (no network yet, or only loopback).
function lanAddressDetail(appDir) {
  const pin = pinnedAddress(appDir);
  const candidates = lanCandidates();
  if (pin) {
    const match = candidates.find((c) => c.address === pin);
    return {
      address: pin,
      name: match ? match.name : '(pinned, not currently present)',
      netmask: match ? match.netmask : null,
      cidr: match ? match.cidr : null,
      pinned: true,
      candidates,
    };
  }
  if (!candidates.length) return null;
  return Object.assign({ pinned: false, candidates }, candidates[0]);
}

// The bare address, with the same loopback fallback server.js always used so
// nothing downstream has to handle null.
function lanAddress(appDir) {
  const d = lanAddressDetail(appDir);
  return d ? d.address : '127.0.0.1';
}

module.exports = { lanAddress, lanAddressDetail, lanCandidates, networkCidr, VIRTUAL, isUnusable, rangeRank };

// ---------------------------------------------------------------- selftest
if (require.main === module) {
  if (process.argv.includes('--selftest')) {
    let pass = 0, fail = 0;
    const A = (label, ok) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + label); ok ? pass++ : fail++; };

    // The exact adapter set on the shop machine that exposed this.
    const shop = {
      'DuckDuckGo.VPN': [{ family: 'IPv4', internal: false, address: '10.110.8.189', netmask: '255.255.255.255' }],
      'Tailscale': [{ family: 'IPv4', internal: false, address: '100.64.31.38', netmask: '255.255.255.255' }],
      'Wi-Fi': [{ family: 'IPv4', internal: false, address: '192.168.12.240', netmask: '255.255.255.0' }],
      'vEthernet (WSL (Hyper-V firewall))': [{ family: 'IPv4', internal: false, address: '172.26.32.1', netmask: '255.255.240.0' }],
      'Loopback Pseudo-Interface 1': [{ family: 'IPv4', internal: true, address: '127.0.0.1', netmask: '255.0.0.0' }],
    };
    const best = lanCandidates(shop)[0];
    A('shop machine: picks the Wi-Fi LAN address, not the VPN', best.address === '192.168.12.240');
    A('shop machine: names the right adapter', best.name === 'Wi-Fi');
    A('shop machine: derives the subnet', best.cidr === '192.168.12.0/24');
    A('Tailscale CGNAT address is dropped entirely',
      !lanCandidates(shop).some((c) => c.address === '100.64.31.38'));
    A('WSL vEthernet is flagged virtual',
      lanCandidates(shop).find((c) => c.address === '172.26.32.1').virtual === true);
    A('a .VPN suffix is caught mid-name', VIRTUAL.test('DuckDuckGo.VPN'));
    A('an OpenVPN TAP adapter is caught', VIRTUAL.test('TAP-Windows Adapter V9'));
    A('WireGuard is caught', VIRTUAL.test('WireGuard Tunnel'));
    A('a plain NIC is not flagged', !VIRTUAL.test('Wi-Fi') && !VIRTUAL.test('Ethernet'));

    A('link-local is unusable', isUnusable('169.254.10.4'));
    A('loopback is unusable', isUnusable('127.0.0.1'));
    A('CGNAT is unusable', isUnusable('100.80.1.1'));
    A('an ordinary LAN address is usable', !isUnusable('192.168.1.5') && !isUnusable('10.0.0.5'));

    A('192.168 outranks 10.x', rangeRank('192.168.1.5') < rangeRank('10.0.0.5'));
    A('172.16-31 outranks 10.x', rangeRank('172.20.1.5') < rangeRank('10.0.0.5'));
    A('172.32 is not treated as private', rangeRank('172.32.1.5') === 3);

    A('cidr for a /24', networkCidr('192.168.12.240', '255.255.255.0') === '192.168.12.0/24');
    A('cidr for a /16', networkCidr('10.1.2.3', '255.255.0.0') === '10.1.0.0/16');
    A('cidr rejects junk', networkCidr('nope', '255.255.255.0') === null);

    // A real 10.x LAN with no competing adapter must still be chosen.
    const tenOnly = { 'Ethernet': [{ family: 'IPv4', internal: false, address: '10.0.0.50', netmask: '255.255.255.0' }] };
    A('a genuine 10.x LAN is still picked when it is all there is',
      lanCandidates(tenOnly)[0].address === '10.0.0.50');

    // A real NIC always beats a virtual one even on a worse-looking range.
    const mixed = {
      'vEthernet (Default Switch)': [{ family: 'IPv4', internal: false, address: '192.168.99.1', netmask: '255.255.255.0' }],
      'Ethernet': [{ family: 'IPv4', internal: false, address: '10.0.0.50', netmask: '255.255.255.0' }],
    };
    A('a real NIC beats a virtual switch on a nicer range',
      lanCandidates(mixed)[0].address === '10.0.0.50');

    A('no usable address -> null detail',
      lanCandidates({ 'Loopback': [{ family: 'IPv4', internal: true, address: '127.0.0.1', netmask: '255.0.0.0' }] }).length === 0);

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }

  const d = lanAddressDetail();
  if (!d) { console.log('no usable LAN address on this machine'); process.exit(1); }
  console.log(`this machine advertises: ${d.address}  (${d.name}${d.cidr ? ', ' + d.cidr : ''})`
    + (d.pinned ? '   [pinned in machine-config.json]' : ''));
  if (d.candidates.length > 1) {
    console.log('\nother addresses considered:');
    for (const c of d.candidates.slice(d.pinned ? 0 : 1)) {
      console.log(`  ${c.address.padEnd(16)} ${c.name}${c.virtual ? '   (virtual/VPN)' : ''}`);
    }
    console.log('\nIf the chosen address is wrong, pin it in app/machine-config.json:');
    console.log('  { "lan_ip": "<the right one>", "lan_ip_pinned": true }');
  }
}
