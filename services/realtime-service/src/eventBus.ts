/**
 * EventBus: In-process pub/sub system for decoupling real-time transports
 * 
 * This is the central nervous system of the hybrid real-time architecture.
 * It decouples the broadcast logic from the transport layer, allowing
 * SSE, MQTT, Socket.io, and future protocols (gRPC/WebTransport) to
 * coexist without knowing about each other.
 * 
 * Architecture:
 *   Service Logic → EventBus → [SSE Manager, MQTT Broker, Socket.io]
 * 
 * H3 Integration:
 *   Events can be tagged with H3 cells for geospatial routing.
 *   For example, ride requests are only pushed to drivers whose
 *   current H3 cell is within the pickup area's kRing.
 */

import { EventEmitter } from 'events';
import { createLogger } from '@raahi/shared';

const logger = createLogger('event-bus');

// ─── Event Type Definitions ───────────────────────────────────────────────────

export interface RideStatusEvent {
  type: 'ride-status-update';
  rideId: string;
  status: string;
  data?: any;
  timestamp: string;
}

export interface DriverLocationEvent {
  type: 'driver-location';
  driverId: string;
  rideId?: string;
  lat: number;
  lng: number;
  h3Index?: string;
  heading?: number;
  speed?: number;
  timestamp: string;
}

export interface RideRequestEvent {
  type: 'new-ride-request';
  rideId: string;
  targetDriverIds: string[];
  h3Cells?: string[];  // H3 cells for geospatial filtering
  payload: {
    rideId: string;
    pickupLocation: { lat: number; lng: number; address: string };
    dropLocation: { lat: number; lng: number; address: string };
    distance: number;
    estimatedFare: number;
    paymentMethod: string;
    vehicleType: string;
    passengerName: string;
    timestamp: string;
  };
}

export interface DriverAssignedEvent {
  type: 'driver-assigned';
  rideId: string;
  driver: any;
  timestamp: string;
}

export interface RideCancelledEvent {
  type: 'ride-cancelled';
  rideId: string;
  cancelledBy: string;
  reason?: string;
  timestamp: string;
}

export interface RideChatEvent {
  type: 'ride-chat-message';
  rideId: string;
  message: {
    id: string;
    senderId: string;
    message: string;
    timestamp: string;
  };
}

export interface DriverRegistrationEvent {
  type: 'driver-registered' | 'driver-unregistered';
  driverId: string;
  h3Index?: string;
  timestamp: string;
}

export type RealtimeEvent =
  | RideStatusEvent
  | DriverLocationEvent
  | RideRequestEvent
  | DriverAssignedEvent
  | RideCancelledEvent
  | RideChatEvent
  | DriverRegistrationEvent;

// ─── Channel Names ────────────────────────────────────────────────────────────

export const CHANNELS = {
  /** Events for a specific ride room (both driver + passenger) */
  ride: (rideId: string) => `ride:${rideId}`,
  /** Events for a specific driver */
  driver: (driverId: string) => `driver:${driverId}`,
  /** Events broadcast to all available drivers */
  availableDrivers: 'available-drivers',
  /** Global driver location updates (for admin/monitoring) */
  driverLocations: 'driver-locations',
  /** H3-scoped channel for geospatial broadcast */
  h3Cell: (h3Index: string) => `h3:${h3Index}`,
} as const;

// ─── Transport Interface ──────────────────────────────────────────────────────

/**
 * Each transport protocol implements this interface to receive events
 * from the EventBus and push them to connected clients.
 */
export interface RealtimeTransport {
  name: string;
  /** Called when an event should be delivered to a specific channel */
  deliver(channel: string, event: RealtimeEvent): void;
  /** Get the number of active connections/subscriptions for a channel */
  getChannelSize(channel: string): number;
  /** Check if the transport is healthy */
  isHealthy(): boolean;
}

// ─── EventBus Implementation ─────────────────────────────────────────────────

class EventBusImpl {
  private emitter: EventEmitter;
  private transports: Map<string, RealtimeTransport> = new Map();
  private metrics = {
    eventsPublished: 0,
    eventsDelivered: 0,
    deliveryErrors: 0,
    lastEventAt: null as string | null,
  };

  constructor() {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(100);
    logger.info('[EVENT-BUS] Initialized');
  }

  /**
   * Register a transport protocol (SSE, MQTT, Socket.io, etc.)
   */
  registerTransport(transport: RealtimeTransport): void {
    this.transports.set(transport.name, transport);
    logger.info(`[EVENT-BUS] Transport registered: ${transport.name}`);
  }

  /**
   * Unregister a transport protocol
   */
  unregisterTransport(name: string): void {
    this.transports.delete(name);
    logger.info(`[EVENT-BUS] Transport unregistered: ${name}`);
  }

  /**
   * Publish an event to a channel. All registered transports will attempt delivery.
   * 
   * @param channel - The channel to publish to (e.g., 'ride:abc123')
   * @param event - The event payload
   */
  publish(channel: string, event: RealtimeEvent): void {
    this.metrics.eventsPublished++;
    this.metrics.lastEventAt = new Date().toISOString();

    let totalDelivered = 0;
    const deliveryResults: Array<{ transport: string; channelSize: number; success: boolean }> = [];

    for (const [name, transport] of this.transports) {
      try {
        const channelSize = transport.getChannelSize(channel);
        if (channelSize > 0) {
          transport.deliver(channel, event);
          totalDelivered += channelSize;
          deliveryResults.push({ transport: name, channelSize, success: true });
        } else {
          deliveryResults.push({ transport: name, channelSize: 0, success: true });
        }
      } catch (error) {
        this.metrics.deliveryErrors++;
        deliveryResults.push({ transport: name, channelSize: 0, success: false });
        logger.error(`[EVENT-BUS] Delivery failed via ${name}`, { channel, eventType: event.type, error });
      }
    }

    this.metrics.eventsDelivered += totalDelivered;

    // Log delivery summary for important events
    if (event.type !== 'driver-location') {
      logger.info(`[EVENT-BUS] Published ${event.type} to ${channel}`, {
        deliveryResults,
        totalDelivered,
      });
    }
  }

  /**
   * Publish to multiple channels simultaneously (e.g., H3 cells for geo-broadcast)
   */
  publishToMany(channels: string[], event: RealtimeEvent): void {
    for (const channel of channels) {
      this.publish(channel, event);
    }
  }

  /**
   * Get total listeners across all transports for a channel
   */
  getTotalListeners(channel: string): number {
    let total = 0;
    for (const transport of this.transports.values()) {
      total += transport.getChannelSize(channel);
    }
    return total;
  }

  /**
   * Get health status of all transports
   */
  getHealth(): Record<string, boolean> {
    const health: Record<string, boolean> = {};
    for (const [name, transport] of this.transports) {
      health[name] = transport.isHealthy();
    }
    return health;
  }

  /**
   * Get metrics for monitoring
   */
  getMetrics() {
    return {
      ...this.metrics,
      transports: Array.from(this.transports.keys()),
      transportHealth: this.getHealth(),
    };
  }
}

// Singleton instance
export const eventBus = new EventBusImpl();
