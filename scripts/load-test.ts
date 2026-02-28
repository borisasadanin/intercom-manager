/**
 * Multi-SMB Load Test Script
 *
 * Registers N clients, creates M calls between random pairs,
 * verifies SMB distribution via the /health endpoint, then cleans up.
 *
 * Usage:
 *   npx ts-node scripts/load-test.ts [baseUrl] [numClients] [numCalls]
 *
 * Examples:
 *   npx ts-node scripts/load-test.ts http://localhost:8000 10 5
 *   npx ts-node scripts/load-test.ts https://my-intercom.example.com 20 15
 */

const BASE_URL = process.argv[2] || 'http://localhost:8000';
const NUM_CLIENTS = parseInt(process.argv[3] || '10', 10);
const NUM_CALLS = parseInt(process.argv[4] || '5', 10);

interface RegisteredClient {
  clientId: string;
  token: string;
  name: string;
}

interface HealthResponse {
  status: string;
  uptime: number;
  clients: number;
  activeCalls: number;
  activeTalkers: number;
  smb?: Array<{
    url: string;
    conferences: number;
    maxConferences: number;
    status: string;
  }>;
}

async function registerClients(count: number): Promise<RegisteredClient[]> {
  const clients: RegisteredClient[] = [];
  for (let i = 0; i < count; i++) {
    const res = await fetch(`${BASE_URL}/api/v1/client/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `LoadTest-Client-${i}`,
        role: 'tester',
        location: 'load-test'
      })
    });

    if (!res.ok) {
      console.error(
        `Failed to register client ${i}: ${res.status} ${await res.text()}`
      );
      continue;
    }

    const data = (await res.json()) as {
      clientId: string;
      token: string;
      name: string;
    };
    clients.push({
      clientId: data.clientId,
      token: data.token,
      name: data.name
    });
  }
  return clients;
}

async function createCalls(
  clients: RegisteredClient[],
  count: number
): Promise<string[]> {
  const callIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const callerIdx = i % clients.length;
    const calleeIdx = (i + 1) % clients.length;

    const res = await fetch(`${BASE_URL}/api/v1/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${clients[callerIdx].token}`
      },
      body: JSON.stringify({ calleeId: clients[calleeIdx].clientId })
    });

    if (res.ok) {
      const data = (await res.json()) as { callId: string };
      callIds.push(data.callId);
      console.log(
        `  Call ${i + 1}: ${clients[callerIdx].name} -> ${clients[calleeIdx].name} (${data.callId})`
      );
    } else {
      const err = await res.text();
      console.error(`  Call ${i + 1} failed: ${res.status} ${err}`);
    }
  }
  return callIds;
}

async function getHealth(): Promise<HealthResponse | null> {
  try {
    const res = await fetch(`${BASE_URL}/api/v1/health`);
    if (!res.ok) {
      console.error(`Health check failed: ${res.status}`);
      return null;
    }
    return (await res.json()) as HealthResponse;
  } catch (err) {
    console.error('Health check error:', err);
    return null;
  }
}

async function cleanupCalls(
  callIds: string[],
  token: string
): Promise<number> {
  let cleaned = 0;
  for (const callId of callIds) {
    try {
      const res = await fetch(`${BASE_URL}/api/v1/call/${callId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) cleaned++;
    } catch {
      // best-effort cleanup
    }
  }
  return cleaned;
}

async function main() {
  console.log(
    `\n=== Multi-SMB Load Test ===\n` +
      `Target: ${BASE_URL}\n` +
      `Clients: ${NUM_CLIENTS}\n` +
      `Calls: ${NUM_CALLS}\n`
  );

  // 1. Register clients
  console.log('--- Registering clients ---');
  const clients = await registerClients(NUM_CLIENTS);
  console.log(`Registered ${clients.length}/${NUM_CLIENTS} clients\n`);

  if (clients.length < 2) {
    console.error('Need at least 2 registered clients to create calls. Aborting.');
    process.exit(1);
  }

  // 2. Create calls
  console.log('--- Creating calls ---');
  const callIds = await createCalls(clients, NUM_CALLS);
  console.log(`\nCreated ${callIds.length}/${NUM_CALLS} calls\n`);

  // 3. Check health with SMB distribution
  console.log('--- Health (after calls) ---');
  const health = await getHealth();
  if (health) {
    console.log(`  Status: ${health.status}`);
    console.log(`  Clients: ${health.clients}`);
    console.log(`  Active calls: ${health.activeCalls}`);
    console.log(`  Active talkers: ${health.activeTalkers}`);

    if (health.smb && health.smb.length > 0) {
      console.log(`\n  SMB instances (${health.smb.length}):`);
      for (const instance of health.smb) {
        console.log(
          `    ${instance.url}: ${instance.conferences}/${instance.maxConferences} conferences [${instance.status}]`
        );
      }

      // Check distribution
      const totalConferences = health.smb.reduce(
        (sum, i) => sum + Math.max(0, i.conferences),
        0
      );
      const okInstances = health.smb.filter((i) => i.status === 'ok').length;
      console.log(
        `\n  Total conferences: ${totalConferences} across ${okInstances} healthy instances`
      );

      if (health.smb.length > 1) {
        const counts = health.smb
          .filter((i) => i.status === 'ok')
          .map((i) => i.conferences);
        const max = Math.max(...counts);
        const min = Math.min(...counts);
        console.log(
          `  Distribution: min=${min}, max=${max}, spread=${max - min}`
        );
        if (max - min <= 2) {
          console.log('  Distribution: BALANCED');
        } else {
          console.log('  Distribution: UNEVEN (may be expected for small N)');
        }
      }
    } else {
      console.log('  (No SMB status available)');
    }
  }

  // 4. Cleanup
  console.log('\n--- Cleanup ---');
  const cleaned = await cleanupCalls(callIds, clients[0].token);
  console.log(`Ended ${cleaned}/${callIds.length} calls`);

  // 5. Final health
  console.log('\n--- Health (after cleanup) ---');
  const finalHealth = await getHealth();
  if (finalHealth) {
    console.log(`  Active calls: ${finalHealth.activeCalls}`);
    if (finalHealth.smb) {
      for (const instance of finalHealth.smb) {
        console.log(
          `    ${instance.url}: ${instance.conferences}/${instance.maxConferences} conferences [${instance.status}]`
        );
      }
    }
  }

  console.log('\n=== Load test complete ===\n');
}

main().catch((err) => {
  console.error('Load test failed:', err);
  process.exit(1);
});
