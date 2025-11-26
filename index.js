const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();

// Security Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Rate Limiting
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use('/api/', generalLimiter);

const activationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5 // 5 activation attempts per hour
});
app.use('/api/activate-license', activationLimiter);

// Environment variables
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

if (!MONGODB_URI || !ADMIN_TOKEN) {
  console.error('❌ Missing required environment variables');
  process.exit(1);
}

// MongoDB Connection
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

// ==================== ADMIN ENDPOINTS ====================

// Authentication middleware for admin endpoints
const authenticateAdmin = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${ADMIN_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// Get all licenses
app.get('/api/admin/licenses', authenticateAdmin, async (req, res) => {
  try {
    const licenses = await License.find().sort({ createdAt: -1 });
    res.json(licenses);
  } catch (error) {
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
    res.status(500).json({ error: error.message });
  }
});

// Create a new license
app.post('/api/admin/create-license', authenticateAdmin, async (req, res) => {
  try {
    const { customerEmail, customerName, planType, durationMonths = 12, maxActivations = 1, notes } = req.body;
    
    if (!customerEmail || !customerName) {
      return res.status(400).json({ error: 'Customer email and name are required' });
    }
    
    // Generate license key (format: BABYLON-XXXX-XXXX-XXXX)
    const segments = [];
    for (let i = 0; i < 3; i++) {
      segments.push(crypto.randomBytes(2).toString('hex').toUpperCase());
    }
    const licenseKey = `BABYLON-${segments.join('-')}`;
    
    const expiryDate = new Date();
    expiryDate.setMonth(expiryDate.getMonth() + durationMonths);
    
    const license = await License.create({
      licenseKey,
      customerEmail,
      customerName,
      expiryDate,
      maxActivations,
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
    res.status(500).json({ success: false, error: error.message });
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
    res.status(500).json({ error: error.message });
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

// Serve admin panel
app.get('/admin', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Babylon RCT - License Admin</title>
        <style>
            body { font-family: Arial, sans-serif; margin: 40px; }
            .section { margin: 20px 0; padding: 20px; border: 1px solid #ddd; }
            input, button { margin: 5px; padding: 10px; }
            .success { background: #d4edda; padding: 10px; }
            .error { background: #f8d7da; padding: 10px; }
        </style>
    </head>
    <body>
        <h1>Babylon RCT License Admin</h1>
        <p>Admin panel is working! Use the API endpoints to manage licenses.</p>
        <div class="section">
            <h3>Create License</h3>
            <input type="text" id="customerName" placeholder="Customer Name">
            <input type="email" id="customerEmail" placeholder="Customer Email">
            <button onclick="createLicense()">Create License</button>
            <div id="result"></div>
        </div>
        <script>
            async function createLicense() {
                const result = document.getElementById('result');
                try {
                    const response = await fetch('/api/admin/create-license', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': 'Bearer ${ADMIN_TOKEN}'
                        },
                        body: JSON.stringify({
                            customerName: document.getElementById('customerName').value,
                            customerEmail: document.getElementById('customerEmail').value
                        })
                    });
                    const data = await response.json();
                    if (data.success) {
                        result.innerHTML = '<div class="success">License created: ' + data.license.licenseKey + '</div>';
                    } else {
                        result.innerHTML = '<div class="error">Error: ' + data.error + '</div>';
                    }
                } catch (error) {
                    result.innerHTML = '<div class="error">Error: ' + error.message + '</div>';
                }
            }
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
  console.log(`🔑 Admin Token: ${ADMIN_TOKEN.substring(0, 10)}...`);
});