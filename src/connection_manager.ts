import { WebSocket } from 'ws';
import { WsServerEvent } from './models';
import { Log } from './log';

/**
 * In-memory WebSocket connection tracker.
 * Maps clientId -> WebSocket. Process-local (single-instance POC).
 *
 * Handles duplicate connections (e.g. browser tab refresh) by closing the
 * old socket with code 4002 before storing the new one.
 */
export class ConnectionManager {
  private connections = new Map<string, WebSocket>();

  /**
   * Register a WebSocket for the given clientId.
   * If a connection already exists for this client, close the old one with 4002.
   */
  add(clientId: string, socket: WebSocket): void {
    const existing = this.connections.get(clientId);
    if (existing) {
      Log().info(
        `ConnectionManager: closing duplicate connection for client ${clientId}`
      );
      existing.close(4002, 'Already connected');
    }
    this.connections.set(clientId, socket);
  }

  /**
   * Remove the connection for the given clientId.
   */
  remove(clientId: string): void {
    this.connections.delete(clientId);
  }

  /**
   * Send a JSON message to all connected clients, optionally excluding one.
   * Silently skips sockets that are not in OPEN state.
   */
  broadcast(message: WsServerEvent, excludeClientId?: string): void {
    const data = JSON.stringify(message);
    for (const [clientId, socket] of this.connections) {
      if (clientId === excludeClientId) continue;
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(data);
      }
    }
  }

  /**
   * Send a JSON message to a specific client by clientId.
   * Silently skips if the client is not connected or socket is not OPEN.
   */
  sendTo(clientId: string, message: WsServerEvent): void {
    const socket = this.connections.get(clientId);
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  /**
   * Get the WebSocket for a specific client, if connected.
   */
  getSocket(clientId: string): WebSocket | undefined {
    return this.connections.get(clientId);
  }

  /**
   * Return all currently tracked client IDs.
   */
  getConnectedClientIds(): string[] {
    return Array.from(this.connections.keys());
  }
}
