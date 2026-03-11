import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import { Express } from 'express';

export interface SwaggerConfig {
  title: string;
  version: string;
  description: string;
  port: number;
  basePath: string;
  apis: string[];
}

export const commonSchemas = {
  User: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Unique user ID' },
      email: { type: 'string', format: 'email', nullable: true },
      phone: { type: 'string', description: 'Phone number in E.164 format' },
      firstName: { type: 'string' },
      lastName: { type: 'string', nullable: true },
      profileImage: { type: 'string', nullable: true },
      isVerified: { type: 'boolean' },
      isActive: { type: 'boolean' },
      createdAt: { type: 'string', format: 'date-time' },
      lastLoginAt: { type: 'string', format: 'date-time', nullable: true },
    },
  },
  AuthTokens: {
    type: 'object',
    properties: {
      accessToken: { type: 'string', description: 'JWT access token' },
      refreshToken: { type: 'string', description: 'JWT refresh token' },
      expiresIn: { type: 'integer', description: 'Token expiry in seconds' },
    },
  },
  Pagination: {
    type: 'object',
    properties: {
      page: { type: 'integer', minimum: 1 },
      limit: { type: 'integer', minimum: 1 },
      total: { type: 'integer' },
      totalPages: { type: 'integer' },
      hasNext: { type: 'boolean' },
      hasPrev: { type: 'boolean' },
    },
  },
  ApiResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      message: { type: 'string' },
      data: { type: 'object' },
    },
  },
  ErrorResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: false },
      message: { type: 'string' },
      errors: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            msg: { type: 'string' },
            param: { type: 'string' },
            location: { type: 'string' },
          },
        },
      },
    },
  },
  ValidationError: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: false },
      message: { type: 'string', example: 'Validation failed' },
      errors: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            msg: { type: 'string' },
            param: { type: 'string' },
            location: { type: 'string' },
          },
        },
      },
    },
  },
  Driver: {
    type: 'object',
    properties: {
      driver_id: { type: 'string' },
      email: { type: 'string', nullable: true },
      name: { type: 'string' },
      phone: { type: 'string' },
      license_number: { type: 'string', nullable: true },
      vehicle_info: {
        type: 'object',
        properties: {
          make: { type: 'string' },
          model: { type: 'string' },
          year: { type: 'integer' },
          license_plate: { type: 'string' },
          color: { type: 'string' },
        },
      },
      status: { type: 'string', enum: ['active', 'inactive', 'suspended'] },
      rating: { type: 'number' },
      total_trips: { type: 'integer' },
      is_online: { type: 'boolean' },
      is_verified: { type: 'boolean' },
    },
  },
  Ride: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      passengerId: { type: 'string' },
      driverId: { type: 'string', nullable: true },
      status: {
        type: 'string',
        enum: ['PENDING', 'CONFIRMED', 'DRIVER_ARRIVED', 'RIDE_STARTED', 'RIDE_COMPLETED', 'CANCELLED'],
      },
      pickupLatitude: { type: 'number' },
      pickupLongitude: { type: 'number' },
      dropLatitude: { type: 'number' },
      dropLongitude: { type: 'number' },
      pickupAddress: { type: 'string' },
      dropAddress: { type: 'string' },
      distance: { type: 'number', description: 'Distance in meters' },
      duration: { type: 'integer', description: 'Duration in seconds' },
      baseFare: { type: 'number' },
      distanceFare: { type: 'number' },
      timeFare: { type: 'number' },
      surgeMultiplier: { type: 'number' },
      totalFare: { type: 'number' },
      paymentMethod: { type: 'string', enum: ['CASH', 'CARD', 'UPI', 'WALLET'] },
      paymentStatus: { type: 'string', enum: ['PENDING', 'COMPLETED', 'FAILED'] },
      vehicleType: { type: 'string' },
      otp: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
      startedAt: { type: 'string', format: 'date-time', nullable: true },
      completedAt: { type: 'string', format: 'date-time', nullable: true },
    },
  },
  FareBreakdown: {
    type: 'object',
    properties: {
      baseFare: { type: 'number' },
      distanceFare: { type: 'number' },
      timeFare: { type: 'number' },
      surgeMultiplier: { type: 'number' },
      totalFare: { type: 'number' },
      startingFee: { type: 'number' },
      ratePerKm: { type: 'number' },
      ratePerMin: { type: 'number' },
    },
  },
  Coordinates: {
    type: 'object',
    required: ['latitude', 'longitude'],
    properties: {
      latitude: { type: 'number', minimum: -90, maximum: 90 },
      longitude: { type: 'number', minimum: -180, maximum: 180 },
    },
  },
  SavedPlace: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      address: { type: 'string' },
      latitude: { type: 'number' },
      longitude: { type: 'number' },
      placeType: { type: 'string', enum: ['home', 'work', 'other'] },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  SupportTicket: {
    type: 'object',
    properties: {
      request_id: { type: 'string' },
      issue_type: { type: 'string' },
      description: { type: 'string' },
      priority: { type: 'string', enum: ['low', 'medium', 'high'] },
      status: { type: 'string', enum: ['open', 'in_progress', 'resolved', 'closed'] },
      response: { type: 'string', nullable: true },
      responded_at: { type: 'string', format: 'date-time', nullable: true },
      created_at: { type: 'string', format: 'date-time' },
    },
  },
  Notification: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      title: { type: 'string' },
      message: { type: 'string' },
      type: { type: 'string', enum: ['RIDE_UPDATE', 'PAYMENT', 'PROMOTION', 'SYSTEM', 'SUPPORT'] },
      isRead: { type: 'boolean' },
      data: { type: 'object', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  DriverDocument: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      type: { type: 'string', enum: ['LICENSE', 'RC', 'INSURANCE', 'PUC', 'PAN_CARD', 'AADHAAR_CARD', 'PROFILE_PHOTO'] },
      url: { type: 'string' },
      name: { type: 'string' },
      verificationStatus: { type: 'string', enum: ['pending', 'verified', 'rejected'] },
      isVerified: { type: 'boolean' },
      rejectionReason: { type: 'string', nullable: true },
      uploadedAt: { type: 'string', format: 'date-time' },
      verifiedAt: { type: 'string', format: 'date-time', nullable: true },
    },
  },
  PayoutAccount: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      accountType: { type: 'string', enum: ['BANK_ACCOUNT', 'UPI'] },
      bankName: { type: 'string', nullable: true },
      accountNumber: { type: 'string', nullable: true },
      ifscCode: { type: 'string', nullable: true },
      accountHolderName: { type: 'string', nullable: true },
      upiId: { type: 'string', nullable: true },
      isPrimary: { type: 'boolean' },
      isVerified: { type: 'boolean' },
    },
  },
  WalletBalance: {
    type: 'object',
    properties: {
      available: { type: 'number' },
      pending: { type: 'number' },
      hold: { type: 'number' },
      effective: { type: 'number' },
    },
  },
};

export function createSwaggerSpec(config: SwaggerConfig): object {
  const options: swaggerJsdoc.Options = {
    definition: {
      openapi: '3.0.0',
      info: {
        title: config.title,
        version: config.version,
        description: config.description,
        contact: {
          name: 'Raahi Support',
          email: 'support@raahi.com',
        },
      },
      servers: [
        {
          url: `http://localhost:${config.port}`,
          description: 'Development server',
        },
        {
          url: 'https://api.raahi.com',
          description: 'Production server',
        },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'Enter your JWT token',
          },
        },
        schemas: commonSchemas,
      },
      tags: [],
    },
    apis: config.apis,
  };

  return swaggerJsdoc(options);
}

export function setupSwagger(app: Express, config: SwaggerConfig): void {
  const swaggerSpec = createSwaggerSpec(config);

  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: `${config.title} - Swagger UI`,
  }));

  app.get('/api-docs.json', (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpec);
  });
}

export { swaggerUi, swaggerJsdoc };
