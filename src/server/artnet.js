'use strict';

const dgram = require('dgram');

const udpSocket = dgram.createSocket('udp4');
udpSocket.bind(() => {
  try { udpSocket.setBroadcast(true); } catch (_) { /* not all networks allow it */ }
});

function buildArtDmxPacket(universe, dmxData) {
  const packet = Buffer.alloc(18 + 512);
  packet.write('Art-Net\0', 0, 'ascii');
  packet.writeUInt16LE(0x5000, 8);
  packet.writeUInt16BE(14, 10);
  packet[12] = 0;
  packet[13] = 0;
  packet.writeUInt16LE(universe & 0x7fff, 14);
  packet.writeUInt16BE(512, 16);
  dmxData.copy(packet, 18, 0, 512);
  return packet;
}

function sendArtDmx({ host, port, universe }, dmxData) {
  const packet = buildArtDmxPacket(universe, dmxData);
  udpSocket.send(packet, 0, packet.length, port, host);
}

module.exports = { buildArtDmxPacket, sendArtDmx };
