const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();

// Security Middleware with adjusted CSP for admin panel
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"]
    }
  }
}));
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Trust proxy for Render
app.set('trust proxy', 1);

// Rate Limiting
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  keyGenerator: (req) => req.ip
});
app.use('/api/', generalLimiter);

// Environment variables
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

if (!MONGODB_URI || !ADMIN_TOKEN) {
  console.error('❌ Missing required environment variables');
  console.log('MONGODB_URI:', MONGODB_URI ? 'Set' : 'Missing');
  console.log('ADMIN_TOKEN:', ADMIN_TOKEN ? 'Set' : 'Missing');
  process.exit(1);
}

// MongoDB Connection with better error handling
mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('✅ Connected to MongoDB Atlas'))
.catch(err => {
  console.error('❌ MongoDB connection error:', err);
  process.exit(1);
});

// License Schema
const licenseSchema = new mongoose.Schema({
  licenseKey: { type: String, required: true, unique: true },
  customerEmail: { type: String, required: true },
  customerName: { type: String, required: true },
  purchaseDate: { type: Date, default: Date.now },
  expiryDate: { type: Date, required: true },
  isActive: { type: Boolean, default: true },
  maxActivations: { type: Number, default: 1 },
  currentActivations: { type: Number, default: 0 },
  deviceActivations: [{
    deviceId: String,
    activationDate: { type: Date, default: Date.now },
    lastValidation: { type: Date, default: Date.now },
    deviceInfo: Object
  }],
  metadata: {
    planType: { type: String, default: 'single' },
    version: { type: String, default: '1.0' },
    notes: String
  }
}, { timestamps: true });

const License = mongoose.model('License', licenseSchema);

// Usage Analytics Schema
const usageSchema = new mongoose.Schema({
  licenseKey: String,
  deviceId: String,
  action: String,
  metadata: Object,
  timestamp: { type: Date, default: Date.now }
});

const Usage = mongoose.model('Usage', usageSchema);

// ==================== ADMIN ENDPOINTS ====================

// Authentication middleware for admin endpoints
const authenticateAdmin = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized - No token provided' });
  }
  
  const token = authHeader.substring(7); // Remove "Bearer " prefix
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized - Invalid token' });
  }
  next();
};

// Create a new license - IMPROVED VERSION
app.post('/api/admin/create-license', authenticateAdmin, async (req, res) => {
  try {
    console.log('📝 Creating new license request:', req.body);
    
    const { customerEmail, customerName, planType, durationMonths = 12, maxActivations = 1, notes } = req.body;
    
    if (!customerEmail || !customerName) {
      console.log('❌ Missing required fields');
      return res.status(400).json({ 
        success: false, 
        error: 'Customer email and name are required' 
      });
    }
    
    // Generate license key (format: BABYLON-XXXX-XXXX-XXXX)
    const segments = [];
    for (let i = 0; i < 3; i++) {
      segments.push(crypto.randomBytes(2).toString('hex').toUpperCase());
    }
    const licenseKey = `BABYLON-${segments.join('-')}`;
    
    const expiryDate = new Date();
    expiryDate.setMonth(expiryDate.getMonth() + (parseInt(durationMonths) || 12));
    
    console.log('🔑 Generated license key:', licenseKey);
    
    const license = await License.create({
      licenseKey,
      customerEmail: customerEmail.trim(),
      customerName: customerName.trim(),
      expiryDate,
      maxActivations: parseInt(maxActivations) || 1,
      metadata: { 
        planType: planType || 'single',
        notes: notes || ''
      }
    });
    
    console.log(`✅ New license created: ${licenseKey} for ${customerEmail}`);
    
    res.json({ 
      success: true, 
      license: {
        licenseKey: license.licenseKey,
        customerName: license.customerName,
        customerEmail: license.customerEmail,
        expiryDate: license.expiryDate,
        maxActivations: license.maxActivations,
        planType: license.metadata.planType
      }
    });
    
  } catch (error) {
    console.error('💥 License creation error:', error);
    
    if (error.code === 11000) {
      // Duplicate key error (shouldn't happen with random keys, but just in case)
      return res.status(400).json({ 
        success: false, 
        error: 'License key already exists. Please try again.' 
      });
    }
    
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get all licenses
app.get('/api/admin/licenses', authenticateAdmin, async (req, res) => {
  try {
    const licenses = await License.find().sort({ createdAt: -1 });
    res.json(licenses);
  } catch (error) {
    console.error('💥 Error fetching licenses:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get usage statistics
app.get('/api/admin/usage-stats', authenticateAdmin, async (req, res) => {
  try {
    const stats = await Usage.aggregate([
      {
        $group: {
          _id: '$licenseKey',
          totalActions: { $sum: 1 },
          lastActivity: { $max: '$timestamp' },
          uniqueDevices: { $addToSet: '$deviceId' },
          actions: { $push: { action: '$action', timestamp: '$timestamp' } }
        }
      },
      {
        $lookup: {
          from: 'licenses',
          localField: '_id',
          foreignField: 'licenseKey',
          as: 'licenseInfo'
        }
      }
    ]);
    
    res.json(stats);
  } catch (error) {
    console.error('💥 Error fetching usage stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// Deactivate license
app.post('/api/admin/deactivate-license', authenticateAdmin, async (req, res) => {
  try {
    const { licenseKey } = req.body;
    
    const license = await License.findOneAndUpdate(
      { licenseKey },
      { isActive: false },
      { new: true }
    );
    
    if (!license) {
      return res.status(404).json({ error: 'License not found' });
    }
    
    res.json({ success: true, message: 'License deactivated' });
  } catch (error) {
    console.error('💥 Error deactivating license:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== LICENSE VALIDATION ENDPOINTS ====================

// Validate license endpoint
app.post('/api/validate-license', async (req, res) => {
  try {
    const { license_key, device_id } = req.body;
    
    console.log(`🔍 Validating license: ${license_key} for device: ${device_id}`);
    
    const license = await License.findOne({ 
      licenseKey: license_key,
      isActive: true 
    });
    
    if (!license) {
      console.log('❌ License not found:', license_key);
      return res.json({ 
        valid: false, 
        message: 'License not found or inactive' 
      });
    }
    
    if (new Date() > license.expiryDate) {
      console.log('❌ License expired:', license_key);
      return res.json({ 
        valid: false, 
        message: 'License has expired' 
      });
    }
    
    const deviceActivation = license.deviceActivations.find(
      activation => activation.deviceId === device_id
    );
    
    if (!deviceActivation) {
      console.log('❌ Device not activated:', device_id);
      return res.json({ 
        valid: false, 
        message: 'License not activated on this device' 
      });
    }
    
    deviceActivation.lastValidation = new Date();
    await license.save();
    
    console.log('✅ License validated successfully:', license_key);
    
    res.json({
      valid: true,
      message: 'License is valid',
      expiry_date: license.expiryDate.toISOString(),
      customer_name: license.customerName,
      plan_type: license.metadata.planType
    });
    
  } catch (error) {
    console.error('💥 Validation error:', error);
    res.status(500).json({ valid: false, message: 'Server error during validation' });
  }
});

// Activate license endpoint
app.post('/api/activate-license', async (req, res) => {
  try {
    const { license_key, device_id, device_fingerprint } = req.body;
    
    console.log(`🚀 Activating license: ${license_key} for device: ${device_id}`);
    
    const license = await License.findOne({ 
      licenseKey: license_key,
      isActive: true 
    });
    
    if (!license) {
      console.log('❌ License not found:', license_key);
      return res.json({ 
        valid: false, 
        message: 'Invalid license key' 
      });
    }
    
    if (new Date() > license.expiryDate) {
      console.log('❌ License expired:', license_key);
      return res.json({ 
        valid: false, 
        message: 'License has expired. Please contact support.' 
      });
    }
    
    const existingActivation = license.deviceActivations.find(
      activation => activation.deviceId === device_id
    );
    
    if (existingActivation) {
      existingActivation.lastValidation = new Date();
      await license.save();
      
      console.log('✅ License already activated on device:', device_id);
      
      return res.json({
        valid: true,
        message: 'License already activated on this device',
        expiry_date: license.expiryDate.toISOString(),
        customer_name: license.customerName
      });
    }
    
    if (license.currentActivations >= license.maxActivations) {
      console.log('❌ Activation limit reached:', license_key);
      return res.json({ 
        valid: false, 
        message: `License activation limit reached (${license.maxActivations} device${license.maxActivations > 1 ? 's' : ''}). Please contact support.` 
      });
    }
    
    license.deviceActivations.push({
      deviceId: device_id,
      deviceInfo: device_fingerprint || {},
      activationDate: new Date(),
      lastValidation: new Date()
    });
    
    license.currentActivations += 1;
    await license.save();
    
    console.log('✅ License activated successfully:', license_key);
    
    res.json({
      valid: true,
      message: 'License activated successfully!',
      expiry_date: license.expiryDate.toISOString(),
      customer_name: license.customerName,
      plan_type: license.metadata.planType,
      activations_used: license.currentActivations,
      activations_total: license.maxActivations
    });
    
  } catch (error) {
    console.error('💥 Activation error:', error);
    res.status(500).json({ valid: false, message: 'Server error during activation' });
  }
});

// Record usage endpoint
app.post('/api/record-usage', async (req, res) => {
  try {
    const { license_key, device_id, action, metadata } = req.body;
    
    await Usage.create({
      licenseKey: license_key,
      deviceId: device_id,
      action: action,
      metadata: metadata || {}
    });
    
    console.log(`📊 Usage recorded: ${action} for license: ${license_key}`);
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('💥 Usage recording error:', error);
    res.json({ success: false });
  }
});

// Health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
    const licenseCount = await License.countDocuments();
    const activeLicenses = await License.countDocuments({ 
      isActive: true, 
      expiryDate: { $gt: new Date() } 
    });
    
    res.json({ 
      status: 'OK', 
      timestamp: new Date().toISOString(),
      database: dbStatus,
      total_licenses: licenseCount,
      active_licenses: activeLicenses,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      service: 'Babylon RCT License Server'
    });
  } catch (error) {
    res.status(500).json({ status: 'ERROR', error: error.message });
  }
});

// Root route - Friendly homepage
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Babylon RCT License Server</title>
        <style>
            body { font-family: Arial, sans-serif; margin: 40px; text-align: center; }
            .container { max-width: 800px; margin: 0 auto; }
            .endpoint { background: #f5f5f5; padding: 10px; margin: 10px 0; border-left: 4px solid #007cba; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🚀 Babylon RCT License Server</h1>
            <p>Your license validation server is running successfully!</p>
            
            <h2>Available Endpoints:</h2>
            
            <div class="endpoint">
                <strong>GET /api/health</strong> - Server health check
                <br><a href="/api/health">Test Health</a>
            </div>
            
            <div class="endpoint">
                <strong>GET /admin</strong> - License management panel
                <br><a href="/admin">Admin Panel</a>
            </div>
            
            <div class="endpoint">
                <strong>POST /api/validate-license</strong> - Validate license key
            </div>
            
            <div class="endpoint">
                <strong>POST /api/activate-license</strong> - Activate license on device
            </div>
            
            <h3>Server Information:</h3>
            <p><strong>Status:</strong> ✅ Live</p>
            <p><strong>URL:</strong> https://babylon-license-server-zivj.onrender.com</p>
            <p><strong>Database:</strong> MongoDB Atlas</p>
        </div>
    </body>
    </html>
  `);
});

// Serve admin panel - IMPROVED VERSION
app.get('/admin', (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN;
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Babylon RCT - License Admin</title>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            body { 
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
                margin: 0; 
                padding: 20px; 
                background: #f5f6fa;
                min-height: 100vh;
            }
            .container {
                max-width: 500px;
                margin: 0 auto;
                background: white;
                padding: 30px;
                border-radius: 10px;
                box-shadow: 0 5px 15px rgba(0,0,0,0.1);
            }
            h1 { 
                color: #2c3e50; 
                text-align: center;
                margin-bottom: 30px;
            }
            .form-group { 
                margin-bottom: 20px; 
            }
            label { 
                display: block; 
                margin-bottom: 8px; 
                font-weight: 600;
                color: #555;
            }
            input { 
                width: 100%; 
                padding: 12px; 
                border: 2px solid #ddd; 
                border-radius: 6px;
                font-size: 16px;
                box-sizing: border-box;
            }
            input:focus {
                border-color: #3498db;
                outline: none;
            }
            button { 
                background: #3498db;
                color: white;
                border: none;
                padding: 15px;
                border-radius: 6px;
                cursor: pointer;
                font-size: 16px;
                font-weight: 600;
                width: 100%;
                transition: background 0.3s;
            }
            button:hover { 
                background: #2980b9;
            }
            button:disabled {
                background: #bdc3c7;
                cursor: not-allowed;
            }
            .result { 
                margin-top: 20px; 
                padding: 15px;
                border-radius: 6px;
                display: none;
            }
            .success { 
                background: #d4edda; 
                color: #155724;
                border: 1px solid #c3e6cb;
            }
            .error { 
                background: #f8d7da; 
                color: #721c24;
                border: 1px solid #f5c6cb;
            }
            .debug-info {
                margin-top: 20px;
                padding: 10px;
                background: #f8f9fa;
                border-radius: 5px;
                font-size: 12px;
                color: #666;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>Babylon RCT License Admin</h1>
            
            <div class="form-group">
                <label for="customerName">Customer Name *</label>
                <input type="text" id="customerName" placeholder="Enter customer name" required>
            </div>
            
            <div class="form-group">
                <label for="customerEmail">Customer Email *</label>
                <input type="email" id="customerEmail" placeholder="Enter customer email" required>
            </div>
            
            <button onclick="createLicense()" id="createBtn">Create License Key</button>
            
            <div id="result" class="result"></div>
            
            <div class="debug-info">
                <strong>Debug Info:</strong><br>
                Server: <span id="serverStatus">Checking...</span><br>
                Admin Token: <span id="tokenStatus">Checking...</span>
            </div>
        </div>

        <script>
            const ADMIN_TOKEN = '${adminToken}';
            const SERVER_URL = window.location.origin;
            
            console.log('Admin panel loaded');
            console.log('Server URL:', SERVER_URL);
            console.log('Admin Token present:', !!ADMIN_TOKEN);
            
            // Update debug info
            document.getElementById('serverStatus').textContent = SERVER_URL;
            document.getElementById('tokenStatus').textContent = ADMIN_TOKEN ? 'Present' : 'Missing';
            
            async function createLicense() {
                const customerName = document.getElementById('customerName').value.trim();
                const customerEmail = document.getElementById('customerEmail').value.trim();
                const resultDiv = document.getElementById('result');
                const createBtn = document.getElementById('createBtn');
                
                console.log('Creating license for:', { customerName, customerEmail });
                
                if (!customerName || !customerEmail) {
                    showResult('Please fill in all fields', 'error');
                    return;
                }
                
                if (!ADMIN_TOKEN) {
                    showResult('Admin token not configured on server', 'error');
                    return;
                }
                
                createBtn.disabled = true;
                createBtn.textContent = 'Creating License...';
                resultDiv.style.display = 'none';
                
                try {
                    console.log('Sending request to:', SERVER_URL + '/api/admin/create-license');
                    
                    const response = await fetch(SERVER_URL + '/api/admin/create-license', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': 'Bearer ' + ADMIN_TOKEN
                        },
                        body: JSON.stringify({
                            customerName: customerName,
                            customerEmail: customerEmail
                        })
                    });
                    
                    console.log('Response status:', response.status);
                    
                    const data = await response.json();
                    console.log('Response data:', data);
                    
                    if (data.success) {
                        const licenseKey = data.license.licenseKey;
                        showResult(
                            '<strong>✅ License Created!</strong><br><br>' +
                            '<strong>License Key:</strong><br>' +
                            '<code style="background: #2c3e50; color: white; padding: 10px; border-radius: 5px; font-size: 16px; display: block; margin: 10px 0;">' + licenseKey + '</code>' +
                            '<strong>Customer:</strong> ' + data.license.customerName + '<br>' +
                            '<strong>Email:</strong> ' + data.license.customerEmail + '<br>' +
                            '<strong>Expiry:</strong> ' + new Date(data.license.expiryDate).toLocaleDateString(),
                            'success'
                        );
                        
                        // Clear form
                        document.getElementById('customerName').value = '';
                        document.getElementById('customerEmail').value = '';
                    } else {
                        showResult('Error: ' + (data.error || 'Unknown error'), 'error');
                    }
                } catch (error) {
                    console.error('Network error:', error);
                    showResult('Network Error: ' + error.message, 'error');
                } finally {
                    createBtn.disabled = false;
                    createBtn.textContent = 'Create License Key';
                }
            }
            
            function showResult(message, type) {
                const resultDiv = document.getElementById('result');
                resultDiv.innerHTML = message;
                resultDiv.className = 'result ' + type;
                resultDiv.style.display = 'block';
                
                // Scroll to result
                resultDiv.scrollIntoView({ behavior: 'smooth' });
            }
            
            // Allow form submission with Enter key
            document.addEventListener('keypress', function(event) {
                if (event.key === 'Enter') {
                    createLicense();
                }
            });
        </script>
    </body>
    </html>
  `);
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Babylon RCT License Server running on port ${PORT}`);
  console.log(`📊 Admin panel: http://localhost:${PORT}/admin`);
  console.log(`❤️  Health check: http://localhost:${PORT}/api/health`);
  console.log(`🔑 Admin Token: ${ADMIN_TOKEN ? 'Set (' + ADMIN_TOKEN.substring(0, 10) + '...)' : 'NOT SET'}`);
  console.log(`🗄️  MongoDB URI: ${MONGODB_URI ? 'Set' : 'NOT SET'}`);
});
