import { createSocket, type Socket } from 'node:dgram';

/** A minimal STUN binding responder (RFC 5389) for tests: answers with the sender's address. */
export async function startStunServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const socket: Socket = createSocket('udp4');
  socket.on('message', (msg, remote) => {
    if (msg.length < 20 || msg.readUInt16BE(0) !== 0x0001 || msg.readUInt32BE(4) !== 0x2112a442) return;
    const attribute = Buffer.alloc(12);
    attribute.writeUInt16BE(0x0020, 0); // XOR-MAPPED-ADDRESS
    attribute.writeUInt16BE(8, 2);
    attribute.writeUInt8(0, 4);
    attribute.writeUInt8(0x01, 5); // IPv4
    attribute.writeUInt16BE(remote.port ^ 0x2112, 6);
    const ip = remote.address.split('.').map(Number);
    attribute.writeUInt32BE((((ip[0]! << 24) | (ip[1]! << 16) | (ip[2]! << 8) | ip[3]!) ^ 0x2112a442) >>> 0, 8);
    const header = Buffer.alloc(20);
    header.writeUInt16BE(0x0101, 0); // binding success
    header.writeUInt16BE(attribute.length, 2);
    msg.copy(header, 4, 4, 20); // magic cookie + transaction id
    socket.send(Buffer.concat([header, attribute]), remote.port, remote.address);
  });
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  return {
    url: `stun:127.0.0.1:${socket.address().port}`,
    close: () => new Promise((resolve) => socket.close(() => resolve())),
  };
}
