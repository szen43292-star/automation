/**
 * A local STUN responder for browser tests and offline demos (call audio finds its address
 * without the internet):  npx tsx test/stun-server.ts   →  MEDIA_ICE_SERVERS=stun:127.0.0.1:3478
 */
import { startStunServer } from './stun';

const stun = await startStunServer(Number(process.env.STUN_PORT ?? 3478));
console.log(`STUN responder on ${stun.url}`);
