/**
 * supabase-client.js
 * Quản lý kết nối và truy vấn dữ liệu từ Supabase Database
 * Cấu hình từ Supabase.txt:
 * Project URL: https://pmxvshdtcwxbqjdmfyll.supabase.co
 * Public Key: sb_publishable_Z2AIZpEI4dStNKVf6Plbrg_z38v_s6I
 */

const SUPABASE_CONFIG = {
    url: 'https://pmxvshdtcwxbqjdmfyll.supabase.co',
    anonKey: 'sb_publishable_Z2AIZpEI4dStNKVf6Plbrg_z38v_s6I'
};

// Khởi tạo Supabase Client nếu thư viện @supabase/supabase-js có sẵn qua CDN
let _supabaseClient = null;
try {
    if (typeof window !== 'undefined' && window.supabase && typeof window.supabase.createClient === 'function') {
        _supabaseClient = window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);
    }
} catch (e) {
    console.warn('[SupabaseService] Lỗi khi tạo Supabase Client qua SDK:', e);
}

const SupabaseService = {
    config: SUPABASE_CONFIG,
    client: _supabaseClient,

    /**
     * Lấy danh sách tất cả kênh từ bảng 'channels' trên Supabase.
     * Tự động fallback sang CHANNELS_DATA nếu gặp lỗi mạng hoặc Supabase không phản hồi.
     */
    async getChannels(options = {}) {
        const { sortBy = 'subscribers', ascending = false } = options;

        // 1. Thử truy vấn qua Supabase SDK Client
        if (_supabaseClient) {
            try {
                const query = _supabaseClient
                    .from('channels')
                    .select('*')
                    .order(sortBy, { ascending: ascending });

                const { data, error } = await query;
                if (!error && Array.isArray(data) && data.length > 0) {
                    return { data, source: 'supabase', error: null };
                }
                if (error) {
                    console.warn('[SupabaseService] SDK query error, thử chuyển sang REST API:', error);
                }
            } catch (sdkErr) {
                console.warn('[SupabaseService] SDK exception, thử chuyển sang REST API:', sdkErr);
            }
        }

        // 2. Thử truy vấn qua Direct REST API (fetch chuẩn không phụ thuộc thư viện CDN)
        try {
            const orderParam = `${sortBy}.${ascending ? 'asc' : 'desc'}`;
            const restUrl = `${SUPABASE_CONFIG.url}/rest/v1/channels?select=*&order=${orderParam}`;
            const response = await fetch(restUrl, {
                method: 'GET',
                headers: {
                    'apikey': SUPABASE_CONFIG.anonKey,
                    'Authorization': `Bearer ${SUPABASE_CONFIG.anonKey}`,
                    'Content-Type': 'application/json'
                }
            });

            if (response.ok) {
                const data = await response.json();
                if (Array.isArray(data) && data.length > 0) {
                    return { data, source: 'supabase', error: null };
                }
            } else {
                throw new Error(`Supabase REST returned HTTP ${response.status}: ${response.statusText}`);
            }
        } catch (restErr) {
            console.warn('[SupabaseService] REST fetch thất bại, chuyển sang fallback dữ liệu local:', restErr);
        }

        // 3. Fallback sang dữ liệu có sẵn trong channels-data.js (đảm bảo web luôn chạy được)
        const localData = (typeof CHANNELS_DATA !== 'undefined' && Array.isArray(CHANNELS_DATA))
            ? CHANNELS_DATA.slice()
            : [];

        // Áp dụng sắp xếp cho fallback local
        localData.sort((a, b) => {
            if (sortBy === 'subscribers') {
                return ascending ? a.subscribers - b.subscribers : b.subscribers - a.subscribers;
            }
            if (sortBy === 'published_at') {
                return ascending
                    ? new Date(a.published_at || 0) - new Date(b.published_at || 0)
                    : new Date(b.published_at || 0) - new Date(a.published_at || 0);
            }
            return 0;
        });

        return {
            data: localData,
            source: 'local',
            error: new Error('Không thể kết nối Supabase, hiển thị dữ liệu cục bộ')
        };
    },

    /**
     * Lấy thông tin chi tiết một kênh theo Channel ID.
     */
    async getChannelById(id) {
        if (!id) return { data: null, source: 'none', error: new Error('Missing channel ID') };

        // 1. Thử lấy qua Supabase SDK Client
        if (_supabaseClient) {
            try {
                const { data, error } = await _supabaseClient
                    .from('channels')
                    .select('*')
                    .eq('id', id)
                    .single();

                if (!error && data) {
                    return { data, source: 'supabase', error: null };
                }
            } catch (sdkErr) {
                console.warn('[SupabaseService] SDK getChannelById error:', sdkErr);
            }
        }

        // 2. Thử lấy qua Direct REST API
        try {
            const restUrl = `${SUPABASE_CONFIG.url}/rest/v1/channels?id=eq.${encodeURIComponent(id)}&select=*`;
            const response = await fetch(restUrl, {
                method: 'GET',
                headers: {
                    'apikey': SUPABASE_CONFIG.anonKey,
                    'Authorization': `Bearer ${SUPABASE_CONFIG.anonKey}`,
                    'Content-Type': 'application/json'
                }
            });

            if (response.ok) {
                const arr = await response.json();
                if (Array.isArray(arr) && arr.length > 0) {
                    return { data: arr[0], source: 'supabase', error: null };
                }
            }
        } catch (restErr) {
            console.warn('[SupabaseService] REST getChannelById error:', restErr);
        }

        // 3. Fallback sang local data
        if (typeof CHANNELS_DATA !== 'undefined' && Array.isArray(CHANNELS_DATA)) {
            const local = CHANNELS_DATA.find(c => c.id === id);
            if (local) {
                return { data: local, source: 'local', error: null };
            }
        }

        return { data: null, source: 'none', error: new Error('Không tìm thấy kênh') };
    },

    /**
     * Đăng ký nhận sự kiện realtime khi bảng channels có thay đổi
     */
    subscribe(onChangeCallback) {
        if (!_supabaseClient || typeof _supabaseClient.channel !== 'function') {
            return null;
        }
        try {
            const subscription = _supabaseClient
                .channel('channels-live-changes')
                .on('postgres_changes', { event: '*', schema: 'public', table: 'channels' }, payload => {
                    console.log('[Supabase Realtime] Có thay đổi dữ liệu:', payload);
                    if (typeof onChangeCallback === 'function') {
                        onChangeCallback(payload);
                    }
                })
                .subscribe();

            return subscription;
        } catch (subErr) {
            console.warn('[SupabaseService] Realtime subscribe error:', subErr);
            return null;
        }
    },

    /**
     * Cập nhật các cột (subscribers, subscribers_formatted, videos_count, view_count) từ YouTube API vào Database.
     * Hỗ trợ gọi qua API Server (/api/update-channels) hoặc chạy trực tiếp từ trình duyệt!
     */
    async syncFromYouTube(onProgress) {
        // 1. Thử gọi qua API backend server trước nếu đang chạy server.js
        try {
            const apiRes = await fetch('/api/update-channels', { method: 'POST' });
            if (apiRes.ok) {
                const apiData = await apiRes.json();
                return apiData;
            }
        } catch (e) {
            // Backend server không chạy hoặc đang mở trực tiếp file HTML, tiếp tục chạy client-side
        }

        // 2. Chế độ đồng bộ trực tiếp từ trình duyệt
        const YOUTUBE_KEY = 'AIzaSyCoccJ_YSStOgdLxct49Td3PA9z6e4aJ_A';
        const channelsRes = await this.getChannels();
        const channels = channelsRes.data || [];
        if (channels.length === 0) {
            throw new Error('Không có kênh nào trong database để cập nhật');
        }

        if (typeof onProgress === 'function') {
            onProgress({ status: 'fetching_youtube', current: 0, total: channels.length, message: 'Đang truy vấn YouTube Data API v3...' });
        }

        // Gom nhóm 50 IDs truy vấn YouTube
        const ytFoundMap = new Map();
        const allIds = channels.map(c => c.id).filter(Boolean).join(',');
        try {
            const ytUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${allIds}&key=${YOUTUBE_KEY}`;
            const ytRes = await fetch(ytUrl);
            const ytData = await ytRes.json();
            if (ytData.items) {
                ytData.items.forEach(it => ytFoundMap.set(it.id, it));
            }
        } catch (ytErr) {
            console.warn('[SupabaseService] Batch fetch YouTube error:', ytErr);
        }

        // Fallback qua @handle cho kênh chưa khớp ID
        for (const c of channels) {
            if (!ytFoundMap.has(c.id)) {
                let handle = (c.handle || '').replace(/^@/, '').trim();
                if (handle.toLowerCase() === 'sbsdrama') handle = 'sbsdrama.official';
                if (handle) {
                    try {
                        const hUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&forHandle=${encodeURIComponent(handle)}&key=${YOUTUBE_KEY}`;
                        const hRes = await fetch(hUrl);
                        const hData = await hRes.json();
                        if (hData.items && hData.items.length > 0) {
                            ytFoundMap.set(c.id, hData.items[0]);
                        }
                    } catch (hErr) {
                        console.warn('[SupabaseService] Handle fetch error:', hErr);
                    }
                }
            }
        }

        function formatSub(num) {
            if (!num || isNaN(num)) return '0';
            num = Number(num);
            if (num >= 1e9) return (num / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
            if (num >= 1e6) return (num / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
            if (num >= 1e3) return (num / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
            return num.toLocaleString();
        }

        let updated = 0;
        for (let i = 0; i < channels.length; i++) {
            const ch = channels[i];
            const ytItem = ytFoundMap.get(ch.id);
            if (!ytItem || !ytItem.statistics) continue;

            const subCount = Number(ytItem.statistics.subscriberCount || 0);
            const subFmt = formatSub(subCount);
            const vidCount = Number(ytItem.statistics.videoCount || 0);
            const viewCount = Number(ytItem.statistics.viewCount || 0);

            try {
                const patchUrl = `${SUPABASE_CONFIG.url}/rest/v1/channels?id=eq.${encodeURIComponent(ch.id)}`;
                const patchRes = await fetch(patchUrl, {
                    method: 'PATCH',
                    headers: {
                        'apikey': SUPABASE_CONFIG.anonKey,
                        'Authorization': `Bearer ${SUPABASE_CONFIG.anonKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        subscribers: subCount,
                        subscribers_formatted: subFmt,
                        videos_count: vidCount,
                        view_count: viewCount,
                        updated_at: new Date().toISOString()
                    })
                });
                if (patchRes.ok) updated++;
            } catch (err) {
                console.warn('[SupabaseService] Update failed for', ch.name, err);
            }

            if (typeof onProgress === 'function') {
                onProgress({
                    status: 'updating_supabase',
                    current: i + 1,
                    total: channels.length,
                    updated,
                    message: `Đang lưu Supabase: ${i + 1}/${channels.length} (${ch.name})`
                });
            }
        }

        return {
            success: updated > 0,
            message: `Đã cập nhật ${updated}/${channels.length} kênh từ YouTube API thành công`,
            total: channels.length,
            updated
        };
    }
};

// Đưa ra window / global / module để các script khác sử dụng
if (typeof window !== 'undefined') {
    window.SupabaseService = SupabaseService;
}
if (typeof global !== 'undefined') {
    global.SupabaseService = SupabaseService;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SupabaseService;
}
