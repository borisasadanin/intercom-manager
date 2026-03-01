import { Log } from '../log';
import {
  CallDocument,
  ClientDocument,
  Ingest,
  Line,
  NewIngest,
  Production,
  UserSession
} from '../models';
import { assert } from '../utils';
import { DbManager } from './interface';
import nano from 'nano';

const SESSION_PRUNE_SECONDS = 7_200;
export class DbManagerCouchDb implements DbManager {
  private client;
  private nanoDb: nano.DocumentScope<unknown> | undefined;
  private dbConnectionUrl: URL;
  private pruneIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor(dbConnectionUrl: URL) {
    this.dbConnectionUrl = dbConnectionUrl;
    const server = new URL('/', this.dbConnectionUrl).toString();
    this.client = nano({
      url: server,
      requestDefaults: {
        timeout: 10000
      }
    });
  }

  async connect(): Promise<void> {
    if (!this.nanoDb) {
      const maxRetries = 5;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const dbList = await this.client.db.list();
          Log().debug('List of databases', dbList);
          const dbName = this.dbConnectionUrl.pathname.replace(/^\//, '');
          if (!dbList.includes(dbName)) {
            Log().info('Creating database', dbName);
            await this.client.db.create(dbName);
          }
          Log().info('Using database', dbName);
          this.nanoDb = this.client.db.use(
            this.dbConnectionUrl.pathname.replace(/^\//, '')
          );
          await this.ensureSessionIndexes();
          this.sessionPruneInterval();
          return;
        } catch (error: any) {
          if (this.isTransientError(error) && attempt < maxRetries - 1) {
            const delay = 1000 * Math.pow(2, attempt);
            Log().warn(
              `CouchDB connect failed (attempt ${attempt + 1}/${maxRetries}): ${
                error.message
              }. Retrying in ${delay}ms...`
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
          } else {
            throw error;
          }
        }
      }
    }
  }

  // This interval is used to track and remove sessions based on 'isExpired' flag, set in production_manager.
  // Deviates from mongoDB, which handles session pruning based on internal TTL index. This isn't supported by CouchDB.
  private sessionPruneInterval() {
    this.pruneIntervalId = setInterval(async () => {
      try {
        const cutoff = new Date(
          Date.now() - SESSION_PRUNE_SECONDS * 1000
        ).toISOString();
        const sessions = await this.getSessionsByQuery({
          lastSeenAt: { $lt: cutoff } as any
        });
        for (const session of sessions) {
          const sessionId = session._id;
          await this.deleteUserSession(sessionId);
          Log().info(`Terminated session ${sessionId}`);
        }
      } catch (error: any) {
        Log().error(error);
      }
    }, 300_000); // runs every 5th minute
  }

  async disconnect(): Promise<void> {
    if (this.pruneIntervalId) {
      clearInterval(this.pruneIntervalId);
      this.pruneIntervalId = null;
    }
  }

  // Generic retry wrapper for all DB operations.
  // Retries on transient network errors only (not 409 conflicts).
  private async withRetry<T>(
    operation: () => Promise<T>,
    maxRetries = 3
  ): Promise<T> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error: any) {
        if (this.isTransientError(error) && attempt < maxRetries - 1) {
          Log().warn(
            `Transient DB error (attempt ${attempt + 1}/${maxRetries}): ${
              error.message
            }`
          );
          await new Promise((resolve) =>
            setTimeout(resolve, 100 * Math.pow(2, attempt))
          );
        } else {
          throw error;
        }
      }
    }
    throw new Error('withRetry: exhausted retries');
  }

  private async getNextSequence(collectionName: string): Promise<number> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }

    const counterDocId = `counter_${collectionName}`;
    interface CounterDoc {
      _id: string;
      _rev?: string;
      value: string;
    }
    let counterDoc: CounterDoc;

    try {
      counterDoc = (await this.withRetry(() =>
        this.nanoDb!.get(counterDocId)
      )) as CounterDoc;
      counterDoc.value = (parseInt(counterDoc.value) + 1).toString();
    } catch (error: any) {
      if (error.statusCode === 404) {
        counterDoc = { _id: counterDocId, value: '1' };
      } else {
        throw error;
      }
    }
    await this.withRetry(() => this.nanoDb!.insert(counterDoc));
    return parseInt(counterDoc.value, 10);
  }

  /** Get all productions from the database in reverse natural order, limited by the limit parameter */
  async getProductions(limit: number, offset: number): Promise<Production[]> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }
    const productions: Production[] = [];
    const response = await this.withRetry(() =>
      this.nanoDb!.list({ include_docs: true })
    );
    // eslint-disable-next-line
    response.rows.forEach((row: any) => {
      if (
        row.doc._id.toLowerCase().indexOf('counter') === -1 &&
        row.doc._id.toLowerCase().indexOf('session_') === -1
      )
        productions.push(row.doc);
    });

    // Apply offset and limit
    const result = productions.slice(offset, offset + limit);
    return result as any as Production[];
  }

  async getProductionsLength(): Promise<number> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }
    const productions = await this.withRetry(() =>
      this.nanoDb!.list({ include_docs: false })
    );
    // Filter out counter and session documents
    const filteredRows = productions.rows.filter(
      (row: any) =>
        row.id.toLowerCase().indexOf('counter') === -1 &&
        row.id.toLowerCase().indexOf('session_') === -1
    );
    return filteredRows.length;
  }

  async getProduction(id: number): Promise<Production | undefined> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }

    const production = await this.withRetry(() =>
      this.nanoDb!.get(id.toString())
    );
    // eslint-disable-next-line
    return production as any | undefined;
  }

  async updateProduction(
    production: Production
  ): Promise<Production | undefined> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }

    const existingProduction = await this.withRetry(() =>
      this.nanoDb!.get(production._id.toString())
    );
    const updatedProduction = {
      ...existingProduction,
      ...production,
      _id: production._id.toString()
    };
    const response = await this.withRetry(() =>
      this.nanoDb!.insert(updatedProduction)
    );
    return response.ok ? production : undefined;
  }

  async addProduction(name: string, lines: Line[]): Promise<Production> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }

    const _id = await this.getNextSequence('productions');
    if (_id === -1) {
      throw new Error('Failed to get next sequence');
    }
    const insertProduction = { name, lines, _id: _id.toString() };
    const response = await this.withRetry(() =>
      this.nanoDb!.insert(insertProduction as unknown as nano.MaybeDocument)
    );
    if (!response.ok) throw new Error('Failed to insert production');
    return { name, lines, _id } as Production;
  }

  async deleteProduction(productionId: number): Promise<boolean> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }

    const production = await this.withRetry(() =>
      this.nanoDb!.get(productionId.toString())
    );
    const response = await this.withRetry(() =>
      this.nanoDb!.destroy(production._id, production._rev)
    );
    return response.ok;
  }

  async setLineConferenceId(
    productionId: number,
    lineId: string,
    conferenceId: string
  ): Promise<void> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }

    const production = await this.getProduction(productionId);
    assert(production, `Production with id "${productionId}" does not exist`);
    const line = production.lines.find((line) => line.id === lineId);
    assert(
      line,
      `Line with id "${lineId}" does not exist for production with id "${productionId}"`
    );
    line.smbConferenceId = conferenceId;
    const existingProduction = await this.withRetry(() =>
      this.nanoDb!.get(productionId.toString())
    );
    const updatedProduction = {
      ...existingProduction,
      lines: production.lines
    };
    const response = await this.withRetry(() =>
      this.nanoDb!.insert(updatedProduction)
    );
    assert(
      response.ok,
      `Failed to update production with id "${productionId}"`
    );
  }

  async addIngest(newIngest: NewIngest): Promise<Ingest> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }

    const _id = await this.getNextSequence('ingests');
    if (_id === -1) {
      throw new Error('Failed to get next sequence');
    }
    const insertIngest = {
      ...newIngest,
      _id: _id.toString()
    };
    const response = await this.withRetry(() =>
      this.nanoDb!.insert(insertIngest as unknown as nano.MaybeDocument)
    );
    if (!response.ok) throw new Error('Failed to insert ingest');
    return { ...newIngest, _id } as any;
  }

  /** Get all ingests from the database in reverse natural order, limited by the limit parameter */
  async getIngests(limit: number, offset: number): Promise<Ingest[]> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }

    const ingests: Ingest[] = [];
    const response = await this.withRetry(() =>
      this.nanoDb!.list({ include_docs: true })
    );
    // eslint-disable-next-line
    response.rows.forEach((row: any) => {
      if (
        row.doc._id.toLowerCase().indexOf('counter') === -1 &&
        row.doc._id.toLowerCase().indexOf('session_') === -1
      )
        ingests.push(row.doc);
    });

    // Apply offset and limit
    const result = ingests.slice(offset, offset + limit);
    return result as any as Ingest[];
  }

  async getIngestsLength(): Promise<number> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }

    const ingests = await this.withRetry(() =>
      this.nanoDb!.list({ include_docs: false })
    );
    // Filter out counter and session documents
    const filteredRows = ingests.rows.filter(
      (row: any) =>
        row.id.toLowerCase().indexOf('counter') === -1 &&
        row.id.toLowerCase().indexOf('session_') === -1
    );
    return filteredRows.length;
  }

  async getIngest(id: number): Promise<Ingest | undefined> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }

    const ingest = await this.withRetry(() => this.nanoDb!.get(id.toString()));
    // eslint-disable-next-line
    return ingest as any | undefined;
  }

  async updateIngest(ingest: Ingest): Promise<Ingest | undefined> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }

    const existingIngest = await this.withRetry(() =>
      this.nanoDb!.get(ingest._id.toString())
    );
    const updatedIngest = {
      ...existingIngest,
      ...ingest,
      _id: ingest._id.toString()
    };
    const response = await this.withRetry(() =>
      this.nanoDb!.insert(updatedIngest)
    );
    return response.ok ? ingest : undefined;
  }

  async deleteIngest(ingestId: number): Promise<boolean> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }

    const ingest = await this.withRetry(() =>
      this.nanoDb!.get(ingestId.toString())
    );
    const response = await this.withRetry(() =>
      this.nanoDb!.destroy(ingest._id, ingest._rev)
    );
    return response.ok;
  }

  // Session management methods

  private isTransientError(error: any): boolean {
    const codes = [
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ENOTFOUND',
      'EPIPE'
    ];
    if (error.code && codes.includes(error.code)) return true;
    if (
      typeof error.message === 'string' &&
      error.message.includes('socket hang up')
    ) {
      return true;
    }
    return false;
  }

  // Helper method, to avoid conflicting _revs on simultaneous update requests.
  // Also retries on transient socket errors (ECONNRESET, socket hang up, etc).
  private async insertWithRetry(doc: any, maxRetries = 3): Promise<any> {
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await this.nanoDb.insert(doc);
      } catch (error: any) {
        const isConflict = error.statusCode === 409;
        const isTransient = this.isTransientError(error);
        if ((isConflict || isTransient) && attempt < maxRetries - 1) {
          if (isConflict) {
            const latestDoc = await this.nanoDb.get(doc._id);
            doc = { ...latestDoc, ...doc, _rev: latestDoc._rev };
          }
          await new Promise((resolve) =>
            setTimeout(resolve, 100 * Math.pow(2, attempt))
          );
        } else {
          throw error;
        }
      }
    }
  }

  async saveUserSession(
    sessionId: string,
    userSession: UserSession
  ): Promise<void> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }

    if (!sessionId.startsWith('session')) {
      sessionId = `session_${sessionId}`;
    }

    let existingDoc: any;

    // Check if document exists, if not creates new session
    try {
      existingDoc = await this.withRetry(() => this.nanoDb!.get(sessionId));
    } catch (error: any) {
      if (error.statusCode === 404) {
        existingDoc = { _id: sessionId };
      } else {
        throw error;
      }
    }
    const now = new Date();
    const updatedSession = {
      ...existingDoc,
      ...userSession,
      lastSeenAt: now.toISOString(),
      _id: sessionId
    };
    // Set createdAt only on first insert (like MongoDB's $setOnInsert)
    if (!existingDoc.createdAt) {
      updatedSession.createdAt = now.toISOString();
    }
    await this.insertWithRetry(updatedSession);
  }

  async deleteUserSession(sessionId: string): Promise<boolean> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }
    if (!sessionId.startsWith('session')) {
      sessionId = `session_${sessionId}`;
    }
    const session = await this.withRetry(() => this.nanoDb!.get(sessionId));
    const response = await this.withRetry(() =>
      this.nanoDb!.destroy(session._id, session._rev)
    );
    return response.ok;
  }

  async getSession(sessionId: string): Promise<UserSession | null> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }

    if (!sessionId.startsWith('session')) {
      sessionId = `session_${sessionId}`;
    }
    const session = await this.withRetry(() => this.nanoDb!.get(sessionId));
    return session as any as UserSession;
  }

  async updateSession(
    sessionId: string,
    updates: Partial<UserSession>
  ): Promise<boolean> {
    await this.connect();

    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }
    if (!sessionId.startsWith('session')) {
      sessionId = `session_${sessionId}`;
    }

    let doc: any;
    try {
      doc = await this.withRetry(() => this.nanoDb!.get(sessionId));
    } catch (error: any) {
      if (error.statusCode === 404) {
        return false;
      }
      throw error;
    }

    const updateData: any = { ...updates };

    // converts lastSeen to a timestamp
    if ('lastSeen' in updates && typeof updates.lastSeen === 'number') {
      updateData.lastSeenAt = new Date(updates.lastSeen).toISOString();
    }

    // to ensure lastSeenAt is an ISO string Date object.
    if ('lastSeenAt' in updates && updates.lastSeenAt !== 'undefined') {
      const v = updates.lastSeenAt as any;
      updateData.lastSeenAt =
        v instanceof Date ? v.toISOString() : new Date(v).toISOString();
    }
    const updated = { ...doc, ...updateData };
    const res = await this.insertWithRetry(updated);
    return res.ok;
  }

  async getSessionsByQuery(q: Partial<UserSession>): Promise<UserSession[]> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }

    const selector: any = { ...q };
    const response = await this.withRetry(() =>
      this.nanoDb!.find({ selector, limit: 10000 })
    );
    return response.docs as unknown as UserSession[]; // could also expand type UserSession to avoid unknown
  }

  async ensureSessionIndexes(): Promise<void> {
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }
    // index for toInactivate, toReactivate, toExpire
    await this.withRetry(() =>
      (this.nanoDb as any).createIndex({
        index: {
          fields: ['isExpired', 'isActive']
        },
        name: 'idx_isExpired_isActive',
        ddoc: 'idx_isExpired_isActive',
        type: 'json'
      })
    );

    // index for getUsersForLine()
    await this.withRetry(() =>
      (this.nanoDb as any).createIndex({
        index: {
          fields: ['isWhip', 'isExpired']
        },
        name: 'idx_isWhip_isExpired',
        ddoc: 'idx_isWhip_isExpired',
        type: 'json'
      })
    );

    // index for getUsersForLine()
    await this.withRetry(() =>
      (this.nanoDb as any).createIndex({
        index: {
          fields: ['productionId', 'lineId', 'isExpired']
        },
        name: 'idx_prod_line_isExpired',
        ddoc: 'idx_prod_line_isExpired',
        type: 'json'
      })
    );

    // index for getActiveUsers()
    await this.withRetry(() =>
      (this.nanoDb as any).createIndex({
        index: {
          fields: ['productionId', 'isActive']
        },
        name: 'idx_prod_isActive',
        ddoc: 'idx_prod_isActive',
        type: 'json'
      })
    );

    // index for getOnlineClients() (M1: Client Registry)
    await this.withRetry(() =>
      (this.nanoDb as any).createIndex({
        index: {
          fields: ['docType', 'isOnline']
        },
        name: 'idx_docType_isOnline',
        ddoc: 'idx_docType_isOnline',
        type: 'json'
      })
    );

    // Index for caller active calls (M2)
    await this.withRetry(() =>
      (this.nanoDb as any).createIndex({
        index: { fields: ['docType', 'state', 'callerId'] },
        name: 'idx_call_caller',
        ddoc: 'idx_call_caller',
        type: 'json'
      })
    );

    // Index for callee active calls (M2)
    await this.withRetry(() =>
      (this.nanoDb as any).createIndex({
        index: { fields: ['docType', 'state', 'calleeId'] },
        name: 'idx_call_callee',
        ddoc: 'idx_call_callee',
        type: 'json'
      })
    );
  }

  // === M1: Client Registry ===

  async saveClient(client: ClientDocument): Promise<void> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }

    let existingDoc: any;
    try {
      existingDoc = await this.withRetry(() =>
        this.nanoDb!.get(client._id)
      );
    } catch (error: any) {
      if (error.statusCode === 404) {
        existingDoc = null;
      } else {
        throw error;
      }
    }

    const doc = existingDoc
      ? { ...existingDoc, ...client, _id: client._id }
      : { ...client };

    await this.insertWithRetry(doc);
  }

  async getClient(clientId: string): Promise<ClientDocument | null> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }

    try {
      const doc = await this.withRetry(() => this.nanoDb!.get(clientId));
      return doc as unknown as ClientDocument;
    } catch (error: any) {
      if (error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  async updateClient(
    clientId: string,
    updates: Partial<ClientDocument>
  ): Promise<void> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }

    let existingDoc: any;
    try {
      existingDoc = await this.withRetry(() => this.nanoDb!.get(clientId));
    } catch (error: any) {
      if (error.statusCode === 404) {
        throw new Error(`Client with id "${clientId}" not found`);
      }
      throw error;
    }

    const updatedDoc = {
      ...existingDoc,
      ...updates,
      _id: clientId,
      lastSeenAt: new Date().toISOString()
    };

    await this.insertWithRetry(updatedDoc);
  }

  async getOnlineClients(): Promise<ClientDocument[]> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }

    const response = await this.withRetry(() =>
      this.nanoDb!.find({
        selector: { docType: 'client', isOnline: true },
        limit: 10000
      })
    );
    return response.docs as unknown as ClientDocument[];
  }

  // === M2: P2P Calls ===

  async saveCall(call: CallDocument): Promise<void> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }

    await this.insertWithRetry({ ...call, _id: call._id });
  }

  async getCall(callId: string): Promise<CallDocument | null> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }

    try {
      const doc = await this.withRetry(() => this.nanoDb!.get(callId));
      return doc as unknown as CallDocument;
    } catch (error: any) {
      if (error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  async updateCall(
    callId: string,
    updates: Partial<CallDocument>
  ): Promise<void> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }

    let existingDoc: any;
    try {
      existingDoc = await this.withRetry(() => this.nanoDb!.get(callId));
    } catch (error: any) {
      if (error.statusCode === 404) {
        throw new Error(`Call with id "${callId}" not found`);
      }
      throw error;
    }

    const updatedDoc = {
      ...existingDoc,
      ...updates,
      _id: callId
    };

    await this.insertWithRetry(updatedDoc);
  }

  async getActiveCallCount(): Promise<number> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }

    const result = await this.withRetry(() =>
      this.nanoDb!.find({
        selector: {
          docType: 'call',
          state: { $ne: 'ended' }
        },
        fields: ['_id'],
        limit: 10000
      })
    );
    return result.docs.length;
  }

  async markAllClientsOffline(): Promise<void> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }

    const response = await this.withRetry(() =>
      this.nanoDb!.find({
        selector: { docType: 'client', isOnline: true },
        limit: 10000
      })
    );

    const docs = response.docs as any[];
    if (docs.length === 0) {
      Log().info('Startup cleanup: no online clients to mark offline');
      return;
    }

    const now = new Date().toISOString();
    const updatedDocs = docs.map((doc) => ({
      ...doc,
      isOnline: false,
      lastSeenAt: now
    }));

    await this.withRetry(() =>
      this.nanoDb!.bulk({ docs: updatedDocs })
    );

    Log().info(
      `Startup cleanup: marked ${docs.length} client(s) offline in CouchDB`
    );
  }

  async getActiveCallsForClient(clientId: string): Promise<CallDocument[]> {
    await this.connect();
    if (!this.nanoDb) {
      throw new Error('Database not connected');
    }

    // Query calls where client is the caller
    const callerResponse = await this.withRetry(() =>
      this.nanoDb!.find({
        selector: {
          docType: 'call',
          state: { $ne: 'ended' },
          callerId: clientId
        },
        limit: 10000
      })
    );

    // Query calls where client is the callee
    const calleeResponse = await this.withRetry(() =>
      this.nanoDb!.find({
        selector: {
          docType: 'call',
          state: { $ne: 'ended' },
          calleeId: clientId
        },
        limit: 10000
      })
    );

    // Deduplicate by _id
    const callMap = new Map<string, CallDocument>();
    for (const doc of callerResponse.docs as unknown as CallDocument[]) {
      callMap.set(doc._id, doc);
    }
    for (const doc of calleeResponse.docs as unknown as CallDocument[]) {
      callMap.set(doc._id, doc);
    }

    return Array.from(callMap.values());
  }
}
