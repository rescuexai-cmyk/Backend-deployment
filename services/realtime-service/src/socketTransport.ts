/**
 * Socket.io Transport Adapter
 * 
 * Wraps the existing Socket.io implementation as a RealtimeTransport
 * so it works alongside SSE and MQTT through the EventBus.
 * 
 * This preserves backward compatibility with existing Flutter clients
 * while allowing migration to SSE/MQTT.
 * 
 * Migration strategy:
 * 1. Phase 1 (now): Socket.io + SSE + MQTT all active
 * 2. Phase 2: Flutter app migrates to SSE/MQTT
 * 3. Phase 3: Socket.io deprecated and removed
 */

import type { Server as SocketServer } from 'socket.io';
import { createLogger } from '@raahi/shared';
import { eventBus, RealtimeEvent, RealtimeTransport, CHANNELS } from './eventBus';

const logger = createLogger('socket-transport');

class SocketIOTransport implements RealtimeTransport {
  name = 'socketio';
  
  private io: SocketServer | null = null;
  private connectedDrivers: Map<string, string> | null = null;
  private driverSockets: Map<string, Set<string>> | null = null;

  initialize(
    io: SocketServer,
    connectedDrivers: Map<string, string>,
    driverSockets: Map<string, Set<string>>
  ): void {
    this.io = io;
    this.connectedDrivers = connectedDrivers;
    this.driverSockets = driverSockets;
    eventBus.registerTransport(this);
    logger.info('[SOCKET-TRANSPORT] Initialized and registered with EventBus');
  }

  deliver(channel: string, event: RealtimeEvent): void {
    if (!this.io) return;

    // Map EventBus channels to Socket.io rooms and events
    if (channel.startsWith('ride:')) {
      const rideId = channel.slice(5);
      const room = `ride-${rideId}`;
      this.io.to(room).emit(event.type, event);
    } else if (channel.startsWith('driver:')) {
      const driverId = channel.slice(7);
      const room = `driver-${driverId}`;
      this.io.to(room).emit(event.type, event);
    } else if (channel === 'available-drivers') {
      this.io.to('available-drivers').emit(event.type, event);
    } else if (channel === 'driver-locations') {
      this.io.emit('driver-location-update', event);
    } else if (channel.startsWith('h3:')) {
      // H3 channels don't have direct Socket.io room equivalents
      // Fall through to available-drivers as Socket.io fallback
      // (SSE and MQTT handle H3-scoped delivery natively)
    }
  }

  getChannelSize(channel: string): number {
    if (!this.io) return 0;

    if (channel.startsWith('ride:')) {
      const rideId = channel.slice(5);
      return this.io.sockets.adapter.rooms.get(`ride-${rideId}`)?.size || 0;
    }
    if (channel.startsWith('driver:')) {
      const driverId = channel.slice(7);
      return this.io.sockets.adapter.rooms.get(`driver-${driverId}`)?.size || 0;
    }
    if (channel === 'available-drivers') {
      return this.io.sockets.adapter.rooms.get('available-drivers')?.size || 0;
    }
    if (channel === 'driver-locations') {
      return this.io.sockets.sockets.size;
    }
    return 0;
  }

  isHealthy(): boolean {
    return this.io !== null;
  }

  getStats() {
    if (!this.io) {
      return { connected: false, totalSockets: 0, uniqueDrivers: 0 };
    }

    return {
      connected: true,
      totalSockets: this.io.sockets.sockets.size,
      uniqueDrivers: this.driverSockets?.size || 0,
      availableDriversRoom: this.io.sockets.adapter.rooms.get('available-drivers')?.size || 0,
    };
  }
}

export const socketTransport = new SocketIOTransport();
