import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import dotenv from 'dotenv';
import webhookRoutes from './routes/webhookRoutes.js';
import healthRoutes from './routes/healthRoutes.js';
import metricsRoutes from './routes/metricsRoutes.js';
import { logger } from './utils/logger.js';
import { generalRateLimiter } from './middleware/rateLimiting.js';

dotenv.config();

const app = express();

// Trust proxy if configured (for rate limiting and IP detection)
if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
  logger.info('Trust proxy enabled');
}

// Security headers via Helmet
app.use(helmet({
  // Disable some headers not needed for API-only service
  contentSecurityPolicy: false, // Not needed for API
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: false
}));

// CORS configuration
const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps, Postman, curl)
    if (!origin) {
      return callback(null, true);
    }
    
    // Get allowed origins from environment (comma-separated list)
    const allowedOrigins = process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
      : [];
    
    // If no origins configured, deny browser CORS (backend-to-backend only)
    if (allowedOrigins.length === 0) {
      return callback(new Error('CORS not configured'), false);
    }
    
    // Check if origin is allowed
    if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'), false);
    }
  },
  credentials: false, // Don't allow credentials with wildcard origin
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'X-API-Key']
};

// Apply CORS (will be rejected if ALLOWED_ORIGINS not configured)
app.use(cors(corsOptions));

// Body parsers with size limits
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// Apply general rate limiting to all routes (except health)
app.use(generalRateLimiter);

// Legacy health endpoint (kept for backward compatibility)
// No authentication or rate limiting for basic health check
app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Webhook Dispatcher API is running'
  });
});

// Health check endpoints (liveness and readiness)
// No authentication for Kubernetes/monitoring probes
app.use('/health', healthRoutes);

// Prometheus metrics endpoint
// Note: Metrics should be restricted by network/firewall in production
app.use('/metrics', metricsRoutes);

// API routes (protected by authentication and rate limiting)
app.use('/api/webhooks', webhookRoutes);

// 404 handler
app.use((req, res) => {
  logger.warn({
    method: req.method,
    path: req.path
  }, 'Route not found');
  
  res.status(404).json({
    success: false,
    message: 'Route not found'
  });
});

// Global error handler
app.use((err, req, res, next) => {
  // Handle CORS errors
  if (err.message && err.message.includes('CORS')) {
    logger.warn({
      origin: req.headers.origin,
      method: req.method,
      path: req.path
    }, 'CORS policy violation');
    
    return res.status(403).json({
      success: false,
      error: 'CORS policy violation',
      details: 'Origin not allowed'
    });
  }
  
  // Handle JSON parsing errors
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    logger.warn({
      error: 'Malformed JSON',
      method: req.method,
      path: req.path
    }, 'JSON parsing error');
    
    return res.status(400).json({
      success: false,
      error: 'Malformed JSON',
      details: 'Request body contains invalid JSON'
    });
  }
  
  // Handle payload too large
  if (err.type === 'entity.too.large') {
    logger.warn({
      error: 'Payload too large',
      method: req.method,
      path: req.path
    }, 'Payload size exceeded');
    
    return res.status(413).json({
      success: false,
      error: 'Payload too large',
      details: 'Request body exceeds maximum size limit'
    });
  }

  // Log internal errors (sanitized - no stack trace in production)
  logger.error({
    error: err.message,
    method: req.method,
    path: req.path,
    // Only include stack in development
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  }, 'Internal server error');
  
  // Generic error response (no implementation details)
  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    success: false,
    error: process.env.NODE_ENV === 'production' 
      ? 'Internal server error' 
      : err.message,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  });
});

export default app;
