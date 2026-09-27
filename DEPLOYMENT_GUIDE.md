# ALTITUDE Deployment & Hosting Guide

This guide covers how to deploy the **ALTITUDE Live Prototype Website** with zero errors to any major cloud hosting platform.

---

## Architecture Overview

1. **Frontend (Next.js 15 Web Portal + Interactive 3D Prototype)**:
   - Self-contained and resilient.
   - If connected to a live backend via `NEXT_PUBLIC_API_BASE`, it streams real-time hardware telemetry.
   - If deployed standalone (e.g., on Vercel/Netlify) without an active backend, it automatically runs an integrated client-side simulation engine so judges and evaluators always see a rich, fully interactive 3D prototype with live metrics and charts without error.
2. **Node.js Telemetry Gateway** (Optional for cloud, required for physical ESP32):
   - Ingests packets from ESP32 (`/api/telemetry`) and fans out SSE streams (`/api/stream`).
3. **Python Health Engine** (Optional for cloud):
   - Computes subsystem health score and thermal/safety alerts.

---

## Option 1: Deploying to Vercel (Recommended — Fastest & Free)

Vercel is the native hosting platform for Next.js and provides instant HTTPS deployments.

### Method A: Via Vercel Dashboard (GitHub / GitLab)
1. Push this project to your GitHub repository.
2. Go to [https://vercel.com/new](https://vercel.com/new) and import your repository.
3. Configure the Project Settings:
   - **Framework Preset**: `Next.js`
   - **Root Directory**: Select `frontend` (or `altitude-hackathon-website/frontend`)
   - **Build Command**: `next build` (default)
   - **Output Directory**: `.next` (default)
   - **Install Command**: `npm install` (default)
4. *(Optional)* Under **Environment Variables**, add:
   - `NEXT_PUBLIC_API_BASE`: `https://your-node-gateway.onrender.com` (if you deployed the backend)
5. Click **Deploy**. Your site will be live on `https://your-project.vercel.app` in under 1 minute!

### Method B: Via Vercel CLI
From your terminal:
```bash
npm install -g vercel
cd frontend
vercel
```
Follow the prompt, accept default settings, and deployment completes instantly.

---

## Option 2: Deploying to Netlify

1. Push your code to GitHub.
2. Go to [https://app.netlify.com/start](https://app.netlify.com/start) and select your repository.
3. Set:
   - **Base directory**: `frontend`
   - **Build command**: `npm run build`
   - **Publish directory**: `.next`
4. Click **Deploy Site**.

---

## Option 3: Deploying Fullstack (Next.js + Node Gateway + Python) on Render / Railway

If you want the Node.js telemetry gateway and Python health engine also hosted in the cloud:

### 1. Deploy Python Health Service
- **Service Type**: Web Service
- **Root Directory**: `python-service`
- **Build Command**: (none required, uses standard Python 3)
- **Start Command**: `python service.py`
- **Environment Variables**: `PORT=8000`, `HOST=0.0.0.0`

### 2. Deploy Node.js Gateway
- **Service Type**: Web Service
- **Root Directory**: `node-backend`
- **Build Command**: `npm install`
- **Start Command**: `node server.js`
- **Environment Variables**:
  - `PORT=8080`
  - `HOST=0.0.0.0`
  - `PYTHON_URL=https://your-python-service.onrender.com/analyze`

### 3. Deploy Frontend (Vercel / Render)
- Set Environment Variable:
  - `NEXT_PUBLIC_API_BASE=https://your-node-gateway.onrender.com`

---

## Option 4: Deploying with Docker

You can containerize the portal for any container platform (AWS ECS, Google Cloud Run, DigitalOcean, VPS):

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
EXPOSE 3000
CMD ["node", "server.js"]
```

---

## Verification & Health Check

After deployment, test your URL:
- Open `https://<YOUR_DEPLOYED_URL>` in any desktop or mobile browser.
- Verify that:
  - The 3D interactive model loads with full orbit/zoom/pan controls.
  - Sensor telemetry metrics and sparkline charts update continuously at 1 Hz.
  - Subsystem status, health scores, and tabs switch cleanly without any console errors.
