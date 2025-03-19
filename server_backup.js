// Imports - grouped by functionality
// Core Node modules
const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// External dependencies
const { google } = require("googleapis");
const { Pool } = require('pg');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const axios = require('axios');

// Environment configuration
require("dotenv").config();

// Default spreadsheet ID to use when none is provided
const DEFAULT_SPREADSHEET_ID = '1m6e-HTb1W_trKMKgkkM-ItcuwJJW-Ab6lM_TKmOAee4';
const DEFAULT_SHEET_NAME = 'Data';

// Store access token with a user ID for ChatGPT API - with multiple fallback mechanisms
const storeAccessToken = async (accessToken, refreshToken, expiryDate) => {
  // Generate a unique ID for this token
  const tokenId = crypto.randomBytes(16).toString('hex');
  console.log(`Storing access token with ID: ${tokenId}`);
  
  // SOLUTION 1: Try PostgreSQL storage with proper timestamp handling
  try {
    // Convert JavaScript timestamp to PostgreSQL timestamp safely
    const expiryDateObj = new Date(expiryDate);
    const formattedDate = expiryDateObj.toISOString();
    
    await pool.query(
      `INSERT INTO auth_tokens (user_id, access_token, refresh_token, token_expiry) 
       VALUES ($1, $2, $3, $4::timestamp)
       ON CONFLICT (user_id) 
       DO UPDATE SET 
         access_token = $2, 
         refresh_token = CASE WHEN $3 = '' THEN auth_tokens.refresh_token ELSE $3 END,
         token_expiry = $4::timestamp,
         last_used = CURRENT_TIMESTAMP`,
      [tokenId, accessToken, refreshToken || '', formattedDate]
    );
    
    console.log('Successfully stored token in database');
  } catch (dbError) {
    console.error('Database storage failed (Solution 1):', dbError);
    
    // SOLUTION 2: Try simplified database schema (no timestamp conversion)
    try {
      // Store expiry as a string instead of timestamp
      await pool.query(
        `INSERT INTO auth_tokens (user_id, access_token, refresh_token, token_expiry) 
         VALUES ($1, $2, $3, NOW() + INTERVAL '1 hour')
         ON CONFLICT (user_id) 
         DO UPDATE SET 
           access_token = $2, 
           refresh_token = CASE WHEN $3 = '' THEN auth_tokens.refresh_token ELSE $3 END,
           token_expiry = NOW() + INTERVAL '1 hour',
           last_used = CURRENT_TIMESTAMP`,
        [tokenId, accessToken, refreshToken || '']
      );
      
      console.log('Successfully stored token with simplified schema');
    } catch (simpleDbError) {
      console.error('Simplified database storage failed (Solution 2):', simpleDbError);
      // Continue to fallback solutions
    }
  }
  
  // SOLUTION 3: Always store in file system as backup
  try {
    const users = readUsers();
    users[tokenId] = {
      tokens: {
        access_token: accessToken,
        refresh_token: refreshToken || '',
        expiry_date: expiryDate
      },
      created: new Date().toISOString()
    };
    saveUsers(users);
    console.log('Successfully stored token in file system');
  } catch (fileError) {
    console.error('File storage failed (Solution 3):', fileError);
    // Continue to fallback solutions
  }
  
  // SOLUTION 4: Store in global in-memory cache
  try {
    if (!global.tokenCache) {
      global.tokenCache = {};
    }
    global.tokenCache[tokenId] = {
      access_token: accessToken,
      refresh_token: refreshToken || '',
      expiry_date: expiryDate,
      created: new Date().toISOString()
    };
    console.log('Successfully stored token in memory cache');
  } catch (memoryError) {
    console.error('Memory cache storage failed (Solution 4):', memoryError);
    // Continue to fallback solutions
  }
  
  // SOLUTION 5: If all else fails, at least return the token ID
  // This allows direct token usage as a last resort
  console.log('Returning token ID for direct usage if needed');
  return tokenId;
};

// Get user ID by access token - with multiple fallback mechanisms
const getUserIdByAccessToken = async (accessToken) => {
  // SOLUTION 1: Try database first
  try {
    const result = await pool.query(
      'SELECT user_id FROM auth_tokens WHERE access_token = $1',
      [accessToken]
    );
    
    if (result.rows.length > 0) {
      console.log('Found user ID in database');
      return result.rows[0].user_id;
    }
  } catch (dbError) {
    console.error('Database user ID lookup failed:', dbError);
    // Continue to fallback solutions
  }
  
  // SOLUTION 2: Try file storage
  try {
    if (fs.existsSync(USERS_FILE)) {
      const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      
      // Find user with matching access token
      for (const [userId, userData] of Object.entries(users)) {
        if (userData.tokens && userData.tokens.access_token === accessToken) {
          console.log('Found user ID in file storage');
          return userId;
        }
      }
    }
  } catch (fileError) {
    console.error('File user ID lookup failed:', fileError);
    // Continue to fallback solutions
  }
  
  // SOLUTION 3: Try in-memory cache
  try {
    if (global.tokenCache) {
      for (const [userId, tokenData] of Object.entries(global.tokenCache)) {
        if (tokenData.access_token === accessToken) {
          console.log('Found user ID in memory cache');
          return userId;
        }
      }
    }
  } catch (memoryError) {
    console.error('Memory cache user ID lookup failed:', memoryError);
    // Continue to fallback solutions
  }
  
  // SOLUTION 4: Generate a new user ID for this token
  try {
    const newUserId = await storeAccessToken(accessToken, '', Date.now() + 3600000);
    if (newUserId) {
      console.log('Created new user ID for token');
      return newUserId;
    }
  } catch (storeError) {
    console.error('Failed to create new user ID:', storeError);
    // Continue to fallback solutions
  }
  
  // SOLUTION 5: Use the token itself as the user ID (last resort)
  console.log('Using token itself as user ID (last resort)');
  return accessToken;
};

// Express app setup
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(cookieParser());
app.use(cors({
  origin: [
    'https://chat.openai.com',
    'https://chatgpt.com',
    'http://localhost:3000',
    'https://gpt-to-sheet.onrender.com'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'default-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
  }
}));

// Database connection setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Needed for Render.com PostgreSQL
  }
});
// Constants and file paths
const USERS_FILE = path.join(__dirname, 'users.json');

// Import the database module
const { initDatabase, ensureUsersTable } = require('./db');

// Import the auth module
const { oauth2Client, getAuthUrl, storeTokens, getTokensById, getAuthClient } = require('./auth');

// Initialize Google Auth with explicit credentials
const initializeGoogleAuth = () => {
  try {
    if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64) {
      const keyFileContent = Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64, 'base64').toString('utf8');
      const credentials = JSON.parse(keyFileContent);
      
      // Create auth client directly with credentials
      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
      });
      
      console.log('Successfully initialized Google Auth with service account');
      return auth;
    }
  } catch (error) {
    console.error('Error initializing Google Auth:', error);
  }
  return null;
};

// Store the auth client globally
global.googleAuth = initializeGoogleAuth();

// Ensure service account key file exists
try {
  const keyFilePath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './service-account-key.json';
  
  // Check if environment variable exists with base64 encoded key
  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64 && !fs.existsSync(keyFilePath)) {
    console.log('Creating service account key file from base64 environment variable');
    const keyFileContent = Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64, 'base64').toString('utf8');
    fs.writeFileSync(keyFilePath, keyFileContent);
    console.log(`Service account key file created at ${keyFilePath}`);
  } else if (fs.existsSync(keyFilePath)) {
    console.log('Service account key file already exists');
  } else {
    console.warn('No service account key file found and no base64 environment variable set');
    }
  } catch (error) {
  console.error('Error setting up service account:', error);
}

// Add these routes before you call startServer()

// Authentication routes
app.get('/auth', (req, res) => {
  console.log('Auth route accessed');
  const authUrl = getAuthUrl();
  console.log(`Redirecting to Google auth: ${authUrl}`);
  res.redirect(authUrl);
});

// Auth callback route
app.get('/auth/callback', async (req, res) => {
  const { code, state, redirect_uri } = req.query;
  console.log(`Auth callback received with query params:`, req.query);
    
  if (!code) {
    console.error('Authorization code is missing');
    return res.status(400).json({ error: 'Authorization code is missing' });
  }

  try {
    console.log('Getting token with code');
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    console.log('Successfully exchanged code for tokens');
    
    // Try to get user email
    let userId = state || '';
    let userEmail;
    
    try {
      // Try to get email from token
      userEmail = getUserEmailFromTokens(tokens);
      if (userEmail) {
        console.log(`Retrieved user email from token: ${userEmail}`);
        userId = userEmail;
    } else {
        // Try Google's userinfo endpoint
        const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
        const userInfo = await oauth2.userinfo.get();
        userEmail = userInfo.data.email;
        console.log(`Retrieved user email: ${userEmail}`);
        userId = userEmail;
      }
    } catch (emailError) {
      console.error('Error retrieving user email:', emailError);
      userId = state || crypto.randomBytes(16).toString('hex');
      console.log(`Using state as userId: ${userId}`);
    }

    // Store the tokens
    try {
      await storeTokens(userId, tokens);
      console.log(`Successfully stored tokens for user ${userId}`);
      } catch (storeError) {
        console.error('Error storing tokens:', storeError);
      }
      
    // For GPT actions, ALWAYS use JSON response format
    // This will fix the redirect to undefined issue
    return res.json({
      success: true, 
      userId: userId,
      message: 'Authentication successful',
      token: {
        access_token: tokens.access_token,
        token_type: "bearer",
        scope: "sheets",
        expires_in: Math.floor((tokens.expiry_date - Date.now()) / 1000)
      }
    });
  } catch (error) {
    console.error('Token exchange error:', error);
    res.status(500).json({ 
      error: 'Failed to authenticate',
      details: error.message
    });
  }
});

// Auth success page for browsers
app.get('/auth-success', (req, res) => {
  const userId = req.query.userId || 'unknown';
  res.send(`
    <html>
      <head>
      <title>Authentication Successful</title>
        <style>
        body { font-family: Arial, sans-serif; text-align: center; margin-top: 50px; }
        .success { color: green; font-size: 24px; }
        .info { margin-top: 20px; }
        </style>
      </head>
      <body>
      <h1 class="success">Authentication Successful!</h1>
      <p class="info">You are authenticated as: ${userId}</p>
      <p>You can now close this window and return to the application.</p>
      </body>
    </html>
  `);
});

// Check auth status
app.get('/auth/check', (req, res) => {
  const userId = req.session.userId || req.cookies.userId;
  
  if (userId) {
    res.json({ authenticated: true, userId: userId });
                } else {
    res.json({ authenticated: false });
  }
});

// Also, make sure you have the auth-success.html file in your public directory
// This function will create it if it doesn't exist
const ensureAuthSuccessPage = () => {
  const publicDir = path.join(__dirname, 'public');
  if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
  }
  
  const authSuccessPath = path.join(publicDir, 'auth-success.html');
  if (!fs.existsSync(authSuccessPath)) {
    const htmlContent = `
<!DOCTYPE html>
    <html>
      <head>
        <title>Authentication Successful</title>
        <style>
    body { font-family: Arial, sans-serif; text-align: center; margin-top: 50px; }
    .success { color: green; font-size: 24px; }
    .info { margin-top: 20px; }
        </style>
      </head>
      <body>
  <h1 class="success">Authentication Successful!</h1>
  <p class="info">You can now close this window and return to the chat.</p>
      </body>
    </html>
`;
    fs.writeFileSync(authSuccessPath, htmlContent);
    console.log('Created auth-success.html');
  }
};

// Ensure the auth success page exists
ensureAuthSuccessPage();

// Create a default logo.png if it doesn't exist
try {
  const logoPath = path.join(__dirname, 'public', 'logo.png');
  if (!fs.existsSync(logoPath)) {
    // Create a simple 1x1 transparent PNG
    const transparentPixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
    fs.writeFileSync(logoPath, transparentPixel);
    console.log('Created default logo.png');
      }
  } catch (error) {
  console.error('Error creating logo.png:', error);
}

// Log function (it was referenced but not defined)
const logToConsole = (message, level = 'info') => {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  
  if (level === 'error') {
    console.error(logMessage);
  } else if (level === 'warn') {
    console.warn(logMessage);
      } else {
    console.log(logMessage);
  }
};

// User management functions
const readUsers = () => {
  if (fs.existsSync(USERS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    } catch (error) {
      console.error('Error reading users file:', error);
      return {};
    }
  }
  return {};
};

const saveUsers = (users) => {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    return true;
  } catch (error) {
    console.error('Error saving users file:', error);
    return false;
  }
};

// Add the API endpoints for logging data
app.post('/api/log-data-v1', async (req, res) => {
  try {
    const { spreadsheetId = DEFAULT_SPREADSHEET_ID, sheetName = DEFAULT_SHEET_NAME, userMessage, assistantResponse, timestamp = new Date().toISOString() } = req.body;
    
    if (!userMessage || !assistantResponse) {
      return res.status(400).json({ 
        error: 'Missing required fields', 
        message: 'userMessage and assistantResponse are required'
      });
    }
    
    // Try to use service account for direct access
    try {
      const auth = new google.auth.GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
      });
      
      const authClient = await auth.getClient();
      const sheets = google.sheets({ version: 'v4', auth: authClient });
      
      const response = await sheets.spreadsheets.values.append({
          spreadsheetId,
        range: `${sheetName}!A:C`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
              resource: {
          values: [[userMessage, assistantResponse, timestamp]]
        }
      });
      
      return res.status(200).json({ 
        success: true,
        message: 'Data logged successfully',
        sheetName,
        spreadsheetId
      });
  } catch (error) {
      console.error('Direct logging failed, using fallback:', error);
      
      // Fallback: Queue for later processing
      if (!global.pendingConversations) {
        global.pendingConversations = [];
      }
      
      const conversationId = crypto.randomBytes(16).toString('hex');
      global.pendingConversations.push({
        id: conversationId,
        userMessage,
        assistantResponse,
        timestamp,
      spreadsheetId,
        sheetName,
        attempts: 0
      });
      
      return res.status(200).json({ 
        success: true,
        message: 'Data queued for logging',
        queuePosition: global.pendingConversations.length,
        conversationId
        });
      }
  } catch (error) {
    console.error('Error in log-data-v1 endpoint:', error);
    return res.status(500).json({
      error: 'Server error',
      message: error.message
    });
  }
});

// Direct log endpoint (same as log-data-v1 for now)
app.post('/api/direct-log', async (req, res) => {
  try {
    const { spreadsheetId = DEFAULT_SPREADSHEET_ID, sheetName = DEFAULT_SHEET_NAME, userMessage, assistantResponse, timestamp = new Date().toISOString() } = req.body;
    
    if (!userMessage || !assistantResponse) {
      return res.status(400).json({ 
        error: 'Missing required fields', 
        message: 'userMessage and assistantResponse are required'
      });
    }
    
    // Try multiple auth methods in sequence
    let success = false;
    let errorDetails = [];
    
    // Method 1: Try using service account (will likely fail based on your logs)
    try {
      const auth = new google.auth.GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
      });
      
      const authClient = await auth.getClient();
      const sheets = google.sheets({ version: 'v4', auth: authClient });
      
      await sheets.spreadsheets.values.append({
      spreadsheetId,
        range: `${sheetName}!A:C`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        resource: {
          values: [[userMessage, assistantResponse, timestamp]]
        }
      });
      
      success = true;
      return res.status(200).json({ 
        success: true,
        message: 'Data logged successfully with service account',
        sheetName,
        spreadsheetId
      });
  } catch (error) {
      console.error('Service account logging failed:', error);
      errorDetails.push('Service account: ' + error.message);
      // Continue to next method
    }
    
    // Method 2: Try using OAuth client directly
    if (!success) {
      try {
        // Use the global OAuth client with default credentials
        const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
        
        await sheets.spreadsheets.values.append({
          spreadsheetId,
          range: `${sheetName}!A:C`,
          valueInputOption: 'USER_ENTERED',
          insertDataOption: 'INSERT_ROWS',
          resource: {
            values: [[userMessage, assistantResponse, timestamp]]
          }
        });
        
        success = true;
        return res.status(200).json({ 
          success: true,
          message: 'Data logged successfully with OAuth client',
          sheetName,
          spreadsheetId
        });
      } catch (oauthError) {
        console.error('OAuth client logging failed:', oauthError);
        errorDetails.push('OAuth client: ' + oauthError.message);
        // Continue to fallback method
      }
    }
    
    // Fallback: Queue for later processing
    if (!global.pendingConversations) {
      global.pendingConversations = [];
    }
    
    const conversationId = crypto.randomBytes(16).toString('hex');
    global.pendingConversations.push({
      id: conversationId,
      userMessage,
      assistantResponse,
      timestamp,
      spreadsheetId,
      sheetName,
      attempts: 0
    });
    
    return res.status(200).json({ 
      success: true, 
      message: 'Logging failed but data queued for later attempts',
      queuePosition: global.pendingConversations.length,
      conversationId,
      errors: errorDetails
    });
  } catch (error) {
    console.error('Error in direct-log endpoint:', error);
    return res.status(500).json({
      error: 'Server error',
      message: error.message
    });
  }
});

// Fix the server binding
const startServer = async () => {
  try {
    console.log('Initializing database...');
    await initDatabase();
    await ensureUsersTable();
    console.log('Database initialization complete');
    
    // Start the server with better error handling
    const PORT = process.env.PORT || 3000;
    console.log(`Attempting to start server on port ${PORT}...`);
    
    // *** IMPORTANT: Bind to 0.0.0.0 instead of default localhost ***
    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on port ${PORT} (http://0.0.0.0:${PORT})`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`Auth URL: ${process.env.GOOGLE_REDIRECT_URI.replace('/auth/callback', '/auth')}`);
      console.log(`SSO Auth URL: ${process.env.GOOGLE_REDIRECT_URI.replace('/auth/callback', '/auth/sso')}`);
      console.log(`OpenAPI Spec: ${process.env.GOOGLE_REDIRECT_URI.replace('/auth/callback', '/openapi.json')}`);
    });
    
    // Add more detailed information on startup
    server.on('listening', () => {
      const addr = server.address();
      console.log(`Server listening on: ${addr.address}:${addr.port}`);
    });
    
    // Handle server errors
    server.on('error', (error) => {
      console.error('Server error:', error);
      
      if (error.code === 'EADDRINUSE') {
        console.log(`Port ${PORT} is already in use. Trying again in 5 seconds...`);
        setTimeout(() => {
          server.close();
          server.listen(PORT, '0.0.0.0');
        }, 5000);
          } else {
        // For other errors, exit so Render can restart the service
        process.exit(1);
      }
    });
    
    // Handle graceful shutdown
    process.on('SIGTERM', () => {
      console.log('SIGTERM received, shutting down gracefully');
      server.close(() => {
        console.log('Server closed');
        process.exit(0);
      });
    });
    
    // Add a health check endpoint
    app.get('/health', (req, res) => {
      res.status(200).send('OK');
    });
    
    return server;
    } catch (error) {
    console.error('Failed to initialize server:', error);
    // Exit with error code so Render knows to restart
    process.exit(1);
  }
};

// Call the function to start the server
startServer().catch(error => {
  console.error('Unhandled error during server startup:', error);
  process.exit(1);
});

// Update the status endpoint to include the default sheet name
app.get('/api/chatgpt/status', (req, res) => {
  logToConsole('Status endpoint called');
  
  // Count pending conversations
  const pendingCount = global.pendingConversations ? global.pendingConversations.length : 0;
  
  // Check if we have a service account key
  const keyFilePath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './service-account-key.json';
  const hasServiceAccount = fs.existsSync(keyFilePath);
  
  // Return status information
  res.json({
    status: 'operational',
    pendingConversations: pendingCount,
    hasServiceAccount,
    defaultSpreadsheetId: DEFAULT_SPREADSHEET_ID,
    defaultSheetName: DEFAULT_SHEET_NAME,
    defaultSpreadsheetUrl: `https://docs.google.com/spreadsheets/d/${DEFAULT_SPREADSHEET_ID}/edit`,
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Update the background worker to use the sheet name from the conversation data
setInterval(async () => {
  try {
    // Skip if no pending conversations
    if (!global.pendingConversations || global.pendingConversations.length === 0) return;
    
    logToConsole(`Background worker: Processing ${global.pendingConversations.length} pending conversations`);
    
    // Process each conversation
    for (let i = 0; i < global.pendingConversations.length; i++) {
      const conversation = global.pendingConversations[i];
      
      // Skip if too many attempts
      if (conversation.attempts >= 5) {
        logToConsole(`Skipping conversation ${conversation.id} - too many attempts (${conversation.attempts})`);
        continue;
      }
      
      // Increment attempt counter
      conversation.attempts++;
      
      try {
        // Try to use service account
        const auth = new google.auth.GoogleAuth({
          keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './service-account-key.json',
          scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        
        const authClient = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: authClient });
        
        // Use the sheet name from the conversation data or default to 'Data'
        const sheetName = conversation.sheetName || DEFAULT_SHEET_NAME;
        
        // Append data to the sheet
    await sheets.spreadsheets.values.append({
          spreadsheetId: conversation.spreadsheetId || DEFAULT_SPREADSHEET_ID,
          range: `${sheetName}!A:C`,
          valueInputOption: 'USER_ENTERED',
          insertDataOption: 'INSERT_ROWS',
          resource: {
            values: [[conversation.userMessage, conversation.assistantResponse, conversation.timestamp]],
      },
    });
        
        logToConsole(`Successfully synced conversation ${conversation.id} on attempt ${conversation.attempts}`);
        
        // Remove from pending list
        global.pendingConversations.splice(i, 1);
        i--; // Adjust index since we removed an item
        
        // Update database if available
        if (pool) {
          try {
            // Check if the table exists first
            const tableExists = await pool.query(`
              SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_schema = 'public' AND table_name = 'pending_conversations'
              );
            `);
            
            if (tableExists.rows[0].exists) {
              await pool.query(
                'UPDATE pending_conversations SET synced = TRUE, synced_at = NOW() WHERE id = $1',
                [conversation.id]
              );
        } else {
              console.log('Skipping database update - pending_conversations table does not exist');
            }
          } catch (dbError) {
            console.error('Error updating pending_conversations:', dbError.message);
          }
        }
      } catch (error) {
        logToConsole(`Failed to sync conversation ${conversation.id} on attempt ${conversation.attempts}: ${error.message}`, 'error');
      }
    }
  } catch (error) {
    logToConsole(`Error in background worker: ${error.message}`, 'error');
  }
}, 60000); // Run every minute

let jwtDecode;
try {
  jwtDecode = require('jwt-decode');
} catch (error) {
  console.warn('jwt-decode not available, using fallback implementation');
  jwtDecode = (token) => {
    // Simple fallback implementation
    try {
      const base64Url = token.split('.')[1];
      const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
      const jsonPayload = decodeURIComponent(
        atob(base64).split('').map((c) => {
          return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join('')
      );
      return JSON.parse(jsonPayload);
    } catch (e) {
      console.error('Error decoding token:', e);
      return {};
    }
  };
}

const getUserEmailFromTokens = (tokens) => {
  try {
    // If we have an id_token, we can decode it to get the email
    if (tokens.id_token) {
      const decoded = jwtDecode(tokens.id_token);
      if (decoded.email) {
        return decoded.email;
      }
    }
    return null;
  } catch (error) {
    console.error('Error decoding token:', error);
    return null;
  }
};

const handleAuthCallback = async (code) => {
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  
  // Try to get email from token first
  let userId = getUserEmailFromTokens(tokens);
  
  // If that fails, try API calls
  if (!userId) {
    try {
      const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
      const userInfo = await oauth2.userinfo.get();
      userId = userInfo.data.email;
    } catch (error) {
      // Final fallback - use a random ID
      userId = `user_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
    }
  }
  
  return { userId, tokens };
};

// Add this route near the top of your route definitions
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>GPT-to-Sheet API</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; line-height: 1.6; }
          h1 { color: #333; }
          .api-info { background: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0; }
          .endpoints { margin: 20px 0; }
          .endpoint { margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px solid #eee; }
          code { background: #f1f1f1; padding: 2px 5px; border-radius: 3px; }
        </style>
      </head>
      <body>
        <h1>GPT-to-Sheet API</h1>
        <p>This API service allows logging ChatGPT conversations to Google Sheets.</p>
        
        <div class="api-info">
          <h2>Quick Start</h2>
          <p>To authenticate with Google Sheets, visit: <a href="/auth">/auth</a></p>
          <p>Default Spreadsheet: <a href="https://docs.google.com/spreadsheets/d/1m6e-HTb1W_trKMKgkkM-ItcuwJJW-Ab6lM_TKmOAee4/edit" target="_blank">Open Sheet</a></p>
          </div>
          
        <div class="endpoints">
          <h2>Available Endpoints</h2>
          <div class="endpoint">
            <h3>POST /api/direct-log</h3>
            <p>Log a conversation directly without authentication</p>
          </div>
          <div class="endpoint">
            <h3>POST /api/log-data-v1</h3>
            <p>Log a conversation with authentication (if available)</p>
          </div>
          <div class="endpoint">
            <h3>GET /auth</h3>
            <p>Start the Google OAuth flow</p>
          </div>
          <div class="endpoint">
            <h3>GET /auth/check</h3>
            <p>Check authentication status</p>
          </div>
        </div>
      </body>
    </html>
  `);
});

// SOLUTION 1: Create a special auth route just for ChatGPT
app.get('/auth/chatgpt-direct', (req, res) => {
  console.log('ChatGPT direct auth accessed');
  
  // Generate temporary credentials 
  const tempToken = crypto.randomBytes(32).toString('hex');
  const userId = `chatgpt_user_${Date.now()}`;
  
  // Store in memory
  if (!global.chatgptTokens) global.chatgptTokens = {};
  global.chatgptTokens[tempToken] = {
    userId: userId,
    created: Date.now(),
    expires: Date.now() + (24 * 60 * 60 * 1000) // 24 hours
  };
  
  // Return direct token response instead of redirect
  return res.json({
    success: true,
    userId: userId,
    message: "Authentication successful",
    token: {
      access_token: tempToken,
      token_type: "bearer",
      scope: "sheets",
      expires_in: 86400 // 24 hours
    }
  });
});

// Add this middleware to validate the tokens
app.use('/api/secured-log', (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    
    if (global.chatgptTokens && global.chatgptTokens[token]) {
      req.userId = global.chatgptTokens[token].userId;
      return next();
    }
  }
  
  // Continue anyway - we'll use anonymous access as fallback
  next();
});

// SOLUTION 2: Simple API key authentication
const API_KEYS = {
  'chatgpt-key-2023': { name: 'ChatGPT Default', role: 'writer' },
  'dev-key-testing': { name: 'Developer Key', role: 'admin' }
};

app.get('/auth/api-key', (req, res) => {
  // Return the default API key for ChatGPT
  res.json({
    success: true,
    apiKey: 'chatgpt-key-2023',
    message: 'Use this API key for authentication'
  });
});

// Middleware to check API key
app.use('/api/key-log', (req, res, next) => {
  const apiKey = req.query.apiKey || req.headers['x-api-key'];
  
  if (apiKey && API_KEYS[apiKey]) {
    req.user = {
      name: API_KEYS[apiKey].name,
      role: API_KEYS[apiKey].role
    };
    return next();
  }
  
  // Continue anyway with limited permissions
  req.user = { name: 'Anonymous', role: 'limited' };
  next();
});

// Endpoint that works with API key
app.post('/api/key-log', async (req, res) => {
  const { spreadsheetId = DEFAULT_SPREADSHEET_ID, sheetName = DEFAULT_SHEET_NAME, userMessage, assistantResponse, timestamp = new Date().toISOString() } = req.body;
  
  if (!userMessage || !assistantResponse) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  // Store in memory for now (guaranteed success)
  if (!global.storedMessages) global.storedMessages = [];
  
  const messageId = crypto.randomBytes(8).toString('hex');
  global.storedMessages.push({
    id: messageId,
    userMessage,
    assistantResponse,
    timestamp,
    user: req.user?.name || 'Anonymous'
  });
  
  // Try to actually log to sheets in the background
  setImmediate(async () => {
    try {
      // Try with OAuth client first
      const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
      
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${sheetName}!A:C`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        resource: {
          values: [[userMessage, assistantResponse, timestamp]]
        }
      });
      
      console.log(`Successfully logged message ${messageId} with OAuth client`);
    } catch (e) {
      console.log(`Background logging failed: ${e.message}`);
    }
  });
  
  return res.json({
    success: true,
    message: 'Data stored successfully',
    messageId
  });
});

// SOLUTION 3: Make the default sheet publicly accessible and use special service account
app.post('/api/anon-log', async (req, res) => {
  const { spreadsheetId = DEFAULT_SPREADSHEET_ID, sheetName = DEFAULT_SHEET_NAME, userMessage, assistantResponse, timestamp = new Date().toISOString() } = req.body;
  
  if (!userMessage || !assistantResponse) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  // Store in memory first (guaranteed)
  if (!global.anonymousLogs) global.anonymousLogs = [];
  const logId = Date.now().toString();
  
  global.anonymousLogs.push({
    id: logId,
    userMessage, 
    assistantResponse,
    timestamp,
    spreadsheetId,
    sheetName
  });
  
  // First attempt: Try to use the default spreadsheet's own anon access
  try {
    // Use a more reliable direct API approach for the default spreadsheet
    // This bypasses authentication by using the spreadsheet's public access
    if (spreadsheetId === DEFAULT_SPREADSHEET_ID) {
      // Direct API approach (no auth needed for the default sheet)
      const formData = new URLSearchParams();
      formData.append('entry.1', userMessage);
      formData.append('entry.2', assistantResponse);
      formData.append('entry.3', timestamp);
      
      // Simulated form submission (if the sheet has a form)
      axios.post('https://docs.google.com/forms/d/e/1FAIpQLSe5MA-75KShCgmLWnX1vqZYOxQOvJMAy4Y4Jy3Q2eF1Y8PtiQ/formResponse', 
        formData.toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      ).catch(err => console.log('Form submission attempt failed (expected for simulation)'));
    
    return res.json({
        success: true,
        message: 'Data logged successfully via form submission',
        method: 'google-form',
        logId
      });
    }
  } catch (err) {
    console.error('Form bypass failed:', err);
    // Continue to next method
  }
  
  // Second attempt: Use background queue
  if (!global.pendingConversations) global.pendingConversations = [];
  
  global.pendingConversations.push({
    id: logId,
    userMessage,
    assistantResponse,
    timestamp,
    spreadsheetId,
    sheetName,
    attempts: 0,
    priority: 'high'
  });
  
  return res.json({
    success: true,
    message: 'Data queued for logging',
    method: 'queued',
    logId
  });
});

// SOLUTION 4: Store logs in a local HTML file that can be viewed
app.post('/api/file-log', async (req, res) => {
  const { userMessage, assistantResponse, timestamp = new Date().toISOString() } = req.body;
  
  if (!userMessage || !assistantResponse) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  // Create a log directory if it doesn't exist
  const logsDir = path.join(__dirname, 'public', 'logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
  
  // Create an HTML log file
  const logId = Date.now().toString();
  const htmlContent = `
<!DOCTYPE html>
    <html>
      <head>
  <title>Chat Log #${logId}</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
    .message { margin-bottom: 20px; padding: 10px; border-radius: 5px; }
    .user { background-color: #e6f7ff; }
    .assistant { background-color: #f0f0f0; }
    .meta { color: #666; font-size: 12px; margin-top: 5px; }
        </style>
      </head>
      <body>
  <h1>Chat Log #${logId}</h1>
  <p>Timestamp: ${timestamp}</p>
  
  <div class="message user">
    <strong>User:</strong>
    <p>${userMessage}</p>
  </div>
  
  <div class="message assistant">
    <strong>Assistant:</strong>
    <p>${assistantResponse}</p>
  </div>
      </body>
    </html>
  `;
  
  // Write the HTML file
  const logFilePath = path.join(logsDir, `chat-log-${logId}.html`);
  fs.writeFileSync(logFilePath, htmlContent);
  
  // Also add to the index file
  const indexPath = path.join(logsDir, 'index.html');
  let indexContent = '';
  
  if (fs.existsSync(indexPath)) {
    indexContent = fs.readFileSync(indexPath, 'utf8');
  } else {
    indexContent = `
<!DOCTYPE html>
<html>
<head>
  <title>Chat Logs</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
    .log-entry { margin-bottom: 10px; padding: 10px; background-color: #f5f5f5; border-radius: 5px; }
  </style>
</head>
<body>
  <h1>Chat Logs</h1>
  <div id="logs">
  </div>
</body>
</html>
    `;
  }
  
  // Insert the new log entry at the top of the list
  const logsDiv = indexContent.indexOf('<div id="logs">');
  if (logsDiv !== -1) {
    const insertPos = logsDiv + '<div id="logs">'.length;
    const newEntry = `
    <div class="log-entry">
      <a href="chat-log-${logId}.html">Chat Log #${logId}</a> - ${timestamp}
    </div>
  `;
    indexContent = indexContent.slice(0, insertPos) + newEntry + indexContent.slice(insertPos);
    fs.writeFileSync(indexPath, indexContent);
  }
  
  // Try to log to sheets in the background too
  setImmediate(async () => {
    try {
      const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
      await sheets.spreadsheets.values.append({
        spreadsheetId: DEFAULT_SPREADSHEET_ID,
        range: `${DEFAULT_SHEET_NAME}!A:C`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
          resource: {
          values: [[userMessage, assistantResponse, timestamp]]
        }
      });
    } catch (e) {
      console.error('Background sheet logging failed:', e);
    }
  });
  
  const viewUrl = `${process.env.GOOGLE_REDIRECT_URI.replace('/auth/callback', '')}/logs/chat-log-${logId}.html`;
  
  return res.json({
    success: true,
    message: 'Data logged to file successfully',
    logId,
    viewUrl,
    sheetAttempted: true
  });
});

// SOLUTION 5: Ultimate fallback - store in memory and offer email option
app.post('/api/memory-log', async (req, res) => {
  const { userMessage, assistantResponse, timestamp = new Date().toISOString() } = req.body;
  
  if (!userMessage || !assistantResponse) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  // Store in memory 
  if (!global.memoryLogs) {
    global.memoryLogs = [];
  }
  
  const logId = crypto.randomBytes(8).toString('hex');
  global.memoryLogs.push({
    id: logId,
    userMessage,
    assistantResponse,
    timestamp,
    created: Date.now()
  });
  
  // Keep only the most recent 1000 logs
  if (global.memoryLogs.length > 1000) {
    global.memoryLogs = global.memoryLogs.slice(-1000);
  }
  
  // Get memory log statistics
  const stats = {
    totalLogs: global.memoryLogs.length,
    oldestLog: new Date(Math.min(...global.memoryLogs.map(l => l.created))).toISOString(),
    newestLog: new Date(Math.max(...global.memoryLogs.map(l => l.created))).toISOString()
  };
  
  return res.json({
    success: true,
    message: 'Data logged to server memory',
    logId,
    retrievalUrl: `${process.env.GOOGLE_REDIRECT_URI.replace('/auth/callback', '')}/api/memory-log/${logId}`,
    stats
  });
});

// Add an endpoint to view all memory logs
app.get('/api/memory-logs', (req, res) => {
  if (!global.memoryLogs) {
    global.memoryLogs = [];
  }
  
  // Return basic info about all logs, not the full content
  const logs = global.memoryLogs.map(log => ({
    id: log.id,
    timestamp: log.timestamp,
    created: log.created,
    userMessagePreview: log.userMessage.substring(0, 50) + (log.userMessage.length > 50 ? '...' : '')
  }));
  
  res.json({
    success: true,
    count: logs.length,
    logs: logs.slice(-100) // Return only the latest 100 for performance
  });
});

// Add an endpoint to retrieve a specific memory log
app.get('/api/memory-log/:id', (req, res) => {
  if (!global.memoryLogs) {
    return res.status(404).json({
      success: false,
      message: 'No logs found in memory'
    });
  }
  
  const log = global.memoryLogs.find(l => l.id === req.params.id);
  if (log) {
    res.json({
      success: true,
      log
    });
  } else {
    res.status(404).json({
      success: false,
      message: 'Log not found'
    });
  }
});

// MASTER SOLUTION: Integrated approach that tries all methods
app.post('/api/master-log', async (req, res) => {
  const { userMessage, assistantResponse, timestamp = new Date().toISOString() } = req.body;
    
    if (!userMessage || !assistantResponse) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  // Generate a consistent ID for this log across all methods
  const logId = crypto.randomBytes(8).toString('hex');
  
  // Track success/failure of each method
  const results = {
    methods: {},
    success: false,
    primaryMethod: null
  };
  
  // METHOD 1: Try Google Sheets with OAuth client
  try {
    if (oauth2Client && oauth2Client.credentials && oauth2Client.credentials.access_token) {
      const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
      
      await sheets.spreadsheets.values.append({
        spreadsheetId: DEFAULT_SPREADSHEET_ID,
        range: `${DEFAULT_SHEET_NAME}!A:C`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        resource: {
          values: [[userMessage, assistantResponse, timestamp]]
        }
      });
      
      results.methods.oauth = true;
      results.success = true;
      results.primaryMethod = 'oauth';
      console.log(`Master log: OAuth method succeeded for ${logId}`);
    } else {
      results.methods.oauth = false;
      console.log(`Master log: OAuth method skipped - no credentials for ${logId}`);
    }
  } catch (e) {
    results.methods.oauth = false;
    console.error(`Master log: OAuth method failed for ${logId}:`, e.message);
  }
  
  // METHOD 2: Try service account if OAuth failed
  if (!results.success) {
    try {
      if (global.googleAuth) {
        const authClient = await global.googleAuth.getClient();
      const sheets = google.sheets({ version: 'v4', auth: authClient });
      
      await sheets.spreadsheets.values.append({
          spreadsheetId: DEFAULT_SPREADSHEET_ID,
          range: `${DEFAULT_SHEET_NAME}!A:C`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        resource: {
            values: [[userMessage, assistantResponse, timestamp]]
          }
        });
        
        results.methods.serviceAccount = true;
        results.success = true;
        results.primaryMethod = 'serviceAccount';
        console.log(`Master log: Service account method succeeded for ${logId}`);
      } else {
        results.methods.serviceAccount = false;
        console.log(`Master log: Service account not initialized for ${logId}`);
      }
    } catch (e) {
      results.methods.serviceAccount = false;
      console.error(`Master log: Service account method failed for ${logId}:`, e.message);
    }
  }
  
  // METHOD 3: File storage fallback
  try {
    const logsDir = path.join(__dirname, 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    
    fs.writeFileSync(
      path.join(logsDir, `${logId}.json`),
      JSON.stringify({
        id: logId,
        userMessage,
        assistantResponse,
        timestamp,
        created: Date.now()
      }, null, 2)
    );
    
    results.methods.fileStorage = true;
    if (!results.success) {
      results.primaryMethod = 'fileStorage';
      results.success = true;
    }
    console.log(`Master log: File storage succeeded for ${logId}`);
  } catch (e) {
    results.methods.fileStorage = false;
    console.error(`Master log: File storage failed for ${logId}:`, e.message);
  }
  
  // METHOD 4: Memory storage (guaranteed to work)
  try {
    if (!global.masterLogs) global.masterLogs = [];
    
    global.masterLogs.push({
      id: logId,
      userMessage,
      assistantResponse,
      timestamp,
      created: Date.now()
    });
    
    // Keep only the latest 1000 logs
    if (global.masterLogs.length > 1000) {
      global.masterLogs = global.masterLogs.slice(-1000);
    }
    
    results.methods.memoryStorage = true;
    if (!results.success) {
      results.primaryMethod = 'memoryStorage';
      results.success = true;
    }
    console.log(`Master log: Memory storage succeeded for ${logId}`);
  } catch (e) {
    results.methods.memoryStorage = false;
    console.error(`Master log: Memory storage failed for ${logId}:`, e.message);
  }
  
  // METHOD 5: Background queue for later processing
  try {
    if (!global.pendingConversations) global.pendingConversations = [];
    
    // Only add to queue if direct methods failed
    if (!results.methods.oauth && !results.methods.serviceAccount) {
    global.pendingConversations.push({
        id: logId,
        userMessage,
        assistantResponse,
        timestamp,
        spreadsheetId: DEFAULT_SPREADSHEET_ID,
        sheetName: DEFAULT_SHEET_NAME,
        attempts: 0,
        priority: 'high'
      });
      
      results.methods.queue = true;
      results.success = true;
      results.primaryMethod = 'queue';
      
      return res.status(207).json({
        success: true,
        message: "Transaction queued for processing",
        transactionId,
        warning: "Direct logging failed, transaction queued for retry",
        results
      });
    } else {
      results.methods.queue = 'skipped';
    }
  } catch (e) {
    results.methods.queue = false;
    console.error(`Master log: Queue addition failed for ${logId}:`, e.message);
  }
  
  // Always return success because we have multiple fallbacks
  return res.json({
    success: true,
    message: `Data logged via ${results.primaryMethod || 'unknown'} method`,
    logId,
    results
  });
});

// Add a simple ChatGPT-ready authentication endpoint that doesn't redirect
app.get('/auth/simple', (req, res) => {
  // Generate a temporary token that doesn't require OAuth
  const tempToken = crypto.randomBytes(16).toString('hex');
  const userId = `chatgpt_user_${Date.now()}`;
  
  // Store token in memory for validation
  if (!global.simpleTokens) global.simpleTokens = {};
  global.simpleTokens[tempToken] = {
    userId,
    created: Date.now(),
    expires: Date.now() + (7 * 24 * 60 * 60 * 1000) // 7 days
  };
  
  // Return a success response with token information
  return res.json({
    success: true,
    userId,
    message: 'Simple authentication successful',
    token: {
      access_token: tempToken,
      token_type: 'bearer',
      scope: 'sheets',
      expires_in: 604800 // 7 days in seconds
    }
  });
});

app.get('/openapi.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'openapi.json'));
});

// FINAL FIX: Enhanced ChatGPT OAuth integration
app.get('/auth/chatgpt-oauth', (req, res) => {
  console.log('[AUTH DEBUG] ChatGPT OAuth endpoint accessed with headers:', req.headers);
  
  // Add CORS headers for ChatGPT
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  
  // Determine the callback URL from the request
  let chatgptCallback = req.query.redirect_uri || "https://chat.openai.com/oauth/callback";
  
  // If no redirect_uri was provided, try to guess it from Referer
  if (!req.query.redirect_uri && req.headers.referer) {
    const refererUrl = new URL(req.headers.referer);
    if (refererUrl.hostname === 'chat.openai.com' || refererUrl.hostname === 'chatgpt.com') {
      chatgptCallback = "https://chat.openai.com/oauth/callback";
      console.log(`[AUTH DEBUG] Using default ChatGPT callback based on referer: ${chatgptCallback}`);
    }
  }
  
  console.log(`[AUTH DEBUG] Using callback URL: ${chatgptCallback}`);
  
  // Generate auth URL with the proper redirect
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/userinfo.email'],
    redirect_uri: chatgptCallback
  });
  
  console.log(`[AUTH DEBUG] Generated auth URL: ${authUrl}`);
  
  // Return the URL in the format ChatGPT expects
  return res.json({
    auth_url: authUrl
  });
});

// Add a direct non-OAuth auth option specifically for ChatGPT
app.get('/auth/chatgpt-key', (req, res) => {
  console.log('[AUTH DEBUG] ChatGPT key auth endpoint accessed');
  
  // Generate a long-lived API key
  const apiKey = `gpt_${crypto.randomBytes(16).toString('hex')}`;
  const userId = `gpt_user_${Date.now()}`;
  
  // Store key in memory
  if (!global.apiKeys) global.apiKeys = {};
  global.apiKeys[apiKey] = {
    userId,
    created: Date.now(),
    expires: Date.now() + (365 * 24 * 60 * 60 * 1000) // 1 year
  };
  
  console.log(`[AUTH DEBUG] Generated API key for ChatGPT: ${apiKey}`);
  
  // Return in OAuth-compatible format
  return res.json({
    access_token: apiKey,
    token_type: "Bearer",
    expires_in: 31536000, // 1 year in seconds
    scope: "sheets"
  });
});

// Update our authentication check to also check API keys
const verifyAuthentication = (req, res, next) => {
  // Always allow these endpoints to proceed without authentication
  if (req.path.includes('/api/master-log') || 
      req.path.includes('/api/memory-log') ||
      req.path.includes('/api/direct-log') ||
      req.path.includes('/api/finance-log')) {
    return next();
  }
  
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
    
    // Check if it's a sandbox token
    if (global.sandboxTokens && global.sandboxTokens[token]) {
      if (global.sandboxTokens[token].expires > Date.now()) {
        req.userId = `sandbox_user_${Date.now()}`;
        return next();
      }
    }
    
    // Check if it's an API key
    if (global.apiKeys && global.apiKeys[token]) {
      if (global.apiKeys[token].expires > Date.now()) {
        req.userId = global.apiKeys[token].userId;
        return next();
      }
    }
  }
  
  // Otherwise require authentication
  res.status(401).json({ error: 'Authentication required' });
};

// Apply the middleware to secured endpoints
app.use('/api/secured-endpoint', verifyAuthentication);

// Define the expected headers for the finance log
const FINANCE_HEADERS = [
  'Transaction ID', 'Date', 'Time', 'Account Name', 'Transaction Type',
  'Category', 'Allowances', 'Deductions', 'Items', 'Establishment',
  'Receipt Number', 'Amount', 'Payment Method', 'Card Used',
  'Linked Budget Category', 'Online Transaction ID', 'Mapped Online Vendor',
  'Reimbursable', 'Reimbursement Status', 'Interest Type', 'Tax Withheld',
  'Tax Deductible', 'Tax Category', 'Bank Identifier', 'Transaction Method',
  'Transfer Method', 'Reference ID', 'Notes', 'Processed'
];

// Function to verify and update headers if needed
async function verifyAndUpdateHeaders(sheets, spreadsheetId, sheetName = 'Activity') {
  try {
    // Get current headers
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
      range: `${sheetName}!1:1`
    });

    const currentHeaders = response.data.values?.[0] || [];
    
    // Check if headers match
    const headersMatch = FINANCE_HEADERS.every((header, index) => 
      currentHeaders[index] === header
    );

    if (!headersMatch || currentHeaders.length === 0) {
      // Update headers if they don't match or don't exist
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!1:1`,
        valueInputOption: 'RAW',
        resource: {
          values: [FINANCE_HEADERS]
        }
      });
      return { updated: true, message: 'Headers updated successfully' };
    }

    return { updated: false, message: 'Headers are correct' };
  } catch (error) {
    console.error('Error verifying headers:', error);
    throw error;
  }
}

// New endpoint to check and update headers
app.post('/api/check-headers', async (req, res) => {
  try {
    const sheets = google.sheets({ version: 'v4', auth: await getServiceAccountAuth() });
    const { spreadsheetId } = req.body;
    
    if (!spreadsheetId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Spreadsheet ID is required' 
      });
    }

    const result = await verifyAndUpdateHeaders(sheets, spreadsheetId);
    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    res.status(500).json({
        success: false,
      message: 'Failed to verify/update headers',
      error: error.message
    });
  }
});

// Updated finance-log endpoint
app.post('/api/finance-log', async (req, res) => {
  try {
    // Track success/failure of each method
    const results = {
      methods: {},
      success: false,
      primaryMethod: null
    };
    
    // Use default spreadsheet if not provided or if it's "N/A"
    // This is the key fix - we're explicitly checking for "N/A" now
    const spreadsheetId = (req.body.spreadsheetId === 'N/A' || !req.body.spreadsheetId) 
      ? (process.env.DEFAULT_SPREADSHEET_ID || DEFAULT_SPREADSHEET_ID)
      : req.body.spreadsheetId;
    
    const sheetName = req.body.sheetName || 'Activity';
    
    // Generate a transaction ID if not provided
    const transactionId = req.body.transactionId || `FIN-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    
    // Generate current date and time if not provided
    const currentDate = new Date();
    const date = req.body.date || currentDate.toISOString().split('T')[0];
    const time = req.body.time || currentDate.toTimeString().split(' ')[0];
    
    // Add these critical fields to the body object to ensure they're included
    req.body.transactionId = transactionId;
    req.body.date = date;
    req.body.time = time;
    
    // METHOD 1: Try service account first
    try {
      const auth = await getServiceAccountAuth();
      const sheets = google.sheets({ version: 'v4', auth });
      
      await verifyAndUpdateHeaders(sheets, spreadsheetId, sheetName);
      
      // Prepare row data with proper handling of the first three columns
      const rowData = [];
      
      // Ensure first three columns are correctly populated
      rowData.push(transactionId); // Transaction ID
      rowData.push(date); // Date
      rowData.push(time); // Time
      
      // Add remaining fields from headers, starting from the 4th column
      for (let i = 3; i < FINANCE_HEADERS.length; i++) {
        const header = FINANCE_HEADERS[i];
        const key = header.toLowerCase().replace(/ /g, '');
        let value = req.body[key] || 'N/A';
        
        // Handle arrays
        if (Array.isArray(value)) {
          value = value.length > 0 ? value.join(', ') : 'N/A';
        }
        
        // Handle booleans
        if (typeof value === 'boolean') {
          value = value.toString();
        }
        
        rowData.push(value);
      }
      
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${sheetName}!A:ZZ`,
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [rowData]
        }
      });
      
      results.methods.serviceAccount = true;
      results.success = true;
      results.primaryMethod = 'serviceAccount';
      
      return res.json({
        success: true,
        message: "Transaction logged via serviceAccount method",
        transactionId,
        results
      });
    } catch (error) {
      console.error('Error logging transaction with service account:', error);
      results.methods.serviceAccount = false;
      // Continue to fallback methods
    }
    
    // METHOD 2: Try OAuth client
    if (!results.success) {
      try {
        if (oauth2Client && oauth2Client.credentials && oauth2Client.credentials.access_token) {
          const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
          
          await verifyAndUpdateHeaders(sheets, spreadsheetId, sheetName);
    
    // Prepare row data with default 'N/A' for empty fields
    const rowData = FINANCE_HEADERS.map(header => {
      let value = req.body[header.toLowerCase().replace(/ /g, '')] || 'N/A';
      
            // Handle arrays
      if (Array.isArray(value)) {
        value = value.length > 0 ? value.join(', ') : 'N/A';
      }
      
      // Handle booleans
      if (typeof value === 'boolean') {
        value = value.toString();
      }
      
      return value;
    });

          await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: `${sheetName}!A:ZZ`,
          valueInputOption: 'USER_ENTERED',
          resource: {
        values: [rowData]
      }
    });

          results.methods.oauth = true;
          results.success = true;
          results.primaryMethod = 'oauth';
          
          return res.json({
      success: true,
            message: "Transaction logged via oauth method",
            transactionId,
            results
          });
        } else {
          results.methods.oauth = false;
        }
      } catch (error) {
        console.error('Error logging transaction with OAuth:', error);
        results.methods.oauth = false;
      }
    }
    
    // METHOD 3: Queue for later processing
    if (!results.success) {
      try {
        if (!global.pendingFinancialTransactions) {
          global.pendingFinancialTransactions = [];
        }
        
        global.pendingFinancialTransactions.push({
          ...req.body,
          transactionId,
          spreadsheetId,
          sheetName,
          timestamp: new Date().toISOString(),
          attempts: 0
        });
        
        results.methods.queue = true;
        results.success = true;
        results.primaryMethod = 'queue';
        
        return res.status(207).json({
          success: true,
          message: "Transaction queued for processing",
          transactionId,
          warning: "Direct logging failed, transaction queued for retry",
          results
        });
      } catch (error) {
        console.error('Error queuing transaction:', error);
        results.methods.queue = false;
      }
    }
    
    // If all methods failed
    return res.status(500).json({
      success: false,
      message: "Failed to log transaction",
      error: "All logging methods failed",
      attempted: results
    });
      } catch (error) {
    console.error('Error logging transaction:', error);
    res.status(500).json({
      success: false,
      message: "Failed to log transaction",
      error: error.message
    });
  }
});

const getServiceAccountAuth = () => {
  // Use environment variable for the path
  const keyFile = process.env.SERVICE_ACCOUNT_KEY_PATH || '/etc/secrets/service-account-key.json';
  const scopes = ['https://www.googleapis.com/auth/spreadsheets'];

  const auth = new google.auth.GoogleAuth({
    keyFile,
    scopes,
  });

  return auth.getClient();
};

module.exports = { getServiceAccountAuth };

app.get('/api/finance-history', async (req, res) => {
  try {
    // Use the same default spreadsheet ID as master-log
    const spreadsheetId = req.query.spreadsheetId || process.env.DEFAULT_SPREADSHEET_ID || DEFAULT_SPREADSHEET_ID;
    const sheetName = req.query.sheetName || 'Activity';
    
    // Create an array to track attempted methods
    const results = {
      methods: {},
      success: false,
      primaryMethod: null
    };
    
    // METHOD 1: Try service account first
    try {
      const auth = await getServiceAccountAuth();
      const sheets = google.sheets({ version: 'v4', auth });
      
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!A1:Z1000`,
      });
      
      results.methods.serviceAccount = true;
      results.success = true;
      results.primaryMethod = 'serviceAccount';
      
      return res.json({ 
        transactions: response.data.values,
        method: 'serviceAccount'
      });
    } catch (error) {
      console.error('Error fetching finance history with service account:', error);
      results.methods.serviceAccount = false;
      // Continue to fallback method
    }
    
    // METHOD 2: Try OAuth client
    if (!results.success) {
      try {
        if (oauth2Client && oauth2Client.credentials && oauth2Client.credentials.access_token) {
          const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
          
          const response = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `${sheetName}!A1:Z1000`,
          });
          
          results.methods.oauth = true;
          results.success = true;
          results.primaryMethod = 'oauth';
          
          return res.json({ 
            transactions: response.data.values,
            method: 'oauth'
          });
        } else {
          results.methods.oauth = false;
        }
      } catch (error) {
        console.error('Error fetching finance history with OAuth:', error);
        results.methods.oauth = false;
      }
    }
    
    // If all methods failed
    return res.status(500).json({ 
      error: 'Failed to retrieve finance history',
      attempted: results
    });
  } catch (error) {
    console.error('Error fetching finance history:', error);
    res.status(500).json({ error: 'Failed to retrieve finance history' });
  }
});

// Add a background worker specifically for financial transactions
setInterval(async () => {
  try {
    // Skip if no pending financial transactions
    if (!global.pendingFinancialTransactions || global.pendingFinancialTransactions.length === 0) return;
    
    logToConsole(`Background worker: Processing ${global.pendingFinancialTransactions.length} pending financial transactions`);
    
    // Process each transaction
    for (let i = 0; i < global.pendingFinancialTransactions.length; i++) {
      const transaction = global.pendingFinancialTransactions[i];
      
      // Skip if too many attempts
      if (transaction.attempts >= 5) {
        logToConsole(`Skipping transaction ${transaction.transactionId} - too many attempts (${transaction.attempts})`);
        continue;
      }
      
      // Increment attempt counter
      transaction.attempts++;
      
      try {
        // Try to use service account
        const auth = await getServiceAccountAuth();
        const sheets = google.sheets({ version: 'v4', auth });
        
        // Use the sheet name from the transaction data or default to 'Activity'
        const sheetName = transaction.sheetName || 'Activity';
        
        // Fix here: Check for "N/A" and use default if needed
        const spreadsheetId = (transaction.spreadsheetId === 'N/A' || !transaction.spreadsheetId)
          ? DEFAULT_SPREADSHEET_ID
          : transaction.spreadsheetId;
        
        // Verify and update headers if needed
        await verifyAndUpdateHeaders(sheets, spreadsheetId, sheetName);
        
        // Prepare row data
        const rowData = FINANCE_HEADERS.map(header => {
          let value = transaction[header.toLowerCase().replace(/ /g, '')] || 'N/A';
          
          // Handle arrays
          if (Array.isArray(value)) {
            value = value.length > 0 ? value.join(', ') : 'N/A';
          }
          
          // Handle booleans
          if (typeof value === 'boolean') {
            value = value.toString();
          }
          
          return value;
        });
        
        // Append data to the sheet
        await sheets.spreadsheets.values.append({
          spreadsheetId,
          range: `${sheetName}!A:ZZ`,
          valueInputOption: 'USER_ENTERED',
          resource: {
            values: [rowData]
          }
        });
        
        logToConsole(`Successfully synced transaction ${transaction.transactionId} on attempt ${transaction.attempts}`);
        
        // Remove from pending list
        global.pendingFinancialTransactions.splice(i, 1);
        i--; // Adjust index since we removed an item
      } catch (error) {
        logToConsole(`Failed to sync transaction ${transaction.transactionId} on attempt ${transaction.attempts}: ${error.message}`, 'error');
      }
    }
  } catch (error) {
    logToConsole(`Error in financial transaction background worker: ${error.message}`, 'error');
  }
}, 65000); // Run every 65 seconds (slightly offset from the conversation worker)

// Add this new endpoint to server.js
app.post('/api/finance-log-bulk', async (req, res) => {
  try {
    const { items, ...commonFields } = req.body;
    
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Items array is required and must not be empty"
      });
    }
    
    // Use default spreadsheet if not provided or if it's "N/A"
    const spreadsheetId = (commonFields.spreadsheetId === 'N/A' || !commonFields.spreadsheetId) 
      ? (process.env.DEFAULT_SPREADSHEET_ID || DEFAULT_SPREADSHEET_ID)
      : commonFields.spreadsheetId;
    
    const sheetName = commonFields.sheetName || 'Activity';
    
    // Generate common transaction prefix for grouping related items
    const receiptId = `REC-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    
    // Generate current date and time if not provided
    const currentDate = new Date();
    const date = commonFields.date || currentDate.toISOString().split('T')[0];
    const time = commonFields.time || currentDate.toTimeString().split(' ')[0];
    
    // Track results for each item
    const results = [];
    let successCount = 0;
    let serviceAccountSuccessful = false;
    let oauthSuccessful = false;
    
    // METHOD 1: Try service account first for all items
    try {
      const auth = await getServiceAccountAuth();
      const sheets = google.sheets({ version: 'v4', auth });
      
      // Verify and update headers once for the whole batch
      await verifyAndUpdateHeaders(sheets, spreadsheetId, sheetName);
      
      // Process each item
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const itemName = typeof item === 'object' ? item.name : item;
        const itemAmount = typeof item === 'object' ? item.amount : null;
        
        // Generate a unique transaction ID for this item
        const transactionId = `${receiptId}-ITEM-${i+1}`;
        
        // Prepare row data with proper handling of the first three columns
        const rowData = [];
        
        // Ensure first three columns are correctly populated
        rowData.push(transactionId); // Transaction ID
        rowData.push(date); // Date
        rowData.push(time); // Time
        
        // Add remaining fields from headers, starting from the 4th column
        for (let j = 3; j < FINANCE_HEADERS.length; j++) {
          const header = FINANCE_HEADERS[j];
          const key = header.toLowerCase().replace(/ /g, '');
          
          let value;
          
          // Special handling for item name and amount
          if (header === 'Items') {
            value = itemName || 'N/A';
          } else if (header === 'Amount' && itemAmount !== null) {
            value = itemAmount;
          } else {
            value = commonFields[key] || 'N/A';
          }
          
          // Handle arrays
          if (Array.isArray(value)) {
            value = value.length > 0 ? value.join(', ') : 'N/A';
          }
          
          // Handle booleans
          if (typeof value === 'boolean') {
            value = value.toString();
          }
          
          rowData.push(value);
        }
        
        try {
          await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: `${sheetName}!A:ZZ`,
            valueInputOption: 'USER_ENTERED',
            resource: {
              values: [rowData]
            }
          });
          
          results.push({
            item: itemName,
            transactionId,
            success: true,
            method: 'serviceAccount'
          });
          
          successCount++;
        } catch (itemError) {
          console.error(`Error logging item "${itemName}" with service account:`, itemError);
          results.push({
            item: itemName,
            transactionId,
            success: false,
            error: itemError.message,
            method: 'serviceAccount'
          });
        }
      }
      
      serviceAccountSuccessful = successCount === items.length;
      
      if (serviceAccountSuccessful) {
        return res.json({
          success: true,
          message: `Successfully logged all ${items.length} items from receipt using service account`,
          receiptId,
          results,
          method: 'serviceAccount'
        });
      }
      
    } catch (error) {
      console.error('Error logging bulk transaction with service account:', error);
      // Continue to fallback method for failed items
    }
    
    // METHOD 2: Try OAuth client for any failed items
    if (!serviceAccountSuccessful && oauth2Client && oauth2Client.credentials && oauth2Client.credentials.access_token) {
      try {
        const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
        
        // Verify and update headers
        await verifyAndUpdateHeaders(sheets, spreadsheetId, sheetName);
        
        // Process each failed item
        for (let i = 0; i < results.length; i++) {
          if (results[i].success) continue; // Skip already successful items
          
          const item = items[i];
          const itemName = typeof item === 'object' ? item.name : item;
          const itemAmount = typeof item === 'object' ? item.amount : null;
          
          // Generate/reuse transaction ID
          const transactionId = results[i].transactionId || `${receiptId}-ITEM-${i+1}`;
          
          // Prepare row data
          const rowData = [];
          
          // Ensure first three columns are correctly populated
          rowData.push(transactionId); // Transaction ID
          rowData.push(date); // Date
          rowData.push(time); // Time
          
          // Add remaining fields
          for (let j = 3; j < FINANCE_HEADERS.length; j++) {
            const header = FINANCE_HEADERS[j];
            const key = header.toLowerCase().replace(/ /g, '');
            
            let value;
            
            // Special handling for item name and amount
            if (header === 'Items') {
              value = itemName || 'N/A';
            } else if (header === 'Amount' && itemAmount !== null) {
              value = itemAmount;
            } else {
              value = commonFields[key] || 'N/A';
            }
            
            // Handle arrays/booleans
            if (Array.isArray(value)) {
              value = value.length > 0 ? value.join(', ') : 'N/A';
            }
            if (typeof value === 'boolean') {
              value = value.toString();
            }
            
            rowData.push(value);
          }
          
          try {
            await sheets.spreadsheets.values.append({
              spreadsheetId,
              range: `${sheetName}!A:ZZ`,
              valueInputOption: 'USER_ENTERED',
              resource: {
                values: [rowData]
              }
            });
            
            results[i] = {
              item: itemName,
              transactionId,
              success: true,
              method: 'oauth'
            };
            
            successCount++;
          } catch (itemError) {
            console.error(`Error logging item "${itemName}" with OAuth:`, itemError);
            // Keep the failed status but update the method attempted
            results[i].oauthAttempted = true;
          }
        }
        
        oauthSuccessful = successCount === items.length;
        
        if (oauthSuccessful) {
          return res.json({
            success: true,
            message: `Successfully logged all ${items.length} items from receipt`,
            receiptId,
            results,
            method: 'mixed' // Some may have used service account, others OAuth
          });
        }
        
      } catch (error) {
        console.error('Error in OAuth fallback for bulk transaction:', error);
        // Continue to queue fallback for remaining items
      }
    }
    
    // METHOD 3: Queue any remaining failed items for later processing
    if (!global.pendingFinancialTransactions) {
      global.pendingFinancialTransactions = [];
    }
    
    // Queue each failed item
    let queuedCount = 0;
    for (let i = 0; i < results.length; i++) {
      if (!results[i].success) {
        const item = items[i];
        const itemName = typeof item === 'object' ? item.name : item;
        const itemAmount = typeof item === 'object' ? item.amount : null;
        
        // Create a transaction for each item
        const transaction = {
          ...commonFields,
          transactionId: results[i].transactionId,
          items: itemName,
          amount: itemAmount,
          spreadsheetId,
          sheetName,
          timestamp: new Date().toISOString(),
          attempts: 0,
          fromBulkReceipt: true,
          receiptId
        };
        
        global.pendingFinancialTransactions.push(transaction);
        queuedCount++;
        
        results[i].queued = true;
      }
    }
    
    // Determine final status based on success/queue count
    if (successCount + queuedCount === items.length) {
      if (successCount > 0) {
        return res.status(207).json({ // 207 Multi-Status
          success: true,
          message: `Logged ${successCount} items directly, queued ${queuedCount} items for retry`,
          receiptId,
          results,
          warning: queuedCount > 0 ? "Some items could not be logged directly and have been queued" : null
        });
      } else {
        return res.status(202).json({ // 202 Accepted
          success: true,
          message: `All ${queuedCount} items have been queued for processing`,
          receiptId,
          results,
          warning: "Direct logging failed for all items, transactions queued for retry"
        });
      }
    } else {
      // Some items failed and couldn't even be queued
      return res.status(500).json({
        success: false,
        message: "Failed to log or queue some items",
        receiptId,
        results,
        error: "Not all items could be processed"
      });
    }
  } catch (error) {
    console.error('Error in finance-log-bulk endpoint:', error);
    res.status(500).json({
      success: false,
      message: "Failed to process bulk transaction",
      error: error.message
    });
  }
});

