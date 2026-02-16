/**
 * MQTT Broker (Aedes) for Lightweight Real-Time Messaging
 * 
 * MQTT is the industry standard for IoT and mobile real-time messaging,
 * used by Facebook Messenger, Amazon IoT, and ride-hailing apps.
 * 
 * Why MQTT for Raahi:
 * 1. Extremely lightweight - minimal overhead per message (~2 bytes header)
 * 2. Built for unreliable networks - QoS levels, retained messages, last-will
 * 3. Publish/Subscribe pattern - perfect for driver location broadcasting
 * 4. Works on 2G/3G networks common in Indian tier-2/3 cities
 * 5. Supports offline message queuing (QoS 1/2)
 * 
 * Topic Hierarchy:
 *   raahi/driver/{driverId}/location     - Driver location updates
 *   raahi/ride/{rideId}/status           - Ride status events
 *   raahi/ride/{rideId}/location         - Driver location during ride
 *   raahi/ride/{rideId}/chat             - In-ride chat messages
 *   raahi/h3/{h3Index}/requests          - Geo-scoped ride requests
 *   raahi/broadcast/rides                - All ride requests (fallback)
 * 
 * H3 Integration:
 *   Drivers subscribe to their H3 cell topic and adjacent cells.
 *   When a ride request comes in, it's published to the pickup area's
 *   H3 cell topics, ensuring only nearby drivers receive it.
 * 
 * Protocol: MQTT over WebSocket (for browser/Flutter compatibility)
 *           MQTT over TCP (for native mobile clients)
 */

import { Aedes, AedesOptions } from 'aedes';
import { createServer as createTcpServer, Server as NetServer } from 'net';
import { createServer as createHttpServer, Server as HttpServer } from 'http';
import { WebSocketServer, createWebSocketStream } from 'ws';
import { createLogger } from '@raahi/shared';
import { eventBus, RealtimeEvent, RealtimeTransport, CHANNELS } from './eventBus';

const logger = createLogger('mqtt-broker');

// ─── Topic Mapping ────────────────────────────────────────────────────────────

export const MQTT_TOPICS = {
  driverLocation: (driverId: string) => `raahi/driver/${driverId}/location`,
  rideStatus: (rideId: string) => `raahi/ride/${rideId}/status`,
  rideLocation: (rideId: string) => `raahi/ride/${rideId}/location`,
  rideChat: (rideId: string) => `raahi/ride/${rideId}/chat`,
  h3Requests: (h3Index: string) => `raahi/h3/${h3Index}/requests`,
  broadcastRides: 'raahi/broadcast/rides',
  driverEvents: (driverId: string) => `raahi/driver/${driverId}/events`,
} as const;

// Map EventBus channels to MQTT topics
function channelToMqttTopic(channel: string): string | null {
  if (channel.startsWith('ride:')) {
    const rideId = channel.slice(5);
    return `raahi/ride/${rideId}/#`;  // Wildcard for all ride sub-topics
  }
  if (channel.startsWith('driver:')) {
    const driverId = channel.slice(7);
    return MQTT_TOPICS.driverEvents(driverId);
  }
  if (channel === 'available-drivers') {
    return MQTT_TOPICS.broadcastRides;
  }
  if (channel.startsWith('h3:')) {
    const h3Index = channel.slice(3);
    return MQTT_TOPICS.h3Requests(h3Index);
  }
  if (channel === 'driver-locations') {
    return 'raahi/driver/+/location';  // Wildcard for all driver locations
  }
  return null;
}

// Map RealtimeEvent types to specific MQTT sub-topics
function eventToMqttTopic(channel: string, event: RealtimeEvent): string | null {
  if (channel.startsWith('ride:')) {
    const rideId = channel.slice(5);
    switch (event.type) {
      case 'ride-status-update': return MQTT_TOPICS.rideStatus(rideId);
      case 'driver-location': return MQTT_TOPICS.rideLocation(rideId);
      case 'ride-chat-message': return MQTT_TOPICS.rideChat(rideId);
      case 'driver-assigned': return MQTT_TOPICS.rideStatus(rideId);
      case 'ride-cancelled': return MQTT_TOPICS.rideStatus(rideId);
      default: return MQTT_TOPICS.rideStatus(rideId);
    }
  }
  if (channel.startsWith('driver:')) {
    const driverId = channel.slice(7);
    if (event.type === 'driver-location') {
      return MQTT_TOPICS.driverLocation(driverId);
    }
    return MQTT_TOPICS.driverEvents(driverId);
  }
  if (channel === 'available-drivers') {
    return MQTT_TOPICS.broadcastRides;
  }
  if (channel.startsWith('h3:')) {
    const h3Index = channel.slice(3);
    return MQTT_TOPICS.h3Requests(h3Index);
  }
  return null;
}

// ─── MQTT Broker Transport ────────────────────────────────────────────────────

class MQTTBrokerTransport implements RealtimeTransport {
  name = 'mqtt';

  private aedes: InstanceType<typeof Aedes> | null = null;
  private tcpServer: NetServer | null = null;
  private wsServer: WebSocketServer | null = null;
  private httpServer: HttpServer | null = null;
  private topicSubscriberCount = new Map<string, number>();
  private isRunning = false;

  // Configuration
  private readonly TCP_PORT = parseInt(process.env.MQTT_TCP_PORT || '1883', 10);
  private readonly WS_PORT = parseInt(process.env.MQTT_WS_PORT || '8883', 10);
  private readonly MAX_CONNECTIONS = parseInt(process.env.MQTT_MAX_CONNECTIONS || '10000', 10);

  constructor() {
    logger.info('[MQTT] Broker transport created (call start() to initialize)');
  }

  /**
   * Start the MQTT broker with both TCP and WebSocket listeners.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('[MQTT] Broker already running');
      return;
    }

    try {
      // Create Aedes broker instance
      const aedesOptions: AedesOptions = {
        concurrency: 200,
        heartbeatInterval: 30000,
        connectTimeout: 10000,
      };
      this.aedes = new Aedes(aedesOptions);

      // Track subscriptions for EventBus channel size reporting
      this.aedes.on('subscribe', (subscriptions, client) => {
        for (const sub of subscriptions) {
          const count = this.topicSubscriberCount.get(sub.topic) || 0;
          this.topicSubscriberCount.set(sub.topic, count + 1);
          logger.debug(`[MQTT] Client ${client?.id} subscribed to ${sub.topic}`);
        }
      });

      this.aedes.on('unsubscribe', (subscriptions, client) => {
        for (const topic of subscriptions) {
          const count = this.topicSubscriberCount.get(topic) || 0;
          if (count > 0) {
            this.topicSubscriberCount.set(topic, count - 1);
          }
        }
      });

      this.aedes.on('client', (client) => {
        logger.info(`[MQTT] Client connected: ${client.id}`);
      });

      this.aedes.on('clientDisconnect', (client) => {
        logger.info(`[MQTT] Client disconnected: ${client.id}`);
      });

      this.aedes.on('clientError', (client, error) => {
        logger.error(`[MQTT] Client error: ${client.id}`, { error: error.message });
      });

      // Handle incoming published messages from MQTT clients (e.g., driver location)
      this.aedes.on('publish', (packet, client) => {
        if (!client) return; // System messages (e.g., retained)
        
        const topic = packet.topic;
        const payload = packet.payload.toString();

        // Driver location update via MQTT
        if (topic.match(/^raahi\/driver\/[^/]+\/location$/)) {
          try {
            const data = JSON.parse(payload);
            const driverIdMatch = topic.match(/^raahi\/driver\/([^/]+)\/location$/);
            if (driverIdMatch) {
              // Re-publish to EventBus so other transports and services get it
              eventBus.publish(CHANNELS.driverLocations, {
                type: 'driver-location',
                driverId: driverIdMatch[1],
                lat: data.lat,
                lng: data.lng,
                h3Index: data.h3Index,
                heading: data.heading,
                speed: data.speed,
                timestamp: data.timestamp || new Date().toISOString(),
              });
            }
          } catch (error) {
            logger.warn(`[MQTT] Failed to parse location update from ${client.id}`, { error });
          }
        }
      });

      // Start TCP server for native MQTT clients
      this.tcpServer = createTcpServer(this.aedes.handle);
      await new Promise<void>((resolve, reject) => {
        this.tcpServer!.listen(this.TCP_PORT, () => {
          logger.info(`[MQTT] TCP broker listening on port ${this.TCP_PORT}`);
          resolve();
        });
        this.tcpServer!.on('error', (err) => {
          if ((err as any).code === 'EADDRINUSE') {
            logger.warn(`[MQTT] TCP port ${this.TCP_PORT} already in use, skipping TCP listener`);
            resolve(); // Don't fail, just skip TCP
          } else {
            reject(err);
          }
        });
      });

      // Start WebSocket server for browser/Flutter clients
      this.httpServer = createHttpServer();
      this.wsServer = new WebSocketServer({ server: this.httpServer });
      
      this.wsServer.on('connection', (wsClient, req) => {
        const stream = createWebSocketStream(wsClient);
        this.aedes!.handle(stream as any);
      });

      await new Promise<void>((resolve, reject) => {
        this.httpServer!.listen(this.WS_PORT, () => {
          logger.info(`[MQTT] WebSocket broker listening on port ${this.WS_PORT}`);
          resolve();
        });
        this.httpServer!.on('error', (err) => {
          if ((err as any).code === 'EADDRINUSE') {
            logger.warn(`[MQTT] WS port ${this.WS_PORT} already in use, skipping WS listener`);
            resolve();
          } else {
            reject(err);
          }
        });
      });

      this.isRunning = true;
      eventBus.registerTransport(this);
      logger.info('[MQTT] Broker started and registered with EventBus');
    } catch (error) {
      logger.error('[MQTT] Failed to start broker', { error });
      throw error;
    }
  }

  // ─── Transport Interface ─────────────────────────────────────────────────

  deliver(channel: string, event: RealtimeEvent): void {
    if (!this.aedes || !this.isRunning) return;

    const topic = eventToMqttTopic(channel, event);
    if (!topic) return;

    const payload = JSON.stringify(event);
    
    // Determine QoS based on event type
    // QoS 0: At most once (fire & forget) - location updates
    // QoS 1: At least once - ride status, assignments
    const qos = event.type === 'driver-location' ? 0 : 1;

    this.aedes.publish({
      topic,
      payload: Buffer.from(payload),
      qos: qos as 0 | 1 | 2,
      retain: false,
      cmd: 'publish',
      dup: false,
    }, (err) => {
      if (err) {
        logger.error(`[MQTT] Publish failed: topic=${topic}`, { error: err });
      }
    });
  }

  getChannelSize(channel: string): number {
    const topic = channelToMqttTopic(channel);
    if (!topic) return 0;
    
    // For wildcard topics, sum up matching subscriptions
    let total = 0;
    for (const [subscribedTopic, count] of this.topicSubscriberCount) {
      if (this.topicMatches(topic, subscribedTopic) || this.topicMatches(subscribedTopic, topic)) {
        total += count;
      }
    }
    return total;
  }

  isHealthy(): boolean {
    return this.isRunning && this.aedes !== null;
  }

  /**
   * Simple MQTT topic matching (supports + and # wildcards)
   */
  private topicMatches(pattern: string, topic: string): boolean {
    if (pattern === topic) return true;
    if (pattern.includes('#')) {
      const prefix = pattern.slice(0, pattern.indexOf('#'));
      return topic.startsWith(prefix);
    }
    if (pattern.includes('+')) {
      const patternParts = pattern.split('/');
      const topicParts = topic.split('/');
      if (patternParts.length !== topicParts.length) return false;
      return patternParts.every((p, i) => p === '+' || p === topicParts[i]);
    }
    return false;
  }

  // ─── Direct Publish (for high-frequency location updates) ────────────────

  /**
   * Publish driver location directly to MQTT (bypasses EventBus for performance).
   * Used for high-frequency location updates where EventBus overhead is unnecessary.
   */
  publishDriverLocation(driverId: string, lat: number, lng: number, h3Index?: string, heading?: number, speed?: number): void {
    if (!this.aedes || !this.isRunning) return;

    const topic = MQTT_TOPICS.driverLocation(driverId);
    const payload = JSON.stringify({
      driverId,
      lat,
      lng,
      h3Index,
      heading,
      speed,
      t: Date.now(),  // Compact timestamp for bandwidth efficiency
    });

    this.aedes.publish({
      topic,
      payload: Buffer.from(payload),
      qos: 0,  // Fire and forget for location updates
      retain: true,  // Retain last known location for new subscribers
      cmd: 'publish',
      dup: false,
    }, (err) => {
      if (err) {
        logger.debug(`[MQTT] Location publish failed for ${driverId}`, { error: err });
      }
    });
  }

  /**
   * Publish ride-specific driver location (higher QoS than global location)
   */
  publishRideLocation(rideId: string, driverId: string, lat: number, lng: number, heading?: number, speed?: number): void {
    if (!this.aedes || !this.isRunning) return;

    const topic = MQTT_TOPICS.rideLocation(rideId);
    const payload = JSON.stringify({
      driverId,
      lat,
      lng,
      heading,
      speed,
      t: Date.now(),
    });

    this.aedes.publish({
      topic,
      payload: Buffer.from(payload),
      qos: 1,  // At least once - important for ride tracking
      retain: true,
      cmd: 'publish',
      dup: false,
    }, () => {});
  }

  // ─── Stats ───────────────────────────────────────────────────────────────

  getStats() {
    if (!this.aedes) {
      return { running: false, clients: 0, topics: 0 };
    }

    return {
      running: this.isRunning,
      connectedClients: this.aedes.connectedClients,
      topics: this.topicSubscriberCount.size,
      tcpPort: this.TCP_PORT,
      wsPort: this.WS_PORT,
    };
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    if (!this.isRunning) return;

    logger.info('[MQTT] Shutting down broker...');
    
    eventBus.unregisterTransport('mqtt');
    this.isRunning = false;

    if (this.aedes) {
      await new Promise<void>((resolve) => {
        this.aedes!.close(() => resolve());
      });
    }

    if (this.tcpServer) {
      this.tcpServer.close();
    }

    if (this.httpServer) {
      this.httpServer.close();
    }

    logger.info('[MQTT] Broker shut down');
  }
}

// Singleton instance
export const mqttBroker = new MQTTBrokerTransport();
