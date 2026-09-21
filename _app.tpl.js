// ============================================================
// 《续费全流程实战》微课 · 应用逻辑
// 数据从 #appDataJson 读取（JSON），避免转义问题
// ============================================================
const APP = JSON.parse(document.getElementById('appDataJson').textContent);
const courseData = { title: APP.title, sections: APP.sections };
const chapterQuizzes = APP.chapterQuizzes;

// ---------------- 状态 ----------------
const LS_PREFIX = APP.lsPrefix;
let currentSection = 0;
let completedSections = new Set();
let chapterQuizDone = new Array(chapterQuizzes.length).fill(false);
let chapterQuizAnswers = {};   // { 'chIdx_qi': { selected, isCorrect } }
let fillAnswers = {};          // { idx: { value, correct } } —— 第 4 章收单动作填空
let fillDone = false;
let finalTaskSubmitted = false;
let finalScore = 0;
let finalBreakdown = null;
let finalFeedbackText = '';
let finalConversationStarted = false;
let finalMessages = [];
let finalRound = 0;
let finalAiScoring = false;

// ---- 第 6 章 · 四段阶梯实战演练（练习，不计入考核） ----
// scenarios: { sc1: { started, messages:[], round, submitted, score, breakdown, feedback, aiScoring } }
let scenarios = {};
let scenarioActiveTab = '';
// ---- 第 6 章 · 三轮话术写作练习（本地关键词评分，不计入考核） ----
// writings: { wd1: { text, submitted, score, dims } }
let writings = {};

// ---------------- AI 后端 ----------------
// A 档：密钥在构建期以 XOR+hex 混淆注入；未注入时 _rK() 返回空串 → AI 按钮置灰并降级
const LLM_API_URL = APP.aiBaseUrl + '/chat/completions';
const LLM_MODEL = APP.aiModel;
const _HEX_KEY = '__MIMO_API_KEY__';
const _SALT = 'vipthink-cn-lp-renewal';
function _rK() {
  if (!_HEX_KEY || _HEX_KEY.indexOf('__') === 0) return '';
  let o = '';
  for (let i = 0; i < _HEX_KEY.length; i += 2) {
    const b = parseInt(_HEX_KEY.substr(i, 2), 16) ^ _SALT.charCodeAt((i / 2) % _SALT.length);
    o += String.fromCharCode(b);
  }
  return o;
}
function aiReady() { return _rK().length > 10; }

// 域名白名单（防止页面被搬运到其它站点后继续盗用对话额度）
const ALLOWED_HOSTS = APP.allowedHosts;
function guardHost() {
  const h = location.hostname;
  if (ALLOWED_HOSTS.indexOf(h) === -1) {
    showToast('🔒 本课程仅限官方站点使用，AI 功能已停用', 'warning');
    return false;
  }
  return true;
}

let studySeconds = 0; let timerInterval = null;

// ============================================================
// 初始化
// ============================================================
function init() {
  renderSidebar();
  renderSections();
  renderLevelLibrary();
  mountFillQuiz(4);       // 第 4 章填空题：挂载进内容里预留的容器 #fillQuizContainer4
  renderCh6ScenarioTabs();// 第 6 章四段阶梯实战演练：挂载进 #ch6ScenarioTabs
  renderWritingDrills();  // 第 6 章三轮话术写作练习：挂载进 #ch6WritingDrills
  loadProgress();
  startTimer();
  loadNotes();
}

function renderSidebar() {
  const nav = document.getElementById('sidebarNav');
  nav.innerHTML = courseData.sections.map((s, i) =>
    '<div class="nav-section" data-index="' + i + '" onclick="navigateTo(' + i + ')">' +
    '<div class="nav-icon">' + s.icon + '</div>' +
    '<div class="nav-info"><div class="nav-label">' + escapeHtml(s.title) + '</div>' +
    '<div class="nav-sub">⏱ ' + s.duration + '</div></div></div>').join('');
  updateSidebarLocks();
}

function updateSidebarLocks() {
  document.querySelectorAll('.nav-section').forEach((el, i) => {
    const check = canNavigateTo(i);
    if (!check.ok && i !== currentSection) el.classList.add('locked');
    else el.classList.remove('locked');
  });
}

function renderSections() {
  const main = document.getElementById('mainContent');
  main.innerHTML = courseData.sections.map((s, i) =>
    '<div class="section" data-section="' + i + '">' +
      s.content +
      quizBlockFor(i, s) +
      '<div class="section-nav-buttons">' +
        '<div>' + (i > 0 ? '<button class="btn btn-outline" onclick="navigateTo(' + (i - 1) + ')">← 上一章</button>' : '') + '</div>' +
        '<div>' + (i < courseData.sections.length - 1
          ? '<button class="btn" onclick="markComplete(' + i + ');navigateTo(' + (i + 1) + ')">下一章 →</button>'
          : '<button class="btn btn-success" id="completeCourseBtn" onclick="tryCompleteCourse(' + i + ')">✓ 完成课程</button>') +
        '</div>' +
      '</div>' +
    '</div>').join('');
  // 挂载终极考核的自由对话 UI
  const rc = document.getElementById('roleplayContainer');
  if (rc) rc.innerHTML = renderRoleplayHTML();
}

// 章节测验区块：选择题章节渲染选择题；第 4 章额外把填空题挂到 #fillQuizContainer4
function quizBlockFor(i, s) {
  let h = '';
  const hasQuiz = (s.type === 'content_quiz' || s.type === 'content_quiz_fill')
    && chapterQuizzes[i] && chapterQuizzes[i].length > 0;
  if (hasQuiz) h += renderChapterQuiz(i);
  return h;
}

// 填空题挂载：把题库渲染进内容里预留的容器（第 4 章，DOM 里 id="fillQuizContainer4"）
function mountFillQuiz(chapterNo) {
  const box = document.getElementById('fillQuizContainer' + chapterNo);
  if (box) box.innerHTML = renderFillQuiz();
}

// ============================================================
// 章节测验（串行锁定：答对上一题才解锁下一题）
// ============================================================
function renderChapterQuiz(chIdx) {
  const qs = chapterQuizzes[chIdx];
  if (!qs || qs.length === 0) return '';
  const title = '📝 ' + (chIdx + 1) + ' 章测验（共 ' + qs.length + ' 题，全部答对后解锁下一章）';
  return '<div class="card" style="border-top:4px solid var(--primary);" id="chquizwrap-' + chIdx + '">' +
    '<h2 style="margin-bottom:8px;">' + title + '</h2>' +
    '<p style="margin:0 0 12px 0;font-size:13px;color:var(--text-secondary);background:#FFF7ED;border-left:3px solid #F59E0B;padding:8px 12px;border-radius:4px">🔒 串行作答：第 1 题答对后才能解锁第 2 题，以此类推。答错的题可以点「重新作答」再做一次。</p>' +
    qs.map((q, qi) =>
      '<div class="quiz-card' + (qi > 0 && !isPreviousQuestionCorrect(chIdx, qi) ? ' locked' : '') + '" id="chquiz-' + chIdx + '-' + qi + '" data-answered="false">' +
        '<div class="quiz-question">第 ' + (qi + 1) + ' 题：' + escapeHtml(q.q) + '</div>' +
        '<div class="quiz-options">' + q.opts.map((opt, oi) =>
          '<div class="quiz-option" data-option="' + oi + '" onclick="selectChQuizOption(this,' + oi + ',' + chIdx + ',' + qi + ')">' +
          '<span class="quiz-option-label">' + String.fromCharCode(65 + oi) + '</span><span>' + escapeHtml(opt) + '</span></div>').join('') +
        '</div>' +
        '<div class="quiz-feedback" id="feedback-chquiz-' + chIdx + '-' + qi + '"></div>' +
        '<div class="quiz-locked-hint"><span>🔒 请先答对上一题，本题才会解锁</span></div>' +
      '</div>').join('') +
    '<div id="chquizstatus-' + chIdx + '" style="text-align:center;margin-top:8px;padding:12px;border-radius:8px;font-size:14px;background:' +
      (chapterQuizDone[chIdx] ? '#ECFDF5' : '#F8FAFC') + ';">' +
      (chapterQuizDone[chIdx]
        ? '<span style="color:#065F46;font-weight:600;">✅ 本章测验已全部通过！</span>'
        : '<span style="color:#64748B;">📋 请按顺序答完所有题目</span>') +
    '</div></div>';
}

function isPreviousQuestionCorrect(chIdx, qi) {
  if (qi === 0) return true;
  const prev = document.getElementById('chquiz-' + chIdx + '-' + (qi - 1));
  if (!prev) return false;
  return prev.dataset.answered === 'true' && !prev.querySelector('.quiz-option.wrong');
}

function updateChapterQuizLockState(chIdx) {
  const qs = chapterQuizzes[chIdx] || [];
  const done = chapterQuizDone[chIdx];
  qs.forEach((q, qi) => {
    const card = document.getElementById('chquiz-' + chIdx + '-' + qi);
    if (!card) return;
    // 本章已全部答对 → 清除所有锁定（否则刷新后会残留「锁定」外观）
    if (done || isPreviousQuestionCorrect(chIdx, qi)) card.classList.remove('locked');
    else card.classList.add('locked');
  });
}

function selectChQuizOption(el, oi, chIdx, qi) {
  const card = document.getElementById('chquiz-' + chIdx + '-' + qi);
  if (!card || card.dataset.answered === 'true') return;
  if (card.classList.contains('locked')) { showToast('🔒 请先答对上一题', 'warning'); return; }
  const q = chapterQuizzes[chIdx][qi];
  const isCorrect = (oi === q.correct);
  card.querySelectorAll('.quiz-option').forEach(b => {
    const optIdx = parseInt(b.dataset.option, 10);
    b.style.pointerEvents = 'none';
    if (isCorrect && optIdx === q.correct) b.classList.add('correct');
    else if (!isCorrect && optIdx === oi) b.classList.add('wrong');
    else b.classList.add('disabled');
  });
  const fb = document.getElementById('feedback-chquiz-' + chIdx + '-' + qi);
  if (isCorrect) {
    fb.innerHTML = '✅ 回答正确！';
    fb.classList.add('show', 'correct');
    card.style.borderColor = 'var(--success)';
  } else {
    // 学习者红线：不展示正确答案，只提示错误并允许重做
    fb.innerHTML = '❌ 这个选项还不对。再想一想第 ' + (qi + 1) + ' 题考的是哪个知识点，点「重新作答」再试一次。' +
      '<div class="quiz-retry"><button class="btn btn-outline btn-sm" onclick="resetChapterQuiz(' + chIdx + ',' + qi + ')">重新作答</button></div>';
    fb.classList.add('show', 'wrong');
    card.style.borderColor = 'var(--danger)';
  }
  card.dataset.answered = 'true';
  chapterQuizAnswers[chIdx + '_' + qi] = { selected: oi, isCorrect: isCorrect };
  updateChapterQuizLockState(chIdx);
  checkChapterQuizComplete(chIdx);
  saveProgress();
}

function resetChapterQuiz(chIdx, qi) {
  const card = document.getElementById('chquiz-' + chIdx + '-' + qi);
  if (!card) return;
  card.dataset.answered = 'false';
  card.querySelectorAll('.quiz-option').forEach(b => {
    b.classList.remove('correct', 'wrong', 'disabled');
    b.style.pointerEvents = '';
  });
  card.style.borderColor = '';
  const fb = document.getElementById('feedback-chquiz-' + chIdx + '-' + qi);
  fb.classList.remove('show', 'correct', 'wrong');
  fb.innerHTML = '';
  delete chapterQuizAnswers[chIdx + '_' + qi];
  updateChapterQuizLockState(chIdx);
  saveProgress();
}

function checkChapterQuizComplete(chIdx) {
  if (chapterQuizDone[chIdx]) return;
  const qs = chapterQuizzes[chIdx] || [];
  if (qs.length === 0) return;
  const allCorrect = qs.every((q, qi) => {
    const card = document.getElementById('chquiz-' + chIdx + '-' + qi);
    return card && card.dataset.answered === 'true' && !card.querySelector('.quiz-option.wrong');
  });
  if (!allCorrect) return;
  chapterQuizDone[chIdx] = true;
  refreshChapterQuizStatus(chIdx);
  showToast('🎉 第 ' + (chIdx + 1) + ' 章测验全部通过！', 'success');
  updateSidebarLocks();
  saveProgress();
}

// 刷新某章测验的底部状态条（首次渲染 / 答题完成 / 进度恢复 共用）
function refreshChapterQuizStatus(chIdx) {
  const el = document.getElementById('chquizstatus-' + chIdx);
  if (!el) return;
  const done = !!chapterQuizDone[chIdx];
  el.style.background = done ? '#ECFDF5' : '#F8FAFC';
  el.innerHTML = done
    ? '<span style="color:#065F46;font-weight:600;">✅ 本章测验已全部通过！</span>'
    : '<span style="color:#64748B;">📋 请按顺序答完所有题目</span>';
}

// ============================================================
// 填空题（收单动作关键词作答，答错可重填，不直接给答案）
// ============================================================
function normFill(s) {
  return String(s === undefined || s === null ? '' : s)
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。、；：！？,.;:!?"'“”‘’（）()【】\[\]《》<>·—－-]/g, '')
    .replace(/％/g, '%');
}

function renderFillQuiz() {
  const fills = APP.finalFills || [];
  if (!fills.length) return '';
  return '<div class="card" style="border-top:4px solid var(--accent);" id="fillwrap">' +
    '<h2 style="margin-bottom:8px;">✍️ 填空题 · 写出带付话术的关键动作（共 ' + fills.length + ' 题）</h2>' +
    '<p style="margin:0 0 12px 0;font-size:13px;color:var(--text-secondary);background:#FFF7ED;border-left:3px solid #F59E0B;padding:8px 12px;border-radius:4px">填写关键词即可，系统会自动忽略空格与标点。答错会给出知识点提示，可以反复重填。全部答对后解锁下一章。</p>' +
    fills.map((f, i) => {
      const rec = fillAnswers[i];
      const ok = rec && rec.correct;
      return '<div class="fill-card' + (ok ? ' ok' : '') + '" id="fill-' + i + '" data-answered="' + (ok ? 'true' : 'false') + '">' +
        '<div class="quiz-question">第 ' + (i + 1) + ' 题：' + escapeHtml(f.q) + '</div>' +
        '<div class="fill-row">' +
          '<input class="fill-input" id="fillInput-' + i + '" type="text" autocomplete="off" ' +
            'placeholder="' + escapeHtml(f.placeholder || '填写关键词') + '" ' +
            (ok ? 'disabled value="' + escapeHtml(rec.value) + '"' : '') +
            ' onkeypress="if(event.key===\'Enter\')submitFill(' + i + ')">' +
          (ok ? '' : '<button class="btn" id="fillBtn-' + i + '" onclick="submitFill(' + i + ')">提交</button>') +
        '</div>' +
        '<div class="quiz-feedback' + (ok ? ' show correct' : '') + '" id="fillFeedback-' + i + '">' +
          (ok ? '✅ 回答正确！' : '') +
        '</div>' +
      '</div>';
    }).join('') +
    '<div id="fillstatus" style="text-align:center;margin-top:8px;padding:12px;border-radius:8px;font-size:14px;background:' +
      (fillAllDone() ? '#ECFDF5' : '#F8FAFC') + ';">' +
      (fillAllDone()
        ? '<span style="color:#065F46;font-weight:600;">✅ 填空题已全部通过！</span>'
        : '<span style="color:#64748B;">📋 请依次填写完成全部填空题</span>') +
    '</div></div>';
}

function fillAllDone() {
  const fills = APP.finalFills || [];
  return fills.length > 0 && fills.every((f, i) => fillAnswers[i] && fillAnswers[i].correct);
}

function submitFill(idx) {
  const f = (APP.finalFills || [])[idx];
  const card = document.getElementById('fill-' + idx);
  if (!f || !card || card.dataset.answered === 'true') return;
  const input = document.getElementById('fillInput-' + idx);
  const fb = document.getElementById('fillFeedback-' + idx);
  const raw = input.value;
  if (!normFill(raw)) {
    fb.innerHTML = '请先填写答案再提交。';
    fb.classList.add('show', 'wrong');
    input.focus();
    return;
  }
  const ok = f.answer.some(a => normFill(a) === normFill(raw));
  if (ok) {
    card.dataset.answered = 'true';
    card.classList.add('ok');
    input.disabled = true;
    fillAnswers[idx] = { value: raw, correct: true };
    fb.innerHTML = '✅ 回答正确！';
    fb.classList.remove('wrong');
    fb.classList.add('show', 'correct');
    const btn = document.getElementById('fillBtn-' + idx);
    if (btn) btn.remove();
    showToast('✅ 第 ' + (idx + 1) + ' 题回答正确', 'success');
    checkFillComplete();
    saveProgress();
  } else {
    // 学习者红线：不展示正确答案，只给知识点提示，允许反复重填
    fb.innerHTML = '❌ 这一空还不对。<span class="fill-hint">💡 ' + escapeHtml(f.hint) + '</span>' +
      '<div class="quiz-retry"><button class="btn btn-outline btn-sm" onclick="resetFill(' + idx + ')">清空重填</button></div>';
    fb.classList.remove('correct');
    fb.classList.add('show', 'wrong');
  }
}

function resetFill(idx) {
  const card = document.getElementById('fill-' + idx);
  if (!card || card.dataset.answered === 'true') return;
  const input = document.getElementById('fillInput-' + idx);
  input.value = '';
  input.focus();
  const fb = document.getElementById('fillFeedback-' + idx);
  fb.classList.remove('show', 'wrong', 'correct');
  fb.innerHTML = '';
}

function checkFillComplete() {
  const allDone = fillAllDone();
  const statusEl = document.getElementById('fillstatus');
  if (statusEl) {
    statusEl.style.background = allDone ? '#ECFDF5' : '#F8FAFC';
    statusEl.innerHTML = allDone
      ? '<span style="color:#065F46;font-weight:600;">✅ 填空题已全部通过！</span>'
      : '<span style="color:#64748B;">📋 请依次填写完成全部填空题</span>';
  }
  if (allDone && !fillDone) showToast('🎉 填空题已全部通过！', 'success');
  fillDone = allDone;
  updateSidebarLocks();
}

function restoreFillUI() {
  const fills = APP.finalFills || [];
  for (let i = 0; i < fills.length; i++) {
    const rec = fillAnswers[i];
    if (!rec) continue;
    const card = document.getElementById('fill-' + i);
    const input = document.getElementById('fillInput-' + i);
    const fb = document.getElementById('fillFeedback-' + i);
    if (rec.correct) {
      if (card) { card.dataset.answered = 'true'; card.classList.add('ok'); }
      if (input) { input.value = rec.value; input.disabled = true; }
      const btn = document.getElementById('fillBtn-' + i);
      if (btn) btn.remove();
      if (fb) { fb.innerHTML = '✅ 回答正确！'; fb.classList.add('show', 'correct'); }
    }
  }
  checkFillComplete();
}

// ============================================================
// 第 6 章 · S1-S9 九级速查库（折叠卡片，S5/S6/S7 为热点）
// ============================================================
function renderLevelLibrary() {
  const box = document.getElementById('levelLibrary');
  const levels = APP.levelLibrary || [];
  if (!box || !levels.length) return;
  // position 字段来自课程内容（可信本地数据），保留少量行内标签用于强调；其余字段一律转义
  const richText = (s) => escapeHtml(s).replace(/&lt;(\/?)(strong|em|b|br)\s*\/?&gt;/g, '<$1$2>');
  const stuckHtml = (l) => (l.stuck || []).map(s =>
    '<div class="lv-stuck"><b>卡点：' + escapeHtml(s[0]) + '</b><br>' +
    '👀 表现：' + escapeHtml(s[1]) + '<br>' +
    '<span class="lv-fix">🛠 应对：' + escapeHtml(s[2]) + '</span></div>').join('');
  box.innerHTML = '<div class="level-grid">' + levels.map((l, i) =>
    '<div class="level-card' + (l.hot ? ' is-hot' : '') + '" id="levelcard-' + i + '">' +
      '<div class="level-card-h" onclick="toggleLevelCard(' + i + ')">' +
        '<div class="lv-badge">' + escapeHtml(l.level) + '</div>' +
        '<div class="lv-title"><b>' + escapeHtml(l.grade || '') + (l.hot ? ' · 重点衔接级' : '') + '</b>' +
          '<span>' + richText(l.position || '') + '</span></div>' +
        '<div class="lv-caret">▼</div>' +
      '</div>' +
      '<div class="level-card-body">' +
        '<div class="lv-sec"><div class="lv-sec-h">⚠️ 常见卡点与应对</div>' + stuckHtml(l) + '</div>' +
        '<div class="lv-sec"><div class="lv-sec-h">📐 本级能建立什么</div><ul>' +
          (l.build || []).map(x => '<li>' + richText(x) + '</li>').join('') + '</ul></div>' +
        '<div class="lv-sec"><div class="lv-sec-h">🔄 升级后新增变化</div><ul>' +
          (l.change || []).map(x => '<li>' + richText(x) + '</li>').join('') + '</ul></div>' +
        '<div class="lv-tip">💡 用法：家长问「孩子现在学得怎么样／还能往上走吗」时，先定位到当前级别，再顺着上一条讲「下一步能拿到什么」。</div>' +
      '</div>' +
    '</div>').join('') + '</div>';
}

function toggleLevelCard(i) {
  const card = document.getElementById('levelcard-' + i);
  if (card) card.classList.toggle('open');
}

// ============================================================
// 导航与解锁
// ============================================================
function canNavigateTo(index) {
  if (index === 0) return { ok: true };
  // 章序：0 底层逻辑 → 1 学情反馈 → 2 课程规划 → 3 课包方案+推单收单 → 4 异议处理 → 5 学习反馈+终极考核
  if (index >= 1 && !chapterQuizDone[0]) return { ok: false, msg: '请先完成第 1 章的所有测验题（全部答对）' };
  if (index >= 2 && !chapterQuizDone[1]) return { ok: false, msg: '请先完成第 2 章的所有测验题（全部答对）' };
  if (index >= 3 && !chapterQuizDone[2]) return { ok: false, msg: '请先完成第 3 章的所有测验题（全部答对）' };
  if (index >= 4 && !chapterQuizDone[3]) return { ok: false, msg: '请先完成第 4 章的测验题与填空题（全部答对）' };
  if (index >= 4 && !fillAllDone()) return { ok: false, msg: '请先完成第 4 章的填空题（全部答对）' };
  if (index >= 5 && !chapterQuizDone[4]) return { ok: false, msg: '请先完成第 5 章的所有测验题（全部答对）' };
  return { ok: true };
}

function navigateTo(index) {
  const check = canNavigateTo(index);
  if (!check.ok) { showToast('🔒 ' + check.msg, 'warning'); return; }
  currentSection = index;
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-section').forEach(n => n.classList.remove('active'));
  const section = document.querySelector('.section[data-section="' + index + '"]');
  if (section) section.classList.add('active');
  const navItem = document.querySelector('.nav-section[data-index="' + index + '"]');
  if (navItem) navItem.classList.add('active');
  updateProgress(); updateNotesForSection(index); saveProgress();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('show');
  const mhTitle = document.getElementById('mhTitle');
  if (mhTitle) mhTitle.textContent = courseData.sections[index].title;
}

function markComplete(index) {
  completedSections.add(index);
  updateProgress(); saveProgress();
  showToast('「' + courseData.sections[index].title + '」已完成 ✓', 'success');
  checkCertificate();
}

// 终极考核 = 第 4 章填空题（收单动作） + AI 家长自由对话评分
// 说明：本课第 6 章为纯内容章（学习反馈与复习引导），不设综合选择题；
//      15 道选择题分散在第 1/2/3/4/5 章，各章「全部答对」即解锁下一章。
function finalQuizDone() {
  // 末章若有测验题，需全部答对；本课末章无题，视为已满足
  const qs = chapterQuizzes[courseData.sections.length - 1] || [];
  return qs.length === 0 || !!chapterQuizDone[courseData.sections.length - 1];
}
function finalFillsDone() { return fillAllDone(); }

function tryCompleteCourse(index) {
  if (!finalFillsDone()) { showToast('请先完成第 4 章的填空题（全部答对）', 'warning'); return; }
  if (!finalTaskSubmitted) { showToast('请先完成终极考核的 AI 家长对话并提交评分', 'warning'); return; }
  if (finalScore < 60) { showToast('AI 对话评分尚未通过，请点击「重新开始」再试一次', 'warning'); return; }
  markComplete(index);
}

function updateProgress() {
  const total = courseData.sections.length;
  const viewed = new Set([...completedSections, currentSection]);
  const pct = Math.round((viewed.size / total) * 100);
  document.getElementById('progressPercent').textContent = pct + '%';
  document.getElementById('progressFill').style.width = pct + '%';
  document.querySelectorAll('.nav-section').forEach((el, i) => {
    if (completedSections.has(i)) el.classList.add('completed');
  });
}

// ============================================================
// AI 调用（含限流 / 域名白名单 / 降级）
// ============================================================
const RATE_LIMIT_KEY = LS_PREFIX + '_llm_rate_ts';
const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_WINDOW = 3600000;
function checkRateLimit() {
  const now = Date.now();
  let ts = [];
  try { ts = JSON.parse(localStorage.getItem(RATE_LIMIT_KEY) || '[]'); } catch (e) { ts = []; }
  ts = ts.filter(t => now - t < RATE_LIMIT_WINDOW);
  if (ts.length >= RATE_LIMIT_MAX) {
    const resetIn = Math.ceil((ts[0] + RATE_LIMIT_WINDOW - now) / 60000);
    throw new Error('对话次数已达每小时上限，约 ' + resetIn + ' 分钟后恢复。');
  }
  ts.push(now);
  localStorage.setItem(RATE_LIMIT_KEY, JSON.stringify(ts));
}
async function callLLM(messages, options) {
  options = options || {};
  const maxTokens = options.maxTokens || 500;
  const temperature = (options.temperature === undefined) ? 0.7 : options.temperature;
  if (!aiReady()) throw new Error('AI 功能未配置');
  if (!guardHost()) throw new Error('AI 功能已停用');
  checkRateLimit();
  const res = await fetch(LLM_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + _rK() },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: messages,
      thinking: { type: 'disabled' },        // mimo-v2.5-pro 必须关闭思考，否则 content 为空
      max_completion_tokens: maxTokens,      // 参数名映射：max_tokens → max_completion_tokens
      temperature: temperature
    })
  });
  if (!res.ok) {
    let err = 'AI 服务繁忙 (' + res.status + ')';
    try { const j = await res.json(); err = (j.error && j.error.message) || j.message || err; } catch (e) {}
    throw new Error(err);
  }
  return await res.json();
}

// ============================================================
// 终极考核：AI 家长自由对话（洋阳妈妈）
// ============================================================
function renderRoleplayHTML() {
  return '<div class="dialogue-container" id="finalDialogue">' +
    '<div class="dialogue-header"><span>📞 续费沟通 · 自由对话（家长：洋阳妈妈）</span>' +
      '<div class="dialogue-meta"><span class="badge badge-primary">🔄 对话轮数：<b id="finalRound">0</b></span>' +
      '<span class="badge badge-warning" id="finalTopicBadge">📍 当前话题：-</span></div></div>' +
    '<div class="dialogue-messages" id="finalMessages">' +
      '<div class="chat-msg system" style="justify-content:center"><div class="chat-bubble" style="background:#F8FAFC;color:var(--text-secondary);max-width:90%;text-align:center">点击「开始通话」后，洋阳妈妈将接通，对话会显示在这里。至少完成 4 轮交流再结束评分。</div></div></div>' +
    '<div class="dialogue-input-area" id="finalInputArea">' +
      '<input type="text" id="finalInput" placeholder="输入你要对家长说的话..." disabled onkeypress="if(event.key===\'Enter\')sendFinalMessage()">' +
      '<button class="btn" id="finalSendBtn" onclick="sendFinalMessage()" disabled>发送</button></div>' +
    '</div>' +
    '<div class="final-actions" style="margin-top:16px;display:flex;gap:12px;justify-content:center;flex-wrap:wrap">' +
      '<button class="btn btn-success final-call-btn" id="finalStartBtn" onclick="startFinalConversation()">📞 开始通话</button>' +
      '<button class="btn" id="finalEndBtn" onclick="endFinalConversation()" disabled>🛑 结束并评分</button>' +
      '<button class="btn btn-outline" onclick="resetFinalConversation()">🔄 重新开始</button></div>' +
    '<div class="ai-feedback-panel" id="finalFeedback"></div>';
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---- 通用聊天渲染（支持多实例：终极考核 final / 第 6 章四段演练 sc1..sc4） ----
// key      ：实例标识，决定 DOM id 前缀（finalMessages / scenarioMessages-sc1 ...）
// persona  ：家长显示名（如「洋阳妈妈」）
// avatar   ：家长头像文字（如「妈」）
function renderChatMessage(key, persona, avatar, role, text) {
  const container = document.getElementById(key + 'Messages');
  if (!container) return;
  const div = document.createElement('div');
  div.className = 'chat-msg ' + (role === 'lp' ? 'lp' : 'parent');
  const label = role === 'lp' ? '班主任 · 我' : persona;
  const av = role === 'lp' ? '我' : avatar;
  div.innerHTML = '<div class="chat-avatar">' + escapeHtml(av) + '</div><div class="chat-content">' +
    '<div class="chat-label">' + escapeHtml(label) + '</div><div class="chat-bubble">' + escapeHtml(text) + '</div></div>';
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function showChatTyping(key, persona, avatar, show) {
  const elId = key + 'Typing';
  let el = document.getElementById(elId);
  if (!show) { if (el) el.remove(); return; }
  if (el) return;
  const container = document.getElementById(key + 'Messages');
  if (!container) return;
  el = document.createElement('div');
  el.id = elId;
  el.className = 'chat-msg parent';
  el.innerHTML = '<div class="chat-avatar">' + escapeHtml(avatar) + '</div><div class="chat-content">' +
    '<div class="chat-label">' + escapeHtml(persona) + '</div>' +
    '<div class="typing-indicator"><span></span><span></span><span></span></div></div>';
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

// 兼容层：终极考核沿用旧函数名，行为不变
function renderFinalMessage(role, text) { renderChatMessage('final', '洋阳妈妈', '妈', role, text); }
function showFinalTyping(show) { showChatTyping('final', '洋阳妈妈', '妈', show); }

function updateFinalTopic() {
  const lastAi = finalMessages.filter(m => m.role === 'assistant').pop();
  const lastText = lastAi ? lastAi.content : '';
  let topic = '开场寒暄';
  for (const t of APP.topicTags) {
    if (t.kw && t.kw.some(k => lastText.indexOf(k) !== -1)) { topic = t.name; break; }
  }
  const badge = document.getElementById('finalTopicBadge');
  if (badge) badge.textContent = '📍 当前话题：' + topic;
  return topic;
}

function getFinalFallbackReply(userText) {
  for (const pair of APP.fallbackReplies) {
    if (pair[0].some(k => userText.indexOf(k) !== -1)) return pair[1];
  }
  return '嗯，我听明白了。不过这件事我还得再想想，你能再跟我说说具体怎么安排吗？';
}

async function startFinalConversation() {
  if (finalConversationStarted || finalAiScoring) return;
  finalConversationStarted = true;
  finalMessages = [{ role: 'system', content: APP.finalSystemPrompt }];
  finalRound = 0;
  document.getElementById('finalStartBtn').disabled = true;
  document.getElementById('finalInput').disabled = false;
  document.getElementById('finalSendBtn').disabled = false;
  document.getElementById('finalEndBtn').disabled = false;
  document.getElementById('finalMessages').innerHTML = '';
  showFinalTyping(true);
  let reply = '喂，你好，请问哪位？';
  try {
    const data = await callLLM(finalMessages, { maxTokens: 200, temperature: 0.75 });
    reply = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim() || reply;
  } catch (e) {
    showToast('AI 家长暂时无法接通，已切换为脚本模拟回复', 'warning');
  } finally {
    showFinalTyping(false);
  }
  finalMessages.push({ role: 'assistant', content: reply });
  renderFinalMessage('parent', reply);
  updateFinalTopic();
  saveProgress();
}

async function sendFinalMessage() {
  if (!finalConversationStarted || finalAiScoring || finalTaskSubmitted) return;
  const input = document.getElementById('finalInput');
  const text = (input.value || '').trim();
  if (!text) return;
  input.value = '';
  renderFinalMessage('lp', text);
  finalMessages.push({ role: 'user', content: text });
  finalRound++;
  document.getElementById('finalRound').textContent = finalRound;
  document.getElementById('finalInput').disabled = true;
  document.getElementById('finalSendBtn').disabled = true;
  showFinalTyping(true);
  let reply;
  try {
    const data = await callLLM(finalMessages, { maxTokens: 200, temperature: 0.75 });
    reply = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim() || getFinalFallbackReply(text);
  } catch (e) {
    reply = getFinalFallbackReply(text);
    showToast('AI 服务暂时不可用，已切换为脚本模拟回复', 'warning');
  } finally {
    showFinalTyping(false);
    if (!finalTaskSubmitted) {
      document.getElementById('finalInput').disabled = false;
      document.getElementById('finalSendBtn').disabled = false;
      document.getElementById('finalInput').focus();
    }
  }
  finalMessages.push({ role: 'assistant', content: reply });
  renderFinalMessage('parent', reply);
  updateFinalTopic();
  saveProgress();
}

async function endFinalConversation() {
  if (!finalConversationStarted || finalAiScoring || finalTaskSubmitted) return;
  if (finalRound < 4) { showToast('请至少完成 4 轮对话再结束评分', 'warning'); return; }
  finalAiScoring = true;
  document.getElementById('finalInput').disabled = true;
  document.getElementById('finalSendBtn').disabled = true;
  document.getElementById('finalEndBtn').disabled = true;
  showToast('正在调用 AI 评分官...', 'success');
  await scoreFinalConversation();
}

async function scoreFinalConversation() {
  const dialogue = finalMessages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => (m.role === 'user' ? '班主任' : '洋阳妈妈') + '：' + m.content).join('\n');
  const scoringPrompt = APP.scoringPrompt.replace('{dialogue}', dialogue);
  try {
    const data = await callLLM([
      { role: 'system', content: '你是一位严格而公正的评分官，只输出合法 JSON，不要任何多余文字。' },
      { role: 'user', content: scoringPrompt }
    ], { maxTokens: 800, temperature: 0.3 });
    const raw = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
    let result = {};
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      result = JSON.parse(m ? m[0] : raw);
    } catch (e) { console.warn('AI 评分 JSON 解析失败：', raw); }
    const sc = parseInt(result.score, 10);
    finalScore = Math.min(100, Math.max(0, isNaN(sc) ? 65 : sc));
    finalBreakdown = result.breakdown || null;
    finalFeedbackText = result.feedback || '已完成考核。';
  } catch (e) {
    console.error('AI 评分失败：', e);
    finalScore = 0;
    finalBreakdown = null;
    finalFeedbackText = 'AI 评分服务暂时不可用，本次未获得评分。请点击「重新开始」再试一次。';
  } finally {
    finalAiScoring = false;
    if (finalScore > 0) finalTaskSubmitted = true;
    renderFinalScore();
    saveProgress();
    updateSidebarLocks();
    if (finalTaskSubmitted) checkCertificate();
  }
}

function renderFinalScore() {
  const fb = document.getElementById('finalFeedback');
  if (!fb) return;
  if (!finalTaskSubmitted) {
    fb.innerHTML = '<div style="padding:16px;background:#FEF2F2;border-radius:8px;font-size:14px;color:#991B1B;text-align:center">' + escapeHtml(finalFeedbackText) + '</div>';
    fb.classList.add('show');
    return;
  }
  const score = finalScore;
  const level = score >= 80 ? 'high' : score >= 60 ? 'medium' : 'low';
  const levelText = score >= 80 ? '优秀！流程完整，信息准确，家长顾虑处理得体。'
    : score >= 60 ? '通过！整体沟通完整，细节还可以再打磨。'
    : '还需要更多练习，建议回顾前几章后重新开始。';
  const bd = finalBreakdown || {};
  const dim = (k, label) => '<div class="final-score-card"><div class="score">' + (bd[k] === undefined ? '—' : bd[k]) + '</div><div class="label">' + label + '</div></div>';
  fb.innerHTML =
    '<div class="score-display"><div class="score-circle ' + level + '">' + score + '</div>' +
    '<div style="font-size:13px;color:var(--text-secondary);margin-top:4px">综合评分</div></div>' +
    '<p style="text-align:center;font-size:14px;margin-bottom:16px;font-weight:600">' + levelText + '</p>' +
    '<div class="final-score-grid">' + dim('流程', '流程规范性 /30') + dim('准确', '信息准确性 /30') +
    dim('亲合', '服务亲和力 /25') + dim('覆盖', '话题覆盖度 /15') + '</div>' +
    '<div class="final-feedback-text"><strong>AI 评分官点评：</strong><br>' + escapeHtml(finalFeedbackText) + '</div>' +
    (score >= 60
      ? '<div style="margin-top:16px;padding:14px;background:#ECFDF5;border-radius:8px;font-size:14px;color:#065F46;text-align:center"><strong>✅ 考核通过！</strong> 点击右下角「完成课程」即可领取结业证书。</div>'
      : '<div style="margin-top:16px;padding:14px;background:#FEF2F2;border-radius:8px;font-size:14px;color:#991B1B;text-align:center"><strong>📖 本次未通过。</strong> 请点击「重新开始」，回顾前面的章节后再试一次。</div>');
  fb.classList.add('show');
}

function resetFinalConversation() {
  finalConversationStarted = false;
  finalTaskSubmitted = false;
  finalScore = 0;
  finalBreakdown = null;
  finalFeedbackText = '';
  finalRound = 0;
  finalMessages = [];
  finalAiScoring = false;
  const c = document.getElementById('finalMessages');
  if (c) c.innerHTML = '<div class="chat-msg system" style="justify-content:center"><div class="chat-bubble" style="background:#F8FAFC;color:var(--text-secondary);max-width:90%;text-align:center">点击「开始通话」后，洋阳妈妈将接通，对话会显示在这里。至少完成 4 轮交流再结束评分。</div></div>';
  document.getElementById('finalInput').value = '';
  document.getElementById('finalInput').disabled = true;
  document.getElementById('finalSendBtn').disabled = true;
  document.getElementById('finalEndBtn').disabled = true;
  document.getElementById('finalStartBtn').disabled = false;
  document.getElementById('finalRound').textContent = '0';
  document.getElementById('finalTopicBadge').textContent = '📍 当前话题：-';
  const fb = document.getElementById('finalFeedback');
  fb.classList.remove('show'); fb.innerHTML = '';
  updateSidebarLocks(); saveProgress();
}

function restoreFinalConversation() {
  if (!finalConversationStarted) return;
  const container = document.getElementById('finalMessages');
  if (!container) return;
  container.innerHTML = '';
  finalMessages.forEach(m => {
    if (m.role === 'system') return;
    if (m.role === 'user') renderFinalMessage('lp', m.content);
    if (m.role === 'assistant') renderFinalMessage('parent', m.content);
  });
  document.getElementById('finalRound').textContent = finalRound;
  updateFinalTopic();
  if (finalTaskSubmitted) {
    document.getElementById('finalInput').disabled = true;
    document.getElementById('finalSendBtn').disabled = true;
    document.getElementById('finalEndBtn').disabled = true;
    document.getElementById('finalStartBtn').disabled = true;
    renderFinalScore();
  } else {
    document.getElementById('finalStartBtn').disabled = true;
    document.getElementById('finalInput').disabled = false;
    document.getElementById('finalSendBtn').disabled = false;
    document.getElementById('finalEndBtn').disabled = false;
  }
}

// ============================================================
// 第 6 章 · 四段阶梯实战演练（练习，不计入考核，不卡通关）
// 交互形式参照示例课：Tab 标签页切换场景 + 多轮自由对话
// ============================================================
function scState(id) {
  if (!scenarios[id]) {
    scenarios[id] = {
      started: false, messages: [], round: 0,
      submitted: false, score: 0, breakdown: null, feedback: '', aiScoring: false
    };
  }
  return scenarios[id];
}
function scMeta(id) {
  return (APP.ch6DialogueScenarios || []).filter(s => s.id === id)[0] || null;
}

function renderCh6ScenarioTabs() {
  const box = document.getElementById('ch6ScenarioTabs');
  const list = APP.ch6DialogueScenarios || [];
  if (!box || !list.length) return;
  if (!scenarioActiveTab) scenarioActiveTab = list[0].id;
  box.innerHTML =
    '<div class="tab-wrap" id="scTabBar">' +
      list.map(s => '<button class="tab-btn' + (s.id === scenarioActiveTab ? ' active' : '') +
        '" data-sctab="' + s.id + '" onclick="switchScenarioTab(\'' + s.id + '\')">' + escapeHtml(s.tab) + '</button>').join('') +
    '</div>' +
    list.map(s => '<div class="tab-panel' + (s.id === scenarioActiveTab ? ' active' : '') + '" id="scPanel-' + s.id + '">' +
      renderScenarioBody(s) + '</div>').join('');
  list.forEach(s => restoreScenarioUI(s.id));
}

function switchScenarioTab(id) {
  scenarioActiveTab = id;
  const bar = document.getElementById('scTabBar');
  if (bar) bar.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.sctab === id);
  });
  const wrap = document.getElementById('ch6ScenarioTabs');
  if (wrap) wrap.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'scPanel-' + id));
}

function renderScenarioBody(s) {
  const st = scState(s.id);
  const topic0 = (s.topic_tags && s.topic_tags[0]) ? s.topic_tags[0].name : '开场寒暄';
  return '<div class="scenario-card" id="scCard-' + s.id + '">' +
    '<div class="scenario-setup">' +
      '<div class="ss-title">' + escapeHtml(s.title) + '</div>' +
      '<div class="ss-body">' + s.setup + '</div>' +
      '<div class="ss-meta">🧭 <strong>建议至少完成 ' + s.min_rounds + ' 轮对话</strong>（练习，不计分、不计入考核，随时可退出）</div>' +
    '</div>' +
    '<div class="dialogue-container" id="' + s.id + 'Dialogue">' +
      '<div class="dialogue-header"><span>📞 ' + escapeHtml(s.persona_name) + ' · 自由对话</span>' +
        '<div class="dialogue-meta">' +
          '<span class="badge badge-primary">🔄 对话轮数：<b id="' + s.id + 'Round">' + (st.round || 0) + '</b></span>' +
          '<span class="badge badge-warning" id="' + s.id + 'TopicBadge">📍 当前话题：' + escapeHtml(topic0) + '</span>' +
        '</div></div>' +
      '<div class="dialogue-messages" id="' + s.id + 'Messages">' +
        '<div class="chat-msg system" style="justify-content:center"><div class="chat-bubble" style="background:#F8FAFC;color:var(--text-secondary);max-width:90%;text-align:center">点击「开始练习」后，' + escapeHtml(s.persona_name) + '将接通，对话会显示在这里。</div></div>' +
      '</div>' +
      '<div class="dialogue-input-area">' +
        '<input type="text" id="' + s.id + 'Input" placeholder="输入你要对家长说的话..." disabled onkeypress="if(event.key===\'Enter\')sendScenarioMessage(\'' + s.id + '\')">' +
        '<button class="btn" id="' + s.id + 'SendBtn" onclick="sendScenarioMessage(\'' + s.id + '\')" disabled>发送</button>' +
      '</div>' +
    '</div>' +
    '<div class="final-actions" style="margin-top:14px;display:flex;gap:12px;justify-content:center;flex-wrap:wrap">' +
      '<button class="btn" id="' + s.id + 'StartBtn" onclick="startScenario(\'' + s.id + '\')">🎬 开始练习</button>' +
      '<button class="btn btn-success" id="' + s.id + 'ScoreBtn" onclick="endScenario(\'' + s.id + '\')" disabled>📊 结束并评分</button>' +
      '<button class="btn btn-outline" onclick="resetScenario(\'' + s.id + '\')">🔄 重新开始</button>' +
    '</div>' +
    '<div class="ai-feedback-panel" id="' + s.id + 'Feedback"></div>' +
  '</div>';
}

function updateScenarioTopic(id) {
  const s = scMeta(id), st = scState(id);
  if (!s) return '开场寒暄';
  const lastAi = st.messages.filter(m => m.role === 'assistant').pop();
  const lastText = lastAi ? lastAi.content : '';
  let topic = (s.topic_tags && s.topic_tags[0]) ? s.topic_tags[0].name : '开场寒暄';
  for (const t of (s.topic_tags || [])) {
    if (t.kw && t.kw.some(k => lastText.indexOf(k) !== -1)) { topic = t.name; break; }
  }
  const badge = document.getElementById(id + 'TopicBadge');
  if (badge) badge.textContent = '📍 当前话题：' + topic;
  return topic;
}

function getScenarioFallback(s, userText) {
  for (const pair of (s.fallback_replies || [])) {
    if (pair[0].some(k => userText.indexOf(k) !== -1)) return pair[1];
  }
  return '嗯，我听明白了。不过这事我还得再想想，你能再跟我说说具体怎么安排吗？';
}

async function startScenario(id) {
  const s = scMeta(id), st = scState(id);
  if (!s || st.started || st.aiScoring) return;
  st.started = true;
  st.messages = [{ role: 'system', content: s.system_prompt }];
  st.round = 0;
  const startBtn = document.getElementById(id + 'StartBtn');
  if (startBtn) startBtn.disabled = true;
  const input = document.getElementById(id + 'Input'), sendBtn = document.getElementById(id + 'SendBtn');
  if (input) { input.disabled = false; }
  if (sendBtn) sendBtn.disabled = false;
  const scoreBtn = document.getElementById(id + 'ScoreBtn');
  if (scoreBtn) scoreBtn.disabled = false;
  const box = document.getElementById(id + 'Messages');
  if (box) box.innerHTML = '';
  showChatTyping(id, s.persona_name, '妈', true);
  let reply = '喂，你好，请问哪位？';
  try {
    const data = await callLLM(st.messages, { maxTokens: 200, temperature: 0.75 });
    reply = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim() || reply;
  } catch (e) {
    showToast('AI 家长暂时无法接通，已切换为脚本模拟回复', 'warning');
  } finally {
    showChatTyping(id, s.persona_name, '妈', false);
  }
  st.messages.push({ role: 'assistant', content: reply });
  renderChatMessage(id, s.persona_name, '妈', 'parent', reply);
  updateScenarioTopic(id);
  saveProgress();
}

async function sendScenarioMessage(id) {
  const s = scMeta(id), st = scState(id);
  if (!s || !st.started || st.aiScoring) return;
  const input = document.getElementById(id + 'Input');
  if (!input) return;
  const text = (input.value || '').trim();
  if (!text) return;
  input.value = '';
  renderChatMessage(id, s.persona_name, '妈', 'lp', text);
  st.messages.push({ role: 'user', content: text });
  st.round++;
  const rEl = document.getElementById(id + 'Round');
  if (rEl) rEl.textContent = st.round;
  input.disabled = true;
  const sendBtn = document.getElementById(id + 'SendBtn');
  if (sendBtn) sendBtn.disabled = true;
  showChatTyping(id, s.persona_name, '妈', true);
  let reply;
  try {
    const data = await callLLM(st.messages, { maxTokens: 200, temperature: 0.75 });
    reply = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim() || getScenarioFallback(s, text);
  } catch (e) {
    reply = getScenarioFallback(s, text);
    showToast('AI 服务暂时不可用，已切换为脚本模拟回复', 'warning');
  } finally {
    showChatTyping(id, s.persona_name, '妈', false);
    input.disabled = false;
    if (sendBtn) sendBtn.disabled = false;
    input.focus();
  }
  st.messages.push({ role: 'assistant', content: reply });
  renderChatMessage(id, s.persona_name, '妈', 'parent', reply);
  updateScenarioTopic(id);
  saveProgress();
}

async function endScenario(id) {
  const s = scMeta(id), st = scState(id);
  if (!s || !st.started || st.aiScoring || st.submitted) return;
  if (st.round < s.min_rounds) {
    showToast('建议至少完成 ' + s.min_rounds + ' 轮对话再评分（练习不计入考核，可继续聊）', 'warning');
    return;
  }
  st.aiScoring = true;
  const input = document.getElementById(id + 'Input');
  if (input) input.disabled = true;
  const sendBtn = document.getElementById(id + 'SendBtn');
  if (sendBtn) sendBtn.disabled = true;
  const scoreBtn = document.getElementById(id + 'ScoreBtn');
  if (scoreBtn) scoreBtn.disabled = true;
  showToast('正在调用 AI 评分官...', 'success');
  await scoreScenario(id);
}

async function scoreScenario(id) {
  const s = scMeta(id), st = scState(id);
  if (!s) return;
  const pname = s.persona_name;
  const dialogue = st.messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => (m.role === 'user' ? '班主任' : pname) + '：' + m.content).join('\n');
  const scoringPrompt = s.scoring_prompt.replace('{dialogue}', dialogue);
  try {
    const data = await callLLM([
      { role: 'system', content: '你是一位严格而公正的评分官，只输出合法 JSON，不要任何多余文字。' },
      { role: 'user', content: scoringPrompt }
    ], { maxTokens: 800, temperature: 0.3 });
    const raw = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
    let result = {};
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      result = JSON.parse(m ? m[0] : raw);
    } catch (e) { console.warn('第 6 章演练评分 JSON 解析失败：', raw); }
    const sc = parseInt(result.score, 10);
    st.score = Math.min(100, Math.max(0, isNaN(sc) ? 65 : sc));
    st.breakdown = result.breakdown || null;
    st.feedback = result.feedback || '本次练习已完成。';
  } catch (e) {
    console.error('第 6 章演练评分失败：', e);
    st.score = 0;
    st.breakdown = null;
    st.feedback = 'AI 评分服务暂时不可用，本次未获得评分。可以点「重新开始」再练一次。';
  } finally {
    st.aiScoring = false;
    if (st.score > 0) st.submitted = true;
    renderScenarioScore(id);
    saveProgress();
  }
}

// 练习区红线：只展示实际得分，不设通过线、不显示「未通过」
function renderScenarioScore(id) {
  const s = scMeta(id), st = scState(id);
  const fb = document.getElementById(id + 'Feedback');
  if (!s || !fb) return;
  if (!st.submitted) {
    fb.innerHTML = '<div style="padding:16px;background:#FEF2F2;border-radius:8px;font-size:14px;color:#991B1B;text-align:center">' + escapeHtml(st.feedback) + '</div>';
    fb.classList.add('show');
    return;
  }
  const score = st.score;
  const bd = st.breakdown || {};
  const dims = s.dims || [];
  fb.innerHTML =
    '<div class="score-display"><div class="score-circle ' + (score >= 80 ? 'high' : score >= 60 ? 'medium' : 'low') + '">' + score + '</div>' +
    '<div style="font-size:13px;color:var(--text-secondary);margin-top:4px">本次练习得分</div></div>' +
    '<div class="scenario-dims">' + dims.map(d =>
      '<div class="final-score-card"><div class="score">' + (bd[d.key] === undefined ? '—' : escapeHtml(String(bd[d.key]))) + '</div>' +
      '<div class="label">' + escapeHtml(d.name) + ' /' + d.max + '</div></div>').join('') + '</div>' +
    '<div class="final-feedback-text"><strong>AI 评分官点评：</strong><br>' + escapeHtml(st.feedback) + '</div>' +
    '<div class="scenario-note">🧪 本区为练习，不设通过线、不计入考核，可点「重新开始」反复练习。</div>';
  fb.classList.add('show');
}

function resetScenario(id) {
  const s = scMeta(id);
  if (!s) return;
  scenarios[id] = { started: false, messages: [], round: 0, submitted: false, score: 0, breakdown: null, feedback: '', aiScoring: false };
  const topic0 = (s.topic_tags && s.topic_tags[0]) ? s.topic_tags[0].name : '开场寒暄';
  const box = document.getElementById(id + 'Messages');
  if (box) box.innerHTML = '<div class="chat-msg system" style="justify-content:center"><div class="chat-bubble" style="background:#F8FAFC;color:var(--text-secondary);max-width:90%;text-align:center">点击「开始练习」后，' + escapeHtml(s.persona_name) + '将接通，对话会显示在这里。</div></div>';
  const input = document.getElementById(id + 'Input');
  if (input) { input.value = ''; input.disabled = true; }
  const sendBtn = document.getElementById(id + 'SendBtn'); if (sendBtn) sendBtn.disabled = true;
  const scoreBtn = document.getElementById(id + 'ScoreBtn'); if (scoreBtn) scoreBtn.disabled = true;
  const startBtn = document.getElementById(id + 'StartBtn'); if (startBtn) startBtn.disabled = false;
  const rEl = document.getElementById(id + 'Round'); if (rEl) rEl.textContent = '0';
  const tEl = document.getElementById(id + 'TopicBadge'); if (tEl) tEl.textContent = '📍 当前话题：' + topic0;
  const fb = document.getElementById(id + 'Feedback');
  if (fb) { fb.classList.remove('show'); fb.innerHTML = ''; }
  saveProgress();
}

function restoreScenarioUI(id) {
  const s = scMeta(id), st = scState(id);
  if (!s || !st.started) return;
  const box = document.getElementById(id + 'Messages');
  if (box) box.innerHTML = '';
  st.messages.forEach(m => {
    if (m.role === 'system') return;
    if (m.role === 'user') renderChatMessage(id, s.persona_name, '妈', 'lp', m.content);
    if (m.role === 'assistant') renderChatMessage(id, s.persona_name, '妈', 'parent', m.content);
  });
  const rEl = document.getElementById(id + 'Round'); if (rEl) rEl.textContent = st.round;
  updateScenarioTopic(id);
  const input = document.getElementById(id + 'Input'), sendBtn = document.getElementById(id + 'SendBtn');
  const scoreBtn = document.getElementById(id + 'ScoreBtn'), startBtn = document.getElementById(id + 'StartBtn');
  if (st.submitted) {
    if (input) input.disabled = true;
    if (sendBtn) sendBtn.disabled = true;
    if (scoreBtn) scoreBtn.disabled = true;
    if (startBtn) startBtn.disabled = true;
    renderScenarioScore(id);
  } else {
    if (startBtn) startBtn.disabled = true;
    if (input) input.disabled = false;
    if (sendBtn) sendBtn.disabled = false;
    if (scoreBtn) scoreBtn.disabled = false;
  }
}

// ============================================================
// 第 6 章 · 三轮话术写作练习（本地关键词评分，不消耗 AI 额度，不计入考核）
// ============================================================
function renderWritingDrills() {
  const box = document.getElementById('ch6WritingDrills');
  const list = APP.ch6WritingDrills || [];
  if (!box || !list.length) return;
  box.innerHTML = list.map((d, i) => {
    const st = writings[d.id] || {};
    const done = !!st.submitted;
    return '<div class="writing-card" id="wc-' + d.id + '">' +
      '<div class="wc-head"><h3>' + escapeHtml(d.title) + '</h3>' +
        '<span class="badge badge-primary">5 维 × 20 分</span></div>' +
      '<div class="wc-scene">🎬 <strong>场景：</strong>' + escapeHtml(d.scene) + '</div>' +
      '<div class="wc-info">👦 <strong>学员信息：</strong>' + d.student_info + '</div>' +
      '<div class="wc-task">📝 <strong>任务：</strong>' + d.task + '</div>' +
      '<textarea class="practice-textarea" id="wt-' + d.id + '" rows="8" placeholder="' + escapeHtml(d.placeholder) + '"' + (done ? ' disabled' : '') + '>' + (st.text ? escapeHtml(st.text) : '') + '</textarea>' +
      '<div class="wc-actions">' +
        '<button class="btn" id="wsub-' + d.id + '" onclick="submitWriting(\'' + d.id + '\')"' + (done ? ' style="display:none"' : '') + '>📝 提交评分</button>' +
        '<span class="wc-warn" id="wwarn-' + d.id + '" style="display:none">⚠️ 字数不足，请继续补充</span>' +
        (done ? '<span class="wc-done" id="wdone-' + d.id + '">✅ 已提交（' + st.score + ' 分）</span>' : '') +
        '<button class="btn btn-outline btn-sm" id="wreset-' + d.id + '" onclick="resetWriting(\'' + d.id + '\')"' + (done ? '' : ' style="display:none"') + '>🔄 重新作答</button>' +
      '</div>' +
      '<div class="ch3-ref-panel" id="wscore-' + d.id + '"></div>' +
      '<div class="ch3-ref-panel" id="wref-' + d.id + '">' +
        '<div class="highlight-box success"><strong>📋 参考话术（仅作参考，并非唯一答案）：</strong><br>' + d.ref_answer + '</div>' +
        '<div class="tips-box" style="margin-top:12px">' + escapeHtml(d.ref_tips) + '</div>' +
      '</div>' +
    '</div>';
  }).join('');
  list.forEach(d => restoreWritingUI(d.id));
}

function submitWriting(id) {
  const d = (APP.ch6WritingDrills || []).filter(x => x.id === id)[0];
  const ta = document.getElementById('wt-' + id);
  if (!d || !ta) return;
  const raw = (ta.value || '').trim();
  const warn = document.getElementById('wwarn-' + id);
  if (raw.length < d.min_len) {
    if (warn) { warn.textContent = '⚠️ 至少 ' + d.min_len + ' 字（当前 ' + raw.length + ' 字），请继续补充'; warn.style.display = 'inline'; }
    ta.focus();
    return;
  }
  if (warn) warn.style.display = 'none';
  const t = raw.toLowerCase();
  let total = 0;
  const dimResults = (d.dims || []).map(dim => {
    const matched = (dim.kw || []).filter(k => t.indexOf(String(k).toLowerCase()) !== -1);
    const score = Math.min(dim.max, matched.length * 4);
    total += score;
    return { name: dim.name, score: score, max: dim.max, matched: matched.slice(0, 6) };
  });
  writings[id] = { text: raw, submitted: true, score: total, dims: dimResults };
  ta.disabled = true;
  const sub = document.getElementById('wsub-' + id); if (sub) sub.style.display = 'none';
  const res = document.getElementById('wreset-' + id); if (res) res.style.display = '';
  const card = document.getElementById('wc-' + id);
  if (card) card.classList.add('submitted');
  let doneEl = document.getElementById('wdone-' + id);
  if (!doneEl) {
    doneEl = document.createElement('span');
    doneEl.id = 'wdone-' + id;
    doneEl.className = 'wc-done';
    const actions = card ? card.querySelector('.wc-actions') : null;
    if (actions && res) actions.insertBefore(doneEl, res);
    else if (actions) actions.appendChild(doneEl);
  }
  doneEl.textContent = '✅ 已提交（' + total + ' 分）';
  renderWritingScore(id);
  saveProgress();
}

function renderWritingScore(id) {
  const st = writings[id];
  const panel = document.getElementById('wscore-' + id);
  const refPanel = document.getElementById('wref-' + id);
  if (!st || !st.submitted || !panel) return;
  panel.innerHTML = '<div class="card" style="margin-top:16px;border-top:4px solid var(--accent)">' +
    '<h2 style="margin-bottom:6px;color:var(--primary)">📊 本次写作得分</h2>' +
    '<p style="font-size:13px;color:var(--text-secondary);margin-bottom:14px">本地关键词命中评分——命中 1 处计 4 分，单维上限 20 分。<strong>练习不计入考核。</strong></p>' +
    '<div class="wc-score-dims">' + (st.dims || []).map((dim, i) => {
      const pct = Math.round(dim.score / dim.max * 100);
      const color = pct >= 75 ? '#059669' : pct >= 40 ? '#D97706' : '#DC2626';
      return '<div class="wc-dim">' +
        '<div class="wc-dim-top"><span>' + (i + 1) + '. ' + escapeHtml(dim.name) + '</span>' +
        '<span style="color:' + color + '">' + dim.score + '/' + dim.max + '</span></div>' +
        '<div class="wc-bar"><div class="wc-bar-in" style="width:' + pct + '%;background:' + color + '"></div></div>' +
        '<div class="wc-kw">命中：' + (dim.matched.length ? escapeHtml(dim.matched.join('、')) : '未命中关键词') + '</div>' +
      '</div>';
    }).join('') + '</div>' +
    '<div class="wc-total"><div class="score-circle ' + (st.score >= 80 ? 'high' : st.score >= 60 ? 'medium' : 'low') + '">' + st.score + '</div>' +
    '<div style="font-size:13px;color:var(--text-secondary);margin-top:4px">总分 ' + st.score + ' / 100</div></div>' +
    '<div class="scenario-note">🧪 本练习不设通过线、不计入考核。对照下方参考话术看看还有哪些要点可以补上。</div>' +
  '</div>';
  panel.classList.add('show');
  if (refPanel) refPanel.classList.add('show');
}

function resetWriting(id) {
  const d = (APP.ch6WritingDrills || []).filter(x => x.id === id)[0];
  if (!d) return;
  delete writings[id];
  const ta = document.getElementById('wt-' + id);
  if (ta) { ta.disabled = false; ta.value = ''; if (ta.focus) ta.focus(); }
  const sub = document.getElementById('wsub-' + id); if (sub) sub.style.display = '';
  const res = document.getElementById('wreset-' + id); if (res) res.style.display = 'none';
  const doneEl = document.getElementById('wdone-' + id); if (doneEl) doneEl.remove();
  const warn = document.getElementById('wwarn-' + id); if (warn) warn.style.display = 'none';
  const panel = document.getElementById('wscore-' + id); if (panel) { panel.classList.remove('show'); panel.innerHTML = ''; }
  const refPanel = document.getElementById('wref-' + id); if (refPanel) refPanel.classList.remove('show');
  const card = document.getElementById('wc-' + id); if (card) card.classList.remove('submitted');
  saveProgress();
}

function restoreWritingUI(id) {
  const st = writings[id];
  if (!st || !st.submitted) return;
  const ta = document.getElementById('wt-' + id);
  if (ta) { ta.disabled = true; if (st.text) ta.value = st.text; }
  const sub = document.getElementById('wsub-' + id); if (sub) sub.style.display = 'none';
  const res = document.getElementById('wreset-' + id); if (res) res.style.display = '';
  const card = document.getElementById('wc-' + id); if (card) card.classList.add('submitted');
  let doneEl = document.getElementById('wdone-' + id);
  if (!doneEl && card) {
    doneEl = document.createElement('span');
    doneEl.id = 'wdone-' + id;
    doneEl.className = 'wc-done';
    const actions = card.querySelector('.wc-actions');
    if (actions) (res ? actions.insertBefore(doneEl, res) : actions.appendChild(doneEl));
  }
  if (doneEl) doneEl.textContent = '✅ 已提交（' + st.score + ' 分）';
  renderWritingScore(id);
}


function startTimer() {
  const saved = localStorage.getItem(LS_PREFIX + '_study_seconds');
  if (saved) studySeconds = parseInt(saved, 10);
  updateTimerDisplay();
  timerInterval = setInterval(() => {
    studySeconds++;
    updateTimerDisplay();
    if (studySeconds % 10 === 0) localStorage.setItem(LS_PREFIX + '_study_seconds', studySeconds);
  }, 1000);
}
function updateTimerDisplay() {
  const mins = Math.floor(studySeconds / 60), secs = studySeconds % 60;
  const ts = String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
  const el = document.getElementById('timerDisplay'); if (el) el.textContent = ts;
  const mt = document.getElementById('mhTimer'); if (mt) mt.textContent = '⏱ ' + ts;
}

function switchTab(btn, panelId) {
  const wrap = btn.closest('.card') || document;
  wrap.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  wrap.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  const panel = document.getElementById(panelId);
  if (panel) panel.classList.add('active');
}

function toggleNotes() { document.getElementById('notesPanel').classList.toggle('open'); }
function updateNotesForSection(index) {
  document.getElementById('notesChapterLabel').textContent = courseData.sections[index].title;
  const saved = JSON.parse(localStorage.getItem(LS_PREFIX + '_notes') || '{}');
  document.getElementById('notesTextarea').value = saved[index] || '';
}
function loadNotes() {
  const saved = JSON.parse(localStorage.getItem(LS_PREFIX + '_notes') || '{}');
  const ta = document.getElementById('notesTextarea');
  if (!ta) return;
  ta.value = saved[currentSection] || '';
  ta.addEventListener('input', function () {
    const all = JSON.parse(localStorage.getItem(LS_PREFIX + '_notes') || '{}');
    all[currentSection] = this.value;
    localStorage.setItem(LS_PREFIX + '_notes', JSON.stringify(all));
  });
}

// ============================================================
// 进度持久化
// ============================================================
function restoreChapterQuizUI() {
  Object.keys(chapterQuizAnswers).forEach(key => {
    const parts = key.split('_').map(Number);
    const chIdx = parts[0], qi = parts[1];
    if (isNaN(chIdx) || isNaN(qi)) return;
    const ans = chapterQuizAnswers[key];
    if (!ans) return;
    const card = document.getElementById('chquiz-' + chIdx + '-' + qi);
    if (!card) return;
    card.dataset.answered = 'true';
    card.querySelectorAll('.quiz-option').forEach(b => {
      const oi = parseInt(b.dataset.option, 10);
      b.style.pointerEvents = 'none';
      if (ans.isCorrect && oi === (chapterQuizzes[chIdx][qi] || {}).correct) b.classList.add('correct');
      else if (!ans.isCorrect && oi === ans.selected) b.classList.add('wrong');
      else b.classList.add('disabled');
    });
    const fb = document.getElementById('feedback-chquiz-' + chIdx + '-' + qi);
    if (fb) {
      if (ans.isCorrect) {
        fb.innerHTML = '✅ 回答正确！';
        fb.classList.add('show', 'correct');
        card.style.borderColor = 'var(--success)';
      } else {
        fb.innerHTML = '❌ 这个选项还不对。点「重新作答」再试一次。' +
          '<div class="quiz-retry"><button class="btn btn-outline btn-sm" onclick="resetChapterQuiz(' + chIdx + ',' + qi + ')">重新作答</button></div>';
        fb.classList.add('show', 'wrong');
        card.style.borderColor = 'var(--danger)';
      }
    }
  });
}

function saveProgress() {
  const state = {
    completedSections: [...completedSections],
    chapterQuizDone: chapterQuizDone,
    chapterQuizAnswers: chapterQuizAnswers,
    fillAnswers: fillAnswers,
    fillDone: fillDone,
    finalTaskSubmitted: finalTaskSubmitted,
    finalScore: finalScore,
    finalBreakdown: finalBreakdown,
    finalFeedbackText: finalFeedbackText,
    finalConversationStarted: finalConversationStarted,
    finalMessages: finalMessages,
    finalRound: finalRound,
    finalAiScoring: false,
    scenarios: scenarios,
    scenarioActiveTab: scenarioActiveTab,
    writings: writings,
    currentSection: currentSection
  };
  try { localStorage.setItem(LS_PREFIX + '_progress', JSON.stringify(state)); } catch (e) {}
}

function loadProgress() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_PREFIX + '_progress'));
    if (saved) {
      completedSections = new Set(saved.completedSections || []);
      chapterQuizDone = saved.chapterQuizDone || new Array(chapterQuizzes.length).fill(false);
      if (chapterQuizDone.length !== chapterQuizzes.length) chapterQuizDone = new Array(chapterQuizzes.length).fill(false);
      chapterQuizAnswers = saved.chapterQuizAnswers || {};
      fillAnswers = saved.fillAnswers || {};
      fillDone = false;
      finalTaskSubmitted = saved.finalTaskSubmitted || false;
      finalScore = saved.finalScore || 0;
      finalBreakdown = saved.finalBreakdown || null;
      finalFeedbackText = saved.finalFeedbackText || '';
      finalConversationStarted = saved.finalConversationStarted || false;
      finalMessages = saved.finalMessages || [];
      finalRound = saved.finalRound || 0;
      scenarios = saved.scenarios || {};
      Object.keys(scenarios).forEach(k => { scenarios[k].aiScoring = false; });
      scenarioActiveTab = saved.scenarioActiveTab || '';
      writings = saved.writings || {};
      currentSection = saved.currentSection || 0;
      // 兼容旧数据：有完成标记但没有答题记录 → 重置测验状态
      const hasDoneButNoAnswers = chapterQuizDone.some(d => d) && Object.keys(chapterQuizAnswers).length === 0;
      if (hasDoneButNoAnswers) chapterQuizDone = new Array(chapterQuizzes.length).fill(false);
      if (!canNavigateTo(currentSection).ok) currentSection = 0;
      updateProgress();
      updateSidebarLocks();
      restoreChapterQuizUI();
      for (let i = 0; i < chapterQuizzes.length; i++) {
        if (chapterQuizzes[i] && chapterQuizzes[i].length > 0) {
          updateChapterQuizLockState(i);
          refreshChapterQuizStatus(i);
        }
      }
      restoreFillUI();
      restoreFinalConversation();
      // 第 6 章练习区：Tab 已按 scenarioActiveTab 渲染，这里恢复对话与写作状态
      (APP.ch6DialogueScenarios || []).forEach(s => restoreScenarioUI(s.id));
      (APP.ch6WritingDrills || []).forEach(d => restoreWritingUI(d.id));
      document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
      const section = document.querySelector('.section[data-section="' + currentSection + '"]');
      if (section) section.classList.add('active');
      const navItem = document.querySelector('.nav-section[data-index="' + currentSection + '"]');
      if (navItem) navItem.classList.add('active');
      const mhTitle = document.getElementById('mhTitle');
      if (mhTitle) mhTitle.textContent = courseData.sections[currentSection].title;
    } else {
      navigateTo(0);
    }
  } catch (e) {
    navigateTo(0);
  }
}

// ============================================================
// 结业证书
// ============================================================
function checkCertificate() {
  const allDone = completedSections.size >= courseData.sections.length
    && finalFillsDone() && finalTaskSubmitted && finalScore >= 60;
  if (!allDone) return;
  setTimeout(() => {
    showToast('🏆 恭喜完成全部课程！点击领取结业证书', 'success');
    // 证书口径：章节测验（15 题）+ 收单填空（3 题）+ AI 对话得分
    const mcqTotal = chapterQuizzes.reduce((n, qs) => n + (qs ? qs.length : 0), 0);
    const fills = APP.finalFills || [];
    const fillN = fills.filter((f, i) => fillAnswers[i] && fillAnswers[i].correct).length;
    document.getElementById('certScore').textContent =
      '综合评定：通过（章节测验 ' + mcqTotal + '/' + mcqTotal + ' · 填空题 ' + fillN + '/' + fills.length + '）';
    document.getElementById('certFinalScore').textContent = 'AI 对话考核得分：' + finalScore + ' 分';
    document.getElementById('certDate').textContent = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
    const savedName = localStorage.getItem(LS_PREFIX + '_student_name');
    if (savedName) {
      document.getElementById('certStudentName').textContent = savedName;
      document.getElementById('certNameEdit').style.display = 'none';
    } else {
      document.getElementById('certNameEdit').style.display = 'block';
      document.getElementById('certNameInput').focus();
    }
    document.getElementById('certOverlay').style.display = 'flex';
  }, 800);
}
function saveCertName() {
  const input = document.getElementById('certNameInput');
  const name = (input.value || '').trim();
  if (!name) { showToast('请输入姓名后再确认', 'warning'); input.focus(); return; }
  localStorage.setItem(LS_PREFIX + '_student_name', name);
  document.getElementById('certStudentName').textContent = name;
  document.getElementById('certNameEdit').style.display = 'none';
  showToast('✅ 姓名已保存', 'success');
}
function closeCertificate() { document.getElementById('certOverlay').style.display = 'none'; }
function printCertificate() {
  const name = document.getElementById('certStudentName').textContent;
  if (!name || name === '请填写姓名') { showToast('请先确认姓名后再打印证书', 'warning'); return; }
  const cert = document.getElementById('certPaper');
  const win = window.open('', '_blank', 'width=750,height=600');
  win.document.write('<html><head><meta charset="UTF-8"><title>结业证书</title><style>');
  win.document.write('body{font-family:"PingFang SC","Microsoft YaHei",sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f1f5f9;}');
  win.document.write('.cert{background:#fff;width:700px;padding:48px 36px;text-align:center;border:2px solid #e2e8f0;border-radius:12px;}');
  win.document.write('.cert h1{font-size:28px;color:#3730A3;margin-bottom:4px;}');
  win.document.write('.cert .sub{font-size:12px;color:#64748b;letter-spacing:0.1em;margin-bottom:24px;}');
  win.document.write('.cert .body{font-size:15px;line-height:2;color:#1e293b;}');
  win.document.write('.cert .name{display:inline-block;border-bottom:2px solid #4F46E5;min-width:120px;padding:4px 12px;margin:0 4px;}');
  win.document.write('.cert .course{font-weight:700;color:#3730A3;margin:8px 0;}');
  win.document.write('.cert .score{margin:20px 0 4px;font-size:16px;font-weight:600;color:#10b981;}');
  win.document.write('.cert .final-score{margin:4px 0 20px;font-size:14px;font-weight:600;color:#3730A3;}');
  win.document.write('.cert .footer{display:flex;justify-content:space-between;font-size:12px;color:#64748b;margin-top:32px;border-top:1px solid #e2e8f0;padding-top:16px;}');
  win.document.write('</style></head><body><div class="cert">');
  win.document.write(cert.innerHTML.replace(/<button[^>]*>[\s\S]*?<\/button>/g, '').replace(/<div class="cert-name-edit"[\s\S]*?<\/div><\/div>/g, ''));
  win.document.write('</div></body></html>');
  win.document.close(); setTimeout(() => win.print(), 500);
}

// ============================================================
// Toast / 侧边栏
// ============================================================
function showToast(msg, type) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'toast ' + type;
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2500);
}
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebarOverlay').classList.toggle('show');
}

document.addEventListener('DOMContentLoaded', init);
