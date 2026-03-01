import api from './api';
import { CoreFunctions } from './api_productions_core_functions';
import { initJwt } from './auth/jwt';
import { CallManager, SmbInstance } from './call_manager';
import { ConnectionManager } from './connection_manager';
import { ConnectionQueue } from './connection_queue';
import { DbManagerCouchDb } from './db/couchdb';
import { DbManagerMongoDb } from './db/mongodb';
import { IngestManager } from './ingest_manager';
import { Log } from './log';
import { ProductionManager } from './production_manager';
import { SmbProtocol } from './smb';
import { TalkManager } from './talk_manager';

const SMB_ADDRESS: string = process.env.SMB_ADDRESS ?? 'http://localhost:8080';
const PUBLIC_HOST: string = process.env.PUBLIC_HOST ?? 'http://localhost:8000';

if (!process.env.SMB_ADDRESS) {
  Log().warn('SMB_ADDRESS environment variable not set, using defaults');
}

const ENDPOINT_IDLE_TIMEOUT_S: string =
  process.env.ENDPOINT_IDLE_TIMEOUT_S ?? '60';

const PORT = process.env.PORT ? Number(process.env.PORT) : 8000;

const DB_CONNECTION_STRING: string =
  process.env.DB_CONNECTION_STRING ??
  process.env.MONGODB_CONNECTION_STRING ??
  'mongodb://localhost:27017/intercom-manager';
let dbManager;
const dbUrl = new URL(DB_CONNECTION_STRING);
if (dbUrl.protocol === 'mongodb:' || dbUrl.protocol === 'mongodb+srv:') {
  dbManager = new DbManagerMongoDb(dbUrl);
} else if (dbUrl.protocol === 'http:' || dbUrl.protocol === 'https:') {
  dbManager = new DbManagerCouchDb(dbUrl);
} else {
  throw new Error('Unsupported database protocol');
}

(async function startServer() {
  await dbManager.connect();
  await dbManager.markAllClientsOffline();
  Log().info('Startup cleanup: marked all clients offline');
  const productionManager = new ProductionManager(dbManager);
  await productionManager.load();

  const connectionQueue = new ConnectionQueue();
  const ingestManager = new IngestManager(dbManager);
  await ingestManager.load();

  const JWT_SECRET = process.env.JWT_SECRET;
  if (!JWT_SECRET) {
    Log().warn(
      'JWT_SECRET not set, using default development secret. DO NOT use in production.'
    );
  }
  initJwt(JWT_SECRET ?? 'intercom2-dev-secret-change-in-production');

  const connectionManager = new ConnectionManager();

  const smb = new SmbProtocol();

  // Multi-SMB configuration: SMB_ADDRESSES takes priority over SMB_ADDRESS
  const SMB_MAX_CONFERENCES = parseInt(
    process.env.SMB_MAX_CONFERENCES ?? '80',
    10
  );
  let smbInstances: SmbInstance[];

  const smbAddresses = process.env.SMB_ADDRESSES;
  const smbApiKeys = process.env.SMB_APIKEYS;

  if (smbAddresses) {
    const urls = smbAddresses.split(',').map((s) => s.trim());
    const keys = smbApiKeys
      ? smbApiKeys.split(',').map((s) => s.trim())
      : urls.map(() => '');
    smbInstances = urls.map((url, i) => ({
      url,
      apiKey: keys[i] || '',
      maxConferences: SMB_MAX_CONFERENCES
    }));
    Log().info(`Multi-SMB: ${smbInstances.length} instances configured`);
  } else {
    // Single-SMB backward compatibility
    smbInstances = [
      {
        url: SMB_ADDRESS,
        apiKey: process.env.SMB_APIKEY ?? '',
        maxConferences: SMB_MAX_CONFERENCES
      }
    ];
  }

  const callManager = new CallManager({
    dbManager,
    connectionManager,
    smb,
    smbInstances,
    endpointIdleTimeout: parseInt(ENDPOINT_IDLE_TIMEOUT_S, 10)
  });

  const talkManager = new TalkManager();

  const server = await api({
    title: 'intercom-manager',
    smbServerBaseUrl: SMB_ADDRESS,
    endpointIdleTimeout: ENDPOINT_IDLE_TIMEOUT_S,
    smbServerApiKey: process.env.SMB_APIKEY,
    publicHost: PUBLIC_HOST,
    whipAuthKey: process.env.WHIP_AUTH_KEY,
    dbManager: dbManager,
    productionManager: productionManager,
    ingestManager: ingestManager,
    connectionManager: connectionManager,
    callManager: callManager,
    talkManager: talkManager,
    coreFunctions: new CoreFunctions(productionManager, connectionQueue)
  });

  server.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
    if (err) {
      throw err;
    }
    Log().info(`Manager listening on ${address}`);
    Log().info(
      `Media Bridge at ${SMB_ADDRESS} (${ENDPOINT_IDLE_TIMEOUT_S}s idle timeout)`
    );

    // Stale heartbeat cleanup: mark clients offline if no WebSocket
    // connection and lastSeenAt is more than 30 seconds ago.
    // Runs every 60 seconds to catch heartbeat-only clients that
    // stopped polling (e.g. browser closed).
    setInterval(async () => {
      try {
        const onlineClients = await dbManager.getOnlineClients();
        const now = Date.now();
        for (const client of onlineClients) {
          const lastSeen = new Date(client.lastSeenAt).getTime();
          const hasWs =
            connectionManager.getSocket(client._id) !== undefined;
          if (!hasWs && now - lastSeen > 30_000) {
            await dbManager.updateClient(client._id, { isOnline: false });
            connectionManager.broadcast(
              { type: 'client_disconnected', clientId: client._id },
              client._id
            );
            Log().info(
              `Stale cleanup: marked ${client._id} (${client.name}) offline (no WS, lastSeen ${Math.round((now - lastSeen) / 1000)}s ago)`
            );
          }
        }
      } catch (e) {
        Log().warn(`Stale cleanup error: ${e}`);
      }
    }, 60_000);
  });

  const shutdown = async (signal: string) => {
    Log().info(`${signal} received, shutting down gracefully`);
    const connectedIds = connectionManager.getConnectedClientIds();
    Log().info(
      `Marking ${connectedIds.length} connected client(s) offline...`
    );
    for (const clientId of connectedIds) {
      try {
        await dbManager.updateClient(clientId, { isOnline: false });
      } catch (e) {
        Log().warn(`Failed to mark ${clientId} offline: ${e}`);
      }
    }
    await server.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    Log().error('Unhandled promise rejection:', reason);
  });

  process.on('uncaughtException', (err) => {
    Log().error('Uncaught exception:', err);
    process.exit(1);
  });
})();
