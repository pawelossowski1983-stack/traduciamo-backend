// server.js - Backend proxy dla TraduciAMO z MongoDB
// Uruchom: node server.js

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// MongoDB connection
let db;
let historyCollection;

const connectDB = async () => {
  try {
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    db = client.db('traduciamo');
    historyCollection = db.collection('history');
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

// Endpoint do tłumaczenia
app.post('/api/translate', async (req, res) => {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: req.body.max_tokens || 2000,
        messages: req.body.messages
      })
    });

    if (!response.ok) {
      throw new Error(`API Error: ${response.status}`);
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Translation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// HISTORY ENDPOINTS
// ============================================

// Zapisz tłumaczenie do historii
app.post('/api/history/save', async (req, res) => {
  try {
    const { userId, original, translated, fromLang, toLang } = req.body;
    
    if (!userId || !original || !translated) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const translation = {
      userId,
      original,
      translated,
      fromLang,
      toLang,
      timestamp: new Date()
    };

    await historyCollection.insertOne(translation);
    
    res.json({ success: true, message: 'Translation saved' });
  } catch (error) {
    console.error('Save history error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Pobierz historię dla użytkownika
app.get('/api/history/get', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const history = await historyCollection
      .find({ userId })
      .sort({ timestamp: -1 })
      .limit(100)
      .toArray();
    
    res.json(history);
  } catch (error) {
    console.error('Get history error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Wyczyść historię użytkownika
app.delete('/api/history/clear', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const result = await historyCollection.deleteMany({ userId });
    
    res.json({ 
      success: true, 
      message: `Deleted ${result.deletedCount} translations` 
    });
  } catch (error) {
    console.error('Clear history error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Usuń pojedyncze tłumaczenie
app.delete('/api/history/delete/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { ObjectId } = require('mongodb');
    
    const result = await historyCollection.deleteOne({ 
      _id: new ObjectId(id) 
    });
    
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Translation not found' });
    }
    
    res.json({ success: true, message: 'Translation deleted' });
  } catch (error) {
    console.error('Delete translation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    mongodb: db ? 'connected' : 'disconnected'
  });
});

// Test endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'TraduciAMO Backend is running!',
    timestamp: new Date().toISOString(),
    mongodb: db ? 'connected' : 'disconnected'
  });
});

// Start server
const startServer = async () => {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📝 ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? '✅ Set' : '❌ Missing'}`);
    console.log(`🗄️  MONGODB_URI: ${process.env.MONGODB_URI ? '✅ Set' : '❌ Missing'}`);
  });
};

startServer();
