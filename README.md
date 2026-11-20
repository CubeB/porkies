# 🐷 Porkies

A bluffing trivia party game for your local network. Everyone sees a strange fact with a
blank, writes a convincing lie on their phone, then tries to pick the real answer.

## Run it

```
npm install      (first time only)
npm start
```

- Open **http://localhost/host** on the TV / laptop everyone can see.
- Players open **cyrus.game** on their phones (same Wi-Fi), type a name and join.
  The QR code on the TV works too and needs no setup.
- The first player to join (or the Start button on the TV) starts the game.

If port 80 is taken the server uses 3000 instead and prints the address to use.
Allow Node through Windows Firewall on **private networks** when prompted.

## Making `cyrus.game` work on phones

Phones need to be told that `cyrus.game` means this PC. Run the bundled DNS helper in a
second terminal:

```
node dns.js
```

It prints this PC's address (e.g. `192.168.0.176`). Then do **one** of:

1. **Router (best, do once):** in the router's DHCP/LAN settings set the DNS server to
   that address. Every device that joins the Wi-Fi then resolves `cyrus.game` automatically.
   Keep `dns.js` running while this is set, or restore the router setting afterwards —
   otherwise nothing on the network can look up websites.
2. **Per phone:** Wi-Fi settings → your network → DNS → Manual → that address.

Notes: Android "Private DNS" and iPhone "iCloud Private Relay" / "Limit IP Address
Tracking" bypass local DNS — turn them off for this network, or just scan the QR code.

## Files

- `server.js` — game server (express + socket.io)
- `questions.json` — the question bank; add your own in the same format
- `public/` — phone controller (`index.html`) and TV screen (`host.html`)
- `dns.js` — optional DNS helper for the `cyrus.game` name
