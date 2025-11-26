# Babylon RCT License Server

This is the license validation server for the Babylon RCT (Randomic Control Tool) freemium model.

## Features

- ✅ License validation and activation
- ✅ Device-based activation limits
- ✅ Usage analytics tracking
- ✅ Admin panel for license management
- ✅ Security features (rate limiting, helmet, CORS)
- ✅ MongoDB Atlas cloud database

## Quick Start

### Prerequisites
- Node.js 18+ installed
- MongoDB Atlas account
- Render.com account
- GitHub account

### 1. Account Setup

#### GitHub Account
1. Go to [github.com](https://github.com)
2. Click "Sign up"
3. Create username, password, verify email
4. You're done!

#### MongoDB Atlas Account
1. Go to [MongoDB Atlas](https://www.mongodb.com/atlas)
2. Click "Try Free"
3. Create account and verify email
4. Follow setup wizard to create cluster

#### Render.com Account
1. Go to [render.com](https://render.com)
2. Click "Get Started"
3. Sign up with GitHub (recommended)
4. Verify email

### 2. Local Development

1. Clone this repository
2. Copy `.env.example` to `.env`
3. Fill in your environment variables
4. Install dependencies: `npm install`
5. Start server: `npm run dev`

### 3. Deployment to Render.com

1. Push code to GitHub
2. Go to [render.com](https://render.com)
3. Click "New +" → "Web Service"
4. Connect your GitHub repository
5. Configure:
   - **Name**: `babylon-license-server`
   - **Environment**: `Node`
   - **Region**: `Ohio` (or closest to you)
   - **Branch**: `main`
   - **Build Command**: `npm install`
   - **Start Command**: `node index.js`
   - **Plan**: `Free`

6. Add Environment Variables:
   - `MONGODB_URI` - Your MongoDB Atlas connection string
   - `ADMIN_TOKEN` - A secret token for admin access

7. Click "Create Web Service"

### 4. MongoDB Atlas Setup

1. **Create Cluster**:
   - Go to MongoDB Atlas dashboard
   - Click "Build a Database"
   - Choose **FREE** tier (M0)
   - Choose cloud provider & region
   - Cluster name: `babylon-license-cluster`

2. **Create Database User**:
   - Go to "Database Access"
   - Click "Add New Database User"
   - Username: `babylon-admin`
   - Password: Generate strong password
   - Privileges: "Read and write to any database"

3. **Network Access**:
   - Go to "Network Access"
   - Click "Add IP Address"
   - For production: Add `0.0.0.0/0` (allow all IPs)
   - Click "Confirm"

4. **Get Connection String**:
   - Go to "Databases" → Click "Connect"
   - Choose "Connect your application"
   - Driver: "Node.js", Version: "5.5 or later"
   - Copy connection string
   - Replace `<password>` with your actual password

### Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `MONGODB_URI` | MongoDB connection string | `mongodb+srv://user:pass@cluster.mongodb.net/db` |
| `ADMIN_TOKEN` | Secret token for admin access | `babylon_secret_123` |
| `PORT` | Server port (optional) | `3000` |
| `NODE_ENV` | Environment (optional) | `production` |

### API Endpoints

#### License Management
- `POST /api/validate-license` - Validate existing license
- `POST /api/activate-license` - Activate license on device
- `POST /api/record-usage` - Record usage analytics

#### Admin Endpoints (require ADMIN_TOKEN)
- `GET /api/admin/licenses` - List all licenses
- `POST /api/admin/create-license` - Create new license
- `GET /api/admin/usage-stats` - Get usage statistics
- `POST /api/admin/deactivate-license` - Deactivate license

#### Public Endpoints
- `GET /api/health` - Health check
- `GET /admin` - Basic admin panel

### Flutter App Integration

Update your `FreemiumManager` in the Flutter app:

```dart
static const String _validationServer = 'https://your-app-name.onrender.com';
