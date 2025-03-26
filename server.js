// Imports - grouped by functionality
// Core Node modules
const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// External dependencies
const { google } = require("googleapis");
const cors = require('cors');
const axios = require('axios');

// Environment configuration
require("dotenv").config();

// Define calendar constants
const DEFAULT_CALENDAR_ID = '865d9be49c7fe3679063400a3796fcb5d38560d6c907e9bbbf77802bc646a4ac@group.calendar.google.com';
const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events'
];

// Express app setup
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(cors({
  origin: [
    'https://chat.openai.com',
    'https://chatgpt.com',
    'http://localhost:3000'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Initialize Google Auth with explicit credentials
const initializeGoogleAuth = () => {
  try {
    if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64) {
      const keyFileContent = Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64, 'base64').toString('utf8');
      const credentials = JSON.parse(keyFileContent);
      
      // Create auth client directly with credentials
      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/calendar']
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

// Log function
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

// Consolidated service account authentication
const getServiceAccountAuth = () => {
  try {
    const keyFilePath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || path.join(__dirname, 'service-account-key.json');
    
    // Read the key file directly and parse it
    let credentials;
    try {
      const keyFileContent = fs.readFileSync(keyFilePath, 'utf8');
      credentials = JSON.parse(keyFileContent);
      console.log('Successfully loaded credentials from file');
    } catch (readError) {
      console.error('Error reading key file:', readError);
      throw new Error('Could not read service account key file');
    }
    
    // Create auth client directly with credentials
    const auth = new google.auth.JWT(
      credentials.client_email || credentials.web?.client_email,
      null,
      credentials.private_key || credentials.web?.private_key,
      CALENDAR_SCOPES
    );
    
    return auth;
  } catch (error) {
    console.error('Error initializing service account auth:', error);
    throw error;
  }
};

// Initialize calendar API client
const getCalendarClient = () => {
  const auth = getServiceAccountAuth();
  return google.calendar({ version: 'v3', auth });
};

// Create a calendar event
app.post('/api/create-event', async (req, res) => {
  try {
    const { 
      calendarId = DEFAULT_CALENDAR_ID, 
      summary, 
      description, 
      location,
      startDateTime, 
      endDateTime, 
      attendees = [],
      reminders = { useDefault: true },
      timeZone = 'America/Los_Angeles' // Default to PST
    } = req.body;
    
    if (!summary || !startDateTime || !endDateTime) {
      return res.status(400).json({ 
        error: 'Missing required fields', 
        message: 'summary, startDateTime, and endDateTime are required'
      });
    }
    
    // Validate start and end times
    const startTime = new Date(startDateTime);
    const endTime = new Date(endDateTime);
    
    if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime())) {
      return res.status(400).json({
        error: 'Invalid date format',
        message: 'startDateTime and endDateTime must be valid ISO date strings'
      });
    }
    
    if (endTime < startTime) {
      return res.status(400).json({
        error: 'Invalid time range',
        message: 'endDateTime must be after startDateTime'
      });
    }
    
    // Try to use service account for direct access - with explicit file path
    try {
      const keyFilePath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || path.join(__dirname, 'service-account-key.json');
      console.log(`Using service account key at: ${keyFilePath}`);
      
      // Read the key file directly and parse it
      let credentials;
      try {
        const keyFileContent = fs.readFileSync(keyFilePath, 'utf8');
        credentials = JSON.parse(keyFileContent);
        console.log('Successfully loaded credentials from file');
      } catch (readError) {
        console.error('Error reading key file:', readError);
        throw new Error('Could not read service account key file');
      }
      
      // Create auth client directly with credentials
      const auth = new google.auth.JWT(
        credentials.client_email || credentials.web?.client_email,
        null,
        credentials.private_key || credentials.web?.private_key,
        ['https://www.googleapis.com/auth/calendar']
      );
      
      // Initialize the calendar API with our authenticated client
      const calendar = google.calendar({ version: 'v3', auth });
      
      // Format the event - handle attendees safely
      const event = {
        summary,
        description,
        location,
        start: {
          dateTime: startDateTime,
          timeZone
        },
        end: {
          dateTime: endDateTime,
          timeZone
        },
        reminders
      };
      
      // Only add attendees if there are any (to avoid Domain-Wide Delegation error)
      if (attendees && attendees.length > 0) {
        console.log('Warning: Adding attendees with service account may require Domain-Wide Delegation');
        // Make attendees optional - only include if explicitly requested
        event.attendees = attendees.map(email => ({ email }));
      }
      
      console.log(`Attempting to create event in calendar: ${calendarId}`);
      
      const response = await calendar.events.insert({
        calendarId,
        resource: event
      });
      
      console.log(`Event created successfully: ${response.data.id}`);
      
      return res.status(200).json({ 
        success: true,
        message: 'Event created successfully',
        eventId: response.data.id,
        htmlLink: response.data.htmlLink
      });
    } catch (error) {
      console.error('Direct calendar access failed:', error);
      
      // Fallback: Queue for later processing
      if (!global.pendingEvents) {
        global.pendingEvents = [];
      }
      
      const eventId = crypto.randomBytes(16).toString('hex');
      global.pendingEvents.push({
        id: eventId,
        calendarId,
        summary,
        description,
        location,
        startDateTime,
        endDateTime,
        attendees: [], // Don't include attendees in the queued event to avoid Domain-Wide Delegation error
        reminders,
        timeZone,
        timestamp: new Date().toISOString(),
        attempts: 0
      });
      
      return res.status(200).json({ 
        success: true,
        message: 'Event queued for creation',
        queuePosition: global.pendingEvents.length,
        eventId
      });
    }
  } catch (error) {
    console.error('Error in create-event endpoint:', error);
    return res.status(500).json({
      error: 'Server error',
      message: error.message
    });
  }
});

// Get calendar events
app.get('/api/list-events', async (req, res) => {
  try {
    const { 
      calendarId = DEFAULT_CALENDAR_ID,
      timeMin = new Date().toISOString(),
      timeMax = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 1 week from now
      maxResults = 10
    } = req.query;
    
    // Try to use service account
    try {
      const keyFilePath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || path.join(__dirname, 'service-account-key.json');
      
      // Read the key file directly and parse it
      let credentials;
      try {
        const keyFileContent = fs.readFileSync(keyFilePath, 'utf8');
        credentials = JSON.parse(keyFileContent);
        console.log('Successfully loaded credentials from file');
      } catch (readError) {
        console.error('Error reading key file:', readError);
        throw new Error('Could not read service account key file');
      }
      
      // Create auth client directly with credentials
      const auth = new google.auth.JWT(
        credentials.client_email || credentials.web?.client_email,
        null,
        credentials.private_key || credentials.web?.private_key,
        ['https://www.googleapis.com/auth/calendar']
      );
      
      // Initialize the calendar API with our authenticated client
      const calendar = google.calendar({ version: 'v3', auth });
      
      console.log(`Listing events from calendar: ${calendarId}`);
      
      const response = await calendar.events.list({
        calendarId,
        timeMin,
        timeMax,
        maxResults,
        singleEvents: true,
        orderBy: 'startTime'
      });
      
      return res.status(200).json({ 
        success: true,
        events: response.data.items
      });
    } catch (error) {
      console.error('Calendar list access failed:', error);
      return res.status(500).json({
        error: 'Failed to list events',
        message: error.message
      });
    }
  } catch (error) {
    console.error('Error in list-events endpoint:', error);
    return res.status(500).json({
      error: 'Server error',
      message: error.message
    });
  }
});

// Add a health check endpoint
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Update the status endpoint
app.get('/api/status', (req, res) => {
  logToConsole('Status endpoint called');
  
  // Count pending events
  const pendingCount = global.pendingEvents ? global.pendingEvents.length : 0;
  
  // Check if we have a service account key
  const keyFilePath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './service-account-key.json';
  const hasServiceAccount = fs.existsSync(keyFilePath);
  
  // Return status information
  res.json({
    status: 'operational',
    pendingEvents: pendingCount,
    hasServiceAccount,
    defaultCalendarId: DEFAULT_CALENDAR_ID,
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Delete a calendar event - handle both DELETE and POST methods
app.delete('/api/delete-event', handleDeleteEvent);
app.post('/api/delete-event', handleDeleteEvent);

async function handleDeleteEvent(req, res) {
  try {
    let { 
      calendarId = DEFAULT_CALENDAR_ID,
      eventId 
    } = req.body;
    
    if (!eventId) {
      return res.status(400).json({ 
        error: 'Missing required field', 
        message: 'eventId is required'
      });
    }
    
    // Try to use service account
    try {
      const keyFilePath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || path.join(__dirname, 'service-account-key.json');
      
      // Read the key file directly and parse it
      let credentials;
      try {
        const keyFileContent = fs.readFileSync(keyFilePath, 'utf8');
        credentials = JSON.parse(keyFileContent);
        console.log('Successfully loaded credentials from file');
      } catch (readError) {
        console.error('Error reading key file:', readError);
        throw new Error('Could not read service account key file');
      }
      
      // Create auth client directly with credentials
      const auth = new google.auth.JWT(
        credentials.client_email || credentials.web?.client_email,
        null,
        credentials.private_key || credentials.web?.private_key,
        ['https://www.googleapis.com/auth/calendar']
      );
      
      // Initialize the calendar API with our authenticated client
      const calendar = google.calendar({ version: 'v3', auth });
      
      console.log(`Attempting to delete event ${eventId} from calendar: ${calendarId}`);
      
      // First verify the calendar exists and we have access
      try {
        await calendar.calendars.get({ calendarId });
        console.log(`Verified access to calendar: ${calendarId}`);
      } catch (error) {
        if (error.code === 404) {
          return res.status(404).json({
            error: 'Calendar not found',
            message: 'The specified calendar does not exist or is not accessible.'
          });
        }
        if (error.code === 403) {
          return res.status(403).json({
            error: 'Permission denied',
            message: 'Service account does not have permission to access this calendar.',
            details: error.message
          });
        }
        throw error;
      }
      
      // Try to find the event in the specified calendar
      let eventExists = false;
      try {
        await calendar.events.get({
          calendarId,
          eventId
        });
        console.log(`Found event ${eventId} in calendar ${calendarId}`);
        eventExists = true;
      } catch (error) {
        if (error.code === 404 || error.message.includes('Resource has been deleted')) {
          // Event not found in specified calendar, try to find it in other calendars
          console.log(`Event ${eventId} not found in calendar ${calendarId}, searching other calendars...`);
          
          try {
            // List all calendars we have access to
            const calendarList = await calendar.calendarList.list();
            
            // Search for the event in each calendar
            for (const cal of calendarList.data.items) {
              try {
                await calendar.events.get({
                  calendarId: cal.id,
                  eventId
                });
                console.log(`Found event ${eventId} in calendar ${cal.id}`);
                // Update calendarId to the one where we found the event
                calendarId = cal.id;
                eventExists = true;
                break;
              } catch (e) {
                if (e.code !== 404 && !e.message.includes('Resource has been deleted')) {
                  throw e;
                }
              }
            }
            
            if (!eventExists) {
              return res.status(200).json({
                success: true,
                message: 'Event was already deleted'
              });
            }
          } catch (searchError) {
            if (searchError.message.includes('Resource has been deleted')) {
              return res.status(200).json({
                success: true,
                message: 'Event was already deleted'
              });
            }
            return res.status(404).json({
              error: 'Event not found',
              message: 'The specified event does not exist in any accessible calendar.',
              details: searchError.message
            });
          }
        } else if (error.message.includes('Resource has been deleted')) {
          return res.status(200).json({
            success: true,
            message: 'Event was already deleted'
          });
        } else {
          throw error;
        }
      }
      
      // If we get here and eventExists is false, the event was already deleted
      if (!eventExists) {
        return res.status(200).json({
          success: true,
          message: 'Event was already deleted'
        });
      }
      
      // If we get here, we have access and the event exists
      console.log(`Attempting to delete event ${eventId} from calendar ${calendarId}`);
      
      try {
        await calendar.events.delete({
          calendarId,
          eventId,
          sendUpdates: 'all' // Send updates to all attendees
        });
        
        console.log(`Successfully deleted event ${eventId} from calendar ${calendarId}`);
        
        return res.status(200).json({ 
          success: true,
          message: 'Event deleted successfully'
        });
      } catch (deleteError) {
        if (deleteError.message.includes('Resource has been deleted')) {
          console.log(`Event ${eventId} was already deleted`);
          return res.status(200).json({
            success: true,
            message: 'Event was already deleted'
          });
        }
        throw deleteError;
      }
    } catch (error) {
      console.error('Calendar delete access failed:', error);
      
      if (error.message.includes('Resource has been deleted')) {
        return res.status(200).json({
          success: true,
          message: 'Event was already deleted'
        });
      }
      
      return res.status(500).json({
        error: 'Failed to delete event',
        message: error.message,
        details: error.stack
      });
    }
  } catch (error) {
    console.error('Error in delete-event endpoint:', error);
    return res.status(500).json({
      error: 'Server error',
      message: error.message
    });
  }
}

// Move a calendar event
app.post('/api/move-event', async (req, res) => {
  try {
    const { 
      calendarId = DEFAULT_CALENDAR_ID,
      eventId,
      destinationCalendarId,
      sendUpdates = 'all'
    } = req.body;
    
    if (!eventId || !destinationCalendarId) {
      return res.status(400).json({ 
        error: 'Missing required fields', 
        message: 'eventId and destinationCalendarId are required'
      });
    }

    // Validate destination calendar ID
    if (destinationCalendarId === 'primary') {
      return res.status(400).json({
        error: 'Invalid destination calendar',
        message: 'Service account cannot access primary calendar. Please provide a specific calendar ID.'
      });
    }
    
    const calendar = getCalendarClient();
    
    // First verify access to both calendars
    try {
      // Verify source calendar access
      await calendar.calendars.get({ calendarId });
      
      // Verify destination calendar access
      await calendar.calendars.get({ calendarId: destinationCalendarId });
      
      // Verify event exists and we have access
      await calendar.events.get({
        calendarId,
        eventId
      });
    } catch (error) {
      if (error.code === 404) {
        return res.status(404).json({
          error: 'Resource not found',
          message: 'One or more resources (calendar or event) were not found. Please verify the IDs.',
          details: error.message
        });
      }
      if (error.code === 403) {
        return res.status(403).json({
          error: 'Permission denied',
          message: 'Service account does not have access to one or more resources. Please ensure the service account has the necessary permissions.',
          details: error.message
        });
      }
      throw error;
    }
    
    console.log(`Moving event ${eventId} from calendar ${calendarId} to ${destinationCalendarId}`);
    
    const response = await calendar.events.move({
      calendarId,
      eventId,
      destination: destinationCalendarId,
      sendUpdates
    });
    
    console.log(`Successfully moved event ${eventId} to calendar ${destinationCalendarId}`);
    
    return res.status(200).json({ 
      success: true,
      message: 'Event moved successfully',
      event: response.data
    });
  } catch (error) {
    console.error('Calendar move access failed:', error);
    
    // Provide more specific error messages
    if (error.code === 404) {
      return res.status(404).json({
        error: 'Resource not found',
        message: 'The event was not found. Please verify the event ID.',
        details: error.message
      });
    }
    if (error.code === 403) {
      return res.status(403).json({
        error: 'Permission denied',
        message: 'Service account does not have permission to move this event. Please ensure the service account has access to both calendars.',
        details: error.message
      });
    }
    
    return res.status(500).json({
      error: 'Failed to move event',
      message: error.message,
      details: error.stack
    });
  }
});

// List available calendars
app.get('/api/list-calendars', async (req, res) => {
  try {
    const calendar = getCalendarClient();
    
    console.log('Fetching list of available calendars');
    
    const response = await calendar.calendarList.list();
    
    // Format the response to include only relevant information
    const calendars = response.data.items.map(cal => ({
      id: cal.id,
      summary: cal.summary,
      description: cal.description || '',
      location: cal.location || '',
      timeZone: cal.timeZone,
      accessRole: cal.accessRole,
      backgroundColor: cal.backgroundColor,
      foregroundColor: cal.foregroundColor,
      selected: cal.selected,
      primary: cal.primary || false
    }));
    
    console.log(`Found ${calendars.length} calendars`);
    
    return res.status(200).json({ 
      success: true,
      calendars
    });
  } catch (error) {
    console.error('Calendar list access failed:', error);
    
    // Provide more specific error messages
    if (error.code === 403) {
      return res.status(403).json({
        error: 'Permission denied',
        message: 'Service account does not have permission to list calendars. Please ensure the service account has the necessary permissions.',
        details: error.message
      });
    }
    
    return res.status(500).json({
      error: 'Failed to list calendars',
      message: error.message,
      details: error.stack
    });
  }
});

// Add a home page
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>GPT-to-Calendar API</title>
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
        <h1>GPT-to-Calendar API</h1>
        <p>This API service allows managing Google Calendar events directly from ChatGPT.</p>
        
        <div class="api-info">
          <h2>Quick Start</h2>
          <p>No authentication needed - uses service account directly.</p>
        </div>
          
        <div class="endpoints">
          <h2>Available Endpoints</h2>
          <div class="endpoint">
            <h3>POST /api/create-event</h3>
            <p>Create a new calendar event</p>
          </div>
          <div class="endpoint">
            <h3>GET /api/list-events</h3>
            <p>List upcoming calendar events</p>
          </div>
          <div class="endpoint">
            <h3>DELETE /api/delete-event</h3>
            <p>Delete a calendar event</p>
            <p>Required fields: eventId</p>
          </div>
          <div class="endpoint">
            <h3>POST /api/move-event</h3>
            <p>Move a calendar event to a different calendar</p>
            <p>Required fields: eventId, destinationCalendarId</p>
            <p>Optional: sendUpdates ('all', 'externalOnly', or 'none')</p>
          </div>
          <div class="endpoint">
            <h3>GET /api/status</h3>
            <p>Check service status</p>
          </div>
          <div class="endpoint">
            <h3>GET /api/list-calendars</h3>
            <p>List available calendars</p>
          </div>
        </div>
      </body>
    </html>
  `);
});

// Add a privacy policy page
app.get('/privacy-policy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy-policy.html'));
});

// Background worker to process pending events
setInterval(async () => {
  try {
    // Skip if no pending events
    if (!global.pendingEvents || global.pendingEvents.length === 0) return;
    
    logToConsole(`Background worker: Processing ${global.pendingEvents.length} pending events`);
    
    // Process each event
    for (let i = 0; i < global.pendingEvents.length; i++) {
      const event = global.pendingEvents[i];
      
      // Skip if too many attempts
      if (event.attempts >= 5) {
        logToConsole(`Skipping event ${event.id} - too many attempts (${event.attempts})`);
        continue;
      }
      
      // Increment attempt counter
      event.attempts++;
      
      try {
        // Try to use service account with explicit file path
        const keyFilePath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || path.join(__dirname, 'service-account-key.json');
        
        // Read the key file directly and parse it
        let credentials;
        try {
          const keyFileContent = fs.readFileSync(keyFilePath, 'utf8');
          credentials = JSON.parse(keyFileContent);
          logToConsole('Successfully loaded credentials from file');
        } catch (readError) {
          logToConsole(`Error reading key file: ${readError.message}`, 'error');
          throw new Error('Could not read service account key file');
        }
        
        // Create auth client directly with credentials
        const auth = new google.auth.JWT(
          credentials.client_email || credentials.web?.client_email,
          null,
          credentials.private_key || credentials.web?.private_key,
          ['https://www.googleapis.com/auth/calendar']
        );
        
        // Initialize the calendar API with our authenticated client
        const calendar = google.calendar({ version: 'v3', auth });
        
        // Validate start and end times
        const startTime = new Date(event.startDateTime);
        const endTime = new Date(event.endDateTime);
        
        if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime()) || endTime <= startTime) {
          logToConsole(`Invalid time range for event ${event.id}. Removing from queue.`, 'error');
          global.pendingEvents.splice(i, 1);
          i--;
          continue;
        }
        
        // Format the event - without attendees to avoid Domain-Wide Delegation error
        const calendarEvent = {
          summary: event.summary,
          description: event.description,
          location: event.location,
          start: {
            dateTime: event.startDateTime,
            timeZone: event.timeZone || 'America/Los_Angeles'
          },
          end: {
            dateTime: event.endDateTime,
            timeZone: event.timeZone || 'America/Los_Angeles'
          },
          reminders: event.reminders || { useDefault: true }
        };
        
        logToConsole(`Attempting to create event in calendar: ${event.calendarId || DEFAULT_CALENDAR_ID}`);
        
        await calendar.events.insert({
          calendarId: event.calendarId || DEFAULT_CALENDAR_ID,
          resource: calendarEvent
        });
        
        logToConsole(`Successfully created event ${event.id} on attempt ${event.attempts}`);
        
        // Remove from pending list
        global.pendingEvents.splice(i, 1);
        i--; // Adjust index since we removed an item
      } catch (error) {
        logToConsole(`Failed to create event ${event.id} on attempt ${event.attempts}: ${error.message}`, 'error');
      }
    }
  } catch (error) {
    logToConsole(`Error in background worker: ${error.message}`, 'error');
  }
}, 60000); // Run every minute

// Fix the server binding
const startServer = async () => {
  try {
    // Start the server with better error handling
    const PORT = process.env.PORT || 3000;
    console.log(`Attempting to start server on port ${PORT}...`);
    
    // *** IMPORTANT: Bind to 0.0.0.0 instead of default localhost ***
    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on port ${PORT} (http://0.0.0.0:${PORT})`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
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
        // For other errors, exit so service can restart
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
    
    return server;
  } catch (error) {
    console.error('Failed to initialize server:', error);
    process.exit(1);
  }
};

// Call the function to start the server
startServer().catch(error => {
  console.error('Unhandled error during server startup:', error);
  process.exit(1);
});

module.exports = { getServiceAccountAuth };
