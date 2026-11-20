// Tiny DNS server so phones on your Wi-Fi can reach the game at http://cyrus.game
// It answers cyrus.game (and www.cyrus.game) with this PC's LAN address and
// forwards every other lookup to a real DNS server, so normal browsing keeps working.
//
//   node dns.js                 (auto-detects the LAN address)
//   node dns.js 192.168.1.20    (or tell it which address to use)
//
// Then point devices at this PC for DNS — see README.md.

const dgram = require('dgram');
const os = require('os');

const DOMAINS = (process.env.GAME_DOMAIN || 'cyrus.game').toLowerCase().split(',');
const UPSTREAM = process.env.UPSTREAM_DNS || '1.1.1.1';

function lanIp() {
  const candidates = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (/virtual|vmware|vethernet|wsl|docker|loopback|hyper-v|bluetooth/i.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) candidates.push(a.address);
    }
  }
  return (
    candidates.find((ip) => ip.startsWith('192.168.')) ||
    candidates.find((ip) => ip.startsWith('10.')) ||
    candidates.find((ip) => /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) ||
    candidates[0]
  );
}

const ip = process.argv[2] || lanIp();
if (!ip || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
  console.error('Could not work out the LAN address. Run: node dns.js <your-ip>');
  process.exit(1);
}
const ipBytes = Buffer.from(ip.split('.').map(Number));

// Reads the first question of a DNS query. Returns null if malformed.
function parseQuestion(msg) {
  if (msg.length < 17 || msg.readUInt16BE(4) < 1) return null;
  const labels = [];
  let off = 12;
  for (;;) {
    if (off >= msg.length) return null;
    const len = msg[off];
    if (len === 0) { off += 1; break; }
    if (len > 63 || off + 1 + len > msg.length) return null;
    labels.push(msg.toString('ascii', off + 1, off + 1 + len));
    off += 1 + len;
  }
  if (off + 4 > msg.length) return null;
  return { name: labels.join('.').toLowerCase(), type: msg.readUInt16BE(off), end: off + 4 };
}

function answer(msg, q) {
  const isA = q.type === 1;
  const header = Buffer.alloc(12);
  msg.copy(header, 0, 0, 2);            // same id
  header.writeUInt16BE(0x8580, 2);      // response, authoritative, recursion ok, no error
  header.writeUInt16BE(1, 4);           // one question
  header.writeUInt16BE(isA ? 1 : 0, 6); // one answer for A, none for AAAA/HTTPS/etc.
  const parts = [header, msg.subarray(12, q.end)];
  if (isA) {
    const rr = Buffer.alloc(12);
    rr.writeUInt16BE(0xc00c, 0);        // name = pointer to the question
    rr.writeUInt16BE(1, 2);             // type A
    rr.writeUInt16BE(1, 4);             // class IN
    rr.writeUInt32BE(30, 6);            // TTL 30s
    rr.writeUInt16BE(4, 10);
    parts.push(rr, ipBytes);
  }
  return Buffer.concat(parts);
}

const server = dgram.createSocket('udp4');

server.on('message', (msg, rinfo) => {
  const q = parseQuestion(msg);
  if (q && DOMAINS.some((d) => q.name === d || q.name === 'www.' + d)) {
    server.send(answer(msg, q), rinfo.port, rinfo.address);
    return;
  }
  // Everything else: relay to the real DNS server and pass the reply back.
  const up = dgram.createSocket('udp4');
  const timer = setTimeout(() => up.close(), 4000);
  up.on('message', (reply) => {
    clearTimeout(timer);
    server.send(reply, rinfo.port, rinfo.address);
    up.close();
  });
  up.on('error', () => { clearTimeout(timer); try { up.close(); } catch {} });
  up.send(msg, 53, UPSTREAM);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
    console.error(`Port 53 on ${ip} is unavailable (${err.code}). Try an Administrator terminal, or close whatever is using it.`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.bind(53, ip, () => {
  console.log(`DNS running on ${ip}:53`);
  console.log(`  ${DOMAINS.join(', ')}  ->  ${ip}`);
  console.log(`  everything else  ->  ${UPSTREAM}`);
  console.log(`Set the DNS server on your router (or on each phone's Wi-Fi settings) to ${ip}`);
});
