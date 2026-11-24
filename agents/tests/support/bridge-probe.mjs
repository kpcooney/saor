/**
 * agents/tests/support/bridge-probe.mjs
 *
 * The Node half of the cross-process storage-bridge test (issue #59). It is
 * spawned by src-tauri/tests/storage_bridge.rs, which plays the Rust host over
 * this process's stdin/stdout exactly as the Tauri spawner does in production.
 *
 * The probe drives the real, compiled bridge client and port adapters
 * (agents/dist/bridge/) through every bridge method, then reports what it
 * observed on a final `completed` status line. The Rust test asserts on that
 * report and reads the side effects back out of the real stores, so a
 * wire-format mismatch between the two sides fails here rather than in a live
 * agent run.
 *
 * Plain JavaScript importing from dist/ on purpose: this is the artifact the
 * sidecar actually runs. Build the agents package (`npm run build`) first.
 *
 * Usage: node bridge-probe.mjs <projectId> <sessionId>
 */

import {
  createBridgeAuditLogger,
  createBridgeMemoryStore,
  createBridgeReferenceResolver,
} from '../../dist/bridge/adapters.js';
import { createBridgeClient } from '../../dist/bridge/client.js';

const [projectId, sessionId] = process.argv.slice(2);
const agentId = `agent:code-agent:${sessionId}`;

const client = createBridgeClient({ input: process.stdin, output: process.stdout });
const memory = createBridgeMemoryStore(client);
const audit = createBridgeAuditLogger(client, { sessionId });
const resolver = createBridgeReferenceResolver(client);

function entry(id, category, content, forProject = projectId) {
  return {
    id,
    projectId: forProject,
    category,
    content,
    metadata: { source: 'bridge-probe' },
    createdBy: agentId,
    createdAt: new Date().toISOString(),
    weight: 1.0,
  };
}

/** Run an operation expected to be refused and return the refusal's code. */
async function refusalCode(operation) {
  try {
    await operation();
    return 'not refused';
  } catch (error) {
    return error.code ?? `unexpected error: ${error}`;
  }
}

async function probe() {
  // Stray stdout output must not disturb the protocol.
  console.log('a stray line a dependency might print');

  await memory.write(entry('probe-learning', 'learning', 'stdio bridges need line framing'));
  await memory.write(entry('probe-convention', 'convention', 'bridge methods are storage primitives'));

  const search = await memory.keywordSearch('framing', { category: 'learning', limit: 5 });
  const filteredOut = await memory.keywordSearch('framing', { category: 'convention' });
  const context = await memory.getProjectContext(projectId);

  await audit.log({
    id: 'probe-event',
    timestamp: new Date().toISOString(),
    projectId,
    agentId,
    agentRole: 'code-agent',
    delegationChain: ['human:local', agentId],
    eventType: 'tool.invoked',
    action: 'Write',
    details: { tool: 'Write', toolUseId: 'tu-probe' },
    issueRef: '59',
    sessionId: 'sdk-session-from-probe',
    result: 'pending',
  });

  const file = await resolver.resolve('file://docs/note.md');
  const standard = await resolver.resolve('standards://coding-standards/rust');
  const memoryRef = await resolver.resolve('memory://query/primitives');

  // Several requests in flight at once are answered independently.
  const concurrent = await Promise.all([
    memory.keywordSearch('framing'),
    memory.keywordSearch('primitives'),
    resolver.resolve('file://docs/note.md'),
  ]);

  return {
    search,
    filteredOutCount: filteredOut.length,
    context,
    file,
    standard,
    memoryRef,
    concurrentIds: [concurrent[0][0]?.id, concurrent[1][0]?.id, concurrent[2].kind],
    refusals: {
      otherProjectWrite: await refusalCode(() =>
        memory.write(entry('probe-smuggled', 'learning', 'smuggled', 'some-other-project')),
      ),
      traversal: await refusalCode(() => resolver.resolve('file://../outside.txt')),
      unknownScheme: await refusalCode(() => resolver.resolve('ftp://example/file')),
    },
  };
}

let exitCode = 0;
try {
  client.sendStatus('completed', { report: await probe() });
} catch (error) {
  client.sendStatus('failed', { error: String(error?.stack ?? error) });
  exitCode = 1;
} finally {
  client.close();
}
process.stdout.write('', () => process.exit(exitCode));
