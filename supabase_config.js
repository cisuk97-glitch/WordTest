/**
 * 🌸 Cozy Kawaii Study Room - Supabase 연결 및 로컬 스토리지 연동 모듈
 */

const SUPABASE_CONFIG = {
    // 기본 설정값 (사용자가 UI에서 변경하거나 로컬스토리지에 저장 가능)
    DEFAULT_URL: "https://your-project.supabase.co",
    DEFAULT_KEY: "your-anon-key",
    
    getUrl() {
        return localStorage.getItem("cozy_sb_url") || this.DEFAULT_URL;
    },
    
    getKey() {
        return localStorage.getItem("cozy_sb_key") || this.DEFAULT_KEY;
    },
    
    saveConfig(url, key) {
        localStorage.setItem("cozy_sb_url", url.trim());
        localStorage.setItem("cozy_sb_key", key.trim());
    },
    
    isConfigured() {
        const url = this.getUrl();
        const key = this.getKey();
        return url && !url.includes("your-project") && key && !key.includes("your-anon-key");
    }
};

let supabaseClient = null;

function initSupabase() {
    if (window.supabase && SUPABASE_CONFIG.isConfigured()) {
        try {
            supabaseClient = window.supabase.createClient(
                SUPABASE_CONFIG.getUrl(),
                SUPABASE_CONFIG.getKey()
            );
            console.log("🌸 Supabase 클라이언트 연결 성공!");
            return supabaseClient;
        } catch (e) {
            console.warn("⚠️ Supabase 초기화 오류, 로컬 모드로 작동합니다:", e);
        }
    }
    return null;
}

async function checkSupabaseHealth(url, key) {
    const targetUrl = url || SUPABASE_CONFIG.getUrl();
    const targetKey = key || SUPABASE_CONFIG.getKey();
    if (!targetUrl || !targetKey || targetUrl.includes("your-project") || targetKey.includes("your-anon-key")) {
        return { success: false, isLocal: true, message: "🟡 로컬 스토리지 모드 (Supabase 미설정)" };
    }
    if (!window.supabase) {
        return { success: false, isLocal: true, message: "⚠️ Supabase SDK 로드 대기 중" };
    }
    try {
        const tempClient = window.supabase.createClient(targetUrl.trim(), targetKey.trim());
        const { data, error } = await tempClient.from('wordbooks').select('id').limit(1);
        if (error) throw error;
        return { success: true, isLocal: false, message: "🟢 Supabase 연결 성공! (테이블 정상 응답)" };
    } catch (err) {
        return { success: false, isLocal: false, message: `🔴 연결 실패: ${err.message || '인증 또는 네트워크 오류'}` };
    }
}

window.SUPABASE_CONFIG = SUPABASE_CONFIG;
window.initSupabase = initSupabase;
window.checkSupabaseHealth = checkSupabaseHealth;
window.getSupabase = () => supabaseClient || initSupabase();
