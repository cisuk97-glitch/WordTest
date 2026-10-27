/**
 * 🌸 Cozy Kawaii Study Room - Main Application Engine
 * 에빙하우스 간격반복 단어장 & 주관식 테스트 & 플래너(schedules) 연동
 */

// 1. 앱 전역 상태 (State)
const AppState = {
  currentView: "study",
  wordbooks: [],
  activeWordbookId: null,
  // 일일 학습 목표 설정 (신규 학습량)
  settings: {
    targetNewWords: 10
  },
  words: [],
  // 단어별 에빙하우스 진도 (wordId -> progress 객체)
  progressMap: {},

  // 현재 플래시카드 인덱스
  studyIndex: 0,
  studyQueue: [],

  // 주관식 테스트 세션
  testSession: {
    sessionId: null,
    questions: [],
    currentIndex: 0,
    startTime: null,
    timerInterval: null,
    elapsedSeconds: 0,
    results: [] // { word, questionType, userAnswer, isCorrect, timeMs }
  },

  // 캔버스 필기 설정
  canvasTool: "pen", // 'pen' | 'highlighter' | 'eraser'
  canvasHistory: [],
  isDrawing: false,
  lastX: 0,
  lastY: 0,


  // 오늘 단어 목록 & 인쇄 상태
  wordlistState: {
    filter: "all", // "all" | "new" | "review" | "vulnerable"
    search: "",
    sort: "unit", // "unit" | "alpha" | "weak"
    hideMeaning: false,
    hideExample: false
  },

  // 채점 후 오답 단어 전체 보기 학습 상태
  wrongWordsList: [],
  wrongStudyState: {
    hideMeaning: false,
    hideExample: false
  }
};

// 3. 에빙하우스 간격 상수 (일 단위)
const EBBINGHAUS_INTERVALS = [1, 3, 7, 14, 30, 60];

// ============================================================================
// 상태 초기화 (원격 Supabase 연동 모드)
// ============================================================================
function loadLocalState() {
  // 이전 로컬 DB 잔여 캐시 완전 제거 (Supabase DB 전면 연동)
  localStorage.removeItem("cozy_wordbooks");
  localStorage.removeItem("cozy_words");
  localStorage.removeItem("cozy_progress");
  localStorage.removeItem("cozy_study_goals");
  localStorage.removeItem("cozy_schedules");

  AppState.wordbooks = [];
  AppState.words = [];
  AppState.progressMap = {};

  const savedActiveBookId = localStorage.getItem("cozy_active_wordbook_id");
  if (savedActiveBookId) {
    AppState.activeWordbookId = Number(savedActiveBookId);
  }
}

function saveLocalState() {
  // 로컬 DB 저장 완전 제거 - 활성 단어장 선택 ID만 가볍게 보존
  if (AppState.activeWordbookId) {
    localStorage.setItem("cozy_active_wordbook_id", AppState.activeWordbookId);
  }
}

// ============================================================================
// 🌸 유저 ID 식별자 및 로컬 진도 Supabase 연동 헬퍼
// ============================================================================
const GUEST_USER_ID = "00000000-0000-0000-0000-000000000001";

async function getEffectiveUserId(sb) {
  if (sb && sb.auth) {
    try {
      const { data } = await sb.auth.getUser();
      if (data?.user?.id) return data.user.id;
    } catch (e) { }
  }
  return window.SUPABASE_CONFIG ? window.SUPABASE_CONFIG.getUserId() : GUEST_USER_ID;
}

// ============================================================================
// 🌸 Supabase words 테이블 최신 단어 & 예문 동기화 엔진 (원격 DB 단독 연동)
// ============================================================================
async function syncWordsFromSupabase(wordbookId) {
  const sb = window.getSupabase();
  if (!sb || !window.SUPABASE_CONFIG || !window.SUPABASE_CONFIG.isConfigured()) {
    AppState.wordbooks = [];
    AppState.words = [];
    AppState.progressMap = {};
    updateWordbookSelectDropdown();
    renderFlashcard();
    renderWordListView();
    updateSidebarStats();
    renderWordbooksList();
    return false;
  }

  try {
    // 1. 단어장 메타정보(wordbooks) 최신 동기화
    const { data: bData, error: bErr } = await sb
      .from("wordbooks")
      .select("*")
      .order("id", { ascending: true });

    if (bErr) throw bErr;

    if (!bData || bData.length === 0) {
      AppState.wordbooks = [];
      AppState.words = [];
      AppState.progressMap = {};
      AppState.activeWordbookId = null;
      updateWordbookSelectDropdown();
      renderFlashcard();
      renderWordListView();
      updateSidebarStats();
      renderWordbooksList();
      return true;
    }

    AppState.wordbooks = bData;
    const requestedId = wordbookId || AppState.activeWordbookId;
    if (requestedId && bData.some(b => Number(b.id) === Number(requestedId))) {
      AppState.activeWordbookId = Number(requestedId);
    } else {
      AppState.activeWordbookId = Number(bData[0].id);
    }

    const activeBook = bData.find(b => Number(b.id) === Number(AppState.activeWordbookId));
    if (activeBook && activeBook.daily_new_target) {
      AppState.settings.targetNewWords = Number(activeBook.daily_new_target);
    }

    // 2. 단어 테이블(words) 로드 (PostgREST 1000행 제한 대응 페이지네이션)
    const targetBookId = AppState.activeWordbookId;
    let allFetchedWords = [];
    let from = 0;
    const pageSize = 1000;
    let hasMore = true;

    while (hasMore) {
      let query = sb
        .from("words")
        .select("*")
        .order("id", { ascending: true })
        .range(from, from + pageSize - 1);

      if (targetBookId) {
        query = query.eq("wordbook_id", Number(targetBookId));
      }

      const { data, error } = await query;
      if (error) {
        console.error("Supabase words fetch error:", error);
        throw error;
      }

      if (data && data.length > 0) {
        allFetchedWords = allFetchedWords.concat(data);
        if (data.length < pageSize) {
          hasMore = false;
        } else {
          from += pageSize;
        }
      } else {
        hasMore = false;
      }
    }

    AppState.words = allFetchedWords;
    AppState.progressMap = {};

    // 3. 사용자 진도 테이블(user_word_progress) 동기화
    const userId = await getEffectiveUserId(sb);
    if (userId) {
      const { data: pData, error: pErr } = await sb
        .from("user_word_progress")
        .select("*")
        .eq("user_id", userId);
      if (pErr) console.warn("Progress sync warning:", pErr);
      if (pData && pData.length > 0) {
        pData.forEach(p => {
          AppState.progressMap[p.word_id] = p;
        });
      }
    }

    // 진도 맵 보정 (미등록 단어 기본 상태)
    AppState.words.forEach(w => {
      if (!AppState.progressMap[w.id]) {
        AppState.progressMap[w.id] = {
          word_id: w.id,
          user_status: "new",
          review_stage: 0,
          consecutive_correct: 0,
          total_tests: 0,
          total_correct: 0,
          total_wrong: 0,
          is_vulnerable: false,
          next_review_at: null,
          last_tested_at: null
        };
      }
    });

    saveLocalState();
    updateWordbookSelectDropdown();
    renderFlashcard();
    renderWordListView();
    updateSidebarStats();
    renderWordbooksList();
    if (document.getElementById("view-stats")?.classList.contains("active") || AppState.currentView === "stats") {
      renderStatsDashboard();
    }
    console.log(`🌸 Supabase에서 ${allFetchedWords.length}개 단어(예문 포함) 동기화 완료!`);
    return true;
  } catch (err) {
    console.error("Supabase sync failed:", err);
    alert("⚠️ Supabase 데이터 로드 실패: " + (err.message || err));
    return false;
  }
}

// ============================================================================
// 에빙하우스 스케줄러 알고리즘
// ============================================================================
function updateEbbinghausProgress(wordId, isCorrect, responseTimeMs, questionType, userAnswer) {
  let prog = AppState.progressMap[wordId];
  if (!prog) {
    prog = {
      word_id: wordId,
      user_status: "learning",
      review_stage: 0,
      consecutive_correct: 0,
      total_tests: 0,
      total_correct: 0,
      total_wrong: 0,
      is_vulnerable: false
    };
  }

  prog.total_tests += 1;
  const now = new Date();
  prog.last_tested_at = now.toISOString();

  if (isCorrect) {
    prog.total_correct += 1;
    prog.consecutive_correct += 1;
    prog.review_stage = Math.min(prog.review_stage + 1, 6);

    // 복습 주기 (일) 계산 (자정 00:00:00 기준)
    const intervalDays = EBBINGHAUS_INTERVALS[Math.max(0, prog.review_stage - 1)];
    const nextDate = new Date();
    nextDate.setDate(nextDate.getDate() + intervalDays);
    nextDate.setHours(0, 0, 0, 0);
    prog.next_review_at = nextDate.toISOString();

    if (prog.review_stage >= 3) {
      prog.is_vulnerable = false; // 숙련 진입 시 취약 해제
    }
    prog.user_status = prog.review_stage >= 5 ? "mastered" : "learning";
  } else {
    prog.total_wrong += 1;
    prog.consecutive_correct = 0;
    prog.review_stage = Math.max(1, Math.floor(prog.review_stage / 2));
    prog.is_vulnerable = true; // 오답 발생 시 취약 단어로 분류

    // 당일 즉시 재복습 가능하도록 당일 자정(00:00:00) 편성
    const nextDate = new Date();
    nextDate.setHours(0, 0, 0, 0);
    prog.next_review_at = nextDate.toISOString();
    prog.user_status = "weak";
  }

  const accuracy = (prog.total_correct / prog.total_tests) * 100;
  prog.recent_accuracy = Math.round(accuracy * 10) / 10;
  AppState.progressMap[wordId] = prog;

  // Supabase 동기화 (게스트/로그인 모두 지원, 원격 DB 직접 upsert)
  const sb = window.getSupabase();
  if (sb && SUPABASE_CONFIG.isConfigured()) {
    getEffectiveUserId(sb).then(userId => {
      if (userId) {
        sb.from("user_word_progress").upsert({
          user_id: userId,
          word_id: wordId,
          user_status: prog.user_status,
          review_stage: prog.review_stage,
          is_vulnerable: prog.is_vulnerable,
          total_tests: prog.total_tests,
          total_correct: prog.total_correct,
          total_wrong: prog.total_wrong,
          consecutive_correct: prog.consecutive_correct,
          recent_accuracy: prog.recent_accuracy,
          next_review_at: prog.next_review_at,
          last_tested_at: prog.last_tested_at
        }, { onConflict: "user_id,word_id" })
        .then(({ error }) => {
          if (error) console.error("❌ [user_word_progress] DB 저장 실패:", error);
        })
        .catch(err => console.error("Supabase progress upsert error:", err));
      }
    });
  }
}

// ============================================================================
// 기존 플래너(schedules) 테이블 자동 연동
// ============================================================================
async function syncToSchedulesPlanner(summary) {
  const recordId = "test_" + Date.now();
  const scheduleData = {
    id: recordId,
    lesson_id: null,
    subject: summary.subject || "영어",
    date: summary.date,
    category: "단어테스트",
    title: summary.title,
    detail: summary.detail,
    progress: 100,
    score: summary.score,
    duration_sec: summary.duration_sec,
    completed: true,
    updated_at: new Date().toISOString()
  };

  // Supabase schedules 테이블 삽입 (원격 DB 직접 적재)
  const sb = window.getSupabase();
  if (sb && SUPABASE_CONFIG.isConfigured()) {
    try {
      const { error } = await sb.from("schedules").insert([scheduleData]);
      if (error) {
        console.error("⚠️ schedules 테이블 삽입 실패:", error.message);
      } else {
        console.log("🌸 플래너(schedules) 연동 성공!");
      }
    } catch (e) {
      console.error("Supabase schedules insert exception:", e);
    }
  }

  // 결과 화면 안내 업데이트
  const noticeEl = document.getElementById("resPlannerDetail");
  if (noticeEl) {
    noticeEl.textContent = `${scheduleData.title} - ${scheduleData.detail} (풀이시간: ${scheduleData.duration_sec}초)`;
  }
}

// ============================================================================
// 뷰 네비게이션 & 통계 갱신
// ============================================================================
function switchView(viewName) {
  AppState.currentView = viewName;
  document.querySelectorAll(".view-section").forEach(sec => {
    sec.style.display = "none";
  });

  const targetSec = document.getElementById(`view-${viewName}`);
  if (targetSec) targetSec.style.display = "block";

  document.querySelectorAll(".drawer-nav-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.view === viewName);
  });

  if (viewName === "study") {
    renderFlashcard();
  } else if (viewName === "test") {
    startSubjectiveTest();
  } else if (viewName === "wordlist") {
    renderWordListView();
  } else if (viewName === "wordbooks") {
    renderWordbooksList();
  } else if (viewName === "stats") {
    renderStatsDashboard();
  } else if (viewName === "wrong-study") {
    renderWrongWordsStudyList();
  }
  updateSidebarStats();
}

function updateSidebarStats() {
  const now = new Date();
  const todayStr = now.toDateString();
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  let todayNew = 0;
  let todayReview = 0;
  let vulnerableCount = 0;
  let totalTests = 0;
  let totalCorrect = 0;

  // 오늘 완료한 단어 수
  let completedNew = 0;
  let completedReview = 0;

  AppState.words.forEach(w => {
    const prog = AppState.progressMap[w.id];
    if (!prog || prog.review_stage === 0) {
      todayNew++;
    } else {
      if (prog.next_review_at && new Date(prog.next_review_at) <= todayEnd) {
        todayReview++;
      }
    }
    if (prog?.is_vulnerable) vulnerableCount++;
    if (prog?.total_tests) {
      totalTests += prog.total_tests;
      totalCorrect += prog.total_correct;
    }

    if (prog && prog.last_tested_at && new Date(prog.last_tested_at).toDateString() === todayStr) {
      if (prog.total_tests <= 1 || prog.review_stage === 1) {
        completedNew++;
      } else {
        completedReview++;
      }
    }
  });

  const accuracy = totalTests > 0 ? Math.round((totalCorrect / totalTests) * 100) : 0;

  // 오늘 총 복습 대상 = 오늘 이미 완료한 복습 + 현재 복습 차례인 단어
  const totalReviewTarget = completedReview + todayReview;
  const targetNew = AppState.settings.targetNewWords || 10;

  // 좌측 서랍 스티커: 진행수 / 목표수 형태
  const statTodayNewEl = document.getElementById("statTodayNew");
  const statTodayReviewEl = document.getElementById("statTodayReview");
  if (statTodayNewEl) statTodayNewEl.textContent = `${completedNew} / ${targetNew}`;
  if (statTodayReviewEl) statTodayReviewEl.textContent = `${completedReview} / ${totalReviewTarget}`;

  const statAccEl = document.getElementById("statAccuracy");
  if (statAccEl) statAccEl.textContent = `${accuracy}%`;
  const statVulEl = document.getElementById("statVulnerable");
  if (statVulEl) statVulEl.textContent = vulnerableCount;

  // 상단 네비게이션 바 진도율: 오늘 학습 단어수의 총합계
  const totalTarget = targetNew + totalReviewTarget;
  const totalCompleted = completedNew + completedReview;
  const pct = totalTarget > 0 ? Math.min(100, Math.round((totalCompleted / totalTarget) * 100)) : 0;

  const progressFill = document.getElementById("topProgressFill");
  const progressText = document.getElementById("topProgressText");
  const progressPill = document.getElementById("topProgressPill");

  if (progressFill) progressFill.style.width = `${pct}%`;
  if (progressText) progressText.textContent = `${totalCompleted}/${totalTarget}`;
  if (progressPill) {
    progressPill.title = `오늘의 진도: ${totalCompleted}/${totalTarget} (신규 ${completedNew}/${targetNew} · 복습 ${completedReview}/${totalReviewTarget}) - 클릭하여 목표 변경`;
  }
}

// ============================================================================
// 🏷️ 품사 네모 박스 배지 및 줄바꿈 포맷팅 헬퍼
// ============================================================================
function formatMeaningToHtml(meaningStr) {
  if (!meaningStr) return "";
  const escaped = String(meaningStr)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped.replace(/\[(동|명|형|부|전|접|대)\]/g, '<span class="pos-box">$1</span>');
}

// ============================================================================
// 💡 예문 Fallback 추출 및 오늘 학습 큐 헬퍼
// ============================================================================
function getWordExamples(w) {
  if (!w) return { ex1En: "", ex1Kr: "", ex2En: "", ex2Kr: "", hasEx1: false, hasEx2: false };

  // 예문 1 추출 (다양한 필드명 지원)
  const ex1En = (
    w.example_1 ||
    w.example ||
    w.example_en ||
    w.sentence ||
    w.example_sentence ||
    w.ex1 ||
    w.ex ||
    w["예문1"] ||
    w["예문"] ||
    ""
  ).toString().trim();

  const ex1Kr = (
    w.example_1_trans ||
    w.example_trans ||
    w.example_ko ||
    w.example_kr ||
    w.sentence_translation ||
    w.sentence_ko ||
    w.ex1_trans ||
    w.trans ||
    w["예문1해석"] ||
    w["해석"] ||
    w["예문해석"] ||
    ""
  ).toString().trim();

  // 예문 2 추출 (존재 여부 철저 검증)
  const ex2En = (
    w.example_2 ||
    w.example_2_en ||
    w.sentence_2 ||
    w.sentence2 ||
    w.ex2 ||
    w["예문2"] ||
    ""
  ).toString().trim();

  const ex2Kr = (
    w.example_2_trans ||
    w.example_2_ko ||
    w.example_2_kr ||
    w.sentence_2_translation ||
    w.sentence_2_ko ||
    w.ex2_trans ||
    w["예문2해석"] ||
    ""
  ).toString().trim();

  return {
    ex1En,
    ex1Kr,
    ex2En,
    ex2Kr,
    hasEx1: Boolean(ex1En),
    hasEx2: Boolean(ex2En)
  };
}

function getTodayStudyWords() {
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  const allNewWords = AppState.words.filter(w => {
    const prog = AppState.progressMap[w.id];
    return !prog || prog.review_stage === 0;
  });

  const allReviewWords = AppState.words.filter(w => {
    const prog = AppState.progressMap[w.id];
    return prog && prog.review_stage > 0 && prog.next_review_at && new Date(prog.next_review_at) <= todayEnd;
  });

  const targetNewCount = AppState.settings.targetNewWords || 10;
  const todayNewWords = allNewWords.slice(0, targetNewCount);
  const todayReviewWords = allReviewWords; // 망각곡선 도래 단어 전량 포함
  const todayWords = [...todayNewWords, ...todayReviewWords];

  return {
    todayWords: todayWords.length > 0 ? todayWords : AppState.words,
    todayNewWords,
    todayReviewWords,
    allNewWords,
    allReviewWords
  };
}

function getCurrentStudyWord() {
  const { todayWords } = getTodayStudyWords();
  const pool = todayWords.length > 0 ? todayWords : AppState.words;
  if (!pool || pool.length === 0) return null;
  return pool[AppState.studyIndex % pool.length];
}

// ============================================================================
// 플래시카드 학습 모드
// ============================================================================
function renderFlashcard() {
  const { todayWords } = getTodayStudyWords();
  const pool = todayWords.length > 0 ? todayWords : AppState.words;

  if (pool.length === 0) {
    document.getElementById("cardUnitBadge").textContent = "안내";
    document.getElementById("cardStageBadge").textContent = "단어장 없음";
    document.getElementById("cardWordText").textContent = "단어장이 비어 있습니다 🌸";
    document.getElementById("cardPronounceText").textContent = "";
    const meaningBox = document.getElementById("cardMeaningBox");
    meaningBox.textContent = "상단의 '단어장 관리' 메뉴에서 새 단어장을 등록해주세요!";
    meaningBox.classList.remove("hidden-blur");
    const exEnEl = document.getElementById("cardExEn");
    if (exEnEl) exEnEl.textContent = "등록된 단어가 없습니다.";
    const exKrEl = document.getElementById("cardExKr");
    if (exKrEl) exKrEl.textContent = "";
    const ex2Wrap = document.getElementById("cardEx2Wrap");
    if (ex2Wrap) ex2Wrap.style.display = "none";
    return;
  }

  const w = pool[AppState.studyIndex % pool.length];
  const prog = AppState.progressMap[w.id] || {};

  document.getElementById("cardUnitBadge").textContent = w.unit || "Unit 01";
  const stage = prog.review_stage || 0;
  const stageNames = ["🌱 미학습", "🌸 1단계(1일)", "🌷 2단계(3일)", "🌿 3단계(7일)", "🍀 4단계(14일)", "⭐ 5단계(30일)", "👑 완전숙련"];
  document.getElementById("cardStageBadge").textContent = stageNames[stage] || "학습 중";

  document.getElementById("cardWordText").textContent = w.word;
  document.getElementById("cardPronounceText").textContent = w.pronunciation || "";

  const meaningBox = document.getElementById("cardMeaningBox");
  meaningBox.innerHTML = formatMeaningToHtml(w.meaning);
  meaningBox.classList.remove("hidden-blur");

  const { ex1En, ex1Kr, ex2En, ex2Kr, hasEx1, hasEx2 } = getWordExamples(w);

  // 예문 1 렌더링
  const exEnEl = document.getElementById("cardExEn");
  const exKrEl = document.getElementById("cardExKr");
  if (exEnEl) exEnEl.textContent = hasEx1 ? ex1En : "예문이 등록되지 않았습니다.";
  if (exKrEl) exKrEl.textContent = hasEx1 ? ex1Kr : "";

  // 예문 2 조건부 렌더링 (있을 때만 노출)
  const ex2Wrap = document.getElementById("cardEx2Wrap");
  const exEn2El = document.getElementById("cardExEn2");
  const exKr2El = document.getElementById("cardExKr2");

  if (ex2Wrap) {
    if (hasEx2) {
      ex2Wrap.style.display = "block";
      if (exEn2El) exEn2El.textContent = ex2En;
      if (exKr2El) exKr2El.textContent = ex2Kr;
    } else {
      ex2Wrap.style.display = "none";
      if (exEn2El) exEn2El.textContent = "";
      if (exKr2El) exKr2El.textContent = "";
    }
  }
}

function speakWord(word) {
  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
    const ut = new SpeechSynthesisUtterance(word);
    ut.lang = "en-US";
    ut.rate = 0.9;
    window.speechSynthesis.speak(ut);
  }
}

// ============================================================================
// 스마트 채점 알고리즘 엔진 (English3 이식)
// 한글 자모 분해, 편집거리 85% 유사도 오타 참작, 복수 뜻 인정
// ============================================================================
const CHOSUNG = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
const JUNGSUNG = ['ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ', 'ㅙ', 'ㅚ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ'];
const JONGSUNG = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

function decomposeHangul(text) {
  if (!text) return '';
  const result = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xAC00 && code <= 0xD7A3) {
      const sIndex = code - 0xAC00;
      const cho = Math.floor(sIndex / 588);
      const jung = Math.floor((sIndex % 588) / 28);
      const jong = sIndex % 28;
      result.push(CHOSUNG[cho]);
      result.push(JUNGSUNG[jung]);
      if (jong > 0) {
        result.push(JONGSUNG[jong]);
      }
    } else {
      result.push(text[i]);
    }
  }
  return result.join('');
}

function levenshteinDistance(s1, s2) {
  if (s1 === s2) return 0;
  if (!s1 || s1.length === 0) return (s2 || '').length;
  if (!s2 || s2.length === 0) return (s1 || '').length;

  const len1 = s1.length;
  const len2 = s2.length;
  const d = [];

  for (let i = 0; i <= len1; i++) d[i] = [i];
  for (let j = 0; j <= len2; j++) d[0][j] = j;

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost
      );
    }
  }
  return d[len1][len2];
}

function cleanText(text, stripParens = true) {
  if (!text) return '';
  let str = text.toLowerCase()
    .replace(/\[[^\]]*\]/g, '') // 품사 태그 [명], [동] 등 제거
    .replace(/[0-9]+\./g, '');   // 1., 2. 번호 제거

  if (stripParens) {
    const withoutParens = str.replace(/\([^)]*\)/g, '');
    // 괄호 내용 지웠을 때 빈 문자열이 아니면 괄호 제외 버전 채택
    if (withoutParens.replace(/[\s~·,/()[\]\-_\'".!?~;:+]/g, '')) {
      str = withoutParens;
    }
  }

  return str.replace(/[\s~·,/()[\]\-_\'".!?~;:+]/g, '');
}

function gradeAnswer(userInput, targetAnswer, isEnglish = false) {
  const uClean = cleanText(userInput, false);
  const tClean = cleanText(targetAnswer, true);

  if (!uClean) {
    return { isCorrect: false, isTypo: false, notice: '', matchedAnswer: targetAnswer };
  }

  // 1. 단순 완전 일치
  if (uClean === tClean || uClean === cleanText(targetAnswer, false)) {
    return { isCorrect: true, isTypo: false, notice: '', matchedAnswer: targetAnswer };
  }

  // 2. 영단어 채점 모드
  if (isEnglish) {
    const dist = levenshteinDistance(uClean, tClean);
    if ((tClean.length >= 5 && dist <= 1) || (tClean.length >= 8 && dist <= 2)) {
      return {
        isCorrect: true,
        isTypo: true,
        notice: `💡 살짝 오타: 원래 표기는 '${targetAnswer}'`,
        matchedAnswer: targetAnswer
      };
    }
    return { isCorrect: false, isTypo: false, notice: '', matchedAnswer: targetAnswer };
  }

  // 3. 한글 뜻 채점 모드 (복수 뜻 분할 및 오타 참작)
  const rawCandidates = targetAnswer
    .replace(/\[[^\]]*\]/g, '')
    .split(/(?:[,/·;\n]|\b[0-9]+\.|\s[0-9]+\.)/)
    .map(c => c.trim())
    .filter(Boolean);

  const candidateList = rawCandidates.length > 0 ? rawCandidates : [targetAnswer];

  for (const cand of candidateList) {
    const cClean = cleanText(cand, true);
    const cCleanWithParens = cleanText(cand, false);
    if (!cClean && !cCleanWithParens) continue;

    const targets = Array.from(new Set([cClean, cCleanWithParens].filter(Boolean)));

    for (const target of targets) {
      // 3-1. 후보 뜻과 완전 일치
      if (uClean === target) {
        return { isCorrect: true, isTypo: false, notice: '', matchedAnswer: cand };
      }

      // 3-2. 동사 어근 일치 ('시작하다' <-> '시작', '강조하다' <-> '강조')
      if (target.endsWith('하다') && uClean === target.slice(0, -2)) {
        return { isCorrect: true, isTypo: false, notice: '', matchedAnswer: cand };
      }
      if (uClean.endsWith('하다') && target === uClean.slice(0, -2)) {
        return { isCorrect: true, isTypo: false, notice: '', matchedAnswer: cand };
      }

      // 3-3. 접미사 '~시키다', '~되다' 대응
      if ((target.endsWith('시키다') || target.endsWith('되다')) && uClean === target.slice(0, -3)) {
        return { isCorrect: true, isTypo: false, notice: '', matchedAnswer: cand };
      }
      if ((uClean.endsWith('시키다') || uClean.endsWith('되다')) && target === uClean.slice(0, -3)) {
        return { isCorrect: true, isTypo: false, notice: '', matchedAnswer: cand };
      }

      // 3-4. 포함(includes) 일치 (2글자 이상)
      if (target.length >= 2 && uClean.length >= 2) {
        if (target.includes(uClean) || uClean.includes(target)) {
          return { isCorrect: true, isTypo: false, notice: '', matchedAnswer: cand };
        }
      }
    }

    // 3-5. 한글 자모 분해 후 Levenshtein 편집거리 유사도 85% 이상 판별
    const uJamo = decomposeHangul(uClean);
    const cJamo = decomposeHangul(cClean);
    const jDist = levenshteinDistance(uJamo, cJamo);
    const maxLen = Math.max(uJamo.length, cJamo.length);

    if (maxLen > 0) {
      const similarity = 1.0 - (jDist / maxLen);
      if (similarity >= 0.85) {
        return {
          isCorrect: true,
          isTypo: true,
          notice: `💡 살짝 오타: 원래 표기는 '${cand}'`,
          matchedAnswer: cand
        };
      }
    }
  }

  return { isCorrect: false, isTypo: false, notice: '', matchedAnswer: targetAnswer };
}

// ============================================================================
// 주관식 단어 테스트 엔진 (Row-based Single Page Test)
// ============================================================================
function startSubjectiveTest(wordsOverride) {
  if (!AppState.words || AppState.words.length === 0) {
    alert("학습할 단어가 없습니다. 먼저 단어장을 등록해주세요 🌸");
    switchView("wordbooks");
    return;
  }
  const session = AppState.testSession;
  session.sessionId = "session_" + Date.now();
  session.currentIndex = 0;
  session.results = [];
  session.userAnswers = {};
  session.elapsedSeconds = 0;
  session.startTime = Date.now();

  let pool = [];
  if (wordsOverride && wordsOverride.length > 0) {
    pool = [...wordsOverride];
  } else {
    // 오늘의 학습 단어(todayWords) 추출, 없으면 전체 단어 fallback
    const { todayWords } = getTodayStudyWords();
    pool = (todayWords && todayWords.length > 0) ? [...todayWords] : [...AppState.words];
  }

  // 무작위 셔플 (랜덤 순서 출제)
  pool.sort(() => Math.random() - 0.5);

  // 영어 단어 보고 한글 뜻 작성하기 단일 유형(en_to_kr)으로 전 문제 구성
  session.questions = pool.map((w, idx) => ({
    index: idx + 1,
    word: w,
    questionType: "en_to_kr",
    prompt: w.word,
    targetAnswer: w.meaning
  }));

  // 스톱워치 가동
  if (session.timerInterval) clearInterval(session.timerInterval);
  const stopwatchEl = document.getElementById("testStopwatch");
  if (stopwatchEl) stopwatchEl.textContent = "00:00";

  session.timerInterval = setInterval(() => {
    session.elapsedSeconds++;
    const m = String(Math.floor(session.elapsedSeconds / 60)).padStart(2, "0");
    const s = String(session.elapsedSeconds % 60).padStart(2, "0");
    if (stopwatchEl) stopwatchEl.textContent = `${m}:${s}`;
  }, 1000);

  renderTestQuestions();
}

function renderTestQuestions() {
  const session = AppState.testSession;
  const container = document.getElementById("testRowsContainer");
  if (!container) return;
  container.innerHTML = "";

  session.questions.forEach((q, idx) => {
    const row = document.createElement("div");
    const existingVal = session.userAnswers[idx] || "";
    row.className = `test-row ${existingVal.trim() ? "answered" : ""}`;
    row.dataset.rowIdx = idx;

    row.innerHTML = `
      <span class="test-row-num">Q${q.index}</span>
      <div class="test-row-prompt">
        <span class="test-prompt-text" title="${q.prompt}">${q.prompt}</span>
        <span class="test-prompt-badge">🇺🇸 ➔ 🇰🇷</span>
      </div>
      <div class="test-row-input-wrap">
        <input type="text" class="test-row-input subjective-input" 
          data-qidx="${idx}" 
          placeholder="한글 뜻 입력..." 
          value="${existingVal}"
          autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
      </div>
    `;

    const inputEl = row.querySelector(".test-row-input");

    inputEl.addEventListener("input", (e) => {
      const val = e.target.value;
      session.userAnswers[idx] = val;
      row.classList.toggle("answered", Boolean(val.trim()));
      updateTestProgress();
    });

    // Enter 키 입력 시 다음 번호 입력창으로 자동 포커스 이동
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const nextInput = container.querySelector(`.test-row-input[data-qidx="${idx + 1}"]`);
        if (nextInput) {
          nextInput.focus();
        } else {
          inputEl.blur();
        }
      }
    });

    container.appendChild(row);
  });

  updateTestProgress();

  // 첫 번째 문제 입력창으로 자동 포커스
  const firstInput = container.querySelector('.test-row-input[data-qidx="0"]');
  if (firstInput) {
    setTimeout(() => firstInput.focus(), 100);
  }
}

function updateTestProgress() {
  const session = AppState.testSession;
  if (!session.questions || session.questions.length === 0) return;
  const answeredCount = Object.values(session.userAnswers || {}).filter(v => v && v.trim()).length;
  const total = session.questions.length;
  const pct = total > 0 ? Math.round((answeredCount / total) * 100) : 0;

  const bar = document.getElementById("testProgressBar");
  const text = document.getElementById("testProgressText");
  if (bar) bar.style.width = `${pct}%`;
  if (text) text.textContent = `${answeredCount} / ${total}`;
}

async function submitAndGradeTest() {
  const session = AppState.testSession;
  const total = session.questions.length;
  if (total === 0) return;

  const answeredCount = Object.values(session.userAnswers || {}).filter(v => v && v.trim()).length;
  if (answeredCount < total) {
    if (!confirm(`아직 작성하지 않은 문제가 있어요! (${answeredCount}/${total}문제 작성됨)\n이대로 채점할까요?`)) {
      return;
    }
  }

  // 타이머 정지
  if (session.timerInterval) {
    clearInterval(session.timerInterval);
    session.timerInterval = null;
  }

  let correctCount = 0;
  session.results = [];

  const testContainer = document.getElementById("testRowsContainer");

  session.questions.forEach((q, idx) => {
    const userAns = (session.userAnswers[idx] || "").trim();
    const w = q.word;
    const targetMeaning = w.meaning;

    // 스마트 채점 엔진 호출
    const gradeResult = gradeAnswer(userAns, targetMeaning, false);
    const isCorrect = gradeResult.isCorrect;

    if (isCorrect) {
      correctCount++;
    }

    // 에빙하우스 간격 업데이트
    updateEbbinghausProgress(w.id, isCorrect, 1000, "en_to_kr", userAns);

    session.results.push({
      word: w,
      questionType: "en_to_kr",
      userAnswer: userAns,
      isCorrect,
      correctAnswer: targetMeaning,
      isTypo: gradeResult.isTypo,
      notice: gradeResult.notice
    });

    // 인라인 시험지 시각 피드백
    if (testContainer) {
      const row = testContainer.querySelector(`.test-row[data-row-idx="${idx}"]`);
      if (row) {
        row.classList.remove("row-correct", "row-wrong");
        row.querySelectorAll(".wrong-answer-hint, .row-status-badge").forEach(el => el.remove());

        const inputWrap = row.querySelector(".test-row-input-wrap");
        if (isCorrect) {
          row.classList.add("row-correct");
          if (inputWrap) {
            const badge = document.createElement("span");
            badge.className = "row-status-badge badge-correct";
            badge.textContent = gradeResult.isTypo ? "💡 오타 참작 정답!" : "✅ 정답";
            inputWrap.appendChild(badge);
          }
        } else {
          row.classList.add("row-wrong");
          if (inputWrap) {
            const hint = document.createElement("div");
            hint.className = "wrong-answer-hint";
            const firstMeaning = targetMeaning.replace(/\[[^\]]*\]/g, "").trim().split(/[,/;\n]/)[0];
            hint.innerHTML = `<span class="hint-label">정답</span> <span class="hint-val">${firstMeaning}</span>`;
            inputWrap.appendChild(hint);
          }
        }
      }
    }
  });

  // 버튼 상태 변경
  const submitBtn = document.getElementById("btnSubmitAll");
  if (submitBtn) {
    submitBtn.textContent = "채점 중...";
    submitBtn.disabled = true;
  }

  // 1.2초 후 결과 다이어리 화면으로 이동
  setTimeout(() => {
    if (submitBtn) {
      submitBtn.textContent = "완료";
      submitBtn.disabled = false;
    }
    finishSubjectiveTest();
  }, 1200);
}

async function finishSubjectiveTest() {
  const session = AppState.testSession;
  if (session.timerInterval) clearInterval(session.timerInterval);

  const total = session.results.length;
  const correctCount = session.results.filter(r => r.isCorrect).length;
  const wrongCount = total - correctCount;
  const accuracy = Math.round((correctCount / total) * 100);

  document.getElementById("resAccuracyPct").textContent = `${accuracy}%`;
  document.getElementById("resTotalCount").textContent = total;
  document.getElementById("resCorrectCount").textContent = correctCount;
  document.getElementById("resWrongCount").textContent = wrongCount;

  const m = Math.floor(session.elapsedSeconds / 60);
  const s = session.elapsedSeconds % 60;
  document.getElementById("resDurationText").textContent = m > 0 ? `${m}분 ${s}초` : `${s}초`;

  // 🗓️ 기존 플래너(schedules) 테이블에 즉시 자동 적재
  const activeBook = AppState.wordbooks.find(b => b.id === AppState.activeWordbookId) || AppState.wordbooks[0];
  await syncToSchedulesPlanner({
    subject: activeBook?.subject || "영어",
    date: new Date().toISOString().split("T")[0],
    title: `[단어테스트] ${activeBook?.title || "수능 영단어"} (${accuracy}%)`,
    detail: `총 ${total}문항 중 ${correctCount}개 정답 (오답: ${wrongCount}개)`,
    score: `${accuracy}% (${correctCount}/${total})`,
    duration_sec: session.elapsedSeconds
  });

  // 📝 Supabase test_logs 테이블에 시험 문항별 상세 로그 적재
  const sb = window.getSupabase();
  if (sb && SUPABASE_CONFIG.isConfigured() && session.results && session.results.length > 0) {
    try {
      const userId = await getEffectiveUserId(sb);
      const sessionId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ("00000000-0000-4000-8000-" + Date.now().toString().padStart(12, "0"));
      const logsToInsert = session.results.map(r => ({
        session_id: sessionId,
        user_id: userId,
        word_id: r.word.id,
        test_mode: AppState.testMode || "daily_review",
        question_type: r.questionType || "en_to_kr",
        input_type: AppState.testType === "handwriting" ? "handwriting" : "keyboard",
        user_answer: r.userAnswer || "",
        correct_answer: r.correctAnswer || "",
        is_correct: Boolean(r.isCorrect),
        response_time_ms: 1000
      }));
      const { error: logErr } = await sb.from("test_logs").insert(logsToInsert);
      if (logErr) console.warn("Supabase test_logs insert warning:", logErr);
    } catch (tle) {
      console.warn("Supabase test_logs insert exception:", tle);
    }
  }

  switchView("results");
  // 채점 후 틀린 단어 확인 창(모달) 자동 오픈
  showWrongWordsModal();
}

// ============================================================================
// 채점 후 틀린 단어 확인 모달 (오답 노트) 제어
// ============================================================================
function showWrongWordsModal() {
  const modal = document.getElementById("wrongWordsModal");
  if (!modal) return;

  const session = AppState.testSession;
  const wrongResults = (session.results || []).filter(r => !r.isCorrect);

  const badge = document.getElementById("wrongWordsBadge");
  const subTitle = document.getElementById("wrongWordsSubTitle");
  const tableWrap = document.getElementById("wrongWordsTableWrap");
  const retryBtn = document.getElementById("btnModalRetryWrong");

  if (wrongResults.length === 0) {
    if (badge) {
      badge.textContent = "0개 오답 (만점! 🎉)";
      badge.style.background = "rgba(32, 139, 103, 0.12)";
      badge.style.color = "#208B67";
      badge.style.borderColor = "rgba(32, 139, 103, 0.3)";
    }
    if (subTitle) {
      subTitle.textContent = "축하합니다! 모든 문제를 완벽하게 맞혔습니다 💖";
    }
    if (tableWrap) {
      tableWrap.innerHTML = `
        <div class="wrong-empty-state">
          <div style="font-size: 3rem; margin-bottom: 8px;">🎉✨</div>
          <h4 style="font-family: var(--font-cute); font-size: 1.5rem; color: #208B67; margin-bottom: 6px;">틀린 단어가 없습니다! 완벽해요!</h4>
          <p style="color: var(--text-muted); font-size: 0.9rem; margin: 0;">오늘의 테스트를 100점으로 마쳤습니다. 대단해요!</p>
        </div>
      `;
    }
    if (retryBtn) retryBtn.style.display = "none";
  } else {
    if (badge) {
      badge.textContent = `${wrongResults.length}개 오답`;
      badge.style.background = "rgba(255, 71, 87, 0.12)";
      badge.style.color = "#FF4757";
      badge.style.borderColor = "rgba(255, 71, 87, 0.3)";
    }
    if (subTitle) {
      subTitle.textContent = "오늘 테스트에서 틀린 단어를 확인하고 다시 복습해보세요.";
    }
    if (tableWrap) {
      tableWrap.innerHTML = `
        <div class="wrong-words-header-row">
          <div class="col-word">단어 (English)</div>
          <div class="col-answer">정답 (뜻)</div>
          <div class="col-user">작성한 오답</div>
        </div>
        <div class="wrong-words-list" id="wrongWordsList"></div>
      `;

      const listContainer = document.getElementById("wrongWordsList");
      wrongResults.forEach(r => {
        const row = document.createElement("div");
        row.className = "wrong-word-row";

        const wordCol = document.createElement("div");
        wordCol.className = "col-word";
        wordCol.textContent = r.word?.word || "";

        const ansCol = document.createElement("div");
        ansCol.className = "col-answer";
        ansCol.textContent = r.correctAnswer || r.word?.meaning || "";

        const userCol = document.createElement("div");
        userCol.className = "col-user";
        const trimmed = (r.userAnswer || "").trim();
        if (trimmed) {
          const badgeSpan = document.createElement("span");
          badgeSpan.className = "user-wrong-badge";
          badgeSpan.textContent = trimmed;
          userCol.appendChild(badgeSpan);
        } else {
          const emptySpan = document.createElement("span");
          emptySpan.className = "user-empty-badge";
          emptySpan.textContent = "(미작성)";
          userCol.appendChild(emptySpan);
        }

        row.appendChild(wordCol);
        row.appendChild(ansCol);
        row.appendChild(userCol);
        listContainer.appendChild(row);
      });
    }
    if (retryBtn) {
      retryBtn.style.display = "inline-flex";
      retryBtn.textContent = `오답만 다시 풀기 (${wrongResults.length}개) 🔄`;
    }
  }

  modal.classList.add("active");
}

function closeWrongWordsModal() {
  const modal = document.getElementById("wrongWordsModal");
  if (modal) modal.classList.remove("active");
}

function retryWrongWordsOnly() {
  closeWrongWordsModal();
  const session = AppState.testSession;
  const wrongWords = (session.results || []).filter(r => !r.isCorrect).map(r => r.word);

  if (!wrongWords || wrongWords.length === 0) {
    alert("틀린 단어가 없습니다! 모두 정답입니다 🎉");
    return;
  }

  // test 뷰로 전환하고 오답 단어로만 재출제
  AppState.currentView = "test";
  document.querySelectorAll(".view-section").forEach(sec => sec.style.display = "none");
  const testSec = document.getElementById("view-test");
  if (testSec) testSec.style.display = "block";
  document.querySelectorAll(".drawer-nav-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.view === "test");
  });

  startSubjectiveTest(wrongWords);
}

// ============================================================================
// 채점 후 오답 전체 보기 학습 (List View) 제어
// ============================================================================
function openWrongWordsListView() {
  closeWrongWordsModal();
  const session = AppState.testSession;
  const wrongResults = (session.results || []).filter(r => !r.isCorrect);

  if (!wrongResults || wrongResults.length === 0) {
    alert("틀린 단어가 없습니다! 모든 문제를 완벽하게 맞혔습니다 🎉");
    return;
  }

  // 오답 결과 저장
  AppState.wrongWordsList = wrongResults;
  AppState.wrongStudyState.hideMeaning = false;
  AppState.wrongStudyState.hideExample = false;

  const toggleMeaningBtn = document.getElementById("toggleWrongMeaningBtn");
  if (toggleMeaningBtn) toggleMeaningBtn.textContent = "👁️ 뜻 가리기";
  const toggleExampleBtn = document.getElementById("toggleWrongExampleBtn");
  if (toggleExampleBtn) toggleExampleBtn.textContent = "💬 예문 접기";

  switchView("wrong-study");
}

function renderWrongWordsStudyList() {
  const container = document.getElementById("wrongStudyListContainer");
  const countBadge = document.getElementById("wrongStudyCountBadge");
  const retestBtn = document.getElementById("startWrongRetestBtn");
  if (!container) return;

  const wrongList = AppState.wrongWordsList || [];
  if (countBadge) countBadge.textContent = `${wrongList.length}단어`;
  if (retestBtn) retestBtn.textContent = `✍️ 오답 재시험 치기 (${wrongList.length}개) 🔄`;

  container.innerHTML = "";

  if (wrongList.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 40px; color: var(--text-muted);">
        <div style="font-size: 3rem; margin-bottom: 8px;">🎉✨</div>
        <div style="font-size: 1.2rem; font-weight: 700; color: #208B67;">틀린 단어가 없습니다! 완벽합니다.</div>
        <p style="font-size: 0.9rem; margin-top: 6px;">결과 화면으로 돌아가거나 오늘의 학습을 완료해보세요.</p>
      </div>
    `;
    return;
  }

  const hideMeaning = AppState.wrongStudyState.hideMeaning;
  const hideExample = AppState.wrongStudyState.hideExample;

  wrongList.forEach((r, idx) => {
    const w = r.word || {};
    const { ex1En, ex1Kr, ex2En, ex2Kr, hasEx1, hasEx2 } = getWordExamples(w);
    const userAnswerTrimmed = (r.userAnswer || "").trim();

    const card = document.createElement("div");
    card.className = "wrong-study-card";

    card.innerHTML = `
      <div class="wrong-study-top">
        <div class="wrong-study-word-wrap">
          <span class="wrong-study-index">${idx + 1}</span>
          <span class="wrong-study-term">${w.word || ""}</span>
          <button class="btn-icon-kawaii vocab-pronounce-btn" style="width: 28px; height: 28px; font-size: 0.85rem; padding: 0;" onclick="speakWord('${w.word || ""}')" title="발음 듣기">🔊</button>
          <span class="wrong-study-pron">${w.pronunciation || ""} ${w.pos ? `[${w.pos}]` : ""}</span>
        </div>
        <div>
          <span style="font-size: 0.78rem; font-weight: 800; color: #FF4757; background: rgba(255, 71, 87, 0.1); border: 1px solid rgba(255, 71, 87, 0.25); padding: 3px 8px; border-radius: 99px;">
            ⚠️ 오답 복습
          </span>
        </div>
      </div>

      <div class="wrong-study-diff">
        <!-- 내가 작성한 오답 -->
        <div class="diff-box wrong">
          <div class="diff-box-label">❌ 내가 작성한 오답</div>
          <div class="diff-box-value">
            ${userAnswerTrimmed ? userAnswerTrimmed : '<span style="color: var(--text-muted); font-weight: normal; font-size: 0.9rem;">(미작성)</span>'}
          </div>
        </div>

        <!-- 정답 뜻 -->
        <div class="diff-box correct">
          <div class="diff-box-label">✨ 정답 뜻</div>
          <div class="diff-box-value ${hideMeaning ? "wrong-meaning-blurred" : ""}" onclick="this.classList.toggle('wrong-meaning-blurred')" title="클릭하여 뜻 보기/가리기">
            ${formatMeaningToHtml(w.meaning || r.correctAnswer || "")}
          </div>
        </div>
      </div>

      <!-- 예문 및 해석 -->
      <div class="wrong-study-examples ${hideExample ? "hidden-example" : ""}">
        <div style="font-weight: 700; color: var(--text-main); line-height: 1.4;">
          ${hasEx1 ? ex1En : "등록된 예문이 없습니다."}
        </div>
        <div style="color: var(--text-muted); font-size: 0.85rem; margin-top: 3px;">
          ${hasEx1 ? ex1Kr : ""}
        </div>
        ${hasEx2 ? `
        <div style="font-weight: 700; color: var(--text-main); margin-top: 8px; padding-top: 8px; border-top: 1px dashed rgba(0,0,0,0.08); line-height: 1.4;">
          ${ex2En}
        </div>
        <div style="color: var(--text-muted); font-size: 0.85rem; margin-top: 3px;">
          ${ex2Kr || ""}
        </div>
        ` : ""}
      </div>
    `;

    container.appendChild(card);
  });
}

function startSubjectiveTestFromWrongList() {
  const wrongWords = (AppState.wrongWordsList || []).map(r => r.word || r).filter(Boolean);
  if (!wrongWords || wrongWords.length === 0) {
    alert("재시험을 치를 오답 단어가 없습니다! 🎉");
    return;
  }

  // test 뷰로 전환하고 오답 단어만 출제
  AppState.currentView = "test";
  document.querySelectorAll(".view-section").forEach(sec => sec.style.display = "none");
  const testSec = document.getElementById("view-test");
  if (testSec) testSec.style.display = "block";
  document.querySelectorAll(".drawer-nav-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.view === "test");
  });

  startSubjectiveTest(wrongWords);
}

// ============================================================================
// Apple Pencil / Touch HTML5 캔버스 드로잉 엔진
// ============================================================================
function initHandwritingCanvas() {
  const canvas = document.getElementById("handwritingCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  // 레티나 디스플레이 및 크기 설정
  function resizeCanvas() {
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * window.devicePixelRatio;
    canvas.height = rect.height * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
  }
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);

  function getPos(e) {
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: clientX - rect.left,
      y: clientY - rect.top
    };
  }

  function startDraw(e) {
    e.preventDefault();
    AppState.isDrawing = true;
    saveCanvasState();
    const pos = getPos(e);
    AppState.lastX = pos.x;
    AppState.lastY = pos.y;
  }

  function draw(e) {
    if (!AppState.isDrawing) return;
    e.preventDefault();
    const pos = getPos(e);

    ctx.beginPath();
    ctx.moveTo(AppState.lastX, AppState.lastY);
    ctx.lineTo(pos.x, pos.y);

    if (AppState.canvasTool === "pen") {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = "#3E2723"; // 웜 다크초코 연필색
      ctx.lineWidth = 3.5;
    } else if (AppState.canvasTool === "highlighter") {
      ctx.globalCompositeOperation = "multiply";
      ctx.strokeStyle = "rgba(255, 234, 167, 0.45)"; // 파스텔 레몬 형광펜
      ctx.lineWidth = 14;
    } else if (AppState.canvasTool === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.lineWidth = 20;
    }

    ctx.stroke();
    AppState.lastX = pos.x;
    AppState.lastY = pos.y;
  }

  function stopDraw(e) {
    if (AppState.isDrawing) {
      AppState.isDrawing = false;
      ctx.beginPath();
    }
  }

  canvas.addEventListener("mousedown", startDraw);
  canvas.addEventListener("mousemove", draw);
  canvas.addEventListener("mouseup", stopDraw);
  canvas.addEventListener("mouseleave", stopDraw);

  canvas.addEventListener("touchstart", startDraw, { passive: false });
  canvas.addEventListener("touchmove", draw, { passive: false });
  canvas.addEventListener("touchend", stopDraw);
}

function saveCanvasState() {
  const canvas = document.getElementById("handwritingCanvas");
  if (!canvas) return;
  if (AppState.canvasHistory.length > 10) AppState.canvasHistory.shift();
  AppState.canvasHistory.push(canvas.toDataURL());
}

function undoCanvas() {
  if (AppState.canvasHistory.length === 0) return;
  const canvas = document.getElementById("handwritingCanvas");
  const ctx = canvas.getContext("2d");
  const prevData = AppState.canvasHistory.pop();
  const img = new Image();
  img.src = prevData;
  img.onload = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width / window.devicePixelRatio, canvas.height / window.devicePixelRatio);
  };
}

function clearCanvas() {
  const canvas = document.getElementById("handwritingCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  AppState.canvasHistory = [];
}

// ============================================================================
// 단어장 관리 및 취약 단어 안전 보존 모달
// ============================================================================
function renderWordbooksList() {
  const container = document.getElementById("wordbooksListContainer");
  container.innerHTML = "";

  if (AppState.wordbooks.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 40px 20px; color: var(--text-muted);">
        <div style="font-size: 2.2rem; margin-bottom: 8px;">📚</div>
        <div style="font-weight: 700; font-size: 1.1rem; color: var(--text-main);">등록된 단어장이 없습니다.</div>
        <div style="font-size: 0.85rem; margin-top: 4px;">상단의 <strong>+ CSV 단어장 등록</strong> 버튼을 눌러 새 단어장을 등록해주세요!</div>
      </div>
    `;
    return;
  }

  AppState.wordbooks.forEach(b => {
    const card = document.createElement("div");
    card.className = "stat-sticker";
    card.style.background = b.is_vulnerable_archive ? "var(--baby-pink-soft)" : "var(--bg-card-alt)";
    card.style.border = "2px solid var(--border-soft)";
    card.style.borderRadius = "var(--radius-md)";
    card.style.padding = "16px 20px";
    card.style.display = "flex";
    card.style.justifyContent = "space-between";
    card.style.alignItems = "center";

    const wordCount = AppState.words.filter(w => w.wordbook_id === b.id).length;

    card.innerHTML = `
      <div style="text-align: left;">
        <div style="font-weight: 800; font-size: 1.15rem; color: var(--text-main); display: flex; align-items: center; gap: 8px;">
          <span>${b.title}</span>
          ${b.is_vulnerable_archive ? '<span style="font-size:0.75rem; background:var(--coral-pink); color:#fff; padding:2px 8px; border-radius:99px;">보존 전용</span>' : ''}
        </div>
        <div style="font-size: 0.85rem; color: var(--text-muted); margin-top: 4px;">
          ${b.description || ''} • 단어수: <strong>${wordCount}</strong>개 • 목표: 하루 ${b.daily_new_target || 20}개
        </div>
      </div>
      <div style="display: flex; gap: 8px;">
        <button class="btn-tool-kawaii" onclick="selectWordbook(${b.id})">선택 📖</button>
        ${!b.is_vulnerable_archive ? `<button class="btn-tool-kawaii" style="color:#FF4757;" onclick="openSafeDeleteModal(${b.id})">삭제 🗑️</button>` : ''}
      </div>
    `;
    container.appendChild(card);
  });
}

async function selectWordbook(bookId) {
  AppState.activeWordbookId = Number(bookId);
  AppState.currentCardIndex = 0;
  AppState.studyIndex = 0;
  saveLocalState();
  updateWordbookSelectDropdown();
  renderWordbooksList();
  renderFlashcard();
  renderWordListView();
  updateSidebarStats();

  if (window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.isConfigured()) {
    await syncWordsFromSupabase(AppState.activeWordbookId);
  }

  alert("🌸 단어장이 선택되었습니다!");
  switchView("study");
}

function updateWordbookSelectDropdown() {
  const sel = document.getElementById("activeWordbookSelect");
  if (!sel) return;
  sel.innerHTML = "";
  if (AppState.wordbooks.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "등록된 단어장 없음";
    sel.appendChild(opt);
    return;
  }
  AppState.wordbooks.forEach(b => {
    const opt = document.createElement("option");
    opt.value = b.id;
    opt.textContent = `📖 ${b.title}`;
    if (Number(b.id) === Number(AppState.activeWordbookId)) opt.selected = true;
    sel.appendChild(opt);
  });
}

let targetDeleteBookId = null;
function openSafeDeleteModal(bookId) {
  targetDeleteBookId = bookId;
  const vulnerableCount = AppState.words.filter(w => AppState.progressMap[w.id]?.is_vulnerable).length;
  document.getElementById("safeDeleteMsg").innerHTML = `
    선택하신 단어장에는 복습이 시급한 <strong>취약 단어 ${vulnerableCount}개</strong>가 있습니다.<br>
    취약 단어를 보존하지 않고 삭제하면 학습 통계와 복습 이력이 유실됩니다.
  `;
  document.getElementById("safeDeleteModal").classList.add("active");
}

async function executeSafeDelete() {
  if (!targetDeleteBookId) return;

  const sb = window.getSupabase();
  if (!sb || !SUPABASE_CONFIG.isConfigured()) {
    alert("⚠️ Supabase DB에 연결되어 있지 않아 단어장을 삭제할 수 없습니다.");
    return;
  }

  try {
    // 1. Supabase에서 보존 전용 단어장 확보
    let archiveBook = AppState.wordbooks.find(b => b.is_vulnerable_archive);
    let archiveBookId = archiveBook?.id;

    if (!archiveBookId) {
      const { data: newArch, error: archErr } = await sb.from("wordbooks").insert([{
        title: "💖 취약 단어 보존함",
        description: "삭제된 단어장에서 자동 보존된 취약 단어들",
        is_vulnerable_archive: true
      }]).select();
      if (archErr) throw archErr;
      if (newArch && newArch[0]) archiveBookId = newArch[0].id;
    }

    // 2. 취약 단어는 archiveBook으로 이전
    const vulnerableWords = AppState.words.filter(w => Number(w.wordbook_id) === Number(targetDeleteBookId) && AppState.progressMap[w.id]?.is_vulnerable);
    if (vulnerableWords.length > 0 && archiveBookId) {
      const vulnWordIds = vulnerableWords.map(w => w.id);
      const { error: moveErr } = await sb.from("words")
        .update({ wordbook_id: archiveBookId })
        .in("id", vulnWordIds);
      if (moveErr) console.warn("Vulnerable words transfer warning:", moveErr);
    }

    // 3. 삭제 대상 단어장의 일반 단어 삭제 (외래키 제약 방지)
    const { error: wordsDelErr } = await sb.from("words")
      .delete()
      .eq("wordbook_id", targetDeleteBookId);
    if (wordsDelErr) console.warn("Words delete warning:", wordsDelErr);

    // 4. 단어장 메타 레코드 삭제
    const { error: bookDelErr } = await sb.from("wordbooks")
      .delete()
      .eq("id", targetDeleteBookId);
    if (bookDelErr) throw bookDelErr;

    document.getElementById("safeDeleteModal").classList.remove("active");
    alert("🌸 단어장이 삭제되었으며 취약 단어는 안전하게 보존되었습니다!");
    await syncWordsFromSupabase();
  } catch (err) {
    console.error("단어장 삭제 실패:", err);
    alert("⚠️ 단어장 삭제 중 오류 발생: " + (err.message || err));
  }
}

// ============================================================================
// 망각곡선 및 누적 통계 대시보드
// ============================================================================
function renderStatsDashboard() {
  let mastered = 0;
  let totalTests = 0;
  let totalCorrect = 0;
  const stageCounts = [0, 0, 0, 0, 0, 0, 0];

  AppState.words.forEach(w => {
    const prog = AppState.progressMap[w.id];
    if (prog) {
      const st = Math.min(6, prog.review_stage || 0);
      stageCounts[st]++;
      if (st >= 5) mastered++;
      totalTests += prog.total_tests || 0;
      totalCorrect += prog.total_correct || 0;
    } else {
      stageCounts[0]++;
    }
  });

  document.getElementById("statsTotalLearned").textContent = AppState.words.length;
  document.getElementById("statsMastered").textContent = mastered;
  const avgAcc = totalTests > 0 ? (totalCorrect / totalTests) * 100 : 92.5;
  document.getElementById("statsAvgAccuracy").textContent = `${Math.round(avgAcc * 10) / 10}%`;
  document.getElementById("statsVulnerableCount").textContent = AppState.words.filter(w => AppState.progressMap[w.id]?.is_vulnerable).length;

  const container = document.getElementById("stageDistributionBars");
  container.innerHTML = "";
  const stageLabels = [
    "🌱 미학습 단계",
    "🌸 1단계 (1일 후 복습)",
    "🌷 2단계 (3일 후 복습)",
    "🌿 3단계 (7일 후 복습)",
    "🍀 4단계 (14일 후 복습)",
    "⭐ 5단계 (30일 후 복습)",
    "👑 6단계 (영구기억숙련)"
  ];

  stageLabels.forEach((label, idx) => {
    const count = stageCounts[idx] || 0;
    const maxVal = Math.max(1, AppState.words.length);
    const pct = Math.round((count / maxVal) * 100);

    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "12px";
    row.style.fontSize = "0.88rem";
    row.style.fontWeight = "700";

    row.innerHTML = `
      <div style="width: 170px; color: var(--text-body);">${label}</div>
      <div style="flex: 1; height: 14px; background: var(--bg-desk); border-radius: 99px; overflow: hidden;">
        <div style="width: ${pct}%; height: 100%; background: linear-gradient(90deg, var(--coral-pink), var(--lavender)); border-radius: 99px;"></div>
      </div>
      <div style="width: 50px; text-align: right; color: var(--text-muted);">${count}단어</div>
    `;
    container.appendChild(row);
  });
}

// ============================================================================
// 📑 오늘 학습 단어 전체 목록 & A4 인쇄 엔진
// ============================================================================
function renderWordListView() {
  const container = document.getElementById("todayWordListContainer");
  if (!container) return;

  const now = new Date();
  const st = AppState.wordlistState;

  // 1. 오늘 학습 대상 추출 (신규 + 복습 및 복습 0개 시 +10 보정)
  const { todayWords, todayNewWords, todayReviewWords } = getTodayStudyWords();

  // 취약 단어는 오늘의 학습 단어 중 취약한 단어
  const todayVulnerableWords = todayWords.filter(w => {
    const prog = AppState.progressMap[w.id];
    return prog && prog.is_vulnerable;
  });

  // 필터별 개수 뱃지 갱신 (오늘 학습 대상 기준)
  refreshWordListFilterCounters();

  // 2. 현재 선택 필터 적용
  let list = [];
  if (st.filter === "new") {
    list = [...todayNewWords];
  } else if (st.filter === "review") {
    list = [...todayReviewWords];
  } else if (st.filter === "vulnerable") {
    list = [...todayVulnerableWords];
  } else {
    // "all" -> 오늘 학습 대상 단어(신규 + 복습)
    list = [...todayWords];
  }

  // 3. 검색어 필터링
  if (st.search.trim()) {
    const q = st.search.trim().toLowerCase();
    list = list.filter(w =>
      w.word.toLowerCase().includes(q) ||
      (w.meaning && w.meaning.toLowerCase().includes(q)) ||
      (w.pronunciation && w.pronunciation.toLowerCase().includes(q))
    );
  }

  // 4. 정렬
  if (st.sort === "alpha") {
    list.sort((a, b) => a.word.localeCompare(b.word));
  } else if (st.sort === "weak") {
    list.sort((a, b) => {
      const vA = AppState.progressMap[a.id]?.is_vulnerable ? 1 : 0;
      const vB = AppState.progressMap[b.id]?.is_vulnerable ? 1 : 0;
      return vB - vA;
    });
  } else {
    // unit 순 (기본)
    list.sort((a, b) => (a.unit || "").localeCompare(b.unit || "") || (a.word_no || 0) - (b.word_no || 0));
  }

  const badgeEl = document.getElementById("wordlistCountBadge");
  if (badgeEl) badgeEl.textContent = `${list.length}단어`;
  container.innerHTML = "";

  if (list.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 40px; color: var(--text-muted);">
        <img src="assets/mascot.png" style="width: 56px; height: 56px; border-radius: 50%; object-fit: cover; border: 2px solid var(--border-soft); margin-bottom: 8px;" alt="Mascot">
        <div style="font-size: 1.1rem; font-weight: 700;">조건에 해당하는 단어가 없습니다.</div>
      </div>
    `;
    return;
  }

  const stageNames = ["🌱 미학습", "🌸 1일", "🌷 3일", "🌿 7일", "🍀 14일", "⭐ 30일", "👑 숙련"];

  list.forEach((w, idx) => {
    const prog = AppState.progressMap[w.id] || {};
    const stg = Math.min(6, prog.review_stage || 0);
    const isVulnerable = prog.is_vulnerable;
    const { ex1En, ex1Kr, ex2En, ex2Kr, hasEx1, hasEx2 } = getWordExamples(w);

    const row = document.createElement("div");
    row.className = `word-card-row ${isVulnerable ? "is-vulnerable" : ""}`;

    const stageLabel = stg === 0 ? "🌱 미학습" : (stg === 1 ? "📍 학습" : (stageNames[stg] || "📍 학습"));

    row.innerHTML = `
      <div class="word-index-num">${idx + 1}</div>
      <div class="word-main-col">
        <div class="word-term">
          <span>${w.word}</span>
          <button class="btn-icon-kawaii vocab-pronounce-btn" style="width: 26px; height: 26px; font-size: 0.8rem; padding: 0;" onclick="speakWord('${w.word}')" title="발음 듣기">🔊</button>
        </div>
        <div class="word-pron ${st.hideMeaning ? "hidden-pron" : ""}">${w.pronunciation || ""} ${w.pos ? `[${w.pos}]` : ""}</div>
        <button class="word-stage-pill ${stg === 0 ? "is-unlearned" : "is-learned"}" 
                onclick="toggleWordLearningStatus('${w.id}', this)" 
                title="클릭하여 학습 상태 변경 (미학습 ↔ 학습)">
          ${stageLabel}
        </button>
      </div>
      <div class="word-meaning-col">
        <div class="word-meaning-text ${st.hideMeaning ? "blurred" : ""}" onclick="this.classList.toggle('blurred')" title="클릭하여 뜻 가리기/보기">
          ${formatMeaningToHtml(w.meaning)}
        </div>
      </div>
      <div class="word-example-col ${(st.hideExample || st.hideMeaning) ? "hidden-example" : ""}">
        <div style="font-weight: 700; color: var(--text-main);">${hasEx1 ? ex1En : "등록된 예문 없음"}</div>
        <div style="color: var(--text-muted); font-size: 0.8rem; margin-top: 2px;">${hasEx1 ? ex1Kr : ""}</div>
        ${hasEx2 ? `
        <div style="font-weight: 700; color: var(--text-main); margin-top: 6px; padding-top: 6px; border-top: 1px dashed rgba(0,0,0,0.08);">${ex2En}</div>
        <div style="color: var(--text-muted); font-size: 0.8rem; margin-top: 2px;">${ex2Kr || ""}</div>
        ` : ''}
      </div>
      <div class="word-status-col">
        ${isVulnerable ? '<span style="font-size: 0.72rem; font-weight: 800; color: #FF4757; background: #FFF0F2; padding: 2px 6px; border-radius: 99px;">취약 단어</span>' : ''}
      </div>
    `;
    container.appendChild(row);
  });
}

function refreshWordListFilterCounters() {
  const { todayWords, todayNewWords, todayReviewWords } = getTodayStudyWords();
  const todayVulnerableWords = todayWords.filter(w => {
    const prog = AppState.progressMap[w.id];
    return prog && prog.is_vulnerable;
  });

  const cntAllEl = document.getElementById("cntFilterAll");
  if (cntAllEl) cntAllEl.textContent = todayWords.length;
  const cntNewEl = document.getElementById("cntFilterNew");
  if (cntNewEl) cntNewEl.textContent = todayNewWords.length;
  const cntRevEl = document.getElementById("cntFilterReview");
  if (cntRevEl) cntRevEl.textContent = todayReviewWords.length;
  const cntVulEl = document.getElementById("cntFilterVulnerable");
  if (cntVulEl) cntVulEl.textContent = todayVulnerableWords.length;
}

function toggleWordLearningStatus(wordId, btnEl) {
  let prog = AppState.progressMap[wordId];
  if (!prog) {
    prog = {
      word_id: wordId,
      user_status: "learning",
      review_stage: 0,
      consecutive_correct: 0,
      total_tests: 0,
      total_correct: 0,
      total_wrong: 0,
      is_vulnerable: false
    };
  }

  const now = new Date();
  const currentStage = prog.review_stage || 0;

  if (currentStage === 0) {
    // 🌱 미학습 -> 📍 학습(1단계)
    prog.review_stage = 1;
    prog.user_status = "learning";
    if (!prog.total_tests) {
      prog.total_tests = 1;
      prog.total_correct = 1;
    }
    const nextDate = new Date();
    nextDate.setDate(nextDate.getDate() + 1); // 1일 후 복습 스케줄 (자정 기준)
    nextDate.setHours(0, 0, 0, 0);
    prog.next_review_at = nextDate.toISOString();
    prog.last_tested_at = now.toISOString();
  } else {
    // 1이상(학습/복습 단계) -> 🌱 미학습(0단계) 되돌리기
    prog.review_stage = 0;
    prog.user_status = "new";
    prog.next_review_at = null;
  }

  AppState.progressMap[wordId] = prog;

  // Supabase 동기화 (게스트/로그인 모두 지원, 원격 DB 직접 upsert)
  const sb = window.getSupabase();
  if (sb && SUPABASE_CONFIG.isConfigured()) {
    getEffectiveUserId(sb).then(userId => {
      if (userId) {
        sb.from("user_word_progress").upsert({
          user_id: userId,
          word_id: wordId,
          user_status: prog.user_status,
          review_stage: prog.review_stage,
          is_vulnerable: prog.is_vulnerable,
          total_tests: prog.total_tests || 0,
          total_correct: prog.total_correct || 0,
          total_wrong: prog.total_wrong || 0,
          consecutive_correct: prog.consecutive_correct || 0,
          recent_accuracy: prog.recent_accuracy || 0,
          next_review_at: prog.next_review_at,
          last_tested_at: prog.last_tested_at
        }, { onConflict: "user_id,word_id" })
        .then(({ error }) => {
          if (error) console.error("❌ [user_word_progress] DB 저장 실패:", error);
        })
        .catch(err => console.error("Supabase progress upsert error:", err));
      }
    });
  }

  // 뱃지 UI 즉시 반영
  if (btnEl) {
    const isLearned = prog.review_stage > 0;
    btnEl.className = `word-stage-pill ${isLearned ? "is-learned" : "is-unlearned"}`;
    btnEl.innerHTML = isLearned ? (prog.review_stage === 1 ? "📍 학습" : (["🌱 미학습", "🌸 1일", "🌷 3일", "🌿 7일", "🍀 14일", "⭐ 30일", "👑 숙련"][prog.review_stage] || "📍 학습")) : "🌱 미학습";
  }

  // 상단 필터 탭 개수 & 사이드바/대시보드 통계 실시간 갱신
  refreshWordListFilterCounters();
  updateSidebarStats();
  if (document.getElementById("view-stats")?.classList.contains("active")) {
    renderStatsDashboard();
  }
}

function printMemorizeBook() {
  const container = document.getElementById("view-wordlist");
  if (container) container.classList.remove("print-blank-mode");
  window.print();
}

function printBlankTest() {
  const container = document.getElementById("view-wordlist");
  if (container) container.classList.add("print-blank-mode");
  window.print();
  setTimeout(() => {
    if (container) container.classList.remove("print-blank-mode");
  }, 1000);
}

// ============================================================================
// CSV 파서 및 단어장 일괄 등록 모듈
// ============================================================================
function parseCsvText(text) {
  const lines = [];
  let currentLine = [];
  let currentField = '';
  let insideQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];
    if (char === '"') {
      if (insideQuotes && nextChar === '"') {
        currentField += '"';
        i++;
      } else {
        insideQuotes = !insideQuotes;
      }
    } else if (char === ',' && !insideQuotes) {
      currentLine.push(currentField.trim());
      currentField = '';
    } else if ((char === '\r' || char === '\n') && !insideQuotes) {
      if (char === '\r' && nextChar === '\n') i++;
      currentLine.push(currentField.trim());
      if (currentLine.some(f => f.length > 0)) lines.push(currentLine);
      currentLine = [];
      currentField = '';
    } else {
      currentField += char;
    }
  }
  if (currentField || currentLine.length > 0) {
    currentLine.push(currentField.trim());
    if (currentLine.some(f => f.length > 0)) lines.push(currentLine);
  }
  return lines;
}

function initUploadModal() {
  const modal = document.getElementById("uploadWordbookModal");
  const openBtn = document.getElementById("openUploadCsvBtn");
  const closeBtn = document.getElementById("closeUploadModalBtn");
  const cancelBtn = document.getElementById("btnCancelUpload");
  const submitBtn = document.getElementById("btnSubmitWordbook");
  const alertBox = document.getElementById("uploadStatusAlert");

  if (!modal) return;

  const closeModal = () => {
    modal.classList.remove("active");
    if (alertBox) {
      alertBox.style.display = "none";
      alertBox.textContent = "";
    }
    const fileInput = document.getElementById("csvFileInput");
    if (fileInput) fileInput.value = "";
  };

  if (openBtn) {
    openBtn.addEventListener("click", () => {
      document.getElementById("newBookTitle").value = "";
      document.getElementById("newBookDesc").value = "";
      const targetNewEl = document.getElementById("newBookTargetNew");
      if (targetNewEl) targetNewEl.value = "10";
      if (alertBox) alertBox.style.display = "none";
      modal.classList.add("active");
    });
  }

  if (closeBtn) closeBtn.addEventListener("click", closeModal);
  if (cancelBtn) cancelBtn.addEventListener("click", closeModal);

  if (submitBtn) {
    submitBtn.addEventListener("click", async () => {
      const title = document.getElementById("newBookTitle").value.trim();
      const desc = document.getElementById("newBookDesc").value.trim();
      const targetNew = parseInt(document.getElementById("newBookTargetNew")?.value) || 10;
      const fileInput = document.getElementById("csvFileInput");

      if (!title) {
        alert("⚠️ 단어장 이름을 입력해주세요!");
        return;
      }

      if (!fileInput.files || fileInput.files.length === 0) {
        alert("⚠️ 업로드할 CSV 단어 파일을 선택해주세요!");
        return;
      }

      const file = fileInput.files[0];
      alertBox.style.display = "block";
      alertBox.className = "connection-alert status-loading";
      alertBox.textContent = `📖 "${file.name}" 파일 파싱 중...`;
      submitBtn.disabled = true;

      try {
        const text = await file.text();
        const rawLines = parseCsvText(text);

        if (rawLines.length < 2) {
          throw new Error("CSV 파일에 최소 1개 이상의 단어 행이 필요합니다.");
        }

        // 헤더 인덱스 매핑 (대소문자 무시 및 다양한 영문/한글 헤더 자동 매칭)
        const header = rawLines[0].map(h => (h || "").toLowerCase().trim());
        const findHeaderIdx = (candidates) => {
          for (const cand of candidates) {
            const idx = header.indexOf(cand.toLowerCase().trim());
            if (idx !== -1) return idx;
          }
          return -1;
        };

        let unitIdx = findHeaderIdx(["unit", "단원", "과"]);
        let wordIdx = findHeaderIdx(["word", "단어", "표제어", "영단어", "term"]);
        let meaningIdx = findHeaderIdx(["meaning", "뜻", "한글뜻", "의미", "translation"]);
        let pronIdx = findHeaderIdx(["pronunciation", "발음", "발음기호", "pron"]);
        let ex1EnIdx = findHeaderIdx(["example_1", "example", "example_en", "sentence", "example_sentence", "예문", "예문1", "ex1", "ex"]);
        let ex1KoIdx = findHeaderIdx(["example_1_trans", "example_trans", "example_ko", "example_kr", "sentence_translation", "sentence_ko", "예문해석", "해석", "예문1해석", "trans"]);
        let ex2EnIdx = findHeaderIdx(["example_2", "example_2_en", "sentence_2", "sentence2", "예문2", "ex2"]);
        let ex2KoIdx = findHeaderIdx(["example_2_trans", "example_2_ko", "example_2_kr", "sentence_2_translation", "sentence_2_ko", "예문2해석", "해석2"]);
        let posIdx = findHeaderIdx(["pos", "품사"]);
        let derivIdx = findHeaderIdx(["derivatives", "파생어", "관련어"]);

        let startIndex = 1;
        // 헤더가 없을 경우 순서대로 매핑: unit, word, meaning, pronunciation, example_1, example_1_trans, example_2, example_2_trans
        if (wordIdx === -1 && meaningIdx === -1) {
          startIndex = 0;
          unitIdx = 0;
          wordIdx = 1;
          meaningIdx = 2;
          pronIdx = 3;
          ex1EnIdx = 4;
          ex1KoIdx = 5;
          ex2EnIdx = 6;
          ex2KoIdx = 7;
        }

        const wordsToInsert = [];
        for (let i = startIndex; i < rawLines.length; i++) {
          const row = rawLines[i];
          const word = (row[wordIdx] || "").trim();
          const meaning = (row[meaningIdx] || "").trim();
          if (!word || !meaning) continue;

          wordsToInsert.push({
            unit: (row[unitIdx] || "Unit 01").trim(),
            word: word,
            meaning: meaning,
            pronunciation: pronIdx !== -1 ? (row[pronIdx] || "").trim() : "",
            example_1: ex1EnIdx !== -1 ? (row[ex1EnIdx] || "").trim() : "",
            example_1_trans: ex1KoIdx !== -1 ? (row[ex1KoIdx] || "").trim() : "",
            example_2: ex2EnIdx !== -1 ? (row[ex2EnIdx] || "").trim() : "",
            example_2_trans: ex2KoIdx !== -1 ? (row[ex2KoIdx] || "").trim() : "",
            pos: posIdx !== -1 ? (row[posIdx] || "").trim() : "",
            derivatives: derivIdx !== -1 ? (row[derivIdx] || "").trim() : ""
          });
        }

        if (wordsToInsert.length === 0) {
          throw new Error("유효한 단어(word, meaning)를 파싱하지 못했습니다.");
        }

        alertBox.textContent = `💾 총 ${wordsToInsert.length}개 단어 저장 중...`;

        const sb = window.getSupabase();
        if (!sb || !SUPABASE_CONFIG.isConfigured()) {
          throw new Error("Supabase DB 연결이 필요합니다. 상단 ⚙️ 설정에서 DB 접속 정보를 먼저 등록해 주세요.");
        }

        // Supabase wordbooks INSERT
        const { data: bData, error: bErr } = await sb.from("wordbooks").insert([{
          title: title,
          description: desc,
          daily_new_target: targetNew
        }]).select();

        if (bErr) throw bErr;
        if (!bData || !bData[0]) throw new Error("단어장 레코드 생성 응답을 받지 못했습니다.");
        const newBookId = bData[0].id;

        // Supabase words 일괄 INSERT (청크 200개씩)
        const wordsWithBookId = wordsToInsert.map(w => ({ ...w, wordbook_id: newBookId }));
        const chunkSize = 200;
        for (let c = 0; c < wordsWithBookId.length; c += chunkSize) {
          const chunk = wordsWithBookId.slice(c, c + chunkSize);
          const { error: wErr } = await sb.from("words").insert(chunk);
          if (wErr) {
            console.error("Supabase words chunk insert error:", wErr);
            throw new Error(`단어 데이터 저장 실패 (${c + 1}~${c + chunk.length}): ${wErr.message}`);
          }
        }

        // Supabase 최신 데이터로 동기화 갱신
        await syncWordsFromSupabase(newBookId);

        alertBox.className = "connection-alert status-connected";
        alertBox.textContent = `🎉 "${title}" 단어장(${wordsToInsert.length}단어) Supabase 등록 완료!`;

        setTimeout(() => {
          closeModal();
          alert(`🌸 새 단어장 [${title}] (${wordsToInsert.length}개 단어)이 Supabase DB에 성공적으로 등록되었습니다!`);
        }, 600);

      } catch (err) {
        alertBox.className = "connection-alert status-error";
        alertBox.textContent = `❌ 등록 실패: ${err.message}`;
      } finally {
        submitBtn.disabled = false;
      }
    });
  }
}

async function refreshDbStatusBadge() {
  const badge = document.getElementById("dbStatusBadge");
  if (!badge) return;
  const res = await window.checkSupabaseHealth();
  if (res.success) {
    badge.className = "status-pill status-connected";
    badge.innerHTML = "🟢 Supabase 연결됨";
  } else if (res.isLocal) {
    badge.className = "status-pill status-error";
    badge.innerHTML = "🟡 DB 미설정 (연결 필요 ⚙️)";
  } else {
    badge.className = "status-pill status-error";
    badge.innerHTML = "🔴 DB 연결 실패 ⚙️";
  }
}

// ============================================================================
// 이벤트 리스너 바인딩 & 초기 구동
// ============================================================================
document.addEventListener("DOMContentLoaded", () => {
  loadLocalState();
  initSupabase();
  initHandwritingCanvas();
  updateWordbookSelectDropdown();
  initUploadModal();
  refreshDbStatusBadge();

  // 날짜 표시
  const dateOptions = { month: "long", day: "numeric", weekday: "short" };
  document.getElementById("currentDateDisplay").textContent = new Date().toLocaleDateString("ko-KR", dateOptions);

  // 내비게이션 탭
  document.querySelectorAll(".drawer-nav-btn").forEach(btn => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });

  // 브랜드 로고 클릭 -> 홈
  document.getElementById("brandHomeBtn").addEventListener("click", () => switchView("study"));

  // 플래시카드 버튼
  document.getElementById("cardPronounceBtn").addEventListener("click", () => {
    const w = getCurrentStudyWord();
    if (w) speakWord(w.word);
  });

  document.getElementById("cardMeaningBox").addEventListener("click", function () {
    this.classList.toggle("hidden-blur");
  });

  document.getElementById("cardBtnKnow").addEventListener("click", () => {
    const w = getCurrentStudyWord();
    if (w) updateEbbinghausProgress(w.id, true, 1000, "flashcard", "known");
    AppState.studyIndex++;
    renderFlashcard();
    updateSidebarStats();
  });

  document.getElementById("cardBtnAgain").addEventListener("click", () => {
    const w = getCurrentStudyWord();
    if (w) updateEbbinghausProgress(w.id, false, 1000, "flashcard", "again");
    AppState.studyIndex++;
    renderFlashcard();
    updateSidebarStats();
  });

  // 주관식 단어 테스트 일괄 채점 버튼
  const btnSubmitAll = document.getElementById("btnSubmitAll");
  if (btnSubmitAll) {
    btnSubmitAll.addEventListener("click", submitAndGradeTest);
  }

  // 캔버스 툴 버튼 (옵션/호환성 유지)
  const penToolBtn = document.getElementById("penToolBtn");
  if (penToolBtn) {
    penToolBtn.addEventListener("click", function () {
      AppState.canvasTool = "pen";
      document.querySelectorAll(".canvas-toolbar .btn-tool-kawaii").forEach(b => b.classList.remove("active"));
      this.classList.add("active");
    });
  }
  const highlighterToolBtn = document.getElementById("highlighterToolBtn");
  if (highlighterToolBtn) {
    highlighterToolBtn.addEventListener("click", function () {
      AppState.canvasTool = "highlighter";
      document.querySelectorAll(".canvas-toolbar .btn-tool-kawaii").forEach(b => b.classList.remove("active"));
      this.classList.add("active");
    });
  }
  const eraserToolBtn = document.getElementById("eraserToolBtn");
  if (eraserToolBtn) {
    eraserToolBtn.addEventListener("click", function () {
      AppState.canvasTool = "eraser";
      document.querySelectorAll(".canvas-toolbar .btn-tool-kawaii").forEach(b => b.classList.remove("active"));
      this.classList.add("active");
    });
  }
  const canvasUndoBtn = document.getElementById("canvasUndoBtn");
  if (canvasUndoBtn) canvasUndoBtn.addEventListener("click", undoCanvas);
  const canvasClearBtn = document.getElementById("canvasClearBtn");
  if (canvasClearBtn) canvasClearBtn.addEventListener("click", clearCanvas);

  // 결과 화면 & 오답 모달 버튼 이벤트
  document.getElementById("resFinishBtn")?.addEventListener("click", () => switchView("study"));
  document.getElementById("resRetryWrongBtn")?.addEventListener("click", retryWrongWordsOnly);
  document.getElementById("resOpenWrongModalBtn")?.addEventListener("click", showWrongWordsModal);
  document.getElementById("resOpenWrongStudyBtn")?.addEventListener("click", openWrongWordsListView);
  document.getElementById("btnCloseWrongWordsModal")?.addEventListener("click", closeWrongWordsModal);
  document.getElementById("btnModalRetryWrong")?.addEventListener("click", retryWrongWordsOnly);
  document.getElementById("btnModalOpenStudyList")?.addEventListener("click", openWrongWordsListView);

  // 오답 전체 보기 학습 뷰 이벤트
  document.getElementById("btnBackToResultsFromWrong")?.addEventListener("click", () => switchView("results"));
  document.getElementById("startWrongRetestBtn")?.addEventListener("click", startSubjectiveTestFromWrongList);

  const toggleWrongMeaningBtn = document.getElementById("toggleWrongMeaningBtn");
  if (toggleWrongMeaningBtn) {
    toggleWrongMeaningBtn.addEventListener("click", () => {
      AppState.wrongStudyState.hideMeaning = !AppState.wrongStudyState.hideMeaning;
      toggleWrongMeaningBtn.textContent = AppState.wrongStudyState.hideMeaning ? "👁️ 뜻 보이기" : "👁️ 뜻 가리기";
      renderWrongWordsStudyList();
    });
  }

  const toggleWrongExampleBtn = document.getElementById("toggleWrongExampleBtn");
  if (toggleWrongExampleBtn) {
    toggleWrongExampleBtn.addEventListener("click", () => {
      AppState.wrongStudyState.hideExample = !AppState.wrongStudyState.hideExample;
      toggleWrongExampleBtn.textContent = AppState.wrongStudyState.hideExample ? "💬 예문 보이기" : "💬 예문 접기";
      renderWrongWordsStudyList();
    });
  }

  // 단어장 안전 삭제 모달 이벤트
  document.getElementById("btnConfirmPreserveDelete").addEventListener("click", executeSafeDelete);
  document.getElementById("btnCancelDelete").addEventListener("click", () => {
    document.getElementById("safeDeleteModal").classList.remove("active");
  });

  // 환경설정 모달 이벤트
  const settingsModal = document.getElementById("settingsModal");
  const openSettings = async () => {
    document.getElementById("cfgSbUrl").value = SUPABASE_CONFIG.getUrl();
    document.getElementById("cfgSbKey").value = SUPABASE_CONFIG.getKey();
    const cfgUserEl = document.getElementById("cfgUserId");
    if (cfgUserEl) cfgUserEl.value = SUPABASE_CONFIG.getUserId();

    const cfgNewEl = document.getElementById("cfgTargetNew");
    if (cfgNewEl) cfgNewEl.value = AppState.settings.targetNewWords || 10;

    const alertBox = document.getElementById("sbConnectionAlert");
    if (alertBox) {
      alertBox.className = "connection-alert status-loading";
      alertBox.textContent = "🔄 현재 연결 상태 확인 중...";
      const res = await window.checkSupabaseHealth();
      alertBox.className = `connection-alert ${res.success ? 'status-connected' : (res.isLocal ? 'status-local' : 'status-error')}`;
      alertBox.textContent = res.message;
    }
    settingsModal.classList.add("active");
  };

  document.getElementById("openSettingsBtn").addEventListener("click", openSettings);
  const topPill = document.getElementById("topProgressPill");
  if (topPill) topPill.addEventListener("click", openSettings);

  document.getElementById("closeSettingsBtn").addEventListener("click", () => settingsModal.classList.remove("active"));

  // 연결 테스트 버튼
  const btnTestSb = document.getElementById("btnTestSbConnection");
  if (btnTestSb) {
    btnTestSb.addEventListener("click", async () => {
      const url = document.getElementById("cfgSbUrl").value.trim();
      const key = document.getElementById("cfgSbKey").value.trim();
      const alertBox = document.getElementById("sbConnectionAlert");
      btnTestSb.disabled = true;
      alertBox.className = "connection-alert status-loading";
      alertBox.textContent = "🔄 Supabase 데이터베이스 연결 확인 중...";
      const res = await window.checkSupabaseHealth(url, key);
      btnTestSb.disabled = false;
      alertBox.className = `connection-alert ${res.success ? 'status-connected' : (res.isLocal ? 'status-local' : 'status-error')}`;
      alertBox.textContent = res.message;
      await refreshDbStatusBadge();
    });
  }

  document.getElementById("btnSaveConfig").addEventListener("click", async () => {
    const url = document.getElementById("cfgSbUrl").value.trim();
    const key = document.getElementById("cfgSbKey").value.trim();
    const userIdInput = document.getElementById("cfgUserId")?.value.trim() || "";

    // 일일 학습 목표 저장
    const targetNew = parseInt(document.getElementById("cfgTargetNew")?.value) || 10;
    AppState.settings.targetNewWords = targetNew;

    const activeBook = AppState.wordbooks.find(b => Number(b.id) === Number(AppState.activeWordbookId));
    if (activeBook) {
      activeBook.daily_new_target = targetNew;
      const sb = window.getSupabase();
      if (sb && SUPABASE_CONFIG.isConfigured()) {
        try {
          await sb.from("wordbooks").update({ daily_new_target: targetNew }).eq("id", activeBook.id);
        } catch (e) {
          console.warn("Wordbook target update warning:", e);
        }
      }
    }
    saveLocalState();
    updateSidebarStats();

    const alertBox = document.getElementById("sbConnectionAlert");
    const btnSave = document.getElementById("btnSaveConfig");
    btnSave.disabled = true;
    alertBox.className = "connection-alert status-loading";
    alertBox.textContent = "🔄 연결 확인 및 설정 저장 중...";
    const res = await window.checkSupabaseHealth(url, key);
    btnSave.disabled = false;
    SUPABASE_CONFIG.saveConfig(url, key, userIdInput);
    initSupabase();
    await refreshDbStatusBadge();
    alertBox.className = `connection-alert ${res.success ? 'status-connected' : 'status-error'}`;
    alertBox.textContent = res.message;
    if (res.success) {
      alertBox.textContent = "🔄 Supabase 데이터베이스 동기화 중...";
      await syncWordsFromSupabase();
      alert("🌸 Supabase 설정이 저장되고 정상 연결되었습니다!");
      settingsModal.classList.remove("active");
    } else if (res.isLocal) {
      alert("⚠️ 유효한 Supabase URL과 Key를 입력해 주세요. (원격 DB 연동 전용)");
    } else {
      alert("⚠️ Supabase 연결 실패: " + res.message);
    }
  });

  // 상단 단어장 선택 변경 이벤트
  const activeBookSel = document.getElementById("activeWordbookSelect");
  if (activeBookSel) {
    activeBookSel.addEventListener("change", (e) => {
      selectWordbook(e.target.value);
    });
  }

  // 오늘 단어 목록 필터 탭
  document.querySelectorAll("#view-wordlist [data-filter]").forEach(btn => {
    btn.addEventListener("click", function () {
      document.querySelectorAll("#view-wordlist [data-filter]").forEach(b => b.classList.remove("active"));
      this.classList.add("active");
      AppState.wordlistState.filter = this.dataset.filter;
      renderWordListView();
    });
  });

  // 검색 & 정렬
  const searchInput = document.getElementById("wordlistSearchInput");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      AppState.wordlistState.search = e.target.value;
      renderWordListView();
    });
  }

  const sortSelect = document.getElementById("wordlistSortSelect");
  if (sortSelect) {
    sortSelect.addEventListener("change", (e) => {
      AppState.wordlistState.sort = e.target.value;
      renderWordListView();
    });
  }

  // 뜻 가리기 토글
  const toggleMeaningBtn = document.getElementById("toggleMeaningBtn");
  if (toggleMeaningBtn) {
    toggleMeaningBtn.addEventListener("click", () => {
      AppState.wordlistState.hideMeaning = !AppState.wordlistState.hideMeaning;
      toggleMeaningBtn.textContent = AppState.wordlistState.hideMeaning ? "👁️ 뜻 보이기" : "👁️ 뜻 가리기";
      renderWordListView();
    });
  }

  // 예문 접기 토글
  const toggleExampleBtn = document.getElementById("toggleExampleBtn");
  if (toggleExampleBtn) {
    toggleExampleBtn.addEventListener("click", () => {
      AppState.wordlistState.hideExample = !AppState.wordlistState.hideExample;
      toggleExampleBtn.textContent = AppState.wordlistState.hideExample ? "💬 예문 보이기" : "💬 예문 접기";
      renderWordListView();
    });
  }

  // 인쇄 버튼들
  const printMemoBtn = document.getElementById("printMemoBtn");
  if (printMemoBtn) printMemoBtn.addEventListener("click", printMemorizeBook);

  const printExamBtn = document.getElementById("printExamBtn");
  if (printExamBtn) printExamBtn.addEventListener("click", printBlankTest);

  // 상단 DB 상태 뱃지 클릭 시 설정 모달 열기
  const dbBadge = document.getElementById("dbStatusBadge");
  if (dbBadge) {
    dbBadge.style.cursor = "pointer";
    dbBadge.addEventListener("click", () => {
      settingsModal.classList.add("active");
    });
  }

  // 초기 뷰 렌더링
  switchView("study");

  // Supabase words 테이블 최신 단어 & 예문 비동기 로드
  refreshDbStatusBadge().then(() => {
    if (window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.isConfigured()) {
      syncWordsFromSupabase(AppState.activeWordbookId).then(success => {
        if (!success) {
          settingsModal.classList.add("active");
        }
      });
    } else {
      // Supabase 접속 정보 미설정 시 설정 모달 자동 노출
      settingsModal.classList.add("active");
    }
  });
});
