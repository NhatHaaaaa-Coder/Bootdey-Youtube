/**
 * youtube-sync.js
 * Module đồng bộ dữ liệu YouTube Data API v3 vào Supabase Database
 * Cập nhật 4 cột:
 * - subscribers (BIGINT)
 * - subscribers_formatted (VARCHAR)
 * - videos_count (INT)
 * - view_count (BIGINT)
 * - updated_at (TIMESTAMP)
 */

const fs = require('fs');
const path = require('path');

// Đọc cấu hình từ Supabase.txt và youtube.txt
function loadConfigs() {
    let supabaseUrl = 'https://pmxvshdtcwxbqjdmfyll.supabase.co';
    let supabaseKey = 'sb_publishable_Z2AIZpEI4dStNKVf6Plbrg_z38v_s6I';
    let youtubeKey = 'AIzaSyCoccJ_YSStOgdLxct49Td3PA9z6e4aJ_A';

    try {
        const sbPath = path.join(__dirname, 'Supabase.txt');
        if (fs.existsSync(sbPath)) {
            const content = fs.readFileSync(sbPath, 'utf8');
            const urlMatch = content.match(/Project URL:\s*(https?:\/\/[^\s]+)/i);
            const keyMatch = content.match(/Public Key:\s*([^\s]+)/i);
            if (urlMatch) supabaseUrl = urlMatch[1].trim();
            if (keyMatch) supabaseKey = keyMatch[1].trim();
        }
    } catch (e) {
        console.warn('Lỗi đọc file Supabase.txt, sử dụng cấu hình mặc định:', e.message);
    }

    try {
        const ytPath = path.join(__dirname, 'youtube.txt');
        if (fs.existsSync(ytPath)) {
            const content = fs.readFileSync(ytPath, 'utf8');
            const keyMatch = content.match(/API_KEY=([^\s]+)/i) || content.match(/key=([A-Za-z0-9_-]+)/i);
            if (keyMatch) youtubeKey = keyMatch[1].trim();
        }
    } catch (e) {
        console.warn('Lỗi đọc file youtube.txt, sử dụng cấu hình mặc định:', e.message);
    }

    return { supabaseUrl, supabaseKey, youtubeKey };
}

/**
 * Định dạng số người đăng ký theo chuẩn ngắn gọn (VD: 526M, 10.2M, 500K)
 */
function formatSubscribers(num) {
    if (!num || isNaN(num)) return '0';
    num = Number(num);
    if (num >= 1e9) {
        return (num / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    }
    if (num >= 1e6) {
        return (num / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    }
    if (num >= 1e3) {
        return (num / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    }
    return num.toLocaleString();
}

/**
 * Hàm chính thực hiện đồng bộ dữ liệu từ YouTube Data API sang Supabase
 */
async function syncYouTubeData(customConfigs = {}) {
    const config = { ...loadConfigs(), ...customConfigs };
    const startTime = Date.now();
    console.log(`[YouTube Sync] Bắt đầu đồng bộ lúc ${new Date().toISOString()}`);

    // 1. Lấy danh sách toàn bộ kênh từ bảng channels trên Supabase
    const sbUrl = `${config.supabaseUrl}/rest/v1/channels?select=*`;
    const sbRes = await fetch(sbUrl, {
        method: 'GET',
        headers: {
            'apikey': config.supabaseKey,
            'Authorization': `Bearer ${config.supabaseKey}`,
            'Content-Type': 'application/json'
        }
    });

    if (!sbRes.ok) {
        throw new Error(`Lỗi kết nối Supabase: HTTP ${sbRes.status} ${sbRes.statusText}`);
    }

    const channels = await sbRes.json();
    if (!Array.isArray(channels) || channels.length === 0) {
        return {
            success: true,
            message: 'Không có kênh nào trong cơ sở dữ liệu để đồng bộ.',
            total: 0,
            updated: 0,
            durationMs: Date.now() - startTime
        };
    }

    console.log(`[YouTube Sync] Tìm thấy ${channels.length} kênh trong database Supabase.`);

    // 2. Gom nhóm truy vấn YouTube theo ID (tối đa 50 kênh / 1 request)
    const ytFoundMap = new Map();
    const batchSize = 50;

    for (let i = 0; i < channels.length; i += batchSize) {
        const batch = channels.slice(i, i + batchSize);
        const ids = batch.map(c => c.id).filter(Boolean).join(',');
        if (!ids) continue;

        const ytUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${ids}&key=${config.youtubeKey}`;
        try {
            const ytRes = await fetch(ytUrl);
            const ytData = await ytRes.json();
            if (ytData.error) {
                console.error('[YouTube Sync] Lỗi từ YouTube API:', ytData.error);
                throw new Error(`YouTube API Error: ${ytData.error.message || JSON.stringify(ytData.error)}`);
            }
            if (ytData.items && Array.isArray(ytData.items)) {
                ytData.items.forEach(item => {
                    ytFoundMap.set(item.id, item);
                });
            }
        } catch (ytErr) {
            console.error('[YouTube Sync] Lỗi khi gọi YouTube API batch:', ytErr.message);
        }
    }

    // 3. Fallback cho các kênh không tìm thấy theo ID (tìm qua @handle)
    for (const c of channels) {
        if (!ytFoundMap.has(c.id)) {
            let handle = (c.handle || '').replace(/^@/, '').trim();
            // Xử lý các handle đặc thù
            if (handle.toLowerCase() === 'sbsdrama') handle = 'sbsdrama.official';

            if (handle) {
                try {
                    const handleUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&forHandle=${encodeURIComponent(handle)}&key=${config.youtubeKey}`;
                    const hRes = await fetch(handleUrl);
                    const hData = await hRes.json();
                    if (hData.items && hData.items.length > 0) {
                        ytFoundMap.set(c.id, hData.items[0]);
                    }
                } catch (hErr) {
                    console.warn(`[YouTube Sync] Không tìm thấy kênh qua handle @${handle}:`, hErr.message);
                }
            }
        }
    }

    // 4. Cập nhật các cột trong database Supabase
    const updateResults = [];
    let updatedCount = 0;
    let failedCount = 0;

    for (const ch of channels) {
        const ytItem = ytFoundMap.get(ch.id);
        if (!ytItem || !ytItem.statistics) {
            updateResults.push({
                id: ch.id,
                name: ch.name,
                status: 'skipped',
                reason: 'Không tìm thấy thông tin trên YouTube'
            });
            continue;
        }

        const stats = ytItem.statistics;
        const subCount = Number(stats.subscriberCount || 0);
        const subFormatted = formatSubscribers(subCount);
        const vidCount = Number(stats.videoCount || 0);
        const viewCount = Number(stats.viewCount || 0);
        const now = new Date().toISOString();

        const updatePayload = {
            subscribers: subCount,
            subscribers_formatted: subFormatted,
            videos_count: vidCount,
            view_count: viewCount,
            updated_at: now
        };

        try {
            const patchUrl = `${config.supabaseUrl}/rest/v1/channels?id=eq.${encodeURIComponent(ch.id)}`;
            const patchRes = await fetch(patchUrl, {
                method: 'PATCH',
                headers: {
                    'apikey': config.supabaseKey,
                    'Authorization': `Bearer ${config.supabaseKey}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=minimal'
                },
                body: JSON.stringify(updatePayload)
            });

            if (patchRes.ok) {
                updatedCount++;
                updateResults.push({
                    id: ch.id,
                    name: ch.name,
                    status: 'success',
                    subscribers: subCount,
                    subscribers_formatted: subFormatted,
                    videos_count: vidCount,
                    view_count: viewCount
                });
            } else {
                failedCount++;
                const errText = await patchRes.text();
                updateResults.push({
                    id: ch.id,
                    name: ch.name,
                    status: 'failed',
                    error: `HTTP ${patchRes.status}: ${errText}`
                });
            }
        } catch (patchErr) {
            failedCount++;
            updateResults.push({
                id: ch.id,
                name: ch.name,
                status: 'failed',
                error: patchErr.message
            });
        }
    }

    const durationMs = Date.now() - startTime;
    console.log(`[YouTube Sync] Hoàn thành: ${updatedCount}/${channels.length} kênh đã cập nhật thành công (${durationMs}ms)`);

    return {
        success: updatedCount > 0,
        message: `Đã cập nhật ${updatedCount}/${channels.length} kênh từ YouTube API thành công`,
        timestamp: new Date().toISOString(),
        durationMs,
        total: channels.length,
        updated: updatedCount,
        failed: failedCount,
        details: updateResults
    };
}

// Cho phép chạy trực tiếp từ dòng lệnh: node youtube-sync.js
if (require.main === module) {
    syncYouTubeData()
        .then(res => {
            console.log('\n=== KẾT QUẢ ĐỒNG BỘ YOUTUBE ===');
            console.log(`Tổng số kênh: ${res.total}`);
            console.log(`Cập nhật thành công: ${res.updated}`);
            console.log(`Thất bại: ${res.failed}`);
            console.log(`Thời gian thực hiện: ${res.durationMs}ms`);
            console.log('Chi tiết 3 kênh đầu tiên:');
            console.log(res.details.slice(0, 3));
        })
        .catch(err => {
            console.error('[YouTube Sync] Lỗi nghiêm trọng:', err);
            process.exit(1);
        });
}

module.exports = {
    loadConfigs,
    formatSubscribers,
    syncYouTubeData
};
