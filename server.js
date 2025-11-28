// server.js - Backend proxy dla TraduciAMO z MongoDB + Auth
// Uruchom: node server.js

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { MongoClient } = require('mongodb');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// MongoDB connection
let db;
let historyCollection;
let usersCollection;

const connectDB = async () => {
  try {
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    db = client.db('traduciamo');
    historyCollection = db.collection('history');
    usersCollection = db.collection('users');
    
    // Utwórz indeks na email (unique)
    await usersCollection.createIndex({ email: 1 }, { unique: true });
    
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'traduciamo-secret-key-change-in-production';

// Middleware do weryfikacji tokenu
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

// ============================================
// AUTH ENDPOINTS
// ============================================

// Rejestracja
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;

    // Walidacja
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Sprawdź czy user istnieje
    const existingUser = await usersCollection.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'User already exists' });
    }

    // Hash hasła
    const hashedPassword = await bcrypt.hash(password, 10);

    // Utwórz użytkownika
    const user = {
      email,
      password: hashedPassword,
      name: name || email.split('@')[0],
      createdAt: new Date(),
      lastLogin: new Date()
    };

    await usersCollection.insertOne(user);

    // Wygeneruj token
    const token = jwt.sign(
      { userId: user._id, email: user.email },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      success: true,
      token,
      user: {
        email: user.email,
        name: user.name
      }
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Logowanie
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Walidacja
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Znajdź użytkownika
    const user = await usersCollection.findOne({ email });
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Sprawdź hasło
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Zaktualizuj lastLogin
    await usersCollection.updateOne(
      { _id: user._id },
      { $set: { lastLogin: new Date() } }
    );

    // Wygeneruj token
    const token = jwt.sign(
      { userId: user._id, email: user.email },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      success: true,
      token,
      user: {
        email: user.email,
        name: user.name
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Pobierz dane zalogowanego użytkownika
app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const user = await usersCollection.findOne(
      { email: req.user.email },
      { projection: { password: 0 } } // Nie zwracaj hasła
    );

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      email: user.email,
      name: user.name,
      createdAt: user.createdAt
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// TRANSLATION ENDPOINT
// ============================================

app.post('/api/translate', async (req, res) => {
  try {
    console.log('📝 Translation request received');
    console.log('Messages:', JSON.stringify(req.body.messages).substring(0, 200) + '...');
    
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
      const errorData = await response.text();
      console.error('❌ Claude API Error:', response.status, errorData);
      throw new Error(`API Error: ${response.status} - ${errorData.substring(0, 100)}`);
    }

    const data = await response.json();
    console.log('✅ Translation successful');
    res.json(data);
  } catch (error) {
    console.error('❌ Translation error:', error.message);
    res.status(500).json({ 
      error: error.message,
      details: error.toString()
    });
  }
});

// ============================================
// HISTORY ENDPOINTS (wymagają auth)
// ============================================

// Zapisz tłumaczenie do historii
app.post('/api/history/save', authenticateToken, async (req, res) => {
  try {
    const { original, translated, fromLang, toLang } = req.body;
    
    if (!original || !translated) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const translation = {
      userId: req.user.email, // Z tokenu JWT
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
app.get('/api/history/get', authenticateToken, async (req, res) => {
  try {
    const history = await historyCollection
      .find({ userId: req.user.email }) // Z tokenu JWT
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
app.delete('/api/history/clear', authenticateToken, async (req, res) => {
  try {
    const result = await historyCollection.deleteMany({ 
      userId: req.user.email // Z tokenu JWT
    });
    
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
app.delete('/api/history/delete/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { ObjectId } = require('mongodb');
    
    const result = await historyCollection.deleteOne({ 
      _id: new ObjectId(id),
      userId: req.user.email // Tylko własne tłumaczenia
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
    mongodb: db ? 'connected' : 'disconnected',
    version: '2.0.0-auth'
  });
});

// Start server
const startServer = async () => {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📝 ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? '✅ Set' : '❌ Missing'}`);
    console.log(`🗄️  MONGODB_URI: ${process.env.MONGODB_URI ? '✅ Set' : '❌ Missing'}`);
    console.log(`🔐 JWT_SECRET: ${process.env.JWT_SECRET ? '✅ Set' : '⚠️  Using default (change in production!)'}`);
  });
};

startServer();
