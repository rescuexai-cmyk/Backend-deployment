/**
 * SSE (Server-Sent Events) Manager
 * 
 * Industry-grade SSE implementation for Raahi ride-hailing.
 * Replaces Socket.io for server→client push communication.
 * 
 * Why SSE over WebSockets:
 * 1. Uses standard HTTP - works through all proxies/firewalls/load balancers
 * 2. Built-in reconnection with Last-Event-ID resumption
 * 3. No connection upgrade handshake (the main source of "Start Ride" errors)
 * 4. Simpler to scale (stateless HTTP, can be load-balanced easily)
 * 5. Lower overhead for unidirectional server→client push
 * 
 * H3 Integration:
 * - Driver SSE connections are tagged with their current H3 cell index
 * - Ride request broadcasts use H3 kRing to target only nearby drivers
 * - H3 cell changes trigger automatic channel re-subscription
 * 
 * Used by: Uber (for rider-side updates), Lyft, Grab
 */

import { Request, Response } from 'express';
import { createLogger } from '@raahi/shared';
import { latLngToH3, getKRing, getH3Config } from '@raahi/shared';
import { eventBus, RealtimeEvent, RealtimeTransport, CHANNELS } from './eventBus';

const logger = createLogger('sse-manager');

// ─── SSE Client Connection ───────────────────────────────────────────────────

interface SSEClient {
  id: string;
  res: Response;
  channels: Set<string>;
  clientType: 'passenger' | 'driver' | 'admin';
  entityId: string;  // passengerId, driverId, or adminId
  h3Index?: string;  // Current H3 cell (drivers only)
  connectedAt: Date;
  lastEventId: number;
  isAlive: boolean;
}

// ─── SSE Manager ─────────────────────────────────────────────────────────────

class SSEManagerImpl implements RealtimeTransport {
  name = 'sse';
  
  private clients = new Map<string, SSEClient>();
  private channelSubscribers = new Map<string, Set<string>>(); // channel → Set<clientId>
  private entityToClient = new Map<string, Set<string>>(); // entityId → Set<clientId>
  private eventCounter = 0;
  private heartbeatInterval: NodeJS.Timeout | null = null;

  // Configuration
  private readonly HEARTBEAT_INTERVAL_MS = 15000; // 15s heartbeat (SSE keep-alive)
  private readonly CLIENT_TIMEOUT_MS = 60000; // 60s before marking client dead
  private readonly MAX_RETRY_MS = 5000; // Client reconnect retry hint (5s)

  constructor() {
    this.startHeartbeat();
    eventBus.registerTransport(this);
    logger.info('[SSE] Manager initialized and registered with EventBus');
  }

  // ─── Transport Interface Implementation ──────────────────────────────────

  deliver(channel: string, event: RealtimeEvent): void {
    const subscriberIds = this.channelSubscribers.get(channel);
    if (!subscriberIds || subscriberIds.size === 0) return;

    const eventId = ++this.eventCounter;
    const sseData = this.formatSSEMessage(event.type, event, eventId);

    for (const clientId of subscriberIds) {
      const client = this.clients.get(clientId);
      if (client && client.isAlive) {
        try {
          client.res.write(sseData);
          client.lastEventId = eventId;
        } catch (error) {
          logger.warn(`[SSE] Failed to write to client ${clientId}`, { error });
          this.removeClient(clientId);
        }
      }
    }
  }

  getChannelSize(channel: string): number {
    return this.channelSubscribers.get(channel)?.size || 0;
  }

  isHealthy(): boolean {
    return true; // SSE is always healthy as long as Express is running
  }

  // ─── Connection Management ───────────────────────────────────────────────

  /**
   * Handle a new SSE connection from an Express route handler.
   * 
   * Usage in route:
   *   app.get('/api/realtime/sse/ride/:rideId', authenticate, (req, res) => {
   *     sseManager.handleRideConnection(req, res, rideId, userId);
   *   });
   */
  handleRideConnection(req: Request, res: Response, rideId: string, userId: string): void {
    const clientId = `sse-ride-${userId}-${rideId}-${Date.now()}`;
    
    this.setupSSEHeaders(res);
    
    const client: SSEClient = {
      id: clientId,
      res,
      channels: new Set(),
      clientType: 'passenger',
      entityId: userId,
      connectedAt: new Date(),
      lastEventId: parseInt(req.headers['last-event-id'] as string) || 0,
      isAlive: true,
    };

    this.addClient(client);
    this.subscribe(clientId, CHANNELS.ride(rideId));
    
    // Send initial connection confirmation
    this.sendEvent(client, 'connected', {
      clientId,
      channel: `ride:${rideId}`,
      protocol: 'sse',
      serverTime: new Date().toISOString(),
      reconnectMs: this.MAX_RETRY_MS,
    });

    logger.info(`[SSE] Ride connection: client=${clientId}, ride=${rideId}, user=${userId}`);

    // Handle client disconnect
    req.on('close', () => {
      logger.info(`[SSE] Ride client disconnected: ${clientId}`);
      this.removeClient(clientId);
    });
  }

  /**
   * Handle a new SSE connection for a driver.
   * Subscribes to:
   * - Driver-specific events (ride assignments, cancellations)
   * - Available drivers room (new ride requests)
   * - H3 cell channels (geospatial ride matching)
   */
  handleDriverConnection(
    req: Request,
    res: Response,
    driverId: string,
    lat?: number,
    lng?: number,
  ): void {
    const clientId = `sse-driver-${driverId}-${Date.now()}`;
    
    this.setupSSEHeaders(res);
    
    const h3Index = (lat !== undefined && lng !== undefined)
      ? latLngToH3(lat, lng)
      : undefined;

    const client: SSEClient = {
      id: clientId,
      res,
      channels: new Set(),
      clientType: 'driver',
      entityId: driverId,
      h3Index,
      connectedAt: new Date(),
      lastEventId: parseInt(req.headers['last-event-id'] as string) || 0,
      isAlive: true,
    };

    this.addClient(client);
    
    // Subscribe to driver-specific channel
    this.subscribe(clientId, CHANNELS.driver(driverId));
    
    // Subscribe to available drivers (for ride requests)
    this.subscribe(clientId, CHANNELS.availableDrivers);
    
    // Subscribe to H3 cell channels for geospatial ride matching
    if (h3Index) {
      this.subscribeToH3Cells(clientId, h3Index);
    }

    this.sendEvent(client, 'connected', {
      clientId,
      channels: Array.from(client.channels),
      protocol: 'sse',
      h3Index,
      serverTime: new Date().toISOString(),
      reconnectMs: this.MAX_RETRY_MS,
    });

    logger.info(`[SSE] Driver connection: client=${clientId}, driver=${driverId}, h3=${h3Index}`);

    req.on('close', () => {
      logger.info(`[SSE] Driver client disconnected: ${clientId}`);
      this.removeClient(clientId);
    });
  }

  /**
   * Handle SSE connection for admin/monitoring dashboards.
   */
  handleAdminConnection(req: Request, res: Response, adminId: string): void {
    const clientId = `sse-admin-${adminId}-${Date.now()}`;
    
    this.setupSSEHeaders(res);
    
    const client: SSEClient = {
      id: clientId,
      res,
      channels: new Set(),
      clientType: 'admin',
      entityId: adminId,
      connectedAt: new Date(),
      lastEventId: parseInt(req.headers['last-event-id'] as string) || 0,
      isAlive: true,
    };

    this.addClient(client);
    this.subscribe(clientId, CHANNELS.driverLocations);

    this.sendEvent(client, 'connected', {
      clientId,
      protocol: 'sse',
      serverTime: new Date().toISOString(),
    });

    logger.info(`[SSE] Admin connection: client=${clientId}`);

    req.on('close', () => {
      this.removeClient(clientId);
    });
  }

  // ─── H3 Geospatial Integration ──────────────────────────────────────────

  /**
   * Subscribe a driver to their current H3 cell and surrounding kRing cells.
   * This enables efficient geospatial ride request delivery.
   */
  private subscribeToH3Cells(clientId: string, h3Index: string): void {
    const config = getH3Config();
    // Subscribe to k=1 ring (center + 6 adjacent cells) for ride request delivery
    const cells = getKRing(h3Index, 1);
    
    for (const cell of cells) {
      this.subscribe(clientId, CHANNELS.h3Cell(cell));
    }
    
    logger.debug(`[SSE] Driver ${clientId} subscribed to ${cells.length} H3 cells (center: ${h3Index})`);
  }

  /**
   * Update a driver's H3 cell subscriptions when they move to a new cell.
   * Called when driver location updates change their H3 index.
   */
  updateDriverH3(driverId: string, newH3Index: string): void {
    const clientIds = this.entityToClient.get(driverId);
    if (!clientIds) return;

    for (const clientId of clientIds) {
      const client = this.clients.get(clientId);
      if (!client || client.clientType !== 'driver') continue;

      const oldH3Index = client.h3Index;
      if (oldH3Index === newH3Index) return; // No change

      // Unsubscribe from old H3 cells
      if (oldH3Index) {
        const oldCells = getKRing(oldH3Index, 1);
        for (const cell of oldCells) {
          this.unsubscribe(clientId, CHANNELS.h3Cell(cell));
        }
      }

      // Subscribe to new H3 cells
      client.h3Index = newH3Index;
      this.subscribeToH3Cells(clientId, newH3Index);
      
      logger.debug(`[SSE] Driver ${driverId} H3 updated: ${oldH3Index} → ${newH3Index}`);
    }
  }

  // ─── Subscription Management ─────────────────────────────────────────────

  private subscribe(clientId: string, channel: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    client.channels.add(channel);

    if (!this.channelSubscribers.has(channel)) {
      this.channelSubscribers.set(channel, new Set());
    }
    this.channelSubscribers.get(channel)!.add(clientId);
  }

  private unsubscribe(clientId: string, channel: string): void {
    const client = this.clients.get(clientId);
    if (client) {
      client.channels.delete(channel);
    }

    const subscribers = this.channelSubscribers.get(channel);
    if (subscribers) {
      subscribers.delete(clientId);
      if (subscribers.size === 0) {
        this.channelSubscribers.delete(channel);
      }
    }
  }

  /**
   * Subscribe a client to a ride-specific channel dynamically.
   * Used when a driver accepts a ride and needs to join the ride room.
   */
  subscribeToRide(driverId: string, rideId: string): void {
    const clientIds = this.entityToClient.get(driverId);
    if (!clientIds) return;

    for (const clientId of clientIds) {
      this.subscribe(clientId, CHANNELS.ride(rideId));
    }
    logger.info(`[SSE] Driver ${driverId} subscribed to ride ${rideId}`);
  }

  /**
   * Unsubscribe a client from a ride channel.
   */
  unsubscribeFromRide(entityId: string, rideId: string): void {
    const clientIds = this.entityToClient.get(entityId);
    if (!clientIds) return;

    for (const clientId of clientIds) {
      this.unsubscribe(clientId, CHANNELS.ride(rideId));
    }
  }

  // ─── Client Lifecycle ────────────────────────────────────────────────────

  private addClient(client: SSEClient): void {
    this.clients.set(client.id, client);

    if (!this.entityToClient.has(client.entityId)) {
      this.entityToClient.set(client.entityId, new Set());
    }
    this.entityToClient.get(client.entityId)!.add(client.id);
  }

  private removeClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    // Unsubscribe from all channels
    for (const channel of client.channels) {
      const subscribers = this.channelSubscribers.get(channel);
      if (subscribers) {
        subscribers.delete(clientId);
        if (subscribers.size === 0) {
          this.channelSubscribers.delete(channel);
        }
      }
    }

    // Remove from entity mapping
    const entityClients = this.entityToClient.get(client.entityId);
    if (entityClients) {
      entityClients.delete(clientId);
      if (entityClients.size === 0) {
        this.entityToClient.delete(client.entityId);
      }
    }

    // Try to end the response if still writable
    try {
      if (!client.res.writableEnded) {
        client.res.end();
      }
    } catch {
      // Already closed
    }

    this.clients.delete(clientId);
  }

  // ─── SSE Protocol Helpers ────────────────────────────────────────────────

  private setupSSEHeaders(res: Response): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',  // Disable nginx buffering
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Last-Event-ID',
    });

    // Send retry interval hint to client
    res.write(`retry: ${this.MAX_RETRY_MS}\n\n`);
  }

  /**
   * Format an SSE message according to the spec.
   * 
   * SSE message format:
   *   id: <event-id>
   *   event: <event-type>
   *   data: <json-payload>
   *   \n
   */
  private formatSSEMessage(eventType: string, data: any, eventId: number): string {
    const jsonData = JSON.stringify(data);
    return `id: ${eventId}\nevent: ${eventType}\ndata: ${jsonData}\n\n`;
  }

  private sendEvent(client: SSEClient, eventType: string, data: any): void {
    if (!client.isAlive || client.res.writableEnded) return;
    
    try {
      const eventId = ++this.eventCounter;
      const message = this.formatSSEMessage(eventType, data, eventId);
      client.res.write(message);
      client.lastEventId = eventId;
    } catch (error) {
      logger.warn(`[SSE] Failed to send event to ${client.id}`, { error });
      client.isAlive = false;
    }
  }

  // ─── Heartbeat / Keep-Alive ──────────────────────────────────────────────

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      const deadClients: string[] = [];

      for (const [clientId, client] of this.clients) {
        if (!client.isAlive || client.res.writableEnded) {
          deadClients.push(clientId);
          continue;
        }

        // Send SSE comment as heartbeat (: is a comment in SSE spec)
        try {
          client.res.write(`: heartbeat ${new Date().toISOString()}\n\n`);
        } catch {
          deadClients.push(clientId);
        }
      }

      // Clean up dead clients
      for (const clientId of deadClients) {
        this.removeClient(clientId);
      }

      if (deadClients.length > 0) {
        logger.debug(`[SSE] Cleaned up ${deadClients.length} dead connections`);
      }
    }, this.HEARTBEAT_INTERVAL_MS);
  }

  // ─── Stats & Monitoring ──────────────────────────────────────────────────

  getStats() {
    const clientsByType = { passenger: 0, driver: 0, admin: 0 };
    for (const client of this.clients.values()) {
      clientsByType[client.clientType]++;
    }

    return {
      totalConnections: this.clients.size,
      uniqueEntities: this.entityToClient.size,
      activeChannels: this.channelSubscribers.size,
      clientsByType,
      eventCounter: this.eventCounter,
    };
  }

  /**
   * Get detailed connection info (for debug endpoint)
   */
  getDetailedConnections() {
    const connections: Array<{
      clientId: string;
      type: string;
      entityId: string;
      channels: string[];
      h3Index?: string;
      connectedAt: string;
      lastEventId: number;
    }> = [];

    for (const client of this.clients.values()) {
      connections.push({
        clientId: client.id,
        type: client.clientType,
        entityId: client.entityId,
        channels: Array.from(client.channels),
        h3Index: client.h3Index,
        connectedAt: client.connectedAt.toISOString(),
        lastEventId: client.lastEventId,
      });
    }

    return connections;
  }

  /**
   * Shutdown the SSE manager gracefully
   */
  shutdown(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    // Close all client connections
    for (const clientId of this.clients.keys()) {
      this.removeClient(clientId);
    }

    eventBus.unregisterTransport('sse');
    logger.info('[SSE] Manager shut down');
  }
}

// Singleton instance
export const sseManager = new SSEManagerImpl();
