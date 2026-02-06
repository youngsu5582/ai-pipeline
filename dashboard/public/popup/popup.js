// 요소 참조
const container = document.getElementById('container');
const character = document.getElementById('character');
const question = document.getElementById('question');
const inputTextarea = document.getElementById('inputTextarea');
const inputButtons = document.getElementById('inputButtons');
const inputReview = document.getElementById('inputReview');
const textInput = document.getElementById('textInput');
const reviewInput = document.getElementById('reviewInput');
const quickButtons = document.getElementById('quickButtons');
const entriesList = document.getElementById('entriesList');
const sessionsList = document.getElementById('sessionsList');
const btnSubmit = document.getElementById('btnSubmit');
const btnSkip = document.getElementById('btnSkip');
const loading = document.getElementById('loading');
const success = document.getElementById('success');
const successMessage = document.getElementById('successMessage');

// 현재 작업
let currentJob = null;
let collectedData = null;

// Character emoji mapping
const characterEmojis = {
  default: '🤖',   // robot
  asking: '🤔',    // thinking
  happy: '😊',     // smile
  reminder: '🙏',  // prayer hands
};

// Thank you messages
const thankYouMessages = [
  '고마워요! 좋은 하루 되세요 ✨',
  '기록 완료! 잘하고 있어요 💪',
  '남겨줘서 고마워요 📝',
  '오늘도 화이팅! 🔥'
];

// 데이터 수신 이벤트
if (window.electronAPI) {
  window.electronAPI.onPopupData((data) => {
    currentJob = data.job;
    collectedData = data.collectedData;
    initializeUI();
  });
}

// UI 초기화
function initializeUI() {
  if (!currentJob) return;

  const popup = currentJob.popup || {};

  // 캐릭터 설정
  const characterState = popup.character || 'default';
  character.innerHTML = characterEmojis[characterState] || characterEmojis.default;
  character.className = `character ${characterState}`;

  // 질문 설정 (랜덤 선택)
  const prompts = popup.prompts || ['무엇을 도와드릴까요?'];
  question.innerHTML = prompts[Math.floor(Math.random() * prompts.length)];

  // 입력 타입에 따른 UI 표시
  const inputType = popup.inputType || 'textarea';
  hideAllInputs();

  switch (inputType) {
    case 'quick-buttons':
      setupQuickButtons(popup.buttons || ['확인', '나중에']);
      inputButtons.classList.remove('hidden');
      break;

    case 'review':
      setupReview();
      inputReview.classList.remove('hidden');
      break;

    default:
      inputTextarea.classList.remove('hidden');
      textInput.placeholder = popup.placeholder || '간단히 적어주세요...';
      textInput.focus();
  }

  // 버튼 텍스트 업데이트
  if (popup.inputType === 'review') {
    btnSubmit.innerHTML = '&#128640; 정리하기';
  }
}

// 모든 입력 영역 숨기기
function hideAllInputs() {
  inputTextarea.classList.add('hidden');
  inputButtons.classList.add('hidden');
  inputReview.classList.add('hidden');
}

// Quick Buttons 설정
function setupQuickButtons(buttons) {
  quickButtons.innerHTML = '';

  buttons.forEach((label, index) => {
    const btn = document.createElement('button');
    btn.className = 'quick-btn';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      if (index === 0) {
        // 첫 번째 버튼 = 확인
        submitResponse(label);
      } else {
        // 나머지 = 스킵
        skipPopup();
      }
    });
    quickButtons.appendChild(btn);
  });
}

// Review 설정
function setupReview() {
  // 오늘 기록
  entriesList.innerHTML = '';
  const entries = collectedData?.entries || [];

  if (entries.length === 0) {
    entriesList.innerHTML = '<li class="empty">기록이 없어요</li>';
  } else {
    entries.forEach(entry => {
      const li = document.createElement('li');
      const time = new Date(entry.time).toLocaleTimeString('ko-KR', {
        hour: '2-digit',
        minute: '2-digit'
      });
      li.innerHTML = `<span class="time">${time}</span>${escapeHtml(entry.text)}`;
      entriesList.appendChild(li);
    });
  }

  // Claude 세션
  sessionsList.innerHTML = '';
  const sessions = collectedData?.sessions || [];

  if (sessions.length === 0) {
    sessionsList.innerHTML = '<li class="empty">세션이 없어요</li>';
  } else {
    sessions.forEach(session => {
      const li = document.createElement('li');
      li.textContent = session.summary || session.firstPrompt?.substring(0, 50) || '(제목 없음)';
      sessionsList.appendChild(li);
    });
  }
}

// HTML 이스케이프
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// 제출
async function submitResponse(text) {
  const inputType = currentJob?.popup?.inputType || 'textarea';
  let response;

  switch (inputType) {
    case 'quick-buttons':
      response = text;
      break;
    case 'review':
      response = reviewInput.value.trim();
      break;
    default:
      response = textInput.value.trim();
  }

  if (!response && inputType !== 'quick-buttons') {
    // 빈 입력 허용 여부 확인
    if (currentJob?.popup?.allowEmpty !== true) {
      textInput.focus();
      return;
    }
  }

  showLoading();

  try {
    if (window.electronAPI) {
      await window.electronAPI.submitPopup({
        text: response,
        job: currentJob,
        collectedData
      });
    }

    showSuccess();
  } catch (error) {
    console.error('Submit error:', error);
    alert('오류가 발생했어요: ' + error.message);
    hideLoading();
  }
}

// 스킵
async function skipPopup() {
  if (window.electronAPI) {
    await window.electronAPI.skipPopup();
  }
}

// 로딩 표시
function showLoading() {
  document.querySelector('.header').style.display = 'none';
  hideAllInputs();
  document.querySelector('.actions').style.display = 'none';
  loading.classList.remove('hidden');
}

// 로딩 숨기기
function hideLoading() {
  document.querySelector('.header').style.display = 'flex';
  loading.classList.add('hidden');
  document.querySelector('.actions').style.display = 'flex';
  initializeUI();
}

// 성공 표시
function showSuccess() {
  loading.classList.add('hidden');
  success.classList.remove('hidden');
  character.innerHTML = characterEmojis.happy;
  character.className = 'character happy';

  const message = thankYouMessages[Math.floor(Math.random() * thankYouMessages.length)];
  successMessage.innerHTML = message;

  // 1.5초 후 자동 닫기
  setTimeout(() => {
    if (window.electronAPI) {
      window.electronAPI.hideWindow();
    }
  }, 1500);
}

// 이벤트 리스너
btnSubmit.addEventListener('click', () => submitResponse());
btnSkip.addEventListener('click', skipPopup);

// 키보드 이벤트
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    const activeElement = document.activeElement;
    if (activeElement.tagName === 'TEXTAREA') {
      e.preventDefault();
      submitResponse();
    }
  } else if (e.key === 'Escape') {
    skipPopup();
  }
});

// 개발용: 테스트 데이터
if (!window.electronAPI) {
  currentJob = {
    id: 'test',
    name: '테스트',
    popup: {
      character: 'asking',
      prompts: ['지금 뭐 하고 있어요? &#128522;'],
      inputType: 'textarea',
      placeholder: '간단히 적어주세요...'
    }
  };
  collectedData = {
    entries: [
      { time: new Date().toISOString(), text: '테스트 기록 1' },
      { time: new Date().toISOString(), text: '테스트 기록 2' }
    ],
    sessions: [
      { summary: 'Dashboard 구현' },
      { summary: 'Electron 앱 개발' }
    ]
  };
  initializeUI();
}
