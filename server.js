/**
 * server.js
 * API Server & Auto-Sync Service cho YouTuber Ranking
 * Cung cấp:
 * 1. API endpoint: GET /api/update-channels (hoặc POST) để kích hoạt cập nhật dữ liệu YouTube vào Supabase
 * 2. API endpoint: GET /api/status để kiểm tra trạng thái máy chủ và lần đồng bộ gần nhất
 * 3. Chức năng tự động chạy theo chu kỳ (Scheduled Auto-Sync Interval)
 * 4. Web server phục vụ file tĩnh (index.html, profile.html, hình ảnh, scripts)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { syncYouTubeData, loadConfigs } = require('./youtube-sync');

const PORT = process.env.PORT || 3000;
// Chu kỳ tự động cập nhật (mặc định: 60 phút, có thể đổi qua biến môi trường AUTO_SYNC_MINUTES)
const AUTO_SYNC_MINUTES = parseInt(process.env.AUTO_SYNC_MINUTES || '60', 10);

let lastSyncResult = null;
let isSyncing = false;
let nextSyncTime = null;

// Bảng MIME types cho static files
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.sql': 'text/plain; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8'
};

// Hàm xử lý kích hoạt đồng bộ
async function handleTriggerSync() {
    if (isSyncing) {
        return {
            success: false,
            message: 'Đang có một tiến trình đồng bộ khác đang chạy. Vui lòng thử lại sau vài giây.',
            isSyncing: true,
            timestamp: new Date().toISOString()
        };
    }

    try {
        isSyncing = true;
        const result = await syncYouTubeData();
        lastSyncResult = {
            ...result,
            completedAt: new Date().toISOString()
        };
        if (AUTO_SYNC_MINUTES > 0) {
            nextSyncTime = new Date(Date.now() + AUTO_SYNC_MINUTES * 60 * 1000).toISOString();
        }
        return lastSyncResult;
    } catch (err) {
        lastSyncResult = {
            success: false,
            message: 'Lỗi trong quá trình đồng bộ: ' + err.message,
            timestamp: new Date().toISOString()
        };
        return lastSyncResult;
    } finally {
        isSyncing = false;
    }
}

// Khởi tạo máy chủ HTTP
const server = http.createServer(async (req, res) => {
    // Thêm CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // --- API ROUTE 1: Kích hoạt đồng bộ YouTube -> Supabase ---
    if (pathname === '/api/update-channels' || pathname === '/api/sync') {
        console.log(`[API] Nhận yêu cầu đồng bộ từ client (${req.method} ${pathname})`);
        const result = await handleTriggerSync();
        res.writeHead(result.success ? 200 : (result.isSyncing ? 429 : 500), {
            'Content-Type': 'application/json; charset=utf-8'
        });
        return res.end(JSON.stringify(result, null, 2));
    }

    // --- API ROUTE 2: Kiểm tra trạng thái máy chủ và lần cập nhật gần nhất ---
    if (pathname === '/api/status') {
        const configs = loadConfigs();
        const statusData = {
            server: 'YouTuber Ranking Auto-Sync Service',
            status: 'online',
            currentTime: new Date().toISOString(),
            isSyncing,
            autoSyncIntervalMinutes: AUTO_SYNC_MINUTES,
            nextScheduledSync: nextSyncTime,
            supabaseUrl: configs.supabaseUrl,
            youtubeKeyConfigured: Boolean(configs.youtubeKey),
            lastSync: lastSyncResult
        };
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(statusData, null, 2));
    }

    // --- STATIC FILES SERVER: Phục vụ web frontend ---
    let safePath = pathname;
    if (safePath === '/' || safePath === '') safePath = '/index.html';

    const filePath = path.join(__dirname, safePath.replace(/^\//, ''));

    // Đảm bảo không truy cập ra ngoài thư mục gốc
    if (!filePath.startsWith(__dirname)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('403 Forbidden');
    }

    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('404 Not Found');
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        res.writeHead(200, { 'Content-Type': contentType });
        const stream = fs.createReadStream(filePath);
        stream.pipe(res);
    });
});

// Lập lịch tự động chạy định kỳ (Scheduled Auto-Sync)
function startScheduledAutoSync() {
    if (AUTO_SYNC_MINUTES <= 0) {
        console.log('[Auto-Sync] Tự động cập nhật định kỳ đang bị tắt.');
        return;
    }

    const intervalMs = AUTO_SYNC_MINUTES * 60 * 1000;
    nextSyncTime = new Date(Date.now() + intervalMs).toISOString();
    console.log(`[Auto-Sync] Đã bật tự động cập nhật mỗi ${AUTO_SYNC_MINUTES} phút. Lần chạy kế tiếp lúc: ${nextSyncTime}`);

    setInterval(async () => {
        console.log(`[Auto-Sync] Bắt đầu chu kỳ tự động cập nhật định kỳ (${AUTO_SYNC_MINUTES}m)...`);
        await handleTriggerSync();
    }, intervalMs);
}

// Bắt đầu lắng nghe
server.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`  🚀 YouTuber Ranking API & Web Server is running!`);
    console.log(`  🌐 Website:        http://localhost:${PORT}`);
    console.log(`  🔄 Sync API:       http://localhost:${PORT}/api/update-channels`);
    console.log(`  📊 Status API:     http://localhost:${PORT}/api/status`);
    console.log(`======================================================\n`);

    startScheduledAutoSync();
});
