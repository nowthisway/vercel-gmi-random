export const config = {
  runtime: 'edge', // ⚡ 极速边缘节点
};

// ✅ API Key 管理类 (完美还原 GMI 的校验和逻辑)
class APIKeyManager {
  private apiKeys: string[] =[];
  private requestCounter = 0;
  private loadError: string | null = null;

  constructor() {
    this.loadKeysFromEnv();
    this.logKeyStatus();
  }

  private loadKeysFromEnv(): void {
    const envSources =['GMI_API_KEYS', 'GMI_KEYS', 'API_KEYS'];

    console.log("🔍 开始加载环境变量...");

    for (const envVar of envSources) {
      const keysStr = process.env[envVar];
      if (keysStr) {
        const cleanKeysStr = keysStr.replace(/^["']|["']$/g, '');
        const keyArray = cleanKeysStr.split(',')
          .map(key => key.trim())
          .filter(key => key.length > 0);
          
        for (let i = 0; i < keyArray.length; i++) {
          const key = keyArray[i];
          const isValid = this.isValidAPIKey(key);
          if (isValid) {
            this.apiKeys.push(key);
          }
        }
        
        if (this.apiKeys.length > 0) {
          console.log(`✅ 从 ${envVar} 成功加载 ${this.apiKeys.length} 个有效的 API keys`);
          break;
        }
      }
    }

    if (this.apiKeys.length === 0) {
      console.log("🔍 尝试加载索引格式的环境变量...");
      for (let i = 1; i <= 20; i++) {
        const envVar = `GMI_API_KEY_${i}`;
        const key = process.env[envVar];
        if (key && this.isValidAPIKey(key.trim())) {
          this.apiKeys.push(key.trim());
        }
      }
    }

    if (this.apiKeys.length === 0) {
      this.loadError = 'No valid API keys found! Please check your Vercel Environment Variables.';
      console.error('❌ 没有找到有效的 GMI API keys!');
    }
  }

  // ⚠️ 还原 GMI 专属 JWT 格式校验
  private isValidAPIKey(key: string): boolean {
    const parts = key.split('.');
    const isValid = parts.length === 3 && 
                    parts.every(part => part.length > 0) &&
                    key.length > 100;
    
    if (!isValid) {
      console.log(`❌ 无效的 GMI API Key 格式，长度: ${key.length}, 部分数: ${parts.length}`);
    }
    return isValid;
  }

  hasValidKeys(): boolean {
    return this.apiKeys.length > 0;
  }

  getLoadError(): string | null {
    return this.loadError;
  }

  getNextAPIKey(): string {
    if (!this.hasValidKeys()) throw new Error('No valid API keys available');
    const timeSlot = Math.floor(Date.now() / 1000);
    const index = (timeSlot + this.requestCounter) % this.apiKeys.length;
    this.requestCounter++;
    return this.apiKeys[index];
  }

  getPublicKeyStatus(): { total: number; usage: number[]; error?: string; hasKeys: boolean } {
    const result = {
      total: this.apiKeys.length,
      usage: new Array(this.apiKeys.length).fill(0),
      hasKeys: this.apiKeys.length > 0
    };
    if (this.loadError && this.apiKeys.length === 0) {
      return { ...result, error: 'API keys configuration error - check server logs' };
    }
    return result;
  }

  private logKeyStatus(): void {
    if (this.loadError) {
      console.log(`❌ API Keys 加载失败: ${this.loadError}`);
      return;
    }
    console.log(`🔑 总计 GMI API Keys: ${this.apiKeys.length}`);
  }
}

// ✅ 代理访问认证管理器
class ProxyAuthManager {
  private customToken: string | null = null;
  constructor() { this.loadCustomToken(); }

  private loadCustomToken(): void {
    const token = process.env.PROXY_API_TOKEN;
    if (token && token.trim().length > 0) {
      this.customToken = token.trim();
    } else {
      console.error('❌ PROXY_API_TOKEN 未设置或为空！');
    }
  }

  validateToken(token: string): boolean {
    return this.customToken !== null && this.customToken === token;
  }
  hasValidToken(): boolean { return this.customToken !== null; }
}

interface RequestStats {
  totalRequests: number; successfulRequests: number; failedRequests: number;
  startTime: number; authFailures: number; rateLimitHits: number;
}
const stats: RequestStats = {
  totalRequests: 0, successfulRequests: 0, failedRequests: 0,
  startTime: Date.now(), authFailures: 0, rateLimitHits: 0
};

let keyManager: APIKeyManager | null = null;
let authManager: ProxyAuthManager | null = null;

// 🎯 目标 URL 还原为 GMI 官方端点
const UPSTREAM_BASE = 'https://api.gmi-serving.com';

export default async function handler(request: Request): Promise<Response> {
  if (!keyManager) keyManager = new APIKeyManager();
  if (!authManager) authManager = new ProxyAuthManager();

  // ⚠️ 绝杀 404：处理 Vercel Rewrite 路径，精准获取代理 URI
  const rawUrl = request.headers.get('x-forwarded-url') || request.url;
  const url = new URL(rawUrl);
  let pathname = url.pathname;
  if (pathname.startsWith('/api/proxy')) {
    pathname = pathname.substring('/api/proxy'.length) || '/';
  } else if (pathname.startsWith('/api')) {
    pathname = pathname.substring('/api'.length) || '/';
  }
  const search = url.search;

  stats.totalRequests++;

  // ✅ CORS 预检
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  // ✅ 首页状态页与 Robots
  if ((pathname === '/' || pathname === '/index.html') && request.method === 'GET' && !request.headers.get('Authorization')) {
    return htmlResponse(generateStatusPage(request.url));
  }
  if (pathname === '/status' && request.method === 'GET') {
    return jsonResponse({
      service: "GMI Proxy Server", version: "2.0.0 (Vercel)",
      uptime: Date.now() - stats.startTime, stats,
      keyStatus: keyManager.getPublicKeyStatus(),
      proxyToken: authManager.hasValidToken() ? 'configured' : 'not configured'
    });
  }
  if (pathname === '/robots.txt' && request.method === 'GET') {
    return textResponse("User-agent: *\nDisallow: /");
  }

  // ✅ 服务可用性与鉴权检查
  if (!authManager.hasValidToken()) return jsonResponse({ error: "Service Unavailable", message: "Proxy token not configured" }, 503);
  if (!keyManager.hasValidKeys()) return jsonResponse({ error: "Service Unavailable", message: "No valid GMI keys" }, 503);
  
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authManager.validateToken(authHeader.replace('Bearer ', '').trim())) {
    stats.failedRequests++; stats.authFailures++;
    return jsonResponse({ error: "Unauthorized", message: "Valid Bearer token required" }, 401);
  }

  const targetUrl = `${UPSTREAM_BASE}${pathname}${search}`;
  let apiKey: string;
  try {
    apiKey = keyManager.getNextAPIKey();
  } catch (error) {
    stats.failedRequests++;
    return jsonResponse({ error: "Service Unavailable", message: "No API keys available" }, 503);
  }

  // ✅ 预处理请求体 (完美保留 GMI 原版针对 claude 的过滤和 top_p 冲突处理)
  let requestBody: BodyInit | null = null;
  if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
    try {
      const bodyText = await request.clone().text();
      if (bodyText) {
        try {
          const bodyJson = JSON.parse(bodyText);
          if (bodyJson.temperature !== undefined && bodyJson.top_p !== undefined) delete bodyJson.top_p;
          const model = (bodyJson.model || '').toLowerCase();
          if (model.includes('claude')) {['frequency_penalty', 'presence_penalty', 'logprobs', 'top_logprobs'].forEach(p => delete bodyJson[p]);
          }
          requestBody = JSON.stringify(bodyJson);
        } catch { requestBody = bodyText; }
      }
    } catch { requestBody = null; }
  }

  // ✅ 高可用请求转发
  let retries = 3;
  let response: Response | null = null;

  while (retries > 0) {
    try {
      const headers = new Headers(request.headers);
      headers.set("Authorization", `Bearer ${apiKey}`);
      headers.set("User-Agent", getRandomUserAgent());
      headers.set("Accept", "application/json");
      headers.set("Content-Type", "application/json");
      
      // 防止 Vercel 追踪头暴露
      headers.delete("Host"); headers.delete("x-vercel-id");
      headers.delete("x-forwarded-host"); headers.delete("x-forwarded-for");
      
      response = await fetch(targetUrl, {
        method: request.method, headers: headers, body: requestBody, redirect: "follow"
      });

      if (response.status === 401 || response.status === 403) {
        stats.authFailures++; retries--;
        await new Promise(res => setTimeout(res, 1000 * (4 - retries)));
        continue;
      }
      if (response.status === 429) {
        stats.rateLimitHits++; retries--;
        await new Promise(res => setTimeout(res, 2000 * (4 - retries)));
        continue;
      }
      break;
    } catch (error) {
      retries--; await new Promise(res => setTimeout(res, 1500 * (4 - retries)));
    }
  }

  if (!response) {
    stats.failedRequests++;
    return jsonResponse({ error: "Bad Gateway", message: "All retries failed" }, 502);
  }

  stats.successfulRequests++;
  const responseHeaders = new Headers(response.headers);
  responseHeaders.set("X-Proxy-Server", "Vercel GMI Proxy");
  responseHeaders.set("X-Retries", String(3 - retries));
  responseHeaders.set("Access-Control-Allow-Origin", "*");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders
  });
}

function getRandomUserAgent(): string {
  const uaList =[
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  ];
  return uaList[Math.floor(Math.random() * uaList.length)];
}

// ✅ 状态页面 (已还原为 GMI 专属蓝色极简风格主题)
function generateStatusPage(requestUrl: string): string {
  const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
  const keyStatus = keyManager!.getPublicKeyStatus();
  const hasProxyToken = authManager!.hasValidToken();
  const baseUrl = new URL(requestUrl).origin;
  const successRate = stats.totalRequests > 0 ? ((stats.successfulRequests / stats.totalRequests) * 100).toFixed(1) : '0';

  return `
<!DOCTYPE html>
<html>
<head>
    <title>GMI Proxy Server</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; margin: 0; padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; }
        .container { max-width: 800px; margin: 0 auto; background: white; padding: 30px; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.1); }
        .header { text-align: center; margin-bottom: 30px; }
        .status { color: #28a745; font-weight: bold; font-size: 18px; }
        .error { color: #dc3545; font-weight: bold; font-size: 18px; }
        .card { background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 15px 0; border-left: 4px solid #007bff; }
        .error-card { border-left: 4px solid #dc3545; background: #f8d7da; }
        .success-card { border-left: 4px solid #28a745; background: #d4edda; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; }
        .stat-item { text-align: center; padding: 15px; background: white; border-radius: 6px; }
        .stat-number { font-size: 24px; font-weight: bold; color: #007bff; }
        .stat-label { font-size: 14px; color: #666; margin-top: 5px; }
        .endpoint { background: #e9ecef; padding: 15px; border-radius: 6px; font-family: 'Monaco', 'Menlo', monospace; font-size: 14px; margin: 10px 0; word-break: break-all; }
        h1 { color: #333; margin: 0; }
        h2 { color: #555; border-bottom: 2px solid #eee; padding-bottom: 10px; }
        .version { color: #666; font-size: 14px; }
        .footer { text-align: center; margin-top: 30px; color: #666; font-size: 12px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🚀 GMI Proxy Server</h1>
            <p class="version">v2.0.0 (Direct root proxy via Vercel)</p>
            ${keyStatus.hasKeys && hasProxyToken ? '<p class="status">✅ Service Running Normally</p>' : '<p class="error">❌ Service Configuration Error</p>'}
        </div>
      
        ${!hasProxyToken ? `<div class="card error-card"><h3>❌ Authentication Error</h3><p>PROXY_API_TOKEN not configured.</p></div>` : ''}
        ${!keyStatus.hasKeys ? `<div class="card error-card"><h3>❌ API Keys Error</h3><p>No valid GMI API keys configured.</p></div>` : ''}
      
        <div class="card">
            <h2>📊 Service Statistics</h2>
            <div class="stats-grid">
                <div class="stat-item"><div class="stat-number">${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m</div><div class="stat-label">Uptime</div></div>
                <div class="stat-item"><div class="stat-number">${stats.totalRequests}</div><div class="stat-label">Total Requests</div></div>
                <div class="stat-item"><div class="stat-number">${stats.successfulRequests}</div><div class="stat-label">Successful</div></div>
                <div class="stat-item"><div class="stat-number">${successRate}%</div><div class="stat-label">Success Rate</div></div>
                <div class="stat-item"><div class="stat-number">${stats.authFailures}</div><div class="stat-label">Auth Failures</div></div>
                <div class="stat-item"><div class="stat-number">${stats.rateLimitHits}</div><div class="stat-label">Rate Limits</div></div>
            </div>
        </div>
      
        <div class="card ${keyStatus.hasKeys ? 'success-card' : 'error-card'}">
            <h2>🔑 GMI API Keys Status</h2>
            <p><strong>Total Keys:</strong> ${keyStatus.total}</p>
            <p>${keyStatus.hasKeys ? '✅ Load balancing active' : '❌ No valid API keys configured'}</p>
        </div>
      
        ${keyStatus.hasKeys && hasProxyToken ? `
        <div class="card">
            <h2>📡 API Usage</h2>
            <div class="endpoint">
                <strong>Base URL:</strong><br>${baseUrl}<br><br>
                <strong>Example:</strong><br>POST ${baseUrl}/v1/chat/completions<br><br>
                <strong>Headers:</strong><br>Authorization: Bearer YOUR_PROXY_TOKEN<br>Content-Type: application/json
            </div>
            <p><strong>Note:</strong> All paths are proxied directly to upstream API. No <code>/gmi</code> prefix needed.</p>
        </div>` : ''}
    </div>
</body>
</html>`;
}

function htmlResponse(content: string): Response { return new Response(content, { headers: { "Content-Type": "text/html; charset=utf-8" }, status: 200 }); }
function textResponse(content: string, status = 200): Response { return new Response(content, { headers: { "Content-Type": "text/plain; charset=utf-8" }, status }); }
function jsonResponse(data: unknown, status = 200): Response { return new Response(JSON.stringify(data, null, 2), { headers: { "Content-Type": "application/json; charset=utf-8" }, status }); }
