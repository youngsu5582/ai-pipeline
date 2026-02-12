# AI Pipeline 🤖📝

> **CLI AI 대화를 지식으로 바꾸는 Zero-Friction 파이프라인**

Claude, ChatGPT, Codex와 나눈 대화가 휘발되지 않고 **Obsidian에 체계적으로 저장**되어 나만의 Second Brain이 됩니다.

```
AI 대화 → 정제 → Obsidian → 주간 회고 → 월간 성장 리포트
```

## 왜 만들었나요?

매일 AI와 대화하면서 배우는 게 많은데, 대화가 끝나면 **다 사라집니다**.

- "어제 Claude한테 물어본 거 뭐였지?"
- "지난주에 해결한 Kafka 이슈 어디 적어뒀더라..."
- "이번 달 뭘 배웠는지 모르겠네"

AI Pipeline은 이 문제를 해결합니다:

| 문제 | 해결 |
|------|------|
| 대화 휘발 | 자동으로 Obsidian에 저장 |
| 지식 파편화 | 주제별 자동 분류 |
| 성장 추적 어려움 | 주간/월간 회고 자동 생성 |
| 맥락 손실 | 고민/상황도 함께 기록 |

## 핵심 기능

### 🚀 빠른 기록
```bash
# 순간의 생각 즉시 기록 (태그로 분류)
quick "Kafka consumer rebalancing 주의해야함"
quick "#issue 배포 순서 고민됨"
quick "#insight 코드리뷰하다가 깨달음"
```

### 📅 일일 관리
```bash
# 아침: 오늘의 템플릿 생성
daily-init

# 저녁: AI 대화 + GitHub 활동 동기화
ai-daily
sync-github --today
```

### 📊 자동 회고
```bash
# 주간: 배운 것 + 퀴즈 생성
ai-weekly

# 월간: 성장 리포트
ai-monthly
```

## 웹 대시보드

CLI 스크립트를 통합 관리하는 **웹 대시보드**를 제공합니다.

```bash
cd dashboard
npm install
npm run dev    # http://localhost:3030
```

### 주요 기능

| 기능 | 설명 |
|------|------|
| **작업 관리** | 크론 스케줄링, 수동 실행, 실행 이력/통계 |
| **파이프라인** | 작업 간 의존성 그래프 + 조건부 실행 |
| **통합 타임라인** | 메모, 세션, GitHub 활동을 시간순으로 조회 |
| **AI 인사이트** | 주간 다이제스트, 생산성 분석, 스마트 서제스션 |
| **세션 관리** | Claude Code 세션 요약 + 지식 그래프 시각화 |
| **노트** | 빠른 메모/백로그 + AI 자동 분류 |
| **알림** | Slack/Discord 채널별 규칙 기반 알림 |
| **PWA** | 모바일 반응형 + 오프라인 지원 |

### 탭 구조

```
홈 - 오늘의 요약, 타임라인, 빠른 액션
작업 - 작업 목록 / 실행 이력 / 통계
설정 - Slack, 웹훅, 알림 채널 관리
세션 - 세션 목록 / 지식 그래프 / 리뷰 분석
노트 - 메모 + 백로그 (카테고리 필터)
분석 - 종합 / 하루 시작 / 오늘 보고서 / 주간 분석
```

## 설치

### 1. 저장소 클론
```bash
git clone https://github.com/youngsu5582/ai-pipeline.git
cd ai-pipeline
```

### 2. Python 환경 설정
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 3. 설정 파일 생성
```bash
cp config/settings.example.yaml config/settings.local.yaml
```

`config/settings.local.yaml` 수정:
```yaml
vault:
  path: "~/Documents/Obsidian"    # 본인 Obsidian vault 경로
  drafts_folder: "study/_drafts"
  daily_folder: "DAILY"

sync:
  github:
    enabled: true
    repos:
      - "~/Projects/my-project"   # 본인 프로젝트 경로
```

### 4. API 키 설정
```bash
# ~/.zshrc 또는 ~/.bashrc에 추가
export GOOGLE_API_KEY="your-gemini-api-key"

# Gemini API 키 발급: https://aistudio.google.com/apikey
```

### 5. Shell 별칭 등록
```bash
# ~/.zshrc에 추가
source ~/ai-pipeline/scripts/aliases.sh
```

```bash
# 적용
source ~/.zshrc
```

## 사용법

### Quick Start
```bash
# 설정 확인
python scripts/config.py

# 오늘의 Daily Note 생성
daily-init

# 빠른 메모
quick "오늘 배운 것: Docker layer caching"

# 오늘의 현황 보기
ai-status
```

### 일일 워크플로우

**아침**
```bash
daily-init  # 오늘의 템플릿 생성
```

생성되는 템플릿:
```markdown
# 2026-01-16 (목)

## 🎯 오늘의 Focus
-

## 📋 할 일
- [ ]

## 🤔 고민거리

## 📝 오늘의 생각

## ✅ 오늘 한 일
```

**하루 중**
```bash
# 배운 것, 고민, 인사이트 즉시 기록
quick "Redis cluster failover 테스트 완료"
quick "#issue API 응답 느린 원인 파악중"
quick "#insight 테스트 코드가 문서다"
```

**퇴근 전**
```bash
sync-github --today  # GitHub 활동 동기화
ai-daily             # AI 대화 노트 연결
```

### 주간/월간 회고

**주말**
```bash
ai-weekly
```

자동 생성되는 내용:
- 📚 주제별 학습 정리
- 🤔 도전과 배움 (고민 → 해결 과정)
- ❓ 복습 퀴즈 5개
- 🎯 다음 주 액션

**월말**
```bash
ai-monthly
```

자동 생성되는 내용:
- 📊 월간 통계 (노트 수, 활동일 등)
- 🌱 성장 영역 분석
- 🔄 반복 패턴 발견
- 🎯 다음 달 Focus 제안

## 명령어 목록

| 명령어 | 설명 | 예시 |
|--------|------|------|
| `quick` | 빠른 메모 | `quick "내용"` |
| `daily-init` | 아침 템플릿 | `daily-init` |
| `ai-daily` | Daily Note 동기화 | `ai-daily` |
| `sync-github` | GitHub 활동 동기화 | `sync-github --today` |
| `ai-weekly` | 주간 회고 | `ai-weekly` |
| `ai-monthly` | 월간 리포트 | `ai-monthly 2026-01` |
| `ai-process` | AI 로그 처리 | `ai-process ~/.ai-pipeline/raw/2026/01/16/codex_20260116_140437.log` |
| `ai-status` | 오늘 현황 | `ai-status` |
| `ai-help` | 도움말 | `ai-help` |

## 지원하는 태그

`quick` 명령어에서 사용 가능한 태그:

| 태그 | 아이콘 | 용도 |
|------|--------|------|
| `#insight` | 💡 | 깨달음, 인사이트 |
| `#issue` | 🤔 | 고민, 문제 상황 |
| `#todo` | 📌 | 나중에 할 것 |
| `#learned` | 📚 | 오늘 배운 것 |
| `#idea` | 💭 | 아이디어 |
| `#decision` | ✅ | 결정 사항 |
| `#blocker` | 🚫 | 막힌 것 |

## 설정

### 환경변수

| 변수 | 설명 | 기본값 |
|------|------|--------|
| `GOOGLE_API_KEY` | Gemini API 키 | (필수) |
| `AI_VAULT_PATH` | Obsidian vault 경로 | settings.yaml |
| `AI_LLM_PROVIDER` | LLM 제공자 | `gemini` |
| `AI_GITHUB_REPOS` | GitHub 저장소 (콤마 구분) | settings.yaml |

### 설정 파일 우선순위

1. 환경변수 (최우선)
2. `config/settings.local.yaml` (개인 설정)
3. `config/settings.yaml` (기본 설정)

## 데이터 흐름

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  AI 대화    │────▶│   _drafts   │────▶│   study/    │
│  (Claude,   │     │  (staging)  │     │  (최종)     │
│   Codex)    │     └─────────────┘     └─────────────┘
└─────────────┘            │
                           ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ quick notes │────▶│ Daily Note  │────▶│ Weekly/     │
│ (#insight,  │     │ (일일 통합) │     │ Monthly     │
│  #issue)    │     └─────────────┘     │ 회고        │
└─────────────┘            ▲            └─────────────┘
                           │
┌─────────────┐            │
│  GitHub     │────────────┘
│  활동       │
└─────────────┘
```

## 폴더 구조

```
ai-pipeline/
├── config/
│   ├── settings.example.yaml  # 템플릿 (커밋됨)
│   └── settings.local.yaml    # 개인 설정 (gitignore)
├── scripts/                   # Python CLI 스크립트
│   ├── config.py              # 설정 로딩 모듈
│   ├── quick.py               # 빠른 메모
│   ├── daily.py               # Daily Note 관리
│   ├── weekly.py              # 주간 회고
│   ├── monthly.py             # 월간 리포트
│   ├── sync_github.py         # GitHub 동기화
│   ├── processor.py           # AI 로그 처리
│   └── aliases.sh             # Shell 별칭
├── dashboard/                 # 웹 대시보드 (Node.js)
│   ├── server.js              # Express 엔트리포인트
│   ├── routes/                # API 라우터 (7개 모듈)
│   ├── lib/                   # 비즈니스 로직 (10개 모듈)
│   ├── public/index.html      # 싱글 페이지 UI
│   ├── electron/              # 데스크톱 앱 (Electron)
│   └── jobs.example.json      # 작업 정의 템플릿
├── docs/
│   ├── SETUP.md               # 상세 설치 가이드
│   ├── COMMANDS.md            # 명령어 상세
│   └── ARCHITECTURE.md        # 아키텍처 설명
├── requirements.txt
└── README.md
```

## 요구사항

- Python 3.10+
- Obsidian (또는 마크다운 지원 노트앱)
- Gemini API 키 (무료)
- (선택) GitHub CLI (`gh`) - GitHub 활동 동기화용

## FAQ

**Q: Gemini 말고 다른 LLM도 쓸 수 있나요?**

A: 네, `settings.local.yaml`에서 provider를 변경하세요:
```yaml
llm:
  provider: "openai"  # 또는 "anthropic"
```

**Q: Obsidian 없이도 쓸 수 있나요?**

A: 네, 마크다운 파일만 생성하므로 어떤 에디터로도 볼 수 있습니다.

**Q: API 비용이 얼마나 드나요?**

A: Gemini 무료 tier로 충분합니다 (분당 15회, 일 1500회).

## 기여하기

1. Fork
2. Feature branch 생성 (`git checkout -b feature/amazing-feature`)
3. 커밋 (`git commit -m 'Add amazing feature'`)
4. Push (`git push origin feature/amazing-feature`)
5. Pull Request

자세한 내용은 [CONTRIBUTING.md](CONTRIBUTING.md)를 참고하세요.

## 라이선스

MIT License - 자유롭게 사용하세요!

## 만든 사람

**이영수** - 매일 AI와 대화하면서 배운 것들이 사라지는 게 아까워서 만들었습니다.

---

⭐ 도움이 되었다면 Star를 눌러주세요!
