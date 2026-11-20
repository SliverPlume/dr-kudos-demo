import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { WebSocketServer } from 'ws';
import { useServer } from 'graphql-ws/use/ws';
import { createSchema, createYoga } from 'graphql-yoga';
import { resolvers } from './resolvers.ts';
import { seedDemoData } from './seed.ts';
import { recoverPendingReplies } from './ai.ts';
import { llmDescription } from './llm.ts';

const PORT = Number(process.env.PORT ?? 4000);

const schema = createSchema({
  typeDefs: readFileSync(new URL('./schema.graphql', import.meta.url), 'utf8'),
  resolvers,
});

const yoga = createYoga({
  schema,
  graphiql: { subscriptionsProtocol: 'WS' },
  cors: { origin: '*' },
  logging: 'warn',
});

const httpServer = createServer(yoga);
const webSocketServer = new WebSocketServer({ server: httpServer, path: yoga.graphqlEndpoint });

useServer(
  {
    schema,
    onConnect: () => console.log(`[ws] client connected (${webSocketServer.clients.size} open)`),
    onDisconnect: () => console.log(`[ws] client disconnected (${webSocketServer.clients.size} open)`),
  },
  webSocketServer,
);

seedDemoData();
recoverPendingReplies();

httpServer.listen(PORT, '0.0.0.0', () => {
  const lanAddress = Object.values(networkInterfaces())
    .flat()
    .find((networkInterface) => networkInterface && networkInterface.family === 'IPv4' && !networkInterface.internal)?.address;
  console.log(`GraphQL  http://localhost:${PORT}/graphql`);
  if (lanAddress) console.log(`LAN      http://${lanAddress}:${PORT}/graphql`);
  console.log(`AI       ${llmDescription}`);
});
